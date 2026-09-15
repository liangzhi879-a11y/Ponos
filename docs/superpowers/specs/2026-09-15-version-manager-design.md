# 版本管理器（Version Manager）设计方案

日期：2026-09-15 ｜ 状态：设计已获用户批准，待实施

## 0. 背景与问题

YFWorking 项目当前的版本相关现状：

| 项 | 现状 | 问题 |
|---|---|---|
| 版本号 | `version.mjs` 三线并行：`APP_VERSION = 'dev 3.0.0'`、`KERNEL_VERSION = 'dev 0.2'`、`package.json version = 2.8.0` | 一线一值，无统一视图 |
| 版本脚本 | `version.mjs` 注释声明"升级版本号禁止手改，一律走 `scripts/bump-version.mjs`" | **该文件实际不存在**（文档漂移） |
| Git 标签 | **0 个 tag** | 无任何版本锚点 |
| 分支 | 38 个本地分支（`perf/`、`fix/`、`feature/` 等） | 多为无主实验分支，无清理机制 |
| Worktree | `src/components/worktree/WorktreePanel.tsx` + bridge `/worktrees`、`/branches`、`/worktree/create`、`/worktree/remove` | 只能创建/删除，**不能切换、不能看改动、不能回滚、不感知 agent** |

结论：项目已具备"并发隔离"（worktree）能力，但缺"版本锚定 + 回退"能力；且 agent 在日常开发中改动大量文件而不提交，**没有任何回退点**。

## 1. 需求（用户已确认）

1. **管理对象**：代码快照与发布版本号**统一在一个面板**。
2. **使用形态**：GUI 面板 + Agent 工具 + 自动策略，三者都要。
3. **核心操作**：打快照、回退/恢复、对比差异、清理与归档，四项一期全覆盖。
4. **管理范围**：仅管 YFWorking 自身仓库。
5. **自动触发**：回合收尾、里程碑达成、改动量超阈值、提交前，四类全部启用。
6. **版本号联动**：快照**可选**提升版本号，**默认不自动改**。
7. **保留策略**：自动快照滚动保留最近 N 个（默认 20，可配），手动快照永不自动删除。

## 2. 方案选型（已决策：影子引用快照）

候选方案与取舍：

| 方案 | 做法 | 结论 |
|---|---|---|
| A. Git Tag 原生 | 快照 = `v1.2.3-dev.7` 格式 tag | ❌ tag 只能指向**已提交** commit。agent 常态是改了 20 个文件未 commit → 要么强制 commit 污染历史，要么快照失真；且不解决分支膨胀 |
| **B. 影子引用快照** | 快照 = 写入 `refs/yfw/snap/<id>` 的**合成提交**，经临时索引捕获工作区 | ✅ **采纳** |
| C. 独立文件级备份 | 改动文件复制到 `.yfw-versions/<id>/` | ❌ 与 git 功能重复、存储翻倍、diff 质量差、不解决分支膨胀 |

**B 的三条硬理由**：① 捕获未提交改动（A 做不到，而这是 agent 工作流要害）；② 不污染 `git branch` 列表（38 分支不会变 380）；③ 复用既有 bridge + git 通道，diff/回退/清理全部复用 git plumbing。

## 3. 架构

三层，**核心逻辑单点，上挂两种消费端**——禁止 GUI 与 CLI 各写一套 git 操作。

```
┌─ server/version-store.mjs ──────────── 核心（纯 git plumbing，零 bridge 依赖，可单测）
│    createSnapshot / listSnapshots / diffSnapshots / restoreSnapshot / pruneSnapshots
└──────┬────────────────────────┬──────────────────────────┐
       │                        │                          │
  scripts/yfw-version.mjs   server/version-routes.mjs   bridge.mjs 自动触发
  （CLI，agent 经 Bash 调用）  （HTTP /versions/*，GUI 用）   （3 处挂点 + git hook）
       │                        │
   Agent 技能（何时打/如何读）  src/components/versions/VersionPanel.tsx
```

