/**
 * dsh-plan-toggle —— DSH Web 插件的 host 半。
 *
 * 两个命令（由浏览器半的快捷键触发）：
 *   - `/plan-toggle`（Alt+1）：进/出官方 plan 模式（软拦截：只切 plan 状态，不动 sandbox）。
 *   - `/plan-review`（Alt+2）：plan 模式下的一条流水线 —— 取草稿 → fresh-context 子代理只读复核
 *     → 修订并归档到 `<cwd>/docs/plans/YYYY-MM-DD-功能名.md` → 退出 plan 模式 → 注入执行轮
 *     → 执行轮结束后自动注入一次自查。
 *
 * 设计原则（照本仓库复核结论）：
 *   - 官方源码零改动，全部走官方服务：agentPresets / subagents / commands / sessionQuery。
 *   - 只 import 一个官方包（@deepseek-ai/dsh-llm 的 createUserMessage）；其余一律走服务，
 *     避免跨安装副本的版本漂移。
 *   - 零人工确认（用户选定）：不依赖 exit_plan_mode 审批通道，改用 planMode.set(agent,false)，
 *     即官方 /plan off 按钮的同一条 API，确定性退出，不赌 waterfall 监听顺序。
 *   - 复核者只读 + 只拿草稿（fresh context），归档由插件写：toolFilter 只管到工具名、管不到
 *     路径，所以"只能写 docs/plans/"这种约束不能交给子代理自律。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { archivePlan } from './archive.js'
import { createHardGate } from './sandbox.js'
import { DEFAULT_PTC_PRESETS, isPtcSession } from './presentation.js'
import {
  canStartReview,
  createSessionStates,
  executionInstruction,
  extractDraft,
  localDate,
  MODE,
  nextToggleMode,
  reviewerSchema,
  selfReviewInstruction,
  validateReview,
  buildReviewerPrompt,
} from './state.js'

/** 插件名：同时是 cordis 行 id、命令来源标记与 client bundle id。 */
export const name = 'dsh-plan-toggle'

/** 需要的官方 host 服务（web profile 均未禁用，见 cordis.patch.yml 注释）。 */
export const inject = ['agentPresets', 'subagents', 'commands', 'sessionQuery']

/** 复核子代理使用的 provider（base 层默认注册的进程内 spawn）。 */
const REVIEW_PROVIDER = 'spawn'

/** 复核超时：超时即失败，绝不带着未复核的计划去执行。 */
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000

/** 退出 plan 模式的重试次数（'queued' 表示 agent 又开了轮，等空闲后再落盘）。 */
const LEAVE_PLAN_ATTEMPTS = 5

const success = text => ({ kind: 'success', text })
const failure = text => ({ kind: 'error', text })

/** 复核者允许使用的工具：全部只读（write/edit 与 bash 一律不给）。 */
const REVIEW_TOOL_ALLOW = ['read', 'grep', 'glob']

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 取该 agent 的 plan 模式服务。plan-mode 由 agent preset 挂在 isolate realm 里，
 * 因此必须走 agentPresets.serviceFor（agent.ctx / host ctx 都取不到）。
 * @param ctx - host context。
 * @param agent - 目标 agent。
 * @returns plan 模式控制器，或 undefined（该 preset 没挂 plan-mode）。
 */
function planModeOf(ctx, agent) {
  return ctx.agentPresets.serviceFor(agent, 'planMode')
}

/**
 * PTC 会话的拒绝文案。刻意写成"已忽略本次按键 + 下一步怎么做"：
 * 命令结果会在 UI 里内联渲染，用户看到的就是这条。
 */
const PTC_REFUSAL = [
  '当前会话是 PTC 模式（工具被塌缩成 run_code，其程序可访问 Node API，能绕过沙箱写文件），',
  '硬拦截 plan 模式只在 standard（原生工具）会话可用，本次按键已忽略、未做任何改动。',
  '请新建一个 standard 预设的会话再使用（选预设要在会话开始对话前选好：会话一旦开聊，预设就锁定了，不能中途切换）。',
].join('')

/** 判定该 agent 的会话是否处在 PTC 表现层（见 lib/presentation.js 的证据链）。 */
function ptcOf(ctx, agent, ptcPresets) {
  return isPtcSession({ tools: ctx.get('tools'), agent, session: agent.session, ptcPresets })
}

