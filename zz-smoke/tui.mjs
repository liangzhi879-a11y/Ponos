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
//   /version      显示 dev 版本号
//   /quit         退出
//   审批时：allow / deny（或 y / n / a / d）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { YFW_VERSION } from '../version.mjs'

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
  return `YFW-turbo TUI（${YFW_VERSION}）
用法: node zz-smoke/tui.mjs [--resume <sid>] [--mock] [--dir <path>] [--banner <file>] [--no-banner]
快捷指令（支持 /yfw <cmd> 前缀，别名 yfwturbo）:
  /cancel        取消当前轮次          /stats  会话统计（轮次/用量）
  /clear         清屏并重显 banner     /tools  工具列表
  /help          显示本帮助            /session 会话 ID
  /model         当前模型              /banner 重显艺术字
  /version       dev 版本号            /quit  退出
审批: allow / deny（或 y / n / a / d）`
}

// ---------- 艺术字缩放（亮度重采样，适配终端宽度） ----------
// 渐变块字符斜坡（无 @ = O 等符号）：空白 → ░ → ▒ → ▓ → 全块
const CHARS = [' ', '░', '▒', '▓', '█']
const CHAR_BRIGHTNESS = { ' ': 0, '.': 0.16, '`': 0.3, ',': 0.16, '/': 0.5, '\\': 0.5, '^': 0.5, '[': 0.66, ']': 0.66, '=': 0.82, '-': 0.82, 'O': 0.92, '@': 1, '░': 0.25, '▒': 0.5, '▓': 0.75, '█': 1 }

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

