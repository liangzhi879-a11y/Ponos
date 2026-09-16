# Spec：上下文失真健康 —— 以「准不准」为被测量的健康体系（2026-09-12）

## 背景与输入

目标：把现有上下文健康模块的**被测量**从"还能装多少"（容量/压力）换成"还准不准"（失真），
并使**弹窗建议只在失真过多时出现**；失真是可恢复的病因，因此弹窗动作要提供
「重新锚定（轻）→ 携带摘要新建会话（重）」两级。

用户四项定案（逐条约束下文设计）：

1. 首发病灶：**自洽性（自相矛盾 / 陈旧引用）+ 目标漂移 + 记忆失真（压缩丢/改事实）** 三类
   （行为失真「打转 / 说到做不到」本期未选，列入非目标）；
2. 成本：**允许在压缩点核对**（可复用压缩那一次模型调用，也可在压缩点追加确定性比对）；
3. 弹窗动作：**加入「重新锚定」两级动作**；
4. 本期范围：**只出设计文档（spec）先评审，不动代码**，但 spec 必须前后端一起覆盖。

### 现状实证（2026-09-12 源码核对）

| 层 | 现状 | 缺口 |
|---|---|---|
| 内核判定 `kernel/health.mjs` | `computeHealthScore()`（:21）输入全是容量代理：`compactCount` / `chainDepth` / `remainingPct` / `remainingTurns` / `failures`；`attentionCeiling = 0.8×win`（:17）；水位取 `requestTokens(lastUsage)`（:103）；`emitIfChanged()`（:125）按档位变化发事件；`tier` 三档由分数 ≥70 或 `remainingTurns<5` 强制红 | 无任何"上下文内容是否正确"的观测量；红档语义=快装不下 |
| 预测 `kernel/context.mjs` | `predictTurns()` 增长速率外推剩余轮数（L4-1） | 同样只描述容量 |
| 压缩 `kernel/compact.mjs` | 两阶段压缩；`landSummary()`（:524）落地摘要；`extractKeyInfo()`（:296）已确定性抽取 todos/files/decisions；会话工作记忆 `memory/session/<id>.md`（`kernel/cli.mjs:588` 轮末写入） | 摘要落地**没有任何保真校验**——丢了事实无从发现 |
| 内核装配 `kernel/cli.mjs:293` | `createHealth({ wire, model, contextWindow, env })`；compactor 装配 health（:297，压缩成功后 `health.recordCompaction` 单通道发 `ponos_summary`） | 无 fidelity 装配点 |
| 内核事件 `kernel/protocol.mjs:56` | `wire.health()` → `{type:'ponos_health', ...}`；`wire.summary()` → `{type:'ponos_summary'}` | 载荷无失真字段 |
| 引擎 `kernel/engine.mjs` | `turnStats.push({usage,lastUsage,durationMs,model,ts,compactCount})`（:2475）→ `health.record()`（:2490）；已有 `judgeUntil()`（:2367）小样本判定基础设施（loop --until / health judge 复用） | turnStats 不带"本轮说了什么/读了什么"的内容侧观测 |
| 桥 `server/bridge.mjs` | 内核 stdout 行整包透传：`send({type:'event', data: parsed})`（:1372）；`useYFWCLI.ts:678` 同时收 `ponos_health` 与 `yfw_health` | **无需改动**（新增字段自动透传），仅需更新契约文档 |
| GUI 血条 `src/components/chat/HealthMeter.tsx` | 宽度=`remainingPct`、颜色=`tier`、压缩次数双源取 max（:53）；脉冲闪一次 | 血条语义=压力，须保留 |
| GUI 提示卡 `src/components/chat/HealthSuggestCard.tsx` | `shouldShowRedAlert()`（`src/lib/healthUi.ts:19`，签名仅 `(health, dismissedUntil)`）只看 `tier==='red'`；动作只有 `handleNewSession()`（:30）＝停源会话 + 新建 + 可选携带摘要；dismiss 冷却 5 分钟（`healthStore.ts:35` `RED_DISMISS_MS`） | 无证据清单；无可原地修复的轻动作；红档**无回绿路径** |
| GUI 光晕 `src/components/chat/HealthGlow.tsx` | 压力红档给聊天区泛红光 | 与"指控"语义绑定，需换轴（见 §7.4） |

### 关键结论（决定本设计）

