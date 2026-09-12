# dsh-plan-toggle 需求文档（PRD）

> 目标：在 **DeepSeek Harness Web UI** 里用两个快捷键复刻 pi 的 `F8`/`F9` 闭环。
> 硬约束：**不改动 deepseek-harness 官方源码**，机制全部复用官方现成能力。

## 0. 需求（已确认）

| 项 | 决定 |
|---|---|
| 形态 | 独立仓库 `xsstomy/dsh-plan-toggle`，第三方 **bundle 插件**（host 半 + browser 半），官方源码零改动 |
| 平台 | **仅 Web profile**（Desktop 暂不做） |
| 键 1 `Alt+1` | 进/出「plan 模式」（复用官方 plan mode；**软拦截**：只切 plan 状态，不切 sandbox） |
| 键 2 `Alt+2` | 零人工确认流水线：子代理独立复核 → 修订并归档 → 自动执行 → 执行后自动自查 → 回 normal |
| 归档 | 插件写 `<会话 cwd>/docs/plans/YYYY-MM-DD-功能名.md`；同名规则见下 |
| 命名 | 复用官方 plan mode 语义，不另造同名概念 |

目标状态机：

```
normal ──Alt+1──▶ planning ──Alt+2──▶ reviewing ──(复核+归档完成，插件内自动)──▶ executing ──(turn-stopping)──▶ 自审一轮 ──▶ normal
  ▲                  │
  └────Alt+1─────────┘       任意状态 Alt+1 → normal（清状态；不打断正在跑的 turn）
```

### 归档同名规则

1. 目标文件不存在 → 直接写；
2. 已存在且首行标题与本次计划相同（同一次计划的重跑）→ 先读全文，**原地更新**；
3. 已存在但标题不同（同名不同计划）→ **不覆盖**，依次试 `-2`、`-3`…（上限 50）。

## 1. 复用映射（哪些是官方能力，哪些必须自己写）

| 需要 | 复用官方 | 关键 API / 入口 |
|---|---|---|
| 取 agent 的 plan 模式服务 | ✅ | `ctx.agentPresets.serviceFor(agent, 'planMode')`（plan-mode 在 preset 的 isolate realm，`agent.ctx` 取不到） |
| 进/出 plan 模式 | ✅ | `planMode.get(agent)` / `planMode.set(agent, active)`（后者即 `/plan off` 按钮同一条 API，返回 `committed/queued/cancelled/noop`） |
| plan 模式提示词 | ✅ | 官方 `plan:policy` 段（ptc/standard preset 已挂），插件不改 |
| 独立复核子代理 | ✅ | `ctx.subagents.start('spawn', { parent, prompt, signal, outputSchema, toolFilter, maxDepth })` → `run.result` / `run.dispose()` |
| 复核者只读 | ✅ | `toolFilter: { allow: ['read','grep','glob'] }`（工具级消失且拒绝执行；注意：管不到路径，所以归档不交给子代理写） |
| 读计划草稿 | ✅ | `ctx.sessionQuery.readSurface(sessionId).events`（`user/message` / `assistant/message` 的文本） |
| 注入指令 / 起执行轮 | ✅ | `createUserMessage()`（`@deepseek-ai/dsh-llm`）+ `agent.steer(msg)` |
| 执行后自动自查 | ✅ | `ctx.on('agent/turn-stopping', …)` + steer（官方 hooks 的 Stop 用的同一 seam） |
| 注册命令 | ✅ | `ctx.commands.register({ name, description, handler })` |
| 写归档文件 | 自研 | `node:fs/promises`（不耦合 fs-sandbox 策略） |
| 浏览器快捷键 | **自研** | 官方 Web 无任何快捷键注册机制：client 半在 `window` 捕获阶段挂 keydown → `ctx.remote.commands.execute(sessionId, '/plan-review', [])` |
| 取当前会话 | ✅ | `ctx.sessions.list.getSnapshot().current`（client 服务） |

## 2. 明确的取舍

1. **零人工确认**（用户选定）：不依赖 `exit_plan_mode` 审批通道自动批答（waterfall 监听顺序不保证），改用确定性的 `planMode.set(agent, false)`。
   - 副作用：规划阶段模型若自行调用 `exit_plan_mode`，仍会弹出官方「Approve / Keep planning」人工对话框（官方行为原样保留）。
2. 只读为**软拦截**：只切官方 plan mode，不切 sandbox（`setSandboxMode` 不用）。
3. 执行后**自查一轮**，不循环。
4. 暂不发 npm，先用 git / 本地路径安装；复核者模型继承父会话路由。
5. 键位 v1 硬编码 `Alt+1` / `Alt+2`（用 `event.code` 判定，规避 macOS Option 改字符）；改键列为后续项。

## 3. 已知限制

- 模型在"执行中提问并结束轮"时也会触发一次执行后自查（把提问当成执行结束）；用状态门控只注入一次。
- `Alt+2` 要求 agent 空闲：正忙时按会被拒绝，需等当前轮跑完。
- 插件重载 / 会话恢复后状态一律回 `normal`（不保留半途的 executing 状态）。
- 复核超时 10 分钟；超时/结构不符 → 停在 plan 模式并报错，不执行。
