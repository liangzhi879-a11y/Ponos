// YFW-turbo 工具注册表与执行器（docs/bridge-contract.md §9 替换面：工具执行器）
// ---------------------------------------------------------------------------
// 工具集：Bash（shell 执行，高危命令经 permissions 审批）、Read/Write/Edit
// （文件读写与编辑，路径边界校验）、Glob/Grep（边界内搜索）、Agent（子代理
// 分发，执行体在 engine）、Task（后台任务管理）、TodoWrite（任务规划）、
// WebFetch（URL 抓取，零依赖 Node https）、OCR（spawn python 调 ocr_engine.py
// 识别扫描件，零 npm 依赖）。返回统一结果 { content, isError, meta? }，由
// engine 以 tool_result 回填模型。
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep, join, extname, basename } from 'node:path'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { get as httpGet, request as httpRequest } from 'node:http'
import { matchesHighRisk } from './highrisk.mjs'
import { discoverSkillsAll, loadSkillContent } from './skills.mjs'
import { getProvider } from './provider.mjs'

// R2-1 活跃子进程登记：Bash/OCR spawn 的子进程统一登记，内核退出（SIGINT/TERM）
// 时 killActiveChildren 兜底清理，防孤儿进程。child 'close' 后自动移除。
const ACTIVE_CHILDREN = new Set()
export function registerChild(child) {
  ACTIVE_CHILDREN.add(child)
  child.once('close', () => ACTIVE_CHILDREN.delete(child))
  return child
}
export function killActiveChildren() {
  for (const c of ACTIVE_CHILDREN) {
    try {
      // Windows 坑：git-bash（MSYS2）的 bash.exe 对 TerminateProcess 免疫，
      // child.kill() 返回 true 但进程不死（实测）。taskkill /F /T 杀整个进程树
      // （含 bash 派生的 sleep 等子进程），契约 §8"真杀 bash"同源。非 Windows
      // 走常规 kill。已退出进程 taskkill 非 0 → execSync 抛 → catch 忽略。
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /T /PID ${c.pid}`, { stdio: 'ignore' }) } catch { /* 进程已退出 */ }
      }
      c.kill()
    } catch {}
  }
  ACTIVE_CHILDREN.clear()
}

// S2-2 子进程 env 白名单：仅透传系统路径/编码/代理变量，剥离一切密钥与
// ANTHROPIC_*/CLAUDE_CODE_* 配置（防 Bash/OCR 子进程窃取宿主密钥）。
const ENV_WHITELIST = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LANGUAGE', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]
export function childEnv() {
  const out = {}
  for (const k of Object.keys(process.env)) {
    if (ENV_WHITELIST.includes(k)) out[k] = process.env[k]
  }
  return out
}

const BASH_TIMEOUT_MS = 120_000
// Read 一次读取的容量上限（对照 claude/deepseek 的 2000 行、pi 的截断提示）：
// 模型看到声明后放心一次读全文，不再用 sed/python 碎片化取样。
const READ_MAX_LINES = 2000
const READ_MAX_BYTES = 2 * 1024 * 1024

// Windows 探测 git-bash：Bash 工具语义须与系统提示一致（shell: bash）。
// cmd.exe 的 /d /s /c 引号解析与 Node spawn 的参数包裹互相干扰（$HOME 不展开、
// 引号错乱），且 PATH 混入 Git Unix 工具时行为不可预测；git-bash 与模型所见
// 环境一致。找不到 git-bash 时回退 cmd.exe。
function findGitBash() {
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

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

// 文件路径边界：仅允许读写 --add-dir 注入的目录（cwd / 技能根）内文件
// S4-1 路径加固：realpath 解析真实路径（解符号链接），防链接逃逸出边界。
// 文件不存在时对最近存在的父目录做 realpath，再拼回剩余段（写入新文件场景）。
function safeRealpath(p) {
  try { return realpathSync(p) } catch { return p }
}
function realForComparison(p) {
  const r = resolve(p)
  const real = safeRealpath(r)
  if (real !== r) return real
  // 路径不存在：逐级向上找最近存在的祖先做 realpath
  let cur = r
  const tail = []
  for (let i = 0; i < 32; i++) {
    try {
      realpathSync(cur)
      return join(realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return r
      tail.push(basename(cur))
      cur = parent
    }
  }
  return r
}

function withinBoundary(filePath, allowDirs) {
  const resolved = resolve(filePath)
  const real = realForComparison(resolved).toLowerCase()
  return allowDirs.some((dir) => {
    const base = realForComparison(resolve(dir)).toLowerCase()
    return real === base || real.startsWith(base + sep)
  })
}

// 相对路径解析到 cwd（消除"试 4 种路径格式"的浪费）：绝对路径原样，~ 展开，
// 其余 resolve(cwd, p)。参考 claude/pi 的 resolveToCwd 机制。
function resolvePath(p, cwd) {
  if (!p) return p
  if (p.startsWith('~') || p.startsWith('~/')) return join(process.env.HOME || process.env.USERPROFILE || '', p.slice(p[1] === '/' ? 2 : 1))
  return resolve(cwd || process.cwd(), p)
}

// Read 去重 stub（对照 claude FILE_UNCHANGED_STUB）：全量读过的文件在 mtime/size
// 未变时再次读取返回 stub，提示直接引用此前结果——省去模型重复读同一文件
// 的往返与 token（T003 上轮 Read 6 次中部分为重复读）。
const READ_STUB_PREFIX = '文件自上次读取后未变化'

function readFile(filePath, allowDirs, input = {}, cwd, readCache, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    const resolved = resolvePath(filePath, cwd)
    if (!skipBoundary && !withinBoundary(resolved, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${resolved}）`, isError: true }
    if (!existsSync(resolved)) return { content: `文件不存在：${resolved}（当前工作目录：${cwd || process.cwd()}；可用 Glob 定位候选文件或用绝对路径）`, isError: true }
    const st = statSync(resolved)
    if (st.isDirectory()) return { content: `是目录：${resolved}`, isError: true }
    // 超大文件不直接读全文（读一半即 2MB 内存），改为报错 + 定向读取建议
    // （对照 claude 的 maxSizeInstruction：让模型知道用什么参数继续，而非猜）
    if (st.size > READ_MAX_BYTES) {
      return { content: `文件过大（${st.size} 字节），超出 ${READ_MAX_BYTES} 字节读取上限；请用 offset/limit 参数定向读取（offset 起始行号，limit 行数）`, isError: true }
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
    // 部分读取时追加进度指引（对照 pi 的 "[Showing X-Y of N. Use offset=Z to continue]"）：
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
    // 对照 claude FILE_UNCHANGED_STUB）。部分读取（offset/limit）不参与去重——定向
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
    // CRLF 行尾归一化（对照 claude FileEditTool.ts:214 的 replaceAll('\r\n','\n')）：
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

// Glob：在会话目录边界内递归匹配文件名/路径（pattern 支持 * ? 和 **）。
// 匹配前把路径归一化为正斜杠，Windows 反斜杠路径与 pattern 里的 / 均能命中。
function globSearch(pattern, allowDirs, { maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    const re = globToRegExp(String(pattern).replace(/\\/g, '/'))
    const explicit = explicitIgnoreDirs(pattern)
    const results = []
    const seen = new Set()
    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (results.length >= maxResults) break
        if (ent.name.startsWith('.') && ent.name !== '.' && ent.name !== '..') continue // 跳过隐藏项
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name, explicit)) continue // 剪枝依赖/构建目录
          walk(full)
        } else {
          const normalized = full.replace(/\\/g, '/')
          if (re.test(normalized) && !seen.has(full)) { seen.add(full); results.push(full) }
        }
      }
    }
    for (const base of allowDirs) walk(base)
    if (results.length === 0) return { content: `无匹配文件（pattern: ${pattern}）。依赖/构建目录（node_modules 等）默认剪枝——若目标在其中，请用含目录段的 pattern（如 **/node_modules/**）；否则用更精确的 pattern，勿反复全树试探` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n') + truncated }
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
function grepSearch(pattern, allowDirs, { glob, context = 0, maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    let re
    try { re = new RegExp(String(pattern)) } catch (e) { return { content: `正则无效：${e.message}`, isError: true } }
    const ctx = Math.max(0, Math.min(Number(context) || 0, 10))
    const globRe = glob ? globToRegExp(String(glob).replace(/\\/g, '/')) : null
    // 显式引用忽略目录（glob 或 pattern 含 node_modules 等）→ 该目录不剪枝
    const explicit = new Set([...explicitIgnoreDirs(glob), ...explicitIgnoreDirs(pattern)])
    const results = []
    const MAX_BYTES = 2 * 1024 * 1024
    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        if (results.length >= maxResults) break
        if (ent.name.startsWith('.')) continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name, explicit)) continue // 剪枝依赖/构建目录
          walk(full)
        } else if (!globRe || globRe.test(full.replace(/\\/g, '/'))) {
          let st
          try { st = statSync(full) } catch { continue }
          if (!st.isFile() || st.size > MAX_BYTES) continue
          // 单文件读取失败（权限/占用/编码）跳过，不中断整个搜索；
          // 含 NUL 字节视为二进制跳过（避免乱码误匹配）
          let content
          try { content = readFileSync(full, 'utf-8') } catch { continue }
          if (content.includes('\0')) continue
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              const from = Math.max(0, i - ctx)
              const to = Math.min(lines.length, i + ctx + 1)
              const block = []
              for (let j = from; j < to; j++) block.push(`${j + 1}:${lines[j]}`)
              results.push(`—— ${full}（行 ${i + 1}）\n${block.join('\n')}`)
              if (results.length >= maxResults) break
            }
          }
        }
      }
    }
    for (const base of allowDirs) walk(base)
    if (results.length === 0) return { content: `无匹配行（pattern: ${pattern}${glob ? `, glob: ${glob}` : ''}）。依赖/构建目录默认剪枝——若目标在其中，glob 需含目录段（如 **/node_modules/**）显式放行；否则核对正则，勿反复试探` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n\n') + truncated }
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
      headers: { 'user-agent': 'YFW-turbo/0.1', accept: 'text/html,text/plain,*/*' },
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
// 零新依赖——复用 provider（ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL），参考
// deepseek-harness web-search-deepseek provider 的 wire 契约：POST /v1/messages，
// body 带 tools:[{type:'web_search_20250305', name:'web_search', max_uses}]，
// 解析 web_search_tool_result 块（url/title/page_age）+ text 块 citations
// （cited_text 作 snippet，url 首见优先）。
// ---------------------------------------------------------------------------
const WEB_SEARCH_TIMEOUT_MS = 30_000
const WEB_SEARCH_MAX_USES = 5
const WEB_SEARCH_MAX_TOKENS = 4096

// mock：YFW_MOCK_API=1 时返回固定结果（测试零依赖，验证格式链路）
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

// Anthropic Messages 响应 → 来源列表（与 deepseek-harness mapAnthropicResponse 同构）
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
  if (process.env.YFW_MOCK_API === '1') return webSearchMock(q)
  const p = getProvider()
  const base = p.baseUrl
  const token = p.authToken
  const model = p.model || process.env.ANTHROPIC_MODEL || ''
  if (!base || !token) return { content: 'WebSearch 需要配置 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（与主对话同一 provider 端点）', isError: true }
  const url = base.replace(/\/+$/, '') + '/v1/messages'
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        'authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'accept': 'application/json',
        'user-agent': 'YFW-turbo/0.1',
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
// OCR：扫描件识别。内核保持零 npm 依赖——OCR 能力来自外部 python 引擎
// （RapidOCR/PP-OCRv4，见 ~/.claude/skills/_common/ocr_engine.py），工具仅负责
// 定位引擎、传参、解析输出。引擎探测：YFW_OCR_ENGINE env 覆盖 → 常见技能路径。
// 输出用 --output 写临时 JSON 全量结果（stdout 仅 500 字符预览），解析后删除。
// ---------------------------------------------------------------------------
const OCR_TIMEOUT_MS = 300_000

function findOcrEngine() {
  if (process.env.YFW_OCR_ENGINE && existsSync(process.env.YFW_OCR_ENGINE)) return process.env.YFW_OCR_ENGINE
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    join(home, '.claude', 'skills', '_common', 'ocr_engine.py'),
    join(home, '.yfworking', 'skills', '_common', 'ocr_engine.py'),
  ]
  return candidates.find((p) => existsSync(p)) || null
}

