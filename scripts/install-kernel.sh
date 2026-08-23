#!/usr/bin/env bash
# ============================================================================
# Ponos-turbo 内核一键部署（Linux / macOS / WSL）
# ----------------------------------------------------------------------------
# 一行使用（复制即用，用户名/仓库按实际替换）：
#   curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install-kernel.sh | bash
#
# 行为：
#   1. 检查 node >= 18
#   2. clone ponos 仓库到 $HOME/ponos（已存在则 git pull）
#   3. 复制 .env.example → .env（首次）
#   4. 提示填写 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
#   5. 启动内核（node kernel/cli.mjs）
#
# 环境变量覆盖：
#   PONOS_REPO  仓库 URL（默认 https://github.com/<user>/<repo>.git）
#   PONOS_DIR   安装目录（默认 $HOME/ponos）
# ============================================================================

set -euo pipefail

REPO_URL="${PONOS_REPO:-https://github.com/liangzhi879-a11y/Ponos.git}"
TARGET="${PONOS_DIR:-$HOME/ponos}"

echo "==> Ponos-turbo 内核一键部署"
echo "    仓库: $REPO_URL"
echo "    目录: $TARGET"

# 1. node 检查
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node。请先安装 Node.js >= 18：https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[错误] node 版本过低（当前 $(node -v)，需要 >= 18）" >&2
  exit 1
fi
echo "    node: $(node -v) ✓"

# 2. 获取代码
if [ -d "$TARGET/.git" ]; then
  echo "==> 仓库已存在，更新中..."
  git -C "$TARGET" pull --ff-only
else
  echo "==> 克隆仓库..."
  mkdir -p "$(dirname "$TARGET")"
  git clone --depth 1 "$REPO_URL" "$TARGET"
fi

# 3. 内核目录
KERNEL_DIR="$TARGET/kernel"
if [ ! -f "$KERNEL_DIR/cli.mjs" ]; then
  echo "[错误] 内核入口不存在：$KERNEL_DIR/cli.mjs" >&2
  exit 1
fi

# 4. 配置 .env
if [ ! -f "$KERNEL_DIR/.env" ]; then
  if [ -f "$KERNEL_DIR/.env.example" ]; then
    cp "$KERNEL_DIR/.env.example" "$KERNEL_DIR/.env"
    echo "==> 已生成 $KERNEL_DIR/.env（请填入 API 配置）"
  else
    echo "==> 警告：未找到 .env.example，请手动创建 $KERNEL_DIR/.env" >&2
  fi
fi

# 5. 冒烟验证
echo "==> 冒烟验证..."
if ! node "$KERNEL_DIR/cli.mjs" --help >/dev/null 2>&1; then
  echo "[错误] 内核启动失败" >&2
  exit 1
fi

echo ""
echo "==> 安装完成！启动内核："
echo "    cd $TARGET/kernel && node cli.mjs"
echo ""
echo "    首次使用请先编辑 $KERNEL_DIR/.env 填入："
echo "      ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL"
echo "    协议契约见 docs/bridge-contract.md"
