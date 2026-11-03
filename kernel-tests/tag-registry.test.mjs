// S2-D6 回归网：标签实体化（独立实体 + 别名合并表 + 作用域 + 自动合并 + 可撤销）
// spec §6.2 D6（现状=三处裸字符串；目标=独立实体+别名合并表+作用域；**不做强制受控词表**）、
// §10 S2-5（"标签为独立实体，支持别名合并与个人/团队作用域"）、§14-4（用户裁定 📌#4 = **自动合并 + 可撤销**）。
//
// 覆盖四层：
//   ① 纯逻辑：归一 / 实体 / 确定性 id / 别名链 / 环安全 / 作用域隔离 / 自动合并 / 撤销逐字还原
//   ② 落盘：**真读磁盘文件**断言（沿用 D4 教训：断言"文件里真的有"，而不是"函数算出来了"）
//   ③ 健壮性：缺文件、损坏文件（读侧降级 vs 写侧拒绝覆盖）
//   ④ 接入：知识标签枚举与经验标签枚举在**传解析器**时折叠别名，**不传时与今日逐字一致**（零回归）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTagRegistry, normalizeTagName, tagId, ensureTag, findTag, resolveTagName, resolveTagNames,
  mergeTag, undoMerge, listTags, tagRegistryView, DEFAULT_TAG_SCOPE,
} from '../shared/tag-registry.mjs'
import {
  tagRegistryPath, loadTagRegistry, saveTagRegistry, syncTagNames,
  mergeTagsInStore, undoMergeInStore, tagRegistrySnapshot, makeTagResolver,
} from '../kernel/tag-store.mjs'
import { createKnowledgeStore, knowledgeRoot } from '../kernel/knowledge.mjs'
import { memoryRoot, listMemoryTags, appendMemoryEntry } from '../kernel/memory.mjs'

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60) }
  }
}

// ---------------------------------------------------------------------------
// ① 归一：与渲染层 src/lib/knowledgeTags.ts 的 normalizeTag 同规则
//    （同规则由 src/lib/tagRegistryParity.test.ts 做逐例 parity 钉住）
// ---------------------------------------------------------------------------
test('归一：去前导 #、合并连续 /、去首尾 /、空 → null（与渲染层同规则）', () => {
  assert.equal(normalizeTagName('#财务'), '财务')
  assert.equal(normalizeTagName('###财务'), '财务')
  assert.equal(normalizeTagName('  财务  '), '财务')
  assert.equal(normalizeTagName(' a//b/ '), 'a/b')
  assert.equal(normalizeTagName('//a///b//'), 'a/b')
  assert.equal(normalizeTagName('财务部/'), '财务部')
  // 空 → null（不是空串）：否则会有一个"看不见的标签"混进集合与计数
  assert.equal(normalizeTagName('   '), null)
  assert.equal(normalizeTagName(''), null)
  assert.equal(normalizeTagName(null), null)
  assert.equal(normalizeTagName('#'), null)
})

// ---------------------------------------------------------------------------
// ② 实体：确定性 id + 幂等 + 撞别名即同一实体
// ---------------------------------------------------------------------------
test('实体：id 由 scope+name 确定性派生（跨机同 id），同 scope 同名=同实体，异 scope=异实体', () => {
  // 确定性 id：① 同参两次调用必相同；② 不同 scope 必不同（作用域隔离的根）
  assert.equal(tagId('personal', '财务'), tagId('personal', '财务'))
  assert.notEqual(tagId('personal', '财务'), tagId('team', '财务'))
  assert.match(tagId('personal', '财务'), /^tag-[0-9a-f]{12}$/)

  const reg = createTagRegistry()
  const a = ensureTag(reg, '#财务')
  const b = ensureTag(reg, ' 财务 ')
  assert.equal(a, b, '同一标签的不同写法必须落到同一实体（否则别名表白建）')
  assert.equal(reg.tags.length, 1, '幂等：不得因重复注册而长出第二个实体')
  assert.equal(a.scope, DEFAULT_TAG_SCOPE, '缺省作用域 = personal（§5.9 L1 恒个人）')

  // 撞别名 = 同一实体
  const reg2 = createTagRegistry()
  ensureTag(reg2, '财务')
  mergeTag(reg2, '财务部', '财务')
  const hit = ensureTag(reg2, '财务部')
  assert.equal(hit.name, '财务', '注册一个已知别名时应返回其规范实体，而不是新建')

  // 无效标签 → null（调用方据此跳过，不产生空实体）
  assert.equal(ensureTag(createTagRegistry(), '   '), null)
})

