// kernel-tests/diff-stats.test.mjs —— 写侧工具增删行数（2026-10-08 用户细化："每次执行修改，
// 显示删减/增加数量"）
// ---------------------------------------------------------------------------
// 钉四层（缺一即回归）：
//   ① 纯函数 diffLineStats：公共前后缀裁剪的行级计数（CRLF 归一、末尾换行约定、
//      "移动行算增+删"的已知取舍——刻意钉住，别当 bug 修）；
//   ② Write 的 meta：新文件全算新增 / 覆盖按真 diff / 内容不变不给数字 /
//      旧文超 1MB 不读不给数字（宁缺勿错，不用"全算新增"冒充）；
//   ③ Edit 的 meta：单处 / 多行片段 / replace_all 乘次数 / CRLF 写回零漂移 /
//      未命中失败与无变化都不给数字；
//   ④ 返回文案关键片段不回归（knowledge-read-boundary 只钉调用点文本，文案由这里钉）。
// 隔离纪律：mkdtempSync 自建夹具，绝不碰真实用户目录，离线可重复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry, diffLineStats } from '../kernel/tools.mjs'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'diff-stats-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const makeTools = (env) => createToolRegistry({ cwd: env.dir, addDirs: [], skipPermissions: true })

test('diffLineStats：纯函数计数（新增/删除/替换/CRLF/末尾换行/移动取舍）', () => {
  assert.deepEqual(diffLineStats('a\nb\nc', 'a\nb\nc'), { additions: 0, deletions: 0 })
  assert.deepEqual(diffLineStats('', 'a'), { additions: 1, deletions: 0 })
  assert.deepEqual(diffLineStats('a', ''), { additions: 0, deletions: 1 })
  assert.deepEqual(diffLineStats('a\nb\nc', 'a\nX\nc'), { additions: 1, deletions: 1 })
  assert.deepEqual(diffLineStats('a\nb', 'a\nb\nc'), { additions: 1, deletions: 0 })
  assert.deepEqual(diffLineStats('b\nc', 'a\nb\nc'), { additions: 1, deletions: 0 })
  // CRLF 归一：纯行尾风格变化不算改动（与 editFile 的归一化口径同源）
  assert.deepEqual(diffLineStats('a\r\nb\r\n', 'a\nb\n'), { additions: 0, deletions: 0 })
  // 末尾换行约定：'a' → 'a\n' 计 +1（split 后空元素参与比对，"加了一行"的直觉）
  assert.deepEqual(diffLineStats('a', 'a\n'), { additions: 1, deletions: 0 })
  // 已知取舍（实现简单性，见 tools.mjs#diffLineStats 头注）：移动/交换块按裁剪法计成增+删
  assert.deepEqual(diffLineStats('a\nb', 'b\na'), { additions: 2, deletions: 2 })
})

test('Write：新文件全算新增（meta {additions, deletions:0}），文案不回归', () => {
  const env = makeEnv()
  try {
    const r = makeTools(env).registry.Write.run({ file_path: join(env.dir, 'new.txt'), content: 'l1\nl2\nl3' })
    assert.equal(r.isError, undefined, `不应报错：${r.content}`)
    // diffHunk（2026-10-28 Task 4a）：新文件按 unified diff 惯例 `@@ -0,0 +1,N @@`，全是 + 行
    assert.deepEqual(r.meta, {
      additions: 3,
      deletions: 0,
      diffHunk: '@@ -0,0 +1,3 @@\n+l1\n+l2\n+l3',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
    assert.match(String(r.content), /^已写入 /)
    assert.match(String(r.content), /new\.txt/) // 文案仍带解析后的绝对路径
  } finally { env.cleanup() }
})

test('Write：覆盖已有文件按真 diff（中段替换 ⇒ 增 1 删 2）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'over.txt')
    writeFileSync(p, 'a\nb\nc', 'utf-8')
    const r = tools.registry.Write.run({ file_path: p, content: 'a\nX' })
    assert.equal(r.isError, undefined, r.content)
    // 公共前缀 'a' 之后的最小改动区间：旧第 2 行起 2 行、新第 2 行起 1 行
    assert.deepEqual(r.meta, {
      additions: 1,
      deletions: 2,
      diffHunk: '@@ -2,2 +2,1 @@\n-b\n-c\n+X',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
    // meta 与落盘同源：数字对应的新内容真的写进去了
    assert.equal(readFileSync(p, 'utf-8'), 'a\nX')
  } finally { env.cleanup() }
})

test('Write：内容不变 ⇒ 无 meta（不虚拟 +0 −0 徽标）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'same.txt')
    writeFileSync(p, 'same', 'utf-8')
    const r = tools.registry.Write.run({ file_path: p, content: 'same' })
    assert.equal(r.isError, undefined, r.content)
    assert.equal(r.meta, undefined)
  } finally { env.cleanup() }
})

