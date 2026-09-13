# S4 生态与分发实施计划（7 任务）

> 规格：`docs/superpowers/specs/2026-09-13-knowledge-distribution-design.md`（**必读 §11 修订记录**）
> 依赖：S1 已交付 `packs/` 只读挂载（`kernel/knowledge.mjs` 的 `discoverSpaces`）、
> `server/knowledge-routes.mjs`（`/knowledge/*` 薄转发）、`shared/knowledge-core.mjs`；
> S2 已交付 GUI（第 7 rail 面板 + 四视图）；S3 已交付 AI 集成（本期**不动**）
> 分支：`knowledge-s1`（worktree `.worktrees/knowledge-s1`）
> 日期：2026-09-13

## 目标

把 S1 留的 `packs/` 占位做成**可用的生态机制**（不是插件市场——包内无代码执行面）：

1. **离线安装**（企业刚需，优先级不低于在线）：本地 `zip` / 目录 → 校验 → 落盘为只读空间
2. **在线清单**：中央轻量索引（`knowledge-packs/index.json`）+ 详情（`pack.json` + `README.md`）
   + 版本兼容回退（`versions.json`）
3. **四态（实为 5 态）决策**：`installed` / `updated` / `unchanged` / `kept-user-modified` / `skipped-empty`，
   照 `server/skill-install.mjs:135` 的 `upsertSkill` 范式
4. **导出与发布**（供给侧）：空间 → `pack.json` + `README.md` + `<id>-<version>.zip` + 清单条目片段
5. **安全**（本 section 风险最高）：路径穿越四重防护、扩展名白名单、体积/条目上限、
   CRC32 + 字节数完整性、无 license 拒绝、已存在走"拒绝+提示"而非静默覆盖

## 全局约束（违反即返工）

1. **kernel ⊥ server 双向禁止 import**。本期**不改 kernel**：安装/卸载/导出操作的是数据目录
   （`knowledge/packs`），与 `server/skill-install.mjs` 同类；`shared/` 是中性层（kernel 已 import 它），
   server 侧可 import `../shared/*.mjs`（`electron-builder.yml` 已收录 `shared/**/*`，
   `server/knowledge-packaging.test.mjs` 有断言守着）。
2. **测试禁止启动 bridge、禁止真联网**：所有网络行为经**注入 fetcher**（`fetchIndex` / `fetchArchive`
   都收 `fetcher` 参数），测试注入假 fetcher 或直接喂 `Buffer`；**绝不在测试里请求真实 URL**。
3. **测试隔离**：`mkdtempSync` + 显式注入 `home`（`PONOS_HOME`/`YFWORKING_HOME` 不参与断言路径），
   **绝不碰真实 `~/.yfworking` / `~/.yfw` / `~/.ponos`**。
4. **纯增量 + 向后兼容**：不改任何 S1/S2/S3 已交付导出与行为；新增能力全部是新文件 + 新路由，
   既有 `/knowledge/*` 路由的响应逐字节不变（`server/knowledge-routes.test.mjs` 既有断言必须全绿）。
   `src/stores/knowledgeStore.ts` 的视图集合由 4 → 5 是**有意的功能扩展**（须同步改
   `knowledgeStore.test.ts:64` 的期望，并在报告里列明"这是功能扩展不是期望值笔误"）。
5. **两份 chat 禁用表不动**（本期不新增内核工具，见 spec §11.2 第 5 条）。
6. **安装写入用户目录属高危操作**：**纯增量**；覆盖前必须**备份**（整目录 rename 到
   `knowledge/packs/.backups/<id>-<ts>`，每包只保留最新 1 份）；目标已存在且内容与台账不符
   一律走 `kept-user-modified`（**不写盘**，返回冲突清单 + 三选）。
7. **中文注释解释 why**（仓库风格）。

## 完成定义（S4 验收标准 → 对照规格 §8）

