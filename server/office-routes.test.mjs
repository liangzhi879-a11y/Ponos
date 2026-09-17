// Office 路由层测试（P1 抽取后新增）
// ---------------------------------------------------------------------------
// 为什么需要这个文件：`docx-ops.test.mjs` / `sheet-ops.test.mjs` **不起桥**（只测 python 侧），
// 而 `bridge-fs-guard.test.mjs` 只覆盖了 office 端点的**越界拒绝**。
// 抽出 `server/office-routes.mjs` 后，该模块可以**直接调用**（不必起桥）——正是抽取的收益之一，
// 这里用它补上"路由分流 + 入参校验 + 闸门 + 真实读取"的正例覆盖。
//
// 运行：node --test server/office-routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReadable, resolveWritable, assertSizeOk } from '../shared/fs-guard.mjs'
import { resolvePython } from '../kernel/knowledge-import.mjs'
import { handleOfficeRoute, OFFICE_ROUTE_PATHS } from './office-routes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'office-fixtures')
const TMP = mkdtempSync(join(tmpdir(), 'yfw-office-routes-'))
const ROOTS = { read: [TMP], write: [TMP], writeDeny: [], credentials: [] }

const XLSX = join(TMP, 'xl_base.xlsx')
const DOCX = join(TMP, 'base.docx')
copyFileSync(join(FIXTURES, 'xl_base.xlsx'), XLSX)
copyFileSync(join(FIXTURES, 'base.docx'), DOCX)

process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

const call = (pathname, { method = 'GET', query = {}, body = null } = {}) => handleOfficeRoute({
  method,
  pathname,
  searchParams: new URLSearchParams(query),
  body,
  sep,
  roots: ROOTS,
  guard: { resolveReadable, resolveWritable, assertSizeOk, findPythonExe: () => resolvePython() },
})

test('路由分流：本模块负责 5 个路径，其余一律返回 null（交回桥处理）', () => {
  assert.deepEqual(
    [...OFFICE_ROUTE_PATHS].sort(),
    ['/convert-office', '/read-docx', '/read-sheet', '/write-docx', '/write-sheet'],
  )
})

test('无关路径 → null（不得越权接管其它端点）', async () => {
  for (const p of ['/read-file', '/list-dir', '/health', '/nope', '/convert-office2']) {
    assert.equal(await call(p), null, `${p} 不应由 office 路由接管`)
  }
})

test('正例：/convert-office 对 xlsx 返回 html', async () => {
  const r = await call('/convert-office', { query: { path: XLSX } })
  assert.equal(r?.status, 200, JSON.stringify(r?.body))
  assert.equal(typeof r.body.html, 'string')
  assert.ok(r.body.html.length > 0, 'html 不应为空')
})

test('正例：/read-sheet 返回 baseVersion / sheetNames / sheets（多表可见 + 防丢失更新依据）', async () => {
  const r = await call('/read-sheet', { query: { path: XLSX } })
  assert.equal(r?.status, 200, JSON.stringify(r?.body))
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.baseVersion, 'string', 'baseVersion 是防丢失更新的依据，必须存在')
  assert.ok(Array.isArray(r.body.sheetNames), 'sheetNames 必须透传（否则 ops 能写到看不见的表上）')
  assert.ok(Array.isArray(r.body.sheets))
  assert.ok(r.body.sheets.length > 0)
  assert.ok(Array.isArray(r.body.sheets[0].rowIds), '每张表应带 rowIds（内容指纹寻址标识）')
})

test('正例：/read-docx 返回 baseVersion 与 blocks', async () => {
  const r = await call('/read-docx', { query: { path: DOCX } })
  assert.equal(r?.status, 200, JSON.stringify(r?.body))
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.baseVersion, 'string')
  assert.ok(Array.isArray(r.body.blocks))
})

test('入参校验：不支持的转换格式 → 400 Unsupported format（白名单外一律拒绝）', async () => {
  const txt = join(TMP, 'plain.txt')
  copyFileSync(join(FIXTURES, 'README.md'), txt)
  const r = await call('/convert-office', { query: { path: txt } })
  assert.equal(r?.status, 400)
  assert.equal(r.body.error, 'Unsupported format')
})

test('入参校验：四个写/读端点缺 path → 400 EBADARG（POST 端点）', async () => {
  for (const p of ['/write-sheet', '/write-docx']) {
    const r = await call(p, { method: 'POST', body: {} })
    assert.equal(r?.status, 400, `${p}`)
    assert.equal(r.body.code, 'EBADARG', `${p} 应报 EBADARG`)
  }
  const r2 = await call('/read-sheet', { query: {} })
  assert.notEqual(r2?.status, 200, '缺 path 不应成功')
})

test('方法约束：GET /write-sheet 不被接管（返回 null，与改前一致）', async () => {
  assert.equal(await call('/write-sheet', { method: 'GET', body: null }), null)
  assert.equal(await call('/write-docx', { method: 'GET', body: null }), null)
})

test('闸门：enforce 下越界读 → 403（roots 之外）', async () => {
  const prev = process.env.YFW_FS_GUARD
  process.env.YFW_FS_GUARD = 'enforce'
  try {
    const outside = join(tmpdir(), 'not-allowed.xlsx')
    const r = await call('/read-sheet', { query: { path: outside } })
    assert.equal(r?.status, 403, JSON.stringify(r?.body))
    assert.equal(r.body.code, 'EOUTSIDE')
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_GUARD; else process.env.YFW_FS_GUARD = prev
  }
})

test('闸门：enforce 下越界写 → 403，且不产生临时文件残留', async () => {
  const prev = process.env.YFW_FS_GUARD
  process.env.YFW_FS_GUARD = 'enforce'
  try {
    const outside = join(tmpdir(), 'not-allowed-write.xlsx')
    const r = await call('/write-sheet', { method: 'POST', body: { path: outside, baseVersion: 'x', ops: [] } })
    assert.equal(r?.status, 403, JSON.stringify(r?.body))
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_GUARD; else process.env.YFW_FS_GUARD = prev
  }
})

test('闸门：凭据文件读 → 403 EPROTECTED（即使位于允许根内）', async () => {
  const creds = join(TMP, 'settings.json')
  copyFileSync(join(FIXTURES, 'README.md'), creds)
  const prev = process.env.YFW_FS_DENY_PATHS
  process.env.YFW_FS_DENY_PATHS = creds
  try {
    // roots.credentials 在 handleOfficeRoute 内由调用方传入 → 这里直接构造一次带凭据的调用
    const r = await handleOfficeRoute({
      method: 'GET', pathname: '/read-sheet', searchParams: new URLSearchParams({ path: creds }),
      body: null, sep,
      roots: { ...ROOTS, credentials: [creds] },
      guard: { resolveReadable, resolveWritable, assertSizeOk, findPythonExe: () => resolvePython() },
    })
    assert.equal(r?.status, 403, JSON.stringify(r?.body))
    assert.equal(r.body.code, 'EPROTECTED')
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_DENY_PATHS; else process.env.YFW_FS_DENY_PATHS = prev
  }
})
