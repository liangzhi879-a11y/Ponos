# 任务：修复工具结果 JSON 形态结构裁剪的三缺陷

这是 YFW-turbo 内核（Node ESM 净室项目）。当前工作区是该内核的一个历史版本，`kernel/compact.mjs` 是两阶段上下文压缩器（阶段①免模型结构裁剪 `pruneToolResult`），存在三个已确认的 JSON 形态缺陷。

## 缺陷描述

`pruneToolResult(text)` 对超长工具输出做结构感知裁剪（返回 `{ text, truncated, kind }`），但对 JSON 形态的输入有三个缺陷：

1. **单行 minified JSON（>20000 字符，无换行）**：检测不到行结构，裁剪逻辑不正确——要么没有"重排采样"（把长 JSON 重排成可采样的多行形态），要么没有字节截断兜底，导致 `truncated: true` 时输出尺寸没有真实下降；
2. **detectKind 顺序错误**：内容判定时表格（table）规则抢在 JSON 之前，导致**多行 pretty JSON / JSONL（每行含逗号）被误判为表格**走表格采样分支，键名结构与错误行丢失；
3. JSONL 多行形态（每行一条 JSON 对象、行内含逗号）应走 JSON 键名分支（头 30 行 + 错误行 + 尾 10 行），而不是表格分支。

## 验收标准

修复后，`pruneToolResult` 对以下三种输入必须满足（在 `server/compact.test.mjs` 补测试验证）：

**A. 单行 minified JSON（`{"name":"big-result","items":{...2000 项...}}`，总长 > 20000）**
- `truncated === true`、`kind === 'json'`
- 裁剪后 `text.length < 原长度`（尺寸真实下降）
- 保留键名行（如 `"name":"big-result"`）

**B. 多行 pretty JSON（>20000 字符）**
- `truncated === true`、`kind === 'json'`（**不得被逗号表格规则抢占**）
- 保留头部键名行（前 30 行内，如 `"name": "deploy-service"`）
- 保留错误行（`"status": "error"`、`"message": "connection refused"`，靠 errLines 规则，不在头 30 内也保留）

**C. JSONL 多行（600 行，每行含逗号）**
- `truncated === true`、`kind === 'json'`（走 json 键名分支而非 table 采样）
- 保留行数 ≤ 60（json 分支上限：头 30 + 错误 20 + 尾 10）
- 首行（`"name":"entry-0"`）与末行（`"name":"entry-599"`）均保留

## 要求

- 只修改必要的内核文件（预期 `kernel/compact.mjs`）。
- 遵循项目风格：ESM、无第三方依赖、确定性 O(n) 纯函数。
- 修复后在 `server/compact.test.mjs` 补充上述 A/B/C 三个测试，并运行 `node --test server/compact.test.mjs` 确认**全部**测试通过（含既有测试，不得回归）。
- 不要改动无关文件。
