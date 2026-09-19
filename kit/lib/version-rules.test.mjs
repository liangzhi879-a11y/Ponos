// kit/lib/version-rules.test.mjs —— V1–V8′ 每条规则的正例/反例
//
// fixture 造的是「最小但结构完整」的仓：只写进 mkdtemp，不依赖本机磁盘特定状态
// （CI 无 scratch/ release/），files 显式传入 → 不依赖 git ls-files。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runVersionRules } from './version-rules.mjs'

/** 造一个"最小但结构完整"的仓：能同时喂给 V1–V8′ */
function fixture(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-kit-'))
  const w = (rel, content) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content) }
  const skill = '---\nname: demo\nversion: "1.0.0"\n---\n\n正文\n'
  w('version.mjs', "export const APP_VERSION = 'dev 3.0.0'\nexport const KERNEL_VERSION = 'dev 0.2'\nexport const SCHEMA_VERSION = 1\n")
  w('kernel/package.json', '{ "version": "0.2.0" }')
  w('package.json', '{ "version": "2.8.0" }')
  w('k/c.mjs', 'export const INDEX_VERSION = 4\n')
  w('public/skills.json', JSON.stringify([{ id: 'demo', version: '1.0.0' }]))
  w('public/sample-skills/demo/SKILL.md', skill)
  const lockHash = createHash('sha256').update(Buffer.from(skill)).digest('hex')
  w('skills-lock.json', JSON.stringify({ version: 1, skills: { demo: { source: 'x/y', computedHash: lockHash } } }))
  w('public/sample-skills/_common/_common_manifest.json', JSON.stringify({ tools: { 'old.py': { current_version: '1.0.0' } } }))
  w('public/sample-skills/_common/old.py', 'print(1)\n')
  const files = ['version.mjs', 'kernel/package.json', 'package.json', 'k/c.mjs', 'public/skills.json',
    'public/sample-skills/demo/SKILL.md', 'skills-lock.json',
    'public/sample-skills/_common/_common_manifest.json', 'public/sample-skills/_common/old.py']
  const versions = {
    version: 1,
    exclude: [],
    history: { baselineCount: 0, commonToolsBaseline: 1, records: [] },
    lines: [
      { id: 'APP_VERSION', value: 'dev 3.0.0', file: 'version.mjs', locator: { kind: 'const', name: 'APP_VERSION' } },
      { id: 'KERNEL_VERSION', value: 'dev 0.2', file: 'version.mjs', locator: { kind: 'const', name: 'KERNEL_VERSION' },
        mirrorValue: '0.2.0' },
      { id: 'GUI_VERSION', value: '2.8.0', file: 'package.json', locator: { kind: 'json', path: 'version' } },
      { id: 'KB_SCHEMA_VERSION', value: 1, file: 'version.mjs', locator: { kind: 'const', name: 'SCHEMA_VERSION' } },
    ],
    contracts: [
      { id: 'INDEX_VERSION', value: 4, file: 'k/c.mjs', locator: { kind: 'const', name: 'INDEX_VERSION' } },
    ],
    skills: [{ id: 'demo', value: '1.0.0', frontmatterVersion: '1.0.0', file: 'public/sample-skills/demo/SKILL.md' }],
    skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: ['demo'] },
    commonTools: { baseline: ['old.py'], addedSinceBaseline: [], entries: [{ file: 'public/sample-skills/_common/old.py', version: '1.0.0', versionSource: 'manifest' }] },
    channels: {},
  }
  return { root, files, versions: { ...versions, ...over } }
}

const rulesOf = (findings) => findings.map((f) => f.rule)
const redOf = (findings, rule) => findings.filter((f) => f.rule === rule && f.severity === 'red')

test('基线（全绿）：完整台账 + 一致宿主 → 无红灯', () => {
  const { root, files, versions } = fixture()
  const { findings, checks } = runVersionRules({ root, versions, files })
  assert.deepEqual(redOf(findings, 'V1'), [])
  assert.deepEqual(redOf(findings, 'V6'), [])
  assert.deepEqual(redOf(findings, 'V7'), [])
  assert.deepEqual(redOf(findings, 'V8'), [])
  assert.ok(checks.length >= 8)
})

// V1 反例：手改宿主文件的值
test('V1 反例：宿主文件值被改 → 红，并给出 file 与期望/实际', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'k/c.mjs'), 'export const INDEX_VERSION = 5\n')
  const { findings } = runVersionRules({ root, versions, files })
  const hits = redOf(findings, 'V1')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].file, 'k/c.mjs')
  assert.equal(hits[0].expected, '4')
  assert.equal(hits[0].actual, '5')
})

