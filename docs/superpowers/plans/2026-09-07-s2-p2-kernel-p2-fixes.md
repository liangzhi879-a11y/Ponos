# S2-P2：内核次要项计划（#8 子 lane 摘要只累 text、#9/#10 取舍评估）

> **For agentic workers:** 本计划混合两类任务：Task 1（#8）为**可完整执行**的修复任务（TDD）；Task 2（#9）为"维持现状 + 注释/文档明示"的小任务（改动小但须落地）；Task 3（#10）为**决策型**——带【推进标注】，推进前须按标注补全后再实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 处理外部审计 P2 次要项——#8 子 lane 文本摘要不再混入 thinking（与主循环一致只累 text）；#9 流重连文本重复按审计"接受"取舍维持现状并注释/文档明示；#10 子 lane 是否补 R3-2 失败自愈与⑤同工具提醒，评估后决策并落地。

**Architecture:** 修复/注释落在 `C:\Users\T203-15\ponos-dev`（HEAD 锚点 `1b350c5`，以锚点研究报告为准）。#8 锚点：子 lane `engine.mjs:1080-1082`（`text || thinking` 都累进 textBuf）对照主循环 560-566（text 才进 textBuf、thinking 只进 genWindow）；#8 的修正面 = `textBuf` 用途（lane 返回 `{ usage, text: textBuf }` → 任务通知/登记 summary）。#9 为 api.mjs 重连实现的取舍注释。#10 依赖子 lane 现状（无 R3-2/⑤，有 ③③b 自愈与 P0/P1 已镜像守卫）。

**Tech Stack:** Node >= 18 ESM、node:test、mockStream（PONOS_MOCK_API=1）。

## Global Constraints

- 执行目录：`C:\Users\T203-15\ponos-dev`（branch main；每任务独立 commit）
- 锚点研究权威文件：`C:\Users\T203-15\yfworking\.superpowers\sdd\2026-09-07-s2-kernel-p0-fixes\s2p1-anchor-research.md`
- hermetic 纪律同 S2-P1；既有 mock 分支零改动；全量回归 `node --test "server/*.test.mjs"`
- **#9 明确不改行为**：只加注释与文档明示；任何想改半截文本处理的方案须先写评估（见 Task 2 Step 3），不得在未征询前实施
- **#10 决策门**：Task 3 实施前须完成成本评估并把决策记录进计划文档；若判定"不移植"须写明理由（研究 §5a/§5c/§5d + §4 子 lane 现状为评估输入）

---

### Task 1: #8 子 lane 摘要只累 text（thinking 不再混入任务通知/摘要）

**Files:**
- Modify: `kernel/engine.mjs`（`runSubAgentLoop` textBuf 累加，约 1080-1082）
- Modify: `kernel/api.mjs`（mockStream：追加产 thinking+text 流的 lane marker——按 api.mjs 实际结构）
- Test: `server/engine-lane-summary.test.mjs`（新建，镜像 lane-trunc harness）

**Interfaces:**
- Consumes: 主循环 text/thinking 分流（`engine.mjs:560-566`：text 才 `textBuf += chunk.text`，thinking 只进 genWindow + wire.assistant）；子 lane 现累加（1080-1082：text 与 thinking 都 `textBuf += chunk.text` + genWindow）；textBuf 的消费链（1166 `{ usage, text: textBuf }` → runLaneExecution 1194 → 任务通知/登记 summary）
- Produces: 子 lane 的任务通知/登记文本只含 text 内容、不含 thinking 内容（thinking 仍参与 genWindow 供 ③ 检测与转录）

- [ ] **Step 1: 读现状与 mock 结构（只读）**

读 `engine.mjs:555-570`（主循环 text/thinking 分流 verbatim）与 `engine.mjs:1075-1090`（子 lane 现累加）确认差异；读 `kernel/api.mjs` mockStream 是否已有产 `{ type: 'thinking', text }` 的既有分支（Grep `'thinking'`），无则按既有 marker 结构追加一个 lane marker（如 `[mock:lane-think]`）：首轮产 `thinking` chunk（唯一文本『子任务内部推理：不应出现在摘要的思考X』）+ `text` chunk（『子任务正式回答：应出现在摘要的文本Y』），并正常完成。报告记录实测结构。

