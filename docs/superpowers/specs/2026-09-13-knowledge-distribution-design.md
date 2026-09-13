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
