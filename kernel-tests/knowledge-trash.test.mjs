// kernel-tests/knowledge-trash.test.mjs —— 知识库删除管理（回收站）的回归
//
// 纪律：**不启动 bridge、不碰真实配置目录**（每个用例自建 mkdtemp 配置根）。
// 这里钉的是"删错了会丢用户数据"的那一层，按风险从高到低：
//   ① 权限矩阵 —— 内置经验库/会话记忆**不许删整库**（它的 root 就是用户的 memory/personal，
//      误放行等于删掉个人经验库）、知识包只读；
//   ② 路径穿越 —— `../` 绝不能把删除引到空间外；
//   ③ 软删除语义 —— 文件必须**还在磁盘上**（只是不在原位），否则"可还原"是假的；
//   ④ 还原的同名让位 —— 只许改名，**绝不覆盖**用户现有文件；
//   ⑤ purge 的物理删除边界 —— 只认回收站内的合规 trashId。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore, trashRoot, isTrashId, newTrashId } from '../kernel/knowledge.mjs'

/**
 * 造一个尽量贴近真实的配置根：
 *   memory/personal/                 ← 内置经验空间（experience）的 root，**用户真实数据的位置**
 *   knowledge/spaces/研发资料/       ← 用户自建空间
 *   knowledge/packs/demo/            ← 只读知识包
 * 三者齐备才能把权限矩阵跑全（少一个就只能测到"未知空间"）。
 */
function mkHome() {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-kbtrash-'))
  // 三个内置空间的 root 必须**都存在**，否则 discoverSpaces 不会产出该空间，
  // 权限矩阵就退化成"未知空间"（测不到 protected-space，矩阵等于没测）。
  // 路径照 builtinSpaceSpecs：memory/personal | memory/session | memory/skill_experiences。
  mkdirSync(join(dir, 'memory', 'personal'), { recursive: true })
  mkdirSync(join(dir, 'memory', 'session'), { recursive: true })
  mkdirSync(join(dir, 'memory', 'skill_experiences'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'personal', 'workflow.md'), '# 经验\n\n- 一条经验\n', 'utf-8')
  mkdirSync(join(dir, 'knowledge', 'spaces', '研发资料', 'sub'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'spaces', '研发资料', '.space.json'), JSON.stringify({ name: '研发资料' }), 'utf-8')
  writeFileSync(join(dir, 'knowledge', 'spaces', '研发资料', 'a.md'), '# A\n\n甲\n', 'utf-8')
  writeFileSync(join(dir, 'knowledge', 'spaces', '研发资料', 'sub', 'b.md'), '# B\n\n乙\n', 'utf-8')
  mkdirSync(join(dir, 'knowledge', 'packs', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'packs', 'demo', 'pack.json'), JSON.stringify({ name: 'demo包' }), 'utf-8')
  writeFileSync(join(dir, 'knowledge', 'packs', 'demo', 'p.md'), '# P\n\n丙\n', 'utf-8')
  return dir
}

function openStore(configDir) {
  const s = createKnowledgeStore({ configDir })
  s.load()
  return s
}

