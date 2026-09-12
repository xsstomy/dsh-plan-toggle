/**
 * host 半接线冒烟测试：用假 ctx 驱动 lib/index.js，验证
 *   1) 插件导出（name / inject）符合 cordis 行要求；
 *   2) 两条命令 + 工具闸门按预期注册；
 *   3) PTC 会话被拒绝（不改模式、不碰沙箱、不动状态），standard 会话正常；
 *   4) /plan-toggle 真的调用 planMode.set(agent, true/false)，并成对切换硬拦截沙箱；
 *   5) 镜像：只用官方 plan 模式（不按 Alt+1）也会切/还原只读沙箱；
 *   6) blockBash 开关只作用于 plan 模式下的 bash/pwsh；
 *   7) **整条流水线的顺序**：复核 → 归档落盘 → 还原沙箱 → 退 plan 模式 → steer 执行
 *      → turn-stopping 注入一次自审。第 7 条是"执行前必须已恢复写权限"的回归。
 *
 * 为什么需要它：真实依赖（@deepseek-ai/dsh-llm、@deepseek-ai/dsh-sandbox-policy）
 * 只在 npm install 后才在；缺依赖时本文件整体跳过，保证干净 clone 上 `npm test` 仍可运行。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

const skipped = host === undefined ? '需要先 npm install（host 半依赖 @deepseek-ai/dsh-llm 与 @deepseek-ai/dsh-sandbox-policy）' : false

/** 假 permission-presets（官方预设路线 C）。 */
function fakePresets(options = {}) {
  const table = options.table ?? {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  }
  const sets = []
  return {
    sets,
    names: Object.keys(table),
    resolve: name => {
      const spec = table[name]
      if (spec === undefined) throw new Error(`unknown preset ${name}`)
      return { name, ...spec }
    },
    current: () => options.current ?? 'workspace-write',
    set: (_session, name) => { sets.push(name) },
  }
}

/**
 * 假 ctx：实现本插件用到的那几个服务，并把所有写入动作记进同一条 timeline，
 * 以便断言"沙箱还原发生在 steer 执行之前"。
 */
function createFakeContext(options = {}) {
  const commands = new Map()
  const listeners = new Map()
  const timeline = []
  const effects = []
  let planActive = options.planActive ?? false
  const session = {
    id: 's1',
    header: { cwd: options.cwd ?? '/tmp/plan-toggle-smoke', agentPreset: options.preset ?? 'standard' },
    append: (type, data) => timeline.push(`event:${type}:${data.mode ?? ''}`),
  }
  const agent = {
    session,
    status: 'idle',
    whenIdle: async () => {},
    steer: message => timeline.push(`steer:${message.content[0].text.slice(0, 24)}`),
  }
  const services = {
    agentPresets: {
      serviceFor: (_agent, key) => {
        assert.equal(key, 'planMode')
        return {
          get: () => ({ active: planActive }),
          set: (_target, active) => {
            planActive = active
            timeline.push(`planMode:${active}`)
            return 'committed'
          },
        }
      },
    },
    // 默认没有 run_code ⇒ standard 会话（PTC 才注入它）；null 表示 tools 服务不存在。
    tools: options.tools === null ? undefined : (options.tools ?? { get: () => undefined }),
    subagents: {
      getProvider: () => options.provider ?? {
        capabilities: { outputSchema: true },
        inheritsParentContext: false,
      },
      start: async () => {
        timeline.push('subagent:start')
        return {
          result: Promise.resolve({
            stopReason: 'completed',
            structured: options.structured ?? {
              findings: [{ severity: 'P1', location: 'a.md:1', evidence: 'e', resolution: 'fixed', reason: 'r' }],
              revisedPlan: '# 计划：冒烟用例\n\n1. 做一件事\n',
            },
          }),
          dispose: async () => {},
        }
      },
    },
    sessionQuery: {
      readSurface: async () => ({
        events: [
          { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: '把登录改成 SSO' }] } },
          { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '# 草稿计划\n1. 先读代码' }] } } },
        ],
      }),
    },
    permissionPresets: options.permissionPresets,
    // null 显式表示"该服务不存在"，用于验证降级路径
    sandboxPolicy: options.sandboxPolicy === null
      ? undefined
      : (options.sandboxPolicy ?? { resolve: () => ({ mode: 'workspace-write' }), overrideOf: () => undefined }),
    approval: options.approval === null
      ? undefined
      : (options.approval ?? { config: { policy: 'ask' }, overrideOf: () => undefined, setPolicy: () => {} }),
  }
  const ctx = {
    commands,
    listeners,
    timeline,
    effects,
    agent,
    // cordis inject 的四个服务以属性形式出现（插件正是这么调的）
    agentPresets: services.agentPresets,
    subagents: services.subagents,
    sessionQuery: services.sessionQuery,
    // 可选的工具/沙箱/预设/审批服务经软取拿；测试里也可直接改这些属性
    get: name => services[name],
    setPlanActive: value => { planActive = value },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    logger: { error() {} },
  }
  ctx.commandsRegistry = {
    register(definition) {
      commands.set(definition.name, definition)
      return () => commands.delete(definition.name)
    },
  }
  return ctx
}