test('Write：旧文超 1MB ⇒ 不读、不给数字（宁缺勿错）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'big.txt')
    writeFileSync(p, 'x'.repeat(1024 * 1024 + 2), 'utf-8') // 超上限一个字符
    const r = tools.registry.Write.run({ file_path: p, content: 'tiny' })
    assert.equal(r.isError, undefined, r.content)
    assert.equal(r.meta, undefined)
    assert.equal(readFileSync(p, 'utf-8'), 'tiny') // 写入本身照常成功
  } finally { env.cleanup() }
})

test('Edit：单处替换按片段真 diff（{1,1}），文案带"1 处替换"', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'e.txt')
    writeFileSync(p, 'alpha\nbeta\ngamma\n', 'utf-8')
    const r = tools.registry.Edit.run({ file_path: p, old_string: 'beta', new_string: 'BETA' })
    assert.equal(r.isError, undefined, r.content)
    // hunk 对**被替换片段**生成（不是全文件），行号从片段开头算
    assert.deepEqual(r.meta, {
      additions: 1,
      deletions: 1,
      diffHunk: '@@ -1,1 +1,1 @@\n-beta\n+BETA',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
    assert.match(String(r.content), /^已编辑 /)
    assert.match(String(r.content), /1 处替换/)
  } finally { env.cleanup() }
})

test('Edit：多行片段合并成一行 ⇒ 增 1 删 2（按被替换片段算，不按全文件）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'multi.txt')
    writeFileSync(p, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8')
    const r = tools.registry.Edit.run({ file_path: p, old_string: 'beta\ngamma', new_string: 'BETA' })
    assert.equal(r.isError, undefined, r.content)
    assert.deepEqual(r.meta, {
      additions: 1,
      deletions: 2,
      diffHunk: '@@ -1,2 +1,1 @@\n-beta\n-gamma\n+BETA',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
  } finally { env.cleanup() }
})

test('Edit：replace_all 乘替换次数（每处同片段同 diff）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'all.txt')
    writeFileSync(p, 'foo foo foo\n', 'utf-8')
    const r = tools.registry.Edit.run({ file_path: p, old_string: 'foo', new_string: 'bar', replace_all: true })
    assert.equal(r.isError, undefined, r.content)
    // 3 处替换只在数字上乘 3；hunk 仍是「每处同片段同 diff」的单份
    assert.deepEqual(r.meta, {
      additions: 3,
      deletions: 3,
      diffHunk: '@@ -1,1 +1,1 @@\n-foo\n+bar',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
    assert.match(String(r.content), /3 处替换/)
    assert.equal(readFileSync(p, 'utf-8'), 'bar bar bar\n')
  } finally { env.cleanup() }
})

test('Edit：CRLF 文件——计数按归一后片段算，写回仍是 CRLF（行尾零漂移）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'crlf.txt')
    writeFileSync(p, 'one\r\ntwo\r\n', 'utf-8')
    // 模型按 LF 习惯写 old_string：归一化后命中，meta 数字是真实替换量（不是全文件）
    const r = tools.registry.Edit.run({ file_path: p, old_string: 'two', new_string: '2' })
    assert.equal(r.isError, undefined, r.content)
    // hunk 基于归一后的片段（\n），不含 \r——与写回的行尾风格解耦
    assert.deepEqual(r.meta, {
      additions: 1,
      deletions: 1,
      diffHunk: '@@ -1,1 +1,1 @@\n-two\n+2',
    })
    assert.match(String(r.meta.diffHunk), /^@@ /)
    assert.ok(!String(r.meta.diffHunk).includes('\r')) // 行尾零漂移同样体现在 hunk 上
    assert.equal(readFileSync(p, 'utf-8'), 'one\r\n2\r\n')
  } finally { env.cleanup() }
})

test('Edit：未命中 ⇒ 失败且无 meta；无实际变化 ⇒ 成功但无 meta（不得凭猜给数字）', () => {
  const env = makeEnv()
  try {
    const tools = makeTools(env)
    const p = join(env.dir, 'edge.txt')
    writeFileSync(p, 'only\n', 'utf-8')
    const miss = tools.registry.Edit.run({ file_path: p, old_string: 'nope', new_string: 'x' })
    assert.equal(miss.isError, true)
    assert.equal(miss.meta, undefined)
    const noop = tools.registry.Edit.run({ file_path: p, old_string: 'only', new_string: 'only' })
    assert.equal(noop.isError, undefined, noop.content)
    assert.equal(noop.meta, undefined)
  } finally { env.cleanup() }
})
