# 任务：修复 protocolStream usage chunk 双发缺陷

这是 Ponos-turbo 内核（Node ESM 净室项目）。当前工作区是该内核的一个历史版本，存在一个已确认的缺陷。

## 缺陷描述

`kernel/api.mjs` 中的 `protocolStream()`（双协议流解析器，Anthropic/OpenAI 统一产出归一化 chunk）存在缺陷：**每个流会产出 2 个相同的 `usage` chunk**。

原因：解析器（`createAnthropicParser` / `createOpenAIParser`）在事件流中遇到终态 usage 时（Anthropic 的 `message_delta`、OpenAI 流末尾的 `usage` 字段）已经 push 了一个 `usage` chunk；但 `protocolStream` 在流结束后又无条件 `yield { type: 'usage', usage: parser.usage() }` 兜底了一次，导致每流双发。

这违反了「每流只产出一个终态 usage」不变量——下游按 chunk 累加 usage 时会**双计**。

## 验收标准

修复后，用以下 mock SSE 事件序列（完整 Anthropic 事件流）调用 `protocolStream`：

```
message_start（含 usage{input_tokens:5, output_tokens:1}）
content_block_start（text）
content_block_delta（text_delta "你好，世界。\n\n"）
content_block_stop
message_delta（usage{input_tokens:5, output_tokens:3, cache_read_input_tokens:2, cache_creation_input_tokens:1}）
[DONE]
```

必须满足：
1. 收集到的 `usage` chunk **恰好 1 个**；
2. 该 usage 的 `output_tokens === 3`、`cache_read_input_tokens === 2`（即终态值，来自 message_delta）；
3. 流中仍有正常 `text` chunk；
4. 若解析器未 push usage 的路径（兜底场景），流结束仍能产出 usage（不回归）；
5. `protocolStream` 需为 `kernel/api.mjs` 的**具名导出**（当前是未导出的内部函数，外部测试无法 import 调用）。

## 要求

- 只修改必要的内核文件（预期 `kernel/api.mjs`）。
- 遵循项目风格：ESM、无第三方依赖。
- 修复后请在 `server/api-protocol.test.mjs` 中补充一个断言该场景的测试（或在同目录新建测试文件），并运行 `node --test server/api-protocol.test.mjs` 确认全部通过。
- 不要改动无关文件。