| # | 验收项 | 方式 |
|---|---|---|
| 1 | 本地 zip 离线安装 → 落盘 `knowledge/packs/<id>` 为只读空间、可被检索 | 单测（安装后跑内核 store 检索） |
| 2 | 在线清单可浏览/搜索/标签过滤（含本地离线清单优先） | 单测（假 fetcher）+ GUI |
| 3 | 5 态决策全部可复现（含"用户改过包内文件"的冲突提示且不写盘） | 单测（5 条用例） |
| 4 | 版本不兼容按 `versions.json` 回退；无兼容版本 → 明确提示且不安装 | 单测 |
| 5 | 恶意包（`../` 路径 / 超限体积 / 无 license / 可执行扩展名 / 符号链接条目）被拒且**不留残留** | 单测（每条一个用例 + 断言 staging 已清理） |
| 6 | 卸载后目录与台账均清理，索引下次 load 自动移除该空间 | 单测 |
| 7 | 导出生成合法 `pack.json` + zip + 清单条目片段（zip 能被自家 reader 读回） | 单测 |
| 8 | 四段测试基线不降 + `npm run typecheck` / `npm run build` 通过 | 命令 |

## 生效默认值（4 项待决策，无异议即按此落地）

| # | 决策 | **生效默认值** |
|---|---|---|
| D1 | 官方清单托管位置 | **并入现有仓库子目录** `knowledge-packs/`（`index.json` + 提交说明 README）；默认 registry 常量 = 该目录 raw 地址（**owner/repo 占位待确认**），可经 `config.json:knowledgePackRegistry` 覆盖；**本地离线清单优先**（`~/.yfw/knowledge/packs-index.local.json` 存在即不联网） |
| D2 | 下载形态 | **zip**（自研 `shared/pack-zip.mjs`：`node:zlib` + 自算 CRC32，零新依赖） |
| D3 | 更新检查 | **仅手动**（无后台定时器；打开市场即检查，不落盘缓存） |
| D4 | 非 md 资产 | **允许**（图片/PDF/CSV 等纯数据），**扩展名白名单 + 体积上限 + 禁可执行/脚本类** |

> **如需变更请指示**：D1 的 owner/repo（否则默认常量指向占位仓库，在线清单在真实环境拉不到，
> 离线路径不受影响）；D3 若要"启动时检查一次"需新增后台任务；D4 若要收紧为"仅 md"需改白名单。

## 节奏

- 每任务：**先测后码**（`node:test` + `node:assert/strict`），定向测试 → `npm run typecheck` → **立即提交**
  （子 Agent 有 300s 工具超时，未提交的代码丢了代价最大）。
- 批次：① 复核+计划（本文档 + spec §11）② **批次 A** = Task 1-4（后端全链）③ **批次 B** = Task 5-7（GUI + 报告）。
- **期望值纪律**：手写期望值与实跑不符时，**改期望不改实现**，报告里列修正清单。

---

### Task 1: `shared/pack-zip.mjs` —— 自研 zip 编解码（零依赖）

**交付物**
- `shared/pack-zip.mjs`：
  - `crc32(buf) → number`（查表法）
  - `readZip(buffer, { maxFiles, maxFileBytes, maxTotalBytes, maxEntries }) → { entries }`，
    每条 `{ name, data, method, size, crc }`；**解压前**用中央目录声明值先挡上限（防 zip bomb）
  - `writeZip(files, { level }) → Buffer`（stored/deflate 二选一，deflate 缺省）
  - `isZipPathSafe(name) → { ok, reason }`（本模块只做"条目名合法性"，**穿越语义防护在 Task 2**）
- `shared/pack-zip.test.mjs`

**实现要点**
- 只支持 **method 0/8**（stored/deflate）；**拒绝 zip64 哨兵**（`0xFFFFFFFF`）与**加密位**
  （flag bit0）——我们的上限 50MB，zip64 出现即异常输入，报可读错误