// Windows 优先 python（rapidocr_onnxruntime 装入的解释器），ENOENT 时回退 py。
// 优先使用 bridge 注入的 YFWORKING_PYTHON（随应用捆绑的 runtime/python/python.exe，
// 见 server/bridge.mjs findPythonExe），新环境无系统 python 时 OCR 仍可用。
function runPythonCapture(args, { cwd, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const envPy = process.env.YFWORKING_PYTHON
    const pythons = envPy
      ? [envPy]
      : (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])
    let idx = 0
    const attempt = () => {
      const py = pythons[idx]
      if (!py) return resolvePromise({ content: 'OCR 失败：未找到 python 解释器（需安装 python + rapidocr_onnxruntime）', isError: true })
      const child = registerChild(spawn(py, args, { cwd: cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }))
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
        finish(`OCR 超时（${timeoutMs}ms）`, true)
      }, timeoutMs)
      child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 500_000) stdout = stdout.slice(-500_000) })
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000) })
      child.on('error', (e) => {
        if (e.code === 'ENOENT') { idx++; attempt() }
        else finish(`OCR 引擎启动失败：${e.message}`, true)
      })
      child.on('close', (code) => {
        const out = stdout.trim()
        const err = stderr.trim()
        const body = code === 0
          ? (out || '(OCR 引擎执行完成，无输出)')
          : `OCR 引擎退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err.slice(0, 2000) : ''}`.trim()
        finish(body, code !== 0)
      })
    }
    attempt()
  })
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']

