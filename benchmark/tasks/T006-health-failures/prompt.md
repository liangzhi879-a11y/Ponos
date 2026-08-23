# 任务：补全健康分「连续压缩失败」因子的单元测试

这是 Ponos-turbo 内核（Node ESM 净室项目）。`kernel/health.mjs` 的 `computeHealthScore()` 是多因子健康分纯函数，其中包含「连续压缩失败」因子：

```js
score += Math.min(3, failures) * 10   // 每次失败 +10，封顶 3 次
```

但 `server/health.test.mjs` 现有测试**没有覆盖该因子的专项断言**——这是测试盲区。

## 任务要求

在 `server/health.test.mjs`（或同目录新建测试文件）中补充针对 `failures` 因子的单元测试，覆盖：

1. **无失败**（`failures: 0`）：不产生额外加分（与其他因子基线一致，可断言 `score` 等于基线）；
2. **1 次失败**：相对基线 **+10**；
3. **3 次失败**：**+30**；
4. **封顶**：4 次及以上失败仍 **+30**（`Math.min(3, failures)` 语义，不超上限）；
5. 失败因子**不影响档位判定逻辑本身的正确性**（例如：baseline 全绿时少量失败不把档位推红，除非达到阈值——按现有 `score >= 70 → red` 规则自然成立，测试只需断言不越界）。

**注意**：为使测试独立于其他因子，调用 `computeHealthScore` 时其余因子传基线值（如 `compactCount: 0, chainDepth: 0, remainingPct: 100, remainingTurns: 99`），只变化 `failures`。

## 验收标准

运行 `node --test server/health.test.mjs` 全部通过（含既有测试，不得回归），新增测试确实断言了 failures 因子行为。

## 要求

- 只修改测试文件（`server/health.test.mjs` 或同目录新建），**不得改动内核源码**。
- 遵循项目测试风格（node:test + node:assert/strict）。
- 不要改动无关文件。
