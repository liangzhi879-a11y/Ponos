# 任务：修复 resume 时 seedHistory 混入 compaction 条目

这是 Ponos-turbo 内核（Node ESM 净室项目）。当前工作区是该内核的一个历史版本，存在一个已确认的缺陷。

## 缺陷描述

`kernel/cli.mjs` 在 `--resume` 恢复会话时，会从 transcript（JSONL 事件日志，权威源）中筛选历史条目作为 `seedHistory` 注入引擎：

```js
const history = entries.filter((e) => e?.type === 'user' || e?.type === 'assistant')
engine.seedHistory(history.map((e) => e.message))
```

这个过滤**仅按 `type` 判断**（user/assistant），但 transcript 中的上下文压缩条目（compaction）`type` 同为 `assistant`，其 `kind` 为 `'compaction'`。其中**孤儿 start 条目**（压缩开始记录，无配对 summary）的 `message.content` 是**空数组 `[]`**——空 content 的 assistant 消息在真实 Anthropic API 请求中**非法**（会直接报错）。

即：resume 一个发生过压缩的会话时，空 content 的 assistant 消息会被当作正常历史注入，导致真实 API 请求失败。

## 验收标准

修复后：
1. resume 的 seedHistory 过滤逻辑对 **compaction 条目（`kind === 'compaction'`）一律排除**，不管其 `type` 是什么；
2. 普通 user / assistant 条目的恢复语义保持不变（不被误过滤）；
3. 运行 `node --test server/kernel-engine.test.mjs server/kernel-contract.test.mjs` 确认既有测试全部通过（回归）。

## 要求

- 只修改必要的内核文件（预期 `kernel/cli.mjs`）。
- 遵循项目风格：ESM、无第三方依赖。
- 建议在 `server/` 下补一个针对 resume 过滤的测试（可用 `PONOS_MOCK_API=1` 环境变量走内置 mock 流，无需真实网络）。
- 不要改动无关文件。