// OCR 主逻辑：边界/存在性校验 → 引擎探测 → python 执行 → 解析。
// PDF 走 CLI（--output 临时 JSON 全量结果）；图片走内联 import 调 ocr_image()
// （引擎 CLI 的 ocr 命令面向 PDF，fitz 包装图片会判为空白页）。零 npm 依赖。
async function ocrFile(filePath, allowDirs, input = {}, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!skipBoundary && !withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (statSync(filePath).isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const mode = input?.mode === 'table' ? 'table' : 'text'
    const project = String(input?.project || 'default')
    const engine = findOcrEngine()
    if (!engine) {
      const home = process.env.USERPROFILE || process.env.HOME || ''
      const checked = [
        join(home, '.claude', 'skills', '_common'),
        join(home, '.yfworking', 'skills', '_common'),
      ].join('、')
      return { content: `OCR 引擎不可用：未找到 ocr_engine.py（已检查 ${checked}；可设置 YFW_OCR_ENGINE 指向引擎路径）`, isError: true }
    }
    const isImage = IMAGE_EXTS.includes(extname(filePath).toLowerCase())
    let data = null
    if (isImage) {
      // 图片：内联 import ocr_engine.ocr_image（table 模式对图片无意义，一律全文）
      const engineDir = dirname(engine)
      const script = [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(engineDir)})`,
        'from ocr_engine import ocr_image',
        `r = ocr_image(${JSON.stringify(filePath)}, ${JSON.stringify(project)})`,
        'print(json.dumps(r, ensure_ascii=False))',
      ].join('; ')
      const r = await runPythonCapture(['-c', script], { cwd: dirname(filePath) })
      if (r.isError) return { content: `OCR 失败\n${r.content}`, isError: true }
      // 引擎初始化日志混在 stdout，JSON 是最后一个以 { 开头的行
      const jsonLine = r.content.split('\n').reverse().find((l) => l.trim().startsWith('{'))
      try { data = JSON.parse(jsonLine) } catch { return { content: `OCR 引擎输出无效\n${r.content}`, isError: true } }
      if (data?.error) return { content: `OCR 失败：${data.error}`, isError: true }
    } else {
      const tmpOut = join(tmpdir(), `yfw-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      const args = mode === 'table'
        ? [engine, 'ocr-table', '--file', filePath, '--project', project, '--output', tmpOut]
        : [engine, 'ocr', '--file', filePath, '--project', project, '--output', tmpOut]
      const r = await runPythonCapture(args, { cwd: dirname(filePath) })
      try { data = JSON.parse(readFileSync(tmpOut, 'utf-8')) } catch {}
      try { rmSync(tmpOut, { force: true }) } catch {}
      if (r.isError) {
        const errMsg = data?.error ? `：${data.error}` : ''
        return { content: `OCR 失败${errMsg}\n${r.content}`, isError: true }
      }
      if (!data) return { content: `OCR 引擎无有效输出\n${r.content}`, isError: true }
    }
    // 组装结果：多页加页标记；table 模式追加表格（tab 分隔行）
    const pages = Array.isArray(data.pages) ? data.pages : []
    const textBlock = pages.length > 1
      ? pages.map((p) => `--- 第 ${p.page} 页 ---\n${p.text || ''}`).join('\n')
      : (pages[0]?.text || data.text || '')
    const tables = Array.isArray(data.tables) ? data.tables : []
    const tableBlock = tables.length
      ? tables.map((t, i) => {
          const rows = Array.isArray(t.data) ? t.data : []
          const lines = rows.map((row) => (Array.isArray(row) ? row.join('\t') : String(row ?? '')))
          return `[表格 ${i + 1}（第 ${t.page} 页，${lines.length} 行）]\n${lines.join('\n')}`
        }).join('\n\n')
      : ''
    const meta = {
      scanned: isImage ? null : data.is_scanned === true,
      pages: pages.length,
      cacheHit: data.cache_hit === true,
      tables: tables.length,
      confidence: data.confidence ?? pages[0]?.confidence ?? null,
    }
    const kind = isImage ? '图片' : (meta.scanned ? '扫描件' : '含文本层')
    const head = `[OCR] ${data.file || filePath}（${kind}，${meta.pages} 页，缓存命中：${meta.cacheHit ? '是' : '否'}）`
    const body = [head, textBlock, tableBlock].filter(Boolean).join('\n\n').trim()
    return { content: body || `OCR 未识别到文本（${filePath}）`, isError: false, meta }
  } catch (e) {
    return { content: `OCR 失败：${e.message}`, isError: true }
  }
}

