# Ponos-turbo 内核（独立部署）

零 npm 依赖的 agent 内核。GUI 集成形态由 bridge spawn；本包为无 GUI 最小部署。

## 一步启动

1. 复制 `.env.example` 为 `.env` 并填入 `ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL`
2. 加载环境变量后运行：

   node cli.mjs

## 交互模式

- 标准输入逐行 NDJSON（type: user / control_request），标准输出 NDJSON 事件流
- 协议契约见 docs/bridge-contract.md

## 配置入口

- 环境变量 + CLI flag：docs/manual/kernel-config.md（生成式清单）
- 分层 settings（user < project < local）：见 kernel/settings.mjs 与生产化规划 Phase 4/6