1. **压力与失真在统计上近乎不相关**：反复压缩但摘要保真的会话是"高压力、低失真"；水位仅 30%
   但摘要改错一个约束的会话是"低压力、高失真"。用容量指标触发质量结论，必然产生
   "已连续压缩 1 次，剩余约 15811 轮，建议开启新会话"这类自相矛盾的假红档（该 bug 的根因链
   已于 2026-09-11 修复，但其**结构性诱因**（被测量错配）本条设计予以消除）。
2. **失真可修复，压力只能重置**：失真弹窗必须提供"原地重锚"，否则用户唯一选择是重建会话、
   丢失全部上下文——这是当前设计最该补的动作面。
3. **信号强度不可加权求和**：用户纠错一次近乎确凿，而"输出重复度高"可能只是正常调试循环。
   把两者相加等于用噪声稀释强证据。故本设计采用**强证据直通 + 中证据累积**两路，而非单一分数。
4. **最强的真值来自用户与工具记录，不来自模型自评**：模型对"我是否失真"的判断本身就是可能
   失真的那一层。模型自评最高只能到中证据（amber，不弹窗）。

## 设计原则

1. **失真正交于压力**：压力轴保留为仪表（血条），**不再作为弹窗触发器**；失真是唯一弹窗触发器。
2. **强证据直通，中证据累积**：确定性真值（用户纠错 / 工具记录 / 文件系统 / 实体覆盖）可直通红档；
   启发式与模型自评只能推 amber。
3. **宁漏勿误**：压力档弹窗是提示（误报代价低），失真档弹窗是"指控"（等于告诉用户"我可能一直在
   胡说"）。故失真档默认健康、amber 不弹、不确定就不弹。
4. **证据可审计**：弹窗必须逐条列出证据（第 N 轮 · 类型 · 一句证据），否则用户只能"信或不信"，
   弹窗失去意义。
5. **修复优先于重建**：轻动作（重新锚定）在前，重动作（携带摘要新建会话）在后；两者都由用户点按，
   本期不做自动修复。
6. **去抖与半衰期**：同一证据 id 只弹一次；老证据随轮龄指数衰减；修复后必须能回绿（现有红档
   没有回绿路径，这在失真语义下是错的）。
7. **纯逻辑与 UI 分离**：检测与聚合全部在内核纯函数（`kernel/fidelity.mjs`），前端判定同样是
   纯函数（`src/lib/healthUi.ts`）；两侧都可 node 单测，沿用现有测试纪律。
8. **全程静默降级**：任一检测器异常都不得影响主流程（与 `health.mjs` 同款 try/catch 纪律）。
9. **契约纯增量**：老 GUI 忽略新字段；老内核无新字段时前端一律按 green 处理（默认健康）。

## 方案

### §1 失真度定义（可判定形式）

> **失真 = 上下文中的陈述，与可验证的外部真值（或上下文内部的自洽性）之间出现偏差。**

该定义把"失真检测"转化为"**采样核对**"，并给出信号可信度排序——**证据强度取决于真值从哪来**，
而不取决于模型自觉。

三轴（彼此独立计分，不做跨轴求和稀释）：

| 轴 | 语义 | 真值来源 | 检测器 | 成本 |
|---|---|---|---|---|
| **M 记忆保真** | 压缩后摘要是否丢/改了关键事实 | 被压缩原文（covered）+ 会话工作记忆 | D1 | 压缩点（低频，用户已批准） |
| **C 自洽性** | 上下文内部矛盾 + 与工具记录/文件系统冲突（含陈旧引用） | 上下文自身 + 工具结果（Read ENOENT 等） | D2 | 零模型成本 |
| **G 目标保真** | 当前工作是否偏离最初任务陈述 | 会话首条真实 user 消息 | D3 | 零成本 + 可选小样本 LLM 判定 |

**失真度 D** = 近 12 轮证据按轮龄衰减（`0.85^(轮龄)`）加权聚合到 0–100；**但强证据直通**（§3.3）。

档位：

- `green` D < 40 —— 不打扰（且**无证据时一律 green**，见原则 3）；
- `amber` 40 ≤ D < 70 或存在 ≥2 点中证据 —— 只改血条角标与 tooltip，**不弹窗**；
- `red` D ≥ 70 或存在任一强证据 —— 弹失真卡；带外参数：新证据 id（去抖）、非观察期。

### §2 证据条目（唯一数据形状）

内核与前端共用同一形状（内核产出、前端只读展示）：

