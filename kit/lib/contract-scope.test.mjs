// kit/lib/contract-scope.test.mjs —— 契约范围登记（T8）
//
// 本文件钉住"防一条通配放行一切"的四道闸（plan §5），每条都能独立失败：
//   ① `ns`/`members` 禁 `*` 与正则字符（写了即红 —— 有问题的条目**失效**并报 CT4C）；
//   ② `members` 与代码真值**集合相等**（多一少一都红）；
//   ③ 命中判定只用 `keyOf` **精确 tuple** —— 源码级断言：本模块不得出现 `startsWith`/`includes`/正则
//      做匹配（否则"前缀/子串放行"会悄悄回来）；
//   ④ `members` 必须**人工编辑**：`kit:sync` 禁止写 `contract-scope.json`（判据在 kit/cli.test.mjs
//      的"sync 前后逐字节不变"）；本文件的 `loadScope` 是**只读**的（无任何写函数导出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScope, checkScopeSets, contractGrowth, keyOf, SCOPE_FILE, SCOPE_KINDS } from './contract-scope.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function writeScope(entries, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yfw-scope-'))
  mkdirSync(join(root, 'kit/manifest'), { recursive: true })
  writeFileSync(join(root, SCOPE_FILE), JSON.stringify({ version: 1, entries, ...extra }, null, 2))
  return root
}
const entry = (o = {}) => ({ kind: 'routes', ns: '/knowledge', members: ['GET /knowledge/a'], docSection: '§7', reason: '文档 §7 只声明 4 条，其余零声明', at: '2026-09-19', ...o })
const truth = (o = {}) => ({ routes: ['GET /knowledge/a'], wsOut: [], wsIn: [], ipc: [], tools: [], doc: [], ...o })
/** 只取某一规则的 findings（subject/severity 便于逐条断言） */
const byRule = (out, rule) => out.findings.filter((f) => f.rule === rule)

test('keyOf：精确 tuple（同名前缀/子串不得相撞）', () => {
  assert.equal(keyOf('routes', 'GET /x'), JSON.stringify(['routes', 'GET /x']))
  assert.notEqual(keyOf('routes', 'GET /x'), keyOf('routes', 'GET /x/y'))
  assert.notEqual(keyOf('routes', 'GET /x'), keyOf('wsOut', 'GET /x'))
})

test('★反例②：本模块源码不得出现 startsWith/includes/正则 做匹配（只用 keyOf 精确 tuple）', () => {
  const src = readFileSync(join(HERE, 'contract-scope.mjs'), 'utf8')
  for (const bad of ['.startsWith(', '.includes(', 'new RegExp', 'RegExp(']) {
    assert.equal(src.includes(bad), false, `contract-scope.mjs 不得出现 ${bad}（匹配只允许 keyOf 精确 tuple）`)
  }
  assert.equal(src.includes('export function writeScope'), false, '本模块不得导出写函数（scope 只能人工编辑）')
})

test('loadScope：读人工登记文件；缺文件 → present:false、entries 空（由 CT4 报红，不静默）', () => {
  const root = writeScope([entry()])
  const s = loadScope({ root })
  assert.equal(s.present, true)
  assert.equal(s.entries.length, 1)
  assert.deepEqual(s.entries[0].members, ['GET /knowledge/a'])
  assert.deepEqual(s.entries[0].problems, [])
  const empty = mkdtempSync(join(tmpdir(), 'yfw-scope-empty-'))
  assert.equal(loadScope({ root: empty }).present, false)
  assert.deepEqual(loadScope({ root: empty }).entries, [])
  assert.equal(SCOPE_FILE, 'kit/manifest/contract-scope.json')
})

test('★反例②：ns/members 写了 `*` 或正则字符 → 条目**失效**并报 CT4C（缺 reason 同判）', () => {
  const root = writeScope([
    entry({ ns: '/knowledge/*', members: ['GET /knowledge/a'] }),
    entry({ ns: '/api', members: ['GET /api/.*'] }),
    entry({ ns: '/team', members: ['GET /team/a'], reason: '   ' }),
    entry({ ns: '/logs', members: [], reason: '空成员但理由真实' }),
  ])
  const s = loadScope({ root })
  assert.equal(s.entries[0].problems.length > 0, true, 'ns 含通配必须有问题')
  assert.equal(s.entries[1].problems.length > 0, true, 'member 含正则字符必须有问题')
  assert.equal(s.entries[2].problems.length > 0, true, '缺 reason 必须有问题')
  assert.deepEqual(s.entries[3].problems, [], '空 members 本身不违规（空命名空间要能登记）')
  const out = checkScopeSets({ scope: s, truth: truth({ routes: ['GET /knowledge/a', 'GET /api/x', 'GET /team/a'] }) })
  assert.equal(byRule(out, 'CT4C').length, 3, `三条坏条目各报一条 CT4C，实测 ${JSON.stringify(byRule(out, 'CT4C'))}`)
  // 失效的条目不产生覆盖：其 members 回到"未登记"（CT4 红）
  assert.ok(byRule(out, 'CT4').some((f) => /未登记/.test(f.subject)), '失效条目不得放行任何键')
})

