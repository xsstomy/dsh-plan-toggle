/**
 * 表现层判定：这个会话的**模型可见工具表**是否被塌缩成 `run_code`（PTC / both）。
 *
 * 为什么需要它：PTC 下模型只能直接调 `run_code`，而它的程序**权限等同 bash、可访问 Node API**
 * （官方 `packages/code-runtime/code-runtime-worker-thread/README.zh.md`），`require('node:fs')`
 * 可以绕过 fs-sandbox（只管 write/edit 工具）与 bash-sandbox（只管 spawn 的进程）两层防线；
 * 官方 `ctx.tools.restrict()` 明确不能限制 `run_code`（`packages/core/tools/src/index.ts:1075`）。
 * 因此 PTC 会话里"写不进文件"做不到，本插件对它改走"拒绝 + 提示切 standard"。
 *
 * 判定证据（优先级从高到低）：
 *   1. `ctx.tools.get('run_code', agent)` —— 权威。保留传输工具只对 `modeFor(scope) !== 'native'`
 *      的 scope 追加（`packages/core/tools/src/index.ts:1179-1180`），所以"存在 ⇔ 模型可直达 run_code"。
 *      注意**不能**用 `ctx.tools.schemas(agent)`：它返回与表现层无关的注册表视图（同文件 `1224-1226`
 *      → `view().visible`），PTC 下照样包含原生工具，塌缩只发生在私有的 `wireSchemas()`。
 *   2. 会话 header 的 `agentPreset` 与可配置名单比对 —— `ctx.tools` 取不到时的兜底。
 *
 * 两侧都拿不到证据时按"可用"（ptc: false）处理：宁可让 standard 用户正常用，也不误伤。
 */

/** 官方 PTC 表现层的保留传输工具名（`packages/core/tools/src/ptc.ts:20`，从包入口导出）。 */
export const RUN_CODE_NAME = 'run_code'

/** 默认按预设 id 识别的 PTC 名单（可由插件行 config 覆盖）。 */
export const DEFAULT_PTC_PRESETS = ['ptc']

/**
 * 判定一个会话是否处在 PTC（工具塌缩）表现层。
 * @param input.tools - 官方 `ctx.tools`（可缺：缺了就走预设兜底）。
 * @param input.agent - 目标 agent（scope key；`ScopeKey = object`）。
 * @param input.session - 目标会话（读 header.agentPreset）。
 * @param input.ptcPresets - 兜底名单。
 * @returns `{ptc, evidence}`，evidence 为 `'run_code' | 'preset' | 'unknown'`。
 */
export function isPtcSession({ tools, agent, session, ptcPresets = DEFAULT_PTC_PRESETS }) {
  if (tools === undefined || agent === undefined || typeof tools.get !== 'function') {
    return byPreset(session, ptcPresets)
  }
  let transport
  try {
    transport = tools.get(RUN_CODE_NAME, agent)
  } catch {
    // 读不到（agent 未挂到 scope 链、服务已释放等）→ 退到预设 id 证据，绝不让判定抛穿。
    return byPreset(session, ptcPresets)
  }
  return transport === undefined
    ? { ptc: false, evidence: 'run_code' }
    : { ptc: true, evidence: 'run_code' }
}

function byPreset(session, ptcPresets) {
  const preset = session?.header?.agentPreset
  if (typeof preset !== 'string' || preset === '') return { ptc: false, evidence: 'unknown' }
  return { ptc: ptcPresets.includes(preset), evidence: 'preset' }
}