- [ ] **Step 2: 写失败测试**

新建 `server/engine-lane-summary.test.mjs`（makeEnv 同 lane-trunc）：
```js
// 子 lane 摘要只累 text（审计 #8）：thinking 不混入任务通知/登记的摘要文本。
test('子 lane：任务通知摘要含 text 不含 thinking', async () => {
  const env = makeEnv()
  try {
    const r = await env.engine.runTurn({ content: '[mock:agent-lane-think]' })
    // 主线程返回文本只含正式回答
    assert.ok(String(r.text).includes('正式回答：应出现在摘要的文本Y'), `主线程文本应含 text，实际：${String(r.text).slice(-300)}`)
    assert.ok(!String(r.text).includes('不应出现在摘要的思考X'), '主线程文本不应含 thinking 内容')
    // 任务通知的摘要同样不含 thinking
    const notif = env.events.find((e) => e.type === 'system' && e.subtype === 'task_notification')
    assert.ok(notif, '应有 task_notification')
    const notifText = JSON.stringify(notif)
    assert.ok(!notifText.includes('不应出现在摘要的思考X'), `任务通知不应含 thinking，实际：${notifText.slice(-300)}`)
  } finally { env.cleanup() }
})
```
> marker 名与断言文本以 Step 1 实测的 mock 追加为准；测试意图不变：通知/摘要文本 = text 内容，不含 thinking。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-summary.test.mjs`
Expected: FAIL —— 修复前 textBuf 混入 thinking，断言 `!includes('不应出现在摘要的思考X')` 失败。

- [ ] **Step 4: 生产代码修复**（engine.mjs runSubAgentLoop）

把约 1080-1082 的累加改为镜像主循环分流（text 进 textBuf；text 与 thinking 都进 genWindow）：
```js
          if (chunk.type === 'text') {
            textBuf += chunk.text
            genWindow = (genWindow + chunk.text).slice(-400)
          } else if (chunk.type === 'thinking') {
            genWindow = (genWindow + chunk.text).slice(-400) // thinking 参与③检测窗，不入摘要
          }
```
> 若子 lane 的 thinking 另有消费点（如转录/日志），确认该消费点不受影响（只改 textBuf 语义）。不得改动 ③/③b 检测对 genWindow 的既有使用。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-summary.test.mjs server/engine-lane-trunc.test.mjs server/subagent.test.mjs`
Expected: PASS（新增 + 子 lane 既有零回归）。

- [ ] **Step 6: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/engine.mjs kernel/api.mjs server/engine-lane-summary.test.mjs && git commit -m "fix(kernel): 子 lane 摘要只累 text，thinking 不再混入通知/登记（审计 #8）"
```

---

### Task 2: #9 流重连文本重复——维持现状 + 取舍注释与文档明示

**Files:**
- Modify: `kernel/api.mjs`（重连实现处的取舍注释——Grep 定位 retry/重连代码）
- Run only：无行为改动

**Interfaces:**
- Consumes: 审计 #9 原判——"流重连文本重复"为**已注明接受的已知取舍**（设计 §12 P2 #9："审计已注明'接受'…维持现状并在代码注释/文档明示（可选：engine 层半截文本处理改进，评估后再定）"）
- Produces: 取舍在代码注释与计划文档双处明示；未来工程师不误判为 bug 去"修"

- [ ] **Step 1: 定位重连实现（只读）**

Run: `cd C:/Users/T203-15/ponos-dev && grep -n "retry\|重连\|重试\|reconnect" kernel/api.mjs | head -20`，读命中处的重连循环/文本追加逻辑，确认"半截文本在重连时可能重复"的确切代码位置（若在 engine.mjs 同理处理）。

- [ ] **Step 2: 加取舍注释**

在重连/文本续接的关键位置加注释（中文，风格对齐文件现有注释）：
```js
      // 已知取舍（审计 #9，2026-09-07 复核维持现状）：断流重连时若上一段文本已部分输出，
      // 重试可能重复半截文本。审计与产品取舍均判定"接受"——重试正确性优先于输出去重；
      // 若要改进（engine 层半截文本去重）需先做真实断流复现与评估，勿无评估直接改此处。