// 行缓冲切分（纯函数，便于测试）：从缓冲+新块中取出"以 \n 结尾的完整行"，
// 保留末尾不完整行。使流式输出多行内容（代码块/列表）正常分行而不逐 token 闪跳
export function bufferChunk(buf, chunk) {
  const combined = buf + chunk
  const nl = combined.lastIndexOf('\n')
  if (nl < 0) return { complete: '', rest: combined }
  return { complete: combined.slice(0, nl + 1), rest: combined.slice(nl + 1) }
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
// 品牌色：YFW brand-500 #ff6a00（src/styles/themes.css）——真彩色 VT（conhost
// 1709+ / Windows Terminal 支持）。键名沿用 cyan/green/yellow/magenta 以兼容
// 现有调用点，语义映射为品牌橙系。
const BRAND = '\x1b[38;2;255;106;0m'          // #ff6a00 品牌橙
const BRAND_BRIGHT = '\x1b[38;2;251;146;60m'  // #fb923c brand-400（正文/强调）
const COLORS = {
  cyan: BRAND,
  green: BRAND_BRIGHT,
  yellow: BRAND,
  magenta: BRAND_BRIGHT,
  dim: '\x1b[2m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m',
}
let useColor = process.stdout.isTTY && !process.env.NO_COLOR

function main() {
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
let toolSeq = 0 // 工具调用序号（卡片显示）
let streamBuf = '' // 当前不完整流式行（无 \n 结尾）
let streamDirty = false // 屏幕上是否存在未换行的流式半行
let thinkingBuf = '' // 思考累积缓冲（逐 token 增量 → 静默累积，段末折叠）
let thinkingDirty = false
let turns = 0 // 已完成轮次
let usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
let initInfo = { model: '', tools: [] } // init 事件缓存（/tools /model 用）

let lineWidth = 0 // 当前行已写可见宽度（重绘前擦除用）
let thinkingHinted = false // 思考占位是否已显示（静默累积模式）
function paint(text, color) {
  return useColor ? `${COLORS[color] ?? ''}${text}${COLORS.reset}` : text
}
// 艺术字行主题色化：浅块（░▒）用 brand-400 亮橙，实块（▓█）用 brand-500 主橙，
// 空格不着色，形成品牌色渐变
function paintBannerLine(line) {
  if (!useColor) return line
  let out = ''
  for (const ch of line) {
    if (ch === '░' || ch === '▒') out += BRAND_BRIGHT + ch + COLORS.reset
    else if (ch === '▓' || ch === '█') out += BRAND + ch + COLORS.reset
    else out += ch
  }
  return out
}
// 可见宽度：跳过 ANSI 序列，东亚宽字符按 2 计（擦除用，过估优于不足）
function visWidth(str) {
  const s = String(str)
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x1b) { while (i < s.length && s[i] !== 'm') i++; continue }
    w += c >= 0x2E80 ? 2 : 1
  }
  return w
}
// 擦除当前行（\r + 空格 + \r，不依赖 ANSI 清行——cmd conhost 默认不解释
// \x1b[2K，会导致流式重绘文本叠加）。宽度取当前行已写与输入行两者较大者，
// 并封顶窗口列宽（超宽行在 conhost 会自动换行，\r 回到换行后行首导致擦除错位）。
function clearLine() {
  const cols = process.stdout.columns || 120
  const inputW = (rl._prompt ? visWidth(rl._prompt) : 0) + (rl.line ? visWidth(rl.line) : 0)
  const w = Math.min(Math.max(lineWidth, inputW), cols)
  if (w) rl.output.write('\r' + ' '.repeat(w) + '\r')
  lineWidth = 0
}
// 输出事件行：先清当前行，打印（\r\n 保证 conhost 换行），再重绘 prompt + 已输入
// （非 TTY/管道场景直接输出，避免控制码乱入）
function emitLine(text) {
  if (!process.stdin.isTTY) { console.log(text); return }
  const cur = rl.line ?? ''
  clearLine()
  rl.output.write(text + '\r\n')
  if (rl._prompt) rl.output.write(rl._prompt + cur)
}
// 流式文本输出：完整行直接落地（自然换行），当前半行擦除重绘
function emitStream(chunk) {
  if (!process.stdin.isTTY) { streamBuf += chunk; streamDirty = true; return }
  const { complete, rest } = bufferChunk(streamBuf, chunk)
  streamBuf = rest
  if (complete) {
    clearLine()
    rl.output.write(paint(complete, 'green'))
    // complete 以 \n 结尾：光标已到下一行行首，当前行宽归零
  }
  if (streamBuf) {
    clearLine()
    // 半行预览截断到窗口宽度内（超宽会触发 conhost 自动换行 → \r 擦除错位）
    const cols = process.stdout.columns || 120
    const shown = visWidth(streamBuf) > cols - 4 ? streamBuf.slice(0, Math.max(8, cols - 6)) + '…' : streamBuf
    rl.output.write(paint(shown, 'green'))
    lineWidth = visWidth(shown)
  }
}
function flushStream() {
  if (process.stdin.isTTY) {
    if (streamDirty) {
      clearLine()
      rl.output.write(paint(streamBuf, 'green') + '\r\n')
    }
  } else if (streamBuf) {
    console.log(streamBuf)
  }
  streamBuf = ''
  streamDirty = false
  lineWidth = 0
}
// 思考增量：静默累积，不逐 token 重绘（滚动重绘在窄窗口/非 VT 终端下
// 极易叠加重复，成熟方案默认折叠思考）。首次出现显示静态占位，段末折叠输出。
function emitThinking(chunk) {
  thinkingBuf += chunk
  if (!process.stdin.isTTY) { thinkingDirty = true; return }
  if (!thinkingHinted) {
    clearLine()
    rl.output.write(paint('[思考中…]', 'dim'))
    lineWidth = visWidth('[思考中…]')
    thinkingHinted = true
  }
  thinkingDirty = true
}
// 思考段结束：折叠为一行（截断 + …），换行收尾
function flushThinking() {
  if (!thinkingBuf && !thinkingDirty) return
  const text = thinkingBuf.replace(/\s+/g, ' ').trim()
  if (process.stdin.isTTY) {
    clearLine()
    rl.output.write(paint('[思考] ' + (text.length > 200 ? text.slice(0, 200) + '…' : text), 'dim') + '\r\n')
  } else if (text) {
    console.log('[思考] ' + text)
  }
  thinkingBuf = ''
  thinkingDirty = false
  thinkingHinted = false
  lineWidth = 0
}
// 统一收尾：思考 + 文本全部落地
function flushAll() {
  flushThinking()
  flushStream()
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
        initInfo.model = ev.model || ''
        initInfo.tools = ev.tools || []
        emitLine(paint(`[init] model=${ev.model} tools=${(ev.tools || []).join(',')} session=${ev.session_id}`, 'cyan'))
      }
      break
    case 'assistant': {
      const blocks = ev.message?.content ?? ev.blocks
      for (const b of blocks || []) {
        if (b?.type === 'text') { flushThinking(); emitStream(b.text) }
        else if (b?.type === 'thinking') emitThinking(b.thinking)
        else if (b?.type === 'tool_use') { flushAll(); toolSeq++; emitLine(paint(`[工具 ${toolSeq}] ${b.name}(${JSON.stringify(b.input)})`, 'yellow')) }
        else { flushAll(); emitLine(`[assistant] ${JSON.stringify(b)}`) }
      }
      break
    }
    case 'control_request': {
      const req = ev.request
      if (req?.subtype === 'can_use_tool') {
        flushAll()
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
      flushAll()
      const u = ev.usage || {}
      turns++
      for (const k of Object.keys(usageTotals)) usageTotals[k] += u[k] ?? 0
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
  // 命令（支持 /yfw <cmd> 前缀与 yfwturbo 别名）
  const cmdText = text.replace(/^\/yfw\s+/i, '/').replace(/^yfwturbo\s*/i, '').trim()
  if (cmdText.startsWith('/') || /^yfwturbo/i.test(text)) {
    const [cmd, ...rest] = cmdText.split(/\s+/)
    if (!cmd) { emitLine(usageText()); rl.prompt(); return } // 裸 yfwturbo → 帮助菜单
    switch (cmd) {
      case '/cancel': {
        child.stdin.write(JSON.stringify({ type: 'control_request', request: { subtype: 'cancel' } }) + '\n')
        emitLine(paint('[命令] 已发送取消', 'yellow'))
        break
      }
      case '/help': emitLine(usageText()); break
      case '/yfw': case '/yfwturbo': emitLine(usageText()); break
      case '/clear': {
        // conhost 不解释 ANSI 清屏：退化为输出空行 + 重显 banner
        const rows = process.stdout.rows || 40
        rl.output.write('\r\n'.repeat(Math.max(5, rows)))
        showBanner()
        break
      }
      case '/stats': {
        emitLine(paint(`[统计] 轮次=${turns}  in=${usageTotals.input_tokens} out=${usageTotals.output_tokens} cacheRead=${usageTotals.cache_read_input_tokens} cacheWrite=${usageTotals.cache_creation_input_tokens}`, 'cyan'))
        break
      }
      case '/tools': emitLine(paint(`[工具] ${initInfo.tools.length ? initInfo.tools.join(', ') : '（尚未收到 init）'}`, 'cyan')); break
      case '/session': emitLine(paint(`[会话] ${sessionId}`, 'cyan')); break
      case '/model': emitLine(paint(`[模型] ${initInfo.model || MODEL}`, 'cyan')); break
      case '/version': emitLine(paint(`[版本] ${YFW_VERSION}（${initInfo.model || MODEL}）`, 'cyan')); break
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
  flushAll()
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
  // 主题色渲染：密度渐变块按品牌双色（浅块 brand-400、实块 brand-500）逐字着色
  for (const l of scaled) emitLine(paintBannerLine(l))
  emitLine(paint('─'.repeat(Math.min(targetW, cols)), 'dim'))
  emitLine(paint(`YFWorking 交互终端 ${YFW_VERSION}${args.mock ? '（mock 模式）' : `（model: ${MODEL}）`}  session: ${sessionId}`, 'cyan'))
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
} // end main

// 直接执行时跑主程序；被 import（测试）时不产生副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
