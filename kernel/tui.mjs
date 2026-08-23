// Ponos-Turbo 交互式 TUI（全屏 ANSI 版，远方品牌橙红深色主题）
// ---------------------------------------------------------------------------
// 用法：
//   node kernel/tui.mjs                     # 新会话；检测到历史时先弹会话选择器
//   node kernel/tui.mjs --resume <sid>      # 恢复既有会话（并投影历史到对话区）
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
//   审批时：按键选择 1=允许 2=拒绝 3=取消（Esc 同取消；兼容输入 allow/deny 回车）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KERNEL_VERSION } from '../version.mjs'
import { resolveConfigDir } from './config.mjs'
import { sanitizeSegment } from './session.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KERNEL_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_BANNER = join(KERNEL_DIR, 'ascii-art-ponos.txt')

// ---------- Provider/模型列表（P4-1 providers.json 快照，与 bridge 同一来源） ----------
// ~/.ponos/providers.json：{ activeProvider, providers: [{ id, apiBaseUrl, authToken,
// primaryModel, models[], subagentModel, contextWindow, visionModel }] }
export function loadProviders(env = process.env) {
  try {
    const file = join(resolveConfigDir(env), 'providers.json')
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    const providers = Array.isArray(data.providers) ? data.providers : []
    if (!providers.length) return null
    return { providers, activeId: data.activeProvider || '' }
  } catch {
    return null
  }
}
// 启动默认模型：env ANTHROPIC_MODEL 优先，其次 providers.json 当前激活 provider，最后内置兜底
export function defaultModel(env = process.env) {
  if (env.ANTHROPIC_MODEL) return env.ANTHROPIC_MODEL
  const cfg = loadProviders(env)
  if (cfg) {
    const active = cfg.providers.find((p) => p.id === cfg.activeId) || cfg.providers[0]
    if (active?.primaryModel) return active.primaryModel
    if (active?.models?.[0]) return active.models[0]
  }
  return 'deepseek-v4-flash'
}

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
  const approvalRows = approval ? 3 : 0
  const viewportRows = Math.max(1, rows - headerRows - footerRows - dividerRows - inputRows - approvalRows)
  return { headerRows, footerRows, dividerRows, inputRows, approvalRows, viewportRows }
}

// ---------- 历史会话扫描与投影（M 系列：恢复历史会话） ----------
// 扫描 <configDir>/projects/<sanitize(cwd)> 下全部 transcript，按最后活动时间倒序
// 返回元信息列表（预览取首条 user 文本，用于启动选择器 / /sessions 展示）。
// 与 server/transcript.mjs 目录约定一致；损坏行跳过、超大文件流式读。
export async function scanSessions({ configDir, cwd, limit = 20 }) {
  const dir = join(configDir, 'projects', sanitizeSegment(cwd))
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const file = join(dir, f)
    let preview = ''
    let count = 0
    let lastTs = ''
    try {
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        let e
        try { e = JSON.parse(t) } catch { continue }
        if (e.type === 'meta' || !e.message || typeof e.message !== 'object') continue
        count++
        if (e.timestamp && e.timestamp > lastTs) lastTs = e.timestamp
        if (!preview && e.message.role === 'user') {
          const c = e.message.content
          preview = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '')
        }
      }
    } catch { continue }
    if (!count) continue // 空 transcript（仅 meta）不列为可恢复会话
    let stat
    try { stat = statSync(file) } catch { continue }
    out.push({
      id: f.replace(/\.jsonl$/, ''),
      preview: preview.replace(/\s+/g, ' ').trim().slice(0, 60),
      count,
      ts: lastTs || stat.mtime.toISOString(),
    })
  }
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
  return out.slice(0, limit)
}

