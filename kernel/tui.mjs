// YFW-Turbo 交互式 TUI（全屏 ANSI 版，远方品牌橙红深色主题）
// ---------------------------------------------------------------------------
// 用法：
//   node kernel/tui.mjs                     # 新会话（ANTHROPIC_* env 已配置）
//   node kernel/tui.mjs --resume <sid>      # 恢复既有会话
//   node kernel/tui.mjs --mock              # 离线 mock 模式（无网络，测交互链路）
//   node kernel/tui.mjs --dir <path>        # 指定会话工作目录（默认当前目录）
//   node kernel/tui.mjs --banner <file>     # 指定启动艺术字文件
//   node kernel/tui.mjs --no-banner         # 不显示艺术字
//   node kernel/tui.mjs --theme light       # 亮色主题（默认 dark）
// 布局（四层固定结构）：
//   Header（2 行）     模型/工作状态/上下文色条/Token/TPS
//   Approval（0-2 行） 高危工具审批横幅（挂起时出现）
//   Viewport（弹性）   对话消息列表，底部对齐，PgUp/PgDn 手动滚动暂停跟随
//   Input（1-4 行）    多行输入，Enter 发送 / Shift+Enter 换行，↑↓ 历史
//   Footer（1 行）     快捷键提示
// 交互：
//   <任意文本> Enter   发送用户消息
//   Shift+Enter / Ctrl+J 换行
//   ↑ / ↓              历史输入切换
//   ← / → / Home / End 光标移动
//   PgUp / PgDn        对话滚动（手动滚动后暂停自动跟随）
//   Ctrl+G / Ctrl+B    滚动到顶部 / 底部
//   Tab                命令补全（/ 开头时）
//   /cancel            取消当前轮次
//   /help /banner /version /clear /stats /tools /session /model /theme /quit
//   审批时：allow / deny（或 y / n / a / d）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KERNEL_VERSION } from '../version.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KERNEL_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_BANNER = join(KERNEL_DIR, 'ascii-art-1787378784252.txt')

// ---------- 主题色板（远方品牌：暖黑底 + 远方橙 #ff4200 + 远方红 #ff2400） ----------
const THEMES = {
  dark: {
    bg: '#0b0a0a', panel: '#151313', code: '#1e1b1a',
    text: '#e6e0db', meta: '#8c8580', placeholder: '#5e5955', border: '#2d2826',
    orange: '#ff4200', red: '#ff2400', error: '#ff5a4a', highlight: '#ff6b33',
  },
  light: {
    bg: '#fff7f2', panel: '#ffffff', code: '#f6ece5',
    text: '#3a322c', meta: '#8a7d72', placeholder: '#b5a89b', border: '#e6d8cc',
    orange: '#cc3400', red: '#cc1d00', error: '#cc3a24', highlight: '#cc3400',
  },
}
let themeName = 'dark'
let theme = THEMES.dark
let useColor = process.stdout.isTTY && !process.env.NO_COLOR
const RESET = '\x1b[0m'

function fg(hex) {
  return `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`
}
function bg(hex) {
  return `\x1b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`
}
// key 取 THEMES 色板键；bold 加粗
function c(text, key, bold) {
  if (!useColor) return String(text)
  const hex = theme[key]
  if (!hex) return String(text)
  return (bold ? '\x1b[1m' : '') + fg(hex) + String(text) + RESET
}
// 整行背景填充（面板色），text 允许含 ANSI
function lineBg(text, key = 'bg') {
  if (!useColor) return text
  return bg(theme[key]) + text + RESET
}

// ---------- 宽度工具（东亚宽字符按 2 计） ----------
export function visWidth(str) {
  const s = String(str)
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\x1b') { while (i < s.length && s[i] !== 'm') i++; continue } // 跳过 ANSI 序列
    w += s.charCodeAt(i) >= 0x2E80 ? 2 : 1
  }
  return w
}
// 按宽度折行（保留 \n 语义），返回行数组。ANSI 序列不计宽、不拆行，且跟随其后
// 的可视字符（折行时序列随字符到下一行，避免色序残留行尾、字符丢色）
export function wrapText(text, width) {
  const out = []
  for (const seg of String(text ?? '').split('\n')) {
    if (seg === '') { out.push(''); continue }
    let line = ''
    let w = 0
    let pendingSeq = '' // 等待下一个可视字符的 ANSI 前缀
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i]
      if (ch === '\x1b') {
        let j = i + 1
        while (j < seg.length && seg[j] !== 'm') j++
        pendingSeq += seg.slice(i, Math.min(j + 1, seg.length))
        i = j
        continue
      }
      const cw = ch.charCodeAt(0) >= 0x2E80 ? 2 : 1
      if (w + cw > width && line) { out.push(line); line = ''; w = 0 }
      if (pendingSeq) { line += pendingSeq; pendingSeq = '' }
      line += ch; w += cw
    }
    if (pendingSeq) line += pendingSeq // 行尾残留序列（如 RESET）
    out.push(line)
  }
  return out
}
// 光标字符偏移 → 可视坐标 {row, col}（相对 wrap 后的行/列）
export function cursorPosOf(text, cursor, width) {
  let row = 0
  let w = 0
  for (let i = 0; i < cursor && i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') { row++; w = 0; continue }
    const cw = ch.charCodeAt(0) >= 0x2E80 ? 2 : 1
    if (w + cw > width) { row++; w = 0 }
    w += cw
  }
  return { row, col: w }
}
// 按可见宽度截断（超宽补 …）。ANSI 序列原样保留（不计宽、绝不切半——切半会
// 残留未闭合 \x1b[38;2 序列，污染整行颜色）
export function trunc(str, width) {
  const s = String(str)
  if (visWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\x1b') {
      let j = i + 1
      while (j < s.length && s[j] !== 'm') j++
      out += s.slice(i, Math.min(j + 1, s.length))
      i = j
      continue
    }
    const cw = ch.charCodeAt(0) >= 0x2E80 ? 2 : 1
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}
// 行缓冲切分（流式输出按完整行落地，避免逐 token 闪跳；测试用）
export function bufferChunk(buf, chunk) {
  const combined = buf + chunk
  const nl = combined.lastIndexOf('\n')
  if (nl < 0) return { complete: '', rest: combined }
  return { complete: combined.slice(0, nl + 1), rest: combined.slice(nl + 1) }
}