```ts
interface FidelityIssue {
  id: string          // 稳定去抖键，如 'm:sum-3:path:src/a.ts'（同 id 不重复弹）
  axis: 'memory' | 'coherence' | 'goal'
  kind: 'summary-missing-entity' | 'stale-reference' | 'contradiction'
      | 'goal-drift' | 'user-correction'
  strength: 'strong' | 'medium'
  turn: number        // 产生该证据的轮次序号（用于文案"第 N 轮"）
  evidence: string    // 一句人话证据（≤120 字），直接展示给用户
  detail?: Record<string, unknown> // 机器可读细节（实体名/路径/两处取值），供展开区
  at: string          // ISO 时间
}
```

### §3 判定模型

#### §3.1 证据衰减与聚合

```
weight(issue) = strength === 'strong' ? 1 : 0.6
score         = clamp(round(100 × Σ weight × 0.85^ageTurns / Σmax), 0, 100)
```

窗口 `PONOS_FIDELITY_WINDOW=12` 轮；超窗证据移入"历史证据"（保留展示、不计分，供用户在
展开区回看"已修复的旧问题"）。同一 id 重复出现只刷新 `at` 与计数，不叠加分数（防单点刷分）。

#### §3.2 中证据计点

| 信号 | 计点 |
|---|---|
| 陈旧引用（同路径第 1 次） | 1 |
| 内部矛盾（同 key 冲突，1 对） | 1 |
| 内部矛盾（同一 key 在不同轮次对 ≥2 对） | 2 |
| 目标覆盖连续低于阈值（见 D3） | 2 |
| LLM 漂移判定为真（仅确定性命中后调用） | 1（上限 +1） |
| 摘要实体缺失率 0.2–0.4 | 2 |

≥2 点 → amber。

#### §3.3 强证据直通（不做加权）

| 强证据 | 判定 |
|---|---|
| **S1 用户纠错指向已压缩区间** | 用户文本命中纠错句式（"我说过 / 我前面说过 / 不是这样 / 我明明 / again / no, I said"）+ 纠错内容的关键实体出现在"已被压缩遮蔽"的区间内 → 直通红档（真值来自用户，误报率最低） |
| **S2 摘要关键实体缺失率 ≥ 0.4** | D1 的确定性比对结果（路径 / 数字 / 约束 / 决策类实体缺失占比） |
| **S3 与权威真值冲突** | 同 key 冲突且其中一处与"会话工作记忆 / 工具记录 / 文件系统"冲突（如引用一个 Read 报 ENOENT 的路径） |
| （S4，保守）**目标漂移双证** | 确定性覆盖命中 + LLM 判定也为"偏离"，且用户从未改过需求 → 直通（两路不同来源，避免单点误报） |

#### §3.4 弹窗门控

红档且满足全部条件才弹：

1. `trigger` 存在（强证据 id，或 D 分≥70 的归因项）；
2. 该证据 id 不在"已展示集合"内（去抖，随 `healthStore` 持久化）；
3. 不在 dismiss 冷却内（沿用 5 分钟）；
4. 不在观察期（重锚定后 3 轮，见 §5.3）。

#### §3.5 回绿与半衰期

- 无新证据 + 老证据衰减至 D < 40 → 自动回绿（**修正现有"红档无回绿"的设计缺陷**）；
- 重锚定后 → 证据标记 `resolved`（保留历史、退出计分）→ 立即回绿；
- **客观回绿（2026-09-16 补全）** → 该证据描述的实体被**工具成功读取**（真值优先级②）⇒ 标记
  `resolved` + `autoResolved` ⇒ 立即回绿；
- 观察期内同源证据再现 → 直通红档，且动作推荐从"重新锚定"升级为"新建会话"（锚定无效的证据）。

**为什么必须补客观回绿**：原设计的消解入口只有"重锚定上报"（`markResolved`）——即"锚点已在
模型侧生效"**没有任何通道回流健康度**。实测后果（kernel-stderr 38h 窗口）：red 期间锚点按
**证据轮龄**无差别重注，模型第 1 轮就复述恢复也照注满 11 轮；单会话最高 388 次注入 = 52%
的请求带锚点，连同每次强制的"先复述关键事实确认"，纯属多余消耗。

判据边界（严格守住铁律②"不信任模型自述"）：
- **只认工具记录**（`isError !== true` 的成功读取）；读**失败**恰恰说明实体仍不可达，不构成恢复。
- **绝不采信模型复述**：锚点文案自带缺失实体清单，拿复述当依据必然假绿，正好绕过"模型自评
  最高只到 medium"的保护。
