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
 * 把模型给的路径限定到允许的根目录内。
 * 先归一化再比较——`C:/Apps/../Windows` 会被折叠成 `C:/Windows`，因此路径穿越挡得住。
 * @throws {Error} 越界时抛（调用方捕获后转成 `{ok:false,error}` 回给模型）
 */
function resolveExplorePath(roots, p) {
  const target = norm(p)
  for (const root of roots || []) {
    const r = norm(root)
    if (target === r || target.startsWith(r + '/')) return target
  }
  throw new Error(`路径超出允许范围（只允许目标程序目录与其用户数据目录）：${p}`)
}

/** 只列条目（不读内容） */
async function listDir({ path, limit = 200 } = {}, deps = {}) {
  const readdir = deps.readdir || ((p) => require('node:fs').promises.readdir(p, { withFileTypes: true }))
  try {
    const p = resolveExplorePath(deps.roots, path)
    const entries = await readdir(p)
    return {
      ok: true,
      entries: entries.slice(0, limit).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: typeof e.size === 'number' ? e.size : 0,
      })),
    }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 读文本（截断 + 二进制拒绝） */
async function readTextFile({ path, maxBytes = DEFAULT_MAX_BYTES } = {}, deps = {}) {
  const readFile = deps.readFile || ((p) => require('node:fs').promises.readFile(p))
  try {
    const p = resolveExplorePath(deps.roots, path)
    const buf = await readFile(p)
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
    const slice = b.subarray(0, Math.min(b.length, maxBytes))
    if (slice.includes(0)) return { ok: false, error: '该文件疑似二进制，拒绝读取（如需数据，请找同目录的文本/配置文件）' }
    return { ok: true, text: slice.toString('utf8'), truncated: b.length > maxBytes, bytes: b.length }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

module.exports = { resolveExplorePath, listDir, readTextFile, DEFAULT_MAX_BYTES }