// ---------------------------------------------------------------------------
// Vision：图片语义理解。走独立视觉模型端点（YFW_VISION_BASE_URL/MODEL/
// AUTH_TOKEN，bridge buildChildEnv 已注入；visionFromEnv 上报同源），Anthropic
// 兼容 /v1/messages 带 image block。零新依赖。OCR 是"提取文字"，Vision 是
// "看图说话"（版面/物体/图表趋势/设计风格等语义），两者互补不替代。
// ---------------------------------------------------------------------------
const VISION_TIMEOUT_MS = 60_000
const VISION_MAX_TOKENS = 2048
const VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const VISION_IMAGE_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

// mock：YFW_MOCK_API=1 时返回固定文本（测试零依赖，验证边界/参数链路）
function visionMock(filePath, instruction) {
  return { content: `【Vision · mock】${filePath}\n描述：${instruction}`, isError: false }
}

async function visionDescribe(filePath, allowDirs, input = {}, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!skipBoundary && !withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (statSync(filePath).isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const ext = extname(filePath).toLowerCase()
    const mediaType = VISION_IMAGE_EXTS[ext]
    if (!mediaType) {
      return { content: `Vision 仅支持 PNG/JPEG/WebP/GIF 图片（${ext || '无扩展名'} 不支持）——PDF/扫描件用 OCR 提取文字，文本文件用 Read`, isError: true }
    }
    const instruction = String(input?.instruction || '').trim() || '详细描述这张图片的内容（版面、物体、图表、文字），并总结其表达的核心信息'
    const bytes = readFileSync(filePath)
    if (bytes.length > VISION_MAX_IMAGE_BYTES) {
      return { content: `图片过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB > 20MB），请先压缩或用 OCR 提取文字`, isError: true }
    }
    if (process.env.YFW_MOCK_API === '1') return visionMock(filePath, instruction)
    const base = (process.env.YFW_VISION_BASE_URL || '').replace(/\/+$/, '')
    const model = process.env.YFW_VISION_MODEL || ''
    const token = process.env.YFW_VISION_AUTH_TOKEN || ''
    if (!base || !model || !token) {
      return { content: 'Vision 未配置：需设置 YFW_VISION_BASE_URL / YFW_VISION_MODEL / YFW_VISION_AUTH_TOKEN（GUI 设置中选中视觉模型后由 bridge 注入）。需要提取图中文字时可先用 OCR', isError: true }
    }
    let res
    try {
      res = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          'authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'accept': 'application/json',
          'user-agent': 'YFW-turbo/0.1',
        },
        body: JSON.stringify({
          model,
          max_tokens: VISION_MAX_TOKENS,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
              { type: 'text', text: instruction },
            ],
          }],
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      })
    } catch (e) {
      return { content: `Vision 请求失败：${e.message}（网络/端点不可达）`, isError: true }
    }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        detail = j?.error?.message || j?.error?.type || ''
      } catch {}
      return { content: `Vision 端点返回 HTTP ${res.status}${detail ? `：${detail}` : ''}——检查 YFW_VISION_* 配置；如需图中文字可改用 OCR`, isError: true }
    }
    let payload
    try { payload = await res.json() } catch { return { content: 'Vision 响应解析失败（非 JSON）', isError: true } }
    const text = (payload?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return { content: 'Vision 模型未返回文本描述', isError: false }
    return { content: `[Vision] ${filePath}\n${text}`, isError: false }
  } catch (e) {
    return { content: `Vision 失败：${e.message}`, isError: true }
  }
}

