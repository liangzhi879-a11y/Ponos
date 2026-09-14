// 应用智控：桌面侧**只读探索工具**（list_dir / read_file）的唯一实现。
//
// ★ 为什么需要：桌面路径下模型原本只有 run_command + submit_spec，无法"看"任何东西——
//   读不了帮助、列不了目录、看不了数据格式，只能凭训练记忆猜，于是经常猜空。
//   用户要求"尽可能获取接口/chunk 等任何可控路径"，前提是模型手上有可读的手段。
//
// ★ 安全边界（硬约束，勿放宽）：
//   ① 仅允许"目标程序目录 + 该应用用户数据目录"范围内（resolveExplorePath 校验，含路径穿越）；
//   ② 全只读；③ 单文件读取有字节上限；④ 二进制拒绝（避免往上下文灌乱码）。
'use strict'
const { resolve } = require('node:path')

const DEFAULT_MAX_BYTES = 64 * 1024

/** 归一化成"正斜杠、绝对路径"便于比较前缀（Windows 下 fs 也认正斜杠） */
function norm(p) {
  return resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 比较用折叠：Windows 路径**大小写不敏感**（`C:/PROGRAM FILES/Aseprite` 与
 * `c:/Program Files/Aseprite` 是同一处，且用户数据目录的真实大小写常与派生名不一致——
 * 如 `%APPDATA%\Aseprite` 对派生名 `aseprite`）；macOS/Linux 保持大小写敏感语义，
 * 那里的 `Foo` 与 `foo` 是两个不同目录，无条件小写会把守卫放宽到能读到范围外的目录。
 * ★ 只用于**比较**：返回给 fs 的仍是原样路径（大小写敏感的文件系统上小写化会直接读不到文件）。
 */
function foldForCompare(p, caseInsensitive) {
  return caseInsensitive ? p.toLowerCase() : p
}

/**
 * 把模型给的路径限定到允许的根目录内。
 * 先归一化再比较——`C:/Apps/../Windows` 会被折叠成 `C:/Windows`，因此路径穿越挡得住。
 * @param {string[]} roots
 * @param {string} p
 * @param {{caseInsensitive?: boolean}} [opts] 缺省按运行平台（win32 → 不敏感）
 * @throws {Error} 越界时抛（调用方捕获后转成 `{ok:false,error}` 回给模型）
 */
function resolveExplorePath(roots, p, opts = {}) {
  const caseInsensitive = opts.caseInsensitive ?? (process.platform === 'win32')
  const target = norm(p)
  const cmpTarget = foldForCompare(target, caseInsensitive)
  for (const root of roots || []) {
    const r = foldForCompare(norm(root), caseInsensitive)
    if (cmpTarget === r || cmpTarget.startsWith(r + '/')) return target
  }
  throw new Error(`路径超出允许范围（只允许目标程序目录与其用户数据目录）：${p}`)
}

/**
 * 目录列表的**给模型看的文本**。
 * ★ 为什么必须有：上层（app-agent 的 toolResultText）只把 `summary` 回喂给模型，
 *   工具只返回结构化字段 ⇒ 模型收到的是"（无摘要）"，等于没给眼睛（M2 空转的根因）。
 *   呈现放在工具实现内（与 app-websearch.cjs 同做法）：谁最懂结果，谁负责说清结果。
 */
function listDirSummary(entries, total) {
  if (!entries.length) return '(空目录)'
  const lines = entries.map((e) => `[${e.type === 'dir' ? '目录' : '文件'}] ${e.name} (${e.size || 0}B)`)
  if (typeof total === 'number' && total > entries.length) lines.push(`…（共 ${total} 项，已列前 ${entries.length} 项）`)
  return lines.join('\n')
}

/** 只列条目（不读内容） */
async function listDir({ path, limit = 200 } = {}, deps = {}) {
  const readdir = deps.readdir || ((p) => require('node:fs').promises.readdir(p, { withFileTypes: true }))
  try {
    const p = resolveExplorePath(deps.roots, path)
    const entries = await readdir(p)
    const shown = entries.slice(0, limit).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: typeof e.size === 'number' ? e.size : 0,
    }))
    return { ok: true, entries: shown, summary: listDirSummary(shown, entries.length) }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, error: msg, summary: `列目录失败：${msg}` }
  }
}

/** 读文本（截断 + 二进制拒绝） */
async function readTextFile({ path, maxBytes = DEFAULT_MAX_BYTES } = {}, deps = {}) {
  const readFile = deps.readFile || ((p) => require('node:fs').promises.readFile(p))
  try {
    const p = resolveExplorePath(deps.roots, path)
    const buf = await readFile(p)
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
    const slice = b.subarray(0, Math.min(b.length, maxBytes))
    if (slice.includes(0)) {
      const msg = '该文件疑似二进制，拒绝读取（如需数据，请找同目录的文本/配置文件）'
      return { ok: false, error: msg, summary: `读取失败：${msg}` }
    }
    const truncated = b.length > maxBytes
    return {
      ok: true,
      text: slice.toString('utf8'),
      truncated,
      bytes: b.length,
      summary: slice.toString('utf8') + (truncated ? `\n…（已截断，共 ${b.length} 字节）` : ''),
    }
  } catch (e) {
    const msg = String(e?.message || e)
    return { ok: false, error: msg, summary: `读取失败：${msg}` }
  }
}

module.exports = { resolveExplorePath, listDir, readTextFile, DEFAULT_MAX_BYTES }