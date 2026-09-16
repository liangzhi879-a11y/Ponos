// kernel/knowledge.mjs 的 resolveSessionKnowledgeScope 测试（2026-09-15，待处理清单 P1）。
//
// 隔离纪律：全部走 mkdtempSync 临时 configDir，绝不碰真实 ~/.yfworking。
// 这一层是**纯函数**（只做目录发现），故不建索引、不写盘——用例只钉语义边界：
//   缺省=经验库、关联=追加、不存在=missing、超上限=dropped、内置不占配额、保序去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSessionKnowledgeScope, MAX_ASSOC_SPACES, LARGE_SPACE_DOCS,
} from '../kernel/knowledge.mjs'

/** 造隔离 configDir：个人经验库 + session 记忆 + N 个用户空间（id = user-1..N）。 */
function makeFixture({ userSpaces = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-scope-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), '# 工作流\n\n- [会话|测试] 一条经验 -- 全文\n', 'utf-8')
  mkdirSync(join(dir, 'memory', 'session'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'session', 's.md'), '# 会话记忆\n', 'utf-8')
  const ids = []
  for (let i = 1; i <= userSpaces; i += 1) {
    const id = `user-${i}`
    const root = join(dir, 'knowledge', 'spaces', id)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.space.json'), JSON.stringify({ name: `库${i}` }), 'utf-8')
    writeFileSync(join(root, 'a.md'), `# 库${i}文档\n\n内容。\n`, 'utf-8')
    ids.push(id)
  }
  return { dir, ids }
}

test('缺省（未关联）：范围只含内置经验类空间，用户库进 unassociated', () => {
  const { dir } = makeFixture()
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir })
    assert.deepEqual(sc.builtin.sort(), ['experience', 'session-memory'], '内置经验类 = source ∈ {experience, memory}')
    assert.deepEqual(sc.associated, [], '没关联就是没关联（不默认放行用户库）')
    assert.deepEqual(sc.spaces.sort(), ['experience', 'session-memory'])
    assert.deepEqual(sc.unassociated, ['user-1'], '用户库存在但未关联 → 提示词据此告知模型')
    assert.equal(sc.truncated, false)
    assert.equal(sc.labels['user-1'], '库1', 'labels = id→显示名（提示词/GUI 共用一份口径）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('关联生效：追加进范围且移出 unassociated', () => {
  const { dir } = makeFixture()
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: ['user-1'] })
    assert.deepEqual(sc.associated, ['user-1'])
    assert.deepEqual(sc.spaces, ['experience', 'session-memory', 'user-1'], '内置前置、关联在后 = 顺序即优先级')
    assert.deepEqual(sc.unassociated, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('不存在的 id 进 missing，且不抛错、不污染范围', () => {
  const { dir } = makeFixture()
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: ['ghost', 'user-1'] })
    assert.deepEqual(sc.missing, ['ghost'])
    assert.deepEqual(sc.associated, ['user-1'], 'missing 不得占关联位')
    assert.deepEqual(sc.spaces, ['experience', 'session-memory', 'user-1'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('去重且保序（用户给定顺序即优先级），重复项不吃配额', () => {
  const { dir } = makeFixture({ userSpaces: 2 })
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: ['user-2', 'user-1', 'user-2'] })
    assert.deepEqual(sc.associated, ['user-2', 'user-1'])
    assert.deepEqual(sc.missing, [], '重复的已存在 id 不是 missing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('超上限（>MAX_ASSOC_SPACES）截断进 dropped 且 truncated=true，不报错', () => {
  const n = MAX_ASSOC_SPACES + 2
  const { dir, ids } = makeFixture({ userSpaces: n })
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: ids })
    assert.equal(sc.associated.length, MAX_ASSOC_SPACES)
    assert.deepEqual(sc.dropped, ids.slice(MAX_ASSOC_SPACES), '被忽略的必须可见（静默丢配置=用户以为生效了）')
    assert.equal(sc.truncated, true)
    assert.equal(sc.spaces.length, 2 + MAX_ASSOC_SPACES)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('内置经验库不可被"关联"移除、也不占关联配额', () => {
  const { dir } = makeFixture()
  try {
    const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: ['experience', 'session-memory', 'user-1'] })
    assert.deepEqual(sc.associated, ['user-1'], '内置空间即使被列出也不算关联（D4：基础设施不可关）')
    assert.ok(sc.spaces.includes('experience') && sc.spaces.includes('session-memory'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('入参脏值归一：非数组/null/空串/空白一律当"未关联"', () => {
  const { dir } = makeFixture()
  try {
    for (const bad of [null, undefined, 'user-1', [], ['', '  '], [null, undefined]]) {
      const sc = resolveSessionKnowledgeScope({ configDir: dir, requested: bad })
      assert.deepEqual(sc.spaces, ['experience', 'session-memory'], `脏值 ${JSON.stringify(bad)} 应等价于未关联`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('阈值常量导出且为大库提示留了可用值（配置面契约）', () => {
  assert.equal(typeof MAX_ASSOC_SPACES, 'number')
  assert.ok(MAX_ASSOC_SPACES >= 1)
  assert.equal(typeof LARGE_SPACE_DOCS, 'number')
  assert.ok(LARGE_SPACE_DOCS > 0)
})
