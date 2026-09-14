# 知识库批量导入：进度与上限（实现契约 · 冻结）

日期：2026-09-14 ｜ 状态：内核已完成并提交（`f26b7f1`），本契约冻结服务端与 GUI 两端的接口。

## 0. 背景与已完成的底座

需求三条：
1. 知识库要能扛**批量大量文件**（原上限 500 文件/300MB 是**整批拒绝**式护栏）。
2. 文件夹选择要能取**子目录及以下**内容。
3. 上传处理时要显示**进度条**（先查文件数，再按实时已处理数算进度）。

**已完成（勿重复实现）**：
- 内核 `kernel/knowledge-import.mjs`：`importDocuments`/`importFiles` 新增 `onProgress` 旁路，发出
  - `{type:'progress', phase:'plan', done:0, total:N, totalBytes, rejected}` —— 枚举完文件立即发（"先查文件数"）
  - `{type:'progress', phase:'process', done:i, total:N, current:'相对路径'}` —— 每个文件**开始处理时**
  - `{type:'progress', phase:'done', done:N, total:N}`
  - 进度按**循环下标**推进（非成功数），保证恒定收敛到 total。
- 内核 CLI（`kernel/cli.mjs`）新增 flag：
  - `--progress`（布尔，**opt-in**）：stdout 改为「若干 NDJSON 进度行 + 末行结果」。不加此 flag 时 stdout **仍是恰好一行 JSON**（既有契约，不可破坏）。
  - `--max-files <int≥1>`、`--max-total-mb <num≥1>`：覆盖内核默认 500 文件 / 300MB。非法值报错（`bad-max-files` / `bad-max-total-mb`）。
  - ⚠️ 内核 limits 键名是 `maxBatchFiles` / `maxBatchBytes`（不是 `maxFiles`/`maxTotalBytes`）。
- 服务端 `server/knowledge-import-policy.cjs`：`DEFAULT_IMPORT_POLICY`（500 / 300MB）、`IMPORT_POLICY_LIMITS`（1–20000 文件；1MB–20GB）、`normalizeImportPolicy`、`readImportPolicy({home})`、`readImportPolicyCached({home,ttlMs=5000})`、`_resetImportPolicyCache()`。
- `server/bridge.mjs`：config.json 默认档 `knowledgeImport` + 保存时钳制（局部补丁语义）。
- GUI 纯函数 `src/lib/knowledgeImportUi.ts`：`DEFAULT_KNOWLEDGE_IMPORT_POLICY`、`KNOWLEDGE_IMPORT_LIMITS`、`normalizeKnowledgeImportPolicyUi`、`importPercent`、`importProgressText`、`reduceProgressEvent`、`IDLE_IMPORT_PROGRESS`、类型 `ImportProgress`/`KnowledgeImportPolicy`。

## 1. HTTP 契约（冻结）

### POST /knowledge/import（既有端点，扩展）
保留现有同步行为**逐字节不变**（不传 `async` 或 `async !== true` 时）。

新增可选字段：
- `async: true` → 立即返回 `202 { jobId }`，导入在后台进行。
- 可选覆盖上限：`maxFiles`（int）、`maxTotalMb`（number，MB）。缺省用 `readImportPolicyCached()` 的值。
  - 非法值 → 400（不静默回落）。
- 其它字段语义不变（`from`/`space`/`spaceId`/`name`/`dryRun`/`maxOcrPages`/`visionTables`/`maxVisionPages`）。

### GET /knowledge/import/jobs/:id（新增）
- 运行中 → `200 { status:'running', done, total, current, percent, startedAt }`
- 完成 → `200 { status:'done', done, total, percent, report, startedAt, endedAt }`
- 失败 → `200 { status:'error', error, code?, startedAt, endedAt }`
- 未知 id → `404 { error }`
- `percent` 用与 GUI 同一口径（`done/total*100`，`total=0` 时 0，上限 100）。

任务保留：完成后保留 10 分钟再回收（TTL 定时清理，`unref()` 防挂住进程）。注册表需有**硬上限**（如最多 50 个并发/历史任务），超出时丢弃最旧的**已结束**任务，绝不淘汰运行中的。