- 逐实体核实（不做整档清空）；路径匹配双向兼容相对/绝对、但须落在路径分隔符边界（防同名
  不同目录误判）；人工路径 `markResolved` 完全不受影响，`autoResolved` 仅供审计与前端区分。

#### §3.6 复发必须可重复提醒（次数语义）

复发（`resolved` 后同源再现）在数据上不只一个布尔标记，还带**次数**（`recurredCount`，内核递增）：

| 状态 | 前端抑制键 | 效果 |
|---|---|---|
| 首次出现 | `<id>` | 提醒一次 |
| 第 1 次复发 | `<id>#recurred1` | **再提醒一次**（动作升级为新建会话） |
| 第 2 次复发 | `<id>#recurred2` | **再提醒一次** |
| 同一复发态未处理 | 同键重复 | 静默（不重复弹，避免"处理→仍报红→再弹"死循环） |

**为什么必须带次数**：抑制键若只到 `<id>#recurred`，第一次复发登记该键后，第二次及以后的复发会撞同一个键 → 静默，用户以为已解决而实际没有。**复发次数是"锚定无效"这一结论的强度指标**，必须逐次可见。

#### §3.7 失效依据必须随进程作废（快照生命周期）

失真证据只存在于**内核进程内**（不落盘），而 GUI 侧健康快照是**持久化**的；内核又只在档位**变化**时发 `yfw_health`（新进程初始即 green）。
故**内核进程变更**（重启 / 空闲回收后 resume）时，GUI 必须丢弃该会话的失真快照与失真 UI 状态（去抖键、冷却），**但保留压力档**（血条不瞬间回满）。
不清理就会留下"依据已过期"的假警报：红色卡片/角标/泛光一直赖着，且「关闭」只冷却 5 分钟、到期又冒出来。
去抖键随进程一并清空是对的——新进程首次发现同一证据应当重新提醒（对它而言是首次，不是复发）。

### §4 检测器

#### §4.1 D1 记忆保真（压缩点核对，成本已批准）

**时机**：`kernel/compact.mjs` `landSummary()` 落地前后（`cut.covered` 与 `summary` 都在手）。

**方法 A（确定性，默认开，零模型成本）**：

1. 从 `cut.covered` 抽取**关键实体**（`kernel/fidelity.mjs` `extractEntities()`，纯规则）：
   - 路径：Windows/Unix 路径、带扩展名文件名（`\S+\.(md|ts|tsx|mjs|py|xlsx|pdf|json|yml)`）；
   - 数字类：版本号、行号、比例/阈值/金额/日期、模型名；
   - 约束句：含"必须 / 不得 / 只能 / 默认 / 上限 / 禁止 / 仅"的短语（保留其关键实体词）；
   - 标识符：反引号内的函数名 / 命令名 / 工具名 / 参数名；
   - 复用 `compact.mjs:296 extractKeyInfo()` 的 todos/files/decisions 与
     `memory/session/<id>.md`（工作记忆）作为第二真值源。
2. 归一化后（去空白、全角转半角、大小写、路径分隔符统一、去 markdown 装饰）在 `summary` 中
   做子串 / token 集覆盖判定；
3. 产出 `{entities, missing[], ratio}`；`ratio = missing/total`（`total < 3` 时不判定，避免
   稀疏文本噪声）。

**方法 B（LLM 保真审计，用户已批准压缩点成本）**：

- 与"方法 A"互补：A 只能发现"字面丢失"，B 能发现"被改写"（如 MySQL→PostgreSQL）。
- 形态：**复用现有摘要请求的机制**，在摘要指令后追加一条极短校验子请求（同一压缩点、最多 1 次）：
  输入 = `covered` 摘要级摘录（头尾各若干条 + key-info 块）+ 落地的 `summary`；
  输出 = 严格 JSON `{"missing":[...],"rewritten":[...],"ok":bool}`。
- 成本与守卫：`maxTokens ≤ 512`；首字节看门狗 30s；失败**不计入压缩熔断计数**（避免压缩被
  审计拖死）；每次压缩最多 1 次；`PONOS_FIDELITY_LLM_AUDIT=1`（默认开，可关）。
- 结果只用于**补充证据**：`rewritten` 命中 → 中证据 2 点；`missing` 与 A 的差集 → 中证据 1 点。
  即"模型只能说还有问题，不能说没问题"——避免自评失真成为结论来源。

**产出**：`health.recordCompactionAudit(audit)` → 进证据流（S2 强证据或中证据）。

#### §4.2 D2 自洽性（零模型成本）

