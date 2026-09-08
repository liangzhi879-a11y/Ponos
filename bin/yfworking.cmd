@echo off
rem ===========================================================================
rem YFWorking cleanroom CLI launcher（净室语义，S4）
rem -------------------------------------------------------------------------
rem 净室不再包装/转发外部 CLI 会话命令：删除按 PATH 查找 claude 命令的三支
rem 兜底、会话命令 %* 转发与配置目录重定向的旧语义。内核由 bridge 从本库
rem kernel/ 源码或 kernel-dist/ bundle 直接 spawn（node 运行时，D1），
rem 无需外部 CLI；home 重定向只为 YFWorking 自身数据根隔离。
rem
rem 解析序：
rem   1. YFWORKING_HOME 已定义 → 透传（隔离 home / 双版并行场景）
rem   2. 未定义 → 设默认 home ~/.yfworking（并建 skills 派生目录）
rem   3. where node 兜底定位 node → node "%~dp0cli.mjs" %*
rem ===========================================================================

rem Compute ~/.yfworking (USERPROFILE works on Windows; HOME for git-bash)
if not defined YFWORKING_HOME (
  if defined HOME (
    set "YFWORKING_HOME=%HOME%\.yfworking"
  ) else (
    set "YFWORKING_HOME=%USERPROFILE%\.yfworking"
  )
)
if not exist "%YFWORKING_HOME%" mkdir "%YFWORKING_HOME%"
if not exist "%YFWORKING_HOME%\skills" mkdir "%YFWORKING_HOME%\skills"

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%~dp0cli.mjs" %*
  goto :eof
)

echo [yfworking] node not found on PATH. 1>&2
echo [yfworking] Install Node.js (>=18) first, then retry. 1>&2
exit /b 127