- 拒绝**声明解压尺寸 > 上限**（不解压即拒）；拒绝**多盘**（disk ≠ 0）
- 中央目录定位：从尾部反向找 EOCD 签名 `0x06054b50`（允许注释长度不定）；条目数据偏移
  以**本地头**为准（`30 + nameLen + extraLen`），尺寸以**中央目录**为准（兼容 data descriptor）
- 逐条 CRC32 + 实际长度 == 声明长度；不符即抛 `zip integrity`
- **符号链接/特殊文件条目**：由 `externalAttrs >> 16` 的 unix mode 判 `S_IFLNK (0xA000)` 等，
  标记 `isSymlink`/`isSpecial`，由 Task 2 拒绝（读者不擅自丢，交上层决策并给可读错误）
- writer 用 `deflateRawSync`；目录条目（`name.endsWith('/')`）不写（解压侧按需 mkdir），
  保持产物最小、且"包内无空目录"这个不必要的特性直接不存在

**验证**
- `node --test shared/pack-zip.test.mjs`
- 用例：round-trip（含中文名/二进制/空文件）、**外部工具产物**（内嵌一段 base64 fixture：
  由 PowerShell `Compress-Archive` 生成的真实 zip，验证我们读得动别人写的）、
  畸形输入（截断/坏签名/声明尺寸超限/加密位）、CRC 篡改被拒

---

### Task 2: `shared/knowledge-pack.mjs` —— 清单/元数据校验与版本判定（纯函数）

**交付物**
- `shared/knowledge-pack.mjs`：
  - `sanitizePackEntryPath(rel)` —— **四重防护**：① 非空、禁绝对路径/盘符/UNC/`\0`；
    ② 逐段禁 `.` `..`；③ `resolve` 后断言在根内（调用方传根）；④ 符号链接条目由调用方 realpath 兜底
  - `sanitizePackId(id)`（`/^[a-z0-9][a-z0-9-]{0,63}$/`）+ `packSpaceId(id)`（= `pack-<id>`）
  - `PACK_LIMITS = { maxFileBytes: 2MB, maxTotalBytes: 50MB, maxFiles: 2000, maxEntries: 4000 }`
  - `ALLOWED_ASSET_EXTS` / `DENIED_CODE_EXTS`（§11.4 第 1 条）+ `classifyPackEntry(name)`
  - `validatePackManifest(json, { expectId, appVersion, versions }) → { ok, errors, pack }`：
    必填 `id/name/version/license/source`；`source` 须为包内相对子目录且**不得为 `.`**（spec §11.3 R1）；
    `minAppVersion` 可选 semver；**`spaces[]` 忽略**（内核不支持多空间）
  - `parseSemver(s)` / `compareSemver(a, b)` / `satisfiesMinApp(minAppVersion, appVersion)`
  - `resolvePackVersion({ manifestVersion, minAppVersion, appVersion, versions }) → { ok, version, reason }`
    （Obsidian 同构：自身兼容即用自身；否则在 `versions.json` 里取"满足当前 App 的最新包版本"；
    都不满足 → `needs-higher-app`）
  - `buildManifestEntry(pack, { repo, tags })`（清单条目片段）+ `buildPackReadme(pack)`
  - `hashContent(buf)`（文本先做 CRLF→LF 归一，与 `skill-install.mjs:92` 同一基准——否则跨平台
    重装会把每个文件误判成"用户改过"）
- `shared/knowledge-pack.test.mjs`

**实现要点**
- 校验函数**只返回结构化结果，不抛**（调用方要能把 `errors` 直接展示给用户）
- 不实现 JSON Schema 引擎（YAGNI）：手写逐字段判定，错误信息用中文短句

**验证**
- `node --test shared/knowledge-pack.test.mjs`
- 用例：`../`/绝对路径/盘符/`\0` 拒；`.exe`/`.js` 拒、`.md`/`.png`/`.pdf` 收；
  `license` 缺失拒；`id` 与目标目录不一致拒；版本回退三态；CRLF 归一哈希相等

