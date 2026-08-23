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

async function runHook(rule, payload) {
  const started = Date.now()
  const child = spawn(rule.command, rule.args || [], {
    env: { ...process.env, PONOS_HOOK_EVENT: payload.event || '' },
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
