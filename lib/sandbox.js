/**
 * 硬拦截（sandbox 只读）的官方入口封装。
 *
 * 为什么需要它：官方 plan mode 只是**软提示词**（模型自觉不写文件）。要真正挡住写入，
 * 官方机制是沙箱策略 —— `SandboxMode` 三档（read-only / workspace-write /
 * danger-full-access）由 fs/bash/terminal 三个受限能力共同消费。本模块提供两条官方入口：
 *
 *   C（首选，走官方预设）：`ctx.permissionPresets.set(session, <只读预设>)`
 *      —— 官方 permission-presets 服务会写 `permission/preset` 并调用各自权威 setter
 *      （setSandboxMode + setApprovalPolicy），因此 UI 的选择器会显示该预设，
 *      审批策略也一并设定。不注入任何配置：预设表由部署方拥有，本插件只"挑一个沙箱只读的"。
 *   B（兜底，直接 setter）：`setSandboxMode(session, 'read-only')`
 *      —— 官方导出的写路径（permission-presets 内部同样调用它）。部署没有只读预设、
 *      或压根没挂 permission-presets 时使用。
 *
 * 离开时按相反顺序还原：优先切回进入前的预设名（旋钮与记录都一致）；进入前不是预设
 * （`custom`）时，直接把快照里的旋钮值写回去。
 *
 * 注意：官方**不会**为了模式切换改动工具表（请求缓存稳定性），所以硬拦截的效果是
 * "写操作被沙箱拒绝（EACCES/EPERM）"，而不是把 write/edit 从工具列表里摘掉。
 */

import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

/** 只读沙箱模式名（官方 SANDBOX_MODES 之一）。 */
export const READ_ONLY_MODE = 'read-only'

/** 预设名偏好：部署若定义了语义化的 `plan` 预设就用它，否则用官方自带的 `read-only`。 */
const PREFERRED_PRESET_NAMES = ['plan', 'read-only']

/** 官方 permission-presets 用 `custom` 表示"旋钮组合不匹配任何预设"，它不可被选中。 */
const CUSTOM_PRESET = 'custom'

/**
 * 从预设表里挑一个"沙箱只读"的预设（纯函数，便于单测）。
 * @param entries - `{name, sandbox, approval}` 列表（由调用方从官方服务解析得到）。
 * @returns 选中的预设，或 undefined（表中没有只读预设）。
 */
export function pickReadOnlyPreset(entries) {
  const readOnly = (entries ?? []).filter(entry => entry.sandbox === READ_ONLY_MODE)
  for (const preferred of PREFERRED_PRESET_NAMES) {
    const hit = readOnly.find(entry => entry.name === preferred)
    if (hit !== undefined) return hit
  }
  return readOnly[0]
}

/**
 * 读当前状态快照（离开只读时按它还原）。
 *
 * `adopted` 的含义（这个字段是修 bug 的关键）：读到的**沙箱已经是只读**时，说明这个只读态大概率
 * 不是用户的选择，而是本插件自己压上去的（插件重启后采纳官方 plan 模式 / 镜像先跑过一次）。
 * 这种快照**不能当作还原目标**，否则还原出来还是只读，会话会永久卡在只读里（实测过的线上现象）。
 * @returns `{presetName, sandbox, approval, adopted}`，缺失的服务对应字段为 undefined。
 */
function snapshot({ sandboxPolicy, approval, permissionPresets }, session) {
  const mode = sandboxPolicy?.resolve({ session })?.mode
  const policy = approval?.overrideOf(session) ?? approval?.config?.policy
  const adopted = mode === READ_ONLY_MODE
  let presetName
  try {
    presetName = permissionPresets?.current(session)
  } catch {
    // 没有预设服务/投影时读不到当前预设名，按"非预设"处理（还原走旋钮直写）。
    presetName = undefined
  }
  return { presetName: adopted ? undefined : presetName, sandbox: mode, approval: policy, adopted }
}

/**
 * 部署默认的旋钮值（无 session 的 `resolve()` 返回部署默认模式）。
 * 作为"进入前状态未知"时的最后一级兜底。
 */
function deploymentDefault({ sandboxPolicy, approval }) {
  return { sandbox: sandboxPolicy?.resolve()?.mode, approval: approval?.config?.policy }
}

/**
 * 造一个硬拦截闸门。服务都从 ctx 软取（官方 API），缺失即降级为"不可用"，
 * 让插件在没挂沙箱的部署里仍能作为软拦截工作。
 * @param input.permissionPresets - 官方 `ctx.permissionPresets`（可缺）。
 * @param input.sandboxPolicy - 官方 `ctx.sandboxPolicy`（可缺）。
 * @param input.approval - 官方 `ctx.approval`（可缺）。
 * @returns 闸门：`available` 判定 + `enter` / `leave`。
 */
