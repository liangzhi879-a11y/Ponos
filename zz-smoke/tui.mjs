// YFW-turbo 内核交互式 TUI（完整交互：发消息 / 流式回复 / 取消 / 工具审批）
// ---------------------------------------------------------------------------
// 用法：
//   node zz-smoke/tui.mjs                    # 新会话（ANTHROPIC_* env 已配置）
//   node zz-smoke/tui.mjs --resume <sid>     # 恢复既有会话
//   node zz-smoke/tui.mjs --mock             # 离线 mock 模式（无网络，测交互链路）
//   node zz-smoke/tui.mjs --dir <path>       # 指定会话工作目录（默认当前目录）
//   node zz-smoke/tui.mjs --banner <file>    # 指定启动艺术字文件
//   node zz-smoke/tui.mjs --no-banner        # 不显示艺术字
// 交互：
//   <任意文本>    发送用户消息
//   /cancel       取消当前轮次
//   /help         显示命令
//   /banner       重显艺术字
//   /quit         退出
//   审批时：allow / deny（或 y / n / a / d）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_BANNER = join(ROOT, 'zz-smoke', 'yfw-banner.txt')

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { resume: null, mock: false, dir: process.cwd(), banner: DEFAULT_BANNER, noBanner: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--resume': out.resume = next(); break
      case '--mock': out.mock = true; break
      case '--dir': out.dir = resolve(next()); break
      case '--banner': out.banner = resolve(next()); break
      case '--no-banner': out.noBanner = true; break
      case '--help': case '-h': console.log(usageText()); process.exit(0); break
    }
  }
  return out
}
function usageText() {
  return `YFW-turbo TUI
用法: node zz-smoke/tui.mjs [--resume <sid>] [--mock] [--dir <path>] [--banner <file>] [--no-banner]
命令: /cancel /help /banner /quit
审批: allow / deny（或 y / n / a / d）`
}

// ---------- 艺术字缩放（亮度重采样，适配终端宽度） ----------
const CHARS = [' ', '.', '`', '/', '=', 'O', '@'] // 亮度递增的字符斜坡
const CHAR_BRIGHTNESS = { ' ': 0, '.': 0.16, '`': 0.3, ',': 0.16, '/': 0.5, '\\': 0.5, '^': 0.5, '[': 0.66, ']': 0.66, '=': 0.82, '-': 0.82, 'O': 0.92, '@': 1 }

function brightnessOf(ch) {
  return CHAR_BRIGHTNESS[ch] ?? 0.5
}
function charFor(b) {
  const idx = Math.round(b * (CHARS.length - 1))
  return CHARS[Math.max(0, Math.min(CHARS.length - 1, idx))]
}

// 读取艺术字 → 有效行（去掉全空白行、行尾空白）
function loadBannerLines(file) {
  if (!file || !existsSync(file)) return null
  const raw = readFileSync(file, 'utf-8').split('\n')
  const lines = raw.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0)
  return lines.length ? lines : null
}

