// Ponos-turbo 工具注册表与执行器（docs/bridge-contract.md §9 替换面：工具执行器）
// ---------------------------------------------------------------------------
// 工具集：Bash（shell 执行，高危命令经 permissions 审批）、Read/Write/Edit
// （文件读写与编辑，路径边界校验）、Glob/Grep（边界内搜索）、Agent（子代理
// 分发，执行体在 engine）、Task（后台任务管理）、TodoWrite（任务规划）、
// WebFetch（URL 抓取，零依赖 Node https）。OCR 与 Vision 已拆至
// `kernel/media-tools.mjs`（P2-1 第二刀），本模块只做注册与转发。
// 返回统一结果 { content, isError, meta? }，由 engine 以 tool_result 回填模型。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, join, extname } from 'node:path'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { get as httpGet, request as httpRequest } from 'node:http'
import { matchesHighRisk } from './highrisk.mjs'
import { discoverSkillsAll, loadSkillContent } from './skills.mjs'
import { isDisabled } from './disabled.mjs'
import { searchSkills } from './skill-search.mjs'
import { searchLocalMemory } from './memory-search.mjs'
import { searchKnowledge, searchKnowledgeItems, expandRelated, RELATED_EXPAND_LIMIT } from './knowledge-search.mjs'
import { getProvider, visionEnv } from './provider.mjs'
import { perfTime } from './perf.mjs'
// P2-1 巨石瘦身：子进程登记 / 子进程 env 白名单 / 文件路径边界已下沉到
// `kernel/exec-base.mjs`（多模块共用的"管道"，自身只依赖 node 内置）。下沉后依赖方向
// 是单向 DAG：exec-base ← {tools, media-tools} ← knowledge-import。
//
// 这三项仍在**本文件 re-export**，是为了保持既有 import 路径不变：`cli.mjs`/`engine.mjs`
// 取 `killActiveChildren`。
import {
  registerChild, killActiveChildren, childEnv, findGitBash,
  safeRealpath, realForComparison, withinBoundary, resolvePath,
} from './exec-base.mjs'
export { registerChild, killActiveChildren, childEnv } from './exec-base.mjs'
// P2-1 第二刀：OCR 与 Vision 拆至 `kernel/media-tools.mjs`（这两族工具与工具注册表之间
// **没有共享状态**，也不依赖本模块的任何工具逻辑）。这里的 import 是**自用**——注册表里
// 两条工具的 run 转发过去。
// 关键收益：`knowledge-import.mjs` 从此直接从 media-tools 取 `findOcrEngine`/`visionDescribe`，
// **不再依赖本模块** ⇒ `tools ↔ knowledge-import` 的文件级环消失（此前靠动态 import 回避，
// 但图谱生成器把动态 import 也计为边，环依旧存在）。
import { findOcrEngine, ocrFile, visionDescribe } from './media-tools.mjs'

const BASH_TIMEOUT_MS = 120_000
// Read 一次读取的容量上限（含截断提示，让模型知道如何继续）：
// 模型看到声明后放心一次读全文，不再用 sed/python 碎片化取样。
const READ_MAX_LINES = 2000
const READ_MAX_BYTES = 2 * 1024 * 1024

function runShell(command, cwd) {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    let shell, args
    if (isWin) {
      const bash = findGitBash()
      if (bash) { shell = bash; args = ['-c', command] }
      else { shell = 'cmd.exe'; args = ['/d', '/s', '/c', command] }
    } else { shell = 'sh'; args = ['-c', command] }
    const child = registerChild(spawn(shell, args, {
      cwd: cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    }))
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (content, isError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ content, isError })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(`命令超时（${BASH_TIMEOUT_MS}ms）`, true)
    }, BASH_TIMEOUT_MS)
    // A4 截断标记：超限保留尾部并显式标注，防模型误以为看到完整输出
    const truncated = []
    child.stdout.on('data', (d) => {
      stdout += d.toString()
      if (stdout.length > 200_000) { stdout = stdout.slice(-200_000); if (!truncated.includes('stdout')) truncated.push('stdout') }
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 100_000) { stderr = stderr.slice(-100_000); if (!truncated.includes('stderr')) truncated.push('stderr') }
    })
    child.on('error', (e) => finish(`命令启动失败：${e.message}`, true))
    child.on('close', (code) => {
      const out = stdout.trim()
      const err = stderr.trim()
      const truncMark = truncated.length
        ? `\n[truncated: ${truncated.join('/')} 输出超过上限，已截断保留尾部]`
        : ''
      const body = (code === 0
        ? (out || '(命令执行完成，无输出)')
        : `退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err : ''}`.trim()) + truncMark
      finish(body, code !== 0)
    })
  })
}

// 文件路径边界（safeRealpath / realForComparison / withinBoundary）与相对路径解析
// （resolvePath）已下沉到 kernel/exec-base.mjs —— 它们是多模块共用的边界纪律，
// 且媒体簇（OCR/视觉）也需要 withinBoundary，下沉后媒体模块可单向依赖 exec-base。

// Read 去重 stub：全量读过的文件在 mtime/size
// 未变时再次读取返回 stub，提示直接引用此前结果——省去模型重复读同一文件
// 的往返与 token（T003 上轮 Read 6 次中部分为重复读）。
const READ_STUB_PREFIX = '文件自上次读取后未变化'

function readFile(filePath, allowDirs, input = {}, cwd, readCache, skipBoundary, allowFiles) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    const resolved = resolvePath(filePath, cwd)
    const fileAllowed = allowFiles && allowFiles.has(resolved.toLowerCase())
    if (!skipBoundary && !withinBoundary(resolved, allowDirs) && !fileAllowed) return { content: `拒绝访问：路径超出会话目录边界（${resolved}）`, isError: true }
    if (!existsSync(resolved)) return { content: `文件不存在：${resolved}（当前工作目录：${cwd || process.cwd()}；可用 Glob 定位候选文件或用绝对路径）`, isError: true }
    const st = statSync(resolved)
    if (st.isDirectory()) return { content: `是目录：${resolved}`, isError: true }
    // 超大文件不直接读全文（读一半即 2MB 内存），改为报错 + 定向读取建议
    // （让模型知道用什么参数继续，而非猜）
    if (st.size > READ_MAX_BYTES) {
      return { content: `文件过大（${st.size} 字节），超出 ${READ_MAX_BYTES} 字节读取上限；请用 offset/limit 参数定向读取（offset 起始行号，limit 行数）`, isError: true }
    }
    // 二进制文件引导：先探测魔数，图片/PDF 等直接引导走 OCR/专用工具，
    // 避免把二进制当文本读出乱码（isBinary 检测）。
    const BINARY_MAGIC = [
      ['PNG', [0x89, 0x50, 0x4e, 0x47]],
      ['JPEG', [0xff, 0xd8, 0xff]],
      ['GIF', [0x47, 0x49, 0x46, 0x38]],
      ['BMP', [0x42, 0x4d]],
      ['WebP', [0x52, 0x49, 0x46, 0x46]],
      ['PDF', [0x25, 0x50, 0x44, 0x46]],
      ['ZIP', [0x50, 0x4b, 0x03, 0x04]],
      ['DOCX/XLSX/PPTX', [0x50, 0x4b, 0x03, 0x04]],
    ]
    const probeHead = readFileSync(resolved, 'latin1').slice(0, 8)
    const headBytes = [...probeHead].map((c) => c.charCodeAt(0))
    const isImage = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(resolved)
    const isPdf = /\.pdf$/i.test(resolved)
    let binaryHint = ''
    if (isImage) binaryHint = `这是图片文件（${extname(resolved)}）——提取图中文字用 OCR 工具，理解版面/语义用 Vision 工具`
    else if (isPdf) binaryHint = `这是 PDF 文件——含文本层可用 Bash python doc_toolkit 提取，扫描件用 OCR 工具`
    else {
      for (const [name, magic] of BINARY_MAGIC) {
        if (magic.every((b, i) => headBytes[i] === b)) {
          binaryHint = `这是二进制文件（${name}）——文本内容请用 OCR 或对应文档工具提取`
          break
        }
      }
    }
    if (binaryHint) {
      return { content: `Read 仅支持文本文件：${resolved}\n${binaryHint}`, isError: true }
    }
    const full = readFileSync(resolved, 'utf-8')
    // offset/limit：按行范围读取（offset 从 1 开始，limit=行数，均可选）
    const offset = Number(input.offset)
    const limit = Number(input.limit)
    // 行数计算：split 会为末尾换行产生空元素，不计为行
    const totalLines = full.endsWith('\n') ? full.split('\n').length - 1 : full.split('\n').length
    const lineSlice = (from0, to1) => {
      const all = full.split('\n')
      const slice = all.slice(from0, to1)
      return { content: slice.join('\n') + (slice.length ? '\n' : ''), slice }
    }
    // 部分读取时追加进度指引（"[Showing X-Y of N. Use offset=Z to continue]"）：
    // 模型无需猜测文件大小与剩余内容，直接按指引续读，杜绝碎片化试错
    const progressHint = (start, end) => {
      const last = Math.min(end, totalLines)
      if (last >= totalLines) return ''
      return `\n\n[共 ${totalLines} 行，已显示 ${start}-${last}；用 offset=${last + 1} 继续读取剩余 ${totalLines - last} 行]`
    }
    if (Number.isFinite(offset) && offset > 0) {
      const start = offset - 1
      const end = Number.isFinite(limit) && limit > 0 ? start + limit : totalLines
      const { content } = lineSlice(start, end)
      const last = Math.min(end, totalLines)
      return { content: content + progressHint(offset, last), isError: false, meta: { range: [offset, last], totalLines } }
    }
    if (Number.isFinite(limit) && limit > 0) {
      const { content } = lineSlice(0, limit)
      const last = Math.min(limit, totalLines)
      return { content: content + progressHint(1, last), isError: false, meta: { range: [1, last], totalLines } }
    }
    // 全量读：先查去重缓存（mtime/size 未变且此前全量读完 → stub，省重复读往返；
    // 同款语义）。部分读取（offset/limit）不参与去重——定向
    // 读是有意取特定范围，且不视为"已有全部内容"。
    const cached = readCache?.get(resolved)
    if (cached?.fullRead && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { content: `${READ_STUB_PREFIX}（${resolved}，${st.size} 字节）。此前 Read 的结果仍有效，直接引用，无需重复读取。`, isError: false }
    }
    // 全量读成功 → 记录缓存（mtime/size 供下次去重）
    if (readCache) readCache.set(resolved, { mtimeMs: st.mtimeMs, size: st.size, fullRead: true })
    return { content: full }
  } catch (e) {
    return { content: `读取失败：${e.message}`, isError: true }
  }
}

function writeFile(filePath, content, allowDirs, cwd, readCache, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    const resolved = resolvePath(filePath, cwd)
    if (!skipBoundary && !withinBoundary(resolved, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${resolved}）`, isError: true }
    writeFileSync(resolved, String(content ?? ''), 'utf-8')
    readCache?.delete(resolved) // 文件已变，失效去重缓存
    return { content: `已写入 ${resolved}（${String(content ?? '').length} 字符）` }
  } catch (e) {
    return { content: `写入失败：${e.message}`, isError: true }
  }
}

// Edit：先读后改的字符串替换。old_string 需在文件中唯一（否则要求 replace_all）。
function editFile(filePath, oldString, newString, replaceAll, allowDirs, cwd, readCache, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    const resolved = resolvePath(filePath, cwd)
    if (!skipBoundary && !withinBoundary(resolved, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${resolved}）`, isError: true }
    if (!existsSync(resolved)) return { content: `文件不存在：${resolved}（当前工作目录：${cwd || process.cwd()}；可用 Glob 定位候选文件或用绝对路径）`, isError: true }
    if (typeof oldString !== 'string' || !oldString) return { content: 'old_string 缺失或为空', isError: true }
    if (typeof newString !== 'string') return { content: 'new_string 必须为字符串', isError: true }
    // CRLF 行尾归一化（replaceAll('\r\n','\n')）：
    // Windows 仓库文件普遍 CRLF，模型（LF 习惯）写的 old_string 若严格字节匹配
    // 永不命中 → 连续失败重试 + 转 python repr 验证字节（T003 实测 34 次工具里
    // Edit 连环失败即此根因）。归一化后 LF old_string 必然命中；写回时按原文件
    // 行尾风格还原，避免整个文件行尾漂移（git diff 全文件变红）。
    const raw = readFileSync(resolved, 'utf-8')
    const hasCRLF = raw.includes('\r\n')
    const content = hasCRLF ? raw.replaceAll('\r\n', '\n') : raw
    const normOld = String(oldString).replaceAll('\r\n', '\n')
    const normNew = String(newString).replaceAll('\r\n', '\n') // new_string 同归一化，避免还原时 \r\r\n
    const count = content.split(normOld).length - 1
    if (count === 0) return { content: `未找到匹配文本：${JSON.stringify(oldString.slice(0, 80))}`, isError: true }
    if (count > 1 && !replaceAll) {
      return { content: `old_string 出现 ${count} 次，不唯一；请使用 replace_all 或补充更多上下文`, isError: true }
    }
    const next = (replaceAll ? content.split(normOld).join(normNew) : content.replace(normOld, normNew))
    writeFileSync(resolved, hasCRLF ? next.replaceAll('\n', '\r\n') : next, 'utf-8')
    readCache?.delete(resolved) // 文件已变，失效去重缓存
    return { content: `已编辑 ${resolved}（${replaceAll ? count : 1} 处替换）` }
  } catch (e) {
    return { content: `编辑失败：${e.message}`, isError: true }
  }
}