export function createHardGate({ permissionPresets, sandboxPolicy, approval }) {
  /** 每个会话最近一次见到的"非只读"预设名：快照不可靠时先还给它。 */
  const lastSettledPreset = new Map()

  /** 这个预设名能不能安全 `set()`（不存在 / 保留名 / 服务缺失都不行）。 */
  function presetExists(name) {
    if (permissionPresets === undefined) return false
    if (typeof name !== 'string' || name === '' || name === CUSTOM_PRESET) return false
    try {
      return permissionPresets.names.includes(name)
    } catch {
      return false
    }
  }

  /** `set()` 可能抛（未知预设名）；失败就不算还原成功，让调用方走下一级兜底。 */
  function setPreset(session, name) {
    try {
      permissionPresets.set(session, name)
      return true
    } catch {
      return false
    }
  }

  /** 部署配置里的默认预设（`permission.defaultPreset`），读不到就 undefined。 */
  function defaultPresetName() {
    try {
      return permissionPresets?.defaultPreset
    } catch {
      return undefined
    }
  }

  /** 解析预设表（官方 names getter + resolve），拿不到就返回空表。 */
  function readOnlyPreset() {
    if (permissionPresets === undefined) return undefined
    let names
    try {
      names = permissionPresets.names
    } catch {
      return undefined
    }
    if (!Array.isArray(names) || names.length === 0) return undefined
    const entries = names
      .filter(name => name !== CUSTOM_PRESET)
      .map(name => {
        try {
          const spec = permissionPresets.resolve(name)
          return { name, sandbox: spec.sandbox, approval: spec.approval }
        } catch {
          return undefined
        }
      })
      .filter(entry => entry !== undefined)
    return pickReadOnlyPreset(entries)
  }

  return {
    /** 有没有可用的硬拦截入口（没有就退回官方的软提示词）。 */
    available: sandboxPolicy !== undefined || permissionPresets !== undefined,

    /**
     * 进入只读。
     * @param session - 目标会话。
     * @returns 描述符（离开时回传），或 undefined 表示硬拦截不可用。
     */
    enter(session) {
      const saved = snapshot({ sandboxPolicy, approval, permissionPresets }, session)
      // 记下“非只读”的预设名：快照不可靠时（重启后采纳 / 镜像先跑）先还给这个。
      if (!saved.adopted && presetExists(saved.presetName)) lastSettledPreset.set(session.id, saved.presetName)
      const preset = readOnlyPreset()
      if (preset !== undefined && permissionPresets !== undefined) {
        permissionPresets.set(session, preset.name)
        return { via: 'preset', presetName: preset.name, saved }
      }
      if (sandboxPolicy !== undefined) {
        setSandboxMode(session, READ_ONLY_MODE)
        return { via: 'setter', saved }
      }
      return undefined
    },

    /**
     * 离开只读并还原进入前的旋钮。执行阶段必须调用它，否则模型写不进任何文件。
     * @param agent - 目标 agent（还原审批策略需要 agent，官方 setPolicy 的签名如此）。
     * @param descriptor - `enter` 的返回值。
     * @returns 实际使用的还原方式（`preset` / `setter` / `none`）。
     */
    leave(agent, descriptor) {
      if (descriptor === undefined) return 'none'
      const session = agent.session
      const { saved } = descriptor

      // 快照是自己压上去的只读态时，进入前的状态未知（插件重启后采纳官方 plan / 镜像先跑）：
      // 按「上次见到的正常预设 → 部署默认预设 → 部署默认旋钮」逐级还原。拿只读快照直接还原
      // 会把会话永久卡在只读里 —— 这是线上实测到过的 bug。
      if (saved.adopted === true) {
        const remembered = lastSettledPreset.get(session.id)
        if (presetExists(remembered) && setPreset(session, remembered)) return 'preset'
        const fallback = defaultPresetName()
        if (presetExists(fallback) && setPreset(session, fallback)) return 'preset'
        const def = deploymentDefault({ sandboxPolicy, approval })
        if (def.sandbox !== undefined) setSandboxMode(session, def.sandbox)
        if (def.approval !== undefined && approval !== undefined) approval.setPolicy(agent, def.approval)
        return 'setter'
      }

      if (presetExists(saved.presetName) && setPreset(session, saved.presetName)) return 'preset'
      if (saved.sandbox !== undefined) setSandboxMode(session, saved.sandbox)
      if (saved.approval !== undefined && approval !== undefined) {
        approval.setPolicy(agent, saved.approval)
      }
      return 'setter'
    },
  }
}