// ---------- 艺术字（亮度重采样缩放 + 品牌双色渲染） ----------
const CHARS = [' ', '░', '▒', '▓', '█']
const CHAR_BRIGHTNESS = { ' ': 0, '.': 0.16, '`': 0.3, ',': 0.16, '/': 0.5, '\\': 0.5, '^': 0.5, '[': 0.66, ']': 0.66, '=': 0.82, '-': 0.82, 'O': 0.92, '@': 1, '░': 0.25, '▒': 0.5, '▓': 0.75, '█': 1 }
function brightnessOf(ch) { return CHAR_BRIGHTNESS[ch] ?? 0.5 }
function charFor(b) {
  const idx = Math.round(b * (CHARS.length - 1))
  return CHARS[Math.max(0, Math.min(CHARS.length - 1, idx))]
}
// 读取艺术字 → 有效行（剔除装饰性 ─ 边框行、空行、行尾空白）
function loadBannerLines(file) {
  if (!file || !existsSync(file)) return null
  const raw = readFileSync(file, 'utf-8').split('\n')
  const lines = raw
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0 && !/^[─━-]+$/.test(l.trim()))
  return lines.length ? lines : null
}
// 缩放到 targetW × targetH（亮度均值重采样；源图更小则直接居中）
export function scaleBanner(lines, targetW, targetH) {
  const srcH = lines.length
  const srcW = Math.max(...lines.map((l) => l.length))
  if (srcW <= targetW && srcH <= targetH) {
    return lines.map((l) => l.padEnd(targetW, ' ').slice(0, targetW))
  }
  const grid = lines.map((l) => l.padEnd(srcW, ' '))
  const out = []
  for (let y = 0; y < targetH; y++) {
    const y0 = Math.floor((y * srcH) / targetH)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / targetH))
    let row = ''
    for (let x = 0; x < targetW; x++) {
      const x0 = Math.floor((x * srcW) / targetW)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / targetW))
      let sum = 0
      let n = 0
      for (let gy = y0; gy < y1; gy++) for (let gx = x0; gx < x1; gx++) { sum += brightnessOf(grid[gy][gx]); n++ }
      row += charFor(n ? sum / n : 0)
    }
    out.push(row.replace(/\s+$/, ''))
  }
  return out
}
// 品牌双色渐变：浅块（░▒）亮橙，实块（▓█）主橙。
// 连续同色合并为单个 ANSI 序列（逐字符着色会产生海量转义、conhost 渲染易闪）
function paintBannerLine(line) {
  if (!useColor) return line
  let out = ''
  let group = ''
  let kind = null // 'light' | 'main'
  const flush = () => {
    if (group) out += kind === 'light' ? c(group, 'highlight') : c(group, 'orange')
    group = ''
  }
  for (const ch of line) {
    const k = ch === '░' || ch === '▒' ? 'light' : (ch === '▓' || ch === '█' ? 'main' : null)
    if (k && k === kind) { group += ch; continue }
    flush()
    if (k) { kind = k; group = ch }
    else { out += ch; kind = null }
  }
  flush()
  return out
}

