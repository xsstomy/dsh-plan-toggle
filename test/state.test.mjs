/**
 * dsh-plan-toggle 纯逻辑单测（node --test，无需 npm install）。
 *
 * 覆盖的是插件里"会决定行为、且不依赖 ctx/模型/磁盘"的规则：状态机、草稿抽取与截断、
 * 归档命名与同名冲突、复核请求与结构化结果校验。这些规则出错会直接导致误执行，
 * 因此必须能被机器逐条验证。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstTitleOf } from '../lib/archive.js'
import {
  archiveCandidateNames,
  buildReviewerPrompt,
  canStartReview,
  chooseArchiveName,
  createSessionStates,
  executionInstruction,
  extractDraft,
  keepTailBytes,
  localDate,
  MAX_DRAFT_BYTES,
  MODE,
  nextToggleMode,
  pickArchiveSlug,
  pickArchiveTitle,
  reviewerSchema,
  samePlanTitle,
  selfReviewInstruction,
  textOfEvent,
  validateReview,
} from '../lib/state.js'

const userEvent = (text, seq = 0) => ({
  type: 'user/message',
  seq,
  time: 0,
  data: { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

const assistantEvent = (text, seq = 1) => ({
  type: 'assistant/message',
  seq,
  time: 0,
  data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }] } },
})

test('状态机：Alt+1 只在 normal 与 planning 之间切换，其余状态一律回 normal', () => {
  assert.equal(nextToggleMode(MODE.normal), MODE.planning)
  assert.equal(nextToggleMode(MODE.planning), MODE.normal)
  assert.equal(nextToggleMode(MODE.reviewing), MODE.normal)
  assert.equal(nextToggleMode(MODE.executing), MODE.normal)
})

test('状态机：Alt+2 仅在 planning 且 agent 空闲时可启动', () => {
  assert.equal(canStartReview({ mode: MODE.planning, status: 'idle' }), true)
  assert.equal(canStartReview({ mode: MODE.planning, status: 'running' }), false)
  assert.equal(canStartReview({ mode: MODE.normal, status: 'idle' }), false)
  assert.equal(canStartReview({ mode: MODE.executing, status: 'idle' }), false)
})

test('会话状态表：默认 normal，自审标记只生效一次', () => {
  const states = createSessionStates()
  assert.deepEqual(states.get('s1'), { mode: MODE.normal, reviewFired: false })
  states.set('s1', MODE.executing)
  assert.equal(states.get('s1').mode, MODE.executing)
  states.markReviewFired('s1')
  assert.deepEqual(states.get('s1'), { mode: MODE.normal, reviewFired: true })
  states.reset('s1')
  assert.equal(states.size, 0)
})

test('草稿抽取：只取 user/assistant 文本，忽略工具结果', () => {
  const events = [
    userEvent('把登录改成 SSO', 0),
    { type: 'tool/result', seq: 1, time: 0, data: { huge: 'x'.repeat(10) } },
    assistantEvent('# 计划\n1. 读代码', 2),
  ]
  const draft = extractDraft(events)
  assert.match(draft, /把登录改成 SSO/)
  assert.match(draft, /# 计划/)
  assert.doesNotMatch(draft, /huge/)
  assert.equal(textOfEvent(events[1]), undefined)
})

test('草稿抽取：超限保留尾部并标注截断', () => {
  const long = 'A'.repeat(1000)
  const draft = extractDraft([userEvent(long)], 100)
  assert.match(draft, /^\[truncated: kept the last 100 bytes\]/)
  assert.equal(keepTailBytes('short', 100), 'short')
  assert.ok(Buffer.byteLength(draft, 'utf8') <= 100 + 64)
  assert.equal(MAX_DRAFT_BYTES, 60 * 1024)
})

test('草稿抽取：默认上限为 60KB，且按字节而非字符计算', () => {
  const big = '中'.repeat(40 * 1024) // 120KB UTF-8
  const draft = extractDraft([userEvent(big)])
  assert.ok(Buffer.byteLength(draft, 'utf8') < 61 * 1024)
  assert.ok(draft.includes('中'))
})

test('归档命名：标题取首行，slug 去路径不安全字符并限长', () => {
  assert.equal(pickArchiveTitle('\n\n# 计划：plan-toggle/自动执行\n正文'), '计划：plan-toggle/自动执行')
  assert.equal(pickArchiveSlug('# 计划：plan-toggle/自动执行'), '计划-plan-toggle-自动执行')
  assert.equal(pickArchiveSlug(''), 'plan')
  assert.equal([...pickArchiveSlug(`# ${'长'.repeat(50)}`)].length, 24)
})

test('归档候选：默认名 + -2/-3 递增后缀', () => {
  assert.deepEqual(archiveCandidateNames('2026-09-12', 'login', 3), [
    '2026-09-12-login.md',
    '2026-09-12-login-2.md',
    '2026-09-12-login-3.md',
  ])
})

test('归档决策：不存在则新建；同标题原地更新；同名不同计划不覆盖', () => {
  const planTitle = '计划：SSO 登录'
  assert.deepEqual(
    chooseArchiveName({ planTitle, candidates: [{ name: 'a.md', exists: false, firstTitle: '' }] }),
    { name: 'a.md', mode: 'create' },
  )
  assert.deepEqual(
    chooseArchiveName({ planTitle, candidates: [{ name: 'a.md', exists: true, firstTitle: '# 计划：SSO 登录' }] }),
    { name: 'a.md', mode: 'update' },
  )
  assert.deepEqual(
    chooseArchiveName({
      planTitle,
      candidates: [
        { name: 'a.md', exists: true, firstTitle: '# 另一个计划' },
        { name: 'a-2.md', exists: false, firstTitle: '' },
      ],
    }),
    { name: 'a-2.md', mode: 'create' },
  )
  assert.equal(
    chooseArchiveName({ planTitle, candidates: [{ name: 'a.md', exists: true, firstTitle: '# 另一个计划' }] }),
    undefined,
  )
})

test('同标题判定忽略 # 前缀与空白，空标题不算同一份', () => {
  assert.equal(samePlanTitle('## 计划 A ', '计划 A'), true)
  assert.equal(samePlanTitle('', ''), false)
  assert.equal(samePlanTitle('计划 B', '计划 A'), false)
  assert.equal(firstTitleOf('\n# 计划 A\n正文'), '计划 A')
})

test('复核请求：prompt 自带草稿、cwd 与三类检查，schema 为对象根且字段齐全', () => {
  const prompt = buildReviewerPrompt({ draft: '草稿内容', cwd: '/repo' })
  assert.match(prompt, /草稿内容/)
  assert.match(prompt, /\/repo/)
  assert.match(prompt, /错误/)
  assert.match(prompt, /遗漏/)
  assert.match(prompt, /歧义/)
  assert.match(prompt, /只读/)

  const schema = reviewerSchema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual([...schema.required].sort(), ['findings', 'revisedPlan'])
  const item = schema.properties.findings.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual([...item.required].sort(), ['evidence', 'location', 'reason', 'resolution', 'severity'])
  assert.deepEqual(item.properties.severity.enum, ['P0', 'P1', 'P2'])
  assert.deepEqual(item.properties.resolution.enum, ['fixed', 'dismissed'])
})

test('复核结果校验：接受合法形状，拒绝半成品', () => {
  const good = validateReview({
    findings: [{ severity: 'P1', location: 'x.md:1', evidence: 'e', resolution: 'fixed', reason: 'r' }],
    revisedPlan: '# 计划\n1. 做',
  })
  assert.equal(good.findings.length, 1)
  assert.equal(good.revisedPlan, '# 计划\n1. 做')

  assert.throws(() => validateReview(null), /不是对象/)
  assert.throws(() => validateReview({ findings: [], revisedPlan: '   ' }), /revisedPlan/)
  assert.throws(() => validateReview({ findings: {}, revisedPlan: '# x' }), /findings/)
  assert.throws(
    () => validateReview({ findings: [{ severity: 'P9', location: '', evidence: '', resolution: 'fixed', reason: '' }], revisedPlan: '# x' }),
    /severity/,
  )
  assert.throws(
    () => validateReview({ findings: [{ severity: 'P0', location: '', evidence: '', resolution: 'later', reason: '' }], revisedPlan: '# x' }),
    /resolution/,
  )
})

test('执行与自审指令：带归档绝对路径；有未解决 P0 时要求先问用户', () => {
  const blocked = executionInstruction({
    archivePath: '/repo/docs/plans/2026-09-12-x.md',
    findings: [{ severity: 'P0', resolution: 'dismissed', reason: 'r' }],
  })
  assert.match(blocked, /\/repo\/docs\/plans\/2026-09-12-x\.md/)
  assert.match(blocked, /先停下来问用户/)
  const normal = executionInstruction({ archivePath: '/p.md', findings: [] })
  assert.doesNotMatch(normal, /P0 发现/)
  assert.match(selfReviewInstruction(), /Execution Review/)
})

test('日期用本地时间格式化为 YYYY-MM-DD', () => {
  assert.equal(localDate(new Date(2026, 8, 12, 23, 30)), '2026-09-12')
  assert.equal(localDate(new Date(2026, 0, 3, 0, 1)), '2026-01-03')
})
