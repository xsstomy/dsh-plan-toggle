/**
 * 浏览器半冒烟测试：用最小的 `window.__ModuleLoader__` 桩加载 lib/client.js，
 * 再驱动它的 apply(ctx)，验证键位判定与命令转发：
 *   - Alt+1 → /plan-toggle，Alt+2 → /plan-review（捕获阶段 + preventDefault）；
 *   - 带 Ctrl/Cmd 的组合、按住重复、无当前会话一律忽略（不抢键、不发命令）。
 *
 * 用桩而不是 jsdom：这一半只用 window + ctx 两个接缝，桩能让测试零依赖。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const loads = []
globalThis.window = {
  __ModuleLoader__: { load: entry => loads.push(entry) },
  addEventListener() {},
  removeEventListener() {},
}

await import('../lib/client.js')

const entry = loads[0]
assert.equal(entry.id, 'dsh-plan-toggle', 'client bundle id 必须与 cordis 行同名')

/** 载入 factory 得到模块导出（require 在本半里未被使用）。 */
function loadClientModule() {
  return entry.factory(() => { throw new Error('client half must not require anything') })
}

/** 假 ctx：只实现 sessions / remote.commands 与 effect。current=null 表示没有当前会话。 */
function createClientContext({ current = 'sess-1' } = {}) {
  const executed = []
  const listeners = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { list: { getSnapshot: () => (current === null ? {} : { current }) } }
      }
      if (name === 'remote') {
        return { commands: { execute: (id, line, attachments) => { executed.push([id, line, attachments]); return Promise.resolve({}) } } }
      }
      return undefined
    },
    effect(factory) {
      const disposer = factory()
      return disposer
    },
  }
  // 捕获 window 上注册的 keydown 处理器
  globalThis.window.addEventListener = (type, handler) => { if (type === 'keydown') listeners.push(handler) }
  globalThis.window.removeEventListener = () => {}
  ctx.executed = executed
  ctx.listeners = listeners
  return ctx
}

const keydown = (overrides = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  code: 'Digit1',
  prevented: 0,
  stopped: 0,
  preventDefault() { this.prevented += 1 },
  stopPropagation() { this.stopped += 1 },
  ...overrides,
})

test('client 半导出 apply 与 inject 声明', () => {
  const mod = loadClientModule()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['sessions', 'remote', 'remote.commands'])
})

test('Alt+1 / Alt+2 转发为对应命令，并在捕获阶段吃掉按键', () => {
  const mod = loadClientModule()
  const ctx = createClientContext()
  mod.apply(ctx)
  assert.equal(ctx.listeners.length, 1)
  const handler = ctx.listeners[0]

  const one = keydown({ code: 'Digit1' })
  handler(one)
  const two = keydown({ code: 'Digit2' })
  handler(two)

  assert.deepEqual(ctx.executed, [
    ['sess-1', '/plan-toggle', []],
    ['sess-1', '/plan-review', []],
  ])
  assert.equal(one.prevented, 1)
  assert.equal(two.prevented, 1)
})

test('带 Ctrl/Cmd 的组合、按住重复、其它键一律忽略', () => {
  const mod = loadClientModule()
  const ctx = createClientContext()
  mod.apply(ctx)
  const handler = ctx.listeners[0]

  const cases = [
    keydown({ ctrlKey: true }),
    keydown({ metaKey: true }),
    keydown({ repeat: true }),
    keydown({ code: 'KeyA' }),
    keydown({ altKey: false }),
  ]
  for (const event of cases) handler(event)

  assert.deepEqual(ctx.executed, [])
  assert.ok(cases.every(event => event.prevented === 0), '忽略的按键不得吞掉事件')
})

test('没有当前会话时不发命令、不抢键', () => {
  const mod = loadClientModule()
  const ctx = createClientContext({ current: null })
  mod.apply(ctx)
  const event = keydown({ code: 'Digit2' })
  ctx.listeners[0](event)
  assert.deepEqual(ctx.executed, [])
  assert.equal(event.prevented, 0)
})

test('命令执行失败不抛出（只记录，不影响键盘）', async () => {
  const mod = loadClientModule()
  const ctx = createClientContext()
  ctx.get = name => (name === 'sessions'
    ? { list: { getSnapshot: () => ({ current: 'sess-1' }) } }
    : { commands: { execute: () => Promise.reject(new Error('boom')) } })
  mod.apply(ctx)
  assert.doesNotThrow(() => ctx.listeners[0](keydown({ code: 'Digit1' })))
  await new Promise(resolve => setTimeout(resolve, 0))
})