输入：`session.deriveMessages()`（`kernel/session.mjs:294`）近 12 轮 + 工具结果记录 + 工作记忆。

**陈旧引用（stale reference）**：

- 真值取自**工具结果**（最可信、零成本）：
  - `Read` 返回"文件不存在/ENOENT"而近 6 轮内 assistant 文本仍引用该路径 → 陈旧引用；
  - `Edit` 返回"文件已被修改/内容不匹配"而文本仍按旧内容推理 → 同上；
  - 本会话内该路径被 `Write`/`Edit` 修改过 ≥2 次（多版本），而当前轮引用未带最新版本/行号语境 → 弱信号，计 1 点。
- 同路径第 1 次计 1 点；第 2 次（不同轮）升级为 S3 强证据。

**自相矛盾（contradiction）**：

- 抽取 `(key, value)` 对（模板化 key：「路径 + 属性」「配置项名」「模型名 / 版本号」
  「数字 + 量纲 + 名词」），value 归一化；
- 同 key 出现互斥取值即冲突，**但排除显式演进**（"改为 / 更新为 / 已修正 / 换成 / 弃用"所在句
  的前后 1 句视为合法演进，不计矛盾）——这是本检测器误报的主要来源，必须过滤；
- 同 key 冲突在 ≥2 个不同轮次对 → 2 点；与工作记忆/文件系统取值不一致 → S3 强证据。
- **锚点权威轮豁免（2026-09-16 补，断自维持反馈环）**：锚点注入的那一轮（`markAnchorInjected`，
  由 engine 在**确实注入**时回报，节流跳过的步不回报）中，取值**出现在锚点文本里**的事实标记
  `authoritative`；矛盾检测中"较晚侧取值 = 该 key 的权威取值"即视为**复述锚点**（勘误），不计矛盾。
  豁免沿 key 传递（实测：只豁免注入轮那一条不够，第 2 轮起复述同一权威值会与压缩前旧自述
  重新配对、假失真延后 1 轮照样出现）。
  为什么必须豁免：锚点文案**要求**模型"先复述关键事实确认"——复述被当成新说法、与压缩前的旧
  自述冲突 ⇒ 判失真 ⇒ 分数被自己抬高、12 轮窗口被延长 ⇒ 招致更多锚定。实测该环使 `C` 轴
  白降 16 分。边界：按值判定、且模型改口成**非权威**取值照抓（注入锚点不是任意改口的免检牌），
  锚点未提及的其他 key 矛盾照抓，标记一次性消费（下一轮未注入则默认行为完全不变）。

**误报控制**：`C` 轴证据只在 amber 以上才触发可选 LLM 复核（冷却 300s，复用 `engine.judgeUntil`
基础设施），复核否定则降为"历史证据"不计分。

#### §4.3 D3 目标漂移

**真值**：会话首条真实 user 消息（`deriveMessages()` 首条 `role==='user'` 且非 tool_result）。

**两段法**：

1. **确定性（每轮）**：抽取首条任务的实体集合（路径 / 交付物名词 / 技术名词 / 动作动词），
   计算近 6 轮 user+assistant 文本对它的覆盖率（实体命中数 / 首条实体数）；
   连续 6 轮覆盖率 < `PONOS_FIDELITY_GOAL_COVERAGE_MIN=0.15` → 中证据 2 点。
2. **LLM 判定（低频）**：仅当确定性已命中 amber 才调用（`judgeUntil` 改造 target：
   `判定当前工作是否偏离最初任务，输出 {"drifted":bool,"reason":"…"}`，`maxTokens≤256`）；
   命中则 +1 点；两者同时命中 → S4 强证据。

**合法转向（关键误报控制）**：若用户在某轮显式改需求（"先放一放 / 改做 X / 换个任务"句式，
或新任务与旧任务实体零交集但由**用户发起**），则**锚点跟随用户更新**为最新任务陈述，
并重置 G 轴全部证据。**用户改需求不是失真。**

### §5 两级动作

#### §5.1 重新锚定（轻，主按钮）

- **锚点内容**（确定性拼接，不调用模型）：
  - 原始任务陈述（首条 user 消息，截断）；
  - 关键事实：D1 审计的 `missing[]`（标注"此前摘要遗漏，现已补回"）；
  - 文件变更 / 任务清单 / 最近决策：来自 `memory/session/<id>.md`（`compact.mjs` 工作记忆）；
  - 硬约束：D2 抽取的约束句；
  - 结尾一句行为指令："若与你记忆中的内容冲突，以上述事实为准；先复述关键事实确认，再继续任务。"