### 3.1 为什么 Agent 侧走 CLI + 技能而非内核 bridge_request 新路由

项目自身的 `version.mjs` 已明文规定"升级版本号禁止手改，一律走 `scripts/bump-version.mjs`"——**CLI 脚本是本项目做版本操作的既有惯例**。且 agent 天然具备 Bash 能力，零内核改动即可使用；新增内核路由需动内核侧协议与内核重新构建，收益不及成本。

## 4. 数据模型（零索引文件）

快照 = `refs/yfw/snap/*` 下的合成提交。**元数据全部编码在 commit message 中**，因此不引入索引文件，不存在缓存失效与并发写一致性问题。

### 4.1 commit message 格式

```
yfw-snap v1
name: 里程碑1-完成
kind: milestone
at: 2026-09-15T10:32:11+08:00
branch: feature/app-universal-onboarding
session: <conversationId>
milestone: 1/3
files: 12  +340  -88
note: |
  补完 onboarding 引导链路
```

字段：

| 字段 | 取值 | 说明 |
|---|---|---|
| `name` | 字符串 | 快照名（手动可填；自动按触发类型生成，如里程碑名） |
| `kind` | `manual` \| `turn` \| `milestone` \| `threshold` \| `precommit` \| `archive` \| `pre-restore` | 触发来源 |
| `at` | ISO8601 带时区 | 创建时间 |
| `branch` | 分支名 | 创建时 HEAD 所在分支；detached 时记 `(detached)` |
| `session` | conversationId | 可选，自动快照带 |
| `milestone` | `i/N` | 可选，仅 milestone 类型 |
| `files` | `N  +A  -B` | 改动统计 |
| `note` | 多行文本 | 可选备注 |

### 4.2 列表读取（单次 git 调用）

```
git for-each-ref refs/yfw/snap/ --format='%(refname:short)%00%(objectname)%00%(contents)'
```

一次调用即取得 ref 名 + sha + 完整 message。**这是刻意的设计选择**：多一个索引文件就多一套一致性维护成本（写失败、并发、跨 worktree 可见性），而 `for-each-ref` 本身就能拿全所需数据。

### 4.3 护栏

- **空改动自动跳过**（幂等）：工作区与 HEAD 树一致时不产生快照。
- **单快照体积护栏**：文件数 > 20000 或树体积 > 200MB 则拒绝创建，防止误入大目录。
- **`.gitignore` 尊重**：用 `git add -A`，忽略项不入快照。

## 5. 快照创建机制

临时索引捕获工作区，**不碰 HEAD、不动工作区、产出不出现在 `git branch`**：

```bash
GIT_INDEX_FILE=<tmpdir>/yfw-idx git add -A        # 临时索引，不污染真实 .git/index
GIT_INDEX_FILE=<tmpdir>/yfw-idx git write-tree   # 得到完整树对象
git commit-tree <tree> -p HEAD -m <msg>          # 合成提交，parent = 当前 HEAD
git update-ref refs/yfw/snap/<ts-slug> <sha>     # 写入影子引用
```

要点：
- 临时索引文件置于系统临时目录并**用后即删**（`try/finally` 保证异常路径也清理）。
- 合成提交的 parent 指向当前 HEAD，使其与 commit 图连通，`git diff <snap> HEAD` 自然可用。
- 不移动 HEAD、不切换分支、不触碰真实 `.git/index`。

### 5.1 快照命名

`refs/yfw/snap/<yyyyMMdd-HHmmss>-<slug>`，slug 为 name 的 ASCII 化短串（非 ASCII 名则退化为 kind）。同一秒内冲突时追加 `-2`、`-3`。

### 5.2 可选版本号提升

面板/CLI 提供 `bump` 参数（如 `--bump app:minor`）。勾选后**先**执行 `scripts/bump-version.mjs`，**再**打快照，保证快照内容已含新版本号。**默认关闭**。

## 6. 自动触发接线点

