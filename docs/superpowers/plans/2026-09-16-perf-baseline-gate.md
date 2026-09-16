# P1-7 最小基准门禁 实施计划

- spec：`docs/superpowers/specs/2026-09-16-perf-baseline-gate-design.md`
- 目标文件：`kernel-tests/perf-baseline.test.mjs`（新建，唯一新增代码文件）

## 步骤

### S1 建夹具与工具函数
- `makeBigHistory({turns})`：每 turn 4 条（user 起点 / assistant tool_use / user tool_result / assistant 文本），`chunk=1700` 字符填充。
- `median(fn, runs)`：取中位数（抗抖动）。
- `bytesOf(msgs)`：`Buffer.byteLength(JSON.stringify(msgs),'utf8')`。
- **验证**：临时打印夹具规模（1480 条 / ~1366KB / est ~390k）。

### S2 规模守卫 + 缓存生效（相对断言）
- 断言 msgs ≥1450、字节 ≥1.2MB、estTotal ≥350k（防夹具被改小导致空跑）。
- warm 中位数 ≤ cold 中位数 / 10。
- **验证**：`node --test kernel-tests/perf-baseline.test.mjs` 绿。

### S3 缓存开关相对断言（抓"缓存被静默关掉"）
- cache-on warm vs `PONOS_ESTIMATE_CACHE=0` warm，比值 ≥5。
- **最后必须 `delete process.env.PONOS_ESTIMATE_CACHE`**（`try/finally`，防污染同进程其他用例）。
- **验证**：绿；且这条正是旧红线抓不到的场景。

### S4 绝对耗时断言（宽松，只拦数量级劣化）
- cold <150ms、6×warm <60ms、findCutPoint <30ms、splitCovered <80ms、extractKeyInfo <30ms、assembleSummaryRequest <30ms。
- **验证**：绿。

### S5 线性度（防 O(n²)）
- 半量 vs 全量 cold 估算，比值 ≤3.2。
- **验证**：绿（实测 ≈2）。

### S6 反证演练（必做）
| 变异 | 期望 |
|---|---|
| 关掉缓存（env）跑到断言里 | S3 红（其余绿） |
| 夹具 turns 改小 | S2 规模守卫红 |
| 临时把 warm 阈值改成 0 | S2 红（证明断言活着） |
- 恢复后回绿 + grep 确认无演练残留。

### S7 全量门禁
- `node --test kernel-tests/*.test.mjs`（基线 1628 pass / 0 fail）、`src`、`server`、`npm run typecheck`。

### S8 同步调试版 + 清单
- `kernel-tests/` 不随包发布（仅 `kernel/` 进 release）→ 本次**无内核源改动**，故 release 无需同步；核对 `release/YFWorking/kernel/` 与 `kernel/` 仍一致即可。
- 更新 `docs/待处理清单.md` P1 段：P1-7 完成，附证据；条目仍不勾选（P1-5/P1-6 未做）。