```
（注释位置与措辞以实际代码为准，意图 = 明示这是有意的取舍。）

- [ ] **Step 3: 文档明示 + 评估注记**

在本计划文档"执行记录"区记录：#9 维持现状、注释已加于何处；"半截文本处理改进"的评估前提（真实断流复现、重复对下游摘要/转录的实际影响度量）留作后续开放项，不阻塞 S2 基线。

- [ ] **Step 4: Commit**

```bash
cd C:/Users/T203-15/ponos-dev && git add kernel/api.mjs && git commit -m "docs(kernel): 流重连半截文本重复取舍注释明示（审计 #9 维持现状）"
```

---

### Task 3: #10 子 lane 补 R3-2 失败自愈与⑤同工具提醒——评估后决策落地

**Files:**
- Modify: `kernel/engine.mjs`（runSubAgentLoop：按决策加 R3-2 与/或 ⑤）
- Test: 决策落地项的配套测试（新建/追加，镜像 r3-guard.test.mjs 与 engine-guard-iter.test.mjs 的子 lane 版）

**Interfaces:**
- Consumes: 主循环 R3-2 失败自愈（`engine.mjs:745-766`，blocks.length===0 分支：hadToolError + guardInjections < maxGuardInjections 注入"请立即重试"）；⑤ 同工具提醒（`engine.mjs:801-816`，canonicalToolCallKey(blocks[0]) 连续计数 + REPEAT_REMIND_AT 注入提醒不 veto）；子 lane 现状（研究 §4：无 R3-2/⑤，工具结果只落 store；`if (blocks.length === 0) break` 在 P0-2 镜像之后约 1149）
- Produces: 决策（移植/不移植 + 理由）入档；若移植：子 lane 行为与主循环对齐且测试锁定

- [ ] **Step 1: 成本评估（只读，产出决策依据）**

读主循环 745-766（R3-2）与 801-816（⑤）及子 lane 1140-1167。评估点：
- ⑤ 移植：需 `canonicalToolCallKey`（模块级导出 333-345 可复用）+ lane 内 `subToolKey/subRepeatStreak/remindedAt` 状态 + blocks 非空时的计数注入（store.appendUser）。成本：低。价值：子任务内同工具打转提醒（防 token 浪费）。
- R3-2 移植：需 lane 内跟踪"上一批工具是否全败/含失败"（落 store 时已有 is_error 信息可复用）+ guardInjections 计数 + 在 `blocks.length === 0` break 前注入续跑。成本：低-中。价值：子任务"失败后纯文本收尾"被纠正为继续尝试——与 Task 1（#4 熔断）互补（熔断兜底"重试救不回"）。
- 相互影响：与 S2-P1 合入后的子 lane 守卫（熔断/溢出自愈/截断拒执）共用同一循环与 store 语义；⑤ 的提醒注入位置须在工具结果落 store 之后、熔断判定之前（对齐主循环 792-816 顺序）。
把评估结论（是否移植、各自理由、影响面、与既有守卫的交互）写入本计划"执行记录"区与 Task 报告。

- [ ] **Step 2: 决策征询**

若评估结论为"移植"或"部分移植"，在实施前把决策（移植范围、理由）通过问题卡片提交用户确认（#10 原审计措辞为"评估移植成本后决定"，决策权在用户）。若评估结论为"不移植"，同样记录理由并征询。**未经用户确认不得直接实施。**

- [ ] **Step 3: 按决策实施（决策已确认：R3-2 与 ⑤ 两项都移植——2026-09-07 用户裁决）**

【推进标注已补全——完整 TDD 步骤】只读评估备忘录：`sdd/2026-09-07-s2-p2-kernel-p2-fixes/task-3-assessment.md`（含当前树行号证据 A-F）。**行号一律以实施时实读为准。**

- [ ] **Step 3.1: 读主循环镜像源 + 子 lane 现状（只读）**

读主循环 verbatim：R3-2 注入块（runTurnInternal 内，评估定位 ~783-791：blocks 结果含失败时 hadToolError 且 guardInjections < maxGuardInjections → 注入"请立即重试"续跑指令）+ hadToolError/guardInjections 计数（~819-820 与 ~455-456，PONOS_GUARD_MAX）；⑤ 同工具提醒（~836-851：canonicalToolCallKey(blocks[0]) 连续计数 + REPEAT_REMIND_AT@65 命中注入提醒不 veto）。读主循环行为锁定测试 `server/r3-guard.test.mjs` 与 `server/engine-guard-iter.test.mjs` 的断言（R3-2 注入时机/文案、guardInjections 上限、⑤ 连续计数/复位/注入文案）作为 lane 版行为规格。读子 lane 现状（runSubAgentLoop：工具结果落 store ~1236、blocks.length===0 break ~1222、熔断判定 ~1244-1253、循环头状态区 ~1093-1095）。

- [ ] **Step 3.2: mock 追加（api.mjs，纯追加零改动既有分支）**

按评估备忘录建议 + 既有 lane marker 结构（`[mock:lane-melt]`/`[mock:agent-lane-melt]` 范本）追加：
- R3-2 lane 版：`[mock:agent-lane-heal]` spawner + `[mock:lane-heal-fail]`（lane 首轮产 is_error 工具结果，镜像 `[mock:guard-err]` 语义）+ 恢复分支（第二轮起成功，镜像 `[mock:guard-recovered]` 语义——once-flag 或轮次门控按既有 lane mock 约定）。
- ⑤ lane 版：`[mock:agent-lane-iter]` spawner + `[mock:lane-iter]`（lane 内连续 N 轮产同一工具调用，使同工具连续计数真实推进到 REPEAT_REMIND_AT 命中）。marker 名以实测/评估备忘录为准，测试与 mock 保持一致。

- [ ] **Step 3.3: 写失败测试（RED）**

新建 `server/engine-lane-heal.test.mjs`（makeEnv 镜像 lane-trunc harness；两层 env 冻结纪律同 S2-P1）。断言意图（以主循环测试为行为规格，措辞实测对齐）：
- R3-2：lane 工具失败轮后，历史/转录含系统续跑注入（"请立即重试"类文案）且 lane 继续执行到成功轮——而非失败后即以文本收尾；guardInjections 达上限后不再注入（走既有熔断收尾）。
- ⑤：lane 连续 N 次同一工具 → 提醒注入出现（含 REPEAT_REMIND_AT 命中语义）；成功/换工具 → 计数复位不再提醒。

- [ ] **Step 3.4: 跑测试确认失败**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-heal.test.mjs`
Expected: FAIL（R3-2 注入缺失 / ⑤ 提醒缺失——lane 现状失败轮无注入、同工具无提醒）。

