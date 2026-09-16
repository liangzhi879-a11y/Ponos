// S1 步骤 2+3：C2 块模型（真序 + 稳定 blockId + baseVersion）与 C1 ops 写入
// ---------------------------------------------------------------------------
// 为什么 C2 与 C1 必须同批验（spec:519）：ops 以 blockId 寻址且**禁用序号**，所以"块模型"与
// "写入契约"是一件事的两面。实测证据：序号寻址在插入/删除后由 17/17 崩到 2/17。
//
// 本文件的断言全部指向**改造后的新契约**（与 `docx-python.test.mjs` 的"[现状]+TODO"相反）：
// 那边锁旧行为、这边验新行为。两边并存不是冗余 —— 前者保证"改写没有顺手弄坏别的东西"
// （幂等、重存稳定、表格写回），后者保证"该变的确实变了"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledPython, resolvePython } from '../kernel/knowledge-import.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SCRIPT = join(__dirname, 'docx_edit.py')
const FIXTURES = join(__dirname, 'office-fixtures')
const TOOLS = join(FIXTURES, 'tools')

function rmRetry(p, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}
function py() { return resolvePython() || bundledPython() || 'python' }

function runDocx(args) {
  const r = spawnSync(py(), [SCRIPT, ...args], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim()) } catch { /* 由断言暴露 */ }
  return { code: r.status, json, stdout: String(r.stdout), stderr: String(r.stderr) }
}
function runProbe(script, args) {
  const r = spawnSync(py(), [join(TOOLS, script), ...args], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
  let json = null
  try { json = JSON.parse(String(r.stdout).trim()) } catch { /* 由断言暴露 */ }
  return json
}
function readBlocks(path) {
  const r = runDocx(['read', path])
  assert.equal(r.json.ok, true, r.stdout + r.stderr)
  return r.json
}
/** 写 ops 请求体，返回 python 的返回。 */
function writeOps(dir, body) {
  const j = join(dir, `ops-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(j, JSON.stringify(body), 'utf-8')
  return runDocx(['write', j])
}
function tmpDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }

test('[C2] 真序：表格按文档真实次序穿插（用**块序已知**的探针，而非恰好重合的 base.docx）', () => {
  const dir = tmpDir('yfw-c2-order-')
  try {
    const docx = join(dir, 'order.docx')
    const made = runProbe('docx_order_probe.py', ['make', docx])
    assert.equal(made.ok, true, '探针生成失败：' + JSON.stringify(made))

    const kinds = readBlocks(docx).blocks.map((b) => b.kind)
    // 旧实现会把两个表都排到末尾（p,p,p,table,table）；真序必须是穿插。
    assert.deepEqual(kinds, ['p', 'table', 'p', 'table', 'p'],
      'C2：read 必须按 body 子元素真序取块（旧实现会把表格全部挪到末尾 = B3）')
  } finally { rmRetry(dir) }
})

test('[C2] blockId 唯一且非空；重复内容靠出现序号区分（纯内容哈希会撞车）', () => {
  const dir = tmpDir('yfw-c2-dup-')
  try {
    const pyc = py()
    const docx = join(dir, 'dup.docx')
    // 造"两段完全相同文字"的文档：纯内容哈希必然给出同一 id，必须靠序号消歧
    const gen = spawnSync(pyc, ['-c', [
      'from docx import Document',
      'd=Document()',
      "d.add_paragraph('重复段落')",
      "d.add_paragraph('重复段落')",
      "d.add_paragraph('另一种')",
      `d.save(r'${docx.replace(/\\/g, '\\\\')}')`,
    ].join('\n')], { cwd: REPO, encoding: 'utf-8', timeout: 30000 })
    assert.equal(gen.status, 0, `造语料失败：${gen.stderr}`)

    const blocks = readBlocks(docx).blocks
    const ids = blocks.map((b) => b.blockId)
    assert.equal(ids.every((x) => typeof x === 'string' && x.length > 0), true, '每个块都要有非空 blockId')
    assert.equal(new Set(ids).size, ids.length, 'blockId 必须唯一（重复内容也要能区分）')
    assert.equal(ids[0].split(':')[0], ids[1].split(':')[0], '同内容 ⇒ 同哈希前缀（幂等/稳定的基础）')
    assert.notEqual(ids[0], ids[1], '同内容 ⇒ 靠出现序号区分')
  } finally { rmRetry(dir) }
})

test('[C2] 幂等三性质：同文件多次读 ⇒ 同一 id；重存文件 ⇒ 同一 id；不同内容 ⇒ 不同 id', () => {
  const dir = tmpDir('yfw-c2-idem-')
  try {
    const docx = join(dir, 'base.docx')
    copyFileSync(join(FIXTURES, 'base.docx'), docx)

    const a = readBlocks(docx)
    const b = readBlocks(docx)
    assert.deepEqual(b.blocks, a.blocks, '幂等：多次读取结果逐字相同')
    assert.equal(b.baseVersion, a.baseVersion, '幂等：baseVersion 也相同（文件没被改动）')

    // 稳定：Word 重存（内容同、XML 表示不同）后 id 必须不变 —— S1 最关键的资产
    const resaved = readBlocks(join(FIXTURES, 'word_resaved.docx'))
    assert.deepEqual(resaved.blocks.map((x) => x.blockId), a.blocks.map((x) => x.blockId),
      '稳定：Word 重存不得改变 blockId（否则协同会把整篇判成"全被改了"）')

    // 判别力：改一个字必须换 id（否则"改内容"在块模型里不可见）
    const w = writeOps(dir, {
      path: docx, baseVersion: a.baseVersion,
      ops: [{ op: 'update', blockId: a.blocks[0].blockId, text: 'YFW-C2-换了文字' }],
    })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    const after = readBlocks(docx)
    assert.notEqual(after.blocks[0].blockId, a.blocks[0].blockId, '内容变了 ⇒ id 必须变')
    assert.equal(after.blocks[0].text, 'YFW-C2-换了文字')
  } finally { rmRetry(dir) }
})

test('[C1] ops 四类：update / delete / insert / move 各自生效且可被 read 观察到', () => {
  const dir = tmpDir('yfw-c1-ops-')
  try {
    const docx = join(dir, 'order.docx')
    assert.equal(runProbe('docx_order_probe.py', ['make', docx]).ok, true)

    // update：改第一段
    let cur = readBlocks(docx)
    let w = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'update', blockId: cur.blocks[0].blockId, text: '甲改' }] })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    cur = readBlocks(docx)
    assert.equal(cur.blocks[0].text, '甲改', 'update 生效')

    // insert after：在"甲改"之后插入新段落
    w = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'insert', after: cur.blocks[0].blockId, block: { kind: 'p', text: '乙新增' } }] })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    cur = readBlocks(docx)
    assert.equal(cur.blocks[1].text, '乙新增', 'insert 插到了锚点之后（位置正确）')
    assert.deepEqual(cur.blocks.map((b) => b.kind), ['p', 'p', 'table', 'p', 'table', 'p'], '插入的是段落，表格仍在真序位置上')

    // move：把新段移到末尾
    const moveTarget = cur.blocks[1].blockId
    const lastId = cur.blocks[cur.blocks.length - 1].blockId
    w = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'move', blockId: moveTarget, after: lastId }] })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    cur = readBlocks(docx)
    assert.equal(cur.blocks[cur.blocks.length - 1].text, '乙新增', 'move 生效（块到了末尾）')

    // delete：删掉它
    w = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'delete', blockId: cur.blocks[cur.blocks.length - 1].blockId }] })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    cur = readBlocks(docx)
    assert.equal(cur.blocks.some((b) => b.text === '乙新增'), false, 'delete 生效（块已消失）')
    assert.equal(cur.blocks.length, 5, '回到 5 块')
  } finally { rmRetry(dir) }
})

test('[C1] 序号寻址禁用：ops 必须靠 blockId 定位（旧 blocks 全量写法**显式报错**）', () => {
  const dir = tmpDir('yfw-c1-legacy-')
  try {
    const docx = join(dir, 'base.docx')
    copyFileSync(join(FIXTURES, 'base.docx'), docx)
    const cur = readBlocks(docx)

    // 旧写法：带 blocks、不带 ops ⇒ 必须明确拒绝（不得静默按位覆盖 = B1）
    const legacy = writeOps(dir, { path: docx, blocks: cur.blocks })
    assert.equal(legacy.json.ok, false, '旧 blocks 写法必须被拒绝')
    assert.equal(legacy.json.code, 'legacy-blocks-not-supported')
    const afterLegacy = readBlocks(docx)
    assert.deepEqual(afterLegacy.blocks, cur.blocks, '被拒绝的写入不得改动文件（拒绝要彻底）')

    // 既无 ops 也无 blocks ⇒ 明确报缺 ops
    const none = writeOps(dir, { path: docx, baseVersion: cur.baseVersion })
    assert.equal(none.json.ok, false)
    assert.equal(none.json.code, 'ops-required')

    // 引用了不存在的 blockId ⇒ 明确报错（不得静默忽略该条 op）
    const ghost = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'update', blockId: 'deadbeefdead:1', text: 'x' }] })
    assert.equal(ghost.json.ok, false)
    assert.equal(ghost.json.code, 'block-not-found')

    // 未知 op 类型 ⇒ 明确报错
    const unknown = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'frobnicate', blockId: cur.blocks[0].blockId }] })
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.code, 'unknown-op')
  } finally { rmRetry(dir) }
})

test('[C1] baseVersion 防丢失更新：缺失拒绝、不匹配拒绝、匹配放行', () => {
  const dir = tmpDir('yfw-c1-ver-')
  try {
    const docx = join(dir, 'base.docx')
    copyFileSync(join(FIXTURES, 'base.docx'), docx)
    const cur = readBlocks(docx)

    // 缺失 ⇒ 拒绝
    const missing = writeOps(dir, { path: docx, ops: [{ op: 'update', blockId: cur.blocks[0].blockId, text: 'x' }] })
    assert.equal(missing.json.ok, false)
    assert.equal(missing.json.code, 'base-version-required')

    // 不匹配（模拟"别人先改了"）⇒ 拒绝，且给出 expected/actual 供排障
    const stale = writeOps(dir, { path: docx, baseVersion: 'f'.repeat(64), ops: [{ op: 'update', blockId: cur.blocks[0].blockId, text: 'x' }] })
    assert.equal(stale.json.ok, false)
    assert.equal(stale.json.code, 'base-version-mismatch')
    assert.equal(stale.json.expected, 'f'.repeat(64))
    assert.equal(stale.json.actual, cur.baseVersion)
    assert.deepEqual(readBlocks(docx).blocks, cur.blocks, '被拒绝的写入不得动文件')

    // 真实场景：A 读 → B 改（A 的 baseVersion 过期）→ A 再提交必须被拒
    const bWrite = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'update', blockId: cur.blocks[0].blockId, text: 'B 先改的' }] })
    assert.equal(bWrite.json.ok, true)
    const aStale = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'update', blockId: cur.blocks[0].blockId, text: 'A 想覆盖' }] })
    assert.equal(aStale.json.ok, false, 'A 基于旧版本提交必须被拒绝（否则会覆盖 B 的改动）')
    assert.equal(aStale.json.code, 'base-version-mismatch')
    assert.equal(readBlocks(docx).blocks[0].text, 'B 先改的', 'B 的改动必须保住')

    // 拿到最新 baseVersion 后重试 ⇒ 放行，且返回新版本号
    const fresh = readBlocks(docx)
    const retry = writeOps(dir, { path: docx, baseVersion: fresh.baseVersion, ops: [{ op: 'update', blockId: fresh.blocks[0].blockId, text: 'A 重试成功' }] })
    assert.equal(retry.json.ok, true, retry.stdout + retry.stderr)
    assert.match(String(retry.json.baseVersion), /^[0-9a-f]{64}$/, '写入后应返回新的 baseVersion（供前端续接）')
    assert.notEqual(retry.json.baseVersion, fresh.baseVersion, '内容变了版本必变')
  } finally { rmRetry(dir) }
})

test('[C1] 表格式更新仍可用（粗粒度）：update table 的 rows 生效且结构不散', () => {
  const dir = tmpDir('yfw-c1-table-')
  try {
    const docx = join(dir, 'order.docx')
    assert.equal(runProbe('docx_order_probe.py', ['make', docx]).ok, true)
    const cur = readBlocks(docx)
    const ti = cur.blocks.findIndex((b) => b.kind === 'table')
    assert.ok(ti >= 0)
    const rows = cur.blocks[ti].rows.map((r) => r.slice())
    rows[0][0] = 'YFW-表头改'
    const w = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'update', blockId: cur.blocks[ti].blockId, rows }] })
    assert.equal(w.json.ok, true, w.stdout + w.stderr)
    const after = readBlocks(docx)
    const t2 = after.blocks.filter((b) => b.kind === 'table')[0]
    assert.equal(t2.rows[0][0], 'YFW-表头改', '表格 cell 更新生效')
    assert.deepEqual(t2.rows.map((r) => r.length), rows.map((r) => r.length), '表结构（列数）不变')
  } finally { rmRetry(dir) }
})

test('[C1] 批内自洽：引用已被删除的块、或把块移到自己之后 ⇒ 明确拒绝（不留半截状态）', () => {
  const dir = tmpDir('yfw-c1-batch-')
  try {
    const docx = join(dir, 'order.docx')
    assert.equal(runProbe('docx_order_probe.py', ['make', docx]).ok, true)
    const cur = readBlocks(docx)
    const id0 = cur.blocks[0].blockId

    const delThenUse = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'delete', blockId: id0 }, { op: 'update', blockId: id0, text: 'x' }] })
    assert.equal(delThenUse.json.ok, false)
    assert.equal(delThenUse.json.code, 'block-deleted')

    const selfMove = writeOps(dir, { path: docx, baseVersion: cur.baseVersion, ops: [{ op: 'move', blockId: id0, after: id0 }] })
    assert.equal(selfMove.json.ok, false)
    assert.equal(selfMove.json.code, 'bad-move')
  } finally { rmRetry(dir) }
})
