#!/usr/bin/env bash
# SWE-bench 外部仓库克隆（一次性环境准备）
# ---------------------------------------------------------------------------
# 每个 repo 用 --filter=blob:none --no-checkout 克隆（只拉 commit/tree 元数据，
# blob 按需获取），后续按任务 base_commit 单独 fetch/checkout。
# 克隆后 repos/<name>/ 下 checkout 到任意 base_commit 验证可用。
# ---------------------------------------------------------------------------
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendors/swebench-repos"
mkdir -p "$DEST"

# repo 名 → GitHub URL
clone_one() {
  local name="$1" url="$2"
  if [ -d "$DEST/$name/.git" ]; then
    echo "已存在: $name（跳过）"
    return
  fi
  echo "克隆 $name ..."
  git -C "$DEST" clone --filter=blob:none --no-checkout "$url" "$name"
}

clone_one sympy https://github.com/sympy/sympy.git
clone_one requests https://github.com/psf/requests.git
clone_one flask https://github.com/pallets/flask.git
clone_one pytest https://github.com/pytest-dev/pytest.git
clone_one pylint https://github.com/pylint-dev/pylint.git

echo ""
echo "完成。全部仓库位于 $DEST"