// 缩放到 targetW × targetH（亮度均值重采样）
export function scaleBanner(lines, targetW, targetH) {
  const srcH = lines.length
  const srcW = Math.max(...lines.map((l) => l.length))
  if (srcW <= targetW && srcH <= targetH) {
    // 源图比目标小：直接居中返回
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

// ---------- 终端颜色 ----------
const COLORS = {
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', dim: '\x1b[2m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m',
}
let useColor = process.stdout.isTTY && !process.env.NO_COLOR

// ---------- 主程序 ----------
const args = parseArgs(process.argv.slice(2))
if (args.mock) process.env.YFW_MOCK_API = '1'
if (args.mock) process.env.YFW_MOCK_COMPACT_RESPONSE = '1'
if (!args.mock) {
  if (process.env.YFW_MOCK_API === '1') { console.error('错误: YFW_MOCK_API=1 会走 mock，请清除或加 --mock'); process.exit(2) }
  if (!process.env.ANTHROPIC_BASE_URL) { console.error('错误: 需要 ANTHROPIC_BASE_URL env（或加 --mock）'); process.exit(2) }
}
// --add-dir 必须存在（否则工具 spawn 子进程 cwd 无效 → ENOENT）
mkdirSync(args.dir, { recursive: true })
const DIR = args.dir
const MODEL = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'

let sessionId = args.resume || '?'

// ---------- spawn 内核 ----------
// 注意：必须在 rl 创建后 spawn（init 事件经 childRl 消费，childRl 依赖 rl 的
// emitLine/prompt 重绘；提前 spawn 会丢失 init 事件）
const cliArgs = [
  join(ROOT, 'kernel', 'cli.mjs'),
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--disallowedTools', 'AskUserQuestion',
  '--model', MODEL,
  '--add-dir', DIR,
]
if (args.resume) cliArgs.push('--resume', args.resume)

// ---------- 事件流处理 ----------
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
rl.setPrompt(useColor ? `${COLORS.cyan}yfw> ${COLORS.reset}` : 'yfw> ')

const child = spawn(process.execPath, cliArgs, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
const childRl = createInterface({ input: child.stdout })

let pendingApproval = null // can_use_tool 挂起中：{ cr }
let turnActive = false
let streamBuf = '' // 当前流式文本缓冲
let streamDirty = false // 流式行是否已在屏幕

function paint(text, color) {
  return useColor ? `${COLORS[color] ?? ''}${text}${COLORS.reset}` : text
}
// 输出事件行：先清当前输入行，打印，再重绘 prompt + 已输入内容
// （非 TTY/管道场景直接输出，避免控制码乱入）
function emitLine(text) {
  if (!process.stdin.isTTY) { console.log(text); streamDirty = false; return }
  const cur = rl.line ?? ''
  rl.output.write('\r\x1b[2K')
  rl.output.write(text + '\n')
  if (rl._prompt) rl.output.write(rl._prompt + cur)
  streamDirty = false
}
// 流式输出：增量追加到当前行（不换行），保持输入行下方
function emitStream(chunk) {
  if (!process.stdin.isTTY) { streamBuf += chunk; streamDirty = true; return }
  streamBuf += chunk
  rl.output.write('\r\x1b[2K')
  rl.output.write(paint(streamBuf, 'green'))
  streamDirty = true
}
function flushStream() {
  if (streamDirty) {
    emitLine(paint(streamBuf, 'green'))
  }
  streamBuf = ''
  streamDirty = false
}

function fmtBlocks(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b?.type === 'text') return b.text
      if (b?.type === 'thinking') return `[思考] ${b.thinking}`
      if (b?.type === 'tool_use') return `[工具] ${b.name}(${JSON.stringify(b.input)})`
      return JSON.stringify(b)
    })
    .join('')
}

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        sessionId = ev.session_id
        emitLine(paint(`[init] model=${ev.model} tools=${(ev.tools || []).join(',')} session=${ev.session_id}`, 'cyan'))
      }
      break
    case 'assistant': {
      const blocks = ev.message?.content ?? ev.blocks
      for (const b of blocks || []) {
        if (b?.type === 'text') emitStream(b.text)
        else if (b?.type === 'thinking') flushStream(), emitLine(paint(`[思考] ${b.thinking}`, 'dim'))
        else if (b?.type === 'tool_use') flushStream(), emitLine(paint(`[工具] ${b.name}(${JSON.stringify(b.input)})`, 'yellow'))
        else flushStream(), emitLine(`[assistant] ${JSON.stringify(b)}`)
      }
      break
    }
    case 'control_request': {
      const req = ev.request
      if (req?.subtype === 'can_use_tool') {
        flushStream()
        emitLine(paint(`[审批] ${req.tool_name} 请求执行，理由：${req.decision_reason || req.reason || '-'}`, 'magenta'))
        emitLine(`        ${JSON.stringify(req.input)}`)
        emitLine(paint('        输入 allow / deny（或 y / n）', 'dim'))
        pendingApproval = ev
        rl.setPrompt(useColor ? `${COLORS.magenta}审批> ${COLORS.reset}` : '审批> ')
        rl.prompt()
      }
      break
    }
    case 'result': {
      flushStream()
      const u = ev.usage || {}
      const ms = ev.duration_ms
      const usageStr = `in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0}`
      emitLine(paint(`[result] ${usageStr}${ms != null ? ` (${ms}ms)` : ''}`, 'dim'))
      turnActive = false
      rl.setPrompt(useColor ? `${COLORS.cyan}yfw> ${COLORS.reset}` : 'yfw> ')
      rl.prompt()
      break
    }
    case 'yfw_health': {
      emitLine(paint(`[健康] score=${ev.score ?? '?'} tier=${ev.tier ?? '?'}`, 'green'))
      break
    }
    case 'yfw_summary': {
      emitLine(paint(`[压缩摘要] 第 ${ev.compactCount ?? '?'} 次：${String(ev.text || '').slice(0, 120)}`, 'dim'))
      break
    }
    default:
      emitLine(`[event:${ev.type}] ${JSON.stringify(ev).slice(0, 200)}`)
  }
}