| 触发 | 接线位置 | 机制 |
|---|---|---|
| 回合收尾 | `server/bridge.mjs:1317`（`parsed.type === 'result'` → `session._turnActive = false`） | 检测 `_turnActive` true→false **边沿** + 300ms 去抖，打 `kind:'turn'` |
| 里程碑达成 | `server/bridge.mjs:1406`（`send({type:'milestone-ok'...})` 处） | 复用已有 `extractMilestoneMarks()` 解析结果，**零新增解析**，打 `kind:'milestone'` 并以里程碑名作快照名 |
| 改动超阈值 | 回合收尾同一处 | 改动 files > 20 或 ±行 > 300 时打 `kind:'threshold'`，并**抑制同一回合的 turn 快照**（避免双份） |
| 提交前 | `.git/hooks/pre-commit` | 调 CLI 打 `kind:'precommit'`；hook 内**一律 `exit 0` 兜底，绝不阻断 commit** |

去抖必要性：内核可能在一个逻辑回合内多次发出 `result`（子任务/重试），无去抖会产生密集重复快照。

### 6.1 配置

`settings.versionManager`：

```js
{
  enabled: true,             // 总开关
  autoTurn: true,            // 回合收尾
  autoMilestone: true,       // 里程碑达成
  autoThreshold: true,       // 改动超阈值
  thresholdFiles: 20,        // 文件数阈值
  thresholdLines: 300,       // 行数阈值
  autoPrecommit: false,      // 提交前（默认关，因需装 hook）
  retentionPerBranch: 20,    // 每分支自动快照保留数
}
```

GUI 面板顶部直接提供开关。

## 7. 四项操作的行为契约

### 7.1 打快照（create）

- 见 §5。
- 参数：`{ repoPath, name, note, kind='manual', bump=null }`。
- 返回：`{ ok, ref, sha, files, insertions, deletions, skipped? }`；空改动时 `{ ok:true, skipped:true, reason:'no-changes' }`。

### 7.2 回退/恢复（restore）

两种模式，**默认软恢复**：

| 模式 | 实现 | 行为 |
|---|---|---|
| 软恢复（默认） | `git checkout <sha> -- <paths>` | 只还原指定路径文件内容；不切 HEAD、不删未跟踪文件、不动其他文件 |
| 整体恢复（需勾选 + 二次确认） | 先 `git checkout <sha> -- .` | 还原整个工作树内容；`mode='full'` 时**忽略 `paths`**，一律全量还原 |

**硬约束**：
- **绝不用 `git reset --hard`、绝不用 `git clean -fd`**（会毁掉未提交工作，且无法追回）。
- **回退前自动创建 `kind:'pre-restore'` 保护快照**，使任何回退**必然可反悔**。该行为**不可配置关闭**。
- 整体恢复同样先打保护快照，再执行。

### 7.3 对比差异（diff）

- 双引用对比：`git diff --stat <refA> <refB>`、`git diff <refA> <refB> -- <path>` 取 patch。
- **最常用形态是"当前工作区 vs 某快照"**（`refB` 缺省为工作区），用于确认"我改了什么"。
- 返回 `{ files: [{path, insertions, deletions, binary}], totalInsertions, totalDeletions }` + 按需 patch 文本。

### 7.4 清理与归档（prune / archive）

- **自动快照按分支滚动保留最近 `retentionPerBranch` 个**；`manual` / `archive` / `pre-restore` 类型**永不自动删除**。
  - **分组依据**：快照 ref 本身不隶属分支，分组按 message 中记录的 `branch` 字段（§4.1）进行。`branch` 已消失（分支被删）的自动快照归入"孤儿"组，同样计入可清理候选。
- 流程：列出候选（超保留额度的自动快照 + 无主分支）→ 用户勾选 → **审批卡确认** → 执行 `git update-ref -d refs/yfw/snap/<id>` / `git branch -D <name>`。
- 归档 = 先打 `kind:'archive'` 快照（含分支名与最新 sha 于 note），再删分支。
- **不做自动 `git gc`**：由用户在明确知晓时手动执行。

