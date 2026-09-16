/**
 * 批次 4（工程健壮性）内核侧用例：覆盖前备份（stash-doc）与文件数上限出声。
 *
 * 这一组的共同主题是**"静默的坏结果"**：
 *   · 覆盖别人的改动却不备份 → 那份内容永远消失（没人发现，直到用户去找）
 *   · 索引撞到文件数上限静默停手 → 用户看到"索引成功"，而超限文档搜不到、图谱里没有、
 *     统计也不含，且没有任何迹象说明原因（用户只会怀疑搜索坏了）
 *   · 截断导致"磁盘已删"清扫误判 → >5000 文件的库每次 load 都全量重建（索引永远追不上）
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const HOMES = []
function makeStore(spaces = [['my-notes', {}]]) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kb4-'))
  HOMES.push(dir)
  for (const [id] of spaces) mkdirSync(join(dir, 'knowledge', 'spaces', id), { recursive: true })
  const store = createKnowledgeStore({ configDir: dir })
  store.load({})
  return { dir, store, root: join(dir, 'knowledge', 'spaces') }
}
after(() => { for (const d of HOMES) rmSync(d, { recursive: true, force: true }) })

test('批次4：stashDoc 把内容**复制**进回收站且原文件保留（覆盖前备份的语义）', () => {
  const { store, root } = makeStore()
  writeFileSync(join(root, 'my-notes', 'a.md'), '# 外部版本\n\n正文。\n', 'utf-8')
  store.load({})

  const r = store.stashDoc({ space: 'my-notes', path: 'a.md', reason: 'overwrite' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.reason, 'overwrite')
  // 原文件必须留下 —— 调用方紧接着要写入新内容，搬走就等于"备份 = 删除"
  assert.ok(existsSync(join(root, 'my-notes', 'a.md')), '备份后原文件必须还在')
  assert.equal(readFileSync(join(root, 'my-notes', 'a.md'), 'utf-8'), '# 外部版本\n\n正文。\n')

  // 回收站里能看到这条备份，且**原因如实**（不是"用户删除的"——否则用户会怀疑系统乱删文件）
  const trash = store.listTrash()
  const item = trash.items.find((it) => it.trashId === r.trashId)
  assert.ok(item, `回收站应有备份条目：${JSON.stringify(trash.items)}`)
  assert.equal(item.reason, 'overwrite')
  assert.equal(item.relPath, 'a.md')
  assert.ok(item.bytes > 0)

  // 备份内容可还原（真有需要时能取回那段内容）
  const restored = store.restore({ trashId: r.trashId, mode: 'to-new-name' })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  const name = restored.path || restored.relPath
  assert.ok(name)
  assert.match(readFileSync(join(root, 'my-notes', name), 'utf-8'), /外部版本/)
})

test('批次4：stashDoc 的路径/空间校验（不存在、越界、非 md、空间不存在都如实报错）', () => {
  const { store, root } = makeStore()
  writeFileSync(join(root, 'my-notes', 'a.md'), '# A\n', 'utf-8')
  store.load({})
  assert.equal(store.stashDoc({ space: 'nope', path: 'a.md' }).error, 'space-not-found')
  assert.equal(store.stashDoc({ space: 'my-notes', path: 'missing.md' }).error, 'not-found')
  // 非 md / 绝对路径 / 越界：一律 bad-path（备份也不能成为绕过穿越防护的通道）
  assert.equal(store.stashDoc({ space: 'my-notes', path: 'a.txt' }).error, 'bad-path')
  assert.equal(store.stashDoc({ space: 'my-notes', path: '../outside.md' }).error, 'bad-path')
  assert.equal(store.stashDoc({ space: 'my-notes', path: 'C:/abs.md' }).error, 'bad-path')
  // 失败时不得留下任何回收站记录（否则用户会看到一条"还原不了"的空条目）
  assert.equal(store.listTrash().items.length, 0)
})

test('批次4：walkMd 跳过原子写临时文件（否则保存一次就多出一篇同名文档）', () => {
  const { store, root } = makeStore()
  const sp = join(root, 'my-notes')
  writeFileSync(join(sp, 'a.md'), '# A\n', 'utf-8')
  // 原子写的临时名结尾也是 `.md` —— 若不跳过，它会被当成一篇新文档收进索引，
  // 而它随时会被 rename 走或删掉（进程被强杀时还会长期残留污染索引）
  writeFileSync(join(sp, '.yfw-tmp-1234-abcd-a.md'), '# A（半截副本）\n', 'utf-8')
  store.load({})
  const ids = store.getDocs().map((d) => d.id)
  assert.deepEqual(ids, ['my-notes/a.md'], `临时文件不得进索引：${JSON.stringify(ids)}`)
})

test('批次4：文件数上限**必须出声**（manifest 留痕 + stats 报出，而不是静默少文档）', () => {
  const { dir, store, root } = makeStore()
  const sp = join(root, 'my-notes')
  // 上限是 5000，造不了那么多文件 → 直接用内核导出的常量校验语义不方便，
  // 故这里用"大量文件 + 校验口径"的方式不可行；改为验证**契约字段存在且默认为未截断**，
  // 真正的截断路径由下面的 lower-level 用例（直接调 walkMd）覆盖。
  writeFileSync(join(sp, 'a.md'), '# A\n', 'utf-8')
  store.load({})
  const st = store.stats()
  assert.ok(st.filesTruncated, 'stats 必须带 filesTruncated 字段（GUI 据此提示）')
  assert.equal(st.filesTruncated.truncated, false)
  assert.equal(typeof st.filesTruncated.limit, 'number')
  // 未截断时 manifest 不留无用键（off/常态不留痕，与 relLines 同一取舍）
  const man = JSON.parse(readFileSync(join(dir, 'knowledge', '.index', 'manifest.json'), 'utf-8'))
  assert.equal(man.filesTruncated, undefined)
})

test('批次4：walkMd 撞上限时 stats.truncated=true 且不再静默', async () => {
  const { walkMd } = await import('../kernel/knowledge.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kb4-walk-'))
  HOMES.push(dir)
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `f${i}.md`), `# ${i}\n`, 'utf-8')
  const stats = {}
  const files = walkMd(dir, { maxFiles: 3, stats })
  assert.equal(files.length, 3)
  assert.equal(stats.truncated, true, '撞上限必须被标注（旧实现静默停手）')
  assert.equal(stats.limit, 3)
  assert.equal(stats.count, 3)
  // 未撞上限 → truncated=false（不能恒真，否则提示永远挂着 → 用户学会无视它）
  const stats2 = {}
  walkMd(dir, { maxFiles: 100, stats: stats2 })
  assert.equal(stats2.truncated, false)
  assert.equal(stats2.count, 6)
})
