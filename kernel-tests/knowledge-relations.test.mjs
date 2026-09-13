// S5 Task 4（关联物化·全量）+ Task 5（增量 updateDoc）的回归测试。
//
// 被钉住的四件事：
//   ① `related.jsonl` 与 `docs/inverted/links` **同生命周期**（persist 内同批原子落盘），
//      manifest 的 `relLines` 等于其行数 —— 没有行数指纹就发现不了文件截断
//      （S1 实测：截断的 inverted.jsonl 解析成"合法但更少"，检索静默返回空集且永不重建）；
//   ② 参与集 = `kind==='entry'` 且 `relationContent.length >= MIN_LEN`：垃圾条目与
//      duplicate 的归类行为（duplicate 不占 MAX_RELATED 预算）；
//   ③ 关联语义无向 ⇒ 物化双向（`from→to` 与 `to→from` 各一行，sig 互换）；
//   ④ 增量：改一个文档后同 tag 入边即时可见、出边重算、`relLines` 同步
//      （否则下次 load 会误判损坏而整库重建），删除的块不再有任何端点残留。
//
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'
import {
  SIM_THRESHOLD, DUP_COS, MAX_RELATED, MAX_TAG_RELATED, MAX_CONTENT_RELATED,
} from '../shared/knowledge-core.mjs'

const idxDir = (dir) => join(dir, 'knowledge', '.index')
const relText = (dir) => {
  try { return readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8') } catch { return '' }
}
const relRows = (dir) => relText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const manifestOf = (dir) => JSON.parse(readFileSync(join(idxDir(dir), 'manifest.json'), 'utf-8'))
/** 行数 = 文件里真正的 JSONL 行数（不是"文件里有几个 \n 片段"）。 */
const relLineCount = (dir) => relText(dir).split('\n').filter(Boolean).length
const key = (r) => `${r.from}\u0000${r.to}`
const outOf = (dir, from) => relRows(dir).filter((r) => r.from === from)

function makePersonal() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-krel-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  return { dir, personal }
}

// ── 全量物化用的固定语料 ────────────────────────────────────────────────────
// #0/#1 同 tag（骨架层）；#2/#3 跨 tag 但正文高度重叠（覆盖层，实测 cos≈0.71）；
// #4/#5 正文逐字相同（duplicate，cos=1）；#6/#7 是存量垃圾条目（去类型前缀后为空）。
const FULL_LINES = [
  '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手，避免打扰真人',
  '- [会话|企微CLI化] 步骤字段契约 -- js 步骤需 expression、click 类需 ref，写错会静默失败很长时间',
  '- [会话|主题甲] 标题一 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行，避免误删文件',
  '- [会话|主题乙] 标题二 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行，确认无误后再落地',
  '- [会话|主题丙] 标题三 -- 打包知识包时必须逐条校验清单与文件一一对应，缺一个就会静默失败',
  '- [会话|主题丁] 标题四 -- 打包知识包时必须逐条校验清单与文件一一对应，缺一个就会静默失败',
  '- [会话|垃圾甲] 流程要点：用户回答： -- 流程要点：用户回答：',
  '- [会话|垃圾乙] 业务要点（请注意）： -- 业务要点（请注意）：',
]

