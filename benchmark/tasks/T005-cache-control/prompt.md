# 任务：为 Anthropic 协议请求支持 cache_control 断点（默认关）

这是 YFW-turbo 内核（Node ESM 净室项目）。`kernel/api.mjs` 是双协议流适配层（Anthropic `/v1/messages` + OpenAI `/v1/chat/completions`），当前请求 body **不含** `cache_control` 断点。

## 需求背景

spec（docs/superpowers/specs/2026-08-20-yfw-turbo-inner-core-design.md §3.6「请求前缀缓存优化」）采纳了 **cache_control 断点（可选）**：在 Anthropic 协议的 system / 静态块上打 `cache_control: { type: 'ephemeral' }` 断点，让长前缀复用 KV/Prompt Cache，降低请求成本。但**未知 provider 可能忽略该字段**——因此必须**默认关闭**，仅当环境变量开启时才注入，且不得改变默认请求形状（现网请求零影响）。

## 任务要求

修改 `kernel/api.mjs` 的 `anthropicStream()`（Anthropic 协议请求构造，内部函数）：

1. **默认（`CLAUDE_CODE_CACHE_CONTROL` 未设置或非 '1'）**：请求 body 与现状完全一致——`system` 字段保持字符串（若存在），不出现任何 `cache_control`；
2. **开启（`CLAUDE_CODE_CACHE_CONTROL === '1'`）**：请求 body 中：
   - `system` 字段（若存在）变为 Anthropic 缓存断点形态：`[{ "type": "text", "text": "<system>", "cache_control": { "type": "ephemeral" } }]`；
   - `messages` 中第一条 user 消息的文本块同样携带 `cache_control: { "type": "ephemeral" }`（messages 为空或首条非文本时跳过，不得报错）；
   - OpenAI 协议（`openaiStream`）不受影响，保持不变。
3. 用环境变量读取（`process.env.CLAUDE_CODE_CACHE_CONTROL`），遵循现有 env 读取风格。

## 验收标准

通过 mock `fetch` 抓取真实请求 body 验证（在 `server/api-protocol.test.mjs` 或同目录新建测试）：

- **A. 默认关闭**：不设 env 调用 `streamMessages`（Anthropic 协议）→ 抓到的请求 body 中 `system` 为字符串（或不存在），且整个 body 的 JSON 序列化字符串**不含** `"cache_control"`；
- **B. 开启**：`CLAUDE_CODE_CACHE_CONTROL=1` → 抓到的请求 body 中 `system` 为含 `cache_control:{type:'ephemeral'}` 的数组块，首条 user 消息文本块含 `cache_control`；
- **C. 开启且 system 为空 / messages 首条非文本**：不抛错，正常产出请求。

## 要求

- 只修改必要的内核文件（预期 `kernel/api.mjs`）。
- 遵循项目风格：ESM、无第三方依赖。
- 补充测试并运行 `node --test server/api-protocol.test.mjs` 确认全部通过（含既有测试，不得回归）。
- 不要改动无关文件。
