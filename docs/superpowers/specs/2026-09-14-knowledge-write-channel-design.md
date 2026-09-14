# S6 设计：经验写入通道（append-only）+ tag 枚举 + 数据根合并

> 前序：S5/S5.1（知识库关联锚点、条目级图谱、捕获规则修正，已合并 main）
> 日期：2026-09-14
> 触发：用户反馈「agent 收发经验总是路径受阻（由于工具白名单限制），能否改由知识库路径直接提交并顺便关联，获取也改由知识库」

## 1. 问题定位（先纠正前提）

### 1.1 受阻的不是存储设计，是**写入通道缺失**

`kernel/tools.mjs` 存在刻意的不对称：

| 工具 | 边界 | 位置 |
|---|---|---|
| `readFile` | 会话目录 **+ 记忆目录**（`allowFiles`） | `tools.mjs:189` |
| `writeFile` / `editFile` | **仅**会话目录（无 `allowFiles`） | `tools.mjs:277` / `:291` |

且这是 **2026-09-10 的明确决定**，理由在代码注释里：

> `// 只扩只读工具：Write/Edit 仍锁会话目录（记忆写入走 memory.mjs 工具链与会话工作记忆维护，不允许任意覆盖）`

**该理由成立**（Write 是整体覆盖语义，一次失误可清空 74 条经验），**但它承诺的替代通道没有兑现**：

| 写入函数 | 现状调用方 |
|---|---|
| `appendMemoryEntry()` | 仅 workflow store 节点 |
| `captureMemoryCandidates()` | 仅轮末启发式自动捕获 |

⇒ **不存在 agent 可主动调用的写入口**。结果三重矛盾：
1. 系统提示要求 agent「用 Write 写 `memory/personal`」→ 被拒
2. agent 转用 Bash `>>`（`runShell` 只拦 `rm -rf /`、`sudo`、`curl|sh`）→ **绕过全部边界检查**
3. ⇒ 防护没生效（Bash 可绕），好路径也没提供（Write 被拒）；守规矩的 agent 直接放弃 → **经验静默丢失**

**结论**：真问题不是"换存储"，而是**缺一个语义安全的写入口**。

### 1.2 关键约束：索引是**纯派生数据**

`docs.jsonl` / `inverted.jsonl` / `related.jsonl` 全部由 `.md` 重建。故"直接提交知识库"只能理解为
**"经由知识库的写通道提交"，落盘仍是 `.md`**；把经验存进索引，一次 `reindex --force` 即全丢。

### 1.3 既有资产：HTTP 层已有带防护的写端点

`POST /knowledge/doc`（GUI 编辑器用）：整体覆盖语义，四道防护（`space.writable` 校验 / 路径穿越 /
symlink realpath / 写完增量重索引）。`experience` 空间 `writable: true`。
⇒ "走知识库提交"这条路**已通**，缺的是 agent 可达性与**追加语义**（现端点是覆盖）。

## 2. 本次范围（用户已定）

1. **写入**：新增 `--knowledge append`（append-only）+ `POST /knowledge/append`
2. **读取**：KB 发现（`search`/`related`/跨空间）+ 原文精读，并**补 `--knowledge tags`**
3. **工具边界一致化**：系统提示改为引导用 append（不再要求 Write 到记忆目录）
4. **数据合并**：`.ponos` → `.yfw`，范围 = `personal`(110) + `skill_experiences`(5)

## 3. 变更 A：`--knowledge append`

### 3.1 接口

```bash
node kernel/cli.mjs --knowledge append --tag 应用智控 --text "经验正文…"
node kernel/cli.mjs --knowledge append --tag 应用智控 --text -    # 从 stdin（长文本/多行）
node kernel/cli.mjs --knowledge append --text "无 tag 的经验"
```

HTTP：`POST /knowledge/append`，body `{ tag?, text, summary? }`

