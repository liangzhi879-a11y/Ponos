# reviewer 异族模型对照实测报告（Task 4）

**日期**：2026-09-19
**计划**：`docs/superpowers/plans/2026-09-19-subagent-evidence-channel.md` Task 4
**裁决问题**：是否应将 `reviewer` 子 Agent 的默认 `model` 从"继承主会话（deepseek 族）"改为异族模型？

---

## 结论（一句话）

**本实测不支持改动默认值。** 异族模型（MiniMax-M3[1m]）在 13 个注入缺陷中命中 10.5 个（≈81%），
而现状对照组（deepseek 族）13/13 全中（100%）；异族组还**漏掉了唯一一个"必然崩溃"级缺陷**
（`sample-c` 的 `Buffer.split`），并在一处给出了**自相矛盾的错误修法**。

⚠️ **方法学限制（必读）**：n=3 样本 / 13 缺陷，样本由本方构造，非大样本统计。
故结论应读作"**在本实测条件下无收益且更差**"，**不能**读作"异族模型普遍更差"。
计划原本的立场是"不预设结论、先实测再改默认"——本实测履行了该立场，其产出是**维持现状**的决策依据。

---

## 实验设计

| 项 | 对照组（ctl） | 实验组（mmx） |
|---|---|---|
| 模型 | `deepseek-v4-flash`（= 现状：内置 agent `model: ''` → 继承主会话） | `MiniMax-M3[1m]`（异族，不同厂商） |
| 子 Agent | 内置 `reviewer` systemPrompt | 同一 `reviewer`（未改动内置定义） |
| 工具集 | Read / Glob / Grep / Bash / WebFetch / Skill（只读） | 同左（**逐字相同**） |
| Prompt | 逐字相同（见下） | 同左 |
| 样本 | `docs/superpowers/audits/samples/sample-{a,b,c}.mjs` | 同左 |
| 耗时 | ~100–330s/样本 | ~60–90s/样本 |

**唯一变量是模型**——这是本实验可解释性的关键。

### 协议环境隔离

两组各自使用**隔离的 `PONOS_CONFIG_DIR`**（`%TEMP%/ponos-{ctl,mmx}/`），其中 `settings.json` 的 `env` 块
分别注入对应 provider 的 `PONOS_BASE_URL` / `PONOS_AUTH_TOKEN` / `PONOS_MODEL`。
理由：`--model` 参数**不会**切换 provider（实测：只传 `--model` 时请求仍打到 `activeProvider` 的端点）——
必须同时改端点与模型 id，否则"对照"实为同端点同模型，实验无效。
→ 未改动用户的 `~/.yfw/config.json`；未打印/落盘任何 token 值。

### 样本与真值（注入缺陷）

样本为独立构造的小文件，**每条缺陷都有确定的触发输入**，便于客观计数：

| 样本 | 注入缺陷（真值） | 严重度 |
|---|---|---|
| `sample-a.mjs` | ① `paginate` 的 `slice(start, end+1)` off-by-one（多返一条且跨页重复） | 严重 |
| | ② `clampPage`/`lastPage` 的 `Math.floor(total/size)` 整除时多算一页 | 严重 |
| | ③ `clampPage` 只夹上界（负数/NaN 原样透传） | 中等 |
| | ④ 三函数均无参数校验 | 中等 |
| | ⑤ `size=0` 除零 → `Infinity` 使夹取失效 | 中等 |
| `sample-b.mjs` | ① `loadAll` 的 `forEach(async …)` 不等待 → 恒返回空数组 | 严重 |
| | ② `saveQuiet` 空 `catch` 静默吞错 | 中等 |
| | ③ `loadAll` 无 `r.ok` 校验 | 中等 |
| | ④ `firstOk` 无 `try/catch` → 网络错误中断探测链 | 中等 |
| `sample-c.mjs` | ① `countLines` 的 `readFileSync(fd)` 返 Buffer 却调 `.split()` → **必然 TypeError** | 严重 |
| | ② `countLines` 无 `try/finally` → fd 泄漏 | 严重 |
| | ③ `sum` 的 `reduce` 无初值 → 空数组抛错 | 严重 |
| | ④ `firstMatch` 的 `i <= list.length` 越界 → 返回 `undefined` 而非 `null` | 严重 |

---

## 结果

| 样本 | 对照组 ctl（deepseek） | 实验组 mmx（MiniMax） |
|---|---|---|
| a | **5 / 5** | 4.5 / 5 |
| b | **4 / 4** | 4 / 4 |
| c | **4 / 4** | **2 / 4** |
| **合计** | **13 / 13 = 100%** | **10.5 / 13 ≈ 81%** |

### 实验组的三处实质问题

**1. 漏掉唯一"必然崩溃"级缺陷（`sample-c` ①）——最严重**

对照组的原文：

> **1. `countLines`（第 6、8 行）：读了 Buffer 却调用 `split`，任何调用必抛 `TypeError`**
> ……`Buffer.prototype` 上不存在 `split`（**已以 Node v24.14.1 实测** `typeof Buffer.prototype.split === 'undefined'`）

