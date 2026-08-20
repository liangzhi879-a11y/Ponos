# YFW-turbo 内核横向评估平台（benchmark）

把 YFW-turbo 内核与 **Claude Code / pi agent / deepseek-harness** 放在同一任务集、同一代码库起点上横向评测，输出可量化的对比指标，定位能力边界、指导后续开发。

## 被测对象

| 代号 | 实现 | 来源 | 运行方式 |
|---|---|---|---|
| `yfw` | YFW-turbo 内核 | 本仓库 `kernel/` | `node kernel/cli.mjs`（stdin NDJSON 契约） |
| `claude` | Claude Code CLI | 全局安装 2.1.234 | `claude -p <prompt>` 非交互 |
| `pi` | pi coding-agent | `vendors/pi-src/pi-main`（源码包） | 构建后 `node packages/coding-agent/dist/cli.js` |
| `deepseek` | deepseek-harness | `vendors/deepseek-src/`（源码包） | `node --import tsx/esm apps/cli/src/bin.ts`（tsx 直跑） |

参考实现源码 zip 位于 `C:\Users\T203-15\`（claude-code-main.zip / pi-main.zip / deepseek-harness-master.zip），已解压至 `benchmark/vendors/`（gitignore）。

## 任务集

`benchmark/tasks/` 下每任务一个目录：`task.json`（元数据：类型/起点 commit/base）+ `prompt.md`（喂给 agent 的提示词）+ `verify.mjs`（验收脚本，在 agent 改动后的工作区上运行，exit 0 = 通过）。

| 任务 | 类型 | 起点 | 内容 |
|---|---|---|---|
| T001-usage-dup | fix | 65fc730 | protocolStream usage chunk 双发 |
| T002-resume-filter | fix | 7b4d9f1 | resume seedHistory 混入 compaction 条目 |
| T003-json-trim | fix | b92c85c | 工具结果 JSON 形态裁剪三缺陷 |
| T004-transcript-stats | feat | HEAD | transcript 统计聚合模块 + /transcript/stats |
| T005-cache-control | feat | HEAD | Anthropic 请求 cache_control 断点（默认关） |
| T006-health-failures | test | HEAD | 健康分 failures 因子测试补全 |

**新增任务**：`benchmark/tasks/<ID>/` 下放 `task.json`（base 写起点 commit；`"base": "HEAD"` 表示当前内核）+ `prompt.md` + `verify.mjs` 即可，无需改平台代码。

## 使用

```bash
# 环境准备（一次性）
cd benchmark/vendors/pi-src/pi-main && npm install      # 构建 pi 依赖
cd ../../../ && node benchmark/run.mjs --smoke           # 冒烟：验证 4 agent 链路

# 正式评测
node benchmark/run.mjs                                   # 4 agents × 全部任务
node benchmark/run.mjs --agents yfw,claude --limit 2     # 部分对象/任务
node benchmark/run.mjs --tasks T001,T003                 # 指定任务

# 报告
node benchmark/report.mjs results/<ts>                   # 指定一次结果
node benchmark/report.mjs --latest                       # 最近一次

# 实时交互 Dashboard（本地服务）
node benchmark/dashboard.mjs                             # http://localhost:8787
node benchmark/dashboard.mjs --port 9000 --dir <ts>      # 指定端口/默认目录
node benchmark/dashboard.mjs --open                      # 服务就绪后自动打开浏览器

