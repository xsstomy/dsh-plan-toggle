/**
 * dsh-plan-toggle 的纯逻辑层：状态机、草稿抽取、归档命名、复核请求/结果规格。
 *
 * 为什么单独一层：插件本体（lib/index.js）只做「编排 + IO」，而这些规则需要在
 * 没有 ctx、没有模型、没有文件系统的前提下被 node --test 直接覆盖。这里刻意
 * 不 import 任何 @deepseek-ai/* 包，因此单测不依赖 npm install。
 */

/** 会话级模式。normal 之外的三态与 pi 的 f8/f9 状态机一一对应。 */
export const MODE = Object.freeze({
  normal: 'normal',
  planning: 'planning',
  reviewing: 'reviewing',
  executing: 'executing',
})

/** 计划草稿注入复核子代理的字节上限（保留尾部，最近的对话更重要）。 */
export const MAX_DRAFT_BYTES = 60 * 1024

/** 同名归档最多尝试的后缀序号（`-2` .. `-50`）。 */
export const MAX_ARCHIVE_ATTEMPTS = 50

/** 复核子代理必须返回的字段，缺一即视为失败（不允许半成品结果被当成成功）。 */
const REVIEW_SEVERITIES = ['P0', 'P1', 'P2']
const REVIEW_RESOLUTIONS = ['fixed', 'dismissed']

/**
 * 进程内的会话状态表。插件重载或会话恢复后一律回 normal：
 * 半途状态误解锁执行的风险远大于丢一次流水线的便利。
 * 每条记录还带一个可选的 `gate`（硬拦截描述符，见 lib/sandbox.js），
 * 用于离开只读时还原进入前的沙箱/审批旋钮。
 * @returns 状态表读写接口。
 */
export function createSessionStates() {
  const states = new Map()
  const normal = () => ({ mode: MODE.normal, reviewFired: false, gate: undefined })
  return {
    get(sessionId) {
      return states.get(sessionId) ?? normal()
    },
    set(sessionId, mode, gate) {
      states.set(sessionId, { mode, reviewFired: false, gate })
    },
    /** 取走并清空该会话的硬拦截描述符（离开只读时用，避免重复还原）。 */
    takeGate(sessionId) {
      const entry = states.get(sessionId)
      if (entry.gate === undefined) return undefined
      states.set(sessionId, { ...entry, gate: undefined })
      return entry.gate
    },
    /**
     * 只写 gate，**不动 mode 与 reviewFired**。
     * 镜像（官方 /plan 进入 → 切只读）必须用它：set() 会把 reviewFired 重置并覆盖
     * 流水线正在用的 reviewing/executing 状态，镜像没有权改那两项。
     */
    setGate(sessionId, descriptor) {
      states.set(sessionId, { ...states.get(sessionId), gate: descriptor })
    },
    /** 自审只允许注入一次：注入后即回 normal，后续轮不再触发。 */
    markReviewFired(sessionId) {
      states.set(sessionId, { mode: MODE.normal, reviewFired: true, gate: undefined })
    },
    reset(sessionId) {
      states.delete(sessionId)
    },
    get size() {
      return states.size
    },
  }
}

/**
 * Alt+1 的目标模式：只在 normal 与 planning 之间切换，
 * reviewing/executing 一律视为「中止流水线」→ normal。
 * @param mode - 当前模式。
 * @returns 切换后的模式。
 */
export function nextToggleMode(mode) {
  return mode === MODE.normal ? MODE.planning : MODE.normal
}

/**
 * Alt+2 是否允许启动流水线：必须在 planning，且 agent 空闲
 * （正忙时启动会与当前轮的执行交叠，无法确定归档/执行的边界）。
 * @param input - 当前模式与 agent 状态。
 * @returns 是否可启动。
 */
export function canStartReview({ mode, status }) {
  return mode === MODE.planning && status === 'idle'
}

/** 取一个 content block 数组里的纯文本。 */
function joinTextBlocks(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 从一个会话 surface 事件里取模型可见文本。只有 user/message 与 assistant/message
 * 产生对话文本；tool/result 刻意排除（工具输出可达数百 KB，且不是需求/计划本体）。
 * @param event - surface 事件（`{type, seq, time, data}`）。
 * @returns 文本，或 undefined 表示无文本。
 */
export function textOfEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'user/message') return joinTextBlocks(event.data?.content)
  if (event.type === 'assistant/message') return joinTextBlocks(event.data?.message?.content)
  return undefined
}