// 搜索忽略目录：依赖/构建产物目录默认剪枝——node_modules 等可达数十万文件，
// 同步递归遍历会阻塞内核事件循环数秒并拖垮 Glob/Grep（实测含 node_modules 的
// 会话目录下单次搜索 3.5-5s）。pattern/glob 显式引用目录名时放行（允许定向
// 搜索依赖，如 **/node_modules/**/package.json）。
const IGNORE_DIR_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'venv', '.venv', '__pycache__', '.cache', '.turbo', '.parcel-cache',
  'bower_components', '.yarn', '.pnpm-store', 'target',
  'release', 'runtime', 'kernel-dist', // 安装包产物 / 捆绑运行时
  'vendors', 'workspace', // 第三方源码快照 / 评测克隆工作区（可达十万级文件）
])
// 从 pattern/glob 提取显式引用的忽略目录名（'**/node_modules/**' 含 node_modules 段）
function explicitIgnoreDirs(pattern) {
  const out = new Set()
  for (const seg of String(pattern || '').split(/[\\/]/)) {
    if (IGNORE_DIR_NAMES.has(seg)) out.add(seg)
  }
  return out
}
function shouldSkipDir(dirname, explicit) {
  return IGNORE_DIR_NAMES.has(dirname) && !explicit.has(dirname)
}

// ---------------------------------------------------------------------------
// 搜索扫描：预算 + 协作式让出（2026-09-11 全树挂起事故修复）
// 旧实现用同步 readdir/readFile 递归遍历 allowDirs 全集。--add-dir 一旦指向大目录
// （实测用户主目录 83 万文件），单次 Grep 独占事件循环数十分钟：stdin 的 cancel
// 读不到（GUI Stop 键完全失效）、engine 的 withToolDeadline 永不触发（它只包住
// 返回值，同步执行早已跑完）、bridge 失速看门狗只能告警不能救。遍历改为每
// SCAN_YIELD_EVERY 个条目 setImmediate 让出一次（取消/超时得以插入事件循环），
// 并施加时间/条目双预算——超预算返回已得结果 + 收窄提示，而非空手失败。
// ---------------------------------------------------------------------------
const SCAN_YIELD_EVERY = 128
function scanBudgetMs() {
  const v = Number(process.env.YFW_TOOL_SCAN_BUDGET_MS)
  return Number.isFinite(v) && v > 0 ? v : 10_000
}
function scanBudgetEntries() {
  const v = Number(process.env.YFW_TOOL_SCAN_BUDGET_ENTRIES)
  return Number.isFinite(v) && v > 0 ? v : 300_000
}

// 路径收窄（Grep/Glob 的 path 参数）：把遍历根从"全部 allowDirs"收窄到指定的一处。
// 越界/不存在一律拒绝并给出可行动提示——静默忽略正是旧实现把"只搜这一个文件"
// 变成"全树扫描"的根因；拒绝也比静默降级为全树扫描安全。
function resolveScanScope(scopePath, allowDirs, { cwd, skipBoundary } = {}) {
  const raw = scopePath == null ? '' : String(scopePath).trim()
  if (!raw) return { roots: allowDirs }
  const resolved = resolvePath(raw, cwd)
  let st
  try { st = statSync(resolved) } catch {
    return { error: `路径不存在：${resolved}（path 需为已存在的文件或目录；省略 path 则遍历全部会话目录）` }
  }
  if (!st.isFile() && !st.isDirectory()) return { error: `path 既不是文件也不是目录：${resolved}` }
  if (!skipBoundary && !withinBoundary(resolved, allowDirs)) {
    return { error: `拒绝访问：路径超出会话目录边界（${resolved}）。可用根目录：${allowDirs.join('、')}` }
  }
  return { roots: [resolved] }
}

// 共享异步遍历：roots 内每个条目交 onFile 判定；onFile 返回 false 表示"已够，停"。
// 目录判定走 Dirent（不额外 stat），仅根节点按 stat 区分文件/目录——与旧实现的
// 系统调用量级一致。回报截断原因供上层做渐进式披露。
async function walkForSearch(roots, { explicit, signal, onFile }) {
  const startedAt = Date.now()
  const maxMs = scanBudgetMs()
  const maxEntries = scanBudgetEntries()
  let entries = 0
  let sinceYield = 0
  let truncation = null

  const hit = () => {
    if (signal?.aborted) return 'aborted'
    if (entries > maxEntries) return 'budget-entries'
    if (Date.now() - startedAt > maxMs) return 'budget-time'
    return null
  }
  const step = async () => {
    entries++
    const reason = hit()
    if (reason) { truncation ||= reason; return false }
    if (++sinceYield >= SCAN_YIELD_EVERY) {
      sinceYield = 0
      // 宏任务让出：微任务（await 链）不足以让 stdin/timer 插队，必须走 setImmediate
      await new Promise((r) => setImmediate(r))
      const late = hit()
      if (late) { truncation ||= late; return false }
    }
    return true
  }

  const walkDir = async (dir) => {
    let list
    try { list = readdirSync(dir, { withFileTypes: true }) } catch { return true }
    for (const ent of list) {
      if (!(await step())) return false
      if (ent.name.startsWith('.') && ent.name !== '.' && ent.name !== '..') continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, explicit)) continue
        if (!(await walkDir(full))) return false
      } else if (!(await onFile(full))) return false
    }
    return true
  }

  for (const root of roots) {
    let st
    try { st = statSync(root) } catch { continue }
    const ok = st.isDirectory() ? await walkDir(root) : st.isFile() ? await onFile(root) : true
    if (!ok) break
  }
  return { truncation, entries, elapsedMs: Date.now() - startedAt }
}

const SCAN_TRUNCATION_TEXT = {
  'budget-time': '扫描超出时间预算，已中止',
  'budget-entries': '扫描超出条目预算，已中止',
  aborted: '扫描被取消，已中止',
}

// 渐进式披露兜底：截断时不吞掉已得结果，而是附上"为何停 + 下一步怎么收窄"。
// 无 path 时首要建议是加 path（这正是本次事故的触发面），已有 path 则建议缩小
// 该 path 或收紧 pattern/glob。
function scanNotice(stats, { hasPath }) {
  if (!stats.truncation) return ''
  const why = SCAN_TRUNCATION_TEXT[stats.truncation] || '扫描被中断'
  const head = `\n\n⚠ ${why}——结果可能不完整（已扫 ${stats.entries} 个条目 / ${stats.elapsedMs}ms）。`
  if (stats.truncation === 'aborted') return head
  return head + (hasPath
    ? '该 path 范围仍然过大，请进一步收窄 path，或用更精确的 pattern/glob 缩小搜索面。'
    : '请用 path 参数限定到具体目录或文件（如 path: "kernel"），或用 glob 过滤（如 **/*.mjs）——在全量会话目录上大范围搜索代价极高。')
}

// Glob：在会话目录边界内递归匹配文件名/路径（pattern 支持 * ? 和 **）。
// 匹配前把路径归一化为正斜杠，Windows 反斜杠路径与 pattern 里的 / 均能命中。
async function globSearch(pattern, allowDirs, { maxResults = 200, path: scopePath, cwd, signal, skipBoundary } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    const re = globToRegExp(String(pattern).replace(/\\/g, '/'))
    const explicit = explicitIgnoreDirs(pattern)
    const scope = resolveScanScope(scopePath, allowDirs, { cwd, skipBoundary })
    if (scope.error) return { content: scope.error, isError: true }
    const results = []
    const seen = new Set()
    const stats = await walkForSearch(scope.roots, {
      explicit,
      signal,
      onFile: async (full) => {
        const normalized = full.replace(/\\/g, '/')
        if (re.test(normalized) && !seen.has(full)) { seen.add(full); results.push(full) }
        return results.length < maxResults
      },
    })
    const notice = scanNotice(stats, { hasPath: !!String(scopePath ?? '').trim() })
    if (results.length === 0) {
      // 截断导致的"零结果"不等于"不存在"——不得回"无匹配"误导模型收手
      if (stats.truncation) return { content: `未扫到匹配文件，但扫描已提前中止，不能据此判定不存在。${notice}`, isError: true }
      return { content: `无匹配文件（pattern: ${pattern}）。依赖/构建目录（node_modules 等）默认剪枝——若目标在其中，请用含目录段的 pattern（如 **/node_modules/**）；否则用更精确的 pattern，勿反复全树试探` }
    }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n') + truncated + notice }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

// 简易 glob → RegExp：** 跨目录 / * 单段内任意 / ? 单字符
function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  // 匹配基准是绝对路径（allowDirs 内 join 出的 full path）：相对路径 pattern
  // （如 'src/**/*.ts'）自动补 '**/' 前缀使其能命中绝对路径任意层；
  // '**/x' 开头与绝对路径（盘符 / UNC / POSIX 根）不补。
  const isAbsolute = /^[A-Za-z]:[/]|^[/]{1,2}/.test(p)
  const src = isAbsolute || p.startsWith('**') ? p : '**/' + p
  // 找与 start 处 '{' 配对的 '}'（支持嵌套计数，未闭合返回 -1）
  const findClosingBrace = (s, start) => {
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}') { depth--; if (depth === 0) return i }
    }
    return -1
  }
  const escapeLiteral = (ch) => ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '*') {
      if (src[i + 1] === '*') {
        // '**/' 可匹配零层或多层目录（标准 glob 语义）；'**x' 按 .* 处理
        if (src[i + 2] === '/') { out.push('(?:.*/)?'); i += 2 } else { out.push('.*'); i++ }
      } else { out.push('[^/]*') }
    } else if (c === '?') {
      out.push('[^/]')
    } else if (c === '{') {
      // brace 展开：{a,b,c} → (?:a|b|c)；未闭合按字面
      const end = findClosingBrace(src, i)
      if (end === -1) { out.push(escapeLiteral(c)) }
      else {
        const alts = src.slice(i + 1, end).split(',').map((alt) => {
          let s = ''
          for (let j = 0; j < alt.length; j++) {
            const ch = alt[j]
            if (ch === '*') s += '[^/]*'
            else if (ch === '?') s += '[^/]'
            else s += escapeLiteral(ch)
          }
          return s
        })
        out.push('(?:' + alts.join('|') + ')')
        i = end
      }
    } else {
      out.push(escapeLiteral(c))
    }
    i++
  }
  return new RegExp('^' + out.join('') + '$', 'i')
}