// ---------------------------------------------------------------------------
// ③ 作用域隔离（§5.9：个人 / 团队）
// ---------------------------------------------------------------------------
test('作用域：同名标签在 personal 与 team 是两个实体；personal 的合并不影响 team', () => {
  const reg = createTagRegistry()
  ensureTag(reg, '财务', { scope: 'personal' })
  ensureTag(reg, '财务', { scope: 'team' })
  assert.equal(reg.tags.length, 2, '同名异 scope 必须是两个实体')

  mergeTag(reg, '财务部', '财务', { scope: 'personal' })
  assert.equal(resolveTagName(reg, '财务部', { scope: 'personal' }), '财务', 'personal 内已合并')
  assert.equal(resolveTagName(reg, '财务部', { scope: 'team' }), '财务部', 'team 内不得受影响（别名不跨作用域）')
  assert.equal(findTag(reg, '财务部', { scope: 'team' }), null)
  // 视图也按 scope 切
  assert.equal(tagRegistryView(reg, { scope: 'personal' }).total, 1)
  assert.equal(tagRegistryView(reg, { scope: 'team' }).total, 1)
  assert.equal(tagRegistryView(reg, { scope: 'team' }).merges.length, 0)
  // 未知 scope 明确报错（不静默当成 personal）
  assert.throws(() => ensureTag(reg, 'x', { scope: 'nope' }), /未知标签作用域/)
})

// ---------------------------------------------------------------------------
// ④ 自动合并（无审核即生效）+ 别名链 + 环安全 + 不做受控词表
// ---------------------------------------------------------------------------
test('自动合并：无审核即生效；链式携带别名；快照可撤销；不做受控词表', () => {
  const reg = createTagRegistry()
  const r = mergeTag(reg, '财务部', '财务')
  assert.equal(r.ok, true, '合并应直接生效（用户裁定 #4：不设人工审核环节）')
  assert.equal(r.into, '财务')
  assert.equal(reg.tags.length, 1, '被吸收实体应从实体表移除')
  assert.deepEqual(reg.tags[0].aliases, ['财务部'])
  assert.equal(resolveTagName(reg, '财务部'), '财务')
  assert.equal(reg.merges.length, 1, '必须留下撤销凭据')
  assert.equal(reg.merges[0].snapshot.name, '财务部', '凭据里要有被吸收实体的快照')

  // 别名整体跟随：C→A 之后把 A→B，C 必须仍能解析到 B。
  // 注：本实现把别名**扁平化**（合并时把源实体自己的 aliases 一并并入目标）⇒ 解析恒为**单跳**，
  // 这里的断言正是钉住"扁平化没漏掉源实体原有的别名"（漏掉则 C 会解析失败）。
  // `resolveTagName` 里保留 while 链循环属**防御性兜底**（外部手改坏注册表时不至于解析错/死循环）。
  const reg2 = createTagRegistry()
  mergeTag(reg2, 'c', 'a')          // a.aliases = [c]
  mergeTag(reg2, 'a', 'b')          // b.aliases = [a, c]
  assert.equal(resolveTagName(reg2, 'c'), 'b', '别名链必须整体跟到新的规范实体')
  assert.equal(resolveTagName(reg2, 'a'), 'b')
  assert.deepEqual(resolveTagNames(reg2, ['c', 'a', 'b', 'c']), ['b'], '批量解析应折叠去重')

  // 不做受控词表：未注册标签原样通过（注册表是"认识表"，不是准入闸门）
  assert.equal(resolveTagName(reg, '从未见过的标签'), '从未见过的标签')
  const reg3 = createTagRegistry()
  const r3 = mergeTag(reg3, '甲', '乙')
  assert.equal(r3.ok, true, '两侧都未注册也应可合并（自动入册）')
  assert.equal(reg3.tags.length, 1)

  // 无效输入明确报错（不静默成功）
  assert.equal(mergeTag(reg3, '', '乙').reason, 'empty-tag')
  assert.equal(mergeTag(reg3, '乙', '乙').reason, 'same-tag')
  assert.equal(mergeTag(reg3, '乙', '   ').reason, 'empty-tag')
})

