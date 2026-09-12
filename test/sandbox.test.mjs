/**
 * 硬拦截闸门单测：官方预设路线（C）与 setter 路线（B）的进入/还原语义。
 *
 * 这几条规则是"plan 模式下真写不进去、执行时又真能写"的唯一保障，因此用假服务
 * 把三条场景全钉死：有只读预设 → 走预设；没有预设 → 走 setter；两者都没有 → 不可用。
 * 另覆盖：进入前是 custom 时还原必须直写旋钮；重复还原不得叠加副作用。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHardGate, pickReadOnlyPreset, READ_ONLY_MODE } from '../lib/sandbox.js'

/** 假 permission-presets：names / resolve / current / set。 */
function fakePresets({ table = {}, current = 'custom' } = {}) {
  const sets = []
  return {
    sets,
    names: Object.keys(table),
    resolve(name) {
      const spec = table[name]
      if (spec === undefined) throw new Error(`unknown preset ${name}`)
      return { name, ...spec }
    },
    current: () => current,
    set(_session, name) {
      if (table[name] === undefined) throw new Error(`unknown preset ${name}`)
      sets.push(name)
    },
  }
}

/** 假 sandboxPolicy：resolve 返回当前生效模式，overrideOf 返回覆盖值。 */
function fakeSandbox({ mode = 'workspace-write', override } = {}) {
  return { resolve: () => ({ mode }), overrideOf: () => override }
}

/** 假 approval：overrideOf 返回覆盖策略，config.policy 是部署默认。 */
function fakeApproval({ policy = 'ask', override } = {}) {
  return { config: { policy }, overrideOf: () => override, setPolicy(_agent, next) { this.written = next } }
}

const session = { id: 's1', header: { cwd: '/repo' } }
const agent = { session }

test('pickReadOnlyPreset：优先 plan 命名，其次 read-only，再退到任意只读预设', () => {
  const entries = [
    { name: 'workspace-write', sandbox: 'workspace-write' },
    { name: 'read-only', sandbox: READ_ONLY_MODE },
    { name: 'plan', sandbox: READ_ONLY_MODE },
  ]
  assert.equal(pickReadOnlyPreset(entries).name, 'plan')
  assert.equal(pickReadOnlyPreset(entries.filter(e => e.name !== 'plan')).name, 'read-only')
  assert.equal(pickReadOnlyPreset([{ name: 'strict', sandbox: READ_ONLY_MODE }]).name, 'strict')
  assert.equal(pickReadOnlyPreset([{ name: 'rw', sandbox: 'workspace-write' }]), undefined)
  assert.equal(pickReadOnlyPreset(undefined), undefined)
})

test('C 路线：有只读预设时走官方 permissionPresets.set，离开时切回进入前的预设', () => {
  const permissionPresets = fakePresets({
    table: { 'read-only': { sandbox: READ_ONLY_MODE, approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
    current: 'workspace-write',
  })
  const gate = createHardGate({ permissionPresets, sandboxPolicy: fakeSandbox(), approval: fakeApproval() })

  const descriptor = gate.enter(session)
  assert.equal(descriptor.via, 'preset')
  assert.equal(descriptor.presetName, 'read-only')
  assert.equal(descriptor.saved.presetName, 'workspace-write')
  assert.deepEqual(permissionPresets.sets, ['read-only'])

  assert.equal(gate.leave(agent, descriptor), 'preset')
  assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])
})

test('C 路线偏好：部署自定义的 plan 预设优先于官方 read-only', () => {
  const permissionPresets = fakePresets({
    table: { plan: { sandbox: READ_ONLY_MODE, approval: 'ask' }, 'read-only': { sandbox: READ_ONLY_MODE, approval: 'ask' } },
    current: 'custom',
  })
  const gate = createHardGate({ permissionPresets, sandboxPolicy: fakeSandbox(), approval: fakeApproval() })
  assert.equal(gate.enter(session).presetName, 'plan')
})

test('B 路线：没有只读预设时退回 setSandboxMode，离开时写回原模式', () => {
  const writes = []
  const sandboxPolicy = fakeSandbox({ mode: 'workspace-write' })
  const gate = createHardGate({ permissionPresets: undefined, sandboxPolicy, approval: fakeApproval() })
  // setSandboxMode 是官方导出函数：这里用 session.append 观察本次写入。
  session.append = (type, data) => writes.push([type, data])

  const descriptor = gate.enter(session)
  assert.equal(descriptor.via, 'setter')
  assert.deepEqual(writes, [['sandbox/mode', { mode: READ_ONLY_MODE }]])

  assert.equal(gate.leave(agent, descriptor), 'setter')
  assert.deepEqual(writes, [
    ['sandbox/mode', { mode: READ_ONLY_MODE }],
    ['sandbox/mode', { mode: 'workspace-write' }],
  ])
})

test('B 路线：进入前是 custom 时还原直写旋钮（沙箱 + 审批）', () => {
  const permissionPresets = fakePresets({
    table: { 'read-only': { sandbox: READ_ONLY_MODE, approval: 'ask' } },
    current: 'custom',
  })
  const writes = []
  session.append = (type, data) => writes.push([type, data])
  const approval = fakeApproval({ policy: 'ask', override: 'never' })
  const gate = createHardGate({ permissionPresets, sandboxPolicy: fakeSandbox({ mode: 'danger-full-access' }), approval })

  const descriptor = gate.enter(session) // 有只读预设 → 走 preset，但 saved 记的是 custom
  assert.deepEqual(permissionPresets.sets, ['read-only'])
  assert.equal(gate.leave(agent, descriptor), 'setter')
  assert.deepEqual(writes, [['sandbox/mode', { mode: 'danger-full-access' }]], 'custom 状态必须直写旋钮还原')
  assert.equal(approval.written, 'never', '审批策略取 overrideOf 的当前值')
})

test('两者都不可用时闸门不可用，toggle 侧降级为软拦截', () => {
  const gate = createHardGate({})
  assert.equal(gate.available, false)
  assert.equal(gate.enter(session), undefined)
  assert.equal(gate.leave(agent, undefined), 'none')
})

test('重复离开不叠加副作用：描述符被调用方取走后不会再被还原一次', () => {
  const permissionPresets = fakePresets({
    table: {
      'read-only': { sandbox: READ_ONLY_MODE, approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    },
    current: 'workspace-write',
  })
  const gate = createHardGate({ permissionPresets, sandboxPolicy: fakeSandbox(), approval: fakeApproval() })
  const descriptor = gate.enter(session)
  gate.leave(agent, descriptor)
  assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])
  // 调用方（host 半）会把描述符 takeGate 掉，因此第二次只能是 none，不会重复写。
  assert.equal(gate.leave(agent, undefined), 'none')
  assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])
})
