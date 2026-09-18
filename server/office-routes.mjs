// Office 路由：预览转换 + Excel/Word 结构读写（P1 · 从 server/bridge.mjs 抽出）
// ---------------------------------------------------------------------------
// 约定同 `server/logs-routes.mjs` / `server/files-routes.mjs`：
//   返回 `{ status, body }` 表示已算出响应；返回 `null` 表示不是本模块负责的路径。
//
// 抽出时顺带做了两件事（都在 HTTP 热路径上，原实现会阻塞 bridge 的单事件循环）：
//   · `validOfficeFile` 由 `statSync` 改 `await stat`；
//   · 临时 JSON 由 `writeFileSync`/`unlinkSync` 改 `await writeFile`/`await unlink`。
//   注：bridge 里其余同步 I/O 多在**启动/配置/技能安装**等一次性路径（微秒级），
//   继续阻塞的收益与风险不成比例，故本次刻意不动。
//
// 行为不变由下列既有测试守住：server/sheet-ops.test.mjs、server/docx-ops.test.mjs、
// server/bridge-fs-guard.test.mjs（office 越界/大小写用例如有覆盖）。
import { spawn } from 'node:child_process'
import { stat, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { guardErrorResponse } from '../shared/fs-guard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 闸门/体积错误 → 响应；非闸门错误原样抛出 */
function guardFail(e) {
  const r = guardErrorResponse(e)
  if (!r) throw e
  return { status: r.status, body: r.body }
}

const officeErr = (status, body) => ({ status, body })

/** 可转换的格式 → python 脚本（白名单，非白名单格式一律 400） */
const CONVERT_SCRIPT_MAP = { docx: 'convert_docx.py', xlsx: 'convert_xls.py', xls: 'convert_xls.py' }

/**
 * Excel 写回错误码 → HTTP 状态。
 * 映射口径与 /write-docx 一致：409=版本冲突（用户应重新载入）、400=请求不可用
 * （含旧写法/公式格只读/引用不存在的行）、423=文件被占用、404=文件不存在，其余 500。
 */
const SHEET_WRITE_STATUS = {
  'base-version-mismatch': 409,
  'file-locked': 423,
  'file-missing': 404,
  'xls-write-unsupported': 400,
  'path-required': 400,
  'ops-required': 400,
  'base-version-required': 400,
  'legacy-updates-not-supported': 400,
  'sheet-not-found': 400,
  'row-not-found': 400,
  'col-not-found': 400,
  'row-deleted': 400,
  'col-deleted': 400,
  'formula-cell-readonly': 400,
  'value-required': 400,
  'unknown-op': 400,
  'bad-op': 400,
  'bad-request': 400,
}

/**
 * Word 写回错误码 → HTTP 状态。把 409 与 400 分开是有意的：
 * 两者的用户动作完全不同（**重新载入** vs 改请求）。
 */
const DOCX_WRITE_STATUS = {
  'base-version-mismatch': 409,
  'file-locked': 423,
  'file-missing': 404,
  'path-required': 400,
  'ops-required': 400,
  'base-version-required': 400,
  'legacy-blocks-not-supported': 400,
  'block-not-found': 400,
  'block-deleted': 400,
  'bad-move': 400,
  'unknown-op': 400,
  'bad-op': 400,
  'text-required': 400,
  'rows-required': 400,
  'bad-request': 400,
}

/** 本模块负责的路径（集中登记，便于调用方判断） */
export const OFFICE_ROUTE_PATHS = new Set([
  '/convert-office', '/read-sheet', '/write-sheet', '/read-docx', '/write-docx',
])

/**
 * 运行 office 处理 python 脚本（转换/结构读取/写回共用）：stdout 必须是单行 JSON。
 * @param {string} scriptName 位于 server/ 下的脚本名
 * @param {string[]} args
 * @param {{pythonExe: string}} deps
 */
export function runOfficeScript(scriptName, args, deps) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(__dirname, scriptName)
    const proc = spawn(deps.pythonExe, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(out.trim())) } catch { reject(new Error('Invalid script output')) }
      } else {
        reject(new Error((err || '').trim() || 'exit ' + code))
      }
    })
    proc.on('error', reject)
  })
}

