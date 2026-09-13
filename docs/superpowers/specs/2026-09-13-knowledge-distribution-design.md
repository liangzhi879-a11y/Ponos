# Spec：生态分发（S4）—— 知识包的清单 / 安装 / 发布（2026-09-13）

## 0. 定位

本子项目是"参考 obsidian-releases"的**直接落地**。依赖 S1 的 `packs/` 布局与 `pack.json` 占位
（S1 §5.1），本 spec 把它做成可用的生态机制。**不碰 `spaces/` 用户数据**（只读挂载包，不合并写入）。

## 1. obsidian-releases 机制拆解与对应

| Obsidian 机制 | 作用 | YFWorking 对应 |
|---|---|---|
| `community-plugins.json`（仅 id/name/author/description/repo） | 中央轻量索引，供搜索 | `knowledge-packs.json`（中央清单） |
| 详情页拉 `manifest.json` + `README.md` | 只拉元数据，不拉内容 | 拉 `pack.json` + `README.md` |
| `manifest.json` 的 `version` 与 `minAppVersion` | 版本判定 + 兼容性 | `pack.json` 的 `version` / `minAppVersion` |
| `versions.json` | manifest 要求版本高于当前 App 时，回退找兼容的最新版 | `versions.json`（同构，字段名保持一致以降低理解成本） |
| 按 version 找同 tag release，下载 `main.js`/`styles.css` | 内容分发走 GitHub Releases | 同 tag release 下载 `pack.zip`（或 tarball） |
| 开发者政策 + 人工审核 | 代码执行风险控制 | **内容包无代码执行**，改为内容净化 + 体积限制（见 §6） |
| 插件存进 vault 目录 | 落到用户可读位置 | 落到 `~/.yfw/knowledge/packs/<packId>/`（只读挂载） |

**关键差异（决定安全模型可放松）**：Obsidian 插件是可执行代码，故其生态必须靠人工审核；
知识包是 Markdown 内容，**无代码执行面**，故不需要提交审核流程，只需防路径穿越 / 体积炸弹 /
渲染注入。这使得 S4 的实现成本远低于一个插件市场。

## 2. 清单与包元数据