// 读取 transcript 投影为 TUI 消息（--resume / 选择器恢复后填充 viewport）：
// user 文本 / assistant 文本 / tool_use 卡片（历史工具结果不落 transcript 正文，
// 卡片 result 留空显示输入即可）；compaction 摘要显示为 result 行。
// 返回 { msgs, toolCount }（toolCount 用于续接 /tool 展开序号，避免新工具从 1 重排）。
export function readTranscriptHistory(file) {
  const msgs = []
  let toolCount = 0
  let pendingAssistant = null
  const flushAssistant = () => {
    if (pendingAssistant && pendingAssistant.text.trim()) msgs.push(pendingAssistant)
    pendingAssistant = null
  }
  if (!existsSync(file)) return { msgs, toolCount }
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const t = raw.trim()
    if (!t) continue
    let e
    try { e = JSON.parse(t) } catch { continue }
    if (e.type === 'meta') continue
    if (e.kind === 'compaction') {
      flushAssistant()
      if (e.phase === 'summary') msgs.push({ kind: 'result', text: `[压缩摘要] ${String(e.message?.content ?? '').slice(0, 100)}` })
      continue
    }
    const m = e.message
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') continue
    if (m.role === 'user') {
      flushAssistant()
      if (typeof m.content === 'string') {
        if (m.content.trim()) msgs.push({ kind: 'user', text: m.content })
      } else if (Array.isArray(m.content)) {
        // tool_result 块不回填历史工具卡片（无 id 关联）；仅投影纯文本 user 消息
        const texts = m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        if (texts.trim()) msgs.push({ kind: 'user', text: texts })
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        flushAssistant()
        if (m.content.trim()) msgs.push({ kind: 'assistant', text: m.content })
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === 'text') {
            if (!pendingAssistant) pendingAssistant = { kind: 'assistant', text: '', streaming: false }
            pendingAssistant.text += b.text
          } else if (b?.type === 'tool_use') {
            flushAssistant()
            toolCount++
            msgs.push({ kind: 'tool', seq: toolCount, name: b.name, input: b.input, result: '' })
          }
        }
      }
    }
  }
  flushAssistant()
  return { msgs, toolCount }
}