// ---------- 键盘解析（raw bytes → key 事件；支持 CSI / Ctrl / Shift+Enter） ----------
export class KeyStream {
  constructor() {
    this.decoder = new StringDecoder('utf-8')
  }
  push(buf) {
    const text = this.decoder.write(buf)
    const events = []
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\x1b') {
        const m = text.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z~])/)
        if (m) {
          events.push(csiEvent(m[1], m[2]))
          i += m[0].length
        } else {
          events.push({ name: 'escape' })
          i++
        }
        continue
      }
      if (ch === '\r') { events.push({ name: 'enter' }); i++; continue }
      if (ch === '\n') { events.push({ name: 'enter', ctrl: true, newline: true }); i++; continue }
      if (ch === '\t') { events.push({ name: 'tab' }); i++; continue }
      if (ch === '\x7f') { events.push({ name: 'backspace' }); i++; continue }
      if (ch === '\x03') { events.push({ name: 'c', ctrl: true }); i++; continue }
      if (ch === '\x07') { events.push({ name: 'g', ctrl: true }); i++; continue }
      if (ch === '\x02') { events.push({ name: 'b', ctrl: true }); i++; continue }
      if (ch === '\x15') { events.push({ name: 'u', ctrl: true }); i++; continue }
      if (ch === '\x01') { events.push({ name: 'a', ctrl: true }); i++; continue }
      if (ch === '\x05') { events.push({ name: 'e', ctrl: true }); i++; continue }
      if (ch === '\x04') { events.push({ name: 'd', ctrl: true }); i++; continue }
      if (ch < ' ') { events.push({ name: ch, ctrl: true }); i++; continue }
      events.push({ name: 'char', char: ch })
      i++
    }
    return events
  }
}
function csiEvent(param, final) {
  switch (final) {
    case 'A': return { name: 'up' }
    case 'B': return { name: 'down' }
    case 'C': return { name: 'right' }
    case 'D': return { name: 'left' }
    case 'H': return { name: 'home' }
    case 'F': return { name: 'end' }
    case '~': {
      if (param === '5') return { name: 'pageup' }
      if (param === '6') return { name: 'pagedown' }
      if (param === '3') return { name: 'delete' }
      if (param === '7' || param === '1') return { name: 'home' }
      if (param === '8' || param === '4') return { name: 'end' }
      // kitty keyboard protocol：13;2u = Shift+Enter；13;3u = Alt+Enter
      if (param.startsWith('13;')) {
        return /13;(2|3)/.test(param) ? { name: 'enter', shift: true, newline: true } : { name: 'enter' }
      }
      return { name: 'unknown' }
    }
    case 'u': { // kitty：13;2u Shift+Enter
      if (param.startsWith('13;')) {
        return /13;(2|3)/.test(param) ? { name: 'enter', shift: true, newline: true } : { name: 'enter' }
      }
      return { name: 'unknown' }
    }
    default: return { name: 'unknown' }
  }
}

// ---------- 布局计算（纯函数，可测） ----------
// 行序：Header(2) ─ divider(1) ─ Viewport(N) ─ divider(1) ─ Approval(A) ─ Input(I) ─ divider(1) ─ Footer(1)
export function computeLayout(rows, cols, { inputLines = 1, approval = false } = {}) {
  const headerRows = 2
  const footerRows = 1
  const dividerRows = 3 // Header 下 / Input 上 / Footer 上 各一条
  const inputRows = Math.max(1, Math.min(4, inputLines))
  const approvalRows = approval ? 2 : 0
  const viewportRows = Math.max(1, rows - headerRows - footerRows - dividerRows - inputRows - approvalRows)
  return { headerRows, footerRows, dividerRows, inputRows, approvalRows, viewportRows }
}