/**
 * 校验本地 office 文件：非目录、≤10MB（与 /convert-office 同款约束）。
 * 改异步（原 `statSync`）以避免阻塞事件循环。
 * ⚠️ **故意不做 try/catch**：原实现里它抛出后由调用方的通用错误出口处理，
 * 此处保持一致，不在重构中顺手改状态码（那属行为变更，应单独评估）。
 */
async function validOfficeFile(fp) {
  const st = await stat(fp)
  if (st.isDirectory() || st.size > 10485760) throw new Error('Invalid or too large')
}

/**
 * 处理 office 类路径。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {URLSearchParams} p.searchParams
 * @param {object|null} p.body
 * @param {string} p.sep
 * @param {{read:string[],write:string[],writeDeny:string[],credentials:string[]}} p.roots
 * @param {{resolveReadable:Function,resolveWritable:Function,assertSizeOk:Function,findPythonExe:Function}} p.guard
 */
export async function handleOfficeRoute({ method, pathname, searchParams, body, sep, roots, guard }) {
  const { resolveReadable, resolveWritable, assertSizeOk, findPythonExe } = guard
  const readOpts = { roots: roots.read, denyPaths: roots.credentials }
  const writeOpts = { roots: roots.write, denyRoots: roots.writeDeny, denyPaths: roots.credentials }
  const deps = { pythonExe: findPythonExe ? findPythonExe() : (process.env.YFWORKING_PYTHON || 'python') }

  // ── GET /convert-office ────────────────────────────────────────────────
  if (pathname === '/convert-office') {
    let fp
    try {
      fp = await resolveReadable((searchParams.get('path') || '').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    const st = await stat(fp)
    if (st.isDirectory()) return officeErr(400, { error: 'Invalid path', code: 'EISDIR' })
    try { assertSizeOk(st.size, 10485760, 400) } catch (e) { return guardFail(e) }
    const ext = fp.split('.').pop().toLowerCase()
    const scriptName = CONVERT_SCRIPT_MAP[ext]
    if (!scriptName) return officeErr(400, { error: 'Unsupported format' })
    try {
      const result = await runOfficeScript(scriptName, [fp], deps)
      if (result.ok) return { status: 200, body: { html: result.html } }
      return officeErr(500, { error: result.error || 'Conversion failed' })
    } catch (e) {
      return officeErr(500, { error: e.message || 'Conversion error' })
    }
  }

  // ── GET /read-sheet ────────────────────────────────────────────────────
  // Excel 结构读取（值 + 公式标记 + 行/列内容指纹），供应用内网格编辑。
  // 【S1-C5】额外透传 `baseVersion`（防丢失更新）与 `sheetNames`（多表工作簿"有哪些表"必须可见，
  // 否则 ops 能写到 read 看不见的表上，形成信息不对称）；每个 sheet 带 `rowIds`/`colIds`，
  // 它们是前端提交时的**寻址标识**（行/列身份按内容算，不按行号 —— 插删行列后行号会漂移）。
  if (pathname === '/read-sheet') {
    let fp
    try {
      fp = await resolveReadable((searchParams.get('path') || '').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    await validOfficeFile(fp)   // 与原实现一致：抛出交由调用方的通用错误出口处理
    try {
      const result = await runOfficeScript('sheet_edit.py', ['read', fp], deps)
      if (!result.ok) throw new Error(result.error || 'read failed')
      return {
        status: 200,
        body: { ok: true, baseVersion: result.baseVersion, sheetNames: result.sheetNames, sheets: result.sheets },
      }
    } catch (e) {
      return officeErr(500, { error: e.message || 'Read error' })
    }
  }

  // ── POST /write-sheet ──────────────────────────────────────────────────
  if (pathname === '/write-sheet' && method === 'POST') {
    if (!body || !body.path) return officeErr(400, { error: 'path required', code: 'EBADARG' })
    let fp
    try {
      fp = await resolveWritable((body.path || '').replace(/\//g, sep), writeOpts)
    } catch (e) { return guardFail(e) }
    await validOfficeFile(fp)   // 与原实现一致：抛出交由调用方的通用错误出口处理
    const tmp = join(tmpdir(), 'yfw-sheet-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
    await writeFile(tmp, JSON.stringify({ ...body, path: fp }))
    try {
      const result = await runOfficeScript('sheet_edit.py', ['write', tmp], deps)
      if (!result.ok) {
        const code = result.code || 'write-failed'
        const status = SHEET_WRITE_STATUS[code] || 500
        return officeErr(status, {
          ok: false, code, error: result.error || 'write failed',
          expected: result.expected, actual: result.actual, cell: result.cell, sheetNames: result.sheetNames,
        })
      }
      return { status: 200, body: { ok: true, baseVersion: result.baseVersion } }
    } catch (e) {
      return officeErr(500, { error: e.message || 'Write error' })
    } finally {
      try { await unlink(tmp) } catch { /* ignore */ }
    }
  }

  // ── GET /read-docx ─────────────────────────────────────────────────────
  // Word 块结构读取（标题/段落/表格），供应用内文档编辑。
  // 【S1-C2】额外透传 `baseVersion`（整文件 sha256）：写回时必须带回它，否则拒绝 —— 这是
  // "防丢失更新"的唯一依据（A 读到 B 改之前的内容时，A 的提交必须失败而不是覆盖 B）。
  if (pathname === '/read-docx') {
    let fp
    try {
      fp = await resolveReadable((searchParams.get('path') || '').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    await validOfficeFile(fp)   // 与原实现一致：抛出交由调用方的通用错误出口处理
    try {
      const result = await runOfficeScript('docx_edit.py', ['read', fp], deps)
      if (!result.ok) throw new Error(result.error || 'read failed')
      return { status: 200, body: { ok: true, baseVersion: result.baseVersion, blocks: result.blocks } }
    } catch (e) {
      return officeErr(500, { error: e.message || 'Read error' })
    }
  }

  // ── POST /write-docx ───────────────────────────────────────────────────
  // 【S1-C1】只接受 `{ path, baseVersion, ops[] }`（旧的 `{ path, blocks }` 会被 python 侧**显式拒绝**，
  // 这里如实转达）。错误码 → HTTP 状态映射见 DOCX_WRITE_STATUS。
  if (pathname === '/write-docx' && method === 'POST') {
    if (!body || !body.path) return officeErr(400, { error: 'path required', code: 'EBADARG' })
    let fp
    try {
      fp = await resolveWritable((body.path || '').replace(/\//g, sep), writeOpts)
    } catch (e) { return guardFail(e) }
    await validOfficeFile(fp)   // 与原实现一致：抛出交由调用方的通用错误出口处理
    const tmp = join(tmpdir(), 'yfw-docx-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
    await writeFile(tmp, JSON.stringify({ ...body, path: fp }))
    try {
      const result = await runOfficeScript('docx_edit.py', ['write', tmp], deps)
      if (!result.ok) {
        const code = result.code || 'write-failed'
        const status = DOCX_WRITE_STATUS[code] || 500
        return officeErr(status, {
          ok: false, code, error: result.error || 'write failed',
          expected: result.expected, actual: result.actual,
        })
      }
      // 返回新的 baseVersion：前端可据此继续编辑（不必立刻重读整篇）
      return { status: 200, body: { ok: true, baseVersion: result.baseVersion } }
    } catch (e) {
      return officeErr(500, { error: e.message || 'Write error' })
    } finally {
      try { await unlink(tmp) } catch { /* ignore */ }
    }
  }

  return null
}

/**
 * 以**同一套闸门**在服务端内部调用 office 端点（不经 HTTP），供 collab 的三路合并落盘复用。
 *
 * 为什么复用 `handleOfficeRoute` 而不是直接跑 python 脚本：路径策略（`roots` / deny 根）、
 * 文件大小上限、`baseVersion` 防丢失更新——这三道校验都在这一层，绕过去等于把它们绕过去。
 * 内部复用只需要"传参数"而不需要"造 HTTP 请求"，所以这里只做参数适配。
 *
 * @returns 与 HTTP 层同语义：命中返回 `{ status, body }`，未命中返回 `null`。
 */
export function createOfficeAccess ({ sep, roots, guard }) {
  const call = (method, pathname, params, body) =>
    handleOfficeRoute({
      method,
      pathname,
      searchParams: new URLSearchParams(params || {}),
      body: body || null,
      sep,
      roots,
      guard,
    })
  return {
    readDocx: (path) => call('GET', '/read-docx', { path }),
    readSheet: (path) => call('GET', '/read-sheet', { path }),
    writeDocx: (path, baseVersion, ops) => call('POST', '/write-docx', {}, { path, baseVersion, ops }),
    writeSheet: (path, sheet, baseVersion, ops) => call('POST', '/write-sheet', {}, { path, sheet, baseVersion, ops }),
  }
}