test('★反例①/③：members 与代码真值**集合相等**（少一个红、多一个红）', () => {
  const eq = checkScopeSets({ scope: loadScope({ root: writeScope([entry()]) }), truth: truth() })
  assert.deepEqual(eq.findings, [], '集合相等 ⇒ 无 finding')
  assert.equal(eq.groupCount, 1)
  assert.equal(eq.keyCount, 1)

  const missing = checkScopeSets({
    scope: loadScope({ root: writeScope([entry()]) }),
    truth: truth({ routes: ['GET /knowledge/a', 'GET /knowledge/b'] }),
  })
  assert.equal(byRule(missing, 'CT4').length, 1)
  assert.match(byRule(missing, 'CT4')[0].message, /GET \/knowledge\/b/)
  assert.equal(byRule(missing, 'CT4')[0].severity, 'red')

  const extra = checkScopeSets({
    scope: loadScope({ root: writeScope([entry({ members: ['GET /knowledge/a', 'GET /knowledge/ghost'] })]) }),
    truth: truth(),
  })
  assert.equal(byRule(extra, 'CT4').length, 1, '多登记（含"已由文档声明的键"）必须红')
  assert.match(byRule(extra, 'CT4')[0].message, /GET \/knowledge\/ghost/)
})

test('★CT4 的 finding subject 必须**带成员名**（用计数当 subject ⇒ 一把基线可认领"任意同类单条"）', () => {
  const missing = checkScopeSets({
    scope: loadScope({ root: writeScope([entry()]) }),
    truth: truth({ routes: ['GET /knowledge/a', 'GET /knowledge/b'] }),
  })
  const extra = checkScopeSets({
    scope: loadScope({ root: writeScope([entry({ members: ['GET /knowledge/a', 'GET /knowledge/ghost'] })]) }),
    truth: truth(),
  })
  assert.deepEqual(byRule(missing, 'CT4').map((f) => f.subject), ['routes 未登记 GET /knowledge/b'])
  assert.deepEqual(byRule(extra, 'CT4').map((f) => f.subject), ['routes 多登记 GET /knowledge/ghost'])
  for (const f of [...byRule(missing, 'CT4'), ...byRule(extra, 'CT4')]) {
    assert.equal(/^\S+ (未登记|多登记) \d+ 条$/.test(f.subject), false, `subject 不得只剩计数：${f.subject}`)
  }
  // 多条缺/多时逐条一条 finding（不是折成一条计数）
  const many = checkScopeSets({
    scope: loadScope({ root: writeScope([entry({ members: ['GET /knowledge/a', 'GET /knowledge/x', 'GET /knowledge/y'] })]) }),
    truth: truth(),
  })
  assert.equal(byRule(many, 'CT4').length, 2, `每条多登记一条 finding，实测 ${JSON.stringify(byRule(many, 'CT4'))}`)
})

test('重复登记（同 kind+ns 两条 / 同一键两条）→ 条目失效', () => {
  const dupNs = loadScope({ root: writeScope([entry(), entry({ members: ['GET /knowledge/b'] })]) })
  assert.equal(dupNs.entries.every((e) => e.problems.length > 0), true, '同 (kind,ns) 两条必须都失效')
  const dupKey = loadScope({ root: writeScope([entry(), entry({ ns: '/other', members: ['GET /knowledge/a'] })]) })
  assert.ok(dupKey.entries.some((e) => e.problems.some((p) => /重复/.test(p))))
})

test('docSection 必须指向**存在的章节**（编造章节 → CT4C）', () => {
  const s = loadScope({ root: writeScope([entry({ docSection: '§99' })]) })
  const out = checkScopeSets({ scope: s, truth: truth(), docSections: ['§7', '§7.1'] })
  assert.equal(byRule(out, 'CT4C').length, 1)
  assert.match(byRule(out, 'CT4C')[0].message, /§99/)
  const ok = checkScopeSets({ scope: loadScope({ root: writeScope([entry()]) }), truth: truth(), docSections: ['§7'] })
  assert.deepEqual(byRule(ok, 'CT4C'), [])
})

test('★反例⑦：报告用的 groups 逐条带 kind/ns/count/docSection/reason（不得只报总数）', () => {
  const root = writeScope([
    entry(),
    entry({ kind: 'wsOut', ns: 'bridge→GUI', members: ['milestone'], docSection: null, reason: '§5 未声明的出站类型' }),
  ])
  const out = checkScopeSets({ scope: loadScope({ root }), truth: truth({ wsOut: ['milestone'], doc: ['milestone'] }) })
  assert.deepEqual(out.groups.map((g) => `${g.kind}|${g.ns}|${g.count}|${g.docSection}|${g.reason}`),
    ['routes|/knowledge|1|§7|文档 §7 只声明 4 条，其余零声明',
      'wsOut|bridge→GUI|1|null|§5 未声明的出站类型'])
  assert.equal(out.keyCount, 2)
  assert.equal(out.groupCount, 2)
  assert.deepEqual(SCOPE_KINDS, ['routes', 'wsOut', 'wsIn', 'ipc', 'tools', 'doc'])
})

test('contractGrowth：双护栏独立 —— 组数封顶 + 键数封顶（键数不变时只触发组数）', () => {
  const s = loadScope({ root: writeScope([entry()]) })
  assert.equal(contractGrowth({ scope: s, recordedCount: 5, recordedRedCount: 5 }), null, '未超则不报')
  const overCount = contractGrowth({ scope: s, recordedCount: 0, recordedRedCount: 5 })
  assert.equal(overCount.exceeded, 1)
  assert.equal(overCount.redExceeded, null)
  const overKeys = contractGrowth({
    scope: loadScope({ root: writeScope([entry({ members: ['GET /knowledge/a', 'GET /knowledge/b'] })]) }),
    recordedCount: 1, recordedRedCount: 1,
  })
  assert.equal(overKeys.redExceeded, 2, '键数超封顶必须单独报（组数没超 ⇒ exceeded 为 null）')
  assert.equal(overKeys.exceeded, null)
  assert.equal(overKeys.keyCount, 2)
  assert.equal(overKeys.count, 1)
  // 记录值缺失（null/undefined）视为"不管"（与 baselineGrowth 同口径）
  assert.equal(contractGrowth({ scope: s, recordedCount: null, recordedRedCount: null }), null)
  assert.equal(contractGrowth({ scope: s }), null)
})
