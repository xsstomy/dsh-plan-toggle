/**
 * host 半接线冒烟测试：用假 ctx 驱动 lib/index.js，验证
 *   1) 插件导出（name / inject）符合 cordis 行要求；
 *   2) 两条命令按预期注册，且不重复；
 *   3) /plan-toggle 真的调用 planMode.set(agent, true/false)，且状态机按规则收敛；
 *   4) /plan-review 在非 planning 状态下拒绝（不会误触发执行）。
 *
 * 为什么需要它：真实依赖（@deepseek-ai/dsh-llm）只在 npm install 后才在；
 * 缺依赖时本文件整体跳过，保证干净 clone 上 `npm test` 仍可运行。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

const skipped = host === undefined ? '需要先 npm install（host 半依赖 @deepseek-ai/dsh-llm）' : false

/** 假 ctx：只实现本插件用到的那几个服务，并记录注册与调用。 */
function createFakeContext() {
  const commands = new Map()
  const listeners = new Map()
  const setCalls = []
  const effects = []
  return {
    commands,
    listeners,
    setCalls,
    effects,
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
    agentPresets: {
      serviceFor(agent, key) {
        assert.equal(key, 'planMode')
        return { set: (target, active) => { setCalls.push([target.session.id, active]); return 'committed' } }
      },
    },
    subagents: { getProvider: () => undefined },
    sessionQuery: { readSurface: async () => ({ events: [] }) },
    commandsRegistry: undefined,
    _ctx: null,
  }
}

function attach(ctx) {
  ctx.commandsRegistry = {
    register(definition) {
      ctx.commands.set(definition.name, definition)
      return () => ctx.commands.delete(definition.name)
    },
  }
  const realApply = host.apply
  realApply({
    ...ctx,
    commands: ctx.commandsRegistry,
    effect: ctx.effect,
    on: ctx.on,
    logger: ctx.logger,
    agentPresets: ctx.agentPresets,
    subagents: ctx.subagents,
    sessionQuery: ctx.sessionQuery,
  })
}

const fakeAgent = (id = 's1') => ({
  session: { id, header: { cwd: '/tmp/plan-toggle-smoke' } },
  status: 'idle',
  whenIdle: async () => {},
  steer() {},
})

test('host 半导出与注入声明', { skip: skipped }, () => {
  assert.equal(host.name, 'dsh-plan-toggle')
  assert.deepEqual(host.inject, ['agentPresets', 'subagents', 'commands', 'sessionQuery'])
  assert.equal(typeof host.apply, 'function')
})

test('注册两条命令与一个 turn-stopping 监听', { skip: skipped }, () => {
  const ctx = createFakeContext()
  attach(ctx)
  assert.deepEqual([...ctx.commands.keys()].sort(), ['plan-review', 'plan-toggle'])
  assert.ok(ctx.listeners.has('agent/turn-stopping'))
  assert.equal(ctx.effects.length, 2)
})

test('/plan-toggle 双向切换并调用 planMode.set', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  const handler = ctx.commands.get('plan-toggle').handler
  const agent = fakeAgent()

  const on = await handler({ agent })
  assert.equal(on.kind, 'success')
  assert.deepEqual(ctx.setCalls, [['s1', true]])

  const off = await handler({ agent })
  assert.equal(off.kind, 'success')
  assert.deepEqual(ctx.setCalls, [['s1', true], ['s1', false]])
})

test('/plan-toggle 在 preset 未挂 plan-mode 时明确报错', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  ctx.agentPresets.serviceFor = () => undefined
  attach(ctx)
  const result = await ctx.commands.get('plan-toggle').handler({ agent: fakeAgent() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan mode/)
})

test('/plan-review 在非 plan 模式下拒绝，且不碰子代理', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  let started = 0
  ctx.subagents.getProvider = () => { started += 1; return undefined }
  const result = await ctx.commands.get('plan-review').handler({ agent: fakeAgent() })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan 模式/)
  assert.equal(started, 0)
})

test('/plan-review 在 agent 正忙时拒绝', { skip: skipped }, async () => {
  const ctx = createFakeContext()
  attach(ctx)
  const agent = fakeAgent()
  const handler = ctx.commands.get('plan-toggle').handler
  await handler({ agent }) // 先进 planning
  agent.status = 'running'
  const result = await ctx.commands.get('plan-review').handler({ agent })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /空闲|status=running/)
})
