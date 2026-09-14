# S5.1 实施计划：条目级图谱层级 + 引用接入（ref）+ 伪链接修复

> spec：`docs/superpowers/specs/2026-09-13-knowledge-relations-s51-design.md`
> 前序：S5（`69e149e` 已合并 main）
> 用户决策（两项）：① 图谱**加「层级」开关（文档/条目）**；② 显式引用**要**产生条目级关联，作为独立 `ref` 类型 + **修伪链接**。

## 任务清单（每步含验证方式）

| # | 任务 | 验证 |
|---|---|---|
| 1 | `extractLinks` 加 `index` + 两道防伪（代码跨度排除、目标形状校验） | 单测 4 例；真实库 `links.jsonl` 从 1 行垃圾 → 0 行 |
| 2 | `parseDocFile` 记录 `line`/`block`（把链接定位到**条目**） | 单测：链接所在条目的 `block` 值正确 |
| 3 | links 行增 `anchor`/`line`/`block`，并在**加载存量 links 时回填** `block` | 单测：重载索引后 ref 边不消失 |
| 4 | `buildRelations` 生成 `ref` 边（源=引用所在条目，目标=被引文档 top-`MAX_REF_RELATED`） | 单测：边数=3、目标全在被引文档、反向边存在 |
| 5 | 断链（`target=null`）零 ref 边 | 单测：`nope.md` → 0 条 ref 边 |
| 6 | `validateRelation` 加 `ref` 分支：只校验端点存在、**不比指纹** | 单测：指纹不符仍 true；content 边对照仍 false |
| 7 | `relRank` 插入 ref（tag > **ref** > content） | 断言被引文档内容变更后 ref 仍在（端到端） |
| 8 | `stats().related.refEdges` | 断言（既有 stats 断言同步补键） |
| 9 | `getEntryGraph`：节点=条目（带 `docId`/`line`）、边=tag/content/ref | 单测 2 例（条目级 + 文档级不回归） |
| 10 | CLI `--level` **三处登记**（parseArgs case / 转发 args / 内核 op） | **真进程**回归 3 例（含反向断言与非法值） |
| 11 | 路由 `?level=entry`（逐字判，不做自由透传） | GUI 走查 |
| 12 | 前端：`getEntryGraph` API + `useEntryGraph(enabled)` + `graphEntry` key | tsc + 单测 |
| 13 | `KnowledgeGraphView`：层级分段控件、三类边线型、entry 点击**定位到块** | tsc + 构建 + GUI 走查 |
| 14 | i18n（zh-CN / en-US）10 个新键 | 构建 |
| 15 | 修正 `stripTypePrefix` **误剥正文**（白名单） | 真实库实测：误剥 20 条 → 0 条；重校准阈值仍 0.15 |
| 16 | 补 `isEmptyTemplateContent` 判据④（旧行为曾靠"剥到首个冒号"的副作用） | `memory-hygiene` 全绿 |
| 17 | 全量回归 + tsc + build + `verify-knowledge-gui.mjs` | 命令 |
| 18 | 部署 `release/YFWorking/` + 报告 | 逐字节比对 |

## 范围外（YAGNI，spec §7）

条目级显式链接边、条目级聚类、ref 的反向条目级视图、改阈值/idf 口径。

## 关键纪律

- 改动集中在 worktree `C:/Users/T203-15/yfworking/.worktrees/knowledge-s1`，**不碰主目录**（有用户未提交改动）
- 新增 CLI flag **必须三处登记**（S5 的 `--doc`/`--related` 就漏在第二处，导致功能静默失效）
- 测试隔离：`mkdtempSync`，真进程走 `PONOS_HOME` + 清 `CLAUDE_CONFIG_DIR`
- 已知 flaky（与本项目无关，不得归因）：`app-tools-mount`、`reap-guard`、`stall-watchdog`、`pending-replay`
