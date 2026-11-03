// kernel/hooks.mjs —— hooks 生命周期执行器（事件 → 规则匹配 → spawn 脚本 → 决策回填）
// 事件：preToolUse（可否决）/ postToolUse / userPromptSubmit（可拦截）/ sessionStart。
// 规则：{ event, tools?, pattern?, command, args?, timeoutMs? }；payload 经 stdin 传 JSON 一行，
// 脚本 stdout 首行 JSON 为决策（preToolUse: { deny, message }；userPromptSubmit: { stop, message }）。
import { spawn } from 'node:child_process'

export function matchHook(rules, event, toolName = '') {
  return (rules || []).filter((r) => {
    if (r.event !== event) return false
    if (r.tools && String(r.tools).trim()) {
      const list = String(r.tools).split(',').map((s) => s.trim()).filter(Boolean)
      if (list.length && !list.includes(toolName)) return false
    }
    return true
  })
}

function matchesPattern(rule, payload) {
  if (rule.pattern == null || String(rule.pattern) === '') return true
  try { return JSON.stringify(payload).includes(String(rule.pattern)) } catch { return false }
}

function parseDecision(rule, event, output) {
  const first = String(output || '').trim().split('\n')[0] || ''
  let parsed = {}
  try { parsed = JSON.parse(first) } catch { parsed = {} }
  if (event === 'preToolUse') {
    return { deny: parsed.deny === true, message: parsed.message || (parsed.deny === true ? `PreToolUse hook ${rule.command} 拒绝执行` : '') }
  }
  if (event === 'userPromptSubmit') {
    return { stop: parsed.stop === true, message: parsed.message || (parsed.stop === true ? '用户输入已由 hook 拦截' : '') }
  }
  return {}
}

/**
 * hook 子进程的**白名单环境**（SEC-04，2026-10-18）。
 *
 * ★ 缺陷：原来这里是 `env: { ...process.env, ... }` —— hook 命令来自**项目级配置**
 *   （`.ponos/hooks.json` / settings），而项目目录常来自 clone / 别人给的仓库
 *   ⇒ **不可信代码继承了完整环境**，包括：
 *     · 各家 LLM API Key（PONOS_*_AUTH_TOKEN / PONOS_VISION_* / 第三方 PONOS_*_KEY）
 *     · 代理与凭据注入变量（HTTP_PROXY 里的 user:pass）
 *     · 密码库路径与解锁上下文（PONOS_HOME / PONOS_VAULT_*）
 *   一个恶意 hook 只要读 `env` 就能把密钥打走 —— 而它本来只是"格式检查/通知"这类轻量动作。
 *
 * ★ 为什么是**白名单**而不是"黑名单剔除敏感词"：黑名单永远漏（新变量名、拼接名、第三方前缀）。
 *   白名单的失效方向是"hook 少了某项能力"（可诊断、可补）；
 *   黑名单的失效方向是"密钥泄漏"。两者代价不对等。
 *
 * ★ NODE_OPTIONS 刻意**不透传**：它能 `--require` 任意模块 = 任意代码执行。
 *   hook 真需要 Node 特殊选项时应在自己的命令里显式写。
 */
function hookEnv(extra = {}) {
  const OUT = {}
  // 基础运行环境：找命令、临时目录、语言/编码、终端行为
  const PASSTHROUGH = [
    'PATH', 'Path', 'PATHEXT',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'TEMP', 'TMP', 'TMPDIR',
    'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONIOENCODING', 'PYTHONUTF8',
    'SHELL', 'TERM', 'PWD',
    // 代理开关本身不敏感（URL 里若含 user:pass 也不该给 hook —— 见下方排除）
    'NO_PROXY', 'no_proxy',
  ]
  for (const k of PASSTHROUGH) {
    if (process.env[k] !== undefined) OUT[k] = process.env[k]
  }
  // ★ 兜底排除：即使上面误加了，名字里带敏感词的也一律不透传。
  //   这层是"双保险"——白名单已足够，但代码演进时容易有人往里加东西。
  const SENSITIVE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|VAULT|COOKIE|SESSION/i
  for (const k of Object.keys(OUT)) {
    if (SENSITIVE.test(k)) delete OUT[k]
  }
  return { ...OUT, ...extra }
}

async function runHook(rule, payload) {
  const started = Date.now()
  const child = spawn(rule.command, rule.args || [], {
    // ★ 2026-10-18 SEC-04：白名单环境（详见 hookEnv 注释）
    env: hookEnv({ PONOS_HOOK_EVENT: payload.event || '' }),
    timeout: rule.timeoutMs || 10_000,
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (d) => { out += d })
  child.stderr?.on('data', (d) => { err += d })
  child.stdin.on('error', () => {})
  child.stdin.write(JSON.stringify(payload) + '\n')
  child.stdin.end()
  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c))
    child.on('error', (e) => resolve(-1))
  })
  const decision = parseDecision(rule, payload.event, out)
  return {
    matched: true,
    deny: decision.deny || false,
    stop: decision.stop || false,
    message: decision.message || '',
    exitCode: code,
    output: (out || '').slice(0, 8192),
    stderr: err.slice(0, 2048),
    durationMs: Date.now() - started,
  }
}

export function createHooks({ rules = [] } = {}) {
  return {
    count: rules.length,
    async run(event, payload = {}) {
      const hits = matchHook(rules, event, payload.toolName || '')
      let last = null
      for (const rule of hits) {
        if (!matchesPattern(rule, payload)) continue
        last = await runHook(rule, { event, ...payload })
        if (last.deny || last.stop) break
      }
      return last || { matched: false }
    },
  }
}