---

### Task 3: `server/knowledge-pack-install.mjs` —— 安装/卸载/导出引擎 + 清单读取

**交付物**
- `server/knowledge-pack-install.mjs`（全部函数收**注入的 `home`**，不自己解析 home）：
  - `packsRoot(home)` / `ledgerPath(home)` / `readLedger(home)` / `writeLedger(home, led)`（tmp+rename 原子）
  - `inspectArchive(buffer, { expectId }) → { manifest, files, errors, warnings }`
    （解压到内存前先全量校验：条目路径/扩展名/体积/条目数/CR；CRC 由 Task 1 兜）
  - `installPack({ home, archiveBuffer | srcDir, source = 'offline', mode = 'safe' })` →
    `{ status, packId, version, spaceId, files, conflicts?, backupPath? }`，5 态决策（§11.3 R3）
  - `uninstallPack({ home, packId })` → `{ ok, removed }`（删目录 + 清台账）
  - `listInstalledPacks(home)`（台账 ∪ 磁盘，供市场列表合并）
  - `exportSpaceAsPack({ home, spaceId, spaceRoot, meta })` →
    `{ ok, packJson, zipPath, zipBytes, manifestEntry, readme }`（落 `knowledge/exports/`）
  - `readLocalIndex(home)`（`packs-index.local.json`）+ `readIndex({ home, fetcher, registry })`
    （本地优先 → 远程；返回 `{ source: 'local'|'remote', packs, updatedAt }`）
  - `fetchPackDetail({ fetcher, registry, id })`、`fetchPackArchive({ fetcher, registry, id, version })`、
    `fetchPackVersions({ fetcher, registry, id })`
  - `resolveRegistry({ home, config })`（本地清单 > `config.knowledgePackRegistry` > `DEFAULT_PACK_REGISTRY`）
  - `buildDownloadUrl({ registry, id, version, file })`：**URL 由基址 + 已校验的 id/version 组装**，
    并断言结果与基址**同源**（spec §11.3 R2）
- `server/knowledge-pack-install.test.mjs`

**实现要点**
- **staging + 原子落盘**：解压到 `<home>/knowledge/.packs-tmp-<rand>/`，校验通过后 `renameSync` 到
  `packs/<id>`（对齐 `kernel/graph.mjs:130` 的 `.tmp → rename` 手法）；**任何失败路径都先 `rmSync` staging**
  （验收项 5 的"不留残留"就靠这一条 + 单测断言目录不存在）
- 覆盖（`updated` / `mode:'overwrite'`）：老目录 `rename` 到 `packs/.backups/<id>-<ts>`（**备份先于覆盖**），
  再落新目录；`.backups/` 里同 id 只保留最新 1 份（有界增长）
- `kept-user-modified`：逐文件比"磁盘现状哈希" vs "台账记录的安装时哈希"——**不一致才算用户改过**
  （不是拿新包内容当基准）；非空即返回 `conflicts` 且**一个字节都不写**
- `mode: 'to-my-space'`（第三选）：把包内容复制进 `knowledge/spaces/<slug>`（可写空间），
  同样走四重防护；不写台账（它不是 pack）
- **id 一致性**：`pack.json.id` 必须等于 `expectId`（在线路径的 `expectId` = 清单里的 id）；
  离线 zip 的 `expectId` = null 时以 `pack.json.id` 为准（但仍需过正则）
- `inspectArchive` 的**目录条目**只用于"父目录存在性"检查，不落空目录
- 依赖方向：`server → shared`（Task 1/2），**不 import kernel**
- 下载体积上限在 `fetchPackArchive` 里也挡一次（`Content-Length` 超限即拒，不读 body）

