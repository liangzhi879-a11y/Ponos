// YFW-turbo 工具注册表与执行器（docs/bridge-contract.md §9 替换面：工具执行器）
// ---------------------------------------------------------------------------
// 工具集：Bash（shell 执行，高危命令经 permissions 审批）、Read/Write/Edit
// （文件读写与编辑，路径边界校验）、Glob/Grep（边界内搜索）。返回统一结果
// { content, isError, meta? }，由 engine 以 tool_result 回填模型。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, sep, join } from 'node:path'
import { matchesHighRisk } from './highrisk.mjs'

const BASH_TIMEOUT_MS = 120_000

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
    const child = spawn(shell, args, {
      cwd: cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000) })
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000) })
    child.on('error', (e) => finish(`命令启动失败：${e.message}`, true))
    child.on('close', (code) => {
      const out = stdout.trim()
      const err = stderr.trim()
      const body = code === 0
        ? (out || '(命令执行完成，无输出)')
        : `退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err : ''}`.trim()
      finish(body, code !== 0)
    })
  })
}

// 文件路径边界：仅允许读写 --add-dir 注入的目录（cwd / 技能根）内文件
function withinBoundary(filePath, allowDirs) {
  const resolved = resolve(filePath)
  return allowDirs.some((dir) => {
    const base = resolve(dir).toLowerCase()
    return resolved.toLowerCase() === base || resolved.toLowerCase().startsWith(base + sep)
  })
}

function readFile(filePath, allowDirs, input = {}) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    const st = statSync(filePath)
    if (st.isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const MAX = 2 * 1024 * 1024
    if (st.size > MAX) return { content: `文件过大（${st.size} 字节），超出 ${MAX} 字节读取上限`, isError: true }
    const full = readFileSync(filePath, 'utf-8')
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
    if (Number.isFinite(offset) && offset > 0) {
      const start = offset - 1
      const end = Number.isFinite(limit) && limit > 0 ? start + limit : totalLines
      const { content } = lineSlice(start, end)
      return { content, isError: false, meta: { range: [offset, Math.min(end, totalLines)], totalLines } }
    }
    if (Number.isFinite(limit) && limit > 0) {
      const { content } = lineSlice(0, limit)
      return { content, isError: false, meta: { range: [1, Math.min(limit, totalLines)], totalLines } }
    }
    return { content: full }
  } catch (e) {
    return { content: `读取失败：${e.message}`, isError: true }
  }
}

function writeFile(filePath, content, allowDirs) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    writeFileSync(filePath, String(content ?? ''), 'utf-8')
    return { content: `已写入 ${filePath}（${String(content ?? '').length} 字符）` }
  } catch (e) {
    return { content: `写入失败：${e.message}`, isError: true }
  }
}

// Edit：先读后改的字符串替换。old_string 需在文件中唯一（否则要求 replace_all）。
function editFile(filePath, oldString, newString, replaceAll, allowDirs) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (typeof oldString !== 'string' || !oldString) return { content: 'old_string 缺失或为空', isError: true }
    if (typeof newString !== 'string') return { content: 'new_string 必须为字符串', isError: true }
    const content = readFileSync(filePath, 'utf-8')
    const count = content.split(oldString).length - 1
    if (count === 0) return { content: `未找到匹配文本：${JSON.stringify(oldString.slice(0, 80))}`, isError: true }
    if (count > 1 && !replaceAll) {
      return { content: `old_string 出现 ${count} 次，不唯一；请使用 replace_all 或补充更多上下文`, isError: true }
    }
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    writeFileSync(filePath, next, 'utf-8')
    return { content: `已编辑 ${filePath}（${replaceAll ? count : 1} 处替换）` }
  } catch (e) {
    return { content: `编辑失败：${e.message}`, isError: true }
  }
}

// Glob：在会话目录边界内递归匹配文件名/路径（pattern 支持 * ? 和 **）。
// 匹配前把路径归一化为正斜杠，Windows 反斜杠路径与 pattern 里的 / 均能命中。
function globSearch(pattern, allowDirs, { maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    const re = globToRegExp(String(pattern).replace(/\\/g, '/'))
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
        if (ent.isDirectory()) walk(full)
        else {
          const normalized = full.replace(/\\/g, '/')
          if (re.test(normalized) && !seen.has(full)) { seen.add(full); results.push(full) }
        }
      }
    }
    for (const base of allowDirs) walk(base)
    if (results.length === 0) return { content: `无匹配文件（pattern: ${pattern}）` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n') + truncated }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

// 简易 glob → RegExp：** 跨目录 / * 单段内任意 / ? 单字符
function globToRegExp(pattern) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(re + '$', 'i')
}

