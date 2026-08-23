@echo off
rem ============================================================================
rem Ponos-turbo 内核一键部署（Windows PowerShell 一行版）
rem ----------------------------------------------------------------------------
rem 一行使用（复制到 PowerShell 执行，用户名/仓库按实际替换）：
rem   irm https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install-kernel.ps1 | iex
rem
rem 行为：检查 node -> clone/更新 -> 生成 .env -> 冒烟 -> 提示启动
rem 环境变量：$env:PONOS_REPO（仓库 URL）、$env:PONOS_DIR（安装目录）
rem ============================================================================

$ErrorActionPreference = "Stop"

$repoUrl = if ($env:PONOS_REPO) { $env:PONOS_REPO } else { "https://github.com/USERNAME/ponos.git" }
$target  = if ($env:PONOS_DIR)  { $env:PONOS_DIR }  else { Join-Path $HOME "ponos" }

Write-Host "==> Ponos-turbo 内核一键部署"
Write-Host "    仓库: $repoUrl"
Write-Host "    目录: $target"

# 1. node 检查
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[错误] 未找到 node。请先安装 Node.js >= 18" -ForegroundColor Red
  exit 1
}
$nodeMajor = [int](node -e "console.log(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 18) {
  Write-Host "[错误] node 版本过低（需要 >= 18）" -ForegroundColor Red
  exit 1
}
Write-Host "    node: $(node -v) OK"

# 2. 获取代码
if (Test-Path (Join-Path $target ".git")) {
  Write-Host "==> 仓库已存在，更新中..."
  Push-Location $target
  git pull --ff-only
  Pop-Location
} else {
  Write-Host "==> 克隆仓库..."
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  git clone --depth 1 $repoUrl $target
}

# 3. 内核目录
$kernelDir = Join-Path $target "kernel"
if (-not (Test-Path (Join-Path $kernelDir "cli.mjs"))) {
  Write-Host "[错误] 内核入口不存在: $kernelDir\cli.mjs" -ForegroundColor Red
  exit 1
}

# 4. 配置 .env
$envFile = Join-Path $kernelDir ".env"
if (-not (Test-Path $envFile)) {
  if (Test-Path (Join-Path $kernelDir ".env.example")) {
    Copy-Item (Join-Path $kernelDir ".env.example") $envFile
    Write-Host "==> 已生成 $envFile（请填入 API 配置）"
  } else {
    Write-Host "==> 警告：未找到 .env.example，请手动创建 $envFile" -ForegroundColor Yellow
  }
}

# 5. 冒烟验证
Write-Host "==> 冒烟验证..."
& node (Join-Path $kernelDir "cli.mjs") --help | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[错误] 内核启动失败" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "==> 安装完成！启动内核：" -ForegroundColor Green
Write-Host "    cd $kernelDir && node cli.mjs"
Write-Host ""
Write-Host "    首次使用请先编辑 $envFile 填入："
Write-Host "      ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL"
Write-Host "    协议契约见 docs/bridge-contract.md"