**验证**
- `node --test server/knowledge-pack-install.test.mjs`
- 用例：安装→空间可检索（用 `kernel/knowledge.mjs` 的 store 读临时 home，**同进程 import，不起子进程**）、
  5 态、备份存在、卸载清理、导出 round-trip、穿越/超限/无 license/可执行扩展名/symlink 条目各被拒
  且 staging 不存在、假 fetcher 驱动 `readIndex`/`fetchPackDetail`/`versions.json` 回退

---

### Task 4: 路由接线 + 既有契约守卫

**交付物**
- `server/knowledge-routes.mjs` 新增（**薄**：参数校验 + 调 Task 3 引擎 + 结构化错误）：
  - `GET  /knowledge/packs`（市场列表：清单 ∪ 已装台账，返回 `source`/`installedVersion`/`updateAvailable`）
  - `GET  /knowledge/packs/detail?id=`（`pack.json` + `README.md` + 版本兼容判定结果）
  - `POST /knowledge/packs/install`（`{ id, version?, localPath?, mode? }`——`localPath` 为 zip 或目录）
  - `POST /knowledge/packs/uninstall`（`{ id }`）
  - `POST /knowledge/packs/export`（`{ spaceId, id, version, license, author, repo, tags }`）
- handler 增可选参 `home`（缺省 `resolveYfwHome()`）与 `fetcher`（缺省 `globalThis.fetch`）——
  两者都**只被新路由使用**，既有路由行为不变
- `server/knowledge-routes.test.mjs` 追加新路由用例（注入 `home` = 临时目录 + 假 fetcher）
- `server/knowledge-packaging.test.mjs` 追加接线断言：bridge 的 `handleKnowledgeRoute({...})`
  调用点仍存在 + 新增 `container`/`home` 透传（源码级，防"实现写了但没接上"）

**实现要点**
- `localPath` 是**用户本机路径**（经 Electron 对话框选择），但仍要校验：`existsSync`、
  是 `.zip` 文件或目录、大小 ≤ 上限；**包内容一律按不可信处理**
- 错误码：`400`（参数/校验失败，带 `errors[]`）、`403`（用户改过且未指定 mode）、
  `404`（清单无此 id / 空间不存在）、`409`（版本不兼容无回退）、`413`（超限）、`500`
- 导出只允许**可写空间**（`writable:false` 的包空间导出无意义且易混淆）

**验证**
- `node --test server/knowledge-routes.test.mjs server/knowledge-packaging.test.mjs`
  （既有用例必须全绿——这是"不改既有行为"的第一道守卫）
- `npm run typecheck`

---

### Task 5: 前端 API 客户端

**交付物**
- `src/lib/knowledgePacksApi.ts`（与 `knowledgeApi.ts` 同风格：不 throw、`ApiResult`、可注入 `baseUrl`）
  - `listPacks()` / `packDetail(id)` / `installPack({ id, version, mode })` /
    `installPackFromFile(localPath, mode)` / `uninstallPack(id)` / `exportPack(meta)`
  - 类型：`KnowledgePackIndexItem` / `KnowledgePackDetail` / `PackInstallResult`
- `src/lib/knowledgePacksApi.test.ts`（假 fetch 断言方法/路径/请求体字段名）

**实现要点**
- 相对导入带 `.ts`（`node --test` 原生 TS 不支持 alias/补全，S2 教训）
- 写操作超时给宽窗口（安装要解压 + 备份，照 `WRITE_TIMEOUT_MS` 的先例）

**验证**
- `node --test src/lib/knowledgePacksApi.test.ts`

---

### Task 6: GUI —— 知识包市场视图 + 左栏入口 + 选择本地文件

**交付物**
- `src/components/knowledge/KnowledgeMarketView.tsx`（新建，≤ 400 行）：
  顶部「来源（本地清单/官方清单）+ 检查更新 + 从本地文件安装」；左侧清单（搜索框 + 标签过滤 +
  官方标识）；右侧详情（README 用 `react-markdown`、license、版本兼容状态、安装/更新/卸载/导出片段）；
  冲突态展示三选（覆盖/保留/另存为我的空间）；**已装/可更新**角标
