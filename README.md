# dsh-plan-toggle

DSH（DeepSeek Harness）**Web UI** 插件：用两个快捷键复刻 pi 的 `F8` / `F9` 计划闭环。

| 键位 | 行为 |
|---|---|
| **`Alt+1`** | 进 / 出 **plan 模式**（复用官方 plan mode，软拦截：只切 plan 状态，不切 sandbox）。在这一阶段跟模型把需求聊清楚，它不会去改代码。 |
| **`Alt+2`** | 在 plan 模式下按：**零人工确认**的一条流水线 —— 拉起一个 fresh-context **只读复核子代理**（查错误 / 遗漏 / 歧义）→ 修订计划 → 归档到 `docs/plans/YYYY-MM-DD-功能名.md` → 退出 plan 模式 → 自动开始执行 → 执行轮结束后自动做一次 **执行后自查**。 |

任意时刻按 `Alt+1` 都会中止流水线并回到 normal（不会打断正在跑的那一轮）。

## 安装

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-plan-toggle

# 或本地 checkout（开发期，改源码即时生效）
dsh plugin --profile web add /path/to/dsh-plan-toggle

# 或从 git 安装
dsh plugin --profile web add github:xsstomy/dsh-plan-toggle
```

> ⚠️ 本插件 host 半 import 了官方包 `@deepseek-ai/dsh-llm`（只为一个 `createUserMessage`）。
> 用**本地路径**（`link:`）安装时，Node 会按真实路径解析依赖，必须先在插件仓库里装依赖：
>
> ```bash
> cd /path/to/dsh-plan-toggle && npm install   # 生成仓库内 node_modules
> ```
>
> 安装/更新插件行后需**重启一次 `dsh web`**（插件行在启动时缓存）；新增行之后 `--dump-config` 应能看到 `id: plan-toggle`。

验证安装：

```bash
dsh --profile web --dump-config | grep -A3 "id: plan-toggle"
```

## 使用

1. 打开 DSH Web，按 **`Alt+1`** —— 输入框出现官方「Plan ×」徽章，模型进入只读计划模式。
2. 正常聊天，把需求讨论清楚（模型不会改代码）。
3. 需求清楚了，按 **`Alt+2`** —— 复核子代理开始读代码复核；随后自动归档、自动执行、自动自查。
4. 想中止：随时按 **`Alt+1`**（在复核等待期间按也能中止，不会执行）。

产物：`<会话工作目录>/docs/plans/YYYY-MM-DD-功能名.md`。同名规则：同一份计划重跑 → 原地更新；同名不同计划 → 追加 `-2`、`-3`，**不覆盖**。

## 工作原理

- **host 半**（`lib/index.js`）：注册 `/plan-toggle` 与 `/plan-review` 两条命令；`/plan-review` 依次做
  `sessionQuery.readSurface` 取草稿 → `subagents.start('spawn', …)`（`toolFilter` 只给 `read`/`grep`/`glob`）
  → 插件用 `node:fs` 写归档 → `planMode.set(agent, false)` 退出 plan 模式 → `agent.steer()` 起执行轮；
  另在 `agent/turn-stopping` 上做一次性执行后自查。
- **browser 半**（`lib/client.js`）：官方 Web 没有快捷键注册机制，因此这一半在 `window` 捕获阶段挂
  `keydown`，用 `event.code`（`Digit1`/`Digit2`）判定，把按键转发成 `/plan-toggle`、`/plan-review` 命令
  （`ctx.remote.commands.execute`）。流程状态只存在于 host 半，浏览器不记状态。
- 官方源码**零改动**：插件只是一层 bundle patch + 一行 Loader 行，用的全是官方服务
  （`agentPresets` / `subagents` / `commands` / `sessionQuery`）。

## 已知限制

- **零人工确认**是你的选择：`Alt+2` 之后没有"批准"步骤，只有 `Alt+1` 中止。若模型在规划阶段自行调用官方的
  `exit_plan_mode`，官方「Approve / Keep planning」对话框仍会照常出现（官方行为未改）。
- **软拦截**：plan 模式只注入官方提示词，不切只读沙箱；真正拦住写入要靠模型自觉。
- `Alt+2` 需要 agent 空闲（正忙时会被拒绝，等这一轮跑完再按）。
- 模型"执行中提问后结束轮"也会触发一次执行后自查（用状态门控只注入一次）。
- 插件重载 / 会话恢复后状态一律回 `normal`。
- 复核超时 10 分钟；超时或结构化结果不符 → 停在 plan 模式并报错，**不执行**。
- 键位 v1 硬编码；改键（设置页录制）是后续项。

## 开发

```bash
npm test                 # 纯逻辑单测（状态机 / 草稿抽取 / 归档命名 / schema 校验），无需 npm install
npm install              # host 半的运行时依赖（@deepseek-ai/dsh-llm）
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config | grep -A3 "id: plan-toggle"
```

目录：

```
lib/index.js    host 半：命令注册 + 流水线编排
lib/state.js    纯逻辑：状态机 / 草稿抽取 / 归档命名 / 复核规格
lib/archive.js  归档 IO（node:fs）
lib/client.js   browser 半：Alt+1 / Alt+2 键位
test/           node --test 单测
prd.md          需求文档（含复用映射与取舍）
```

## 卸载 / 回滚

```bash
dsh plugin --profile web remove dsh-plan-toggle
```

删插件即完全还原（官方源码零改动，插件只贡献自己的 bundle 层）。

## License

MIT