// ---------- readline 输入 ----------
rl.on('line', (line) => {
  const text = line.trim()
  // 审批挂起：输入被当作审批回执
  if (pendingApproval) {
    const allow = /^(allow|y|yes|a)$/i.test(text)
    const deny = /^(deny|n|no|d)$/i.test(text)
    if (!allow && !deny) {
      emitLine(paint('[审批] 请输入 allow / deny（或 y / n）', 'magenta'))
      rl.prompt()
      return
    }
    const cr = pendingApproval
    pendingApproval = null
    rl.setPrompt(useColor ? `${COLORS.cyan}yfw> ${COLORS.reset}` : 'yfw> ')
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
    emitLine(allow ? paint('[审批] 已批准，继续执行', 'green') : paint('[审批] 已拒绝', 'red'))
    rl.prompt()
    return
  }
  // 命令
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(/\s+/)
    switch (cmd) {
      case '/cancel': {
        child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
        emitLine(paint('[命令] 已发送取消', 'yellow'))
        break
      }
      case '/help': emitLine(usageText()); break
      case '/banner': showBanner(); break
      case '/quit': case '/exit': {
        rl.close()
        return
      }
      default: emitLine(paint(`未知命令 ${cmd}，/help 查看`, 'red'))
    }
    rl.prompt()
    return
  }
  // 普通消息
  if (!text) { rl.prompt(); return }
  flushStream()
  turnActive = true
  emitLine(paint(`[你] ${text}`, 'bold'))
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
})

// ---------- 启动 ----------
function showBanner() {
  if (args.noBanner) return
  const lines = loadBannerLines(args.banner)
  if (!lines) return
  const cols = process.stdout.columns || 100
  const targetW = Math.max(40, cols - 2)
  // 高度按源宽高比缩放，上限 ~24 行
  const srcW = Math.max(...lines.map((l) => l.length))
  const targetH = Math.max(6, Math.min(24, Math.round((targetW * lines.length) / srcW)))
  const scaled = scaleBanner(lines, targetW, targetH)
  emitLine(paint('─'.repeat(Math.min(targetW, cols)), 'dim'))
  for (const l of scaled) emitLine(l)
  emitLine(paint('─'.repeat(Math.min(targetW, cols)), 'dim'))
  emitLine(paint(`YFW-turbo 交互终端${args.mock ? '（mock 模式）' : `（model: ${MODEL}）`}  session: ${sessionId}`, 'cyan'))
  emitLine(paint('输入消息开始对话；/help 查看命令', 'dim'))
}
showBanner()
rl.prompt()

// ---------- 内核事件读取 ----------
childRl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let ev
  try { ev = JSON.parse(t) } catch { return }
  handleEvent(ev)
})
child.stderr.on('data', (d) => emitLine(paint(`[kernel-stderr] ${d}`, 'red')))
child.on('close', (code) => {
  emitLine(paint(`\n[kernel] 已退出（code ${code}）`, 'dim'))
  process.exit(code ?? 0)
})
rl.on('close', () => {
  try { child.stdin.end() } catch {}
})
// Ctrl+C：优先取消活跃轮次，无轮次则退出
rl.on('SIGINT', () => {
  if (turnActive) {
    emitLine(paint('[命令] 已发送取消（Ctrl+C）', 'yellow'))
    child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
  } else {
    rl.close()
  }
})
