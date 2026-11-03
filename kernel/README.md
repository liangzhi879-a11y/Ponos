# Ponos-turbo 内核（内嵌形态）

> 这里是内核本体，**不是**完整应用。部署、能力清单、目录地图、测试与版本说明统一在仓根
> [`../README.md`](../README.md) —— 本文件只保留"在这个目录里怎么手工跑起来"这一段，
> 避免同一份自述在两处各写一遍（必然漂移）。

## 三步跑起来

1. 复制 `.env.example` 为 `.env`，填三个变量：
   `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`
2. 加载环境变量（`--env-file=.env` 或 `export $(cat .env | xargs)`）
3. `node cli.mjs`（TUI）；一次性调用用 `node cli.mjs -p "…" --output-format stream-json`

## 形态说明

- **无 GUI 最小部署**：stdin 逐行 NDJSON（`type: user` / `control_request`），stdout NDJSON 事件流。
- **GUI 集成**：由桌面应用的 bridge 以 spawn 方式拉起本目录的 `cli.mjs`，协议契约见
  [`../docs/bridge-contract.md`](../docs/bridge-contract.md)。
- **配置**：环境变量 + CLI flag，逐项清单见 [`../docs/manual/kernel-config.md`](../docs/manual/kernel-config.md)；
  分层 settings（user < project < local）见 `settings.mjs`，生产化规划见
  [`../docs/production-plan.md`](../docs/production-plan.md) 的 Phase 4/6。