- **载体**：内核在 `distortion.anchorText` 中随事件下发（≤4KB 截断），GUI 展示**可预览可编辑**；
  确认后走既有 `useUIStore.setPendingInput(anchor, true)`（`src/stores/uiStore.ts:215` + autoSend）
  注入当前会话，作为一条可见 user 消息。
  - 一期选可见消息注入：**零协议改动、可见、可编辑、可回溯**；
  - 二期可选系统级注入（`--anchor` 子命令，抑制为 system 上下文），需协议扩展，本期不做。
- **触发后的内核通知**：GUI 调用新路由 `POST /session/anchor-applied`（`{sessionId, issueIds[]}`）
  → bridge 以 stdin `{"type":"anchor_applied","issueIds":[...]}` 注入内核 → `fidelity.markResolved()`。
  （若嫌新增路由，可退化为"点按后 3 轮内不弹"的纯前端观察期；见 §13 待确认项 2。）

#### §5.2 携带摘要新建会话（重，次按钮）

沿用现有实现（`HealthSuggestCard.tsx:29 handleNewSession`：停源会话 + 新建 + 可选携带摘要），
但触发条件换成失真红档；摘要来源仍是 `healthStore.summaryBySession`，并在携带文本前追加锚点块
（即"新建会话 = 锚点 + 摘要"），使新会话一开始就带权威事实，而非只带一份可能有损的摘要。

#### §5.3 重锚定后的观察期

`PONOS_FIDELITY_OBSERVE_TURNS=3`：观察期内不再弹红档（除非出现**新 id** 的强证据）；
观察期内同源证据再现 → 解除观察期、直通红档、动作推荐升级为"新建会话"。

### §6 契约

#### §6.1 内核 → GUI（`ponos_health` 事件，纯增量）

```json
{
  "score": 62, "tier": "amber", "compactCount": 3, "remainingPct": 41, "remainingTurns": 9,
  "suggestNewSession": false, "reason": "上下文接近压力区（水位 41%）",
  "distortion": {
    "score": 55, "tier": "amber",
    "axes": { "memory": 20, "coherence": 70, "goal": 0 },
    "issues": [
      { "id": "c:stale:src/a.ts:12", "axis": "coherence", "kind": "stale-reference",
        "strength": "medium", "turn": 12, "evidence": "第 12 轮仍在引用已被删除的 src/a.ts",
        "at": "2026-09-12T08:31:02.144Z" }
    ],
    "trigger": null,
    "observeUntilTurn": null,
    "anchorAvailable": true
  }
}
```

- `tier` 保持**压力语义不变**（血条继续用它）；失真档位一律读 `distortion.tier`。
  **两个 tier 含义不同，禁止互相赋值**（这是本契约最容易出错的一处）。
- `distortion` 为可选字段：老内核不发 → 前端按 green（默认健康）。
- `anchorText` 仅在 `distortion.tier === 'red'` 时随事件下发（避免每次事件携带 4KB 文本）。
- 老 GUI 完全忽略 `distortion`（JSON 增量，无破坏）。

#### §6.2 压缩点审计（内核内部）

`compactor` → `health.recordCompactionAudit({ atTurn, entities, missing, ratio, llm?: {rewritten, missing} })`；
由 health 统一转成 `FidelityIssue` 并入证据流（与"压缩摘要只发一次"的单通道纪律保持一致）。

#### §6.3 bridge

**无需改动**（`bridge.mjs:1371` 整包透传）。仅两处文档/清理：

- `docs/bridge-contract.md` 增补 `ponos_health.distortion` 字段表；
- 顺带修复既有缺陷：`bridge.mjs:1148` 注入 `YFW_HEALTH_COMPACT_COUNT`，而 `kernel/health.mjs:74`
  读 `PONOS_HEALTH_COMPACT_COUNT` —— **注入名与读取名不一致，seed 实际从未生效**（与
  `docs/bridge-contract.md:85` 的记载也不符）。建议内核侧双名兼容读取
  （`env.PONOS_HEALTH_COMPACT_COUNT ?? env.YFW_HEALTH_COMPACT_COUNT`），最稳且不动桥。

### §7 GUI 改动