// ---------- 主程序 ----------
function main() {
  // ---------- 参数 ----------
  function parseArgs(argv) {
    const out = { resume: null, mock: false, dir: process.cwd(), banner: DEFAULT_BANNER, noBanner: false, theme: 'dark' }
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      const next = () => argv[++i]
      switch (a) {
        case '--resume': out.resume = next(); break
        case '--mock': out.mock = true; break
        case '--dir': out.dir = resolve(next()); break
        case '--banner': out.banner = resolve(next()); break
        case '--no-banner': out.noBanner = true; break
        case '--theme': out.theme = next(); break
        case '--help': case '-h': console.log(usageText()); process.exit(0); break
      }
    }
    return out
  }
  function usageText() {
    return `YFWorking 交互终端（YFW-Turbo 内核 ${KERNEL_VERSION}）
用法: node kernel/tui.mjs [--resume <sid>] [--mock] [--dir <path>] [--banner <file>] [--no-banner] [--theme dark|light]
键位: Enter 发送 · Shift+Enter/Ctrl+J 换行 · ↑↓ 历史 · ←→ 移动 · PgUp/PgDn 滚动 · Ctrl+G/B 顶/底 · Tab 补全
命令（支持 /yfw <cmd> 前缀，别名 yfwturbo）:
  /cancel  取消当前轮次       /stats   会话统计（轮次/用量）
  /clear   清空对话重显 banner /tools  工具列表
  /help    显示本帮助          /session 会话 ID
  /model   当前模型            /banner  重显艺术字
  /theme   切换深/亮主题       /tool <n> 展开/折叠工具卡片
  /effort 思考深度档位         /version dev 版本号
  /quit    退出
思考深度: auto 模型原生自适应 · low/high/max 注入 reasoning_effort · off 关闭 · medium 并入 high
审批: allow / deny（或 y / n / a / d）`
  }

  const args = parseArgs(process.argv.slice(2))
  if (args.mock) process.env.YFW_MOCK_API = '1'
  if (args.mock) process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
  if (!args.mock) {
    if (process.env.YFW_MOCK_API === '1') { console.error('错误: YFW_MOCK_API=1 会走 mock，请清除或加 --mock'); process.exit(2) }
    if (!process.env.ANTHROPIC_BASE_URL) { console.error('错误: 需要 ANTHROPIC_BASE_URL env（或加 --mock）'); process.exit(2) }
  }
  if (args.theme === 'light') { themeName = 'light'; theme = THEMES.light }
  mkdirSync(args.dir, { recursive: true })
  const DIR = args.dir
  const MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'
  const CONTEXT_WINDOW = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || 1_000_000) || 1_000_000
  const isTui = !!(process.stdin.isTTY && process.stdout.isTTY)

  // ---------- 状态 ----------
  let sessionId = args.resume || '?'
  let pendingApproval = null
  let turnActive = false
  let toolSeq = 0
  let turns = 0
  let usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let lastDurationMs = 0
  let initInfo = { model: '', tools: [] }
  let inputText = ''
  let cursor = 0
  let history = []
  let historyIdx = -1
  let historyTemp = ''
  let scrollOffset = 0 // 0 = 跟随底部
  // 思考深度档位（对齐 Claude Code /effort）：auto 默认 = 模型原生自适应
  let effort = process.env.CLAUDE_CODE_EFFORT_LEVEL || process.env.YFW_REASONING_EFFORT || 'auto'
  let toolExpanded = new Set()
  let toolSeqMap = new Map()
  let messages = []
  let thinkingBuf = ''
  let thinkingHinted = false
  let breath = 0
  let animTimer = null
  let renderTimer = null
  let child = null
  let stderrBuf = '' // stderr 按行缓冲，避免 chunk 截断成半行
  const ICONS = process.env.YFW_TUI_ICONS === 'ascii' ? { tool: '[工具]', think: '[思考]' } : { tool: '⚙', think: '💭' }

  // ---------- 消息管理 ----------
  function pushMessage(m) {
    if (!isTui) { // 非 TTY：文本直出
      if (m.kind === 'banner') { for (const ln of m.lines) console.log(ln); return }
      console.log(m.kind === 'error' ? `✖ ${m.text}` : m.text)
      return
    }
    messages.push(m)
    // 不重置 scrollOffset：手动滚动后新消息不打断阅读位置（自动跟随仅在 offset=0 时自然发生）
  }
  function fmtToolInput(input) {
    const s = JSON.stringify(input ?? {})
    return s.length > 90 ? s.slice(0, 90) + '…' : s
  }
  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }
  function contextPct() { return Math.min(1, usageTotals.input_tokens / CONTEXT_WINDOW) }
  function tps() {
    if (!lastDurationMs || !usageTotals.output_tokens) return '0'
    const secs = lastDurationMs / 1000
    return (secs > 0 ? (usageTotals.output_tokens / secs / 1000).toFixed(1) : '0') + 'k'
  }

  // ---------- 渲染 ----------
  function bar(pct) {
    const n = Math.round(pct * 18)
    const fill = pct > 0.7 ? 'red' : 'orange'
    return '[' + c('█'.repeat(n), fill) + c('░'.repeat(18 - n), 'meta') + ']'
  }
  function renderHeader(cols) {
    const dot = turnActive ? c(breath % 2 ? '●' : '○', 'red') : c('○', 'meta')
    let line1 = c('YFWorking', 'orange', true) + c(' · ' + (initInfo.model || MODEL), 'highlight')
    line1 += ' ' + dot + ' ' + bar(contextPct())
    line1 += ' ' + c('in=' + fmtK(usageTotals.input_tokens), 'highlight')
    line1 += ' ' + c('out=' + fmtK(usageTotals.output_tokens), 'highlight')
    if (usageTotals.output_tokens) line1 += ' ' + c(tps() + '/s', 'highlight')
    let line2 = c(`会话 ${sessionId}`, 'meta')
    if (args.mock) line2 += ' ' + c('(mock)', 'red')
    line2 += ' ' + c(`思考 ${effort}`, 'orange') + c(` · 上下文 ${Math.round(contextPct() * 100)}% · 主题 ${themeName}`, 'meta')
    return [trunc(line1, Math.max(10, cols)), trunc(line2, Math.max(10, cols))]
  }
  function renderApproval(cols) {
    if (!pendingApproval) return null
    const req = pendingApproval.request || {}
    const title = c(`┌ 审批 ─ ${req.tool_name || ''} 请求执行`, 'red')
    const reason = String(req.decision_reason || req.reason || '-')
    const line1 = trunc(title + c('　理由：' + reason, 'text'), Math.max(8, cols - 2))
    const line2 = trunc(c('│ allow / deny（y / n / a / d）', 'red'), Math.max(8, cols - 2))
    return [line1, line2]
  }
  function msgLines(m, cols) {
    switch (m.kind) {
      case 'banner': return m.lines
      case 'user': {
        const pw = 6 // '┃ You '
        const inner = Math.max(4, cols - pw - 1)
        const lines = wrapText(m.text, inner)
        return lines.map((ln, i) => (i === 0 ? '  ' + c('┃ You ', 'orange') + c(ln, 'text') : '  ' + c('┃' + ' '.repeat(pw - 1), 'orange') + c(ln, 'text')))
      }
      case 'assistant': {
        const pw = 12 // '┃ Assistant '
        const inner = Math.max(4, cols - pw - 1)
        const tail = m.streaming && m.text && m.text.trim() ? c('▍', 'red') : ''
        const lines = wrapText((m.text || '') + tail, inner)
        return lines.map((ln, i) => (i === 0 ? '  ' + c('┃ Assistant ', 'red') + c(ln, 'text') : '  ' + c('┃' + ' '.repeat(pw - 1), 'red') + c(ln, 'text')))
      }
      case 'thinking': {
        const t = String(m.text || '').replace(/\s+/g, ' ').trim()
        return ['  ' + c(`${ICONS.think} [思考] `, 'meta') + c(t.length > cols - 16 ? t.slice(0, cols - 19) + '…' : t, 'meta')]
      }
      case 'tool': {
        const out = []
        const head = `  ${c(`${ICONS.tool} 工具 ${m.seq} · ${m.name}`, 'red')} ${c(fmtToolInput(m.input), 'meta')}`
        out.push(trunc(head, Math.max(10, cols - 1)))
        const r = String(m.result ?? '')
        if (toolExpanded.has(m.seq)) {
          const lines = wrapText(r, Math.max(4, cols - 6))
          for (const ln of lines.slice(0, 8)) out.push('  ' + c('└ ' + ln, 'meta'))
          if (lines.length > 8) out.push('  ' + c(`└ …（共 ${lines.length} 行，/tool ${m.seq} 折叠）`, 'placeholder'))
        } else {
          const one = r.replace(/\s+/g, ' ').trim()
          if (one) out.push('  ' + c('└ ' + (one.length > 120 ? one.slice(0, 120) + '…' : one), 'meta'))
        }
        return out
      }
      case 'result': return wrapText(m.text, Math.max(4, cols - 4)).map((ln) => '  ' + c('┄ ' + ln, 'meta'))
      case 'error': return wrapText(m.text, Math.max(4, cols - 4)).map((ln) => '  ' + c('✖ ' + ln, 'error'))
      default: return wrapText(m.text, Math.max(4, cols - 4)).map((ln) => '  ' + c(ln, 'meta'))
    }
  }
  function renderViewport(rows, cols) {
    const all = []
    for (const m of messages) for (const ln of msgLines(m, cols)) all.push(ln)
    const maxOffset = Math.max(0, all.length - rows)
    if (scrollOffset > maxOffset) scrollOffset = maxOffset
    const start = Math.max(0, all.length - rows - scrollOffset)
    return all.slice(start, start + rows)
  }
  function renderInput(rows, cols) {
    const width = Math.max(4, cols - 2)
    const lines = wrapText(inputText, width)
    const visible = lines.slice(-rows)
    const skip = lines.length - visible.length
    const cur = cursorPosOf(inputText, cursor, width)
    const prompt = c('› ', 'orange')
    const out = []
    for (let i = 0; i < rows; i++) {
      const ln = visible[i]
      let content
      if (ln === undefined) content = i === 0 && !inputText ? c('输入消息开始对话，/help 查看命令', 'placeholder') : ''
      else content = c(ln, 'text')
      const prefix = i === 0 ? prompt : '  '
      out.push('  ' + prefix + content)
    }
    return { lines: out, cursorRow: cur.row - skip, cursorCol: cur.col }
  }
  function renderFooter(cols) {
    const bits = [
      c('Enter', 'highlight') + ' 发送', c('Shift+Enter', 'highlight') + ' 换行',
      c('↑↓', 'highlight') + ' 历史', c('PgUp/PgDn', 'highlight') + ' 滚动',
      c('/', 'orange') + '命令', c('Tab', 'highlight') + '补全',
      c('Esc', 'highlight') + '取消', c('Ctrl+C', 'highlight') + '退出',
    ]
    const sep = c(' · ', 'border')
    let line = ''
    for (const b of bits) {
      if (line && visWidth(line + sep + b) > cols - 4) break
      line += (line ? sep : '') + b
    }
    return '  ' + line
  }
  // 全屏重绘：隐藏光标 → home → 逐层输出（分隔线分板块 + padEnd 覆盖残留）→ 定位输入光标
  function render() {
    if (!isTui) return
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const { headerRows, inputRows, approvalRows, viewportRows } = computeLayout(rows, cols, {
      inputLines: Math.max(1, wrapText(inputText, Math.max(4, cols - 2)).length),
      approval: !!pendingApproval,
    })
    const header = renderHeader(cols)
    const approval = renderApproval(cols)
    const viewport = renderViewport(viewportRows, cols)
    const input = renderInput(inputRows, cols)
    const footer = renderFooter(cols)
    const divider = c('─'.repeat(cols), 'border')
    const padTo = (ln, panel) => {
      // 超宽兜底：任何行都不得超出 cols，否则终端软换行会推乱整屏与光标定位
      const safe = visWidth(ln) > cols ? trunc(ln, cols) : ln
      const w = visWidth(safe)
      const fill = ' '.repeat(Math.max(0, cols - w))
      return lineBg(safe + fill, panel ? 'panel' : 'bg') // 全行统一背景，避免露出终端原底色
    }
    let out = '\x1b[?25l\x1b[H'
    for (const ln of header) out += padTo(ln) + '\r\n'
    out += padTo(divider) + '\r\n'
    for (const ln of viewport) out += padTo(ln) + '\r\n'
    out += padTo(divider) + '\r\n'
    if (approval) for (const ln of approval) out += padTo(ln, true) + '\r\n'
    const inputStartRow = headerRows + 1 + viewportRows + 1 + approvalRows
    input.lines.forEach((ln, i) => {
      out += padTo(ln, true)
      out += i < input.lines.length - 1 ? '\r\n' : ''
    })
    const cursorAbsRow = inputStartRow + Math.max(0, Math.min(input.cursorRow, inputRows - 1)) + 1
    const cursorAbsCol = 4 + input.cursorCol + 1
    out += '\r\n' + padTo(divider) + '\r\n' + padTo(footer, true)
    out += `\x1b[${cursorAbsRow};${cursorAbsCol}H\x1b[?25h`
    process.stdout.write(out)
  }
  function scheduleRender(delay = 40) {
    if (!isTui || renderTimer) return
    renderTimer = setTimeout(() => { renderTimer = null; render() }, delay)
  }
  function startAnim() {
    if (!isTui || animTimer) return
    animTimer = setInterval(() => { breath++; render() }, 450)
  }
  function stopAnim() {
    if (animTimer) { clearInterval(animTimer); animTimer = null }
  }

  // ---------- 事件处理（内核 stream-json） ----------
  function appendAssistantText(t) {
    let last = messages[messages.length - 1]
    if (!last || last.kind !== 'assistant' || last.streaming !== true) {
      last = { kind: 'assistant', text: '', streaming: true }
      messages.push(last)
    }
    last.text += t
    scheduleRender(t.includes('\n') ? 0 : 40)
  }
  function endAssistantStream() {
    const last = messages[messages.length - 1]
    if (last && last.kind === 'assistant') last.streaming = false
  }
  function flushThinking() {
    if (!thinkingBuf && !thinkingHinted) return
    const text = thinkingBuf.replace(/\s+/g, ' ').trim()
    if (text) pushMessage({ kind: 'thinking', text })
    thinkingBuf = ''
    thinkingHinted = false
  }
  function logPlain(ev) {
    switch (ev.type) {
      case 'system': if (ev.subtype === 'init') console.log(`[init] model=${ev.model} session=${ev.session_id}`); break
      case 'assistant': {
        for (const b of ev.message?.content ?? ev.blocks ?? []) {
          if (b?.type === 'text') process.stdout.write(b.text)
          else if (b?.type === 'tool_use') console.log(`\n[工具] ${b.name}(${JSON.stringify(b.input)})`)
        }
        break
      }
      case 'result': console.log(`\n[result] in=${ev.usage?.input_tokens ?? 0} out=${ev.usage?.output_tokens ?? 0}`); break
      default: break
    }
  }
  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    // 统计累计（TTY/非 TTY 共用）
    if (ev.type === 'result') {
      const u = ev.usage || {}
      turns++
      for (const k of Object.keys(usageTotals)) usageTotals[k] += u[k] ?? 0
      lastDurationMs = ev.duration_ms || 0
    }
    if (!isTui) { logPlain(ev); return }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          sessionId = ev.session_id
          initInfo.model = ev.model || ''
          initInfo.tools = ev.tools || []
          pushMessage({ kind: 'system', text: `会话 ${sessionId} · 模型 ${initInfo.model} · ${(ev.tools || []).length} 个工具` })
          render()
        } else if (ev.subtype === 'reasoning_effort_updated') {
          effort = ev.value ?? effort
          pushMessage({ kind: 'result', text: `思考深度已生效：${ev.value}（${ev.effort ?? 'auto'}${ev.value === 'auto' || ev.effort === 'auto' ? '，模型原生自适应' : '，请求注入 reasoning_effort'}）` })
          render()
        } else if (ev.subtype === 'reasoning_effort_rejected') {
          pushMessage({ kind: 'error', text: `思考深度设置被拒：${ev.reason ?? '未知原因'}` })
          render()
        }
        break
      case 'assistant': {
        const blocks = ev.message?.content ?? ev.blocks
        for (const b of blocks || []) {
          if (b?.type === 'text') { flushThinking(); appendAssistantText(b.text) }
          else if (b?.type === 'thinking') { thinkingBuf += b.thinking; thinkingHinted = true }
          else if (b?.type === 'tool_use') {
            flushThinking()
            endAssistantStream()
            toolSeq++
            const toolMsg = { kind: 'tool', seq: toolSeq, name: b.name, input: b.input, result: '' }
            pushMessage(toolMsg)
            toolSeqMap.set(toolSeq, toolMsg)
            render()
          } else {
            pushMessage({ kind: 'system', text: `[assistant] ${JSON.stringify(b).slice(0, 200)}` })
            render()
          }
        }
        break
      }
      case 'control_request': {
        const req = ev.request
        if (req?.subtype === 'can_use_tool') {
          endAssistantStream()
          pendingApproval = ev
          render()
        }
        break
      }
      case 'result': {
        endAssistantStream()
        flushThinking()
        const u = ev.usage || {}
        turnActive = false
        stopAnim()
        const usageStr = `in=${fmtK(u.input_tokens ?? 0)} out=${fmtK(u.output_tokens ?? 0)} cacheRead=${fmtK(u.cache_read_input_tokens ?? 0)} cacheWrite=${fmtK(u.cache_creation_input_tokens ?? 0)}`
        pushMessage({ kind: 'result', text: `第 ${turns} 轮 · ${usageStr}${lastDurationMs ? ` · ${lastDurationMs}ms` : ''}` })
        render()
        break
      }
      case 'yfw_health':
        pushMessage({ kind: 'result', text: `健康 score=${ev.score ?? '?'} tier=${ev.tier ?? '?'}` })
        render(); break
      case 'yfw_summary':
        pushMessage({ kind: 'result', text: `压缩摘要 第 ${ev.compactCount ?? '?'} 次：${String(ev.text || '').slice(0, 120)}` })
        render(); break
      default:
        pushMessage({ kind: 'system', text: `[${ev.type}] ${JSON.stringify(ev).slice(0, 200)}` })
        render()
    }
  }

  // ---------- 命令 ----------
  const COMMANDS = ['/banner', '/cancel', '/clear', '/effort', '/help', '/model', '/quit', '/session', '/stats', '/theme', '/tool', '/tools', '/version', '/exit']
  function sendCancel() {
    child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    pushMessage({ kind: 'system', text: '已发送取消' })
    render()
  }
  function runCommand(cmdText) {
    const [cmd, ...rest] = cmdText.split(/\s+/)
    switch (cmd) {
      case '/cancel': sendCancel(); break
      case '/help': case '/yfw': case '/yfwturbo': pushMessage({ kind: 'system', text: usageText() }); render(); break
      case '/clear': messages = []; toolSeqMap.clear(); showBanner(); break
      case '/stats': pushMessage({ kind: 'result', text: `轮次=${turns} in=${fmtK(usageTotals.input_tokens)} out=${fmtK(usageTotals.output_tokens)} cacheRead=${fmtK(usageTotals.cache_read_input_tokens)} cacheWrite=${fmtK(usageTotals.cache_creation_input_tokens)}` }); render(); break
      case '/tools': pushMessage({ kind: 'result', text: initInfo.tools.length ? initInfo.tools.join(', ') : '（尚未收到 init）' }); render(); break
      case '/session': pushMessage({ kind: 'result', text: sessionId }); render(); break
      case '/model': pushMessage({ kind: 'result', text: initInfo.model || MODEL }); render(); break
      case '/effort': {
        const v = (rest[0] || '').trim().toLowerCase()
        const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max', 'auto']
        if (!v) {
          pushMessage({ kind: 'result', text: `思考深度：${effort}${effort === 'auto' ? '（模型原生自适应：简单快答、复杂深想）' : '（显式档位，下一轮生效）'}` })
          render(); break
        }
        if (!EFFORT_LEVELS.includes(v)) {
          pushMessage({ kind: 'error', text: '用法：/effort <off|low|medium|high|max|auto>（medium 并入 high）' })
          render(); break
        }
        effort = v
        child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'reasoning_effort', payload: { value: v } } }) + '\n')
        pushMessage({ kind: 'system', text: `已请求设置思考深度：${v}（下一轮生效）` })
        render(); break
      }
      case '/version': pushMessage({ kind: 'result', text: `YFW-Turbo 内核 ${KERNEL_VERSION}（${initInfo.model || MODEL}）` }); render(); break
      case '/theme': {
        themeName = themeName === 'dark' ? 'light' : 'dark'
        theme = THEMES[themeName]
        pushMessage({ kind: 'result', text: `已切换主题：${themeName}` })
        render(); break
      }
      case '/tool': {
        const n = Number(rest[0])
        if (!n) { pushMessage({ kind: 'error', text: '用法：/tool <序号> 展开/折叠工具卡片' }); render(); break }
        if (toolExpanded.has(n)) toolExpanded.delete(n); else toolExpanded.add(n)
        render(); break
      }
      case '/banner': showBanner(); break
      case '/quit': case '/exit': leaveTui(0); break
      default: pushMessage({ kind: 'error', text: `未知命令 ${cmd}，/help 查看` }); render()
    }
  }
  function commandCandidates(prefix) {
    return COMMANDS.filter((cmd) => cmd.startsWith(prefix))
  }

  // ---------- 键盘处理 ----------
  function handleKey(k) {
    if (k.name === 'unknown') return
    // 审批挂起：回车提交审批回执
    if (pendingApproval) {
      if (k.name === 'enter' && !k.newline) {
        const text = inputText.trim()
        if (!/^(allow|y|yes|a|deny|n|no|d)$/i.test(text)) {
          inputText = ''
          cursor = 0
          pushMessage({ kind: 'error', text: '请输入 allow / deny（或 y / n）' })
          render()
          return
        }
        const allow = /^(allow|y|yes|a)$/i.test(text)
        const cr = pendingApproval
        pendingApproval = null
        inputText = ''
        cursor = 0
        child.stdin.write(JSON.stringify({
          type: 'control_response',
          response: {
            request_id: cr.request_id,
            subtype: 'success',
            response: {
              behavior: allow ? 'allow' : 'deny',
              updatedInput: {},
              toolUseID: cr.request?.tool_use_id,
              decisionClassification: 'user_temporary',
            },
          },
        }) + '\n')
        pushMessage({ kind: allow ? 'result' : 'error', text: allow ? '审批：已批准，继续执行' : '审批：已拒绝' })
        render()
      }
      return
    }
    switch (k.name) {
      case 'char':
        insertAt(inputText.slice(0, cursor) + k.char, cursor + k.char.length)
        break
      case 'enter': {
        if (k.newline) { insertAt(inputText.slice(0, cursor) + '\n', cursor + 1); break }
        sendMessage()
        break
      }
      case 'backspace':
        if (cursor > 0) {
          inputText = inputText.slice(0, cursor - 1) + inputText.slice(cursor)
          cursor--
          render()
        }
        break
      case 'delete':
        if (cursor < inputText.length) {
          inputText = inputText.slice(0, cursor) + inputText.slice(cursor + 1)
          render()
        }
        break
      case 'left': if (cursor > 0) { cursor--; render() } break
      case 'right': if (cursor < inputText.length) { cursor++; render() } break
      case 'home': cursor = 0; render(); break
      case 'end': cursor = inputText.length; render(); break
      case 'up': historyNav(-1); break
      case 'down': historyNav(1); break
      case 'pageup': scrollOffset += (process.stdout.rows || 24) - 4; render(); break
      case 'pagedown': scrollOffset = Math.max(0, scrollOffset - ((process.stdout.rows || 24) - 4)); render(); break
      case 'tab': completeCommand(); break
      case 'escape':
        if (turnActive) sendCancel()
        else leaveTui(0)
        break
      default:
        if (k.ctrl) {
          switch (k.name) {
            case 'c': if (turnActive) sendCancel(); else leaveTui(0); break
            case 'g': scrollOffset = 1e9; render(); break
            case 'b': scrollOffset = 0; render(); break
            case 'u': inputText = ''; cursor = 0; render(); break
            case 'a': cursor = 0; render(); break
            case 'e': cursor = inputText.length; render(); break
          }
        }
    }
  }
  function insertAt(text, newCursor) {
    inputText = text
    cursor = Math.max(0, Math.min(newCursor, inputText.length))
    render()
  }
  function historyNav(dir) {
    if (!history.length) return
    if (historyIdx === -1) historyTemp = inputText
    historyIdx += dir
    if (historyIdx < 0) { historyIdx = -1; inputText = historyTemp; cursor = inputText.length; render(); return }
    if (historyIdx >= history.length) { historyIdx = history.length - 1; return }
    inputText = history[historyIdx]
    cursor = inputText.length
    render()
  }
  function completeCommand() {
    const m = inputText.match(/^(\/([a-z]*))$/)
    if (!m) return
    const cands = commandCandidates('/' + m[2])
    if (cands.length === 1) { inputText = cands[0]; cursor = inputText.length; render() }
    else if (cands.length > 1) {
      pushMessage({ kind: 'result', text: '候选：' + cands.join(' ') })
      render()
    }
  }
  function sendMessage() {
    const text = inputText.trim()
    if (!text) { render(); return }
    if (history[history.length - 1] !== text) history.push(text)
    if (history.length > 50) history.shift()
    historyIdx = -1
    // 命令（支持 /yfw <cmd> 前缀与 yfwturbo 别名）
    const cmdText = text.replace(/^\/yfw\s+/i, '/').replace(/^yfwturbo\s*/i, '').trim()
    if (cmdText.startsWith('/') || /^yfwturbo/i.test(text)) {
      const [cmd] = cmdText.split(/\s+/)
      if (!cmd) pushMessage({ kind: 'system', text: usageText() })
      else runCommand(cmdText)
      inputText = ''
      cursor = 0
      render()
      return
    }
    inputText = ''
    cursor = 0
    pushMessage({ kind: 'user', text })
    turnActive = true
    scrollOffset = 0
    startAnim()
    render()
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
  }

  // ---------- 启动 banner ----------
  function showBanner() {
    if (args.noBanner) return
    const lines = loadBannerLines(args.banner)
    if (!lines) return
    const cols = process.stdout.columns || 100
    const targetW = Math.max(40, cols - 4)
    const srcW = Math.max(...lines.map((l) => l.length))
    const targetH = Math.max(6, Math.min(24, Math.round((targetW * lines.length) / srcW)))
    const scaled = scaleBanner(lines, targetW, targetH)
    const bannerLines = [
      '  ' + c('─'.repeat(Math.min(targetW, cols - 4)), 'border'),
      ...scaled.map((l) => '  ' + paintBannerLine(l)),
      '  ' + c('─'.repeat(Math.min(targetW, cols - 4)), 'border'),
      '  ' + c(`YFWorking 交互终端（YFW-Turbo 内核 ${KERNEL_VERSION}）${args.mock ? '（mock 模式）' : `（model: ${MODEL}）`}  session: ${sessionId}`, 'highlight'),
      '  ' + c('输入消息开始对话；/help 查看命令', 'meta'),
    ]
    pushMessage({ kind: 'banner', lines: bannerLines })
    render()
  }

  // ---------- 生命周期 ----------
  function spawnKernel() {
    const cliArgs = [
      join(KERNEL_DIR, 'cli.mjs'),
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--disallowedTools', 'AskUserQuestion',
      '--model', MODEL,
      '--add-dir', DIR,
    ]
    if (args.resume) cliArgs.push('--resume', args.resume)
    return spawn(process.execPath, cliArgs, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  function enterTui() {
    if (!isTui) return
    process.stdout.write('\x1b[?1049h')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.on('resize', () => render())
  }
  function leaveTui(code = 0) {
    stopAnim()
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch {}
    if (isTui) process.stdout.write('\x1b[?25h\x1b[?1049l\r\n')
    if (code) console.error(`[yfwturbo] 已退出（code ${code}）`)
    process.exit(code)
  }

  // ---------- 启动 ----------
  if (isTui) {
    enterTui()
    const keys = new KeyStream()
    process.stdin.on('data', (buf) => {
      for (const k of keys.push(buf)) handleKey(k)
    })
  } else {
    // 非 TTY：读行转发为消息/命令
    const plain = createInterface({ input: process.stdin })
    plain.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      const cmdText = t.replace(/^\/yfw\s+/i, '/').replace(/^yfwturbo\s*/i, '').trim()
      if (cmdText.startsWith('/')) { runCommand(cmdText); return }
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n')
    })
  }
  child = spawnKernel()
  const childRl = createInterface({ input: child.stdout })
  childRl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let ev
    try { ev = JSON.parse(t) } catch { return }
    handleEvent(ev)
  })
  child.stderr.on('data', (d) => {
    stderrBuf += String(d)
    const lines = stderrBuf.split('\n')
    stderrBuf = lines.pop() // 末尾不完整行留到下一个 chunk
    for (const ln of lines) {
      const t = ln.trim()
      if (!t) continue
      if (isTui) { pushMessage({ kind: 'system', text: `[kernel] ${t}` }); scheduleRender() }
      else console.error(`[kernel-stderr] ${t}`)
    }
  })
  child.on('close', (code) => {
    leaveTui(code ?? 0)
  })
  showBanner()
}

// 直接执行时跑主程序；被 import（测试）时不产生副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