## 8. HTTP 契约（HTTP /versions/*）

新增独立模块 `server/version-routes.mjs`，与 `logs-routes.mjs` / `knowledge-routes.mjs` **同构**：导出 `handleVersionRoute({...})`，命中返回 `{ status, body }`，未命中返回 `null`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/versions/list?path=` | 列出快照（解析 message）+ 当前分支 + 三线版本号 |
| POST | `/versions/create` | 打快照（body: name/note/kind/bump） |
| POST | `/versions/restore` | 回退（body: ref/paths/mode） |
| GET | `/versions/diff?path=&a=&b=` | 差异统计；`?patch=<file>` 取单文件 patch |
| POST | `/versions/prune` | 清理（body: refs[]/branches[]），**需携带审批确认标记** |
| GET | `/versions/config` / POST `/versions/config` | 读写 `settings.versionManager` |
| GET | `/versions/status?path=` | 各分支快照计数、超保留额度项、可清理候选（面板角标用） |

错误一律返回 `{ ok:false, error }`，不抛 500 裸栈。

## 9. CLI 契约（scripts/yfw-version.mjs）

供 agent 经 Bash 调用，与 HTTP 同源（都调 `version-store.mjs`）：

```
node scripts/yfw-version.mjs snap  [--name <n>] [--note <t>] [--kind <k>] [--bump <line:level>]
node scripts/yfw-version.mjs list  [--json] [--limit N]
node scripts/yfw-version.mjs diff  [<a>] [<b>] [--stat|--patch <file>]
node scripts/yfw-version.mjs restore <ref> [--paths <p1,p2>] [--mode soft|full] [--yes]
node scripts/yfw-version.mjs prune  [--dry-run] [--refs <r1,r2>]
node scripts/yfw-version.mjs status [--json]
```

- `--json` 输出机器可读结果，agent 优先用它。
- **`restore` 与 `prune` 无 `--yes` 时只打印将执行的动作（dry-run）**，绝不直接执行——落实"删除类操作需审批"铁律。
- 所有命令在非 git 目录下给出明确错误而非崩溃。

## 10. GUI 面板

新增 `src/components/versions/VersionPanel.tsx`，**接入既有抽屉机制**：

- `src/components/rail/FilesHistoryOverlay.tsx`：`SecondTabId` 增加 `'versions'`，`CONTENT` 映射增加一行（纯 +1 改动）。
- `src/stores/viewStore.ts`：`SecondTabId` 联合类型增加 `'versions'`。
- 面板结构：顶部开关区（自动策略 + 保留数）→ 版本号区（三线版本号 + 可选 bump 入口）→ 快照时间线（列表 + 对比/回退/删除操作）→ 清理入口（角标提示可清理数量）。
- 回退与删除操作弹出**审批卡**；整体恢复额外二次确认。
- **`WorktreePanel.tsx` 保持原样不改**（版本面板与其职责不同，不合并以免破坏既有已测行为）。

## 11. 安全边界（不可协商）

1. **只写 `refs/yfw/snap/*`**；不 `reset --hard`、不 `clean -fd`、不自动 `gc`。
2. **删除类操作**（清理快照 / 删分支）**一律走审批卡**。
3. **回退前自动保护快照**，不可关闭。
4. 安装 `pre-commit` 钩子会写 `.git/hooks/` → **实施时单独请用户批准**（当前 `.git/hooks/` 无任何活动钩子）。
5. 自动快照失败**绝不影响**对话主流程：全部 `try/catch` 包裹，失败仅记日志。
6. 路径参数防穿越：所有涉及路径的操作 `resolve` 后断言仍在仓库内。

## 12. 补齐 scripts/bump-version.mjs（用户已确认一并做）

`version.mjs` 注释承诺但文件缺失。本次补齐：

- 支持版本线选择与级别：`node scripts/bump-version.mjs <app|kernel|pkg> <major|minor|patch>`
- 写回：`version.mjs` 的 `APP_VERSION` / `KERNEL_VERSION`、`package.json` 的 `version`
- **同步测试期望值**（注释中声明的能力）：扫描测试文件中的版本断言并更新
- 版本规范：`dev <major>.<minor>[.<patch>]`（发布稳定后去 `dev` 前缀），与既有注释一致
- 幂等校验：非法输入（未知版本线/级别）报错退出码非 0，不静默改文件

## 13. 文件清单

**新增（10）**：
- `server/version-store.mjs` — 核心 git plumbing
- `server/version-routes.mjs` — HTTP 路由
- `server/version-store.test.mjs` — 核心单测
- `server/version-routes.test.mjs` — 路由单测
- `scripts/yfw-version.mjs` — CLI
- `scripts/bump-version.mjs` — 版本号提升（补齐缺失）
- `src/lib/versionApi.ts` — HTTP 客户端
- `src/lib/versionModel.ts` + `src/lib/versionModel.test.ts` — 纯函数（message 解析、格式化、保留策略计算）
- `src/components/versions/VersionPanel.tsx` — GUI 面板

**修改（6）**：
- `server/bridge.mjs` — 挂路由 + 3 处触发点（回合收尾 / 里程碑 / 阈值）
- `src/components/rail/FilesHistoryOverlay.tsx` — 加一个 tab（+2 行）
- `src/stores/viewStore.ts` — 联合类型加 `'versions'`
- `src/stores/settingsStore.ts` — 加 `versionManager` 配置段
- `src/i18n/translations/zh-CN.ts` / `en-US.ts` — 新增文案键

**不改**：`src/components/worktree/WorktreePanel.tsx`

## 14. 测试重点

在**真实临时 git 仓库**内跑真实 git 调用（非 mock），覆盖：

1. 捕获**未提交改动**（核心价值点，方案 A 做不到的那个）
2. 空改动**自动跳过**
3. 临时索引**不污染**真实 `.git/index`（创建快照后 `git status` 与创建前一致）
4. 产出**不出现在 `git branch`**
5. 保留策略**不误删** `manual`/`archive`/`pre-restore`
6. 软恢复**只影响指定路径**
7. 恢复前**保护快照必生成**（不可关闭）
8. 超体积**拒绝创建**
9. 消息编解码**往返一致**（含多行 note、非 ASCII 名）
10. CLI 无 `--yes` 时 **restore/prune 只 dry-run**
11. `bump-version.mjs` 三线递增正确 + 非法输入非 0 退出

## 15. 分期

| 期 | 内容 | 交付 |
|---|---|---|
| **P0** | `version-store.mjs` 核心引擎 + CLI + `bump-version.mjs` + 单测 | 命令行可用、有测试保障 |
| **P1** | `version-routes.mjs` + `versionApi.ts` + `versionModel.ts` + VersionPanel + i18n | GUI 可用，四项操作手动可用 |
| **P2** | bridge 4 处自动触发 + 配置段 + pre-commit hook（需单独批准） | agent 开发自动留版本点 |
| **P3** | 清理与归档 UI 补全 + 审批卡 + Agent 技能说明 | 全量交付 |

每期结束**输出里程碑标记并请用户验收**。

## 16. 风险与已知限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 合成提交游离对象 | `git fsck` 会报告 dangling commit | 属预期行为，文档说明；`refs/yfw/*` 有 ref 指向，不会被 gc |
| 快照占用磁盘 | 大仓库频繁快照会累积对象 | 保留策略 + 体积护栏 + 面板体积提示；不做自动 gc |
| 自动快照噪声 | 阈值过低会产生大量快照 | 回合去抖 300ms + threshold 抑制 turn + 可配置阈值 + 可关闭单项 |
| pre-commit 钩子冲突 | 若日后装其他钩子（husky 等） | hook 内容幂等、带标记段；安装前单独获批 |
| 三线版本号漂移 | 已存在（`dev 3.0.0` / `dev 0.2` / `2.8.0`） | 面板集中展示；bump 脚本统一入口 |
