@echo off
title Claude Code GUI
setlocal

REM Resolve to the directory this .bat lives in so it works from any CWD
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

REM Bridge port — can be overridden via YFW_BRIDGE_PORT env var
if not defined YFW_BRIDGE_PORT set "YFW_BRIDGE_PORT=51309"

REM Stop any leftover vite/bridge from a previous run (best-effort).
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R "LISTENING" ^| findstr ":5173 "') do (
  echo [cleanup] stopping stale vite on PID %%P
  taskkill /F /PID %%P >nul 2>&1
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R "LISTENING" ^| findstr ":%YFW_BRIDGE_PORT% "') do (
  echo [cleanup] stopping stale bridge on PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

REM Start the bridge (Claude CLI WebSocket + file APIs)
echo [1/2] starting bridge on :%YFW_BRIDGE_PORT%
start "Bridge (%YFW_BRIDGE_PORT%)" /MIN cmd /c "cd /d %APP_DIR% && node server\bridge.mjs"

REM Start the Vite dev server, bound to all interfaces (0.0.0.0).
REM Without --host, vite defaults to "localhost" only, which on some Windows
REM setups resolves to ::1 (IPv6) and breaks 127.0.0.1 access.
echo [2/2] starting vite on :5173 (host 0.0.0.0)
start "Vite (5173)" /MIN cmd /c "cd /d %APP_DIR% && npx vite --host 0.0.0.0 --port 5173"

REM Give them a moment to bind
timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo   Bridge  ->  http://localhost:%YFW_BRIDGE_PORT%
echo   GUI     ->  http://localhost:5173
echo   Network ->  http://%COMPUTERNAME%:5173
echo ============================================
echo.
echo Open http://localhost:5173 in your browser.
echo Close the spawned windows to stop the servers.
echo.
pause
endlocal