| 文件 | 改动 |
|---|---|
| `src/stores/healthStore.ts` | `HealthInfo` 增 `distortion?: DistortionInfo`；新增 `dismissedDistortionUntilBySession`、`shownDistortionIdsBySession`（去抖，随 persist）、`anchorAppliedBySession`（观察期）；`reset()` 一并清失真态 |
| `src/lib/healthUi.ts`（纯函数） | 新增 `distortionState(health)`、`shouldShowDistortionAlert(health, dismissedUntil, shownIds)`、`anchorTextFrom(health)`、`mergeIssues(list)`；`src/lib/healthUi.test.ts` 补假红/假绿/去抖/回绿用例 |
| `src/components/chat/HealthMeter.tsx` | 血条语义不变（宽度=压力）；失真 amber 以上时在血条右端加**失真角标**（小三角 + 计数），tooltip 列 issues 摘要 |
| `src/components/chat/HealthSuggestCard.tsx` | 触发源改为 `shouldShowDistortionAlert()`；正文改为**证据清单**（逐条：`第 {turn} 轮 · {类型} · {evidence}`）+ 两级动作：主「重新锚定」（带锚点预览/编辑）、次「新建会话携带摘要」；保留最小化 / 关闭 / 冷却 |
| `src/components/chat/HealthGlow.tsx` | 泛光触发由"压力红"改为"失真红"（见 §7.4 待确认） |
| `src/i18n/translations/{zh-CN,en-US}.ts` | `health.distortion.*`：`redTitle`（按 axis 分支文案）、`axis.memory/coherence/goal`、`evidence.turn`、`reanchor`、`reanchorPreview`、`newSessionWithSummary`、`observePeriod`、`resolvedIssues` |
| `src/hooks/useYFWCLI.ts` | `ponos_health` 分支（:678）无需改（整包写入 store）；新增锚点应用后的 `anchor_applied` stdin 上行（若采纳 §5.1 的路由方案） |

§7.4 **红色泛光的归属**：现状"压力红 → 聊天区泛红光"把容量警示渲染成了质量指控。建议改为
失真红才泛光；压力红仅血条变色。待确认项 1。

### §8 参数表

| env | 默认 | 语义 |
|---|---|---|
| `PONOS_FIDELITY` | `1` | 总开关（0 = 完全关闭失真检测，事件不带 `distortion`） |
| `PONOS_FIDELITY_WINDOW` | `12` | 证据窗口轮数 |
| `PONOS_FIDELITY_DECAY` | `0.85` | 轮龄衰减底数 |
| `PONOS_FIDELITY_RED` / `_AMBER` | `70` / `40` | 档位阈值 |
| `PONOS_FIDELITY_SUMMARY_MISSING_STRONG` / `_MEDIUM` | `0.4` / `0.2` | 摘要实体缺失率分档 |
| `PONOS_FIDELITY_LLM_AUDIT` | `1` | 压缩点 LLM 保真审计（每压缩点最多 1 次，失败不计压缩熔断） |
| `PONOS_FIDELITY_GOAL_COVERAGE_MIN` | `0.15` | 目标覆盖阈值（连续 6 轮） |
| `PONOS_FIDELITY_OBSERVE_TURNS` | `3` | 重锚定观察期轮数 |
| `PONOS_FIDELITY_MAX_TEXT` | `200000` | 单轮参与检测的文本上限（截断，防性能退化） |
| 前端 | 5 分钟 | dismiss 冷却（沿用 `RED_DISMISS_MS`） |

### §9 验收

| 节 | 验收方式 |
|---|---|
| §1–§3 | `kernel-tests/fidelity.test.mjs`（纯函数）：证据衰减、同 id 不叠分、中证据→amber、四条强证据直通、**假绿**（无信号恒 green）、**假红回归**（复用 15811 场景：压缩刚落地瞬间不得弹失真红档）、回绿（证据过期后自动降档） |
| §4.1 | 摘要审计用例：摘要丢路径 → `ratio` 命中且 S2 直通；摘要完整 → `ratio=0`；`total<3` 不判定；LLM 审计失败不影响压缩落地与熔断计数 |
| §4.2 | 陈旧引用（Read ENOENT 真值）、同一 key 冲突、**显式演进语不计矛盾**（负例必测）、跨 2 轮对升级为 S3 |
| §4.3 | 目标覆盖：正常延续不报；偏离命中；**用户显式改需求 → 锚点跟随、证据清零**（关键负例） |
| §5.1 | `anchorTextFrom()` 纯函数单测：包含原始任务/缺失实体/约束；≤4KB 截断；不含密钥类文本（沿用 redact 纪律） |
| §6 | 事件契约：`distortion` 缺省时前端全绿；`tier` 与 `distortion.tier` 互不干扰（断言血条仍读压力档） |
| §7 | `src/lib/healthUi.test.ts` 扩展 + 人工清单：长会话 → 压缩 → 注入丢失约束 → amber（角标）→ 强证据 → 红档卡列证据 → 点重新锚定 → 3 轮内回绿 → 再现 → 升级建议新建会话 |
| 回归基线 | `node --test kernel-tests/*.test.mjs` + `npm test` 全绿（当前基线 236 + 292 量级） |