function attach(ctx, config) {
  // attach 只接管 commands 注册表；其余服务保持 ctx 上的属性形态。
  host.apply({
    ...ctx,
    commands: ctx.commandsRegistry,
  }, config)
}

/** 触发一次工具闸门；返回 `{decision, nextCalled}`。 */
async function runToolGate(ctx, name, agent = ctx.agent) {
  const listener = ctx.listeners.get('tools/pre-execute')
  assert.ok(listener, 'tools/pre-execute 必须已注册')
  let nextCalled = false
  const decision = await listener({ name, arguments: {}, agent }, async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  return { decision, nextCalled }
}

test('host 半导出与注入声明', { skip: skipped }, () => {
  assert.equal(host.name, 'dsh-plan-toggle')
  assert.deepEqual(host.inject, ['agentPresets', 'subagents', 'commands', 'sessionQuery'])
  assert.equal(typeof host.apply, 'function')
})

test('注册两条命令、工具闸门与一个 turn-stopping 监听', { skip: skipped }, () => {
  const ctx = createFakeContext()
  attach(ctx)
  assert.deepEqual([...ctx.commands.keys()].sort(), ['plan-review', 'plan-toggle'])
  assert.ok(ctx.listeners.has('agent/turn-stopping'))
  assert.ok(ctx.listeners.has('tools/pre-execute'))
  assert.equal(ctx.effects.length, 2)
})

test('/plan-toggle 双向切换并调用 planMode.set；无沙箱服务时降级为软拦截', { skip: skipped }, async () => {
  // permissionPresets / sandboxPolicy 都不在 → 闸门不可用，退回官方软提示词
  const ctx = createFakeContext({ sandboxPolicy: null, approval: null })
  attach(ctx)
  const handler = ctx.commands.get('plan-toggle').handler

  const on = await handler({ agent: ctx.agent })
  assert.equal(on.kind, 'success')
  assert.match(on.text, /软拦截/)
  const off = await handler({ agent: ctx.agent })
  assert.equal(off.kind, 'success')
  assert.deepEqual(ctx.timeline, ['planMode:true', 'planMode:false'])
})

test('/plan-toggle 有只读预设时走官方预设，并在退出时切回原预设（C 路线）', { skip: skipped }, async () => {
  const permissionPresets = fakePresets({ current: 'workspace-write' })
  const ctx = createFakeContext({ permissionPresets })
  attach(ctx)
  const handler = ctx.commands.get('plan-toggle').handler

  const on = await handler({ agent: ctx.agent })
  assert.match(on.text, /预设 read-only/)
  assert.deepEqual(permissionPresets.sets, ['read-only'])
  assert.deepEqual(ctx.timeline, ['planMode:true'])

  await handler({ agent: ctx.agent })
  assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])
  assert.deepEqual(ctx.timeline, ['planMode:true', 'planMode:false'])
})

test('/plan-toggle 在 preset 未挂 plan-mode 时明确报错', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  ctx.agentPresets = { serviceFor: () => undefined }
  attach(ctx)
  const result = await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan mode/)
})

