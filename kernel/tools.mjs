// YFW-turbo 工具注册表与执行器（docs/bridge-contract.md §9 替换面：工具执行器）
// ---------------------------------------------------------------------------
// 骨架工具集：Bash（shell 执行，高危命令经 permissions 审批）、Read/Write
// （文件读写，路径边界校验）。返回统一结果 { content, isError }，由 engine
// 以 tool_result 回填模型。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { matchesHighRisk } from './highrisk.mjs'

const BASH_TIMEOUT_MS = 120_000

function runShell(command, cwd) {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
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

function readFile(filePath, allowDirs) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    const st = statSync(filePath)
    if (st.isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const MAX = 2 * 1024 * 1024
    if (st.size > MAX) return { content: `文件过大（${st.size} 字节），超出 ${MAX} 字节读取上限`, isError: true }
    return { content: readFileSync(filePath, 'utf-8') }
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

export function createToolRegistry({ cwd, addDirs, skipPermissions }) {
  const allowDirs = [cwd, ...(addDirs || [])].filter(Boolean)
  const registry = {
    Bash: {
      description: '执行 shell 命令',
      run: (input) => runShell(String(input?.command ?? ''), cwd),
      isHighRisk: (input) => matchesHighRisk(String(input?.command ?? '')),
    },
    Read: {
      description: '读取文本文件内容',
      run: (input) => readFile(String(input?.file_path ?? ''), allowDirs),
    },
    Write: {
      description: '写入文本文件',
      run: (input) => writeFile(String(input?.file_path ?? ''), String(input?.content ?? ''), allowDirs),
    },
  }
  return {
    registry,
    toolNames: Object.keys(registry),
    // 执行入口：返回 { content, isError }；approval 决策由调用方（engine）先行
    async run(toolUse, ctx) {
      const tool = registry[toolUse?.name]
      if (!tool) return { content: `未知工具：${toolUse?.name}`, isError: true }
      return tool.run(toolUse.input || {}, ctx)
    },
  }
}