// Grep：在边界内按正则搜索文件内容，返回 file:line 匹配行（含上下文）
function grepSearch(pattern, allowDirs, { glob, context = 0, maxResults = 200 } = {}) {
  try {
    if (!pattern) return { content: 'pattern 缺失', isError: true }
    let re
    try { re = new RegExp(String(pattern)) } catch (e) { return { content: `正则无效：${e.message}`, isError: true } }
    const ctx = Math.max(0, Math.min(Number(context) || 0, 10))
    const globRe = glob ? globToRegExp(String(glob).replace(/\\/g, '/')) : null
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
        if (ent.isDirectory()) walk(full)
        else if (!globRe || globRe.test(full.replace(/\\/g, '/'))) {
          let st
          try { st = statSync(full) } catch { continue }
          if (!st.isFile() || st.size > MAX_BYTES) continue
          const lines = readFileSync(full, 'utf-8').split('\n')
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
    if (results.length === 0) return { content: `无匹配行（pattern: ${pattern}${glob ? `, glob: ${glob}` : ''}）` }
    const truncated = results.length >= maxResults ? `\n（已达 ${maxResults} 条上限，结果截断）` : ''
    return { content: results.join('\n\n') + truncated }
  } catch (e) {
    return { content: `搜索失败：${e.message}`, isError: true }
  }
}

export function createToolRegistry({ cwd, addDirs, skipPermissions }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  const registry = {
    Bash: {
      description: '执行 shell 命令',
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
      description: '读取文本文件内容（支持 offset/limit 行范围读取，offset 从 1 开始）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要读取的文件绝对路径' },
          offset: { type: 'number', description: '可选：起始行号（1 开始）' },
          limit: { type: 'number', description: '可选：读取行数' },
        },
        required: ['file_path'],
      },
      run: (input) => readFile(String(input?.file_path ?? ''), allowDirs, input),
    },
    Write: {
      description: '写入文本文件',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要写入的文件绝对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['file_path', 'content'],
      },
      run: (input) => writeFile(String(input?.file_path ?? ''), String(input?.content ?? ''), allowDirs),
    },
    Edit: {
      description: '先读后改的字符串替换编辑（old_string 需唯一，或指定 replace_all）',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string', description: '要编辑的文件绝对路径' },
          old_string: { type: 'string', description: '要替换的原文（需精确匹配）' },
          new_string: { type: 'string', description: '替换后的内容' },
          replace_all: { type: 'boolean', description: '可选：true 时替换全部匹配（默认 false 仅替换唯一匹配）' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      run: (input) => editFile(String(input?.file_path ?? ''), String(input?.old_string ?? ''), String(input?.new_string ?? ''), input?.replace_all === true, allowDirs),
    },
    Glob: {
      description: '在会话目录内递归搜索文件路径（pattern 支持 * ? 和 ** 通配）',
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
      description: '在会话目录内按正则搜索文件内容，返回 file:line 匹配行',
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
  }
  return {
    registry,
    toolNames: Object.keys(registry),
    // 中立工具 schema 列表（Anthropic/OpenAI 协议字段映射在 api.mjs 完成）
    toolSchemas() {
      return Object.entries(registry).map(([name, tool]) => ({
        name,
        description: tool.description,
        input_schema: tool.input_schema,
      }))
    },
    // 执行入口：返回归一化 { content, isError }（成功路径可能缺省 isError）；
    // approval 决策由调用方（engine）先行
    async run(toolUse, ctx) {
      const tool = registry[toolUse?.name]
      if (!tool) return { content: `未知工具：${toolUse?.name}`, isError: true }
      const r = await tool.run(toolUse.input || {}, ctx)
      if (r && typeof r === 'object') {
        return { content: r.content ?? '', isError: r.isError === true, ...(r.meta ? { meta: r.meta } : {}) }
      }
      return { content: String(r ?? ''), isError: false }
    },
  }
}