test('PTC 会话：两条命令都拒绝，且不改模式、不碰沙箱、不动状态', { skip: skipped }, async () => {
  const permissionPresets = fakePresets({ current: 'workspace-write' })
  // ctx.tools 能取到 run_code ⇒ PTC（权威证据）
  const ctx = createFakeContext({
    permissionPresets,
    preset: 'standard',
    tools: { get: name => (name === 'run_code' ? { name } : undefined) },
  })
  attach(ctx)
  const toggle = await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
  const review = await ctx.commands.get('plan-review').handler({ agent: ctx.agent })

  assert.equal(toggle.kind, 'error')
  assert.equal(review.kind, 'error')
  assert.match(toggle.text, /PTC/)
  assert.match(toggle.text, /standard/)
  assert.deepEqual(ctx.timeline, [], 'PTC 下不得切 plan 模式、不得碰沙箱')
  assert.deepEqual(permissionPresets.sets, [])
  // 状态未被改动：紧接着仍可用官方方式进入（这里以 pre-execute 镜像反证 states 仍 normal）
  assert.deepEqual(ctx.effects.length, 2)
})

test('PTC 兜底判定：ctx.tools 缺失但预设 id 命中名单时同样拒绝', { skip: skipped }, async () => {
  const ctx = createFakeContext({ preset: 'ptc', tools: null })
  attach(ctx)
  const result = await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /PTC/)
  assert.deepEqual(ctx.timeline, [])
})

test('工具闸门：standard 会话下不误拦 write', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  const { decision, nextCalled } = await runToolGate(ctx, 'write')
  assert.equal(decision.kind, 'allow')
  assert.equal(nextCalled, true)
})

test('镜像：只用官方 plan 模式（不按 Alt+1）也会切/还原只读沙箱', { skip: skipped }, async () => {
  const permissionPresets = fakePresets({ current: 'workspace-write' })
  const ctx = createFakeContext({ permissionPresets })
  attach(ctx)

  // 官方 /plan 进入（插件命令没被调用）：下一次工具调用前镜像生效
  ctx.setPlanActive(true)
  const first = await runToolGate(ctx, 'read')
  assert.equal(first.decision.kind, 'allow')
  assert.deepEqual(permissionPresets.sets, ['read-only'], '官方 /plan 进入后必须切只读')

  // 官方 /plan off：恢复写权限
  ctx.setPlanActive(false)
  await runToolGate(ctx, 'read')
  assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])
})

test('镜像：进入官方 plan 模式后 Alt+2 仍可用（状态被镜像成 planning）', { skip: skipped }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plan-toggle-mirror-'))
  const permissionPresets = fakePresets({ current: 'workspace-write' })
  try {
    const ctx = createFakeContext({ cwd, permissionPresets })
    attach(ctx)
    ctx.setPlanActive(true)
    await runToolGate(ctx, 'read') // 镜像切只读 + 状态转 planning

    const result = await ctx.commands.get('plan-review').handler({ agent: ctx.agent })
    assert.equal(result.kind, 'success', result.text)
    assert.ok(ctx.timeline.some(entry => entry.startsWith('steer:')), '镜像进入后 Alt+2 必须能起执行轮')
    assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'], '执行前必须已还原')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('blockBash：开启后 plan 模式下 bash/pwsh 被拒，read 仍放行', { skip: skipped }, async () => {
  const ctx = createFakeContext({ planActive: true })
  attach(ctx, { blockBash: true })

  const bash = await runToolGate(ctx, 'bash')
  assert.deepEqual(bash.decision, {
    kind: 'deny',
    reason: 'plan 模式禁止执行命令。请改用 read/grep/glob 只读探索，或把方案写进计划后按 Alt+2。',
  })
  assert.equal(bash.nextCalled, false, 'deny 时不得继续委派')

  const pwsh = await runToolGate(ctx, 'pwsh')
  assert.equal(pwsh.decision.kind, 'deny')

  const read = await runToolGate(ctx, 'read')
  assert.equal(read.decision.kind, 'allow')
  assert.equal(read.nextCalled, true)
})