返回 `{ ok, id, theme, tag, deduped, lines }`；失败 `{ error }` + code 1。

### 3.2 落盘

复用 `appendMemoryEntry({ root, theme, tag, summary, full, graphStore, knowledgeIndex })` ——
它**已具备**幂等去重（`hashLine`）、增量索引同步（`syncKnowledgeIndex`）、graph 同步。
故本变更的核心是**在它前面加校验闸门**，不改其内部（既有调用方行为逐一不变）。

### 3.3 校验闸门（复用 S5.1 已修的规则，不另造一套）

| 闸门 | 判据 | 拒绝理由 |
|---|---|---|
| `PROTOCOL_TEXT_RE` | `/^(?:【\|执行技能\s\|用户回答：\|用户插话)/` | 协议/系统文本不是经验（S5.1 实测垃圾主源） |
| `isEmptyTemplateContent` | 空/仅标点/短标签+冒号/等于触发词 | 空模板无检索价值 |
| `MIN_LEN` | 有效字符 ≥ 20 | 太短无法参与关联（会被关联侧过滤，入库即成孤岛） |
| tag 合法性 | 非空时可含任意字符，但**不含** `]` `\|` 换行，长度 ≤ 40 | 否则破坏 `- [主题\|tag]` 行格式 |
| 幂等 | `hashLine` 已存在 | 返回 `deduped: true`，不重复写 |

**校验放在 append 路径，不放进 `appendMemoryEntry` 内部**：后者的既有调用方（workflow store 节点）
需要写任意内容，收紧其内部会静默改变既有行为。

### 3.4 主题（theme）决定

`--theme` 可显式指定；缺省按 `tag` 在既有文件中的归属推断，仍无则落 `workflow.md`。
**只允许既有文件名**（白名单），拒绝路径穿越。

## 4. 变更 B：`--knowledge tags`

```
{ tags: [ { tag, count, single, theme } ], total, singleCount }
```

**为什么必需**：`--knowledge` 现有 11 个 op 无 tag 枚举能力（`doc entries graph links reindex
related search spaces stats tree update-doc`）。而"复用既有 tag"是**避免新经验成孤岛**的关键——
缺此能力，agent 会不断制造新单例 tag（S5.1 实测：16/20 种 tag 只出现 1 次，正是孤立条目主源）。

`single` 标记 = 该 tag 只出现 1 次（写前看到它就该考虑换个 tag 或接受孤立）。

## 5. 变更 C：读取路径（不二选一）

**分工**：
- **KB 负责"发现"**：`search`（跨空间 / 关键词）、`related`（S5 关联跳转，"读一条→顺一跳继续读"）
- **原文 Read 负责"精读与普查"**：逐字核对、`tags` 普查

**三条硬约束（故不能把读取单一化到 KB）**：
1. **idf 在小语料退化**：分词是字符 bigram + idf；语料只有 1 个文档时 idf 全零 → `search` 返回空
   （S5.1 实测 `items=[]`）
2. **孤立经验永远搜不到关联**：单例 tag 条目无 `related` 边，只靠关联会系统性漏掉
3. **精读需原文**：`search` 返回片段，核对/改写必须读原文

## 6. 变更 D：工具边界一致化

改系统提示：**写经验用 `--knowledge append`**（不再要求 Write 到 `memory/personal`）。
**不解锁 Write 白名单**——原防护意图（不允许整体覆盖经验库）予以保留，append 从结构上满足它。
Read 已放行记忆目录，保持不变。

## 7. 变更 E：数据根合并 `.ponos` → `.yfw`

### 7.1 实测差异清单（`calib-merge-plan.mjs` / `calib-merge-3way.mjs`）

**⚠️ 勘察中发现第三根**（原判断只覆盖两根）：

