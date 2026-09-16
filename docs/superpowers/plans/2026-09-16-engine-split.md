# P1-6 拆 `engine.mjs` 实施计划

spec：`docs/superpowers/specs/2026-09-16-engine-split-design.md`

## 步骤

### S1 建 4 个新模块（按内聚提取，符号级不切行）
| 模块 | 内容 |
|---|---|
| `kernel/engine-config.mjs` | `envNonNeg`/`envHealMax`/`envRemindList`/`envFloat` + 全部 `PONOS_*` 常量 |
| `kernel/stream-runtime.mjs` | `addUsage`/`hasUsage`/`sleep`/`sleepAbortable`/`retryDelayMs`/`retryStream`/`withToolDeadline`/`applyAggregateResultBudget`/`rawAbortSignal`/`makeIdleWatchdog`/`adaptiveFirstByteMs` |
| `kernel/request-face.mjs` | `isRequestFaceCacheOn`/`isFidAnchorOn`/`withAnchorTail`/`trimOversizedRequestCopy`/`buildHistoryIndex`/`fitRequestToWindow`/`messageTextOf`/`patchOrphanToolUses`/`createRequestFace` |
| `kernel/gen-guards.mjs` | `normalizeEffort`/`isPlanTail`/`isThinkOnly`/`detectGenerationRepeat`/`isCodeLikeUnit`/`createNearRepeatDetector`/`canonicalToolCallKey` + 私有正则/辅助 |

**校验**：各模块 `node --check` ✓；`engine.mjs` 内同名定义 grep 0 命中。

### S2 engine.mjs 改为导入 + re-export
- 删除已外提的 1–770 行区间内对应块（**保留 1–53 行头注释**）
- 新增 import（只导 `createEngine` 实际用到的符号，由引用扫描确定）
- **re-export 原 17 个导出名**（`export { … } from './xxx.mjs'`）⇒ 外部导入方零改动

**校验**：导出名集合与改前逐一相同；`cli.mjs`/`compact.mjs`/kernel-tests 一行未改。

### S3 回归
`node --test kernel-tests/*.test.mjs` → 必须 **1647 / 1646 pass / 0 fail / 1 skipped**（与基线完全一致）。

### S4 守门演练
破坏新模块中的早退判据（如 `fitRequestToWindow` 的 `est(msgs) <= budget` 早退）→ 相应用例应变红 → 恢复回绿 + grep 无残留。

### S5 全量门禁
`npm run typecheck`、内核、`src/**/*.test.ts`（560）、`server/*.test.mjs`（522）。

### S6 同步调试版（**含 4 个新文件，易漏**）
`kernel/{engine-config,stream-runtime,request-face,gen-guards}.mjs` + `kernel/engine.mjs` → `release/YFWorking/kernel/`；
md5 逐一核对 + `diff -rq`（仅 `.env.example`）+ release 内加载探针；**重建 `kernel-dist/cli.mjs`**（`bun`）。

### S7 清单 + 经验
更新 `docs/待处理清单.md`：P1-6 **两个子项均完成**；注明 `createEngine` 闭包（~2200 行）留作独立一轮及其理由。
经验沉淀到 `workflow.md`。