MiniMax **完全未提**这一点，反而把 `split('\n')` 当成可正常运行的代码，
在其上讨论"空文件返回 1 应为 0""尾随换行少计一行"等**行数语义**问题——
即**在一个跑不起来的前提上做细致推理**。它还同时讨论了"大文件 OOM"。
诊断层次看，它没有识破"该函数任何调用都崩"。

注：对照组不仅报了，还**用 Bash 实测**了 `Buffer.prototype.split === undefined`。
两组工具集相同（都含 Bash），差异不在能力而在**是否去验证**。

**2. 给出自相矛盾的错误修法（`sample-a` ②）**

MiniMax 原文：

> `total = 10, size = 10`，实际只有 1 页（第 0 页），但 `lastPage` 返回 `1`
> ……建议：`return Math.ceil(total / size)`；`total = 0` 时返回 `0`

它**正确诊断**出"返回 1 是错的"（应指向第 0 页），但建议的 `Math.ceil(10/10) = 1` **仍返回 1**，
即修法与其自己的诊断矛盾。对照组的修法是正确的：

> 改为 `Math.max(0, Math.ceil(total / size) - 1)`（或 `Math.floor((total - 1) / size)`……）

**3. 覆盖不全（`sample-c` ③）**：MiniMax 通篇未提及 `sum` 函数（`reduce` 无初值）——属整块遗漏。

### 实验组的优势（客观记录）

- **速度**：60–90s vs 对照组 100–330s/样本（约 2–3×），token 消耗也更低（5.4k–5.9k tokens）。
- `sample-b` 追平（4/4），且对 `loadAll` 竞态顺序、`firstOk` 响应体未消费等**次级问题**的展开更详细。
- `sample-a` 的 ③④⑤ 均命中，缺陷密度识别能力正常。

---

## 裁决

**维持现状：不改 `reviewer` 默认 `model`。**

依据：
1. 本实测中异族组命中率更低（81% vs 100%），且**漏掉最致命缺陷**——审查场景下漏一个"必崩"缺陷，
   比多报三个轻微问题代价大得多。
2. 实验组出现"自相矛盾的错误修法"，说明其输出需要额外复核成本——对一个**审查者**角色而言，
   低可信度本身就是负价值（审查者若不可信，等于把复核成本转移给主 Agent）。
3. 计划原"不采纳"理由（`docs/superpowers/plans/...` 引 orchestration spec"本地单模型环境无第二模型可用"）
   **事实已不成立**——本机现有 5 个不同族端点。故该理由应更新；但**结论（不采纳）因本实测而仍然成立**，
   依据从"没有第二个模型"改为"实测无收益且更差"。

### 是否需要进一步验证（建议）

- 若要在生产上真正采纳"异族审查"，建议扩大样本（≥20 个真实改动、真值由人工确认）后复测；
  n=3 不足以支撑策略变更。
- 一个更有前景的**正交**方向（本次未测）：**同族但不同推理档位**、或**双审查者（同族+异族）取并集**
  —— 后者能覆盖单模型的盲区（如本次 MiniMax 漏掉的 `Buffer.split`），代价是 2× 成本。
  这比"换掉 reviewer"更符合"审查者价值在于不漏"的定位。

---

## 复现方式

```bash
# 1) 样本与真值见 docs/superpowers/audits/samples/（3 个文件）
# 2) 夹具（直接拉起 reviewer 子 Agent，绕过主 Agent）
node docs/superpowers/audits/run-reviewer.mjs --model <model-id> --sample <a|b|c> --out <out.txt>
# 3) 需要隔离的协议环境：PONOS_CONFIG_DIR 指向含 settings.json(env 块) 的目录
#    —— 注意 --model 不切 provider，必须同时在 env 中给对应 baseUrl/token，否则对照无效
```

原始输出：`%TEMP%/mmx-{a,b,c}.txt`（实验组）、`%TEMP%/ponos-{ctl,mmx}/out*.jsonl`（早期 CLI 试跑）。

---

## 附带产出：新交付功能的端到端实证

本次实验的输出中可见 Task 1–3 交付的证据面功能在**真实模型调用**下生效（夹具 stdout 原样）：

```
已读文件（1）：C:\Users\T203-15\yfworking\docs\superpowers\audits\samples\sample-a.mjs

过程记录：C:\Users\T203-15\AppData\Local\Temp\ponos-t4-Rwcbx6\projects\...\8bf30ead-....jsonl（需要细节用 Read offset/limit 展开，勿让子 Agent 复述）
```

即：主 Agent 侧确实拿到了 `reads` 清单与 `transcriptPath` 过程入口——
这是对本次代码交付（`{5e68de5, 9fe5407, f33d28a, fbebede, 37c64e2}`）的**真实链路验证**，补足了单测无法覆盖的端到端一环。

## 清理

- 本次创建的全局配置 `~/.yfw/agents/reviewer-cross.md` **已无必要**（该 agent 未被 ACP 会话识别，
  且结论是维持现状）——**待用户确认后删除**。
- 隔离环境 `%TEMP%/ponos-{exp,ctl,mmx}` 与输出 `%TEMP%/mmx-*.txt` 为临时文件，可随时删除。
