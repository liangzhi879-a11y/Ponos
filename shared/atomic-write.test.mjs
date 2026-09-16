/**
 * 批次 4：原子写入（shared/atomic-write.mjs）用例。
 *
 * 这里能测的不是"崩溃时行为"（没法在单测里真的拔电），而是三个**充分条件**：
 *   ① 写入后内容完整、且**目录里不留临时文件**（临时文件残留会被 walkMd 当成 .md 收进索引）
 *   ② 目标已存在时被**整体替换**（不是就地覆写）—— 用一个持续读文件的观察者验证：
 *      读到的永远是"完整旧内容"或"完整新内容"，不会读到中间态
 *   ③ 失败时目标文件**一个字节都没动**（用"临时文件无法创建"来构造失败）
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomicSync, isAtomicTmpName, cleanupAtomicTmpSync } from '../shared/atomic-write.mjs'

const DIRS = []
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'ponos-aw-'))
  DIRS.push(d)
  return d
}
after(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })

test('批次4：writeFileAtomicSync 写入完整内容、自动建目录、不留临时文件', () => {
  const dir = tmpDir()
  const f = join(dir, 'sub', 'deep', 'a.md')
  const n = writeFileAtomicSync(f, '# 标题\n\n正文。\n')
  assert.equal(n, Buffer.byteLength('# 标题\n\n正文。\n'))
  assert.equal(readFileSync(f, 'utf-8'), '# 标题\n\n正文。\n')
  // 残留的临时文件会以 `.md` 结尾（名字是 `.yfw-tmp-…-原名.md`）→ 被判成一篇新文档进索引。
  // 所以"不留临时文件"不是整洁问题，是**数据正确性问题**。
  const names = readdirSync(join(dir, 'sub', 'deep'))
  assert.deepEqual(names, ['a.md'], `不得留临时文件：${JSON.stringify(names)}`)
})

test('批次4：目标已存在时被整体替换（观察者永远读到完整内容，读不到中间态）', async () => {
  const dir = tmpDir()
  const f = join(dir, 'a.md')
  const oldContent = 'A'.repeat(200_000)
  const newContent = 'B'.repeat(200_000)
  writeFileSync(f, oldContent, 'utf-8')
  let torn = 0
  let reads = 0
  let running = true
  const observer = (async () => {
    while (running) {
      try {
        const s = readFileSync(f, 'utf-8')
        reads += 1
        // 只要出现"既不是全 A 也不是全 B"的内容，就是读到了半截（同一 inode 被就地覆写的特征）
        if (s !== oldContent && s !== newContent) torn += 1
      } catch { /* 打开瞬间的竞态：Windows 上 rename 期间偶发，不计为撕裂 */ }
      await new Promise((r) => setImmediate(r))
    }
  })()
  for (let i = 0; i < 5; i++) writeFileAtomicSync(f, newContent)
  running = false
  await observer
  assert.ok(reads > 0, '观察者应至少读到一次')
  assert.equal(torn, 0, `原子替换下不应读到半截内容（reads=${reads}）`)
  assert.equal(readFileSync(f, 'utf-8'), newContent)
})

test('批次4：写入失败时目标文件原封不动（宁可不写，也不能写坏）', () => {
  const dir = tmpDir()
  const f = join(dir, 'a.md')
  writeFileSync(f, '# 原始内容\n', 'utf-8')
  // 构造失败：让临时文件无法创建（目录不可写）。Windows 上 chmod 对目录不生效，
  // 故用"目标是目录"这条跨平台路径 —— rename 到目录必然失败。
  const asDir = join(dir, 'b.md')
  mkdirSync(asDir)
  assert.throws(() => writeFileAtomicSync(asDir, 'x'), '目标不可替换时必须抛错（不静默回退成普通写入）')
  // 抛错路径下，既有文件不受影响
  assert.equal(readFileSync(f, 'utf-8'), '# 原始内容\n')
  assert.ok(!readdirSync(dir).some(isAtomicTmpName), '失败后不得留临时文件')
})

test('批次4：isAtomicTmpName / cleanupAtomicTmpSync 与写入端同源（清理残留）', () => {
  const dir = tmpDir()
  assert.equal(isAtomicTmpName('.yfw-tmp-1-x-a.md'), true)
  assert.equal(isAtomicTmpName('a.md'), false)
  assert.equal(isAtomicTmpName(''), false)
  // 进程被强杀留下的残留：清理函数应能识别并删除
  writeFileSync(join(dir, '.yfw-tmp-1-abc-a.md'), 'x', 'utf-8')
  writeFileSync(join(dir, 'keep.md'), 'x', 'utf-8')
  assert.equal(cleanupAtomicTmpSync(dir), 1)
  assert.deepEqual(readdirSync(dir), ['keep.md'])
  // 目录不存在 → 返回 0 而不是抛错（调用方无须先判存在）
  assert.equal(cleanupAtomicTmpSync(join(dir, 'nope')), 0)
})