test('trash: 权限矩阵——内置库不许删整库、知识包只读（用户明确要求）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    // 内置经验空间：可删条目、不可删整库
    assert.deepEqual(s.canDelete({ space: 'experience' }), { ok: true })
    const whole = s.canDelete({ space: 'experience', whole: true })
    assert.equal(whole.ok, false)
    assert.equal(whole.error, 'protected-space')
    // 会话记忆同理（用户补充说明里点名的"会话记录"）
    assert.equal(s.canDelete({ space: 'session-memory', whole: true }).error, 'protected-space')
    // 知识包：条目与整库都不可删
    assert.equal(s.canDelete({ space: 'pack-demo' }).error, 'readonly-space')
    assert.equal(s.canDelete({ space: 'pack-demo', whole: true }).error, 'readonly-space')
    // 未知空间 / 缺参数
    assert.equal(s.canDelete({ space: '没有任何这个库' }).error, 'unknown-space')
    assert.equal(s.canDelete({}).error, 'missing-space')
    assert.equal(s.canDelete({ space: '   ' }).error, 'missing-space')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 内置库的 writable 为 true —— 权限判定绝不能依赖它', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const exp = s.getSpaces().find((x) => x.id === 'experience')
    // 这条断言是给未来的人看的：writable=true 是**记忆需要能写**，不是"可以删"。
    // 一旦有人把 deleteGate 改成看 writable，删整库就会被放行 → 删掉 memory/personal。
    assert.equal(exp.writable, true)
    assert.equal(s.canDelete({ space: 'experience', whole: true }).error, 'protected-space')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 软删除条目——原位消失、内容进回收站、索引同步（不是物理删除）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const r = s.deleteDoc({ space: '研发资料', path: 'sub/b.md' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.kind, 'doc')
    assert.equal(r.path, 'sub/b.md')
    assert.equal(r.indexSync, 'reloaded')
    assert.ok(isTrashId(r.trashId), r.trashId)

    // ① 原位没了
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料', 'sub', 'b.md')), false)
    // ② 内容**还在**（否则"可还原"是假的）—— 且保留了相对结构，还原才能原位放回
    const payload = join(trashRoot(home), r.trashId, 'payload', 'sub', 'b.md')
    assert.equal(existsSync(payload), true)
    assert.match(readFileSync(payload, 'utf-8'), /乙/)
    // ③ 台账与 meta.json 都在（meta 是台账损坏时的兜底）
    const meta = JSON.parse(readFileSync(join(trashRoot(home), r.trashId, 'meta.json'), 'utf-8'))
    assert.equal(meta.relPath, 'sub/b.md')
    assert.equal(meta.kind, 'doc')
    // ④ 索引里搜不到了（refreshAfterMutation 重建过）
    assert.equal(s.getDocs().some((d) => d.rel === 'sub/b.md'), false)
    // ⑤ 回收站天然不入索引：`.trash` 以 `.` 开头，walkMd 会跳过
    assert.equal(s.getDocs().some((d) => d.rel.includes('.trash')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 路径穿越与非法输入一律拒绝（且不产生任何副作用）', () => {
  const home = mkHome()
  const s = openStore(home)
  const target = join(home, 'memory', 'personal', 'workflow.md')
  try {
    const before = readdirSync(join(home, 'knowledge', 'spaces', '研发资料')).sort()
    // ../ 穿越：目标是真实存在的文件（否则会退化成 not-found，测不到防护本身）
    assert.equal(s.deleteDoc({ space: '研发资料', path: '../../memory/personal/workflow.md' }).error, 'bad-path')
    assert.equal(s.deleteDoc({ space: '研发资料', path: '../a.md' }).error, 'bad-path')
    assert.equal(s.deleteDoc({ space: '研发资料', path: 'sub/../../a.md' }).error, 'bad-path')
    // 绝对路径 / 盘符 / 非 md / 空
    assert.equal(s.deleteDoc({ space: '研发资料', path: '/etc/passwd' }).error, 'bad-path')
    assert.equal(s.deleteDoc({ space: '研发资料', path: 'C:/Windows/win.ini' }).error, 'bad-path')
    assert.equal(s.deleteDoc({ space: '研发资料', path: 'a.txt' }).error, 'bad-path')
    assert.equal(s.deleteDoc({ space: '研发资料', path: '' }).error, 'bad-path')
    // 反斜杠会被归一成正斜杠（Windows 用户从资源管理器复制路径的常态）
    assert.equal(s.deleteDoc({ space: '研发资料', path: 'sub\\nope.md' }).error, 'not-found')
    // 收尾断言：以上全部失败，且**磁盘无变化**（失败路径不许留下半成品）
    assert.equal(existsSync(target), true)
    assert.deepEqual(readdirSync(join(home, 'knowledge', 'spaces', '研发资料')).sort(), before)
    assert.equal(s.listTrash().count, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 不存在的文件报 not-found（而不是 bad-path）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    // 顺序问题：先判越界会把"文件不存在"误报成"路径非法"，调用方会去查路径写法 —— 方向全错
    const r = s.deleteDoc({ space: '研发资料', path: 'zz.md' })
    assert.equal(r.error, 'not-found')
    assert.match(r.message, /zz\.md/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 内置空间的条目可删可还原（记错的经验要能清掉）', () => {
  const home = mkHome()
  const s = openStore(home)
  const file = join(home, 'memory', 'personal', 'workflow.md')
  try {
    const r = s.deleteDoc({ space: 'experience', path: 'workflow.md' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(existsSync(file), false)          // 移走了
    assert.equal(s.getSpaces().some((x) => x.id === 'experience' && x.docCount === 0), true)

    const back = s.restore({ trashId: r.trashId })
    assert.equal(back.ok, true, JSON.stringify(back))
    assert.equal(back.renamed, false)
    assert.equal(existsSync(file), true)           // 回到原位
    assert.match(readFileSync(file, 'utf-8'), /一条经验/)
    assert.equal(s.listTrash().count, 0)           // 条目从回收站移除
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 还原遇同名**改名让位、绝不覆盖**（且目录前缀要带回去）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const del = s.deleteDoc({ space: '研发资料', path: 'sub/b.md' })
    // 删掉之后用户又在原位置建了同名文件（或另一台机器同步回来）—— 这是最常见的冲突
    writeFileSync(join(home, 'knowledge', 'spaces', '研发资料', 'sub', 'b.md'), '# 新B\n\n用户后写的\n', 'utf-8')

    const r = s.restore({ trashId: del.trashId })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.renamed, true)
    // 关键：让位名必须带目录前缀。只返回 `b-2.md` 会把文件还原到空间根 ——
    // 看着"还原成功"，实际位置错了、原目录下依旧缺这个文件。
    assert.equal(r.path, 'sub/b-2.md')
    assert.match(readFileSync(join(home, 'knowledge', 'spaces', '研发资料', 'sub', 'b.md'), 'utf-8'), /用户后写的/)
    assert.match(readFileSync(join(home, 'knowledge', 'spaces', '研发资料', 'sub', 'b-2.md'), 'utf-8'), /乙/)
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料', 'b-2.md')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 单独测 confirm 的 trim 口径（前端 isSpaceConfirmOk 必须与内核一致）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    // 首尾空白被 trim 后精确比对。用户从侧栏复制库名极易带上空格，为此报错只会
    // 制造"我明明输对了"的困惑。钉住这条是因为**两侧都 trim** 才成立：
    // 任一侧改成不 trim，就会出现"前端允许提交、内核拒绝"（表现为点了删除没反应）。
    const r = s.deleteSpace({ space: '研发资料', confirm: ' 研发资料 ' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), false)
    // 还原后测反例：**内部**的空格不会被 trim（`研发 资料` 是另一个名字，必须拒）
    s.restore({ trashId: s.listTrash().items[0].trashId })
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), true)
    assert.equal(s.deleteSpace({ space: '研发资料', confirm: '研发 资料' }).error, 'confirm-mismatch')
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 删整库——需 confirm 精确匹配；只允许用户自建库；目录进回收站', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    // confirm 缺失 / 空 / 不匹配 → 一律拒（先测拒绝路径：空间还在，才测得出"拒了"）
    assert.equal(s.deleteSpace({ space: '研发资料' }).error, 'confirm-mismatch')
    assert.equal(s.deleteSpace({ space: '研发资料', confirm: '' }).error, 'confirm-mismatch')
    assert.equal(s.deleteSpace({ space: '研发资料', confirm: '研发' }).error, 'confirm-mismatch')
    assert.equal(s.deleteSpace({ space: '研发资料', confirm: '错误库名' }).error, 'confirm-mismatch')
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), true)

    const r = s.deleteSpace({ space: '研发资料', confirm: '研发资料' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.kind, 'space')
    // 整库（含子目录与 .space.json）整体进回收站
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), false)
    assert.equal(existsSync(join(trashRoot(home), r.trashId, 'payload', 'sub', 'b.md')), true)
    assert.equal(existsSync(join(trashRoot(home), r.trashId, 'payload', '.space.json')), true)
    // 空间集合里也没了
    assert.equal(s.getSpaces().some((x) => x.id === '研发资料'), false)
    // 内置库即使 confirm 正确也不许删（且**确认流程不能成为绕过权限的路径**）
    assert.equal(s.deleteSpace({ space: 'experience', confirm: 'experience' }).error, 'protected-space')
    assert.equal(existsSync(join(home, 'memory', 'personal', 'workflow.md')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 还原整库——同名时改名让位，不覆盖已有同 id 空间', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const del = s.deleteSpace({ space: '研发资料', confirm: '研发资料' })
    // 还原前用户又建了同名库 → 必须让位（`研发资料-2`），不许覆盖
    mkdirSync(join(home, 'knowledge', 'spaces', '研发资料'), { recursive: true })
    writeFileSync(join(home, 'knowledge', 'spaces', '研发资料', 'new.md'), '# 新库\n\n内容\n', 'utf-8')

    const r = s.restore({ trashId: del.trashId })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.renamed, true)
    assert.equal(r.spaceId, '研发资料-2')
    // 新库原封不动
    assert.match(readFileSync(join(home, 'knowledge', 'spaces', '研发资料', 'new.md'), 'utf-8'), /新库/)
    // 旧库内容在让位目录里完整回来
    assert.match(readFileSync(join(home, 'knowledge', 'spaces', '研发资料-2', 'sub', 'b.md'), 'utf-8'), /乙/)
    const ids = s.getSpaces().map((x) => x.id).sort()
    // 三个内置空间（经验/会话/技能经验）+ 知识包 + 让位后的两个用户库
    assert.deepEqual(ids, ['experience', 'pack-demo', 'session-memory', 'skill-experience', '研发资料', '研发资料-2'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: listTrash 形状与 available 标记（内容被手工清掉时应为 false）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const a = s.deleteDoc({ space: '研发资料', path: 'a.md' })
    const list = s.listTrash()
    assert.equal(list.count, 1)
    assert.equal(list.dir, trashRoot(home))
    assert.equal(list.stray, 0)
    const it = list.items[0]
    assert.equal(it.trashId, a.trashId)
    assert.equal(it.kind, 'doc')
    assert.equal(it.spaceId, '研发资料')
    assert.equal(it.relPath, 'a.md')
    assert.equal(it.available, true)
    assert.ok(it.bytes > 0)
    assert.ok(it.deletedAt)

    // 用户手工把回收站内容删了 → available=false（GUI 据此把「还原」置灰、只留「彻底删除」）
    rmSync(join(trashRoot(home), a.trashId, 'payload'), { recursive: true, force: true })
    assert.equal(s.listTrash().items[0].available, false)
    // 此时还原必须明确报 payload-missing（而不是报"未知 id"这种误导性错误）
    assert.equal(s.restore({ trashId: a.trashId }).error, 'payload-missing')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: purge 是唯一物理删除路径，且只认回收站内的合规 trashId', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const a = s.deleteDoc({ space: '研发资料', path: 'a.md' })
    const b = s.deleteDoc({ space: '研发资料', path: 'sub/b.md' })

    // 非法 id：形状没过白名单（`../`、绝对路径、乱码）→ 一律 bad-trash-id
    for (const bad of ['../../memory/personal', '..', '/etc', 'a/b', '', null, '123', '20260101-0000-AAAA']) {
      assert.equal(s.purge({ trashId: bad }).error, 'bad-trash-id', String(bad))
    }
    assert.equal(s.purge({ trashId: '20260101-0000-zzzz' }).error, 'unknown-trash-id')
    // 非法尝试之后磁盘必须毫发无损
    assert.equal(existsSync(join(home, 'memory', 'personal', 'workflow.md')), true)

    // 单条彻底删除
    const p1 = s.purge({ trashId: a.trashId })
    assert.equal(p1.ok, true)
    assert.equal(p1.purged, 1)
    assert.equal(p1.indexSync, 'unchanged')          // 回收站不在索引里 → 无需重建
    assert.equal(existsSync(join(trashRoot(home), a.trashId)), false)
    assert.equal(s.listTrash().count, 1)

    // 清空全部
    const p2 = s.purge({ all: true })
    assert.equal(p2.ok, true)
    assert.equal(p2.purged, 1)
    assert.equal(s.listTrash().count, 0)
    // 只剩台账文件，回收站被清空
    assert.deepEqual(readdirSync(trashRoot(home)).filter((n) => n !== 'index.json'), [])
    // 且**只**动了回收站：知识库目录与经验库都在（注意 a.md / sub/b.md 已被软删、
    // 本就该不在原位 —— 它们躺在回收站里，断言"还在原位"会把自己写成错的）
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料')), true)
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料', 'a.md')), false)
    assert.equal(existsSync(join(home, 'knowledge', 'spaces', '研发资料', '.space.json')), true)
    assert.equal(existsSync(join(home, 'memory', 'personal', 'workflow.md')), true)
    assert.equal(b.trashId !== a.trashId, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 台账损坏时 listTrash 返回空而不是崩（残留目录只报数、不列出）', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    const a = s.deleteDoc({ space: '研发资料', path: 'a.md' })
    // 台账被写坏（磁盘问题/手工编辑）
    writeFileSync(join(trashRoot(home), 'index.json'), '{ 这不是 JSON', 'utf-8')
    // 读不出来就返回空清单：宁可"看着没东西"也不能让整个知识库面板报错
    assert.equal(s.listTrash().count, 0)
    // 但条目目录还在磁盘上 → 计入 stray（如实报数，避免"回收站明明是空的却占着空间"）
    assert.equal(s.listTrash().stray, 1)
    // 台账坏了之后，凭 meta.json 仍能人工定位内容（这条是"冗余一份 meta"的价值所在）
    assert.equal(existsSync(join(trashRoot(home), a.trashId, 'meta.json')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: trashId 形状校验与生成（purge 的第一道闸）', () => {
  assert.equal(isTrashId('20260914-1630-ab12'), true)
  assert.equal(isTrashId('20260914-1630-AB12'), false)   // 只认小写
  assert.equal(isTrashId('2026-0914-1630-ab12'), false)
  assert.equal(isTrashId('../../x'), false)
  assert.equal(isTrashId(''), false)
  assert.equal(isTrashId(null), false)
  const taken = new Set()
  for (let i = 0; i < 50; i++) {
    const id = newTrashId((x) => taken.has(x))
    assert.ok(isTrashId(id), id)
    assert.equal(taken.has(id), false)
    taken.add(id)
  }
})

test('trash: 删条目后 indexSync 生效——同一 store 实例内立刻搜不到、树里也没有', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    assert.equal(s.getDocs().some((d) => d.rel === 'a.md'), true)
    s.deleteDoc({ space: '研发资料', path: 'a.md' })
    // 不重新 load，直接查：refreshAfterMutation 已经把索引重建过
    assert.equal(s.getDocs().some((d) => d.rel === 'a.md'), false)
    assert.equal(s.listTree({ space: '研发资料' }).length > 0, true)
    const treeRel = JSON.stringify(s.listTree({ space: '研发资料' }))
    assert.equal(treeRel.includes('a.md'), false)
    // 另一个实例（= 新进程/新请求）也必须一致
    assert.equal(openStore(home).getDocs().some((d) => d.rel === 'a.md'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('trash: 软删的残留清理——删过的空间重新建库后统计口径正确', () => {
  const home = mkHome()
  const s = openStore(home)
  try {
    assert.equal(s.getSpaces().find((x) => x.id === '研发资料').docCount, 2)
    s.deleteDoc({ space: '研发资料', path: 'a.md' })
    assert.equal(s.getSpaces().find((x) => x.id === '研发资料').docCount, 1)
    s.deleteSpace({ space: '研发资料', confirm: '研发资料' })
    assert.equal(s.getSpaces().some((x) => x.id === '研发资料'), false)
    // 还原后统计回到 1（不是 2 —— 那篇已删的文档在回收站里，不该被算进来）
    const last = s.listTrash().items.find((x) => x.kind === 'space')
    s.restore({ trashId: last.trashId })
    assert.equal(s.getSpaces().find((x) => x.id === '研发资料').docCount, 1)
    assert.equal(statSync(join(home, 'knowledge', 'spaces', '研发资料', 'sub', 'b.md')).isFile(), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
