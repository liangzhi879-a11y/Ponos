'use strict'
// 纯函数层：快照精简/脱敏/ref 选择器策略/域名白名单。无 Electron 依赖，node --test 可测。

const CID = /\b\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

function maskSensitive(text) {
  return String(text)
    .replace(CID, m => m.slice(0, 6) + '********' + m.slice(-2))
    .replace(PHONE, m => m.slice(0, 3) + '****' + m.slice(-4))
    .replace(EMAIL, m => m[0] + '***@' + m.split('@')[1])
}

function truncate(text, max = 60) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// ref → selector 优先级策略（页面上下文里逐项尝试命中，返回首个可用的）
const SELECTOR_KEYS = ['id', 'name', 'placeholder', 'aria-label', 'data-testid']
function pickSelector(attrs) {
  for (const k of SELECTOR_KEYS) {
    const v = attrs && attrs[k]
    if (typeof v === 'string' && v) return k === 'id' ? `#${cssEscape(v)}` : `[${k}="${cssEscape(v)}"]`
  }
  return null
}
function cssEscape(s) { return String(s).replace(/["\\\n\r]/g, ch => '\\' + ch) }

// JS 驱动菜单等无 href 文本节点：collector 端启发式判 clickable（onclick/pointer 光标/含子交互/子菜单）
// 此处作为交互信号纳入 interactives，tag 标为 menu-item 供模型区分
const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'option']

function buildSnapshot({ axTree = [], url, title, viewport, scrollY, prevSnapshot, downloads }) {
  const interactives = []
  const info = []
  let truncated = 0
  let ref = 0
  for (const node of axTree) {
    if (interactives.length + info.length >= 300) { truncated++; continue }
    const label = truncate(maskSensitive(node.name || ''))
    const clickable = node.clickable === true
    const isInteractive = INTERACTIVE_ROLES.includes(node.role) || clickable
    const entry = { ref: ++ref, tag: clickable && node.role === 'text' ? 'menu-item' : node.role, label, path_hint: truncate(node.path_hint || '') }
    if (isInteractive) {
      if (node.role === 'textbox' || node.role === 'combobox') entry.value = truncate(maskSensitive(node.value || ''))
      if (node.role === 'link' && node.href) entry.href = truncate(maskSensitive(node.href))
      if (node.download === true) entry.download = true
      if (node.checked !== undefined) entry.state = node.checked ? 'checked' : 'unchecked'
      interactives.push(entry)
    } else if (label) {
      info.push({ label, value: node.value !== undefined ? truncate(maskSensitive(String(node.value))) : undefined })
    }
  }
  return {
    page: { url, title: truncate(maskSensitive(title)), readyState: axTree[0]?.readyState || 'complete', loading: !!axTree[0]?.loading, captcha: !!axTree[0]?.captcha, captcha_img: axTree[0]?.captcha_img || null, logged_in: axTree[0]?.logged_in ?? null },
    alerts: (axTree[0]?.alerts || []).map(a => truncate(maskSensitive(a))),
    changes: diffSummary(prevSnapshot, { url, interactives }),
    interactives,
    info,
    downloads: (downloads || []).map(d => ({
      filename: truncate(maskSensitive(d.filename || '')),
      path: truncate(maskSensitive(d.path || '')),
      size: d.size || 0,
      received: d.received || 0,
      status: d.status || 'downloading',
    })),
    viewport, scrollY,
    truncated,
  }
}

function diffSummary(prev, next) {
  if (!prev) return '首次快照'
  const parts = []
  if (prev.url !== next.url) parts.push('URL 变化')
  if (next.alerts && next.alerts.length) parts.push(`提示:${next.alerts.join('/')}`)
  const pc = new Map((prev.interactives || []).map(n => [n.label + '|' + n.tag, 1]))
  let added = 0, removed = 0
  for (const n of next.interactives || []) if (!pc.has(n.label + '|' + n.tag)) added++
  const nc = new Map((next.interactives || []).map(n => [n.label + '|' + n.tag, 1]))
  for (const n of prev.interactives || []) if (!nc.has(n.label + '|' + n.tag)) removed++
  if (added) parts.push(`+${added} 节点`)
  if (removed) parts.push(`-${removed} 节点`)
  return parts.join(' · ') || '页面无变化'
}

function computeFingerprint({ title, href, textLen, inputCount }) {
  return `${title}|${href}|${textLen}|${inputCount}`
}

// 内置预设白名单（正则匹配 host）：
//  - 政务/本地：*.gov.cn（申报系统/政策）、localhost、127.0.0.1
//  - 搜索引擎：bing/baidu/sogou/google（导航到搜索页，再跳转政务目标）
//  - 企业查询：企查查/天眼查/爱企查/水滴信用（企业信息核验场景）
//  - 人社社保：12333 省级站（12333.cn 主域）
//  - 常用邮箱：QQ/163/126 邮箱（收取申报材料/验证码）
// 另有运行时动态配置：{PONOS_HOME}/browser-whitelist.json 的 allow 数组，
// 免改代码免重启（mtime 变化自动重读），支持子域匹配。
const DEFAULT_WHITELIST = [
  /\.gov\.cn$/i, /^localhost$/i, /^127\.0\.0\.1$/,
  /(^|\.)bing\.com$/i, /(^|\.)baidu\.com$/i, /(^|\.)sogou\.com$/i, /(^|\.)google\.com$/i,
  /(^|\.)qcc\.com$/i, /(^|\.)tianyancha\.com$/i, /(^|\.)aiqicha\.com$/i, /(^|\.)shuidi\.cn$/i,
  /(^|\.)12333\.cn$/i,
  /(^|\.)qq\.com$/i, /(^|\.)163\.com$/i, /(^|\.)126\.com$/i,
]
const allowed = new Set()
const fs = require('fs')
const path = require('path')
const os = require('os')
let cfgMtime = 0
let cfgHosts = null
function whitelistConfigPath() {
  const home = process.env.PONOS_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.ponos')
  return path.join(home, 'browser-whitelist.json')
}
// 惰性重读：文件 mtime 变化才重新解析，改配置即时生效，无需重启。
function refreshConfigHosts() {
  let st
  try { st = fs.statSync(whitelistConfigPath()) } catch { cfgHosts = null; return }
  if (st.mtimeMs === cfgMtime) return
  try {
    const raw = JSON.parse(fs.readFileSync(whitelistConfigPath(), 'utf8'))
    cfgHosts = Array.isArray(raw.allow) ? raw.allow.map(String).filter(Boolean) : []
    cfgMtime = st.mtimeMs
  } catch { cfgHosts = null }
}
function isWhitelisted(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    refreshConfigHosts()
    if (allowed.has(host)) return true
    if (cfgHosts && (cfgHosts.includes(host) || cfgHosts.some(h => host.endsWith('.' + String(h).toLowerCase())))) return true
    return DEFAULT_WHITELIST.some(r => r.test(host))
  } catch { return false }
}
isWhitelisted.allow = (host) => allowed.add(String(host).toLowerCase())

module.exports = { maskSensitive, truncate, pickSelector, cssEscape, buildSnapshot, diffSummary, computeFingerprint, isWhitelisted }
