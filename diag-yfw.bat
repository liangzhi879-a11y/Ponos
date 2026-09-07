@echo off
setlocal enabledelayedexpansion

rem ==================================================
rem  YFWorking installer diagnostic - bun exits fast
rem  Run this on the TEST machine, then send back:
rem  diag.log + yfw-console.log + yfw-console.err.log
rem ==================================================

rem ---- [0] locate install dir ----
set "APP="
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
set "LAP=%LocalAppData%\Programs\YFWorking"

if exist "%PF%\YFWorking\YFWorking.exe" set "APP=%PF%\YFWorking"
if exist "%PF86%\YFWorking\YFWorking.exe" set "APP=%PF86%\YFWorking"
if exist "%LAP%\YFWorking.exe" set "APP=%LAP%"

if not defined APP (
  echo.
  echo [0] YFWorking.exe NOT found in common paths.
  echo     Type the install dir manually, NO quotes.
  echo     Example: D:\YFWorking
  set /p "APP=Install dir: "
  set "APP=!APP:"=!"
  if "!APP:~-1!"=="\" set "APP=!APP:~0,-1!"
)

if not defined APP (
  echo [X] No path given. Aborting.
  pause
  exit /b 1
)
if not exist "%APP%\YFWorking.exe" (
  echo [X] ERROR: "%APP%\YFWorking.exe" does not exist.
  pause
  exit /b 1
)

echo [0] App dir: %APP%
del diag.log 2>nul
del yfw-console.log 2>nul
del yfw-console.err.log 2>nul

rem ---- [1] components ----
echo ====== YFWorking diagnostic ====== > diag.log
echo App dir: %APP% >> diag.log
echo Date: %DATE% %TIME% >> diag.log
echo. >> diag.log
echo ====== [1] components ====== >> diag.log
if exist "%APP%\resources\kernel\cli.mjs" echo kernel\cli.mjs: OK >> diag.log
if not exist "%APP%\resources\kernel\cli.mjs" echo kernel\cli.mjs: MISSING >> diag.log
if exist "%APP%\resources\runtime\bun\bun.exe" echo runtime\bun\bun.exe: OK >> diag.log
if not exist "%APP%\resources\runtime\bun\bun.exe" echo runtime\bun\bun.exe: MISSING >> diag.log
echo. >> diag.log

rem ---- [2] bun standalone ----
echo ====== [2] bun --version (standalone) ====== >> diag.log
"%APP%\resources\runtime\bun\bun.exe" --version >> diag.log 2>&1
echo. >> diag.log

rem ---- [3] kernel launch (bun + cli.mjs) ----
echo ====== [3] kernel --version (bun + cli.mjs) ====== >> diag.log
"%APP%\resources\runtime\bun\bun.exe" "%APP%\resources\kernel\cli.mjs" --version >> diag.log 2>&1
echo. >> diag.log

rem ---- [4] bootstrap cache ----
echo ====== [4] bootstrap cache (user home) ====== >> diag.log
if exist "%USERPROFILE%\.yfworking\runtime\bun\bun.exe" echo cached bun: OK >> diag.log
if not exist "%USERPROFILE%\.yfworking\runtime\bun\bun.exe" echo cached bun: MISSING >> diag.log
if exist "%USERPROFILE%\.yfworking\runtime\kernel\cli.mjs" echo cached kernel: OK >> diag.log
if not exist "%USERPROFILE%\.yfworking\runtime\kernel\cli.mjs" echo cached kernel: MISSING >> diag.log
echo. >> diag.log

rem ---- [5] launch GUI, capture logs, live tail ----
echo ====== [5] launching GUI ====== >> diag.log
echo [5] launching GUI, opening live log window ...
powershell -NoProfile -Command "Start-Process -FilePath '%APP%\YFWorking.exe' -WorkingDirectory '%APP%' -RedirectStandardOutput '%CD%\yfw-console.log' -RedirectStandardError '%CD%\yfw-console.err.log'"
start "yfw-live-log" powershell -NoProfile -Command "Get-Content -Wait -Path '%CD%\yfw-console.log'"

echo.
echo A live log window just opened - it shows [main] [bridge] [bridge:err]
echo lines in real time. Wait ~10s, then watch it: if bun dies, the error
echo appears here as [bridge:err] or [bridge] lines.
echo.
echo Press any key when done. (GUI and log window stay open; close them
echo yourself. diag.log / yfw-console.log / yfw-console.err.log are saved.)
echo.
pause
