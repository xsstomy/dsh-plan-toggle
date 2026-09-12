# dsh-plan-toggle 需求文档（PRD）

> 目标：在 **DeepSeek Harness Web UI** 里用两个快捷键复刻 pi 的 `F8`/`F9` 闭环。
> 硬约束：**不改动 deepseek-harness 官方源码**，机制全部复用官方现成能力。

## 0. 需求（已确认）

| 项 | 决定 |
|---|---|
| 形态 | 独立仓库 `xsstomy/dsh-plan-toggle`，第三方 **bundle 插件**（host 半 + browser 半），官方源码零改动 |
| 平台 | **仅 Web profile**（Desktop 暂不做） |
| 键 1 `Alt+1` | 进/出「plan 模式」（复用官方 plan mode；**硬拦截**：进入时把沙箱切到 `read-only`，退出/执行前自动还原）。**仅 standard（原生工具）会话可用；PTC 会话按键会被拒并提示新建 standard 会话** |
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
| plan 模式下的**硬拦截**（写入真被拒） | ✅ | 沙箱策略官方入口：C=`ctx.permissionPresets.set(session, <只读预设>)`（优先 `plan` 预设，否则官方自带 `read-only`）；B=`setSandboxMode(session, 'read-only')`（`@deepseek-ai/dsh-sandbox-policy` 导出，permission-presets 内部同款）；还原用 `setSandboxMode` / `approval.setPolicy` |
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
2. **硬拦截用官方沙箱策略**（B + C 两条入口，插件自动择优）：
   - C（首选）：官方 permission preset。插件在部署预设表里挑一个 `sandbox: read-only` 的项（优先名为 `plan`），
     `ctx.permissionPresets.set(session, name)` —— UI 选择器会显示该预设，审批策略一并设定；**不覆盖**部署的预设表。
   - B（兜底）：`setSandboxMode(session, 'read-only')`（官方导出 setter）。
   - 两者都缺失时自动降级为官方软提示词。
   - 官方为请求缓存稳定**刻意保持工具表跨模式不变**，所以硬拦截是"写操作被拒（EACCES/EPERM）"，
     而不是把 write/edit 从工具表摘掉；`SandboxMode` 只管控文件系统效果（网络/进程可见性不在范围）。
   - **还原是硬要求**：`Alt+1` 退出与 `Alt+2` 执行前都要还原，否则执行轮在只读沙箱下全部失败。
     插件自己的归档走 `node:fs`（host 进程写），不经沙箱，因此不会自锁。
3. 执行后**自查一轮**，不循环。
4. 暂不发 npm，先用 git / 本地路径安装；复核者模型继承父会话路由。
5. 键位 v1 硬编码 `Alt+1` / `Alt+2`（用 `event.code` 判定，规避 macOS Option 改字符）；改键列为后续项。
6. **硬拦截限定 standard 会话**（用户选定）：PTC 把工具塌缩成 `run_code`，其程序权限等同 bash（可 `import('node:fs')`
   绕过两层沙箱），官方 `toolFilter` 明确不能限制它 → PTC 下"写不进文件"做不到，故改走"拒绝 + 提示切 standard"，
   不伪造假保证。判定用官方公开读 `ctx.tools.get('run_code', agent)`（权威），预设 id 兜底。
7. **镜像**：用官方 `/plan`、UI 徽章等入口进入 plan 模式时，下一次工具调用前自动切只读沙箱，官方退出后自动还原。
8. 可选 `blockBash`（默认 `false`）：standard 会话的 plan 模式下是否连 `bash`/`pwsh` 一起拒（含只读命令）。
9. 替代方案（未采纳）：工具级 deny 名单（沙箱已覆盖文件/进程两条写入路径，属重复实现且会误伤只读探索）、
   PTC 下也镜像只读沙箱（同样可被 node:fs 绕过，只会造成"看起来拦住了"的假象）。

## 3. 已知限制

- **PTC 会话无硬拦**（按键被拒并提示切 standard）：官方信任姿态决定，非本插件能修。
- **镜像触发时机是"下一次工具调用"**：官方 `/plan` 后、下一次工具调用前沙箱尚未切；但该次调用本身会在工具体内被新策略拦下，不存在"漏一次写"。
- `blockBash: true` 会误伤只读命令（`git status`/`rg`），默认 `false`。
- **插件重载 / `dsh web` 重启丢失内存状态**，而沙箱覆盖写在会话日志里、跨重启保留。进入前的状态不可知时，
  退出按「上次见到的正常预设 → 部署默认预设 → 部署默认旋钮」还原，**不会卡在只读**（曾有把只读快照
  当还原目标导致永久只读的 bug，已修 + 有回归用例）；残留局限是可能回到部署默认预设而非你手选过的那个。
- 模型在"执行中提问并结束轮"时也会触发一次执行后自查（把提问当成执行结束）；用状态门控只注入一次。
- `Alt+2` 要求 agent 空闲：正忙时按会被拒绝，需等当前轮跑完。
- 插件重载 / 会话恢复后状态一律回 `normal`（不保留半途的 executing 状态）。
- 复核超时 10 分钟；超时/结构不符 → 停在 plan 模式并报错，不执行。