| 根 | 角色 | personal 条目 | 索引 | 与另两根重叠 |
|---|---|---|---|---|
| `~/.yfw` | **应用当前根**（`YFWORKING_HOME`） | 64 | 有（今日 09:37） | **0%** |
| `~/.ponos` | 内核 CLI 默认根（`PONOS_HOME` 未设时） | 110 | 有（今日 07:13） | **92% 已被 `.yfworking` 覆盖** |
| `~/.yfworking` | **旧根 v1**（应用侧解析的 fallback） | **230** | **无**（知识库时代之前） | 与 `.ponos` 重叠 101 条 |

- 三根合计 404 行 → 去重后 **300 条唯一**，**零垃圾**（都是 agent 主动沉淀，未经自动捕获污染）
- `.yfworking` 独有且干净 **227 条**（148 种 tag）；`.ponos` 独有仅 **9 条**；`.yfw` 64 条全独有
- ⇒ `.ponos` 实为 `.yfworking` 的**子集**：只并 `.ponos` 会得到 9 条净新增 + 101 条与
  `.yfworking` 重复的内容，且**漏掉 227 条**（占全部独有经验的大头）。故合并范围需按三根重定（见 §10）

**已知副作用（用户已接受）**：三根 tag 几乎不重叠 ⇒ 合并后 tag 167 种、**单例 74%**
⇒ **孤立条目由 8 条（13%）升至约 124 条（41%）**。不调阈值（避免引入 6 倍弱相似边），
靠 S5.1 的**孤岛分区 + 图例**呈现。

### 7.2 迁移方式

1. **双侧备份**（`.ponos` 与 `.yfw` 各一份，带时间戳）
2. 按文件**追加**：`workflow.md` / `communication.md` 追加；`.yfw` 缺的
   `project-application.md` / `office-docs.md` 新建；`skill_experiences/` 整目录复制
3. 幂等去重（实测重复 0，但流程保留以防重跑）
4. 重建索引，校验条目数 / tag 数

### 7.3 落根一致性（**实测确认的真根因**，比初判更具体）

初判写的是"两套 home 解析口径不统一"。实测后确认真正的断点在 **Bash 工具的 env 白名单**：

| 环节 | 事实 |
|---|---|
| 应用侧解析（`server/yfw-home.cjs`） | `YFWORKING_HOME > CLAUDE_CONFIG_DIR > ~/.yfworking` |
| 内核 CLI 解析（`kernel/config.mjs`） | `CLAUDE_CONFIG_DIR > PONOS_HOME > **~/.ponos**`（**不认 `YFWORKING_HOME`**） |
| bridge 注入（`buildChildEnv`） | 设 `CLAUDE_CONFIG_DIR` + `YFWORKING_HOME` = `.yfw` ⇒ 内核子进程一致 ✅ |
| **Bash 工具（`kernel/tools.mjs` `childEnv`）** | 走 **ENV_WHITELIST**（S2-2 安全策略，防子进程窃取宿主密钥）→ `CLAUDE_CONFIG_DIR` 被剥离、`YFWORKING_HOME` 从来不在名单 ⇒ **agent 在 Bash 里跑 CLI 落到 `~/.ponos`** ❌ |

后果：agent 写进 `~/.ponos` 的经验，GUI（读 `.yfw`）**完全看不见** —— 从"路径受阻"变成"写进黑洞"。

**修法（两处必须同时到位，缺一无效）**：
1. `buildChildEnv()` **额外注入语义中性的 `PONOS_HOME`**（= `YFW_HOME`）
2. `ENV_WHITELIST` **放行 `PONOS_HOME`**

**为什么不直接放行 `CLAUDE_CONFIG_DIR`**：那是密钥目录名（内含 `auth.json`），放开等于削弱
S2-2 的原始防护；`PONOS_HOME` 只是一个目录路径，而 `HOME` 本就在白名单、`.yfw` 也可猜，
故放行它的代价最小，却让"内核子进程 / Bash 子进程"两条路解析到**同一个根**。
回归由 `kernel-tests/knowledge-root-consistency.test.mjs`（静态 + 行为双断言）钉住。