### §2.1 中央清单 `knowledge-packs.json`

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-13T10:00:00Z",
  "packs": [
    {
      "id": "gaoqi-2026",                    // 唯一，小写字母/数字/连字符
      "name": "高新技术企业认定知识包",
      "description": "认定办法、工作指引、材料清单与常见退回问题（截至 2026）",
      "author": "YFWorking 官方",
      "repo": "https://github.com/<owner>/<repo>",   // 元数据来源
      "tags": ["申报", "高企", "政策"],
      "docCount": 48,                        // 提示性，安装后以实际为准
      "sizeBytes": 1048576
    }
  ]
}
```

**清单只放轻量索引**（与 `community-plugins.json` 同思路）：搜索/浏览列表不依赖网络之外的资源；
点开详情才拉 `pack.json` 与 `README.md`。

### §2.2 包元数据 `pack.json`

```jsonc
{
  "id": "gaoqi-2026",
  "name": "高新技术企业认定知识包",
  "version": "1.2.0",            // semver
  "minAppVersion": "0.9.0",      // 低于此版本的 App 不安装
  "description": "…",
  "author": "…",
  "license": "CC-BY-4.0",        // 内容许可，展示给用户
  "source": "knowledge/packs/gaoqi-2026",   // 包内空间根（相对路径）
  "spaces": [ { "id": "gaoqi", "name": "高企认定", "path": "docs/gaoqi" } ]
}
```

### §2.3 版本兼容 `versions.json`

```jsonc
{ "1.2.0": "0.9.0", "1.0.0": "0.8.0" }
```
规则与 Obsidian 一致：若 `pack.json` 的 `minAppVersion` 高于当前 App 版本，则查 `versions.json`
找**满足当前 App 版本的最新包版本**；找不到则提示"该知识包需要更高版本应用"。

## 3. 安装流程

### §3.1 四态决策（复用 `server/skill-install.mjs:135` 的既有范式）

| 状态 | 判据 | 动作 |
|---|---|---|
| `installed` | 目标目录不存在 | 解压落盘 + 写台账 |
| `updated` | 已装且版本不同，且**包内文件未被用户改动** | 覆盖落盘 + 更新台账 |
| `unchanged` | 已装且版本相同 | 跳过 |
| `kept-user-modified` | 已装且用户改过包内文件 | **保留用户改动**，提示冲突并提供"覆盖 / 保留 / 另存为我的空间"三选 |
| `skipped-empty` | 解压后无有效文档 | 不落盘，报错 |

台账：`~/.yfw/knowledge/.packs.json`，记录 `{ packId: { version, installedAt, files: { relPath: hash } } }`
（结构对齐 `skill-install.mjs` 的 `manifest.files` 指纹表）。

### §3.2 安装步骤

1. 校验 `id` 合法性（正则）+ 清单来源可信（§4）；
2. 解析版本：读 `pack.json` → 必要时经 `versions.json` 回退 → 确定要下载的 tag；
3. 下载到临时目录 → **校验**（§6：路径穿越、单文件体积、总积、文件数）；
4. 按四态决策落盘（原子：`.tmp` → rename，对齐 `graph.mjs:130` 手法）；
5. 写台账 → 触发索引增量（新空间注册，S1 端点）；
6. 结果为只读空间（`writable:false`），卸载即删目录 + 清台账。

### §3.3 离线 / 内网模式

企业环境常无外网。清单支持三种来源（按优先级）：

| 来源 | 形式 |
|---|---|
| 本地目录 | `~/.yfw/knowledge/packs-index.local.json`（离线清单，含本地路径或 file:// URL） |
| 自建镜像 | 配置 `knowledgePackRegistry` 指向内网 HTTP 服务（同 schema） |
| 官方清单 | 默认远程（GitHub raw） |

**离线安装**：支持 `从本地 zip / 目录安装`——跳过网络，直接进 §3.2 第 3 步的校验与落盘。
这一条对本产品的企业客户是刚需，优先级不低于在线安装。

## 4. 清单来源与信任

- 默认清单 URL 常量 + 可配置覆盖（对齐 `providerProfile` 的配置思路）；
- **清单不是可信输入**：`repo` 字段仅用于拉元数据，实际下载 URL 由 `id + version + 配置的
  registry 基址` 组装，不接受清单里的任意 URL（防 SSRF / 钓鱼指向）；
- 下载走既有浏览器/网络白名单机制（`server/browser-whitelist.test.mjs` 的域名单一真源）。

## 5. 导出与发布（供给侧）

让用户/官方能把一个空间**发布成知识包**：

1. 选择空间 → `导出为知识包` → 生成 `pack.json`（id/version/LICENSE 由用户填）+ `README.md` 模板；
2. 打包为 `<id>-<version>.zip`，同时产出 `files` 指纹表；
3. 产出**清单条目片段**（可直接粘进 `knowledge-packs.json` 的 JSON 对象）与提交说明，
   流程与 obsidian-releases 的"提交清单 PR"一致；
4. 本地自用：可直接"安装"导出的包（离线路径）。

**不内置自动 PR 提交**（需要 GitHub 凭据，属高风险操作），只产出可粘贴的片段与说明。

## 6. 安全

| 风险 | 防护 |
|---|---|
| 路径穿越（`../`、绝对路径、符号链接） | 解压后逐条目断言 `resolve(dest, rel)` 仍在 `packs/<id>/` 内；拒绝符号链接条目；沿用 `logs-routes.mjs:19-27` 三重防护范式 |
| 体积炸弹 | 单文件 ≤ 2MB、总解压 ≤ 50MB、文件数 ≤ 2000（可配置上限） |
| 内容渲染注入 | 渲染只用 `react-markdown` + `remark-gfm`；**禁止 `dangerouslySetInnerHTML`**、禁止 `rehype-raw`；md 内 HTML 一律按文本显示 |
| 许可证风险 | `pack.json` 必填 `license` 并在安装前展示；无 license 的包拒绝安装 |
| 冒充官方 | 清单区分 `author` 与 `official: true`（仅官方清单条目可标），UI 明确标识 |
| 完整性 | 台账 hash 校验；**明确不做**密码学签名（与 Obsidian 同级） |

## 7. UI 范围（S4 自带）

最小可用：

- **知识包市场**：清单列表（搜索/标签过滤）→ 详情（README + license + 版本兼容状态）→ 安装/更新/卸载；
- 入口两处：知识模块左栏「发现知识包」（对齐原型 §1 的空间列表底部）+ 设置 → 知识库设置；
- **离线安装**：市场页顶部"从本地文件安装"按钮。

实现落点：`src/components/knowledge/KnowledgeMarketView.tsx`（S2 组件目录内），路由 `/knowledge/packs*`。

## 8. 验收标准

- [ ] 能用本地 zip 完成离线安装，落盘为只读空间并可被检索
- [ ] 在线清单可浏览、搜索、按标签过滤
- [ ] 四态决策全部可复现（含"用户改过包内文件"的冲突提示）
- [ ] 版本不兼容时按 `versions.json` 回退；无兼容版本时给出明确提示且不安装
- [ ] 恶意包（`../` 路径、超限体积、无 license）被拒绝且不留残留
- [ ] 卸载后目录与台账均清理，索引同步移除该空间
- [ ] 导出功能生成合法的 `pack.json` + zip + 清单条目片段
- [ ] `npm test` 全绿（安装/校验逻辑单测，**不启动 bridge**）

## 9. 非目标（YAGNI）

付费/订阅、评分与评论、自动更新检查的后台定时任务（本期手动"检查更新"）、
包依赖关系（一个包依赖另一个包）、增量差分更新（整包替换）、代码执行型扩展
（本产品扩展机制走 skills/agents，不走知识包）、自动 PR 提交。

## 10. 待确认决策点

> **状态**：以下四项**不在 S1/S2/S3 的依赖路径上**，故**推迟到 S4 实施前确认**（不影响前三期推进）。
> 本 spec 的建议默认值标 *(默认)*，无异议即按默认落地。

| # | 决策 | 选项 |
|---|---|---|
| D1 | 官方清单托管位置 | 独立 GitHub 仓库（对标 obsidian-releases）／**并入现有仓库子目录** *(默认，零新建成本)*／暂不做官方清单只管离线包 |
| D2 | 下载形态 | **zip** *(默认，解压校验路径成熟)*／tarball／逐文件 raw 下载 |
| D3 | 更新检查 | **仅手动** *(默认，无后台网络与隐私成本)*／启动时后台检查一次 |
| D4 | 知识包是否允许含非 md 资产 | **允许**（图片/PDF 附件，受 §6 体积限制） *(默认)*／仅 md（最简最安全） |

---

## 11. 修订记录（S4 实施前源码复核，2026-09-13）

复核依据：worktree `knowledge-s1`（S1+S2+S3 已落地）对 `kernel/` `server/` `shared/` `src/` 逐条 grep + 读码。
S2 实测发现 12 处漂移、S3 发现 14 处，本次发现 **16 处**（5 处一致 / 11 处偏差，其中 **4 处会返工**）。
**本节与正文冲突时，以本节为准。**

### 11.1 事实修正（行号与命名）

| 原表述 | 实际情况 |
|---|---|
| §3.1「复用 `server/skill-install.mjs:135` 的既有范式」 | 范式在 **`:135` 的 `upsertSkill()`**，返回 **5** 个值（`installed` / `updated` / `unchanged` / `kept-user-modified` / `skipped-empty`）+ `manifest.files` 指纹表（`id/相对路径 → sha256 前 16 位`），且**文本类内容先做行尾归一（CRLF→LF）再哈希**（`:92` `textHash`）。台账 schema 直接对齐它 |
| §7 实现落点 `src/components/knowledge/KnowledgeMarketView.tsx`、路由 `/knowledge/packs*` | 文件**不存在**（新建）；S2 **没有前端 URL 路由**——第 7 rail 是全屏面板 + **四视图条件渲染**（`KnowledgePanel.tsx:88-104`，视图集合 `KNOWLEDGE_VIEWS` 在 `src/stores/knowledgeStore.ts:22`） |
| §8「`npm test` 全绿」 | `package.json` 的 test glob = `shared/**/*.test.mjs` + `server/*.test.mjs` + `electron/*.test.mjs` + `kernel-tests/*.test.mjs` + `src/**/*.test.ts`。**`kernel/*.test.mjs` 与子目录形态的 server 测试都不在 glob 内**（S1 教训） |
| §2.1 中央清单 `knowledge-packs.json` | 该文件**当前不存在**（S1 只实现 `packs/` 扫描 + `pack.json` 读取，`kernel/knowledge.mjs:73-89`）。S4 新建，落点见 §11.3 D1 |
| §1/§5 知识包落盘位置 | ✅ 一致：`join(resolveYfwHome(), 'knowledge', 'packs', <packId>)`（`server/yfw-home.cjs` 解析序 `YFWORKING_HOME > CLAUDE_CONFIG_DIR > ~/.yfworking`；bridge spawn 时注入 `CLAUDE_CONFIG_DIR = YFW_HOME`，`server/bridge.mjs:859`，故 kernel 的 `knowledgeRoot(configDir)` 与 server 同根） |
| §1 空间 id `pack-<id>` / `writable:false` | ✅ 一致：`kernel/knowledge.mjs:82-88` 逐字为 `{ id: 'pack-' + 目录名, root: join(dir, meta.source), writable: false, source: 'pack', packVersion: meta.version }` |

### 11.2 已确认一致的前提（可直接依赖，勿再"顺手改"）

1. **只读挂载语义**：`packs/` 下的空间 `writable:false`，写入一律 403（`server/knowledge-routes.mjs:66`）。
   安装**不碰 `spaces/` 用户数据**这一约束成立。
2. **渲染注入防护已满足**：`src/components/knowledge/KnowledgeDocView.tsx:110` 只用
   `react-markdown` + `remarkPlugins`，全仓无 `rehype-raw`、无 `dangerouslySetInnerHTML`。
   S4 只需**不引入**它们。
3. **无需"注册空间"**：`discoverSpaces` 每次扫盘；`store.load()` 的 staleness 逐文件比
   size/mtime 并检测"磁盘新增/已删"（`kernel/knowledge.mjs:318-321`）→ 安装/卸载后**下一次
   检索自动吸收**新空间，不需要任何内核调用（正文 §3.2 第 5 步作废，见 §11.3 R4）。
4. **server 侧不复制内核逻辑的边界**：安装/卸载/导出操作的是**数据目录**（`knowledge/packs`），
   与 `server/skill-install.mjs` 同类，**不需要经 `kernelReadonly`**；只有"读空间清单"这类
   知识库查询才走 `--knowledge spaces`。
5. **两份 chat 禁用表**：S4 **不新增内核工具**（安装器全在 server 侧），故
   `kernel/tools.mjs` 的 `CHAT_MODE_DISALLOWED` 与 `server/bridge.mjs` 的 `CHAT_DISALLOWED`
   **无需改动**，`kernel-tests/chat-mode.test.mjs` 的逐项比对不受影响。

### 11.3 会导致返工的前提错误（四条，必须按本节实施）

**R1 —— ❌ §2.2 的 `spaces: [{ id, name, path }]` 内核根本不读。**
`kernel/knowledge.mjs:80` 只用**单根** `meta.source`：`base = meta.source ? join(dir, source) : dir`。
即"一个知识包 = 一个空间"，多空间包**不支持**（要支持必须改内核 `discoverSpaces`）。
→ S4 口径：`pack.json` 的 **`source` 必填**、必须是包内**已存在的子目录**、**不得为 `.`**
（若为 `.`，`pack.json` / `README.md` 会被 `walkMd` 当成文档混进空间——实测 `walkMd` 收包根下所有 `.md`）。
`spaces[]` 字段**忽略**（不解析不校验），在 schema 校验里只在**导出**侧不产出。
**示例矛盾也要一起修**：§2.2 同节里 `"source": "knowledge/packs/gaoqi-2026"`（仓库根视角）与
`"path": "docs/gaoqi"`（包内视角）自相矛盾；实施以**包目录为基准**（内核 `join(dir, source)`）。
导出包布局固定为：`<id>/pack.json` + `<id>/README.md` + `<id>/content/**` + `"source": "content"`。

**R2 —— ❌ §4 的"下载走既有浏览器/网络白名单机制"指错了模块，且默认清单 URL 无落地常量。**
① `server/browser-whitelist.test.mjs` 是**测试文件**不是真源（真源在 `electron/browser-common.cjs`
+ `~/.yfw/browser-whitelist.json`），服务的是**浏览器工具执行器**；知识包下载走 server 侧 `fetch`，
不经浏览器通道，硬套白名单只会造出一个"配了却不生效"的假开关。
② `repo` 字段形态（`https://github.com/<owner>/<repo>`）不可直接下载：raw 与 release 资产 URL
另有一套拼法。
→ S4 口径：**下载 URL 由 `registry 基址 + id + version` 唯一组装**，并对组装结果做
**origin 断言**（与基址同源）；清单里的 `repo` 只作展示与人工溯源。测试**注入可替换 fetcher**，
**绝不在测试里请求真实 URL**。

**R3 —— ⚠️ §3.1 表头写"四态决策"但表体是 5 项。** 按 **5 态**实现（与 `upsertSkill` 返回值
逐字一致）；另外补上正文没写清的一点：`kept-user-modified` 的"三选"（覆盖/保留/另存为我的空间）
必须**默认不写盘**——只返回冲突清单与可选项，由调用方显式指定 `mode` 才动盘。

**R4 —— ⚠️ §3.2 第 5 步「触发索引增量（新空间注册，S1 端点）」不存在。** 见 §11.2 第 3 条：
staleness 会自动吸收。实施上**不得**为了"触发"而新增内核 op 或调用 `reindex`（全量重建在
企业库上很贵，且非必要）。

### 11.4 硬约束补强（正文未列，实施必须照做）

1. **禁止可执行/脚本类扩展名**。正文 §1 的安全模型建立在"内容包无代码执行面"之上；若允许
   `.js/.mjs/.cjs/.exe/.dll/.bat/.cmd/.ps1/.sh/.py/.jar` 等落入用户目录，该模型即失效
   （用户或模型后续都可能误执行）。S4 对包内每个条目做**扩展名白名单**（md 与图片/PDF 等
   纯数据资产），命中黑名单即整包拒绝。
2. **体积上限在"解压前"就要用声明值挡一次**（zip 中央目录的 uncompressed size）——
   只在解压后统计等于允许 zip bomb 先吃满内存。
3. **完整性**：逐条目校验 CRC32 + 实际解压字节数 == 声明值；`pack.json` 必须能被解析且
   `id` 与安装目标目录名一致（防"清单说 A、内容其实是 B"）。
4. **按 §6 的体积/文件数上限之外**，另需限制条目数（含目录）——只限制"文件数"挡不住
   十万个空目录条目。
5. **D4 生效后**，`pack.json` 的 `license` 必填且非空（§6 已列），S4 把它做成**校验不过即拒绝**
   的硬失败（而非警告）。

### 11.5 本轮四项待决策的生效默认值

| # | 决策 | **生效默认值（实施口径）** | 如需变更 |
|---|---|---|---|
| D1 | 官方清单托管位置 | **并入现有仓库子目录** `knowledge-packs/`（含 `index.json` + `README.md` 提交说明）；默认 registry 常量指向该目录的 raw 地址，**owner/repo 为占位值待确认**，可经 `config.json` 的 `knowledgePackRegistry` 覆盖；**本地离线清单优先**（`~/.yfw/knowledge/packs-index.local.json` 存在时不再联网） | 请指示 owner/repo 或改为"暂不做官方清单" |
| D2 | 下载形态 | **zip**（自研 `shared/pack-zip.mjs`，`node:zlib` + 自算 CRC32；仓库无 zip 直接依赖，`jszip`/`unzipper`/`tar` 全是传递依赖，不可当契约） | 请指示改用 tarball |
| D3 | 更新检查 | **仅手动**：无后台定时器，仅在用户打开知识包市场/点"检查更新"时拉一次清单，不缓存到磁盘 | 请指示加启动检查 |
| D4 | 非 md 资产 | **允许**（图片/PDF/CSV 等纯数据资产），走**扩展名白名单 + 单文件 ≤2MB/总 ≤50MB/文件数 ≤2000**，**禁可执行与脚本类**（§11.4 第 1 条） | 请指示收紧为"仅 md" |
