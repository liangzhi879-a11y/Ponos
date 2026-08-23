# 启动 ponos vs claude 全量对照评测（独立进程，脱离会话生命周期）
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\T203-15\ponos-dev'
$p = Start-Process -FilePath 'node' `
  -ArgumentList @('benchmark/run.mjs','--agents','ponos,claude','--resume','2026-08-21T12-34-56-877Z') `
  -WorkingDirectory $root `
  -RedirectStandardOutput (Join-Path $root 'benchmark\bench-ponos-claude-run.log') `
  -RedirectStandardError (Join-Path $root 'benchmark\bench-ponos-claude-run.err.log') `
  -WindowStyle Hidden -PassThru
Write-Output ("PID=" + $p.Id)