export function createToolRegistry({ cwd, addDirs, skipPermissions, allowOutsideDirs = false, disallowedTools = [] }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  // 会话目录边界开关：--allow-outside-dirs / YFW_ALLOW_OUTSIDE_DIRS=1 解锁文件工具
  // （Read/Write/Edit/OCR）的目录限制；Glob/Grep 仍限定会话目录内（避免全盘扫描）。
  const skipBoundary = !!allowOutsideDirs || process.env.YFW_ALLOW_OUTSIDE_DIRS === '1'
  // 禁用工具集（--disallowedTools）：toolNames/toolSchemas/run/isConcurrencySafe
  // 全部基于过滤后视图；被禁工具的执行请求直接拒绝（防模型绕过工具列表）
  const blocked = new Set(disallowedTools || [])
  // Read 去重缓存（会话级）：resolved → { mtimeMs, size, fullRead }，Write/Edit 失效
  const readCache = new Map()
  // todo 清单（TodoWrite 覆盖式维护；同一进程共享）
  let todoItems = []
  const registry = {
    Bash: {
      description: '执行 shell 命令。仅用于系统命令/测试/构建/git 等必须场景；读文件用 Read、搜索内容用 Grep、找文件路径用 Glob（禁止用 cat/sed/grep/find 代替专用工具）。多步验证用 && 串联为一次调用。限制：120s 超时；无 stdin（勿用 ssh/vi/read 等交互式命令）；输出超 200KB 截断保留尾部（带 [truncated] 标记）；失败返回退出码与 stderr。',
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
      description: `读取文本文件内容。一次读全文（上限 ${READ_MAX_LINES} 行 / ${READ_MAX_BYTES / 1024 / 1024}MB），默认应读全文而非分段取样；超大文件用 offset/limit 定向读取，结果会提示续读位置。重复读取未变化的文件会返回"文件自上次读取后未变化"提示——直接引用此前结果即可，勿重复发起。优先用本工具而非 Bash cat/sed 读文件；路径用绝对路径，或相对当前工作目录的相对路径。边界限制：仅可读取当前会话目录及其挂载目录（--add-dir）内的文件，会话外路径会被拒绝——调用前先确认目标文件位于会话目录内，否则改用 Bash 或让用户放入会话目录。`,
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
      run: (input) => readFile(String(input?.file_path ?? ''), allowDirs, input, cwd, readCache, skipBoundary),
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
      description: '在会话目录内递归搜索文件路径（pattern 支持 * ? 和 ** 通配）。先 Glob 定位候选文件再 Read，避免无目标 ls。依赖/构建产物目录（node_modules/dist/build/release/vendors/workspace 等）默认剪枝不搜索——若目标在其中，pattern 需显式含目录名（如 **/node_modules/**）；无匹配时按返回提示换更精确的 pattern，勿反复全树试探（代价高）。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '文件路径通配模式，如 **/*.mjs' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input) => globSearch(String(input?.pattern ?? ''), allowDirs, { maxResults: Number(input?.maxResults) || 200 }),
    },
    Grep: {
      description: '在会话目录内按正则搜索文件内容，返回 file:line 匹配行。带精确 pattern 与 glob 过滤；需要上下文时用 context 参数；结果最多 200 条（超出截断并标注）。依赖/构建产物目录默认剪枝（同 Glob，显式引用可放行）。无匹配时按返回提示调整，避免试探性重复搜索。',
      concurrencySafe: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          glob: { type: 'string', description: '可选：文件路径通配过滤，如 **/*.mjs' },
          context: { type: 'number', description: '可选：匹配行上下文件数（0-10，默认 0）' },
          maxResults: { type: 'number', description: '可选：最大结果数（默认 200）' },
        },
        required: ['pattern'],
      },
      run: (input) => grepSearch(String(input?.pattern ?? ''), allowDirs, {
        glob: input?.glob ? String(input.glob) : undefined,
        context: Number(input?.context) || 0,
        maxResults: Number(input?.maxResults) || 200,
      }),
    },
    // 子代理分发：执行体在 engine（ctx.spawnSubAgent）。子 lane 内禁止嵌套。
    Agent: {
      description: '将子任务委派给子 Agent 执行（按优势场景选择 subagent_type）；前台同步回填结果，或 run_in_background 后台异步执行；可基于既有后台任务会话续跑（resume_task_id）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subagent_type: { type: 'string', description: '子 Agent 类型（general-purpose / researcher 或用户注册的 agent id）' },
          prompt: { type: 'string', description: '委派给子 Agent 的完整任务说明；resume 模式下为续跑指令' },
          run_in_background: { type: 'boolean', description: '可选：true 时后台异步执行，立即返回 task_id（Task 工具查询/中止/续跑）' },
          description: { type: 'string', description: '可选：任务描述（展示用）' },
          resume_task_id: { type: 'string', description: '可选：基于既有后台子任务会话继续执行（复用其 lane 会话，prompt 作为续跑指令追加；任务须已结束且进程存活）' },
        },
        required: ['subagent_type', 'prompt'],
      },
      run: (input, ctx) => {
        if (ctx?.lane) return { content: '子 Agent 不支持嵌套分发', isError: true }
        if (typeof ctx?.spawnSubAgent !== 'function') return { content: '子 Agent 执行器不可用', isError: true }
        return ctx.spawnSubAgent(input, ctx)
      },
    },
    // 后台子 Agent 任务管理（查询/中止/续跑）
    Task: {
      description: '管理后台子 Agent 任务：list 列出全部（层级缩进）、status/output 查询单个、stop 中止、resume 续跑（基于既有会话继续）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'list | status | output | stop | resume' },
          task_id: { type: 'string', description: '可选：status/output/stop/resume 时的任务 id' },
          prompt: { type: 'string', description: '可选：resume 时的续跑指令（追加到既有会话；缺省「（任务继续）」）' },
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
        return { content: `未知 command：${cmd}（支持 list/status/output/stop/resume）`, isError: true }
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
      description: '对扫描件 PDF 或图片执行 OCR 文字识别（mode=text 提取全文；mode=table 额外识别表格，仅 PDF 有效；结果按 project 缓存，重复识别秒回）。首次调用需加载识别模型，可能耗时数十秒——属正常初始化，勿误判卡死或重复调用。边界限制：仅可识别当前会话目录及其挂载目录（--add-dir）内的文件，会话外路径会被拒绝——调用前先确认目标文件位于会话目录内（若在会话外，先请用户将文件放入会话目录或经 --add-dir 挂载，不要盲目重试）。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要识别的 PDF/图片绝对路径' },
          mode: { type: 'string', description: '可选：text（默认，全文识别）| table（含表格识别）' },
          project: { type: 'string', description: '可选：项目名（缓存隔离，默认 default）' },
        },
        required: ['file_path'],
      },
      run: (input) => ocrFile(String(input?.file_path ?? ''), allowDirs, input, skipBoundary),
    },
    // 图片语义理解：独立视觉模型端点（YFW_VISION_*；GUI 设置选中后注入）
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
        const content = loadSkillContent({ roots: allowDirs, id })
        if (content == null) {
          const ids = discoverSkillsAll({ roots: allowDirs }).map((s) => s.id)
          return { content: `技能不存在：${id}。可用技能：${ids.join(', ') || '（当前无可用技能）'}`, isError: true }
        }
        return { content: `技能「${id}」已加载，严格按以下指引执行：\n\n${content}`, isError: false }
      },
    },
    // 内置浏览器自动化：经 bridge_request(browser) 路由到主进程执行器
    // （docs/bridge-contract.md §4 bridge_request；bridge 的 browserRouter 已接线）。
    // 执行体在 engine（ctx.browserDriver 挂起等 bridge 回写 browser_response 解除）。
    Browser: {
      description: '驱动内置浏览器执行页面操作（快照驱动：先 snapshot 查看页面结构与可交互元素 ref，再按 ref 操作）。支持动作：goto 导航 / back 后退 / forward 前进 / refresh 刷新 / snapshot 页面快照 / click 点击 / type 输入 / select 选择 / scroll 滚动 / hover 悬停 / wait 等待 / js 页面内执行 JS。元素 ref 随页面变化失效——操作失败时重新 snapshot 获取最新 ref，勿沿用旧 ref 重试。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', description: '浏览器动作：goto/back/forward/refresh/snapshot/click/type/select/scroll/hover/wait/js' },
          params: {
            type: 'object',
            additionalProperties: true,
            description: '动作参数：goto 需 url；click/type/select/hover 需 ref（快照中的元素引用）；type 另需 text；scroll 需 direction；wait 需 ms；js 需 expression。快照驱动，未知元素先 snapshot 获取 ref。',
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
  return {
    registry,
    toolNames: Object.keys(registry).filter((n) => !blocked.has(n)),
    // P0-4：只读工具并发安全标记（Bash/Write/Edit/Agent/Task/OCR 等写/执行类串行）
    isConcurrencySafe(name) {
      return registry[name]?.concurrencySafe === true
    },
    // 中立工具 schema 列表（Anthropic/OpenAI 协议字段映射在 api.mjs 完成）
    toolSchemas() {
      return Object.entries(registry).filter(([name]) => !blocked.has(name)).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
    },
    // 执行入口：返回归一化 { content, isError }（成功路径可能缺省 isError）；
    // approval 决策由调用方（engine）先行
    async run(toolUse, ctx) {
      const name = toolUse?.name
      if (blocked.has(name)) return { content: `工具已被禁用：${name}`, isError: true }
      const tool = registry[name]
      if (!tool) return { content: `未知工具：${name}`, isError: true }
      const r = await tool.run(toolUse.input || {}, ctx)
      if (r && typeof r === 'object') {
        return { content: r.content ?? '', isError: r.isError === true, ...(r.meta ? { meta: r.meta } : {}) }
      }
      return { content: String(r ?? ''), isError: false }
    },
  }
}