test('环安全：A→B 后再 B→A 必须被拒（既不静默、也不死循环）', () => {
  const reg = createTagRegistry()
  assert.equal(mergeTag(reg, 'a', 'b').ok, true)
  const again = mergeTag(reg, 'b', 'a')
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already-merged', '反向合并等价于"它们已经是同一个"，应明确拒绝')
  // 解析不因被拒而进入死循环
  assert.equal(resolveTagName(reg, 'a'), 'b')

  // 源是"别处的别名"：提示改用其规范名（不擅自一次改动两个实体）
  const reg2 = createTagRegistry()
  mergeTag(reg2, 'a', 'b')
  const r = mergeTag(reg2, 'a', 'c')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'source-is-alias')
  assert.match(r.message, /b/, '报错应指出规范名，便于调用方重发')
})

// ---------------------------------------------------------------------------
// ⑤ 撤销：逐字还原
// ---------------------------------------------------------------------------
test('撤销：逐字还原被吸收实体（含自身别名与 createdAt），并从目标剥回别名', () => {
  const reg = createTagRegistry()
  ensureTag(reg, 'c')
  mergeTag(reg, 'c', 'a')                       // a.aliases=[c]
  const before = JSON.parse(JSON.stringify(findTag(reg, 'a')))
  const m = mergeTag(reg, 'a', 'b')             // b.aliases=[a,c]
  assert.deepEqual(findTag(reg, 'b').aliases.sort(), ['a', 'c'])

  const u = undoMerge(reg, m.mergeId)
  assert.equal(u.ok, true)
  assert.deepEqual(findTag(reg, 'a'), before, '还原必须逐字一致（name/id/aliases/createdAt）')
  assert.deepEqual(findTag(reg, 'b').aliases, [], '目标实体的别名应被剥回')
  assert.equal(resolveTagName(reg, 'a'), 'a', '撤销后解析回到合并前状态')
  assert.equal(resolveTagName(reg, 'c'), 'a', '链上的别名也回到原实体')

  // 重复撤销 / 未知 id 明确报错
  assert.equal(undoMerge(reg, m.mergeId).reason, 'already-undone')
  assert.equal(undoMerge(reg, 'mrg-9999').reason, 'not-found')
  // 合并记录保留并记 undoneAt：撤销是"可追溯的反向操作"，不是抹掉历史
  const rec = reg.merges.find((x) => x.id === m.mergeId)
  assert.ok(rec.undoneAt, '撤销后应留下时间戳（审计可解释"这个标签曾为何消失"）')
})

// ---------------------------------------------------------------------------
// ⑥ 落盘：真读文件
// ---------------------------------------------------------------------------
test('落盘实据：合并与撤销真的写进 <configDir>/tags/registry.json（读文件断言）', () => {
  const configDir = tmp('yfw-d6-store-')
  try {
    const p = tagRegistryPath(configDir)
    assert.equal(loadTagRegistry(configDir).tags.length, 0, '全新安装：缺文件应得空注册表而非报错')

    const r = mergeTagsInStore(configDir, '财务部', '财务')
    assert.equal(r.ok, true)
    const text = readFileSync(p, 'utf-8')
    assert.match(text, /"name": "财务"/, '实体必须真的落盘')
    assert.match(text, /"财务部"/, '别名必须真的落盘')
    assert.match(text, /"merges"/, '撤销凭据必须真的落盘')

    // 解析器（生产接线用的形态）
    const resolve = makeTagResolver({ configDir })
    assert.equal(resolve('财务部'), '财务')
    assert.equal(resolve('无关标签'), '无关标签')

    const snap = tagRegistrySnapshot(configDir)
    assert.equal(snap.total, 1)
    assert.equal(snap.merges.length, 1)

    // 撤销落盘
    assert.equal(undoMergeInStore(configDir, r.mergeId).ok, true)
    const after = JSON.parse(readFileSync(p, 'utf-8'))
    assert.ok(after.merges[0].undoneAt)
    assert.deepEqual(after.tags.map((t) => t.name).sort(), ['财务', '财务部'], '撤销后两个实体都应在盘上')

    // 批量入册：有新增才写盘
    const s1 = syncTagNames(configDir, ['甲', '乙', '财务'])
    assert.deepEqual(s1.created.sort(), ['乙', '甲'].sort())
    assert.equal(syncTagNames(configDir, ['甲', '乙', '财务']).created.length, 0, '已有标签不得重复入册')
  } finally { cleanup(configDir) }
})