- [ ] **Step 3.5: 生产代码修复（engine.mjs runSubAgentLoop）**

按评估备忘录插入点最小改动：循环头状态区（~1093-1095 后）加 lane 版 guardInjections/hadToolError 与同工具连续计数状态；工具结果落 store（~1236）后、熔断判定前镜像主循环顺序处理 ⑤ 提醒注入（store.appendUser，不 veto）；失败标志随每轮更新；`blocks.length === 0` break（~1222）前镜像 R3-2 注入（失败且有注入额度时先 appendUser 续跑指令再 continue/放行）。镜像主循环语义与文案，不改既有守卫（熔断/溢出/截断/③③b）逻辑。P1-11 在途批零触碰。

- [ ] **Step 3.6: 跑测试确认通过 + 回归**

Run: `cd C:/Users/T203-15/ponos-dev && node --test server/engine-lane-heal.test.mjs server/r3-guard.test.mjs server/engine-guard-iter.test.mjs server/engine-lane-trunc.test.mjs server/engine-lane-meltdown.test.mjs server/engine-lane-overflow.test.mjs server/engine-lane-summary.test.mjs server/subagent.test.mjs`
Expected: 全 PASS（新增 + 主循环 R3-2/⑤ 零回归 + 子 lane 全部既有零回归）。