### §10 实施顺序（每步可独立验证、可回滚）

1. `kernel/fidelity.mjs` 纯函数 + `kernel/fidelity.test.mjs`（无接线，零行为变更）
2. `kernel/health.mjs` 装配 fidelity + `snapshot()` 增 `distortion`（事件已带字段，UI 未读）
3. `kernel/engine.mjs` 轮尾喂内容侧观测（本轮 user/assistant 文本、工具结果摘要、Read 失败）+ `kernel/cli.mjs` 装配
4. `kernel/compact.mjs` 压缩点审计（确定性 + LLM）与 `recordCompactionAudit`
5. GUI 纯函数与 store（`healthUi.ts` / `healthStore.ts` + 单测）
6. GUI 组件：失真角标 + 失真卡（证据清单 + 两级动作）+ i18n
7. `HealthGlow` 换轴、压力降级为仪表（弹窗触发器切换）
8. 收尾：假红/假绿回归、E2E 人工清单、`docs/bridge-contract.md` 与产品说明书更新

### §11 非目标（本期不做）

- **行为失真**：打转/重复输出检测、**"说到做不到"（声称已完成而工具记录无对应成功调用）**——
  用户本期未选。其判定思路记录在此备用：它是自洽性的自然延伸（声称 vs 工具记录），误报率低，
  适合作为二期首个增量。
- 自动修复（自动重锚 / 自动新建会话）——本期一律由用户点按。
- 语义级（embedding）一致性校验——不引入向量依赖与额外模型服务。
- 跨会话失真记忆与统计看板（本设计不落盘失真历史，仅进程内 + 前端 persisted 快照）。
- 云端/多机同步。

### §12 风险与对策

| 风险 | 对策 |
|---|---|
| **误报（最主要）** | 默认健康；amber 不弹；强证据才直通；用户改需求视为合法转向；矛盾检测过滤显式演进语；`total<3` 不判定 |
| **检测器自身失真** | 模型自评上限为"中证据"；强证据必须来自确定性真值（用户纠错 / 工具记录 / 实体覆盖比对） |
| 性能退化 | 实体抽取只在轮尾做且文本截断（20 万字符上限）；压缩点审计低频且最多 1 次调用 |
| 契约混淆（两个 tier） | 前端血条只读 `tier`，弹窗/光晕只读 `distortion.tier`，单测断言互不干扰 |
| 老内核 / 老 GUI 兼容 | `distortion` 为可选字段；缺省全绿（默认健康），不显示角标 |
| 长会话反复弹窗打扰 | 同 id 只弹一次 + 5 分钟冷却 + 观察期；`resolved` 证据移入历史区可回看 |
| 锚点注入自身污染上下文 | 锚点走可见 user 消息（用户可编辑可删）；长度 ≤4KB；不注入密钥类文本 |

### §13 评审待确认项

| # | 待确认 | 建议 | 影响面 |
|---|---|---|---|
| 1 | 红色泛光（`HealthGlow`）是否改由**失真红**触发（压力红仅血条变色） | 建议改——否则"压力红＝质量指控"的语义混用继续存在 | §7.4；一处组件触发源 |
| 2 | 重锚定生效是否新增 `POST /session/anchor-applied` 上报内核 | 建议新增（代价小，内核可即时 `markResolved` 并回绿；不新增则退化为纯前端观察期） | §5.1；bridge 一条路由 + 内核一个 stdin 子命令 |
| 3 | 压缩点 LLM 保真审计（§4.1 方法 B）默认开还是默认关 | 建议默认开（用户已批准压缩点成本；方法 A 只能发现字面丢失，发现不了"被改写"） | §4.1、§8 |
| 4 | "说到做不到"（声称已完成 vs 工具记录）是否本期并入 `C` 轴 | 建议留二期（用户本期未选；但它是自洽性的自然延伸，误报率低） | §11 非目标调整 |
| 5 | 失真证据是否落盘（transcript / 独立日志） | 建议不落盘：仅进程内 + 前端 persisted 快照；落盘会引入"历史失真"被误读为当前状态的风险 | §6.1、§7 |