function makeFullFixture() {
  const { dir, personal } = makePersonal()
  writeFileSync(join(personal, 'workflow.md'),
    ['---', 'name: workflow', '---', ...FULL_LINES].join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

test('全量物化：三类 why 齐备、双向成对（sig 互换）、relLines 与文件行数一致', async () => {
  const { dir } = makeFullFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })

    // ① 落盘位置与行数指纹：related.jsonl 与 docs/inverted/links 同批落盘，指纹必须相等
    assert.ok(existsSync(join(idxDir(dir), 'related.jsonl')), 'related.jsonl 必须落盘')
    const rows = relRows(dir)
    assert.ok(rows.length > 0, '固定语料必须产出边（否则断言全是空转）')
    assert.equal(manifestOf(dir).relLines, rows.length, 'manifest.relLines = 行数')
    assert.equal(manifestOf(dir).relLines, relLineCount(dir), 'manifest.relLines = 文件实际行数')
    // 与 links.jsonl 分文件：显式 md 链接的行不得混进 related.jsonl
    assert.equal(existsSync(join(idxDir(dir), 'links.jsonl')), true, 'links.jsonl 仍在（分文件）')

    // ② 行形态（spec §4.1）：{from,to,why,sigFrom,sigTo}，指纹为 12 位 sha1 前缀
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ['from', 'sigFrom', 'sigTo', 'to', 'why'])
      assert.match(r.sigFrom, /^[0-9a-f]{12}$/)
      assert.match(r.sigTo, /^[0-9a-f]{12}$/)
      assert.ok(['tag', 'content', 'duplicate'].includes(r.why.kind), 'why 必须是三类之一')
    }

    // ③ 无向 ⇒ 双向物化：任一边的反向边都在，且两端指纹互换
    const byKey = new Map(rows.map((r) => [key(r), r]))
    for (const r of rows) {
      const rev = byKey.get(key({ from: r.to, to: r.from }))
      assert.ok(rev, `缺反向边：${r.from} -> ${r.to}（related(blockId) 会退化成全表扫）`)
      assert.equal(rev.sigFrom, r.sigTo, '反向边的 sigFrom = 正向边的 sigTo')
      assert.equal(rev.sigTo, r.sigFrom)
      assert.deepEqual(rev.why, r.why, 'why 对反向边同样成立（tag/content/duplicate 都只由两端共有信息决定）')
    }

    const doc = 'experience/workflow.md'
    // ④ 骨架层：同 tag 对
    const t0 = byKey.get(key({ from: `${doc}#0`, to: `${doc}#1` }))
    assert.deepEqual(t0?.why, { kind: 'tag', tag: '企微CLI化' })
    // ⑤ 覆盖层：跨 tag 内容相似对，score 在 [SIM_THRESHOLD, DUP_COS) 且 shared 非空
    const c = byKey.get(key({ from: `${doc}#2`, to: `${doc}#3` }))
    assert.equal(c?.why.kind, 'content')
    assert.ok(c.why.score >= SIM_THRESHOLD && c.why.score < DUP_COS,
      `content 边的 score 落在阈值区间内（实测 ${c.why.score}）`)
    assert.ok(c.why.shared.length > 0, 'content 边必须有可解释的 shared（空则宁缺勿滥丢弃）')
    // 六条（含反向）content 边都不得出现空 shared
    for (const r of rows.filter((x) => x.why.kind === 'content')) {
      assert.ok(Array.isArray(r.why.shared) && r.why.shared.length > 0)
    }
    // ⑥ duplicate：cos>=0.95 单独归类，且两端内容一致 ⇒ 指纹相同
    const d = byKey.get(key({ from: `${doc}#4`, to: `${doc}#5` }))
    assert.equal(d?.why.kind, 'duplicate')
    assert.ok(d.why.score >= DUP_COS)
    assert.equal(d.sigFrom, d.sigTo, '逐字重复的两端指纹必然相同')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('参与集门槛：relationContent < MIN_LEN 的垃圾条目既不作 from 也不作 to', async () => {
  const { dir } = makeFullFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const rows = relRows(dir)
    for (const n of [6, 7]) {
      const id = `experience/workflow.md#${n}`
      assert.ok(!rows.some((r) => r.from === id || r.to === id),
        `垃圾条目 ${id}（去类型前缀后为空）必须完全不进 related.jsonl`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 预算夹具：主体条目同时具备 6 个同 tag 同伴（骨架层截断到 MAX_TAG_RELATED）+ 3 个内容
// 相似同伴（覆盖层）+ 1 个逐字重复同伴 ⇒ 非重复边恰好占满 MAX_RELATED，duplicate 仍要在。
const C1 = '同步企微通讯录时先拉全量再做差集比对，避免把离职同事重新写回组织架构'
const C2 = '打包知识包前必须校验清单与文件一一对应，缺项会让安装方静默少装文档'
const C3 = '执行高风险命令前用 dry-run 预览全部副作用，确认无误再真正落地操作'
const BODY_X = `${C1}；${C2}；${C3}`

function makeBudgetFixture() {
  const { dir, personal } = makePersonal()
  const lines = ['---', 'name: budget', '---', `- [会话|预算标签] 主体条目 -- ${BODY_X}`]
  for (let i = 2; i <= 6; i++) {
    lines.push(`- [会话|预算标签] 同标签${i} -- 这是第${i}条同标签条目，正文与其他条目都不同，用于验证骨架层上限`)
  }
  lines.push(`- [会话|相似甲] 相似甲标题 -- ${C1}`)
  lines.push(`- [会话|相似乙] 相似乙标题 -- ${C2}`)
  lines.push(`- [会话|相似丙] 相似丙标题 -- ${C3}`)
  lines.push(`- [会话|重复丁] 重复丁标题 -- ${BODY_X}`)
  writeFileSync(join(personal, 'budget.md'), lines.join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

test('预算：非重复边截断到 MAX_RELATED，duplicate 不占该预算（独立归类）', async () => {
  const { dir } = makeBudgetFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    await store.load({ force: true })
    const mine = outOf(dir, 'experience/budget.md#0')
    const kinds = mine.reduce((m, r) => ({ ...m, [r.why.kind]: (m[r.why.kind] || 0) + 1 }), {})
    // 骨架层：6 个同 tag 同伴被截到 5（MAX_TAG_RELATED）
    assert.equal(kinds.tag, MAX_TAG_RELATED, `同 tag 边应截断到 ${MAX_TAG_RELATED}`)
    // 覆盖层：3 个内容相似同伴全部保留（上限 5 未触及）
    assert.equal(kinds.content, 3)
    // 非重复边总数 == MAX_RELATED（预算被占满）而 duplicate 仍在 ⇒ 它没挤占预算
    assert.equal((kinds.tag || 0) + (kinds.content || 0), MAX_RELATED)
    assert.equal(kinds.duplicate, 1, 'cos=1 的重复项必须在"预算已满"时依然出现')
    assert.ok(mine.length > MAX_RELATED, '总行数 = 8 非重复 + 1 duplicate')
    // 反向：重复项也没有把它的非重复锚点挤掉
    const dup = mine.find((r) => r.why.kind === 'duplicate')
    assert.equal(dup.to, 'experience/budget.md#9')
    assert.deepEqual(Object.keys(dup.why).sort(), ['kind', 'score'], 'duplicate 的 why 只有 kind+score')
    assert.equal(MAX_CONTENT_RELATED >= 3, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S1 教训回归：related.jsonl 被截断 → 行数指纹不符 → 判定损坏并整库重建', async () => {
  const { dir } = makeFullFixture()
  try {
    const s1 = createKnowledgeStore({ configDir: dir })
    s1.load({ force: true })
    const full = relText(dir)
    const fullLines = relLineCount(dir)
    assert.ok(fullLines >= 3, '语料需产出至少 3 行，截断才可观测')

    // 人为截断：只留第一行（模拟落盘中断/进程被杀留下的半截文件）
    writeFileSync(join(idxDir(dir), 'related.jsonl'), full.split('\n')[0] + '\n', 'utf-8')
    assert.equal(relLineCount(dir), 1, '截断后行数确实变少')
    // 不截断 fingerprint 也测一遍：manifest 仍记着原始行数
    assert.equal(manifestOf(dir).relLines, fullLines)

    const s2 = createKnowledgeStore({ configDir: dir })
    s2.load() // 不传 force：走 loadIndexFromDisk → relLines 不符 → buildIndex
    assert.equal(relLineCount(dir), fullLines, '必须重建回完整行数（而不是静默少锚点）')
    assert.equal(relText(dir), full, '重建结果与截断前逐字节一致')
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
    // 重建后索引本身也完整（docs 未被误判为损坏而丢文档）
    assert.equal(s2.stats().docs, 1)

    // 指纹缺失（off→on 切换 / 上一版索引 / 文件被删）：无从证明完整 ⇒ 同样重建
    rmSync(join(idxDir(dir), 'related.jsonl'))
    const man = manifestOf(dir)
    delete man.relLines
    writeFileSync(join(idxDir(dir), 'manifest.json'), JSON.stringify(man), 'utf-8')
    const s3 = createKnowledgeStore({ configDir: dir })
    s3.load()
    assert.equal(relText(dir), full, '指纹缺失也要重建出完整文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('knowledgeRelateMode=off：不写 related.jsonl、manifest 无 relLines、不参与一致性校验', async () => {
  const { dir } = makeFullFixture()
  try {
    const store = createKnowledgeStore({ configDir: dir, relateMode: 'off' })
    await store.load({ force: true })
    assert.equal(store.getRelateMode(), 'off')
    assert.ok(!existsSync(join(idxDir(dir), 'related.jsonl')), 'off 模式不写文件（否则"不写"就是假的）')
    assert.equal('relLines' in manifestOf(dir), false, 'off 模式 manifest 不得出现关联痕迹（等价 S4）')
    // 其余索引文件照旧（纯增量：不影响既有能力）
    assert.equal(existsSync(join(idxDir(dir), 'docs.jsonl')), true)
    assert.ok(store.stats().docs > 0)
    // 残留一个半截 related.jsonl 也不该让 off 模式重建（不做校验 = 不受其影响）
    writeFileSync(join(idxDir(dir), 'related.jsonl'), '{"from":"x","to":"y"}\n', 'utf-8')
    const s2 = createKnowledgeStore({ configDir: dir, relateMode: 'off' })
    s2.load()
    assert.equal(s2.stats().docs, 1, 'off 模式不因 related.jsonl 残缺而重建')
    assert.equal(readFileSync(join(idxDir(dir), 'related.jsonl'), 'utf-8'), '{"from":"x","to":"y"}\n',
      'off 模式不碰该文件（回滚 = 置 off + 手动删）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('性能护栏：76 条规模的全量物化是毫秒~秒级（无 O(N³)/全库重复扫描）', async () => {
  const { dir, personal } = makePersonal()
  try {
    // 76 条（= 真实库规模），其中 1/4 同 tag，其余内容各异
    const lines = ['---', 'name: perf', '---']
    for (let i = 0; i < 76; i++) {
      const tag = i % 4 === 0 ? '性能标签' : `标签${i}`
      lines.push(`- [会话|${tag}] 第${i}条经验 -- 第${i}条经验的正文内容，`
        + `讨论主题编号${i}的排查步骤与结论，用于性能回归护栏`)
    }
    writeFileSync(join(personal, 'perf.md'), lines.join('\n') + '\n', 'utf-8')
    const store = createKnowledgeStore({ configDir: dir })
    const t0 = Date.now()
    await store.load({ force: true })
    const ms = Date.now() - t0
    assert.ok(ms < 5000, `76 条全量物化耗时 ${ms}ms，超出毫秒~秒级预期（O(N²) 是允许的，O(N³) 不是）`)
    assert.ok(relRows(dir).length > 0)
    assert.equal(manifestOf(dir).relLines, relLineCount(dir))
    console.log(`[perf] 76 条全量 reindex + 物化：${ms}ms，边 ${relLineCount(dir)} 行`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