// ---------- 主程序 ----------
function main() {
  // ---------- 参数 ----------
  function parseArgs(argv) {
    const out = { resume: null, mock: false, dir: process.cwd(), banner: DEFAULT_BANNER, noBanner: false, theme: 'dark', allowOutsideDirs: false }
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      const next = () => argv[++i]
      switch (a) {
        case '--resume': out.resume = next(); break
        case '--mock': out.mock = true; break
        case '--dir': out.dir = resolve(next()); break
        case '--allow-outside-dirs': out.allowOutsideDirs = true; break
        case '--banner': out.banner = resolve(next()); break
        case '--no-banner': out.noBanner = true; break
        case '--theme': out.theme = next(); break
        case '--help': case '-h': console.log(usageText()); process.exit(0); break
      }
    }
    return out
  }
  function usageText() {
    return `Ponos 交互终端（Ponos-Turbo 内核 ${KERNEL_VERSION}）
用法: node kernel/tui.mjs [--resume <sid>] [--mock] [--dir <path>] [--banner <file>] [--no-banner] [--theme dark|light] [--allow-outside-dirs]
键位: Enter 发送 · Shift+Enter/Ctrl+J 换行 · ↑↓ 历史 · ←→ 移动 · PgUp/PgDn 滚动 · Ctrl+G/B 顶/底 · Tab 补全
命令（支持 /ponos <cmd> 前缀，别名 ponos-turbo）:
  /cancel  取消当前轮次       /stats   会话统计（轮次/用量）
  /clear   清空对话重显 banner /tools  工具列表
  /help    显示本帮助          /session 会话 ID
  /model   当前模型            /sessions 历史会话选择器（恢复/切换）
  /theme   切换深/亮主题       /tool <n> 展开/折叠工具卡片
  /effort 思考深度档位         /version dev 版本号
  /model 查看模型列表          /model <序号|id|模型名> 切换模型
  /quit    退出
历史: 启动时检测到历史会话自动弹出选择器（↑↓ 选择 Enter 确认 Esc 新建）；/sessions 随时重开
审批: 选择项交互 ↑↓/←→ 移动高亮，Enter 确认（1=允许 2=拒绝 3=取消 数字快捷，Esc 取消）`
  }

  const args = parseArgs(process.argv.slice(2))
  if (args.mock) process.env.PONOS_MOCK_API = '1'
  if (args.mock) process.env.PONOS_MOCK_COMPACT_RESPONSE = '1'
  if (!args.mock) {
    if (process.env.PONOS_MOCK_API === '1') { console.error('错误: PONOS_MOCK_API=1 会走 mock，请清除或加 --mock'); process.exit(2) }
    if (!process.env.ANTHROPIC_BASE_URL) { console.error('错误: 需要 ANTHROPIC_BASE_URL env（或加 --mock）'); process.exit(2) }
  }
  if (args.theme === 'light') { themeName = 'light'; theme = THEMES.light }
  mkdirSync(args.dir, { recursive: true })
  const DIR = args.dir
  const MODEL = defaultModel()
  const CONTEXT_WINDOW = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || 1_000_000) || 1_000_000
  const isTui = !!(process.stdin.isTTY && process.stdout.isTTY)

  // ---------- 状态 ----------
  let sessionId = args.resume || '?'
  let pendingApproval = null
  let approvalSel = 0 // 审批高亮选项：0=允许 1=拒绝 2=取消
  let turnActive = false
  let toolSeq = 0
  // 会话选择器：null = 未激活；激活时 { items, sel, booting }（booting=启动阶段选择，
  // Esc 关闭后走新建会话启动；否则 Esc 仅关闭选择器回到对话）
  let picker = null
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
  let effort = process.env.CLAUDE_CODE_EFFORT_LEVEL || process.env.PONOS_REASONING_EFFORT || 'auto'
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
  const preSpawnLines = [] // 非 TTY：child spawn 前到达的输入行，就绪后重放
  const ICONS = process.env.PONOS_TUI_ICONS === 'ascii' ? { tool: '[工具]', think: '[思考]' } : { tool: '⚙', think: '💭' }

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
    let line1 = c('Ponos', 'orange', true) + c(' · ' + (initInfo.model || MODEL), 'highlight')
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
    const line1 = trunc(title, Math.max(8, cols - 2))
    const line2 = trunc(c('│ 理由：' + reason, 'text'), Math.max(8, cols - 2))
    // 选择项交互：▸ 高亮当前项，↑↓ 移动、Enter 确认、1/2/3 数字快捷、Esc 取消
    const opts = [['1', '允许'], ['2', '拒绝'], ['3', '取消']]
    const optStrs = opts.map(([n, label], i) => {
      const s = `[${n}] ${label}`
      return i === approvalSel ? c('▸ ' + s, 'highlight', true) : c('  ' + s, 'meta')
    })
    const line3 = trunc(c('│ ' + optStrs.join('　'), 'red'), Math.max(8, cols - 2))
    return [line1, line2, line3]
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
    if (picker) {
      const items = picker.items
      // 选中项始终可见（sel 越界时滚动窗口）
      const half = Math.floor(rows / 2)
      let start = picker.sel - half
      if (start < 0) start = 0
      if (start + rows > items.length) start = Math.max(0, items.length - rows)
      const lines = []
      for (let i = start; i < Math.min(start + rows, items.length); i++) {
        const it = items[i]
        const sel = i === picker.sel
        const marker = sel ? c('▸ ', 'orange', true) : '  '
        if (!it.id) {
          lines.push(marker + (sel ? c(it.label, 'highlight', true) : c(it.label, 'meta')))
          continue
        }
        const ts = String(it.ts || '').slice(0, 16).replace('T', ' ')
        const label = `${it.id.slice(0, 8)} · ${ts} · ${it.count} 条 · ${it.preview || '（无文本）'}`
        lines.push(trunc(marker + (sel ? c(label, 'highlight', true) : c(label, 'text')), Math.max(10, cols - 2)))
      }
      return lines
    }
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
          approvalSel = 0 // 新审批默认高亮"允许"
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
      case 'provider_switched':
        initInfo.model = ev.model || initInfo.model
        pushMessage({ kind: 'result', text: `模型已切换：${ev.model}` })
        render(); break
      case 'provider_switch_rejected':
        pushMessage({ kind: 'error', text: `模型切换被拒：${ev.reason || '未知原因'}` })
        render(); break
      case 'ponos_health':
        pushMessage({ kind: 'result', text: `健康 score=${ev.score ?? '?'} tier=${ev.tier ?? '?'}` })
        render(); break
      case 'ponos_summary':
        pushMessage({ kind: 'result', text: `压缩摘要 第 ${ev.compactCount ?? '?'} 次：${String(ev.text || '').slice(0, 120)}` })
        render(); break
      default:
        pushMessage({ kind: 'system', text: `[${ev.type}] ${JSON.stringify(ev).slice(0, 200)}` })
        render()
    }
  }

  // ---------- 命令 ----------
  const COMMANDS = ['/banner', '/cancel', '/clear', '/effort', '/help', '/model', '/quit', '/session', '/sessions', '/stats', '/theme', '/tool', '/tools', '/version', '/exit']
  function sendCancel() {
    // 即时反馈：不等内核 result，先停动画/清除审批横幅/收尾流式尾巴
    stopAnim()
    turnActive = false
    endAssistantStream()
    pendingApproval = null
    approvalSel = 0
    child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
    pushMessage({ kind: 'system', text: '正在中止当前轮次…（可继续输入新消息）' })
    render()
  }
  function runCommand(cmdText) {
    const [cmd, ...rest] = cmdText.split(/\s+/)
    switch (cmd) {
      case '/cancel': sendCancel(); break
      case '/help': case '/ponos': case '/ponos-turbo': pushMessage({ kind: 'system', text: usageText() }); render(); break
      case '/clear': messages = []; toolSeqMap.clear(); showBanner(); break
      case '/stats': pushMessage({ kind: 'result', text: `轮次=${turns} in=${fmtK(usageTotals.input_tokens)} out=${fmtK(usageTotals.output_tokens)} cacheRead=${fmtK(usageTotals.cache_read_input_tokens)} cacheWrite=${fmtK(usageTotals.cache_creation_input_tokens)}` }); render(); break
      case '/tools': pushMessage({ kind: 'result', text: initInfo.tools.length ? initInfo.tools.join(', ') : '（尚未收到 init）' }); render(); break
      case '/session': pushMessage({ kind: 'result', text: sessionId }); render(); break
      case '/sessions': pickerOpen(false); break
      case '/model': {
        const v = (rest[0] || '').trim()
        if (!v) { listModels(); break }
        switchModel(v)
        break
      }
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
      case '/version': pushMessage({ kind: 'result', text: `Ponos-Turbo 内核 ${KERNEL_VERSION}（${initInfo.model || MODEL}）` }); render(); break
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

  // ---------- 模型选择（P4-5 热切换：/model 列表 → switch_provider 控制请求） ----------
  function listModels() {
    const current = initInfo.model || MODEL
    const lines = [`当前模型：${current}`]
    const cfg = loadProviders()
    if (!cfg) {
      lines.push('未找到 providers.json（' + join(resolveConfigDir(process.env), 'providers.json') + '），仅支持 env ANTHROPIC_MODEL 指定模型')
      pushMessage({ kind: 'result', text: lines.join('\n') })
      render()
      return
    }
    cfg.providers.forEach((p, i) => {
      const mark = p.id === cfg.activeId ? c(' ●', 'orange') : ''
      const models = (p.models && p.models.length ? p.models : [p.primaryModel]).filter(Boolean).join(' / ') || '-'
      lines.push(`  ${i + 1}. ${c(p.id, 'highlight')}${mark}（${models}）`)
    })
    lines.push('用法：/model <序号|id|模型名> 切换（空闲时生效，写入 activeProvider）')
    pushMessage({ kind: 'result', text: lines.join('\n') })
    render()
  }
  function switchModel(v) {
    const cfg = loadProviders()
    if (!cfg) {
      pushMessage({ kind: 'error', text: '未找到 providers.json，无法切换模型（/model 查看）' })
      render()
      return
    }
    // 1) 序号
    if (/^\d+$/.test(v)) {
      const p = cfg.providers[Number(v) - 1]
      if (!p) {
        pushMessage({ kind: 'error', text: `序号 ${v} 越界（共 ${cfg.providers.length} 个 provider）` })
        render()
        return
      }
      applySwitch(p, p.primaryModel || p.models?.[0] || '')
      return
    }
    // 2) provider id
    const byId = cfg.providers.find((p) => p.id === v)
    if (byId) { applySwitch(byId, byId.primaryModel || byId.models?.[0] || ''); return }
    // 3) 模型名（跨 provider 匹配）
    const hit = []
    for (const p of cfg.providers) for (const m of p.models || []) if (m === v) hit.push({ p, m })
    if (hit.length === 1) { applySwitch(hit[0].p, hit[0].m); return }
    if (hit.length > 1) {
      pushMessage({ kind: 'error', text: `模型 ${v} 命中多个 provider：${hit.map((h) => h.p.id).join(', ')}，请用序号指定` })
      render()
      return
    }
    pushMessage({ kind: 'error', text: `未找到 ${v}（/model 查看列表）` })
    render()
  }
  function applySwitch(p, modelName) {
    if (turnActive) {
      pushMessage({ kind: 'error', text: '当前轮次进行中，请等待完成后再切换模型' })
      render()
      return
    }
    child.stdin.write(JSON.stringify({
      type: 'control_request',
      request: {
        subtype: 'switch_provider',
        payload: {
          baseUrl: p.apiBaseUrl,
          authToken: p.authToken,
          model: modelName || p.primaryModel || (p.models && p.models[0]) || '',
          contextWindow: p.contextWindow || 0,
        },
      },
    }) + '\n')
    persistActiveProvider(p.id)
    pushMessage({ kind: 'system', text: `已请求切换：${p.id} → ${modelName || p.primaryModel || '(默认)'}` })
    render()
  }
  // 持久化 activeProvider（下次启动 defaultModel 生效）
  function persistActiveProvider(id) {
    try {
      const file = join(resolveConfigDir(process.env), 'providers.json')
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf-8'))
      if (data.activeProvider === id) return
      data.activeProvider = id
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
    } catch (e) {
      pushMessage({ kind: 'system', text: `（提示：activeProvider 持久化失败：${e.message}）` })
    }
  }

  // ---------- 键盘处理 ----------
  // 提交审批回执（allow/deny），选择项 Enter 确认与数字快捷共用
  function resolveApproval(allow) {
    const cr = pendingApproval
    pendingApproval = null
    approvalSel = 0
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
  function handleKey(k) {
    if (k.name === 'unknown') return
    // 会话选择器：↑↓/←→ 移动，Enter 选择，Esc 关闭（booting 阶段关闭即新建会话）
    if (picker) {
      switch (k.name) {
        case 'up': case 'left': picker.sel = (picker.sel + picker.items.length - 1) % picker.items.length; render(); break
        case 'down': case 'right': picker.sel = (picker.sel + 1) % picker.items.length; render(); break
        case 'enter': if (!k.newline) pickConfirm(); break
        case 'escape': pickerClose(); break
        case 'char': if (k.char.toLowerCase() === 'q' || k.char.toLowerCase() === 'n') pickerClose(); break
      }
      return
    }
    // 审批挂起：选择项交互（↑↓/←→ 移动高亮，Enter 确认，1/2/3 数字快捷，Esc 取消）
    if (pendingApproval) {
      if (k.name === 'up' || k.name === 'left') { approvalSel = (approvalSel + 2) % 3; render(); return }
      if (k.name === 'down' || k.name === 'right') { approvalSel = (approvalSel + 1) % 3; render(); return }
      if (k.name === 'enter' && !k.newline) {
        approvalSel === 0 ? resolveApproval(true) : resolveApproval(false)
        return
      }
      if (k.name === 'char') {
        const ch = k.char.toLowerCase()
        if (ch === '1' || ch === 'y' || ch === 'a') return resolveApproval(true)
        if (ch === '2' || ch === 'n' || ch === 'd' || ch === '3') return resolveApproval(false)
        return // 模态选择：忽略其它输入，避免污染输入框
      }
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return resolveApproval(false)
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
    // 命令（支持 /ponos <cmd> 前缀与 ponos-turbo 别名）
    const cmdText = text.replace(/^\/ponos\s+/i, '/').replace(/^ponos-turbo\s*/i, '').trim()
    if (cmdText.startsWith('/') || /^ponos-turbo/i.test(text)) {
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
      '  ' + c(`Ponos 交互终端（Ponos-Turbo 内核 ${KERNEL_VERSION}）${args.mock ? '（mock 模式）' : `（model: ${MODEL}）`}  session: ${sessionId}`, 'highlight'),
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
    if (args.allowOutsideDirs) cliArgs.push('--allow-outside-dirs')
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
    if (code) console.error(`[ponos-turbo] 已退出（code ${code}）`)
    process.exit(code)
  }

  // ---------- 启动（内核子进程装配 + 历史投影） ----------
  // 会话选择器：启动阶段（booting）弹列表（新建/恢复）；Esc 或选"新建"即新会话。
  function pickerOpen(booting = false) {
    if (booting && args.resume) { startKernel(); return } // 显式 --resume 不弹选择器
    if (!booting && turnActive) {
      pushMessage({ kind: 'error', text: '当前轮次进行中，请等待完成后再选择会话' })
      render()
      return
    }
    void scanSessions({ configDir: resolveConfigDir(process.env), cwd: DIR }).then((sids) => {
      if (!sids.length) {
        if (booting) { startKernel(); return }
        pushMessage({ kind: 'result', text: '暂无历史会话（新会话直接开始）' })
        render()
        return
      }
      picker = {
        items: [
          { id: null, label: '＋ 新建会话' },
          ...sids.map((s) => ({
            id: s.id,
            label: `${s.id.slice(0, 8)} · ${String(s.ts || '').slice(0, 16).replace('T', ' ')} · ${s.count} 条 · ${s.preview || '（无文本）'}`,
          })),
        ],
        sel: 0,
        booting,
      }
      render()
    })
  }
  // 确认选择：id=null 新建；否则 resume。booting 阶段确认后启动内核；
  // 运行中（/sessions）选择恢复 → 重启内核装载所选会话。
  function pickConfirm() {
    const it = picker?.items?.[picker.sel]
    if (!it) return
    const wasBooting = picker.booting
    picker = null
    if (it.id) args.resume = it.id
    if (wasBooting) { startKernel(); return }
    restartKernel(it.id)
  }
  function pickerClose() {
    const wasBooting = picker?.booting
    picker = null
    if (wasBooting && !child) startKernel() // Esc → 新建会话直接启动
    else render()
  }
  // 运行中切换到历史会话：kill 旧内核 → 重置本地状态 → 按新 resume 重新装配
  function restartKernel(resumeId) {
    stopAnim()
    turnActive = false
    pendingApproval = null
    approvalSel = 0
    messages = []
    toolSeqMap.clear()
    toolExpanded.clear()
    scrollOffset = 0
    turns = 0
    for (const k of Object.keys(usageTotals)) usageTotals[k] = 0
    if (resumeId) args.resume = resumeId
    try { if (child) { child.removeAllListeners(); child.kill() } } catch {}
    child = null
    startKernel()
  }
  function startKernel() {
    // --resume / 选择恢复：投影历史到对话区（messages 从 transcript 重建，
    // 工具序号续接，避免新工具卡片从 1 重排与历史卡片撞号）
    if (args.resume) {
      try {
        const file = join(resolveConfigDir(process.env), 'projects', sanitizeSegment(DIR), args.resume + '.jsonl')
        const hist = readTranscriptHistory(file)
        if (hist.msgs.length) {
          messages.push(...hist.msgs)
          toolSeq = hist.toolCount
        }
      } catch { /* 历史投影失败不阻塞启动 */ }
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
    // 重放 spawn 前暂存的非 TTY 输入行（管道输入早于内核装配的场景）
    for (const t of preSpawnLines.splice(0)) {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n')
    }
  }
  // 启动入口：TTY 且非 mock 且有历史 → 弹选择器；否则直接启动
  function boot() {
    if (isTui && !args.mock && !args.resume) { pickerOpen(true); return }
    startKernel()
  }
  if (isTui) {
    enterTui()
    const keys = new KeyStream()
    process.stdin.on('data', (buf) => {
      for (const k of keys.push(buf)) handleKey(k)
    })
  } else {
    // 非 TTY：读行转发为消息/命令。child 尚未 spawn 时到达的行暂存，就绪后重放
    // （管道输入可能早于内核子进程装配，直接丢弃会让首个输入静默消失）
    const plain = createInterface({ input: process.stdin })
    plain.on('line', (line) => {
      const t = line.trim()
      if (!t) return
      const cmdText = t.replace(/^\/ponos\s+/i, '/').replace(/^ponos-turbo\s*/i, '').trim()
      if (cmdText.startsWith('/')) { runCommand(cmdText); return }
      if (child) child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n')
      else preSpawnLines.push(t)
    })
    // 管道 EOF → 关闭内核 stdin，内核 readline close → 优雅退出（防挂起）
    plain.on('close', () => { try { child?.stdin.end() } catch {} })
  }
  boot()
}

// 直接执行时跑主程序；被 import（测试）时不产生副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
