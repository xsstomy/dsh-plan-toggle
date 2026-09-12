/**
 * PTC 判定单测。
 *
 * 这条判定决定"按键是否被拒绝"，判错的两种后果都很糟：standard 用户被误拒（功能不可用）、
 * PTC 用户被放进硬拦流程（拿到虚假保证）。因此三种证据来源与两条降级路径都要钉死。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PTC_PRESETS, isPtcSession, RUN_CODE_NAME } from '../lib/presentation.js'

const agent = { session: { id: 's1', header: { cwd: '/repo' } } }
const sessionWith = preset => ({ id: 's1', header: { cwd: '/repo', ...(preset === undefined ? {} : { agentPreset: preset }) } })

test('主证据：ctx.tools 有 run_code → PTC', () => {
  const tools = { get: name => (name === RUN_CODE_NAME ? { name } : undefined) }
  assert.deepEqual(isPtcSession({ tools, agent, session: sessionWith('standard') }), {
    ptc: true,
    evidence: 'run_code',
  })
})

test('主证据：ctx.tools 没有 run_code → standard（即使预设名看起来像 ptc）', () => {
  const tools = { get: () => undefined }
  assert.deepEqual(isPtcSession({ tools, agent, session: sessionWith('ptc') }), {
    ptc: false,
    evidence: 'run_code',
  })
})

test('兜底：ctx.tools 缺失时按预设 id 判定', () => {
  assert.deepEqual(isPtcSession({ tools: undefined, agent, session: sessionWith('ptc') }), {
    ptc: true,
    evidence: 'preset',
  })
  assert.deepEqual(isPtcSession({ tools: undefined, agent, session: sessionWith('standard') }), {
    ptc: false,
    evidence: 'preset',
  })
})

test('兜底：自定义名单生效', () => {
  const result = isPtcSession({
    tools: undefined,
    agent,
    session: sessionWith('my-ptc'),
    ptcPresets: ['my-ptc'],
  })
  assert.deepEqual(result, { ptc: true, evidence: 'preset' })
  assert.deepEqual(DEFAULT_PTC_PRESETS, ['ptc'])
})

test('无预设字段 → unknown，且按可用处理（不误伤）', () => {
  assert.deepEqual(isPtcSession({ tools: undefined, agent, session: sessionWith(undefined) }), {
    ptc: false,
    evidence: 'unknown',
  })
  assert.deepEqual(isPtcSession({ tools: undefined, agent }), { ptc: false, evidence: 'unknown' })
})

test('tools.get 抛错不穿透：退到预设证据', () => {
  const tools = { get: () => { throw new Error('scope unavailable') } }
  assert.deepEqual(isPtcSession({ tools, agent, session: sessionWith('ptc') }), {
    ptc: true,
    evidence: 'preset',
  })
})

test('agent 缺失时退到预设证据，不会抛', () => {
  const tools = { get: () => { throw new Error('agent is required') } }
  assert.deepEqual(isPtcSession({ tools, agent: undefined, session: sessionWith('ptc') }), {
    ptc: true,
    evidence: 'preset',
  })
})
