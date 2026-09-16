/**
 * 批次 4：知识空间文件监听（server/knowledge-watch.mjs）用例。
 *
 * 测的是"外部编辑器改了 md，应用要能知道"这条链路的前半段：watcher 本身。
 * 为什么要真起监听（而不是 mock fs.watch）：这一层的价值全在"平台差异能不能跑起来"——
 * 尤其在 Linux 上递归监听需要 Node ≥ 20，老版本会抛，此时必须**降级并如实标注 mode**，
 * 而不是静默失败（静默失败会让"为什么有时不同步"变成无法排查的玄学）。
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startKnowledgeWatch } from '../server/knowledge-watch.mjs'

const DIRS = []
function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-watch-'))
  DIRS.push(dir)
  const root = join(dir, 'spaces')
  mkdirSync(join(root, 'notes'), { recursive: true })
  return root
}
after(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })

/** 等一批回调（watcher 有 400ms 防抖 → 给足余量；超时则抛，避免测试悬挂） */
function waitForBatch(ms = 2500) {
  let resolve
  const p = new Promise((r) => { resolve = r })
  return { promise: p, push: (b) => resolve(b), timeout: new Promise((_, rej) => setTimeout(() => rej(new Error('watch 未在预期时间内触发')), ms)) }
}

test('批次4：外部写入 md → 防抖后回调一次，路径可读且带单调 revision', async () => {
  const root = tmpRoot()
  const batches = []
  const w = startKnowledgeWatch({ root, onChange: (b) => batches.push(b) })
  try {
    assert.notEqual(w.mode, 'failed', `监听应能启动（error=${w.error}）`)
    writeFileSync(join(root, 'notes', 'a.md'), '# 外部编辑器写的\n', 'utf-8')
    // 防抖窗口 400ms，等 1.2s（含文件系统通知延迟）
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(batches.length, 1, `连续写入应被防抖合并成一批，实际 ${batches.length} 批`)
    const b = batches[0]
    assert.ok(b.count >= 1)
    assert.equal(typeof b.revision, 'number')
    assert.ok(b.paths.some((p) => p.includes('a.md')), `批次里应能看到文件名：${JSON.stringify(b.paths)}`)
    assert.ok(b.paths.length <= 50, '路径样本要有上限（大目录同步会一次产生上千条）')

    // 第二批：revision 必须递增（GUI 靠它丢弃乱序到达的旧批次）
    writeFileSync(join(root, 'notes', 'b.md'), '# 第二篇\n', 'utf-8')
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(batches.length, 2)
    assert.ok(batches[1].revision > batches[0].revision, 'revision 必须单调递增')
  } finally { w.stop() }
})

test('批次4：原子写临时文件不触发通知（否则每次保存都多通知一轮）', async () => {
  const root = tmpRoot()
  const batches = []
  const w = startKnowledgeWatch({ root, onChange: (b) => batches.push(b) })
  try {
    // `.yfw-tmp-*` 是保存文档时的中间产物：它的创建与删除都不是"内容变了"。
    // 不过滤的话，一次保存会额外产生一轮无效通知 → GUI 反复失效、反复拉起内核进程。
    writeFileSync(join(root, 'notes', '.yfw-tmp-999-zzzz-a.md'), '临时\n', 'utf-8')
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(batches.length, 0, `临时文件不该触发通知：${JSON.stringify(batches)}`)
    // 对照：真正的 md 变化照常触发（证明上一条不是因为监听根本没工作）
    writeFileSync(join(root, 'notes', 'real.md'), '# 真的\n', 'utf-8')
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(batches.length, 1, '真实文件变化必须触发')
    assert.ok(batches[0].paths.every((p) => !p.includes('.yfw-tmp-')), '批次里不得含临时文件')
  } finally { w.stop() }
})

test('批次4：stop() 之后不再回调（不泄漏监听，避免 shutdown 后仍拉内核）', async () => {
  const root = tmpRoot()
  const batches = []
  const w = startKnowledgeWatch({ root, onChange: (b) => batches.push(b) })
  writeFileSync(join(root, 'notes', 'before.md'), '# 停之前\n', 'utf-8')
  await new Promise((r) => setTimeout(r, 1200))
  const seen = batches.length
  w.stop()
  assert.equal(w.ok, false, 'stop 后句柄要反映"已停"')
  writeFileSync(join(root, 'notes', 'after.md'), '# 停之后\n', 'utf-8')
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(batches.length, seen, '停止后不得再有回调')
})

test('批次4：root 不存在时自动创建（首次启动不该因为目录还没建就失去监听）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-watch-new-'))
  DIRS.push(dir)
  const root = join(dir, 'spaces')
  const w = startKnowledgeWatch({ root, onChange: () => {} })
  try {
    assert.notEqual(w.mode, 'failed', `应在建目录后成功挂上（error=${w.error}）`)
    assert.ok(w.ok)
  } finally { w.stop() }
  // 无 root 参数 → 明确失败（不是静默 ok），供调用方判断
  const bad = startKnowledgeWatch({ root: '', onChange: () => {} })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'no-root')
})