/** 按 UTF-8 字节保留尾部，避免切出半个多字节字符。 */
export function keepTailBytes(text, maxBytes) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return text
  const tail = Buffer.from(text, 'utf8')
    .subarray(bytes - maxBytes)
    .toString('utf8')
    .replace(/^\uFFFD/, '')
  return `[truncated: kept the last ${maxBytes} bytes]\n\n${tail}`
}

/**
 * 拼装复核子代理的输入草稿：按 seq（surface 顺序）拼接 user/assistant 文本。
 * @param events - readSurface 返回的 events。
 * @param maxBytes - 保留尾部字节上限。
 * @returns 供复核的草稿文本。
 */
export function extractDraft(events, maxBytes = MAX_DRAFT_BYTES) {
  const chunks = []
  for (const event of events ?? []) {
    const text = textOfEvent(event)
    if (typeof text !== 'string' || text.trim() === '') continue
    chunks.push(`## ${event.type === 'user/message' ? 'user' : 'assistant'}\n${text.trim()}`)
  }
  return keepTailBytes(chunks.join('\n\n'), maxBytes)
}

/** 计划首行标题（`# 标题` → `标题`）。 */
export function pickArchiveTitle(planText) {
  const firstLine = String(planText ?? '').split('\n').find(line => line.trim() !== '') ?? ''
  return firstLine.replace(/^#+\s*/, '').trim()
}

/**
 * 用计划标题生成文件名 slug：去掉路径不安全字符（含全角 `：`，中文标题里最常见），
 * 压掉连续分隔符，限长 24 字。
 * @param planText - 修订后的计划 markdown。
 * @returns 文件名 slug（绝不为空）。
 */
export function pickArchiveSlug(planText) {
  const cleaned = pickArchiveTitle(planText)
    .replace(/[\\/:*?"<>|#\uFF1A\uFF0F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const limited = [...cleaned].slice(0, 24).join('')
  return limited === '' ? 'plan' : limited
}

/** 标题归一化比较：忽略 `#` 前缀与首尾空白。 */
function normalizeTitle(value) {
  return String(value ?? '').replace(/^#+\s*/, '').trim()
}

/**
 * 两份计划是否同一份（用于判断「同类重跑 → 原地更新」还是「同名不同计划 → 不覆盖」）。
 * @param existingTitle - 已存在文件首行标题。
 * @param planTitle - 本次计划标题。
 * @returns 是否视为同一份计划。
 */
export function samePlanTitle(existingTitle, planTitle) {
  const left = normalizeTitle(existingTitle)
  const right = normalizeTitle(planTitle)
  return left !== '' && left === right
}

/**
 * 生成候选文件名序列：`YYYY-MM-DD-slug.md`、`YYYY-MM-DD-slug-2.md`、…
 * @param dateStr - 本地日期 `YYYY-MM-DD`。
 * @param slug - 标题 slug。
 * @param count - 候选数量上限。
 * @returns 候选文件名数组。
 */
export function archiveCandidateNames(dateStr, slug, count = MAX_ARCHIVE_ATTEMPTS) {
  const names = []
  for (let index = 0; index < count; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    names.push(`${dateStr}-${slug}${suffix}.md`)
  }
  return names
}

/**
 * 在候选列表上做归档决策（纯函数，IO 由 lib/archive.js 负责）。
 * 规则：不存在的候选 → 新建；已存在且标题相同 → 原地更新；
 * 已存在但标题不同（同名不同计划）→ 跳过，绝不覆盖。
 * @param input - 候选状态与本次计划标题。
 * @returns 选中的候选与模式，或 undefined 表示候选耗尽。
 */
export function chooseArchiveName({ candidates, planTitle }) {
  for (const candidate of candidates) {
    if (candidate.exists !== true) return { name: candidate.name, mode: 'create' }
    if (samePlanTitle(candidate.firstTitle, planTitle)) return { name: candidate.name, mode: 'update' }
  }
  return undefined
}

/** 注入给复核子代理的指令（复核者看不到原会话，因此必须自带草稿与规则）。 */
export function buildReviewerPrompt({ draft, cwd }) {
  return [
    '你是独立的「计划复核员」。你没有原会话上下文，下面给出的草稿就是你唯一的输入。',
    `工作目录：${cwd}`,
    '',
    '待复核的计划草稿：',
    '',
    draft,
    '',
    '任务：',
    `1. 读仓库里的代码、文档与配置（AGENTS.md / package.json 等），逐条验证草稿中的路径、命令、文件引用与假设是否真实可行。`,
    `2. 只查三类问题：错误（路径写错、命令过期、前后矛盾、未证实的假设）、遗漏（原始需求或边界情况没覆盖）、歧义（未来执行者必须靠猜的步骤）。`,
    `3. 对每条发现给出处理：${REVIEW_RESOLUTIONS.join(' / ')}；选择 dismissed 必须在 reason 里写明理由。`,
    `4. 直接产出修订后的最终计划（Markdown，以 \`# 标题\` 开头，可被另一位工程师直接执行），放进 revisedPlan 字段。`,
    `5. 你只有只读工具：不要修改任何文件，不要执行计划（不要 build / test / install / git 变更）。`,
    `6. 严格按调用方给出的 JSON schema 返回：findings（severity ${REVIEW_SEVERITIES.join('/')}、location、evidence、resolution、reason）与 revisedPlan。`,
  ].join('\n')
}

/** 复核子代理的结构化输出 schema（对象根，只用于 assertObjectJsonSchema 支持的子集）。 */
export function reviewerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'revisedPlan'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'location', 'evidence', 'resolution', 'reason'],
          properties: {
            severity: { type: 'string', enum: REVIEW_SEVERITIES },
            location: { type: 'string' },
            evidence: { type: 'string' },
            resolution: { type: 'string', enum: REVIEW_RESOLUTIONS },
            reason: { type: 'string' },
          },
        },
      },
      revisedPlan: { type: 'string' },
    },
  }
}