- `src/stores/knowledgeStore.ts`：`KnowledgeView` 增 `'market'`（**有意扩展**）；
  `src/stores/knowledgeStore.test.ts:64` 期望改 5 视图并加注释说明"功能扩展"
- `src/components/knowledge/KnowledgeViewTabs.tsx`：`VIEW_META` 加 `market`（图标 `Package`）
- `src/components/knowledge/KnowledgeSidebar.tsx`：底部「发现知识包」按钮 → `setView('market')`
  （对齐原型 §1 的空间列表底部）
- `src/components/knowledge/KnowledgePanel.tsx`：`view === 'market'` 分支（**该视图不依赖当前空间**，
  故在 `!space` 空态之前短路，否则"没有空间"时进不去市场）
- i18n：`src/i18n/translations/zh-CN.ts` + `en-US.ts` 两份同步加键（缺一份即显示原始 key）
- 本地文件选择：照 `skills` 面板先例（`electron/main.cjs:905` `dialog:open-skill-package`
  → `preload.cjs:116` → `SkillsPanel.tsx:91`）：新增 IPC `dialog:open-knowledge-pack`
  （`openFile` + `.zip` 过滤），`preload.cjs` 暴露 `yfworkingFile.openKnowledgePack()`，
  `src/types/index.ts` 补类型

**实现要点**
- 详情里的 README **必须**沿用既有 markdown 渲染组件（无 `rehype-raw`、无 `dangerouslySetInnerHTML`）
- 非 Electron 环境（浏览器里跑 dev）要能降级：无 `openKnowledgePack` 时提示"仅桌面版支持本地安装"
  （照 `SkillsPanel.tsx:91-94`）
- 失败一律把后端 `error` 显示成一行提示，**不吞错**

**验证**
- `node --test src/lib/knowledgePacksApi.test.ts src/stores/knowledgeStore.test.ts`
- `npm run typecheck && npm run build`

---

### Task 7: 全量验收 + 报告

**交付物**
- spec §11 增「实施期偏差补记」（逐条列实施期新发现，照 S2/S3 格式）
- `.superpowers/sdd/2026-09-13-knowledge-core-S1/s4-report.md`：spec 复核结论、4 项决策生效默认值、
  实现清单与验证证据、**安全防护实测证据（穿越/校验不过/已存在 各一条）**、全量测试结果、
  期望值修正清单、自审发现、疑虑、**需人工走查清单**

**验证（全量）**
- `node --test "shared/**/*.test.mjs"` / `"server/*.test.mjs"` / `"kernel-tests/*.test.mjs"` /
  `"src/**/*.test.ts"`（+ `electron`）
- `npm run typecheck && npm run build`
- 安全实测（三条命令级证据）：恶意 zip（`../` 条目）被拒且 `packs/` 无残留；
  无 license 的包被拒；目标已存在且用户改过 → 返回 `kept-user-modified` 且**文件 mtime/内容未变**

---

## 附：任务依赖与派发顺序

```
Task 1 (zip 编解码) ── Task 2 (校验纯函数) ── Task 3 (安装引擎) ── Task 4 (路由接线)
                                                              └─ Task 5 (前端 API) ── Task 6 (GUI) ── Task 7 (验收/报告)
```

**可合并派发**：`1`（独立）；`2+3`（强耦合，`3` 直接消费 `2` 的判定）；`4`（守卫既有契约）；
`5+6`（前端一条链，`5` 的字段名由 `4` 定死）；`7` 最后。

**提交批次**：① 本文档 + spec §11 ② Task 1 ③ Task 2 ④ Task 3 ⑤ Task 4 ⑥ Task 5 ⑦ Task 6 ⑧ Task 7 报告。
