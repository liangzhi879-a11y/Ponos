@echo off
rem ===========================================================================
rem YFWorking CLI wrapper
rem -------------------------------------------------------------------------
rem Wraps the Claude Code binary but redirects ALL state to ~/.yfworking/ via
rem CLAUDE_CONFIG_DIR. This guarantees YFWorking and Claude never collide,
rem even when both are installed on the same machine.
rem
rem Precedence:
rem   1. YFWORKING_BIN env var (explicit override)
rem   2. claude.cmd on PATH
rem   3. claude on PATH
rem   4. node + this repo's bin/cli.mjs (dev fallback)
rem ===========================================================================

rem Compute ~/.yfworking (USERPROFILE works on Windows; HOME for git-bash)
if defined HOME (
  set "YFW_HOME=%HOME%\.yfworking"
) else (
  set "YFW_HOME=%USERPROFILE%\.yfworking"
)
if not exist "%YFW_HOME%" mkdir "%YFW_HOME%"
if not exist "%YFW_HOME%\skills" mkdir "%YFW_HOME%\skills"

rem Redirect Claude Code's config dir so it NEVER touches ~/.claude
set "CLAUDE_CONFIG_DIR=%YFW_HOME%"
set "YFWORKING_HOME=%YFW_HOME%"

rem Pick the binary
if defined YFWORKING_BIN (
  "%YFWORKING_BIN%" %*
  goto :eof
)

where claude.cmd >nul 2>nul
if %ERRORLEVEL%==0 (
  claude.cmd %*
  goto :eof
)

where claude >nul 2>nul
if %ERRORLEVEL%==0 (
  claude %*
  goto :eof
)

rem Dev fallback — boot the bundled bridge+vite dev server
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%~dp0cli.mjs" %*
  goto :eof
)

echo [yfworking] Claude Code CLI not found on PATH. 1>&2
echo [yfworking] Install Claude Code first, or set YFWORKING_BIN to its path. 1>&2
exit /b 127