// Grep：在边界内按正则搜索文件内容，返回 file:line 匹配行（含上下文）
async function grepSearch(pattern, allowDirs, { glob, context = 0, maxResults = 200, path: scopePath, cwd, signal, skipBoundary } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    let re
    try { re = new RegExp(String(pattern)) } catch (e) { return { content: `正则无效：${e.message}`, isError: true } }
    const ctx = Math.max(0, Math.min(Number(context) || 0, 10))
    const globRe = glob ? globToRegExp(String(glob).replace(/\\/g, '/')) : null
    // 显式引用忽略目录（glob 或 pattern 含 node_modules 等）→ 该目录不剪枝
    const explicit = new Set([...explicitIgnoreDirs(glob), ...explicitIgnoreDirs(pattern)])
    const scope = resolveScanScope(scopePath, allowDirs, { cwd, skipBoundary })
    if (scope.error) return { content: scope.error, isError: true }
    const results = []
    const MAX_BYTES = 2 * 1024 * 1024
    const stats = await walkForSearch(scope.roots, {
      explicit,
      signal,
      onFile: async (full) => {
        if (globRe && !globRe.test(full.replace(/\\/g, '/'))) return true
        let st
        try { st = statSync(full) } catch { return true }
        if (!st.isFile() || st.size > MAX_BYTES) return true
        // 单文件读取失败（权限/占用/编码）跳过，不中断整个搜索；
        // 含 NUL 字节视为二进制跳过（避免乱码误匹配）
        let content
        try { content = readFileSync(full, 'utf-8') } catch { return true }
        if (content.includes('\0')) return true
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const from = Math.max(0, i - ctx)
            const to = Math.min(lines.length, i + ctx + 1)
            const block = []
            for (let j = from; j < to; j++) block.push(`${j + 1}:${lines[j]}`)
            results.push(`—— ${full}（行 ${i + 1}）\n${block.join('\n')}`)
            if (results.length >= maxResults) return false
          }
        }
        return true
      },
    })
    const notice = scanNotice(stats, { hasPath: !!String(scopePath ?? '').trim() })
    if (results.length === 0) {
      // 截断导致的"零结果"不等于"不存在"——不得回"无匹配"误导模型收手
      if (stats.truncation) return { content: `未搜到匹配行，但扫描已提前中止，不能据此判定不存在。${notice}`, isError: true }
      return { content: `无匹配行（pattern: ${pattern}${glob ? `, glob: ${glob}` : ''}）。依赖/构建目录默认剪枝——若目标在其中，glob 需含目录段（如 **/node_modules/**）显式放行；否则核对正则，勿反复试探` }
    }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n\n') + truncated + notice }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

// WebFetch：抓取 URL 内容。仅 http/https；30s 超时；2MB 上限；HTML→文本简易提取；
// 3xx 跟随重定向（最多 3 跳）；响应无 content-type 时按内容嗅探判定文本。
function fetchUrl(url, { maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000, redirects = 0 } = {}) {
  return new Promise((resolvePromise) => {
    let u
    try { u = new URL(String(url || '')) } catch { return resolvePromise({ content: `URL 无效：${url}`, isError: true }) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolvePromise({ content: `仅支持 http/https：${u.protocol}`, isError: true })
    }
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(u, {
      method: 'GET',
      headers: { 'user-agent': 'Ponos-turbo/0.1', accept: 'text/html,text/plain,*/*' },
    }, (res) => {
      const status = res.statusCode || 0
      // 3xx + Location：跟随重定向（http/https，最多 3 跳）
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume() // 排空响应体，避免连接占用
        if (redirects >= 3) {
          return resolvePromise({ content: `重定向次数过多（>3），停在 ${status} → ${res.headers.location}`, isError: true })
        }
        let next
        try { next = new URL(String(res.headers.location), u) } catch {
          return resolvePromise({ content: `重定向目标无效：${res.headers.location}`, isError: true })
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return resolvePromise({ content: `重定向目标仅支持 http/https：${next.protocol}`, isError: true })
        }
        return resolvePromise(fetchUrl(next.toString(), { maxBytes, timeoutMs, redirects: redirects + 1 }))
      }
      const chunks = []
      let size = 0
      res.on('data', (d) => {
        size += d.length
        if (size > maxBytes) {
          req.destroy()
          resolvePromise({ content: `内容超限（>${maxBytes} 字节），已截断`, isError: true })
          return
        }
        chunks.push(d)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const type = String(res.headers['content-type'] || '')
        const isHtml = /html/i.test(type)
        // 有 content-type 按 MIME 判定；缺失（API/裸文本常见）回退内容嗅探：
        // UTF-8 可解码（无替换符）且无 NUL 字节视为文本
        const sniffedText = !type && buf.length > 0 && !buf.includes(0) && !buf.toString('utf-8').includes('\uFFFD')
        if (!isHtml && !/^text\//i.test(type) && !sniffedText) {
          return resolvePromise({ content: `响应类型 ${type || '(未声明)'}（${buf.length} 字节），非文本内容，本工具仅提取文本、勿重试——如确需该内容，请先下载到会话目录再用 OCR（图片/PDF）或 Read 处理`, isError: false })
        }
        const text = isHtml ? htmlToText(buf.toString('utf-8')) : buf.toString('utf-8')
        resolvePromise({ content: `HTTP ${status}\n${(text.slice(0, maxBytes) || '(空内容)').trim()}`, isError: status >= 400 })
      })
    })
    req.on('error', (e) => resolvePromise({ content: `抓取失败：${e.message}`, isError: true }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolvePromise({ content: `抓取超时（${timeoutMs}ms）`, isError: true }) })
    req.end()
  })
}

// 简易 HTML→文本（零依赖）：去 script/style、标签、常用实体
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

// ---------------------------------------------------------------------------
// WebSearch：经 Anthropic 兼容端点的原生 web_search server tool 执行搜索。
// 零新依赖——复用 provider（PONOS_BASE_URL/AUTH_TOKEN/MODEL），参考
// 联网搜索所调 provider 的 wire 契约：POST /v1/messages，
// body 带 tools:[{type:'web_search_20250305', name:'web_search', max_uses}]，
// 解析 web_search_tool_result 块（url/title/page_age）+ text 块 citations
// （cited_text 作 snippet，url 首见优先）。
// ---------------------------------------------------------------------------
const WEB_SEARCH_TIMEOUT_MS = 30_000
const WEB_SEARCH_MAX_USES = 5
const WEB_SEARCH_MAX_TOKENS = 4096

// mock：PONOS_MOCK_API=1 时返回固定结果（测试零依赖，验证格式链路）
function webSearchMock(query) {
  return {
    content: [
      `【WebSearch · mock】query=${query}`,
      '',
      'Sources:',
      '- [Mock Source One](https://example.com/1) — mock 摘要一',
      '- [Mock Source Two](https://example.com/2) — mock 摘要二',
    ].join('\n'),
    isError: false,
  }
}

// Anthropic Messages 响应 → 来源列表
function formatWebSearchResult(payload, query) {
  const blocks = payload?.content || []
  const resultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result')
  if (!resultBlocks.length) {
    return { content: `搜索「${query}」未返回结果块（端点可能未触发原生搜索）——可尝试换关键词，或改用 WebFetch 抓取已知 URL`, isError: false }
  }
  const snippets = new Map()
  for (const b of blocks) {
    if (b.type !== 'text') continue
    for (const cite of b.citations || []) {
      if (cite?.url && cite?.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text)
    }
  }
  const seen = new Set()
  const lines = []
  for (const rb of resultBlocks) {
    for (const item of rb.content || []) {
      if (item?.type !== 'web_search_result' || !item?.url || seen.has(item.url)) continue
      seen.add(item.url)
      const meta = []
      if (snippets.get(item.url)) meta.push(snippets.get(item.url))
      if (item.page_age) meta.push(`(${item.page_age})`)
      lines.push(`- [${item.title || item.url}](${item.url})${meta.length ? ` — ${meta.join(' ')}` : ''}`)
    }
  }
  if (!lines.length) return { content: `搜索「${query}」无结果`, isError: false }
  return { content: `搜索「${query}」结果：\n\nSources:\n${lines.join('\n')}\n\n（引用来源时按上述 URL 标注 markdown 链接）`, isError: false }
}

async function webSearch(query) {
  const q = String(query || '').trim()
  if (!q) return { content: 'query 不能为空：请提供搜索关键词', isError: true }
  if (process.env.PONOS_MOCK_API === '1') return webSearchMock(q)
  const p = getProvider()
  const base = p.baseUrl
  const token = p.authToken
  const model = p.model || process.env.PONOS_MODEL || ''
  if (!base || !token) return { content: 'WebSearch 需要配置 PONOS_BASE_URL / PONOS_AUTH_TOKEN（与主对话同一 provider 端点）', isError: true }
  const url = base.replace(/\/+$/, '') + '/v1/messages'
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        // 同时发两种鉴权头（超集兼容）：x-api-key-only 端点读 x-api-key，Bearer-only
        // 端点读 authorization。token 已带 "Bearer " 前缀时不重复。
        'authorization': /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'accept': 'application/json',
        'user-agent': 'Ponos-turbo/0.1',
      },
      body: JSON.stringify({
        model,
        max_tokens: WEB_SEARCH_MAX_TOKENS,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${q}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }],
      }),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    })
  } catch (e) {
    return { content: `WebSearch 请求失败：${e.message}（网络/端点不可达；如目标 URL 已知可改用 WebFetch 直接抓取）`, isError: true }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j?.error?.message || j?.error?.type || ''
    } catch {}
    return { content: `WebSearch 端点返回 HTTP ${res.status}${detail ? `：${detail}` : ''}——当前端点可能不支持原生 web_search 工具，勿重试；如需抓取已知 URL 请用 WebFetch`, isError: true }
  }
  let payload
  try { payload = await res.json() } catch { return { content: 'WebSearch 响应解析失败（非 JSON）', isError: true } }
  return formatWebSearchResult(payload, q)
}

// ---------------------------------------------------------------------------
// chat 模式禁用工具表（2026-09-12 会话模式隔离）：chat 是纯联网会话，只留
// WebFetch/WebSearch 等联网只读工具——禁一切本地执行/读写/搜索/子 Agent/技能/
// 工作流/浏览器/记忆检索。此表是**唯一权威源**：内核按 --session-mode chat
// 自行套用（不依赖宿主传参，宿主漏传也不会把本地能力泄进 chat）；bridge 的
// CHAT_DISALLOWED 是逐项拷贝，仅为"跑的是旧缓存内核（不认 --session-mode）"的
// 兼容兜底——两者一致性由 kernel-tests/chat-mode.test.mjs 的源码比对守住。
//
// S3 D2（2026-09-13，**有意的语义变更**）：KnowledgeSearch 出表 = chat 放行它。
// S1 时它与 MemorySearch 同列，语义是"chat 禁一切本地能力"；D2 把该语义**收窄**为
// "chat 禁本地执行/写盘/出网执行类能力"。理由：KnowledgeSearch 是只读检索——不写盘、
// 不执行命令、不出网，隔离要防的风险（本地执行与文件改写的泄漏）它一项都不构成；
// 而"知识库里以前记过什么"是纯聊场景的自然追问（问完仍需 Read 才能看全文，那条路仍禁）。
// MemorySearch **不随之放行**：它每次都全量读文件 + 现算向量（O(N)），chat 场景无收益，
// 放行只会让"同一能力两个入口、一个快一个慢"的口径更乱（S3 只对 D2 这一项做决策）。
// 2026-09-14：KnowledgeImport 入表（chat 禁用）。它是**写盘**能力（往知识空间落文件），
// 与 Read/Write/Skill 同类；chat 的语义是"纯聊/联网问答，不做本地执行与写盘"，导入显然不属于它。
// 纯聊会话里想用知识库，用只读的 KnowledgeSearch 即可（S3 D2 已放行）。
// 2026-09-14：KnowledgeDelete 入表（chat 禁用）——**同族的理由更强**：它是写盘且带破坏性
// （移动/销毁用户知识库文件）。放行它等于让"纯聊"会话具备删库能力，与 chat 的隔离承诺直接冲突。
export const CHAT_MODE_DISALLOWED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'OCR', 'Vision', 'Skill', 'SkillSearch', 'Workflow', 'Browser', 'MemorySearch', 'KnowledgeImport', 'KnowledgeDelete']