/**
 * 校验复核结果。跨 provider 边界的返回值一律当不可信数据处理：
 * 形状不对就当失败，绝不让半成品进入归档与执行。
 * @param value - result.structured。
 * @returns 规整后的 `{findings, revisedPlan}`。
 * @throws 当形状不符合 schema 约定时。
 */
export function validateReview(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('复核结果不是对象')
  }
  if (!Array.isArray(value.findings)) throw new Error('复核结果缺少 findings 数组')
  if (typeof value.revisedPlan !== 'string' || value.revisedPlan.trim() === '') {
    throw new Error('复核结果缺少非空 revisedPlan')
  }
  const findings = value.findings.map((finding, index) => {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`findings[${index}] 不是对象`)
    }
    if (!REVIEW_SEVERITIES.includes(finding.severity)) throw new Error(`findings[${index}].severity 非法`)
    if (!REVIEW_RESOLUTIONS.includes(finding.resolution)) throw new Error(`findings[${index}].resolution 非法`)
    for (const field of ['location', 'evidence', 'reason']) {
      if (typeof finding[field] !== 'string') throw new Error(`findings[${index}].${field} 必须是字符串`)
    }
    return {
      severity: finding.severity,
      location: finding.location,
      evidence: finding.evidence,
      resolution: finding.resolution,
      reason: finding.reason,
    }
  })
  return { findings, revisedPlan: value.revisedPlan }
}

/** 执行轮指令（零确认：复核与归档完成后自动注入）。 */
export function executionInstruction({ archivePath, findings }) {
  const blocking = (findings ?? []).filter(finding => finding.severity === 'P0' && finding.resolution === 'dismissed')
  return [
    '计划已复核并归档，现在自动开始执行（没有二次确认键）。',
    '',
    `- 先读归档文件：${archivePath}`,
    '- 按其中步骤顺序执行；你现在拥有完整写权限。',
    blocking.length > 0
      ? `- 复核报告里有 ${blocking.length} 条未解决的 P0 发现，先停下来问用户再继续。`
      : '- 若某一步歧义或计划有缺口，先停下来问用户，不要猜。',
    '- 遵守仓库 AGENTS.md 里的规则（typecheck / 部署等要求）。',
    '- 完成后做一次执行自查：跑计划要求的构建/测试/类型检查并修复；检查遗漏步骤与遗留 TODO；总结改动。',
  ].join('\n')
}

/** 执行后自查指令（turn-stopping 时注入一次）。 */
export function selfReviewInstruction() {
  return [
    '执行轮已结束，现在做执行后自查（不要修改计划文件本身）：',
    '',
    '1. 验证：跑计划要求的构建 / 测试 / 类型检查与关键验证，修掉坏掉的部分。',
    '2. 查遗漏：计划里没做的步骤、被跳过的边界情况、遗留的 TODO。',
    '3. 输出 `Execution Review:` 段落：验证结果、发现、改动摘要与后续待办。',
  ].join('\n')
}

/** 本地日期 `YYYY-MM-DD`（归档文件名用本地日期，不引用 UTC）。 */
export function localDate(now = new Date()) {
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