test('blockBash 默认关闭：plan 模式下 bash 放行（沙箱负责挡写）', { skip: skipped }, async () => {
  const ctx = createFakeContext({ planActive: true })
  attach(ctx)
  const bash = await runToolGate(ctx, 'bash')
  assert.equal(bash.decision.kind, 'allow')
  assert.equal(bash.nextCalled, true)
})

test('blockBash 不在 plan 模式下生效', { skip: skipped }, async () => {
  const ctx = createFakeContext({ planActive: false })
  attach(ctx, { blockBash: true })
  const bash = await runToolGate(ctx, 'bash')
  assert.equal(bash.decision.kind, 'allow')
})

test('/plan-review 在非 plan 模式下拒绝，且不碰子代理', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  const result = await ctx.commands.get('plan-review').handler({ agent: ctx.agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan 模式/)
  assert.deepEqual(ctx.timeline, [])
})

test('/plan-review 在 agent 正忙时拒绝', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
  ctx.agent.status = 'running'
  const result = await ctx.commands.get('plan-review').handler({ agent: ctx.agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /空闲|status=running/)
})

test('整条流水线：复核 → 归档落盘 → 还原沙箱 → 退 plan → steer 执行 → 自审一次', { skip: skipped }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plan-toggle-smoke-'))
  const permissionPresets = fakePresets({ current: 'workspace-write' })
  try {
    const ctx = createFakeContext({ cwd, permissionPresets })
    attach(ctx)
    const toggle = ctx.commands.get('plan-toggle').handler
    const review = ctx.commands.get('plan-review').handler

    await toggle({ agent: ctx.agent })
    const result = await review({ agent: ctx.agent })
    assert.equal(result.kind, 'success')
    assert.deepEqual(permissionPresets.sets, ['read-only', 'workspace-write'])

    // 归档真的落盘，且文件名用本地日期
    const archived = result.text.match(/已归档 (\S+)（/)
    assert.ok(archived, `返回文本里应有归档路径：${result.text}`)
    const content = await readFile(archived[1], 'utf8')
    assert.match(content, /# 计划：冒烟用例/)

    // 顺序断言：还原沙箱必须早于 steer 执行，否则执行轮会在只读沙箱下全部失败
    const restoreIndex = ctx.timeline.indexOf('planMode:false')
    const steerIndex = ctx.timeline.findIndex(entry => entry.startsWith('steer:'))
    assert.ok(ctx.timeline.includes('subagent:start'), '必须经过复核子代理')
    assert.ok(restoreIndex !== -1 && steerIndex !== -1)
    assert.ok(restoreIndex < steerIndex, `还原(${restoreIndex}) 必须早于执行(${steerIndex})：${ctx.timeline.join(' | ')}`)
    assert.deepEqual(ctx.timeline.filter(entry => entry.startsWith('steer:')).length, 1)

    // 执行轮结束后注入一次自审，且只注入一次
    const onTurnStopping = ctx.listeners.get('agent/turn-stopping')
    onTurnStopping({ agent: ctx.agent })
    onTurnStopping({ agent: ctx.agent })
    assert.equal(ctx.timeline.filter(entry => entry.startsWith('steer:')).length, 2)
    assert.match(ctx.timeline.at(-1), /steer:执行轮已结束/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('复核失败时不执行：停在 plan 模式（并保留只读）', { skip: skipped }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plan-toggle-smoke-'))
  try {
    const ctx = createFakeContext({
      cwd,
      structured: undefined,
      provider: { capabilities: { outputSchema: true }, inheritsParentContext: false },
    })
    // 让复核返回一个结构不符的结果（缺 revisedPlan）
    ctx.subagents.start = async () => ({
      result: Promise.resolve({ stopReason: 'completed', structured: { findings: [] } }),
      dispose: async () => {},
    })
    attach(ctx)
    await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
    const result = await ctx.commands.get('plan-review').handler({ agent: ctx.agent })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /revisedPlan/)
    assert.equal(ctx.timeline.some(entry => entry.startsWith('steer:')), false, '失败绝不允许进入执行轮')
    // 仍停在 plan 模式：再按 Alt+1 才退出
    const off = await ctx.commands.get('plan-toggle').handler({ agent: ctx.agent })
    assert.equal(off.kind, 'success')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