/**
 * PTC 拒绝前记一行带证据的日志：判定要么正确要么被拒绝，出问题时靠这条定位
 * （`evidence: 'run_code'` = 工具注册表证据；`'preset'` = 退到了预设名单——通常说明
 * `ctx.get('tools')` 没拿到）。
 */
function logPtcRefusal(ctx, sessionId, evidence) {
  ctx.logger?.info?.(`${name}: PTC 会话拒绝（evidence=${evidence}，session=${sessionId}）`)
}

/**
 * Alt+1：normal ↔ plan 模式。任意其它状态一律视为中止流水线并回 normal。
 * 不打断正在跑的 turn —— 只切模式与状态，让模型自己收尾。
 *
 * 硬拦截：进入 planning 时同时把沙箱切到只读（见 lib/sandbox.js 的 C/B 两条官方入口），
 * 离开时还原；还原失败也必须把 plan 模式关掉，不能把用户留在只读状态里。
 * @returns 命令结果。
 */
function togglePlanMode(ctx, states, gate, agent) {
  const planMode = planModeOf(ctx, agent)
  if (planMode === undefined) {
    return failure('当前会话的 preset 没有挂载 plan mode（@deepseek-ai/dsh-plan-mode），无法切换。')
  }
  const sessionId = agent.session.id
  const previous = states.get(sessionId)
  const target = nextToggleMode(previous.mode)

  if (target === MODE.planning) {
    const outcome = planMode.set(agent, true)
    const descriptor = gate.enter(agent.session)
    states.set(sessionId, MODE.planning, descriptor)
    const hard = descriptor === undefined
      ? '沙箱只读不可用（未挂 permission-presets/sandbox-policy），当前为软拦截'
      : `沙箱已切只读（${descriptor.via === 'preset' ? `预设 ${descriptor.presetName}` : 'sandbox/mode'}）`
    return success(`plan 模式已开启（${outcome}）；${hard}。先聊清楚需求，然后按 Alt+2 复核并执行；再按 Alt+1 退出。`)
  }

  const restored = gate.leave(agent, states.takeGate(sessionId))
  const outcome = planMode.set(agent, false)
  states.set(sessionId, MODE.normal)
  const note = restored === 'none' ? '' : `（沙箱已还原：${restored}）`
  return success(`plan 模式已关闭（${outcome}）${note}，流水线状态已清空。`)
}

/** 退出 plan 模式：'queued' 说明又开了轮，等空闲后重试，直到落盘。 */
async function leavePlanMode(agent, planMode) {
  for (let attempt = 0; attempt < LEAVE_PLAN_ATTEMPTS; attempt += 1) {
    const outcome = planMode.set(agent, false)
    if (outcome === 'committed' || outcome === 'noop' || outcome === 'cancelled') return outcome
    await agent.whenIdle()
  }
  throw new Error(`planMode.set 一直返回 queued，无法退出 plan 模式`)
}

/**
 * 建并等待一个只读复核子代理。跨 provider 边界一律当不可信数据处理：
 * 非 completed / 结构不符 → 抛错（调用方负责停在 plan 模式）。
 * @returns 规整后的 `{findings, revisedPlan}`。
 */
async function runReviewerSubagent(ctx, agent, draft, outerSignal) {
  const provider = ctx.subagents.getProvider(REVIEW_PROVIDER)
  if (provider === undefined) {
    throw new Error(`复核 provider "${REVIEW_PROVIDER}" 未注册（缺 @deepseek-ai/dsh-subagent-spawn-in-process？）`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`复核 provider "${REVIEW_PROVIDER}" 不支持结构化输出`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`复核 provider "${REVIEW_PROVIDER}" 会继承父会话上下文，不是 fresh context`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('复核超时')), REVIEW_TIMEOUT_MS)
  const relayAbort = () => controller.abort(outerSignal?.reason)
  outerSignal?.addEventListener('abort', relayAbort, { once: true })
  let run
  try {
    run = await ctx.subagents.start(REVIEW_PROVIDER, {
      label: 'plan-reviewer',
      parent: agent,
      prompt: [{ type: 'text', text: buildReviewerPrompt({ draft, cwd: agent.session.header.cwd ?? process.cwd() }) }],
      signal: controller.signal,
      outputSchema: reviewerSchema(),
      toolFilter: { allow: REVIEW_TOOL_ALLOW },
      maxDepth: 0,
    })
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`复核子代理未正常完成（stopReason=${result.stopReason}）`)
    }
    if (result.structured === undefined) {
      throw new Error('复核子代理没有返回结构化结果')
    }
    return validateReview(result.structured)
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', relayAbort)
    if (run !== undefined) await run.dispose()
  }
}