- [ ] **Step 3.7: Commit（scoped staging）**

```bash
cd C:/Users/T203-15/ponos-dev && git commit -m "fix(kernel): 子 lane 补 R3-2 失败续跑注入与同工具提醒，对齐主循环（审计 #10）"
```
> 工作树纪律：engine.mjs/api.mjs 含 P1-11 在途批——严禁整文件 git add，逐 hunk scoped staging 只 stage 本任务改动；提交后 `git show --stat` 自证只含本任务文件；git status 确认在途批仍在。git add 文件清单按实改（engine.mjs、api.mjs、engine-lane-heal.test.mjs）。

若决策为不移植，跳过本步并把理由连同"未来何时值得重估"记入计划执行记录（本次决策 = 两项都移植，不适用）。

---

## 执行记录（S2-P2，已完成 2026-09-07）

起始 HEAD 37a8147（S2-P1 完结态）→ 完结 HEAD 030f0a2。每 task 独立 commit 直上 main + task-scoped 评审（均 Approved，0 Critical / 0 Important）。工作树纪律：全程逐 hunk scoped staging，P1-11 在途批（非 S2-P2 范围、用户裁决保留不动）零卷入、零触碰。

| Task | 审计项 | commit | 处置 |
|---|---|---|---|
| 1 | #8 子 lane 摘要只累 text | bf28829 | 修复：runSubAgentLoop textBuf 拆分流（text 才进 textBuf + genWindow，thinking 只进 genWindow——镜像主循环 ~580-586；③/③b 零扰动）；api.mjs 纯追加 `[mock:agent-lane-think]`/`[mock:lane-think]`；新测试 engine-lane-summary.test.mjs（RED thinking 混入 → GREEN 5 套件 19/19） |
| 2 | #9 流重连半截文本重复 | 57355f4 | **维持现状**（审计已注明接受）：kernel/api.mjs:768 R1-1 注释正上方 +3 行取舍注释（"接受"裁决、重试正确性优先、改进需真实断流复现与评估的护栏、2026-09-07 复核）。零行为改动 |
| 3 | #10 子 lane 补 R3-2 与 ⑤ | 030f0a2 | 评估（task-3-assessment.md：两项均低成本、无冲突、与熔断互补）→ **用户裁决：两项都移植** → 补全 TDD 步骤入档 → 修复：lane 版 R3-2（失败后注入续跑，guardInjections 额度）+ ⑤（连续同工具提醒不 veto）；新测试 engine-lane-heal.test.mjs（RED 3/3 → GREEN 8 套件 25/25） |

审计项最终处置：
- **#8 修复 + 测试锁定**（thinking 不再混入任务通知/登记摘要，仍参与 ③ 检测窗）。
- **#9 维持现状 + 双处明示**：代码注释（api.mjs:768 前）与本文档本记录。"半截文本处理改进"评估前提（真实断流复现、重复对下游摘要/转录的实际影响度量）留作后续开放项，不阻塞 S2 基线。
- **#10 两项都移植 + 测试锁定**（用户裁决；与 S2-P1 熔断互补：R3-2 给重试机会、熔断兜底；⑤ 防同工具空转，与 ③/③b 文本重复检测不重叠）。
- 既有红项：无。

已知开放项（deferred，供 whole-branch/final review 治理裁定，不阻塞本计划）：
- Task 1：通知无"summary 含 Y"正断言（补一行即锁正语义）；lane 门控位置前瞻（工具型 lane 需上移）；genWindow 两分支重复（镜像优先）。
- Task 2：计划文档明示已在本记录完成。
- Task 3：⑤ 换工具复位与 R3-2 hadToolError 门控两处测试判别缺口（实现经查正确、镜像主循环自身覆盖）；上限用例依赖 PONOS_GUARD_MAX 默认；plan-tail（isPlanTail）lane 镜像未做（范围克制，非遗漏）。