// V1 反例：宿主文件被删（解析不到）
test('V1 反例：宿主文件不存在 → 红（不是静默跳过）', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, contracts: [...versions.contracts, { id: 'GONE_VERSION', value: 1, file: 'nope.mjs', locator: { kind: 'const', name: 'GONE_VERSION' } }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.ok(redOf(findings, 'V1').some((f) => f.subject.includes('GONE_VERSION')))
})

// V1b 反例：台账键重复
test('V1b 反例：同一 id@file 出现两次 → 红', () => {
  const { root, files, versions } = fixture()
  const dup = { ...versions.contracts[0] }
  const v = { ...versions, contracts: [...versions.contracts, dup] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V1b').length, 1)
})

// V4 反例：dev X.Y ↔ X.Y.0 映射被破坏
test('V4 反例：内核线映射不一致 → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, lines: versions.lines.map((l) => l.id === 'KERNEL_VERSION' ? { ...l, mirrorValue: '0.3.0' } : l) }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V4').length, 1)
})

// V5 反例：data-schema 缺迁移说明
test('V5 反例：kind=data-schema 却没有 migrationNote → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, contracts: [{ ...versions.contracts[0], kind: 'data-schema', migrationNote: '' }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V5').length, 1)
})

// V6 反例：三处技能版本不一致
test('V6 反例：SKILL.md 与 skills.json 不一致 → 红', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.1.0"\n---\n\n正文\n')
  const { findings } = runVersionRules({ root, versions, files })
  assert.equal(redOf(findings, 'V6').length, 1)
})

// V7 反例（本次真实欠账 A7）：lock 哈希不符
test('V7 反例：SKILL.md 被改 → 哈希不符红；并提示跑 kit:sync', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')
  const { findings } = runVersionRules({ root, versions, files })
  const hits = redOf(findings, 'V7')
  assert.equal(hits.length, 1)
  assert.match(hits[0].hint, /kit:sync/)
})

// ★ 防自证：即便台账被"sync 式"重写成与文件一致，V7 仍必须红（判据是 lock 文件，不是台账）
test('V7 防自证：台账里塞入"正确"哈希也不影响判定（判据恒为 skills-lock.json）', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/demo/SKILL.md'), '---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')
  const tampered = { ...versions, skillsLock: { source: 'skills-lock.json', field: 'computedHash', ids: ['demo'],
    sha256: createHash('sha256').update(Buffer.from('---\nname: demo\nversion: "1.0.0"\n---\n\n被改了\n')).digest('hex') } }
  const { findings } = runVersionRules({ root, versions: tampered, files })
  assert.equal(redOf(findings, 'V7').length, 1, '台账里的哈希不参与判定 —— 否则跑一次 sync 就能把门禁刷绿')
})

// V8 反例：台账记了不存在的文件
test('V8 反例：台账 entries 含不存在的 .py → 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, commonTools: { ...versions.commonTools, entries: [...versions.commonTools.entries, { file: 'public/sample-skills/_common/ghost.py', version: null, versionSource: 'unmarked' }] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V8').length, 1)
})

// V8b 反例：新增 .py 没登记
test('V8b 反例：实有 .py 未在台账登记 → 红', () => {
  const { root, files, versions } = fixture()
  writeFileSync(join(root, 'public/sample-skills/_common/new.py'), 'print(2)\n')
  const { findings } = runVersionRules({ root, versions, files: [...files, 'public/sample-skills/_common/new.py'] })
  assert.equal(redOf(findings, 'V8b').length, 1)
})

// V8b 反向（双向性）：实有 ⊆ 台账 时不得乱报 —— 否则"防漏登记"会退化成"永远红"
test('V8b 反向：实有 .py 全部已登记 → 无红（与 V8 反例互补，构成双向闭合）', () => {
  const { root, files, versions } = fixture()
  const { findings } = runVersionRules({ root, versions, files })
  assert.deepEqual(redOf(findings, 'V8b'), [])
})

// V8' 正例/反例（spec §5.4 的关键护栏）
test("V8' ：存量 .py 免标版本；**新增** .py 必须标版本或显式登记 null", () => {
  const { root, files, versions } = fixture()
  const added = 'public/sample-skills/_common/added.py'
  writeFileSync(join(root, added), 'print(3)\n')
  const f2 = [...files, added]
  const withNull = { ...versions, commonTools: { baseline: ['old.py'], addedSinceBaseline: ['added.py'],
    entries: [...versions.commonTools.entries, { file: added, version: null, versionSource: 'unmarked' }] } }
  assert.equal(redOf(runVersionRules({ root, versions: withNull, files: f2 }).findings, "V8'").length, 1,
    '新增文件登记 null 仍须红（V8′ 的作用就是逼新文件自证版本）')
  const withVer = { ...versions, commonTools: { baseline: ['old.py'], addedSinceBaseline: ['added.py'],
    entries: [...versions.commonTools.entries, { file: added, version: '1.0.0', versionSource: 'inline' }] } }
  assert.equal(redOf(runVersionRules({ root, versions: withVer, files: f2 }).findings, "V8'").length, 0)
})