test('健壮性：损坏的注册表——读侧降级为空表，写侧拒绝覆盖（不静默毁数据）', () => {
  const configDir = tmp('yfw-d6-corrupt-')
  try {
    const p = tagRegistryPath(configDir)
    mkdirSync(join(configDir, 'tags'), { recursive: true })
    writeFileSync(p, '{ 这不是合法 JSON', 'utf-8')

    // 读侧：降级 → 别名暂不生效，但主链路（索引/记忆枚举）仍能跑
    assert.equal(loadTagRegistry(configDir).tags.length, 0)
    // 写侧：拒绝，且**不得**把损坏内容覆盖成空表
    assert.throws(() => loadTagRegistry(configDir, { strict: true }), /已损坏，拒绝覆盖/)
    assert.throws(() => mergeTagsInStore(configDir, 'a', 'b'), /已损坏，拒绝覆盖/)
    assert.equal(readFileSync(p, 'utf-8'), '{ 这不是合法 JSON', '损坏文件必须原样保留，供人工恢复')
  } finally { cleanup(configDir) }
})

// ---------------------------------------------------------------------------
// ⑦ 接入：知识 / 经验（传解析器时折叠；不传时逐字不变 = 零回归）
// ---------------------------------------------------------------------------
function writeSpaceDoc(configDir, spaceId, rel, content) {
  const dir = join(knowledgeRoot(configDir), 'spaces', spaceId)
  mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
  writeFileSync(join(dir, rel), content, 'utf-8')
}

test('接入·知识：listIndexTags 传解析器时别名折叠；不传时与今日一致（零回归）', () => {
  const configDir = tmp('yfw-d6-kb-')
  try {
    writeSpaceDoc(configDir, 'demo', 'a.md', '---\ntags: [财务部]\n---\n\n# A\n\n正文\n')
    writeSpaceDoc(configDir, 'demo', 'b.md', '---\ntags: [财务]\n---\n\n# B\n\n正文\n')

    const store = createKnowledgeStore({ configDir })
    store.load({ force: true }) // 建索引：createKnowledgeStore 不自动建，load 是唯一入口（冷启动时内部变量为空）
    // 不传解析器 ⇒ 今日行为：两个标签各占一行
    const raw = store.listIndexTags({})
    assert.deepEqual(raw.tags.map((t) => t.tag).sort(), ['财务', '财务部'], '不传解析器时输出必须与今日一致')

    // 传解析器 ⇒ 别名折叠：只剩规范名一行、计数合并
    mergeTagsInStore(configDir, '财务部', '财务')
    const merged = store.listIndexTags({ tagResolver: makeTagResolver({ configDir }) })
    assert.deepEqual(merged.tags.map((t) => t.tag), ['财务'], '合并后应只剩规范名（否则"合并了却仍显示两个"）')
    assert.equal(merged.tags[0].count, 2, '计数应合并到规范实体上')
    assert.deepEqual(merged.tags[0].spaceId, 'demo', '同空间内折叠时 spaceId 应保留（既有"跨空间才置 null"口径不变）')
  } finally { cleanup(configDir) }
})

test('接入·经验：listMemoryTags 传解析器时别名折叠；不传时不变；经验行本身不被改写', () => {
  const configDir = tmp('yfw-d6-mem-')
  try {
    const root = memoryRoot(configDir)
    appendMemoryEntry({ root, theme: 'demo', tag: '财务部', summary: '摘要内容足够长以通过最小长度校验', full: '全文内容同样需要足够长以通过最小长度校验的要求' })
    appendMemoryEntry({ root, theme: 'demo', tag: '财务', summary: '第二条摘要内容同样足够长以通过校验', full: '第二条全文内容同样足够长以通过校验的要求' })

    const raw = listMemoryTags(configDir)
    assert.deepEqual(raw.tags.map((t) => t.tag).sort(), ['财务', '财务部'], '不传解析器时输出必须与今日一致')

    mergeTagsInStore(configDir, '财务部', '财务')
    const merged = listMemoryTags(configDir, { tagResolver: makeTagResolver({ configDir }) })
    assert.deepEqual(merged.tags.map((t) => t.tag), ['财务'])
    assert.equal(merged.tags[0].count, 2)

    // 用户数据不被改写：条目标题里的原始写法保持原样
    const text = readFileSync(join(root, 'demo.md'), 'utf-8')
    assert.match(text, /财务部/, '经验行不得被改写（D6 只做解析，不动用户文件）')
  } finally { cleanup(configDir) }
})
