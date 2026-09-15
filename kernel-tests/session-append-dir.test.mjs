// K1.5 落盘目录「只建一次」契约（2026-09-13「任务运行慢」系统性优化 Task 6）
// ---------------------------------------------------------------------------
// `append()` 此前每条都重复 `mkdirSync(dir, {recursive:true})`——实测 0.401ms → 0.221ms/条
// （省 0.181ms，占单条落盘近半）。改为构造期建一次 + `dirEnsured` 标志后，**必须**保住旧实现
// 的隐含自愈语义：目录在运行期被删（用户清理 ~/.yfw、测试夹具 rmSync）时，旧实现每次都 mkdir
// 所以能自愈；新实现若只省不补，就会**静默丢写**（catch 吞掉 ENOENT，磁盘上少一条而内存里有）。
//
// 故本文件的重心不是"省了 mkdir"，而是**省了之后一条都不许丢**。
//
// 另一条硬约束（写在代码注释里，这里用测试反向钉住）：**不得改成常驻 fd**——
// `setEntryUsage` 走 `writeFileSync(tmp) + renameSync(tmp, file)` 整体替换文件，持有 fd 会
// 指向被 unlink 的旧 inode ⇒ 后续写入落在不可达 inode 上。用例 4 就是这个场景的守卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createSessionStore } = await import('../kernel/session.mjs')

const mkHome = () => mkdtempSync(join(tmpdir(), 'sessdir-'))
/** 读出 transcript 里可解析的条目（跳过 meta 首行） */
const readEntries = (file) => readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

test('常态：连续 append 全部落盘，条数与顺序不差（只建一次目录不影响正确性）', () => {
  const home = mkHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'normal' })
    for (let i = 0; i < 5; i++) s.appendUser(`第 ${i} 条`)
    const entries = readEntries(s.file).filter((e) => e.type === 'user')
    assert.equal(entries.length, 5, '5 次 append 必须落 5 条')
    assert.deepEqual(entries.map((e) => e.message.content), [0, 1, 2, 3, 4].map((i) => `第 ${i} 条`))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('自愈（核心）：目录被运行期删除 → 下一条 append 重建目录并**真的落盘**（不静默丢写）', () => {
  // 注意本用例的边界：删掉 `projects` 目录等于连 transcript 文件一起删掉，**旧内容必然没了**
  // （旧实现同样如此）。所以这里要钉的不是"内容复活"，而是"新写入没有被 catch 静默吞掉"——
  // 若只加 dirEnsured 而不补 ENOENT 分支，appendFileSync 会抛 ENOENT 并被吞 ⇒ 磁盘上什么都
  // 没有，而内存里却有这条消息：**这才是要防的丢写**。
  const home = mkHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'heal' })
    s.appendUser('删除前')
    const dir = join(home, 'projects')
    rmSync(dir, { recursive: true, force: true })
    assert.equal(existsSync(dir), false, '前提：目录确实没了')
    s.appendUser('删除后')   // 旧实现靠"每次都 mkdir"自愈；新实现靠 ENOENT 分支
    assert.equal(existsSync(s.file), true, '必须重建目录并落盘，而不是静默丢写')
    const contents = readEntries(s.file).filter((e) => e.type === 'user').map((e) => e.message.content)
    assert.deepEqual(contents, ['删除后'], `删除后的新条目必须落盘（实际 ${JSON.stringify(contents)}）`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('自愈可重复：目录反复删除每次都能恢复（标志被正确复位，不是一次性）', () => {
  const home = mkHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'heal-twice' })
    const dir = join(home, 'projects')
    for (let round = 0; round < 3; round++) {
      s.appendUser(`第 ${round} 轮`)
      const contents = readEntries(s.file).filter((e) => e.type === 'user').map((e) => e.message.content)
      assert.deepEqual(contents, [`第 ${round} 轮`], `第 ${round} 轮必须落盘（标志复位失败会在这里露馅）`)
      rmSync(dir, { recursive: true, force: true })
    }
    s.appendUser('收尾')
    const last = readEntries(s.file).filter((e) => e.type === 'user').map((e) => e.message.content)
    assert.deepEqual(last, ['收尾'], `第 4 次删除后仍须自愈（实际 ${JSON.stringify(last)}）`)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('磁盘不可写：append 不抛、内存状态仍可用（与旧实现同为静默降级）', () => {
  const home = mkHome()
  try {
    // 构造期目录就建不成：把 projects 做成一个**文件**，mkdirSync 必失败（ENOTDIR/EEXIST）
    writeFileSync(join(home, 'projects'), 'not a dir')
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'nowrite' })
    assert.doesNotThrow(() => s.appendUser('写不进去也不该抛'))
    assert.equal(s.deriveMessages().length, 1, '内存状态必须仍然可用（磁盘不可写不致命）')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('守卫：setEntryUsage 换 inode 后，后续 append 仍写进新文件（不得常驻 fd）', () => {
  // 这是"不得改成常驻 fd"那条硬约束的反向守卫：若有人把 append 改成持 fd 直写，
  // setEntryUsage 的 rename 会让 fd 指向旧 inode → 本用例的最后一条会**消失**。
  const home = mkHome()
  try {
    const s = createSessionStore({ configDir: home, cwd: home, sessionId: 'inode' })
    const e = s.appendUser('第一条')
    s.setEntryUsage(e, { input_tokens: 1, output_tokens: 2 })
    s.appendUser('rename 之后的一条')
    const entries = readEntries(s.file).filter((x) => x.type === 'user')
    const contents = entries.map((x) => x.message.content)
    assert.deepEqual(contents, ['第一条', 'rename 之后的一条'],
      `rename 换 inode 后不得丢写（实际 ${JSON.stringify(contents)}）`)
    assert.deepEqual(entries[0].message.usage, { input_tokens: 1, output_tokens: 2 }, '后挂 usage 应落在原条目上')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('加载已存在的会话：构造期不覆盖旧文件（目录已存在时不得误删/误建）', async () => {
  const home = mkHome()
  try {
    const a = createSessionStore({ configDir: home, cwd: home, sessionId: 'reload' })
    a.appendUser('持久化的一条')
    const b = createSessionStore({ configDir: home, cwd: home, sessionId: 'reload' })
    await b.load()
    b.appendUser('恢复后的一条')
    const contents = readEntries(b.file).filter((x) => x.type === 'user').map((x) => x.message.content)
    assert.deepEqual(contents, ['持久化的一条', '恢复后的一条'], '恢复会话必须追加而非截断')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