### 错误映射
沿用 `server/knowledge-routes.mjs` 既有纪律：
- 内核非零退出 + stderr `[knowledge] <code>: <msg>` → 按 `statusOfKnowledgeError` 映射（400/403/404/413）。
- 非闸门类失败（崩溃/超时/stdout 超限）→ **不透 stderr 原文**，回固定 harness 消息（现状即如此）。
- 进度行解析失败不得影响最终结果判定（忽略无法解析的行）。

## 2. 服务端实现要求

新增 `server/kernel-stream.mjs`：`spawnKernelStreaming(argsList, { env, cwd, timeoutMs, maxBuffer, onLine })`。
- 复用 `server/kernel-readonly.mjs:resolveKernelCli()` 解析内核路径（**唯一事实来源，勿另开解析**）；
  调用形如 `spawn(process.execPath, [cli, '--output-format','stream-json','--input-format','stream-json', ...argsList], { stdio:['ignore','pipe','pipe'] })`。
- **保持 kernel-readonly 的三道保险**（详见其头注）：超时 kill、stdout 缓冲上限、非零退出报错。
- 逐行回调（按 `\n` 切分，处理跨 chunk 的半行）。
- stdout 累积需有界：只保留**近期若干行**用于取结果（末行），不要无限累积（大批量导入输出可达数十 MB）。

新增 `server/import-jobs.mjs`：任务注册表（`startImportJob` / `getImportJob` / `_resetImportJobs` 供测试）。
- 进度状态由 NDJSON 行归约；`plan` 定 total、`process` 递进、`done` 收尾。
- 进程退出后解析**末行** JSON 作为 `report`；非零退出按 §1 错误映射给 `error`/`code`。

`server/knowledge-routes.mjs`：接线两个端点。`handleKnowledgeRoute` 已注入 `callKernel`；流式版需新增注入参数（如 `spawnStream = spawnKernelStreaming`）以便测试注入假实现，**不得**在路由里直接 `spawn`。

## 3. GUI 实现要求

1. **进度条**（`src/components/knowledge/KnowledgeImportDialog.tsx`）：
   - 导入改为 `async: true` 提交 → 拿 `jobId` → 轮询 `GET /knowledge/import/jobs/:id`（间隔 ~500ms；完成后停止；组件卸载/取消时清定时器）。
   - 进度条按 `percent`（复用 `importPercent`）；文案复用 `importProgressText`。
   - **先查文件数**：`plan` 事件到达前 total 未知 —— 此时显示"正在统计文件数…"且进度条为不确定态（不要显示 0% 假进度，也不要瞬间满格）。
   - 完成后展示结果摘要（沿用现有 report 渲染）；失败展示错误。
   - 轮询失败（网络/500）需可恢复：不要静默把进度条卡在 100%。
2. **上限可配置入口**：照 `logPolicy` 范式（`src/stores/settingsStore.ts` 默认值 + 归一化、`src/components/settings/SettingsView.tsx` 读/存、`src/types/index.ts` 类型、`src/components/settings/LogsPanel.tsx` 的 patch 写法），新增 `knowledgeImport` 设置项与设置面板控件（文件数、总 MB）；用 `normalizeKnowledgeImportPolicyUi` 钳制。文案需说明"上限是整批拒绝：超出会一个都不导"。
3. 纯函数一律放 `src/lib/`，组件保持薄。

## 4. 测试要求

- 服务端：`server/knowledge-import-jobs.test.mjs` —— 注入假 spawn，覆盖：plan→process→done 归约、末行取 report、非零退出→error+码映射、未知 id→404、任务 TTL/上限淘汰（不淘汰运行中）、进度行损坏不影响结果。
- 服务端（若改既有 import 路由）：既有 `server/knowledge-import-routes.test.mjs` **必须全绿**（同步路径行为不变）。
- GUI：`src/lib/knowledgeImportUi.test.ts` 覆盖 `importPercent`/`reduceProgressEvent`/`importProgressText` 边界。
- 内核：`kernel-tests/knowledge-import-progress.test.mjs` —— onProgress 事件序列（plan 的 total == 文件数、process 的 done 单调递增到 total-1、done 收尾）、跳过/失败文件也计入 done（分母一致性）、`onProgress` 抛错不影响导入成功、`--max-files` 覆盖生效与被拒。

## 5. 纪律

- 只改与本事相关的文件；不顺手重构。
- 中文注释解释**为什么**（尤其护栏/边界），不要复述代码在做什么。
- 不新增依赖。跑测试：`node --test <file>`（Node 内置 test runner，可直接跑 `.ts`）。
