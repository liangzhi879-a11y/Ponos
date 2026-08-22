// yfwturbo 启动器：从 YFW settings.json 注入 ANTHROPIC_* env（单一数据源，
// 密钥不复制到 PATH 脚本），再以当前终端（stdio inherit）启动 TUI。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TUI = join(ROOT, 'kernel', 'tui.mjs')
const SETTINGS = join(homedir(), '.yfworking', 'settings.json')
const KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']

try {
  const cfg = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
  // settings.json 结构：{ env: { ANTHROPIC_*: ... } }；兼容顶层直存
  const src = cfg && cfg.env && typeof cfg.env === 'object' ? cfg.env : cfg
  for (const k of KEYS) {
    if (!process.env[k] && src[k]) process.env[k] = src[k]
  }
} catch (e) {
  console.error(`yfwturbo: 无法读取 ${SETTINGS}：${e.message}`)
}
if (!process.env.ANTHROPIC_BASE_URL) {
  console.error('yfwturbo: 缺少 ANTHROPIC_BASE_URL（settings.json 未配置 provider）')
}
const r = spawnSync(process.execPath, [TUI, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
process.exit(r.status ?? 1)
