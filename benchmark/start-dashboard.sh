#!/usr/bin/env bash
# Ponos-turbo 横向评估 —— 一键启动 Dashboard（终端里运行）
# 用法：./start-dashboard.sh [port]   默认端口 8787
cd "$(dirname "$0")"

PORT="${1:-8787}"

echo "=============================================="
echo "  Ponos-turbo 横向评估 Dashboard 一键启动"
echo "  http://localhost:${PORT}"
echo "  Ctrl+C 停止服务"
echo "=============================================="
echo

exec node dashboard.mjs --port "$PORT" --open