/**
 * 沙箱镜像：官方 `/plan`、UI 徽章、`Shift+Tab` 等入口也会进入 plan 模式，
 * 那不走本插件的命令，所以每次工具调用前对一次官方状态 —— active 且未切就切只读，
 * inactive 且切过就还原。这样"硬拦"不再依赖用户按 Alt+1。
 *
 * 只在 normal/planning 两态生效：reviewing/executing 的 gate 由流水线自己管，
 * 镜像无权覆写（否则会打断"归档后先还原再执行"的顺序）。
 * @param ptc - 该会话是否为 PTC：PTC 下本插件不提供该功能，不碰沙箱。
 */
function reconcileSandbox(ctx, states, gate, agent, ptc) {
  if (ptc) return
  const planMode = planModeOf(ctx, agent)
  if (planMode === undefined) return
  const sessionId = agent.session.id
  const entry = states.get(sessionId)
  if (entry.mode !== MODE.normal && entry.mode !== MODE.planning) return
  const active = planMode.get(agent).active === true
  if (active && entry.gate === undefined) {
    const descriptor = gate.enter(agent.session)
    if (descriptor === undefined) return
    states.setGate(sessionId, descriptor)
    // 官方入口进来的也算 planning：否则 Alt+2 会被自己的状态机拒掉。
    if (entry.mode === MODE.normal) states.set(sessionId, MODE.planning, descriptor)
  } else if (!active && entry.gate !== undefined) {
    gate.leave(agent, states.takeGate(sessionId))
    if (entry.mode === MODE.planning) states.set(sessionId, MODE.normal)
  }
}

/**
 * Alt+2：复核 → 归档 → 退出 plan → 执行。每个 await 之后都重新确认模式仍是 reviewing，
 * 这样用户在等待期间按 Alt+1 能立刻中止流水线（不会留下"复核完却偷偷执行"的窗口）。
 *
 * 硬拦截的还原点：归档完成后、steer 执行之前。必须在这里恢复写权限，
 * 否则模型在只读沙箱下执行会全部失败。
 * @returns 命令结果（成功时执行轮已经开始）。
 */
async function runPlanReview(ctx, states, gate, agent, signal) {
  const sessionId = agent.session.id
  const entry = states.get(sessionId)
  if (entry.mode !== MODE.planning) {
    return failure('当前不在 plan 模式：先按 Alt+1 进入 plan 模式聊清楚需求，再按 Alt+2。')
  }
  if (!canStartReview({ mode: entry.mode, status: agent.status })) {
    return failure(`agent 现在不是空闲（status=${agent.status}），等这一轮跑完再按 Alt+2。`)
  }
  const planMode = planModeOf(ctx, agent)
  if (planMode === undefined) {
    return failure('当前会话的 preset 没有挂载 plan mode（@deepseek-ai/dsh-plan-mode）。')
  }

  states.set(sessionId, MODE.reviewing, entry.gate)
  try {
    const snapshot = await ctx.sessionQuery.readSurface(agent.session.id)
    const draft = extractDraft(snapshot.events)
    if (draft.trim() === '') throw new Error('会话里没有可复核的需求/计划文本')

    const review = await runReviewerSubagent(ctx, agent, draft, signal)
    if (states.get(sessionId).mode !== MODE.reviewing) {
      return failure('流水线已被 Alt+1 中止（复核结果未归档、未执行）。')
    }

    const archived = await archivePlan({
      cwd: agent.session.header.cwd ?? process.cwd(),
      planText: review.revisedPlan,
      dateStr: localDate(),
    })
    if (states.get(sessionId).mode !== MODE.reviewing) {
      return failure('流水线已被 Alt+1 中止（计划已归档但未执行）。')
    }

    // 先还原沙箱写权限、再退 plan 模式，然后才允许执行轮写入。
    gate.leave(agent, states.takeGate(sessionId))
    states.set(sessionId, MODE.executing)
    await leavePlanMode(agent, planMode)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: executionInstruction({ archivePath: archived.path, findings: review.findings }) }],
      source: { kind: 'plugin', plugin: name },
    }))
    const fixed = review.findings.filter(finding => finding.resolution === 'fixed').length
    return success(
      `复核完成：${review.findings.length} 条发现（${fixed} 条已修订）→ 已归档 ${archived.path}（${archived.mode}）→ 沙箱已还原 → 执行轮已启动。`,
    )
  } catch (error) {
    // 失败一律回到 planning：保留需求讨论上下文，让用户能直接重试或手改。
    if (states.get(sessionId).mode === MODE.reviewing) states.set(sessionId, MODE.planning, states.get(sessionId).gate)
    ctx.logger?.error?.(`${name}: 复核流水线失败`, error)
    return failure(`复核流水线失败，仍停在 plan 模式：${describeError(error)}`)
  }
}