**另一处防呆**：`append` 在 `store.load()` **之前**采样"配置根是否存在"，不存在即拒绝写入
（`bad-root`）。因为 `appendMemoryEntry` 内部会 `mkdirSync(recursive)` —— 拼错一个字符的根
不会报错，只会**静默种出一棵没人找得到的树**（实测踩过：条目落到 `~/.ponos/workflow.md`，
真正的 memory 目录一个字节没变，返回值仍是 `ok:true`）。`load()` 自身会创建索引目录，
故这个检查必须抢在它之前、且必须在建 store 前返回（否则"拒绝"也带副作用）。

## 8. 验收标准

| # | 验收项 | 方式 |
|---|---|---|
| 1 | `append` 正常写入并可被下一次 load 检索到 | 单测 + 真进程 |
| 2 | 协议文本 / 空模板 / 过短 / 非法 tag 一律拒绝且**不落盘** | 单测 |
| 3 | 重复内容 → `deduped:true` 且文件不增长 | 单测 |
| 4 | append 后关联已计算（tag 边存在） | 单测 |
| 5 | `tags` 返回 count/single 且与文件实际一致 | 单测 |
| 6 | `append` 走 CLI **真进程**转发（防漏登记，S5 教训） | 真进程回归 |
| 7 | HTTP `POST /knowledge/append` 可用 | 路由单测 |
| 8 | 缺省路径行为不回归（既有 11 op 全绿） | 全量回归 |
| 9 | 合并后 `.yfw` 条目 = 64 + 110 + 5(skill 单独) | 命令 |
| 10 | 合并可回滚（双侧备份存在且校验） | 命令 |
| 11 | 全量测试 0 新增 fail | 命令 |

## 10. 实施结果（2026-09-14，已交付）

- 提交：`2f2e19e`（写入通道 + 枚举 + 落根）、`e2a77f3`（两处静默截断修正）
- 全量测试：**1893 / 1892 pass / 0 fail / 1 skip**（基线 1863）
- 合并：三根 → `.yfw`，新增 **236 条**（跨源去重跳过 104 条），`64 → 302`
- 备份：`~/.yfw/backups/memory-merge-20260914015914/`
- **实施中新发现并修掉两条静默截断**（详见 `s6-report.md` §3）：
  - `MAX_BLOCKS_PER_DOC` 200 → **2000**（合并后单文件 239 条，原上限静默丢尾部 ~48 条 ⇒ 文件 302 / 索引 254）
  - 条目级图缺省 limit → **1000**（原沿用文档级 200 且从头截，恰好吃掉刚合并的尾部经验）
  - 截断改为**出声 + 可观测**（`capBlocks` 收敛 + `console.warn` + `stats.blocksTruncated`）
- 修后实测：**文件 302 = 索引 302**；条目图 302 节点 / 766 边 / `truncated=false`；孤立 94（31%）
- **未处理（超范围，另议）**：`skill_experiences` 有两个归属 —— 技能读 `~/.trae-cn/memory/skill_experiences`（另一应用 home，18 个 JSON），而知识库 space 根是 `<home>/memory/skill_experiences`，且 `walkMd` 只索引 `.md` ⇒ 技能经验不参与知识库检索（该 space `docCount=1`，仅 README）。未擅自改动 `.trae-cn`

## 9. 非目标（YAGNI）

- ❌ 不解锁 Write/Edit 白名单（保留"不允许整体覆盖经验库"的原防护意图）
- ❌ 不让知识库索引成为主存储（派生数据，`reindex --force` 会重建）
- ❌ 不做 append 的并发锁（单行 `O_APPEND` 原子；真遇到再加）
- ❌ 不改 `idf` / 相似度阈值（S5/S5.1 已校准）
- ❌ 不迁 `.ponos` 的 session 与会话历史（非"经验"资产，本次范围外）