// V8' 反向（双向性）：存量 98 个免标版本 —— 若把 baseline 豁免写丢，存量必须被判红（不是"永远绿"）
test("V8' 反向：baseline 里的存量 .py 即使 version=null 也不得红（存量豁免口径）", () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, commonTools: { baseline: ['old.py'], addedSinceBaseline: [],
    entries: [{ file: 'public/sample-skills/_common/old.py', version: null, versionSource: 'unmarked' }] } }
  const findings = runVersionRules({ root, versions: v, files }).findings
  assert.deepEqual(redOf(findings, "V8'"), [])
  // 同时确认该 .py 是"实有且已登记"的 → V8/V8b 都不红（避免用 V8b 污染本断言）
  assert.deepEqual(redOf(findings, 'V8'), [])
  assert.deepEqual(redOf(findings, 'V8b'), [])
})

// V3：历史链
//
// ★ 与 brief 原文的差异（已记录）：brief 的反例数据 `{from:3,to:4}` + `{from:9,to:5}` 会**同时**
//   触发两条判据（链断裂 9≠4、末条 5≠当前值 4），实测红 2 条而非 1 条。故把反例拆成两个用例，
//   每个用例只让**一条**判据成立 —— 否则 `assert.equal(…, 1)` 只是"总数为 1"的巧合，
//   无法指出是哪条判据失效（断言仍具约束力，见变异测试）。
test('V3 反例：历史链断裂（from ≠ 前一条 to）→ 红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, history: { baselineCount: 0, commonToolsBaseline: 1, records: [
    { key: 'INDEX_VERSION@k/c.mjs', from: 3, to: 4, at: '2026-09-18' },
    // 断裂：9 ≠ 4；末条 to=4 与当前值一致 → 隔离出"链断裂"这一条判据
    { key: 'INDEX_VERSION@k/c.mjs', from: 9, to: 4, at: '2026-09-19' },
  ] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V3').length, 1)
})

test('V3 反例：末条 to ≠ 当前值 → 红（防静默降级）', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, history: { baselineCount: 0, commonToolsBaseline: 1, records: [
    // 链本身连续（单条），但记账停在 3、宿主文件已是 4 → 值被改过却没留记录
    { key: 'INDEX_VERSION@k/c.mjs', from: 4, to: 3, at: '2026-09-18' },
  ] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V3').length, 1)
  assert.deepEqual(redOf(findings, 'V1'), [], 'V1 必须绿 —— 否则本用例的红可能来自 V1 而非 V3 的末条判据')
})

test('V3 正例：链条连续且末条 to == 当前值 → 无红', () => {
  const { root, files, versions } = fixture()
  const v = { ...versions, history: { baselineCount: 0, commonToolsBaseline: 1, records: [
    { key: 'INDEX_VERSION@k/c.mjs', from: 3, to: 4, at: '2026-09-18' },
  ] } }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.deepEqual(redOf(findings, 'V3'), [])
})

test('V2：line 的宿主文件必须已入库（判据是 git 已跟踪，不是磁盘存在）', () => {
  const { root, files, versions } = fixture()
  // ★ 该文件"在磁盘上存在且能解析"，但**未入库** → V2 仍须红。
  //   若 V2 写成 existsSync(磁盘)，本用例就绿了 —— 正是 I2（扫描域 = git ls-files）要挡的：
  //   gitignored 的 scratch/ 里恰好存在的文件不能冒充"已入库的版本载体"。
  writeFileSync(join(root, 'untracked.mjs'), 'export const X_VERSION = 1\n')
  const v = { ...versions, lines: [...versions.lines, { id: 'X_VERSION', value: 1, file: 'untracked.mjs', locator: { kind: 'const', name: 'X_VERSION' } }] }
  const { findings } = runVersionRules({ root, versions: v, files })
  assert.equal(redOf(findings, 'V2').length, 1)
  assert.deepEqual(redOf(findings, 'V1'), [], 'V1 必须绿 —— 证明 V2 的红来自"未入库"而非"解析失败"')
})
