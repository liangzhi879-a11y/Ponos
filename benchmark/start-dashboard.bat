@echo off
rem YFW-turbo 横向评估 —— 一键启动 Dashboard（双击本文件即可）
rem 用法：start-dashboard.bat [port]    默认端口 8787
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8787
if not "%1"=="" set PORT=%1

echo ==============================================
echo   YFW-turbo 横向评估 Dashboard 一键启动
echo   http://localhost:%PORT%
echo   关闭本窗口即停止服务
echo ==============================================
echo.

node dashboard.mjs --port %PORT% --open
if errorlevel 1 (
  echo.
  echo [错误] 启动失败。请确认已安装 Node.js 且在 PATH 中。
  pause
)
