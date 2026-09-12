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

test('回归（线上事故）：重启后采纳官方 plan 态，退出必须还原到部署默认预设，不能还原成只读', () => {
  // 场景复现（来自真实会话日志）：
  //   seq 0-2 会话创建 → danger-full-access；seq 4-8 首进 plan → read-only（快照正确）
  //   seq 41  dsh web 重启（插件内存清空，但日志里沙箱仍是 read-only）→ 镜像采纳该态并切 plan
  //   seq 50  退出 → 旧实现把"当时看到的 read-only"当成进入前状态 → 永久卡在只读
  const table = {
    plan: { sandbox: READ_ONLY_MODE, approval: 'never' },
    'read-only': { sandbox: READ_ONLY_MODE, approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const sets = []
  let current = 'danger-full-access'
  let sandboxMode = 'danger-full-access'
  const permissionPresets = {
    names: Object.keys(table),
    resolve: name => ({ name, ...table[name] }),
    current: () => current,
    defaultPreset: 'danger-full-access',
    set: (_session, name) => { sets.push(name); current = name; sandboxMode = table[name].sandbox },
  }
  const sandboxPolicy = { resolve: () => ({ mode: sandboxMode }), overrideOf: () => undefined }
  const session = { id: 's1', append: () => {} }

  // 插件重启 ⇒ 新实例，内存里没有任何快照；但会话日志里沙箱仍是只读、当前预设解出 read-only
  sandboxMode = READ_ONLY_MODE
  current = 'read-only'
  const gate = createHardGate({ permissionPresets, sandboxPolicy })
  const descriptor = gate.enter(session) // 镜像采纳：当前已经是 read-only
  assert.equal(descriptor.via, 'preset')
  assert.equal(descriptor.saved.adopted, true, '幂等快照必须被标记为"采纳态"')

  assert.equal(gate.leave({ session }, descriptor), 'preset')
  assert.deepEqual(sets, ['plan', 'danger-full-access'], '退出必须回到部署默认预设，而不是只读')
})

test('还原优先级：上次见到的正常预设 > 部署默认预设', () => {
  const table = {
    plan: { sandbox: READ_ONLY_MODE, approval: 'never' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const sets = []
  let current = 'workspace-write'
  let sandboxMode = 'workspace-write'
  const permissionPresets = {
    names: Object.keys(table),
    resolve: name => ({ name, ...table[name] }),
    current: () => current,
    defaultPreset: 'danger-full-access',
    set: (_session, name) => { sets.push(name); current = name; sandboxMode = table[name].sandbox },
  }
  const gate = createHardGate({
    permissionPresets,
    sandboxPolicy: { resolve: () => ({ mode: sandboxMode }), overrideOf: () => undefined },
  })
  const session = { id: 's1', append: () => {} }

  // 正常进出一次：记住 workspace-write
  const first = gate.enter(session)
  assert.equal(first.saved.presetName, 'workspace-write')
  gate.leave({ session }, first)
  // 再进入时外部已把它改成 plan（例如用户在 UI 里手动切过）→ 快照不可靠
  current = 'plan'
  sandboxMode = READ_ONLY_MODE
  const second = gate.enter(session)
  assert.equal(second.saved.adopted, true)
  gate.leave({ session }, second)
  assert.equal(sets.at(-1), 'workspace-write', '应优先还原上次见到的正常预设，而不是部署默认')
})

test('无预设服务时：采纳态按部署默认旋钮还原（不把只读留在会话里）', () => {
  const writes = []
  const session = { id: 's1', append: (type, data) => writes.push([type, data]) }
  const gate = createHardGate({
    // 只有 B 路线：没有 permissionPresets
    sandboxPolicy: {
      resolve: request => ({ mode: request === undefined ? 'workspace-write' : READ_ONLY_MODE }),
      overrideOf: () => undefined,
    },
  })
  const descriptor = gate.enter(session)
  assert.equal(descriptor.saved.adopted, true)
  assert.equal(gate.leave({ session }, descriptor), 'setter')
  assert.deepEqual(writes, [
    ['sandbox/mode', { mode: READ_ONLY_MODE }],
    ['sandbox/mode', { mode: 'workspace-write' }],
  ], '没有预设服务时也要回到部署默认模式')
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