/**
 * 执行轮结束后注入一次自查。turn-stopping 每轮都会触发，因此用状态门控：
 * 只有 executing 且未自查过才注入，注入后立即回 normal。
 */
function runSelfReview(states, agent) {
  const sessionId = agent.session.id
  const entry = states.get(sessionId)
  if (entry.mode !== MODE.executing || entry.reviewFired) return
  states.markReviewFired(sessionId)
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: selfReviewInstruction() }],
    source: { kind: 'plugin', plugin: name },
  }))
}

/**
 * 挂载插件：两条命令 + 工具闸门（镜像 / 可选 blockBash）。所有注册都走 ctx.effect / ctx.on，
 * 卸载时随 fiber 一起释放。
 * @param ctx - host context。
 * @param config - 插件行 config：`ptcPresets`（兜底判定名单）、`blockBash`（true 时
 *   standard 会话的 plan 模式下连 `bash`/`pwsh` 一起拒）。
 */
export function apply(ctx, config = {}) {
  const states = createSessionStates()
  const ptcPresets = Array.isArray(config.ptcPresets) && config.ptcPresets.length > 0
    ? config.ptcPresets
    : DEFAULT_PTC_PRESETS
  const blockBash = config.blockBash === true
  // 官方服务软取。懒建立（首次按键时才读）：这三个服务不在本插件的 inject 列表里，
  // 若在 apply 时急切捕获，加载顺序稍有不同就会得到 undefined，静默降级为软拦截。
  let gate
  const hardGate = () => {
    gate ??= createHardGate({
      permissionPresets: ctx.get('permissionPresets'),
      sandboxPolicy: ctx.get('sandboxPolicy'),
      approval: ctx.get('approval'),
    })
    return gate
  }

  ctx.effect(() => ctx.commands.register({
    name: 'plan-toggle',
    description: 'Plan toggle (Alt+1): enter or leave plan mode.',
    handler: ({ agent }) => {
      const { ptc, evidence } = ptcOf(ctx, agent, ptcPresets)
      if (ptc) {
        logPtcRefusal(ctx, agent.session.id, evidence)
        return failure(PTC_REFUSAL)
      }
      return togglePlanMode(ctx, states, hardGate(), agent)
    },
  }), `${name}: /plan-toggle`)

  ctx.effect(() => ctx.commands.register({
    name: 'plan-review',
    description: 'Plan review pipeline (Alt+2): subagent review, archive, auto-execute, self-review.',
    handler: ({ agent, signal }) => {
      const { ptc, evidence } = ptcOf(ctx, agent, ptcPresets)
      if (ptc) {
        logPtcRefusal(ctx, agent.session.id, evidence)
        return failure(PTC_REFUSAL)
      }
      return runPlanReview(ctx, states, hardGate(), agent, signal)
    },
  }), `${name}: /plan-review`)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined) return next()
    const { ptc } = ptcOf(ctx, exec.agent, ptcPresets)
    reconcileSandbox(ctx, states, hardGate(), exec.agent, ptc)
    if (blockBash && !ptc && (exec.name === 'bash' || exec.name === 'pwsh')) {
      const planMode = planModeOf(ctx, exec.agent)
      if (planMode?.get(exec.agent).active === true) {
        return {
          kind: 'deny',
          reason: 'plan 模式禁止执行命令。请改用 read/grep/glob 只读探索，或把方案写进计划后按 Alt+2。',
        }
      }
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    runSelfReview(states, agent)
  })
}
