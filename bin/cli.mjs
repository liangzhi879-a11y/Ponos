#!/usr/bin/env node

import { spawn, execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(__dirname, '..')

const BRIDGE_PORT = parseInt(process.env.YFW_BRIDGE_PORT || '51309', 10)
const VITE_PORT = 5173

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`\x1b[90m${ts}\x1b[0m \x1b[93m[${tag}]\x1b[0m ${msg}`)
}

function killPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8', timeout: 5000 })
    const lines = out.trim().split('\n')
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && /^\d+$/.test(pid)) {
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' }) } catch {}
      }
    }
  } catch {}
}

function openBrowser(url, delay = 4000) {
  setTimeout(() => {
    try {
      execSync(`start "" "${url}"`, { timeout: 5000 })
    } catch {}
  }, delay)
}

function startBridge() {
  killPort(BRIDGE_PORT)
  log('bridge', `starting on :${BRIDGE_PORT}`)
  const proc = spawn('node', [resolve(APP_DIR, 'server', 'bridge.mjs')], {
    cwd: APP_DIR,
    stdio: 'pipe',
  })
  proc.stdout.on('data', (d) => {
    const text = d.toString().trim()
    if (text) log('bridge', text)
  })
  proc.stderr.on('data', (d) => {
    const text = d.toString().trim()
    if (text) log('bridge', `\x1b[91m${text}\x1b[0m`)
  })
  proc.on('error', (e) => log('bridge', `\x1b[91merror: ${e.message}\x1b[0m`))
  return proc
}

function startVite() {
  killPort(VITE_PORT)
  log('vite', `starting on :${VITE_PORT}`)
  const args = ['vite', '--host', '0.0.0.0', '--port', String(VITE_PORT)]
  const proc = spawn('npx', args, {
    cwd: APP_DIR,
    stdio: 'pipe',
  })
  proc.stdout.on('data', (d) => {
    const text = d.toString().trim()
    if (text) log('vite', text)
  })
  proc.stderr.on('data', (d) => {
    const text = d.toString().trim()
    if (text) log('vite', `\x1b[91m${text}\x1b[0m`)
  })
  proc.on('error', (e) => log('vite', `\x1b[91merror: ${e.message}\x1b[0m`))
  return proc
}

const bridge = startBridge()
const vite = startVite()

setTimeout(() => {
  console.log()
  console.log('  \x1b[93m╔══════════════════════════════════════════╗\x1b[0m')
  console.log('  \x1b[93m║\x1b[0m        \x1b[38;5;208mYFWorking GUI\x1b[0m  \x1b[90mready\x1b[0m              \x1b[93m║\x1b[0m')
  console.log('  \x1b[93m╠══════════════════════════════════════════╣\x1b[0m')
  console.log(`  \x1b[93m║\x1b[0m  Bridge  → \x1b[36mhttp://localhost:${BRIDGE_PORT}\x1b[0m              \x1b[93m║\x1b[0m`)
  console.log(`  \x1b[93m║\x1b[0m  GUI     → \x1b[36mhttp://localhost:${VITE_PORT}\x1b[0m              \x1b[93m║\x1b[0m`)
  console.log('  \x1b[93m╚══════════════════════════════════════════╝\x1b[0m')
  console.log()
  console.log('  \x1b[90mPress Ctrl+C to stop all servers\x1b[0m')
  console.log()
}, 3000)

openBrowser(`http://localhost:${VITE_PORT}`, 4000)

process.on('SIGINT', () => {
  bridge.kill()
  vite.kill()
  process.exit(0)
})
process.on('SIGTERM', () => {
  bridge.kill()
  vite.kill()
  process.exit(0)
})
