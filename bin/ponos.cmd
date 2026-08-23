@echo off
rem ===========================================================================
rem Ponos CLI wrapper
rem -------------------------------------------------------------------------
rem Wraps the Claude Code binary but redirects ALL state to ~/.ponos/ via
rem CLAUDE_CONFIG_DIR. This guarantees Ponos and Claude never collide,
rem even when both are installed on the same machine.
rem
rem Precedence:
rem   1. PONOS_BIN env var (explicit override)
rem   2. claude.cmd on PATH
rem   3. claude on PATH
rem   4. node + this repo's bin/cli.mjs (dev fallback)
rem ===========================================================================

rem Compute ~/.ponos (USERPROFILE works on Windows; HOME for git-bash)
if defined HOME (
  set "PONOS_HOME=%HOME%\.ponos"
) else (
  set "PONOS_HOME=%USERPROFILE%\.ponos"
)
if not exist "%PONOS_HOME%" mkdir "%PONOS_HOME%"
if not exist "%PONOS_HOME%\skills" mkdir "%PONOS_HOME%\skills"

rem Redirect Claude Code's config dir so it NEVER touches ~/.claude
set "CLAUDE_CONFIG_DIR=%PONOS_HOME%"
set "PONOS_HOME=%PONOS_HOME%"

rem Pick the binary
if defined PONOS_BIN (
  "%PONOS_BIN%" %*
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

echo [ponos] Claude Code CLI not found on PATH. 1>&2
echo [ponos] Install Claude Code first, or set PONOS_BIN to its path. 1>&2
exit /b 127
