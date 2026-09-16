# 历史会话一键蒸馏到知识库 —— 实施计划

- 关联清单：`P1` 增加历史会话一键蒸馏到知识库功能
- 设计：`docs/superpowers/specs/2026-09-15-session-distill-design.md`
- 状态：见文末"执行记录"

## 步骤（每步含产出 + 验证方式）

| # | 步骤 | 产出 | 验证 |
|---|---|---|---|
| 1 | 纯逻辑层 | `src/lib/sessionDistill.ts`：字节工具（`utf8Bytes`/`truncateToBytes`/`fenceBlock`）、命名与路径（`sanitizeDistillName`/`conversationKey`/`distillRelPath`/`distillDocId`）、复用识别（`findDistilledEntry`）、空间选择（`pickDefaultDistillSpace`）、Markdown 生成（`conversationToMarkdown`）、计划（`planDistill`）、错误文案（`describeDistillError`） | `npx tsc --noEmit`（后续随 typecheck）；函数逐个被单测引用 |
| 2 | 纯逻辑单测 | `src/lib/sessionDistill.test.ts`：A1 全部边界（空会话/无正文/代码块含内层围栏/工具调用与结果/超长头尾裁剪/非法文件名/同名冲突 reuse/重复蒸馏幂等/中文按字节） | `node --test src/lib/sessionDistill.test.ts` 全绿（失败即改实现，不放宽断言） |
| 3 | 蒸馏对话框 | `src/components/rail/SessionDistillDialog.tsx`：加载全量正文（`loadConversationMessages`，空则回落内存 messages + `yfworking-chat-ext-`）→ 选可写空间（`useSpaces`）→ 目标目录 listTree 识别既有文件并取 mtime（`useDoc`）→ 预览（空间名/路径/docId/字节数）→ `saveDoc` 写入 → 409 冲突面板（覆盖走 `force`）→ 403/404/413 可读文案 → 成功后「在知识库中打开」 | `npm run typecheck`；（无 DOM 测试环境，交互走人工走查清单） |
| 4 | 列表挂点 + 文案 | `TaskListPanel.tsx` 行右键菜单加「蒸馏到知识库」并挂对话框；`src/i18n/translations/{zh-CN,en-US}.ts` 新增 `distill` 命名空间键 | `npm run typecheck`；`grep distill` 两语言键一一对应 |
| 5 | 门禁 | — | `npm run typecheck` 零错误 → `node --test src/lib/sessionDistill.test.ts` 全绿 → `npm run build` 成功 → `npm test`（串行、全量，与 build 不并发） |
| 6 | 同步 release | `release/YFWorking/`（`dist/` 产物 + 必要文件） | `diff -rq` 核验一致性 |
| 7 | 回写清单 | `docs/待处理清单.md`（**由主控统一勾选**，本计划不改该文件） | 不执行 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 列表会话正文不在内存（persist 剥 messages + 内存淘汰）⇒ 蒸出空文档 | 正文一律走 `loadConversationMessages(tailFirst:false,crop:false)`；返回空再回落内存 messages 与 `yfworking-chat-ext-<id>`；仍为空则**拒绝写入**并提示，不写空文档 |
| 展示级裁剪（`crop:true`）静默丢正文 | 加载显式传 `crop:false`，与 `chatExport` 同口径 |
| 覆写外部改动过的文件 ⇒ 数据无声丢失 | 复用既有文件时带 `mtime`；409 交用户决策；`force` 只在显式点击时传 |
| 标题含非法文件名字符（Windows `\ / : * ? " < > \|`、控制字符、结尾点/空格） | `sanitizeDistillName` 清洗 + 长度上限 48 字 + 空标题回落 `会话`；单测覆盖 |
| 标题改名后重复蒸馏产生第二份文件 | 复用识别按**会话键后缀**扫目标目录，命中即复用原路径 |
| 超长会话被服务端 413（>2MB） | 预算按**字节**算（600KB），头 70% + 尾 30% 裁剪 + 省略标记；单条消息/工具输出另有上限；单测断言 `bytes < 2MB` |
| 正文里的 ``` 围栏把生成结构撑坏 | `fenceBlock` 按文本内最长反引号串动态取围栏长度（CommonMark 规则） |
| 蒸馏内容含"当前时间" ⇒ 幂等破裂、每次全文覆写 | 内容只用会话自身时间戳（D14），单测钉住两次调用逐字节相同 |
| 目标空间只读（`pack-*`） | UI 不进候选 + 403 给可读文案（双保险，不复刻后端判据） |
| 直接调 `api.writeDoc` 绕过缓存失效 ⇒ "蒸了却看不到" | 写入只走 `useKnowledge.saveDoc()` |
| 无模型环境 | 全机械实现，不依赖 provider（A6）；`grep` 确认无 fetch/模型调用 |

## 执行记录（实际证据）

| 步骤 | 命令 | 真实结果 |
|---|---|---|
| 纯逻辑层单测 | `node --test src/lib/sessionDistill.test.ts` | **21 tests / 21 pass / 0 fail** |
| 既有逻辑层回归 | `node --test src/lib/dirPicker.test.ts` | **17 pass / 0 fail**（未受本改动影响） |
| 类型检查 | `npm run typecheck` | 零错误 |
| 构建 | `npm run build` | 成功，bundle `index-CQ6tfI4-.js` |
| 全量测试 | `npm test`（串行） | **EXIT=0 ｜ 2873 tests / 2872 pass / 0 fail / 1 skipped** |
| 同步 release | `cp dist/… release/YFWorking/dist/` | `dist` 与 `release` 的 `index.html` 均指向 `index-CQ6tfI4-.js`；蒸馏代码已在包内；`server/bridge.mjs` `diff` 一致 |

- 实施人：后台实现者子代理（产物已由我**独立复跑**上述命令验证，非采信其自述；子代理在跑自身门禁阶段被中止，以避免与我的 build/test 并发触发既有 Windows 临时目录 EPERM 假红）。
- 未决/未做：视觉观感（对话框在窄面板下的实际排版）属人工验收，测试只钉住逻辑与结构。
