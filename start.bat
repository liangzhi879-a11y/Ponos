@echo off
title YFWorking
setlocal

REM Resolve to the directory this .bat lives in so it works from any CWD
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

REM Bridge port — can be overridden via YFW_BRIDGE_PORT env var
REM (D4 净室新版独立默认 51517；与在售旧版默认 51309 无交集)
if not defined YFW_BRIDGE_PORT set "YFW_BRIDGE_PORT=51517"
REM Vite dev port — can be overridden via YFW_VITE_PORT env var
REM (D4 净室新版独立默认 5197；与在售旧版默认 5173 无交集)
if not defined YFW_VITE_PORT set "YFW_VITE_PORT=5197"
REM 数据根兜底隔离（2026-09-09 串配置事故修复）：dev 形态默认净室专属根 ~/.yfw，
REM 与在售旧版 ~/.yfworking 互不串；YFWORKING_HOME 已定义时透传（双版隔离主开关）。
if not defined YFWORKING_HOME set "YFWORKING_HOME=%USERPROFILE%\.yfw"

REM Stop any leftover vite/bridge from a previous run (best-effort).
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R "LISTENING" ^| findstr ":%YFW_VITE_PORT% "') do (
  echo [cleanup] stopping stale vite on PID %%P
  taskkill /F /PID %%P >nul 2>&1
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R "LISTENING" ^| findstr ":%YFW_BRIDGE_PORT% "') do (
  echo [cleanup] stopping stale bridge on PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

REM Start the bridge (kernel WebSocket + file APIs)
echo [1/2] starting bridge on :%YFW_BRIDGE_PORT%
start "Bridge (%YFW_BRIDGE_PORT%)" /MIN cmd /c "cd /d %APP_DIR% && node server\bridge.mjs"

REM Start the Vite dev server, bound to all interfaces (0.0.0.0).
REM Without --host, vite defaults to "localhost" only, which on some Windows
REM setups resolves to ::1 (IPv6) and breaks 127.0.0.1 access.
echo [2/2] starting vite on :%YFW_VITE_PORT% (host 0.0.0.0)
start "Vite (%YFW_VITE_PORT%)" /MIN cmd /c "cd /d %APP_DIR% && npx vite --host 0.0.0.0 --port %YFW_VITE_PORT%"

REM Give them a moment to bind
timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo   Bridge  ->  http://localhost:%YFW_BRIDGE_PORT%
echo   GUI     ->  http://localhost:%YFW_VITE_PORT%
echo   Network ->  http://%COMPUTERNAME%:%YFW_VITE_PORT%
echo ============================================
echo.
echo Open http://localhost:%YFW_VITE_PORT% in your browser.
echo Close the spawned windows to stop the servers.
echo.
pause
endlocal