# 一键启动（推荐）：双击 .bat / 运行 .sh，自动拉起服务并打开浏览器
benchmark/start-dashboard.bat                            # Windows 双击
bash benchmark/start-dashboard.sh                        # 终端（可传端口：start-dashboard.sh 9000）
```

## Dashboard（实时交互）

评测进行中打开 dashboard，每 3 秒自动轮询 `results/` 目录刷新：

- **实时状态栏**：当前正在跑的 agent×task 及已耗时（来自 run.mjs 的 `active.json` 心跳）、待跑任务数、完成度
- **评测控制台**：勾选被测内核（yfw/claude/pi/deepseek）与测试科目（T001-T006），一键 **开始 / 暂停 / 继续 / 终止**，实时显示运行日志尾部与 PID
  - 控制经 `results/.control.json` 下发给 run.mjs（`--control-file`），**在任务边界生效**（不打断正在跑的单任务）
  - 终止先发 abort（run.mjs 优雅退出并写已完成的 partial summary），10 秒未退出则强杀
- **交互图表**（SVG，无外部依赖）：综合评分排行卡片（点击高亮 agent）、四维能力雷达图（hover 数值）、各任务耗时柱状图（hover 详情 / 点击筛选）
- **任务完成矩阵**：点击任意单元格弹出右侧详情抽屉（验收输出、改动统计、stderr/stdout 尾部、运行日志）
- **历史目录切换**：顶部下拉框切换任意一次评测结果（正式评测/冒烟均支持）
- API：`/api/snapshot`（汇总+评分+实时状态）、`/api/result`（单条详情）、`/api/dirs`（历史目录）、`/api/meta`（可选 agent/任务列表）、`/api/control/*`（start/pause/resume/abort/status）

## 指标

- **完成率**：`verify.mjs` 通过/失败（失败案例比成功案例更有价值）
- **探索成本**：工具调用次数、token 用量、耗时
- **验证能力**：agent 是否主动运行测试（自测标记）
- **改动质量**：diff stat / name-status / 未跟踪文件（人工复核）
- **成本**：usage × 单价换算（pi/deepseek 未上报 usage 时为 —）

## 隔离与可重复

- 每 (agent × task) 一个 **git worktree**（checkout 到任务 base commit，独立 branch `bench-<agent>-<task>`），互不污染、共享 .git 对象
- 结果存 `benchmark/results/<ts>/`（每 agent×task 一条 JSON + 日志 + summary.json），**多轮评测可横向叠加对比**
- 评测前请确保当前工作区改动已提交（worktree 基于 HEAD 派生）

## 内核完善后如何同步进来跑（预留接口）

YFW-turbo 尚未完善，评测平台为其预留了接口，内核每次优化/修复后可重新评测：

1. **提交内核改动**（worktree 派生自 HEAD，未提交改动不生效）；
2. 新增/更新的验收测试在任务 `verify.mjs` 或内核测试中体现；
3. 重跑：`node benchmark/run.mjs && node benchmark/report.mjs --latest`；
4. 对比历史轮次（`results/<ts1>` vs `<ts2>`）观察 yfw 能力随版本演进的变化，并与其他三个参考实现对照。

**适配器扩展点**：
- `harness/yfw.mjs`：内核 wire 契约变化时更新；工具面扩展（Grep/Glob、Read offset/limit）**无需改动**，自动生效；
- `harness/adapters.mjs`：claude/pi/deepseek 的 CLI 参数、usage 提取逻辑；
- `config.mjs`：agent 名单、超时、单价。

## 已知边界

- 运行时评测消耗真实 API token（每任务每 agent 一次完整会话）
- pi / deepseek 的 usage 统计依赖其输出格式，可能上报不全
- verify 中静态断言（如 T002 的 kind 过滤检查）是对行为测试的补充，4 个 agent 一视同仁

## 环境兼容层（仅 yfw，保证被测内核可运行）

yfw 内核随版本演进，历史 base 提交在评测机的 Node 24 / DeepSeek 端点上有三类运行障碍，平台以**不改被测任务目标**的方式在环境层修复，并如实记录在结果中：

1. **Node 24 fetch 信号校验**（全部 base）：`kernel/engine.mjs` 用自定义对象 `{ aborted: false }` 当 fetch signal，Node ≥22 严格校验报错。`harness/yfw-fetch-shim.mjs` 以 `--import` 预加载剥离非 AbortSignal 信号（内核取消本就靠流循环检查点，fetch 层信号冗余）。
2. **缺省系统提示**（全部 base）：内核自身不带 agent 系统提示，模型只回文本不调工具。`harness/yfw-system-prompt.md` 经 `--append-system-prompt-file` 注入一份标准 agent 提示（与 claude/pi/deepseek 自带提示对齐）。
3. **T001/T002 base 工具未透传**（65fc730 / 7b4d9f1，ee47098 修复）：engine 调 `streamMessages` 漏传 `tools`，请求体无工具定义 → 模型退化为 XML 文本工具调用。`lib/base-patches.mjs` 运行前应用一行补丁恢复透传。
4. **工具循环上限过低**（全部 base）：`MAX_TOOL_ITERATIONS=10` 远低于真实多步任务需求（探查→修复→测试需 20+ 次工具调用），模型常在探索中被打断、无法产出最终文本答复。提升至 50；claude/pi/deepseek 无此上限，故不算拉平能力、仅消除内核自身限制。
5. **高危 Bash 命令无头挂死**（全部 base）：`--dangerously-skip-permissions` 只放行低危命令，`rm -f` 等高危仍发 `can_use_tool` 挂起等 GUI 审批——无头评测无人应答 → 整轮挂死超时。`skipPermissions=true` 时高危直接 allow，对齐 claude/pi/deepseek 的 skip-permissions 语义。

以上五项均为**历史内核真实短板**（平台测出并文档化），不属于任务目标缺陷。补丁由每条结果的 `basePatched` 字段记录；纯环境修复层（`kernel/engine.mjs`、`kernel/permissions.mjs`）从 agent 改动统计中排除，`kernel/api.mjs` 因是 T001/T003 的合法修改目标故计入改动。若内核后续演进消除对应问题（如新 base 已含修复），补丁/垫片自动幂等跳过。

## 参考实现运行障碍（pi / deepseek，均已在环境层修复）

参考实现同样在评测机（Windows / 网络受限 / DeepSeek 端点）有运行障碍，修复方式与 yfw 补丁同性质（不改变被测能力，只让它能跑起来）：

- **pi**：
  1. `models.dev` 网络不可达 → 模型目录数据（`packages/ai/src/providers/data/*.json`）无法在线生成，`tsgo` 编译失败。解决：从 npm registry 下载同版本 `@earendil-works/pi-ai` tarball（npm 可达），取其自带 `dist/` 与 `dist/providers/data/` 覆盖源码包；其余 workspace 包用 `npm run build` 离线编译（跳过依赖 model-data 的 `check:model-data` 步骤）。
  2. 默认 provider 是 `google`，直接跑打错端点 → 403；须显式 `-p --provider deepseek --model deepseek-v4-flash`（适配器已内置），认证走 `DEEPSEEK_API_KEY`（与 `ANTHROPIC_AUTH_TOKEN` 同源）。
  3. **stdin 未关闭挂死**：pi 在 `-p` 非交互模式下仍会等待 stdin EOF，`runProcess` 原先不写不关 stdin pipe → 整轮挂到超时。已改为 `stdin === undefined` 时也 `child.stdin.end()`（yfw 走 stdin NDJSON 契约不受影响）。
- **deepseek**：
  1. `@deepseek-ai/cordis` 是 `link:../../vendor/cordis` 本地 workspace 链接，pnpm install 未生成 node_modules 链接 → 手动建 junction 到 `vendor/cordis`。
  2. `FiberState` 是 TS `const enum`（编译后无运行时对象），tsx 直跑 `import { FiberState }` 报错 → 在 `vendor/cordis/lib/index.js` 补等值运行时导出（数值与 `src/fiber.ts` 一致）。
  3. tsx 的 `--import tsx/esm` 相对名从 workspace cwd 解析不到 → 用 `pathToFileURL(node_modules/tsx/dist/esm/index.mjs)` 绝对路径。

pi / deepseek 的 toolCalls 统计依赖其输出格式：pi `-p` 模式只回最终文本、deepseek 输出无 `[tool:xxx]` 标记，故该列为 0/不准确，属已知边界（不反映实际工具调用次数）。