export function createToolRegistry({ cwd, addDirs, skillsDirs, skipPermissions, allowOutsideDirs = false, disallowedTools = [], workflow = null, memoryRoot = null, projectMemoryRoot = null, readAllowFiles = [], dynamicTools = null, flatSkillRoots = null, knowledgeSpaces = null, knowledgeReadDirs = null, disabledSkills = null }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  // 只读白名单（readAllowDirs = Read 的边界；scanAllowDirs = Grep/Glob 的边界与遍历根）
  // 在下方"会话知识范围"之后构建：知识空间的只读放行要以 scopeEmpty 做 fail-closed，
  // 两者放同一处才不会出现"边界有两份定义"的漂移。
  // 只读文件白名单（2026-09-11 渐进式披露）：会话 transcript 文件放行 Read——
  // 硬适配索引化后模型按行号展开历史细节；仅精确文件匹配，不放宽任何目录。
  const readAllowFilesSet = new Set((readAllowFiles || []).map((f) => resolve(String(f)).toLowerCase()))
  // P10-A：技能加载根 = 显式 skillsDirs（发现根，含默认 <configDir>/skills）优先，
  // 缺省回退 allowDirs——Skill 工具与提示词【可用技能】块同一数据源（cli 发现用同 roots）。
  // 注意：skillsDirs 不并入 allowDirs，避免扩大 Bash/Read 等工具的文件边界。
  const skillLoadRoots = (skillsDirs?.length ? skillsDirs : allowDirs).filter(Boolean)
  // 平铺 <id>.md 的根白名单（2026-09-12 P2-1）：与 cli 提示词发现同口径——项目根里的
  // BUILD.md 之类不再能被 Skill 工具当技能加载，也不出现在"可用技能"回执里。
  const flatSkillRootsArg = Array.isArray(flatSkillRoots) ? flatSkillRoots : undefined
  // 全局停用技能清单（2026-09-15，D 条款）：归一为**数组或 null**。
  // 传 null（缺省）表示"没有停用任何技能"——嵌入/测试场景的既有行为逐字节不变。
  // 空数组与 null 在这里**等价**（都=没有停用项）：与 knowledgeSpaces 的三态语义不同，
  // 因为"停用清单为空"本就等于"全开"，不存在"fail-closed"的第三态。
  // 换名 `disabledSkillIds` 而不是复用入参名：同名 const 会在同一作用域触发 TDZ 报错
  // （实测 `Identifier 'disabledSkills' has already been declared`），且读起来也更明确。
  const disabledSkillIds = Array.isArray(disabledSkills)
    ? [...new Set(disabledSkills.map((s) => String(s ?? '').trim()).filter(Boolean))]
    : null
  // 会话目录边界开关：--allow-outside-dirs / PONOS_ALLOW_OUTSIDE_DIRS=1 解锁文件工具
  // （Read/Write/Edit/OCR）的目录限制；Glob/Grep 仍限定会话目录内（避免全盘扫描）。
  const skipBoundary = !!allowOutsideDirs || process.env.PONOS_ALLOW_OUTSIDE_DIRS === '1'
  // 禁用工具集（--disallowedTools）：toolNames/toolSchemas/run/isConcurrencySafe
  // 全部基于过滤后视图；被禁工具的执行请求直接拒绝（防模型绕过工具列表）
  const blocked = new Set(disallowedTools || [])
  // Read 去重缓存（会话级）：resolved → { mtimeMs, size, fullRead }，Write/Edit 失效
  const readCache = new Map()
  // ── 会话知识范围（2026-09-15，P1 spec §3.4）──────────────────────────────────
  // `knowledgeSpaces` 三态语义（与 kernel/knowledge-inject.mjs 保持同一套口径）：
  //   · null / 非数组 = **不限**（嵌入场景与单测没有"会话"概念，收窄会打断其既有行为——
  //     createToolRegistry 是公开口，很多测试直接构造它验证检索能力）；
  //   · 非空数组     = 白名单；
  //   · 空数组       = **本会话没有可检索知识库** → 一切检索都被拒（fail-closed）。
  // 空数组必须与"不限"区分开：早先写成 `Array.isArray(x) && x.length ? ... : null`，
  // 于是"内置经验库也不存在"（memory/personal 被删 / 首启未经 ensurePersonalDir）时白名单
  // 退化成不限，储备库被重新放进来——范围在最该收紧的场景里静默失效（评审抓出）。
  const scopeSet = Array.isArray(knowledgeSpaces) ? new Set(knowledgeSpaces.map((s) => String(s))) : null
  const scopeList = scopeSet ? [...scopeSet] : null
  const scopeEmpty = scopeSet !== null && scopeSet.size === 0
  // ── 只读边界：会话目录 + 记忆根 + **已授权知识空间根**（P3，2026-09-20）─────────────
  //
  // 记忆只读边界扩展（2026-09-10）：Read 追加个人/项目记忆根——记忆文件是内核自己维护的
  // 知识库（与 MemorySearch 同源），会话目录边界把它们排除在外会让模型"引用记忆原文"被拒
  // （用户实证：memory/personal/workflow.md 无法 Read）。
  //
  // 知识空间只读放行（P3）：`knowledgeReadDirs` = 上层（kernel/cli.mjs）按**本会话授权范围**
  // 算好的知识空间根（元素 `{ id, root }`；`id` 供工具回执判断"这个空间能否 Read"）。
  // 修复的实证病灶：任务模式下非 experience 的空间（如 id「政策」，物理在
  // `<配置根>/knowledge/spaces/政策/…`）既不能 Read 也不能 Grep，而 KnowledgeSearch 的回执
  // 却引导"需全文用 Read 读对应文件行"——模型照做只会撞"路径超出会话目录边界"。
  //
  // 为什么这样放行是安全的（改了本段请同步核对这四条）：
  //   ① 放行的只有 **Read** 的边界与 **Grep/Glob** 的边界/遍历根；Write / Edit / Bash / OCR
  //      仍用 `allowDirs`（会话目录 + --add-dir）——知识库文件在任务会话里照旧**只读**，
  //      写入一律被拒（knowledge-import 等写盘能力另有自己的工具与台账）。
  //   ② 本层**从不自己推导**任何知识路径（不知道配置根，与改造前一致）：放行集合 = 上层显式
  //      给的那份。故"上层忘记传"只会**少**放行，不会多放行（fail-closed）。
  //   ③ `knowledgeSpaces` 为空数组（本会话没有任何可检索库）时**强制清空**放行集合：三态里的
  //      "明确无空间"是 fail-closed，只读边界必须与检索边界同口径——否则"一个库都没有"的会话
  //      反而变成"整棵知识目录可读"，比改造前更宽。
  //   ④ `knowledgeSpaces` 为 null（**不限**：嵌入/测试场景）**不因此放行任何空间**——"不限"只
  //      影响 KnowledgeSearch 的范围过滤；文件边界严格等于上层显式给的那份，绝不等于"全部空间"。
  let knowledgeReadSources = knowledgeReadDirs
  let readAllowDirs = []
  let scanAllowDirs = []
  /** 回执文案的判据（"这些空间能否 Read"）；null = 无从判断 ⇒ 回执不加任何引导（零回归）。 */
  let knowledgeReadableIds = null
  const applyKnowledgeReadDirs = () => {
    const entries = (Array.isArray(knowledgeReadSources) ? knowledgeReadSources : [])
      .map((e) => (typeof e === 'string'
        ? { id: null, root: e }
        : { id: e?.id == null ? null : String(e.id), root: e?.root == null ? null : String(e.root) }))
      .filter((e) => e.root)
    const dirs = scopeEmpty ? [] : entries.map((e) => e.root)
    const ids = entries.map((e) => e.id).filter(Boolean)
    // 只有"确实放行了目录"且"知道空间 id"时才给分支文案：纯字符串入参（只要边界、不要文案
    // 归属）与空白名单都退化为 null，回执措辞与改造前逐字一致。
    knowledgeReadableIds = dirs.length && ids.length ? new Set(ids) : null
    readAllowDirs = [...allowDirs, memoryRoot, projectMemoryRoot, ...dirs].filter(Boolean)
    // Grep/Glob：边界与**默认遍历根**都要含知识空间——模型不知道空间的物理路径（提示词只给库名，
    // 见 prompt.mjs 的 renderKnowledgeScope），只放行 path 参数等于要求它先猜出绝对路径才能搜。
    // 反之**不**把记忆根并进来：记忆是 Read 的只读扩展，"默认在记忆库里全量搜"不是本任务的目标，
    // 保持 Grep 的默认扫描面与改造前一致（要搜记忆仍可显式传 path…也会被拒，与改造前同）。
    scanAllowDirs = [...allowDirs, ...dirs].filter(Boolean)
  }
  applyKnowledgeReadDirs()
  /**
   * 越界文案（**唯一处措辞**，两个工具共用）。三条硬要求：
   *   ① 说清"哪个空间越界 + 当前范围是什么"——模型据此能自己换策略，不必问用户；
   *   ② 明写**请勿重试同一调用**——否则弱模型会把"没权限"当瞬时故障反复重发（本仓库既有教训）；
   *   ③ 给出**用户侧动作**（去知识面板关联）——这是唯一能让原请求变得合法的路径。
   * 之所以要这么啰嗦：静默返回空命中时，模型无法与"该库确实没有这条知识"区分，会编造原因。
   */
  const outOfScopeMsg = (id) => `空间「${id}」不在本会话知识范围内（当前范围：${scopeList.join('、')}）。`
    + '请勿重试同一调用：改用范围内的空间检索，或请用户在知识面板把该库「关联到当前会话」后再试。'
  /** 空白名单专用文案：此时没有"范围里能改用的空间"，指引只能落在用户动作上。 */
  const noSpaceMsg = '本会话没有任何可检索的知识库（经验库与已关联的库都不可用）。'
    + '请勿重试同一调用：请用户确认个人经验库存在，或在知识面板把需要的库「关联到当前会话」后再试。'
  /**
   * 把工具请求的空间收窄到会话范围。
   * @returns {{ spaces: string[]|null } | { deny: string }}
   *
   * **任一请求项越界即整体拒绝**（不做"悄悄丢掉越界项、只查剩下的"）：交集式放行会让模型以为
   * 它查过了那个库、并据"查不到"下结论——那是最贵的假阴性。拒绝时文案点名越界项，
   * 模型重发一次（只带范围内空间）即可完成原意图，代价小于一次错误结论。
   */
  const scopedSpaces = (requested) => {
    const req = Array.isArray(requested) && requested.length ? requested.map((s) => String(s)) : null
    if (!scopeSet) return { spaces: req }        // 不限：维持既有行为（零回归）
    if (scopeEmpty) return { deny: noSpaceMsg }  // 空白名单：任何检索都无从谈起
    if (!req) return { spaces: scopeList }       // 未指定 → 用范围全集（而不是"全部可读空间"）
    const bad = req.find((id) => !scopeSet.has(id))
    if (bad) return { deny: outOfScopeMsg(bad) }
    return { spaces: req }
  }
  /** `related` 分支的越界判定：blockId 形状 `<spaceId>/<path>#<n>`，空间前缀一眼可判。 */
  const blockIdOutOfScope = (blockId) => {
    if (!scopeSet) return null
    if (scopeEmpty) return noSpaceMsg
    const sp = String(blockId || '').split('/')[0]
    return scopeSet.has(sp) ? null : outOfScopeMsg(sp)
  }
  // todo 清单（TodoWrite 覆盖式维护；同一进程共享）
  let todoItems = []
  const registry = {
    Bash: {
      description: '执行 shell 命令。仅用于系统命令/测试/构建/git 等必须场景；读文件用 Read、搜索内容用 Grep、找文件路径用 Glob（禁止用 cat/sed/grep/find 代替专用工具）。多步验证用 && 串联为一次调用。限制：120s 超时；无 stdin（勿用 ssh/vi/read 等交互式命令）；输出超 200KB 截断保留尾部（带 [truncated] 标记）；失败返回退出码与 stderr。Windows 下命令输出可能为 GBK 乱码（tasklist/dir 等），需文本匹配时先 chcp 65001 或改用 PowerShell；大目录遍历/全树搜索优先限定 git 跟踪文件（git ls-files），避免无目标全量扫描。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
      run: (input) => runShell(String(input?.command ?? ''), cwd),
      isHighRisk: (input) => matchesHighRisk(String(input?.command ?? '')),
    },
    Read: {
      description: `读取文本文件内容。一次读全文（上限 ${READ_MAX_LINES} 行 / ${READ_MAX_BYTES / 1024 / 1024}MB），默认应读全文而非分段取样；超大文件用 offset/limit 定向读取，结果会提示续读位置。重复读取未变化的文件会返回"文件自上次读取后未变化"提示——直接引用此前结果即可，勿重复发起。优先用本工具而非 Bash cat/sed 读文件；路径用绝对路径，或相对当前工作目录的相对路径。边界限制：仅可读取当前会话目录及其挂载目录（--add-dir）、个人记忆/项目记忆目录，以及**本会话已授权知识库**目录内的文件；其余会话外路径会被拒绝（知识库文件只读，Write/Edit 对它们一律拒绝）。`,
      // concurrencySafe：只读工具可并发执行（P0-4 只读批并行）
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要读取的文件路径（绝对路径，或相对当前工作目录）' },
          offset: { type: 'number', description: '可选：起始行号（1 开始）' },
          limit: { type: 'number', description: `可选：读取行数（默认一次读全文，最多 ${READ_MAX_LINES} 行）` },
        },
        required: ['file_path'],
      },
      run: (input) => readFile(String(input?.file_path ?? ''), readAllowDirs, input, cwd, readCache, skipBoundary, readAllowFilesSet),
    },
    Write: {
      description: '写入文本文件（覆盖整个文件）。注意是整体覆盖语义——必须携带完整新内容，遗漏会导致文件被清空或内容丢失；改动范围超过半个文件时优先考虑本工具而非多次 Edit。边界限制：仅可写入当前会话目录及其挂载目录（--add-dir）内的文件，会话外路径会被拒绝——调用前先确认目标路径位于会话目录内。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要写入的文件路径（绝对路径，或相对当前工作目录）' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['file_path', 'content'],
      },
      run: (input) => writeFile(String(input?.file_path ?? ''), String(input?.content ?? ''), allowDirs, cwd, readCache, skipBoundary),
    },
    Edit: {
      description: '先读后改的字符串替换编辑（old_string 需与文件字节精确匹配，含空格/换行；需唯一，或指定 replace_all）。一次 Edit 覆盖一个完整逻辑块；同文件多处修改尽量合并为一次调用；改动过大时考虑 Write 重写。失败（未找到/不唯一）时按错误信息调整上下文或加 replace_all，勿原样重试。边界限制：仅可编辑当前会话目录及其挂载目录（--add-dir）内的文件，会话外路径会被拒绝。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要编辑的文件路径（绝对路径，或相对当前工作目录）' },
          old_string: { type: 'string', description: '要替换的原文（需精确匹配）' },
          new_string: { type: 'string', description: '替换后的内容' },
          replace_all: { type: 'boolean', description: '可选：true 时替换全部匹配（默认 false 仅替换唯一匹配）' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      run: (input) => editFile(String(input?.file_path ?? ''), String(input?.old_string ?? ''), String(input?.new_string ?? ''), input?.replace_all === true, allowDirs, cwd, readCache, skipBoundary),
    },
    Glob: {
      description: '在会话目录与已授权知识库内递归搜索文件路径（pattern 支持 * ? 和 ** 通配）。先 Glob 定位候选文件再 Read，避免无目标 ls。已知大致位置时务必传 path 收窄范围——省略 path 会遍历全部会话目录，代价极高。依赖/构建产物目录（node_modules/dist/build/release/vendors/workspace 等）默认剪枝不搜索——若目标在其中，pattern 需显式含目录名（如 **/node_modules/**）；无匹配时按返回提示换更精确的 pattern，勿反复全树试探。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '文件路径通配模式，如 **/*.mjs' },
          path: { type: 'string', description: '可选：限定搜索的目录或文件（绝对路径，或相对会话目录）。强烈建议传——省略则遍历全部会话目录' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input, ctx) => globSearch(String(input?.pattern ?? ''), scanAllowDirs, {
        maxResults: Number(input?.maxResults) || 200,
        path: input?.path ? String(input.path) : undefined,
        cwd, signal: ctx?.signal, skipBoundary,
      }),
    },
    Grep: {
      description: '在会话目录与已授权知识库内按正则搜索文件内容，返回 file:line 匹配行。带精确 pattern 与 glob 过滤；需要上下文时用 context 参数；结果最多 200 条（超出截断并标注）。已知大致位置时务必传 path 收窄范围——省略 path 会遍历全部会话目录，代价极高。依赖/构建产物目录默认剪枝（同 Glob，显式引用可放行）。无匹配时按返回提示调整，避免试探性重复搜索。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '可选：限定搜索的目录或文件（绝对路径，或相对会话目录）。强烈建议传——省略则遍历全部会话目录' },
          glob: { type: 'string', description: '可选：文件路径通配过滤，如 **/*.mjs' },
          context: { type: 'number', description: '可选：匹配行上下文件数（0-10，默认 0）' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input, ctx) => grepSearch(String(input?.pattern ?? ''), scanAllowDirs, {
        glob: input?.glob ? String(input.glob) : undefined,
        context: Number(input?.context) || 0,
        maxResults: Number(input?.maxResults) || 200,
        path: input?.path ? String(input.path) : undefined,
        cwd, signal: ctx?.signal, skipBoundary,
      }),
    },
    // 子代理分发：执行体在 engine（ctx.spawnSubAgent）。子 lane 内禁止嵌套。
    Agent: {
      description: '将子任务委派给子 Agent 执行（按优势场景选择 subagent_type）；前台同步回填结果，或 run_in_background 后台异步执行；可基于既有后台任务会话续跑（resume_task_id）；context 控制主会话上下文继承（none 不继承/summary 继承摘要+最近轮次/full 继承全量历史——长会话推荐 summary 档）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_type: { type: 'string', description: '子 Agent 类型（general-purpose / researcher / implementer / reviewer / explorer / planner 或用户注册的 agent id）' },
          prompt: { type: 'string', description: '委派给子 Agent 的完整任务说明；resume 模式下为续跑指令' },
          run_in_background: { type: 'boolean', description: '可选：true 时后台异步执行，立即返回 task_id（Task 工具查询/中止/续跑/投递消息）' },
          description: { type: 'string', description: '可选：任务描述（展示用）' },
          resume_task_id: { type: 'string', description: '可选：基于既有后台子任务会话继续执行（复用其 lane 会话，prompt 作为续跑指令追加；任务须已结束且进程存活）' },
          context: { type: 'string', description: '可选：主会话上下文继承档 none（默认）| summary（主会话压缩摘要+最近 20 轮文本）| full（最近 200 条全量文本，可能撑爆子任务上下文，谨慎使用）' },
        },
        required: ['subagent_type', 'prompt'],
      },
      run: (input, ctx) => {
        if (ctx?.lane) return { content: '子 Agent 不支持嵌套分发', isError: true }
        if (typeof ctx?.spawnSubAgent !== 'function') return { content: '子 Agent 执行器不可用', isError: true }
        return ctx.spawnSubAgent(input, ctx)
      },
      // 第 10 项（2026-09-17）：同轮多个 Agent 调用**允许并发**。原 P0-4 把 Agent 归入
      // "写/执行类必须串行"，实测代价是前台无法并行分派（同轮两个 Agent 的事件序恒为
      // start→notify→start→notify，即第二个要等第一个跑完）。
      // 并发安全依据（已逐项核查）：① 每个子 lane 独立 session store / AbortController /
      // writePaths；② 子 lane 内禁止再派子 Agent（上面的 ctx.lane 守卫）⇒ 不会无限扇出；
      // ③ 审批挂起用 Map 按 tool_use id 键（engine 的 approvalWaiters）+ 前端 pendingPermissions
      // 是数组队列，多个并行审批请求不会互相覆盖；④ 扇出上限由 spawnSubAgent 的并发闸兜住
      // （LANE_MAX_CONCURRENT，见 kernel/engine.mjs 的前台槽位）。
      concurrencySafe: true,
    },
    // 后台子 Agent 任务管理（查询/中止/续跑）
    Task: {
      description: '管理后台子 Agent 任务：list 列出全部（层级缩进）、status/output 查询单个、stop 中止、resume 续跑（基于既有会话继续）、send_message 向运行中任务投递消息（其当前工具轮结束后接收）、followup 投递消息（对已结束任务自动续跑）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'list | status | output | stop | resume | send_message | followup' },
          task_id: { type: 'string', description: '可选：status/output/stop/resume/send_message/followup 时的任务 id' },
          prompt: { type: 'string', description: '可选：resume/followup 时的续跑指令（追加到既有会话；缺省「（任务继续）」）' },
          message: { type: 'string', description: '可选：send_message/followup 时投递的消息内容' },
        },
        required: ['command'],
      },
      run: (input, ctx) => {
        if (typeof ctx?.taskSystem !== 'object') return { content: '任务系统不可用', isError: true }
        const cmd = String(input?.command || '')
        const id = String(input?.task_id || '')
        const sys = ctx.taskSystem
        if (cmd === 'list') return { content: sys.list() }
        if (cmd === 'status') return { content: sys.status(id) }
        if (cmd === 'output') return sys.output(id)
        if (cmd === 'stop') return sys.stop(id)
        if (cmd === 'resume') return sys.resume(id, input?.prompt)
        if (cmd === 'send_message') return sys.sendMessage(id, input?.message)
        if (cmd === 'followup') return sys.followup(id, input?.message || input?.prompt)
        return { content: `未知 command：${cmd}（支持 list/status/output/stop/resume/send_message/followup）`, isError: true }
      },
    },
    // 任务规划清单（覆盖式更新，返回当前清单）
    TodoWrite: {
      description: '维护任务规划清单（todo list）：以完整清单覆盖更新，返回当前清单供模型跟踪进度。注意是覆盖语义——每次须传完整清单（含已完成与进行中的项），遗漏的项会被移除',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            description: '完整的 todo 清单（覆盖式更新）：[{ content, status? }]，status 为 pending/in_progress/completed',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                content: { type: 'string', description: '任务描述' },
                status: { type: 'string', description: '可选：pending/in_progress/completed（默认 pending）' },
              },
            },
          },
        },
        required: ['todos'],
      },
      run: (input) => {
        const list = Array.isArray(input?.todos) ? input.todos : []
        todoItems = list
          .map((t) => ({
            content: String(t?.content ?? ''),
            status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
          }))
          .filter((t) => t.content)
        if (todoItems.length === 0) return { content: '（todo 清单为空）' }
        const lines = todoItems.map((t, i) => {
          const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '→' : ' '
          return `${i + 1}. [${mark}] ${t.content}`
        })
        return { content: lines.join('\n') }
      },
    },
    // URL 抓取（零依赖 Node http/https）
    WebFetch: {
      description: '抓取 URL 内容并提取文本（仅 http/https；30s 超时；2MB 上限；自动跟随重定向≤3 跳；HTML 自动转文本）。仅提取文本——图片/PDF/二进制 URL 会返回"非文本"提示（勿重试，需下载到会话目录后走 OCR/Read）；非 2xx 状态（404/5xx）标记为错误',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '要抓取的 URL（http/https）' },
        },
        required: ['url'],
      },
      run: (input) => fetchUrl(String(input?.url || '')),
    },
    // 网络搜索：经 Anthropic 兼容端点原生 web_search server tool（零新依赖）
    WebSearch: {
      description: '搜索互联网获取最新信息（当前 provider 端点原生 web_search 能力；30s 超时）。返回带摘要的来源列表（url/title/snippet），需全文时用 WebFetch 跟进。适合查最新政策/新闻/文档/API 变更等时效信息；搜索无结果或端点不支持时返回提示（勿盲目重试，可换关键词或改用 WebFetch 抓已知 URL）',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '搜索关键词（一句话或关键词组合）' },
        },
        required: ['query'],
      },
      run: (input) => webSearch(String(input?.query || '')),
    },
    // 扫描件 OCR（spawn python 调 ocr_engine.py；PDF/图片均可；结果按 project 缓存）
    OCR: {
      description: '对扫描件 PDF 或图片执行 OCR 文字识别（mode=text 提取全文；mode=table 额外识别表格，仅 PDF 有效；结果按 project 缓存，重复识别秒回）。图片默认走增强管线（enhance=auto：深色模式反色/对比度/低置信度重试/数字复核/超长截图分块，识别质量显著高于基础 OCR；enhance=off 可回退基础 OCR）。首次调用需加载识别模型，可能耗时数十秒——属正常初始化，勿误判卡死或重复调用。边界限制：仅可识别当前会话目录及其挂载目录（--add-dir）内的文件，会话外路径会被拒绝——调用前先确认目标文件位于会话目录内（若在会话外，先请用户将文件放入会话目录或经 --add-dir 挂载，不要盲目重试）。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要识别的 PDF/图片绝对路径' },
          mode: { type: 'string', description: '可选：text（默认，全文识别）| table（含表格识别）' },
          project: { type: 'string', description: '可选：项目名（缓存隔离，默认 default）' },
          enhance: { type: 'string', description: '可选：auto（默认，图片走增强管线）| off（基础 OCR）' },
        },
        required: ['file_path'],
      },
      run: (input) => ocrFile(String(input?.file_path ?? ''), allowDirs, input, skipBoundary),
    },
    // 图片语义理解：独立视觉模型端点（PONOS_VISION_*；GUI 设置选中后注入）
    Vision: {
      description: '用视觉模型理解图片内容（版面/物体/图表趋势/设计风格/图中文字语义；60s 超时；PNG/JPEG/WebP/GIF，≤20MB）。与 OCR 互补：OCR 提取文字，Vision 看图说话。未配置视觉模型时返回配置指引（勿重试，需先在应用设置中选中视觉模型）。边界限制：仅可识别当前会话目录及其挂载目录内的文件（同 Read/OCR）',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要理解的图片绝对路径（PNG/JPEG/WebP/GIF）' },
          instruction: { type: 'string', description: '可选：理解指令（缺省为详细描述图片内容）' },
        },
        required: ['file_path'],
      },
      run: (input) => visionDescribe(String(input?.file_path ?? ''), allowDirs, input, skipBoundary),
    },
    // 技能加载：从技能根目录（--add-dir，与提示词【可用技能】块同数据源）读取
    // SKILL.md 全文作为任务指引。只读工具，可并行加载多个技能；模型可在同一
    // 任务的多轮次中自主调用不同技能（一个技能不满足时换另一个）。
    Skill: {
      description: '加载技能指令：按技能名（skill 参数）读取对应 SKILL.md 的完整操作步骤，读取后按其流程执行；同一任务可多轮次自主调用不同技能（先调用最匹配的，不满足再换）。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { skill: { type: 'string', description: '技能名（与提示词【可用技能】清单中的 id 一致）' } },
        required: ['skill'],
      },
      run: (input) => {
        const id = String(input?.skill ?? '').trim()
        if (!id) return { content: 'skill 参数缺失：请传入技能名（提示词【可用技能】清单中的 id）', isError: true }
        // 全局停用（2026-09-15，D 条款）：按名调用也要拦。
        // 停用技能已从提示词与"可用清单"里消失，但模型可能**沿用历史对话/自身记忆**直接按名调用
        // （尤其是长会话里刚被停用的技能）。只在发现处过滤、不在调用处拦截 = 留了一条"照旧能用"
        // 的后门，用户看到的是"我明明停了它还在跑"。故这里独立判一次（防御深度，不是冗余）。
        if (isDisabled(disabledSkillIds, id)) {
          return { content: `技能「${id}」已被全局停用，当前不可调用。如需恢复，请在技能面板打开该技能的启用开关。`, isError: true }
        }
        const content = loadSkillContent({ roots: skillLoadRoots, id, flatRoots: flatSkillRootsArg })
        if (content == null) {
          const ids = discoverSkillsAll({ roots: skillLoadRoots, flatRoots: flatSkillRootsArg, disabled: disabledSkillIds }).map((s) => s.id)
          return { content: `技能不存在：${id}。可用技能：${ids.join(', ') || '（当前无可用技能）'}`, isError: true }
        }
        return { content: `技能「${id}」已加载，严格按以下指引执行：\n\n${content}`, isError: false }
      },
    },
    // MS1 个人/项目经验检索。S3 §4.2：**签名不变、内部转发**到知识库块级检索（老提示词/
    // 老会话零改动即获块级能力），索引不可用时回落 legacy 直检。输出条目含文件绝对路径供
    // Read 追全文。无命中返回明确提示（勿盲目换词重试——可先确认经验库是否有沉淀）。
    // 保留本工具而非直接改名：老提示词/老技能仍在引用它（契约纯增量，见 spec §2.6）。
    MemorySearch: {
      description: '检索个人/项目经验库（本地检索，无网络）：按 query 找过往沉淀的经验条目与知识块。命中返回条目清单（含主题/标签/摘要/全文/所在文件，score 排序），需全文用 Read 读给出的文件路径。适合"以前处理过类似问题吗"类查询。scope：personal=个人经验；project=项目经验（需项目库存在）；all=本会话知识范围（默认）。**新会话推荐改用 KnowledgeSearch**（支持限定空间、块级粒度与可选全文，速度更快）。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索关键词（一句话描述想找的经验主题）' },
          topK: { type: 'number', description: '可选：返回条数上限（1-10，默认 5）' },
          scope: { type: 'string', description: "可选：'personal' | 'project' | 'all'（默认 all）" },
        },
        required: ['query'],
      },
      run: (input) => {
        const q = String(input?.query ?? '').trim()
        if (!q) return { content: 'query 参数缺失：请描述想检索的经验主题', isError: true }
        const scope = String(input?.scope || 'all')
        const topK = Math.min(Math.max(1, Number(input?.topK) || 5), 10)
        // S3 §4.2：**签名不变，内部转发**到知识库块级检索（老提示词/老会话零改动即获块级能力）。
        // scope 映射：personal → ['experience']；project → ['project-*']（知识库里没有该空间，
        // 恒 0 命中 —— 与现状"cli 不传 projectMemoryRoot"等价，见 S3 spec §11.3 N2）；
        // all → null（全部可读空间）。configDir 推导同 KnowledgeSearch（memoryRoot 上溯两级）。
        if (memoryRoot) {
          // 会话知识范围（2026-09-15，P1 spec §3.4）：`all` 从"全部可读空间"收敛为本会话范围。
          // personal / project 两支**刻意不动**：personal 映射的 'experience' 恒在范围内（D4，
          // 经验库不可被移除）；project 映射到知识库里并不存在的 'project-*'（恒 0 命中，
          // 见 S3 §11.3 N2）——给一个不存在的空间套范围判定，只会把"本来就没数据"变成
          // "看起来没权限"，把一个既有的空结果问题换成一个更难懂的新问题。
          if (scope === 'all' && scopeEmpty) return { content: noSpaceMsg, isError: true }
          const mapped = scope === 'personal' ? ['experience']
            : scope === 'project' ? ['project-*']
              : (scopeSet ? scopeList : null)
          const r = searchKnowledgeItems({
            configDir: resolve(memoryRoot, '..', '..'),
            query: q,
            topK,
            spaces: mapped,
          })
          if (r.ok) {
            if (!r.items.length) {
              return { content: `经验库无「${q}」相关命中。可换关键词，或确认该主题尚未沉淀过经验。`, isError: false }
            }
            const lines = [`【经验库命中 ${r.items.length} 条，取前 ${r.items.length}】`]
            for (const it of r.items) {
              // 来源给**绝对路径**（而不是 docId）：Read 的白名单只含 memoryRoot 等目录，
              // 喂相对 docId 会让模型 Read 失败（legacy 实现本来就给绝对路径）。
              const rel = it.docId.slice(it.spaceId.length + 1)
              const sp = r.spaces.find((s) => s.id === it.spaceId)
              const file = sp ? join(sp.root, ...rel.split('/')) : it.docId
              const theme = rel.replace(/\.md$/i, '')
              lines.push(`- [${theme}${it.tag ? '|' + it.tag : ''}] ${it.text} -- ${it.full || it.text}（score ${it.score} · ${file}）`)
            }
            return { content: lines.join('\n'), isError: false }
          }
          // r.ok === false（索引不可用）：回落下面的 legacy 直检——工具能力不得因索引故障缩水。
        }
        const { items, count } = searchLocalMemory({
          personalRoot: memoryRoot,
          projectRoot: projectMemoryRoot,
          query: q,
          topK,
          scope,
        })
        if (!items.length) {
          const why = count > 0 ? '（均未达相似度阈值）' : ''
          return { content: `经验库无「${q}」相关命中${why}。可换关键词，或确认该主题尚未沉淀过经验。`, isError: false }
        }
        const lines = [`【经验库命中 ${count} 条，取前 ${items.length}】`]
        for (const it of items) {
          lines.push(`- [${it.theme}${it.tag ? '|' + it.tag : ''}] ${it.summary} -- ${it.full}（score ${it.score} · ${it.file}）`)
        }
        return { content: lines.join('\n'), isError: false }
      },
    },
    // S1 知识检索：走已建索引的块级检索（比 MemorySearch 的 O(N) 全量扫描快得多），
    // 支持按空间过滤与 snippet/full 两档。S1 阶段与 MemorySearch 并存，S3 收敛。
    KnowledgeSearch: {
      description: '在知识库中做块级检索（本地索引，无网络）：可跨"个人经验/会话记忆/我的笔记/知识包"等空间，按语义+关键词命中到**单个知识块**（一条经验、一个标题段、一段正文）。返回命中清单（空间/文件/标题/行号/分数/摘要 + **命中词**），mode=full 返回整块原文；命中很多时用 offset 翻页续看（回执末行给 total 与 nextOffset）；已授权（可 Read）空间需全文用 Read 打开对应文件行，其余空间只能用 mode=full。适合"知识库里有没有关于 X 的内容"类查询。spaces 可选限定空间；命中行括号内是 blockId；给 related=该 blockId 可展开这条的**一跳**关联锚点（只回 blockId/标题/理由，不做多跳扩散）。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索意图（自然语言，走向量匹配）' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选：精确关键词（走关键词路，适合专有名词/表名）' },
          spaces: { type: 'array', items: { type: 'string' }, description: '可选：限定空间 id 列表（**仅限本会话知识范围内的 id**，范围见提示词的【本会话知识库】段；越界会被拒绝）' },
          topK: { type: 'number', description: '可选：返回条数上限（1-10，默认 5）' },
          offset: { type: 'number', description: '可选：分页偏移（默认 0）。回执末行会给出 total 与 nextOffset —— 命中很多时**续看下一页**用起来，不要靠加大 topK 一次灌满上下文。' },
          mode: { type: 'string', description: "可选：'snippet'（默认，省上下文）| 'full'（整块原文）" },
          related: { type: 'string', description: '可选：给一个命中行的 blockId（形如 experience/workflow.md#2），返回该条目的**一跳**关联锚点（最多 5 条，只给 blockId/标题/理由；可 Read 空间用 Read，其余用 mode=full）。与 query 二选一或并用。' },
        },
        // S5 Task 10：`required` 由 ['query'] 放宽为二者皆可（至少给一个，由 run() 判）。
        // **why 必须放宽**：API 层会校验 required，若仍强制 query，"只想展开一跳"的调用会被
        // 直接 400 掉 —— 新参数就成了摆设。既有调用方一律带 query，行为不受影响。
        required: [],
      },
      run: (input) => {
        const relId = String(input?.related ?? '').trim()
        const q = String(input?.query ?? '').trim()
        if (!q && !relId) {
          return { content: 'query 参数缺失：请描述想检索的知识主题（或给 related 指定 blockId 展开一跳关联）', isError: true }
        }
        // 会话知识范围（2026-09-15，P1 spec §3.4）：越界一律**明确拒绝**，不返回空命中。
        // 两道判定各管一路入参：related 按 blockId 的空间前缀、query 按 spaces 参数。
        const scoped = scopedSpaces(input?.spaces)
        if (scoped.deny) return { content: scoped.deny, isError: true }
        const relDeny = relId ? blockIdOutOfScope(relId) : null
        if (relDeny) return { content: relDeny, isError: true }
        // configDir 推导：createToolRegistry 收到的 memoryRoot = <configDir>/memory/personal
        // （kernel/cli.mjs 的 memoryRoot(configDir)），故 <configDir> = memoryRoot 上溯两级。
        // memoryRoot 缺失（部分测试/嵌入场景不传）时**不猜路径**——用相对路径探知识根会
        // 在 cwd 下建 knowledge/.index，故直接降级为明确提示。
        if (!memoryRoot) {
          return { content: '知识库检索不可用（未配置知识根 memoryRoot）。可直接用 Read 打开记忆文件。', isError: false }
        }
        const configDir = resolve(memoryRoot, '..', '..')
        // 回执文案的可读性判据（P3）：`knowledgeReadableIds` = 已放行只读边界的空间 id 集合
        // （null = 无从判断 ⇒ 回执不加分支引导，措辞与改造前逐字一致）。同一份集合也决定
        // Read/Grep 的边界，故"回执说能读"与"真能读"永远同源。
        // related 分支优先：给了 blockId 就是"展开这条往哪读"，与 query 检索互不干扰
        // （同一工具的两个查询维度；两条路都只读、都不含正文）。
        if (relId) return expandRelated({ configDir, blockId: relId, limit: RELATED_EXPAND_LIMIT, readableSpaces: knowledgeReadableIds })
        return searchKnowledge({
          configDir,
          query: q,
          keywords: Array.isArray(input?.keywords) ? input.keywords : [],
          // 收窄后的空间集（越界已在上面拦掉）：未指定 → 本会话范围全集；不限（嵌入/测试）→ null。
          spaces: scoped.spaces,
          topK: Math.min(Number(input?.topK) || 5, 10),
          // 分页（P2）：上限兜在 200 —— 它是"翻到很深处"的护栏（一份 6917 块的库翻到
          // 第 500 条之后基本已不是"找得到"的问题，而是该换关键词或收窄空间了）。
          offset: Math.min(Math.max(0, Number(input?.offset) || 0), 200),
          mode: input?.mode === 'full' ? 'full' : 'snippet',
          readableSpaces: knowledgeReadableIds,
        })
      },
    },
    // 文件知识库导入（2026-09-14）：把一批文件（PDF/Word/Excel/PPT/图片/文本）转成
    // Markdown 落进一个知识空间，之后 KnowledgeSearch 就能检索到。
    //
    // **为什么是独立工具而不是让模型用 Bash 拼 python**：解析器定位（多候选探测）、
    // OCR 引擎探测、扩展名白名单、体积护栏、路径防护、幂等台账、索引同步——全在
    // kernel/knowledge-import.mjs 一份实现里。让模型自己拼命令行，等于把这条链路
    // 重新"手工实现"一遍，且必然漏掉幂等（重复导入）与护栏（黑名单扩展名）。
    KnowledgeImport: {
      description: '把一个文件或整个目录（递归）导入知识空间 —— **写盘操作**（本地处理、无网络）：解析成 Markdown 写入 knowledge/spaces/<space>/，之后用 KnowledgeSearch 即可检索。支持 PDF（含扫描件，走 OCR）、Word(docx)、Excel(xlsx/xls)、PPT(pptx)、图片、文本/markdown/CSV；可执行/脚本类文件与不支持的扩展名会被拒并给出原因。护栏：单文件 ≤50MB、整批 ≤500 个文件且 ≤300MB。返回结构化报告（JSON）：summary 是全量计数（imported/skipped/rejected/failed），results 逐条给状态与原因——rejected = 这条**本来就不该**进库（格式/体积/符号链接），failed = 该进库但**没成功**（加密/解析崩溃/写盘失败），两者的下一步动作不同。dryRun=true 只预览"将处理/将跳过/将被拒"的清单，不写任何文件。目标空间不存在会自动新建（只读知识包空间不可作目标）。results 超过 50 条时省略（summary 仍为全量计数），需要逐条明细请分批导入。注意扫描件 PDF 与大文件耗时较长（OCR 可能数分钟），一次批量导入请留足时间。**表格**：文本层 PDF（Word/Excel 导出）的表格由本地解析自动识别；扫描件/图片里的表格 OCR 读不出列结构，只有配置了视觉模型才会自动调它按页识别（慢且可能计费，默认最多 20 页）——未配置时正文照常导入，报告的 vision 字段会说明表格未提取，此时若要表格需先配置视觉模型再重新导入。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', description: '要导入的绝对路径（文件或目录；目录递归处理）' },
          space: { type: 'string', description: '目标空间 id（不存在则新建）。不得与内置空间（experience / session-memory / skill-experience）重名、不得以 pack- 开头、不得含 \\ / : * ? " < > | 或控制字符' },
          name: { type: 'string', description: '可选：空间显示名（缺省与 space 相同）' },
          dryRun: { type: 'boolean', description: '可选：true = 只预览"将处理 / 将跳过 / 将被拒"的清单，不落盘' },
          maxOcrPages: { type: 'number', description: '可选：扫描件 PDF 的 OCR 页数上限（默认 200；超出按页截断并在报告里说明）' },
          visionTables: { type: 'boolean', description: '可选：是否用视觉模型识别**扫描件/图片**里的表格（默认"配了视觉模型就用"）。关掉可省时间与调用费用；纯文本类文件与文本层 PDF 不受影响（后者自动识别表格）。未配置视觉模型时该项无效，报告里会给出提示' },
          maxVisionPages: { type: 'number', description: '可选：交视觉模型识别表格的页数上限（默认 20；视觉调用按页慢且可能计费，超出按页截断并出声）' },        },
        required: ['from', 'space'],
      },
      run: async (input, ctx) => {
        const from = String(input?.from ?? '').trim()
        const space = String(input?.space ?? '').trim()
        if (!from) return { content: 'from 参数缺失：请给出要导入的文件或目录的绝对路径', isError: true }
        if (!space) return { content: 'space 参数缺失：请给出目标空间 id（不存在会自动新建）', isError: true }
        // 与 KnowledgeSearch 同一套根推导（memoryRoot = <configDir>/memory/personal，上溯两级）。
        // 缺失时**不猜路径**：相对路径探知识根会在 cwd 下现种一棵 knowledge/.index（脏且难发现）。
        if (!memoryRoot) {
          return { content: '知识导入不可用（未配置知识根 memoryRoot）', isError: true }
        }
        const configDir = resolve(memoryRoot, '..', '..')
        // 动态 import：knowledge-import.mjs 是**体量较大**的模块（文档解析/OCR/落盘/索引
        // 同步），多数会话用不到 KnowledgeImport 工具，放到调用点加载以省启动开销。
        // 注：这里原先还有一条"顶层静态 import 会构成 ESM 循环依赖"的理由（本模块与
        // knowledge-import 互相引用：后者要 findOcrEngine / childEnv / registerChild）。
        // P2-1 拆分后该环**已消除**——OCR 探测在 media-tools、另两项在 exec-base，
        // knowledge-import 不再依赖本模块；故现在纯粹是按需加载，不再有环的约束。
        //
        // 调的是**对外主入口 `importFiles`**（T5 契约名，勿改）：它与 CLI/GUI 走的
        // `importDocuments` 是**同一条管线**（白名单/体积/符号链接/路径防护/台账/落盘/
        // 索引同步全在那份实现里），只是报告口径按任务契约翻成 `results[].status` 四态 +
        // `summary`。故本工具内**只有参数归一 + 一次调用**，没有第二份解析/渲染/落盘逻辑。
        const { importFiles } = await import('./knowledge-import.mjs')
        const maxOcr = Number(input?.maxOcrPages)
        let report
        try {
          report = await importFiles({
            configDir, from, space,
            name: String(input?.name ?? '').trim() || null,
            dryRun: input?.dryRun === true,
            maxOcrPages: Number.isFinite(maxOcr) && maxOcr > 0 ? Math.floor(maxOcr) : null,
            // 视觉表格提取：三态透传（undefined = auto，由 importFiles 按"是否配了视觉模型"决定）
            visionTables: input?.visionTables === false ? false : (input?.visionTables === true ? true : 'auto'),
            maxVisionPages: Number.isFinite(Number(input?.maxVisionPages)) && Number(input?.maxVisionPages) >= 0
              ? Math.floor(Number(input.maxVisionPages)) : null,
            // §6 注入点：python 调用点必须可注入假实现（工具级用例因此完全不加载 OCR 模型、
            // 不起 bridge）。生产链路上 ctx 里没有这个键 → null → importFiles 走
            // defaultConverter（真 python）。与 `ctx.browserDriver` 同一套依赖注入手法。
            runDocToMd: typeof ctx?.runDocToMd === 'function' ? ctx.runDocToMd : null,
          })
        } catch (e) {
          return { content: `导入失败：${e?.message || e}`, isError: true }
        }
        if (!report.ok) {
          // 错误码**原样透出**（invalid-space-id / readonly-space / not-found / empty-batch /
          // batch-too-large …）：只有码值能让模型自己决定"是改 id、换路径，还是分批"——
          // 吞成一句"导入失败"等于让它盲目重试同一批（spec P3-1 的 400/403 语义）。
          return { content: `导入未执行（${report.error}）：${report.message}`, isError: true }
        }
        // 逐文件失败**不**把工具标成 error：报告本身就是结果，标 error 会让模型丢掉
        // "哪些成功了"的信息（它只会看到一句失败，然后重复整批导入）。
        //
        // 体量护栏：整批上限 500 个文件，逐条明细全量回灌会吃掉上万 token（白烧上下文）。
        // 只截 `results`，`summary` 保持**全量计数**（模型仍准确知道多少成功/多少失败/多少
        // 被拒），省略条数显式写在报告里（`resultsOmitted`）——不静默丢信息。
        const MAX_ROWS = 50
        const results = report.results.slice(0, MAX_ROWS)
        const content = JSON.stringify({
          ...report,
          results,
          ...(report.results.length > MAX_ROWS ? { resultsOmitted: report.results.length - MAX_ROWS } : {}),
        }, null, 2)
        return { content, isError: false }
      },
    },
    // 知识库删除管理（回收站，2026-09-14）。设计见 .yfw-spec/knowledge-trash/spec.md。
    // 与 KnowledgeImport 对称：**三入口里唯一的 agent 面**，落盘/权限/路径防护全在
    // kernel/knowledge.mjs 一份实现，本工具内只有参数归一 + 一次调用。
    //
    // 为什么入 chat 禁用表：它是**写盘**能力（移动/删除用户的知识库文件），
    // 与 KnowledgeImport/Write 同类；chat 的语义是"纯聊/联网问答，不做本地执行与写盘"。
    KnowledgeDelete: {
      description: '管理知识库的删除（**软删除到回收站**，本地、无网络）：列出回收站、删条目、删整个知识库、还原、彻底删除。删除都是"移到回收站"而非销毁 —— 还原会把内容放回原位（遇同名自动改名让位，绝不覆盖）。\n\naction：\n· list —— 列出回收站（名称/原空间/删除时间/大小/内容是否还在）。**建议先 list 再决定还原还是彻底删**。\n· doc —— 删一个条目，需 space + path（path 是空间内相对 .md 路径，如 "研发/立项报告.md"）。\n· space —— 删**整个知识库**，需 space + confirm 且 confirm 必须精确等于 space。只允许删用户自建的库；内置空间（experience / session-memory / skill-experience）只能删其中条目、不能删库；知识包（pack-*）完全只读。\n· restore —— 还原，需 trashId（从 list 取）。\n· purge —— 彻底删除（**真正销毁、不可恢复**），需 trashId；或 action=purge 且 all=true 清空整个回收站。\n\n注意：删整库是不可逆量级更大的操作，先与用户确认再执行；不确定时用 list 看现状。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'doc', 'space', 'restore', 'purge'], description: '要执行的操作' },
          space: { type: 'string', description: 'action=doc|space 时必填：空间 id（内置空间只允许删条目）' },
          path: { type: 'string', description: 'action=doc 时必填：空间内的相对 .md 路径' },
          confirm: { type: 'string', description: 'action=space 时必填：必须精确等于 space（防误删整库）' },
          trashId: { type: 'string', description: 'action=restore|purge 时必填：回收站条目 id（从 action=list 取）' },
          all: { type: 'boolean', description: 'action=purge 时可选：true = 清空整个回收站（与 trashId 二选一）' },
        },
        required: ['action'],
      },
      run: async (input, ctx) => {
        const action = String(input?.action ?? '').trim()
        if (!action) return { content: 'action 参数缺失：可选 list / doc / space / restore / purge', isError: true }
        if (!memoryRoot) {
          return { content: '知识库删除不可用（未配置知识根 memoryRoot）', isError: true }
        }
        const configDir = resolve(memoryRoot, '..', '..')
        // 注入点（与 `ctx.runDocToMd` 同一套依赖注入手法）：工具级用例可直接给假 store，
        // 完全不起真进程、不碰真实磁盘。生产链路上 ctx 无此键 → 走真 store。
        let store = ctx?.knowledgeStore || null
        if (!store) {
          // 动态 import 的理由同 KnowledgeImport：本模块与知识生态互相引用，
          // 顶层静态 import 会构成 ESM 循环依赖；调用点加载保持依赖单向。
          const { createKnowledgeStore } = await import('./knowledge.mjs')
          store = createKnowledgeStore({ configDir })
          store.load()
        }
        try {
          if (action === 'list') {
            const t = store.listTrash()
            return { content: JSON.stringify(t, null, 2), isError: false }
          }
          if (action === 'doc') {
            const r = store.deleteDoc({ space: input?.space ?? null, path: input?.path ?? null })
            if (!r.ok) return { content: `删除未执行（${r.error}）：${r.message}`, isError: true }
            return { content: JSON.stringify(r, null, 2), isError: false }
          }
          if (action === 'space') {
            const r = store.deleteSpace({ space: input?.space ?? null, confirm: input?.confirm ?? null })
            if (!r.ok) return { content: `删除未执行（${r.error}）：${r.message}`, isError: true }
            return { content: JSON.stringify(r, null, 2), isError: false }
          }
          if (action === 'restore') {
            const r = store.restore({ trashId: input?.trashId ?? null })
            if (!r.ok) return { content: `还原未执行（${r.error}）：${r.message}`, isError: true }
            return { content: JSON.stringify(r, null, 2), isError: false }
          }
          if (action === 'purge') {
            // `all` 只认**严格 true**（同 server 路由）：`"false"`/0 这类写法按单条删除走，
            // 宁可少删也不能因参数写法把整个回收站清了。
            const r = store.purge({ trashId: input?.trashId ?? null, all: input?.all === true })
            if (!r.ok) return { content: `彻底删除未执行（${r.error}）：${r.message}`, isError: true }
            return { content: JSON.stringify(r, null, 2), isError: false }
          }
          return { content: `未知 action：${action}（可选 list / doc / space / restore / purge）`, isError: true }
        } catch (e) {
          return { content: `知识库删除失败：${e?.message || e}`, isError: true }
        }
      },
    },
    // 联网技能搜索：检索 Claude Code marketplace 生态（Anthropic 官方 + 社区市场），
    // 返回技能名/描述/触发词/来源/SKILL.md 地址。只读检索、不安装；市场列表缓存
    // 10 分钟，命中 top-K 才深挖 SKILL.md（控制请求预算）。安装仍走 bridge /install-skill。
    SkillSearch: {
      description: '联网搜索技能市场（Claude Code marketplace 生态：Anthropic 官方 + 社区市场）：按关键词检索可用的技能，返回技能名/描述/触发词/来源与 SKILL.md 地址。适合"有没有处理表格/PDF 的技能""找一个做 xxx 的技能"等需求；只读检索不安装，需要安装时向 bridge /install-skill 提供返回的地址。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '搜索关键词（中英文均可，如 表格处理 / spreadsheet / pdf 文档）' },
          limit: { type: 'number', description: '可选：返回条数上限（默认 8，最大 20）' },
          source: { type: 'string', description: '可选：限定数据源（anthropic=官方 / community=社区市场，缺省全部）' },
        },
        required: ['query'],
      },
      run: async (input) => {
        const q = String(input?.query ?? '').trim()
        if (!q) return { content: 'query 参数缺失：请输入要检索的技能关键词（如"表格处理"或"pdf"）', isError: true }
        const { results, failed, error } = await searchSkills({
          query: q,
          limit: Number(input?.limit) || 8,
          source: String(input?.source ?? '').trim() || undefined,
        })
        if (error && !results.length) {
          const failNote = failed.length ? `（来源失败：${failed.map((f) => `${f.source}:${f.reason}`).join('；')}）` : ''
          return { content: `技能搜索失败：${error}${failNote}`, isError: true }
        }
        if (!results.length) {
          const failNote = failed.length ? `（部分来源不可达：${failed.map((f) => f.source).join('、')}）` : ''
          return { content: `未在技能市场找到与「${q}」匹配的技能${failNote}。可换关键词（如英文：spreadsheet / pdf / docx）重试`, isError: false }
        }
        const lines = [`【技能搜索】关键词「${q}」匹配 ${results.length} 条（来源：${[...new Set(results.map((r) => r.sourceLabel))].join(' + ')}）：`]
        results.forEach((r, i) => {
          const trig = Array.isArray(r.triggers) && r.triggers.length ? `（触发：${r.triggers.join('、')}）` : ''
          lines.push(`${i + 1}. [${r.sourceLabel}] ${r.name} — ${r.description}${trig}`)
          if (r.url) lines.push(`   SKILL.md: ${r.url}`)
        })
        if (failed.length) lines.push(`（注：来源不可达：${failed.map((f) => `${f.source}（${f.reason}）`).join('；')}）`)
        return { content: lines.join('\n'), isError: false }
      },
    },
    // 工作流执行：与 Skill 平权（同一发现/触发机制），定位差异=严格输出。
    // 需要固定流程/审计留痕的任务用 Workflow（确定性 DAG 执行 + 哈希链审计），
    // 灵活探索用 Skill（模型按 SKILL.md 自由执行）。workflow 引擎实例由
    // createWorkflowEngine 创建后经 cli 注入（registry 闭包 workflow 变量）。
    Workflow: {
      description: '执行固定流程工作流（严格输出、审计留痕）。当任务需要确定性流程/规范处理/可审计步骤时用（如申报材料审查、文件处理流水线、多步校验）；灵活探索/多方案任务用 Skill。workflow 参数传工作流 id（可用 /wf list 查看或提示词【可用工作流】清单），inputs 传入口参数。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workflow: { type: 'string', description: '工作流 id（与技能清单中【可用工作流】的 id 一致）' },
          inputs: { type: 'object', description: '入口参数（工作流 inputs 定义），如 {"report_path":"..."}' },
          mode: { type: 'string', enum: ['sync', 'background'], description: 'sync=阻塞等结果；background=立即返回 run_id' },
        },
        required: ['workflow'],
      },
      run: async (input) => {
        const id = String(input?.workflow ?? '').trim()
        if (!id) return { content: 'workflow 参数缺失：请传入工作流 id（提示词【可用工作流】清单）', isError: true }
        if (!workflow) return { content: '工作流引擎未初始化', isError: true }
        // M3 可见性闸门：本通用工具不得成为私密/未绑定/旧格式工作流的后门——隐藏一个具名
        // 工具（private 不入 dyntools 工具池）却能靠 id 直接执行，等于绕过工具列表。
        // 判定口径与工具池同源（engine.canRun → dyntools.visibilityOf + legacy 拒绝），
        // 不可见即拒绝执行、不落审计。canRun 缺失（测试替身/旧引擎）时跳过闸门。
        if (typeof workflow.canRun === 'function') {
          const gate = workflow.canRun(id)
          if (!gate.ok) return { content: `工作流「${id}」不可执行：${gate.reason}`, isError: true }
        }
        const mode = input?.mode === 'background' ? 'background' : 'sync'
        const r = await workflow.run({ id, inputs: input?.inputs || {}, mode })
        if (!r.ok) return { content: `工作流「${id}」执行失败: ${r.error}${r.node ? `（节点 ${r.node}）` : ''}`, isError: true }
        return {
          content: `工作流「${id}」执行完成（${r.status}，${r.steps} 步）\n审计: ${r.auditPath || '未落盘'}\n输出: ${JSON.stringify(r.outputs, null, 2)}`,
          isError: false,
        }
      },
    },
    // 内置浏览器自动化：经 bridge_request(browser) 路由到主进程执行器
    // （docs/bridge-contract.md §4 bridge_request；bridge 的 browserRouter 已接线）。
    // 执行体在 engine（ctx.browserDriver 挂起等 bridge 回写 browser_response 解除）。
    Browser: {
      description: '驱动内置浏览器执行页面操作（快照驱动：先 snapshot 查看页面结构与可交互元素 ref，再按 ref 操作）。支持动作：goto 导航 / back 后退 / forward 前进 / refresh 刷新 / snapshot 页面快照 / click 点击 / type 输入 / select 选择 / scroll 滚动 / hover 悬停 / wait 等待 / js 页面内执行 JS。元素 ref 随页面变化失效——操作失败时重新 snapshot 获取最新 ref，勿沿用旧 ref 重试。域名白名单限制：goto 访问非白名单域名会被拦截（默认放行政务 *.gov.cn / 搜索 / 企业查询 / 邮箱等站点）。被拦截时系统会向用户请求批准——若用户批准，该域名即自动写入白名单并即时生效，你直接重试同一操作即可；若用户拒绝，改用 WebFetch/WebSearch 等其他途径，勿反复重试。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', description: '浏览器动作：goto/back/forward/refresh/snapshot/click/type/select/scroll/hover/wait/js' },
          params: {
            type: 'object',
            additionalProperties: true,
            description: '动作参数：goto 需 url；click/type/select/hover 需 ref（快照中的元素引用）；type 另需 text；scroll 需 delta（像素，正数向下）或 ref（滚到某元素）；wait 需 ms；js 需 expression。快照驱动，未知元素先 snapshot 获取 ref。',
          },
        },
        required: ['action'],
      },
      run: (input, ctx) => {
        if (typeof ctx?.browserDriver !== 'function') return { content: '浏览器执行器不可用（应用主进程未注册）', isError: true }
        return ctx.browserDriver(String(input?.action || ''), input?.params || {})
      },
    },
  }
  // 动态工具（工作流即工具）：视图函数每次求值，磁盘上增删工作流即时生效。
  // 可传函数（每次求值）或对象（静态快照）；取值/求值异常一律视为空池，不阻断 turn。
  let dynamicToolsRef = dynamicTools
  // K0 观测：`tools=` = 视图求值次数/毫秒。静态名单 getter（toolNames 等）实际被
  // engine 每迭代 + 每次工具调用各读一次，是 K1.2 工具表缓存的核心指标。
  const dynamicView = () => perfTime('tools', () => {
    try { return (typeof dynamicToolsRef === 'function' ? dynamicToolsRef() : dynamicToolsRef) || {} } catch { return {} }
  })
  return {
    registry,
    // getter（非快照）：动态工具（工作流即工具）随磁盘增删即时进出名单，故每次读取求值
    get toolNames() {
      return [...Object.keys(registry).filter((n) => !blocked.has(n)), ...Object.keys(dynamicView()).filter((n) => !blocked.has(n) && !(n in registry))]
    },
    // P0-4：只读工具并发安全标记（Bash/Write/Edit/Task/OCR 等写/执行类串行）。
    // Agent 自 2026-09-17（第 10 项）改为并发安全：同轮多子代理并行分派，扇出上限由
    // engine 的前台并发槽兜住（见 tools.mjs 中 Agent 条目下的并发安全依据）。
    isConcurrencySafe(name) {
      return registry[name]?.concurrencySafe === true || dynamicView()[name]?.concurrencySafe === true
    },
    // 中立工具 schema 列表（Anthropic/OpenAI 协议字段映射在 api.mjs 完成）
    toolSchemas() {
      const statics = Object.entries(registry).filter(([name]) => !blocked.has(name)).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
      const dyn = Object.entries(dynamicView()).filter(([name]) => !blocked.has(name) && !(name in registry)).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
      return [...statics, ...dyn]
    },
    // 动态工具源热替换（engine.mjs 不转发 dynamicTools —— 其调用点不在本任务改动范围，
    // cli 拿到 engine.tools 后经此注入；与 dynamicTools 构造参数等价，后设覆盖先设）
    setDynamicTools(fn) { dynamicToolsRef = fn || null },
    // 知识空间只读边界注入（P3，2026-09-20）：同 setDynamicTools 的处境——engine.mjs 的
    // createToolRegistry 调用点不转发该参数，cli 算出"本会话授权的空间根"后经此注入
    // （与构造参数 knowledgeReadDirs 等价，后设覆盖先设）。边界与 fail-closed 论证见函数
    // 开头"只读边界"块；**只影响只读侧**：Write/Edit/Bash 的边界在闭包里恒定，热注入改不到。
    setKnowledgeReadDirs(dirs) { knowledgeReadSources = dirs; applyKnowledgeReadDirs() },
    // 执行入口：返回归一化 { content, isError }（成功路径可能缺省 isError）；
    // approval 决策由调用方（engine）先行。兜底铁律：任何工具实现抛异常
    // （含审批/hook 内部错误）都不得向上中断 turn——归一化为错误结果返回，
    // 调用方（runToolBatch）看到 isError 后模型可自愈重试，会话不断。
    async run(toolUse, ctx) {
      const name = toolUse?.name
      if (blocked.has(name)) return { content: `工具已被禁用：${name}`, isError: true }
      // 动态工具（工作流即工具）：与静态同名冲突时静态优先（动态名单已排除同名项）；
      // 被禁/未命中的动态调用同样在此拒绝——防模型绕过工具列表。
      const dynTool = !(name in registry) ? dynamicView()[name] : null
      const tool = registry[name] || dynTool
      if (!tool) return { content: `未知工具：${name}`, isError: true }
      let r
      try {
        r = await tool.run(toolUse.input || {}, ctx)
      } catch (e) {
        return { content: `工具执行异常：${e?.message || String(e)}`, isError: true }
      }
      if (r && typeof r === 'object') {
        return { content: r.content ?? '', isError: r.isError === true, ...(r.meta ? { meta: r.meta } : {}) }
      }
      return { content: String(r ?? ''), isError: false }
    },
  }
}
