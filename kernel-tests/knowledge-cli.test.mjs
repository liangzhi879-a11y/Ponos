// kernel 知识子命令测试：直接调 runKnowledgeCommand（不起进程）+ parseArgs 契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'
import { parseArgs } from '../kernel/cli.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kcli-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', '---',
    '- [会话|企微CLI化] 只发文件传输助手 -- 涉及真实沟通渠道的测试一律只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  return { dir, personal }
}

test('op=stats 返回索引统计', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'stats', configDir: dir })
    assert.equal(code, 0)
    assert.equal(output.docs, 1)
    assert.ok(output.blocks >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=spaces 返回空间清单（含 docCount）', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({ op: 'spaces', configDir: dir })
    assert.equal(output.spaces[0].id, 'experience')
    assert.equal(output.spaces[0].docCount, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=search 返回块级结果', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '文件传输助手', topK: 5 },
    })
    assert.ok(output.count > 0)
    assert.equal(output.items[0].spaceId, 'experience')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=entries 返回条目级清单', async () => {
  const { dir } = fixture()
  try {
    const { output } = await runKnowledgeCommand({
      op: 'entries', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.entries.length, 1)
    assert.equal(output.entries[0].tag, '企微CLI化')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=update-doc 触发增量更新', async () => {
  const { dir, personal } = fixture()
  try {
    // 正文（' -- ' 之后）就是 S5 §8 之后的索引文本，故把待检索词直接写进正文——
    // 摘要与正文不同文时，只有正文进索引（summary 仍只作 snippet 展示）。
    writeFileSync(join(personal, 'workflow.md'), '- [会话|新] 增量条目 -- 增量条目，内容\n', 'utf-8')
    const { output } = await runKnowledgeCommand({
      op: 'update-doc', configDir: dir, args: { id: 'experience/workflow.md' },
    })
    assert.equal(output.updated, true)
    const { output: s } = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '增量条目' },
    })
    assert.ok(s.count > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('op=search 支持单数 --space 空间过滤（Task 11 路由按单数转发）', async () => {
  const { dir } = fixture()
  try {
    const q = { op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience' } }
    assert.ok((await runKnowledgeCommand(q)).output.count > 0, '单数 --space 应生效')
    const miss = { op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'nope' } }
    assert.equal((await runKnowledgeCommand(miss)).output.count, 0, '限定不存在的空间应 0 命中')
    const multi = { op: 'search', configDir: dir, args: { query: '文件传输助手', spaces: ['experience'] } }
    assert.ok((await runKnowledgeCommand(multi)).output.count > 0, '复数 spaces 仍生效')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未知 op 返回 code=1 与 error 文案（不抛异常给调用方）', async () => {
  const { dir } = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'nope', configDir: dir })
    assert.equal(code, 1)
    assert.match(String(output.error), /unknown knowledge op/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseArgs 认识 --knowledge 与子参数（topK 转数字）', () => {
  const a = parseArgs(['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'search', '--query', 'x', '--keywords', 'a,b', '--topK', '3', '--mode', 'full'])
  assert.equal(a.knowledge, 'search')
  assert.equal(a.query, 'x')
  assert.deepEqual(a.keywords, ['a', 'b'])
  assert.equal(a.topK, 3)
  assert.equal(a.mode, 'full')
})

test('parseArgs 缺省时 knowledge 为 null（不影响既有路径）', () => {
  const a = parseArgs(['--print'])
  assert.equal(a.knowledge, null)
})

test('op=search 的逗号串空间过滤（路由转发形式，需真正生效）', async () => {
  const { dir } = fixture()
  try {
    // 单数逗号串：explore 两个空间
    const one = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience' } })
    assert.ok(one.output.count > 0, '单空间命中')
    // 逗号串含 experience → 仍应命中
    const two = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'experience,session-memory' } })
    assert.ok(two.output.count > 0, '逗号串含有效空间应命中（原实现会因匹配不到 id 而全空）')
    // 逗号串全为无效空间 → 0 命中（证明过滤生效而非被忽略）
    const bad = await runKnowledgeCommand({ op: 'search', configDir: dir, args: { query: '文件传输助手', space: 'x,y' } })
    assert.equal(bad.output.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// S3 §6 观测：stats op 必须带上注入指标 sidecar（缺失时为 null，不得报错）。
// 为什么要在 CLI 这一层锁：`--knowledge stats` 是新进程，进程内累加器恒为初值，
// 只有读 sidecar 这条路能让 HTTP/CLI 看到指标 —— 这条链断了，指标就等于不存在。
test('S3：op=stats 输出含 metrics（无 sidecar 时为 null）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kcli-s3-'))
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'stats', configDir: dir })
    assert.equal(code, 0)
    assert.ok('metrics' in output, 'stats 必须带 metrics 字段（可为 null）')
    assert.equal(output.metrics, null)
    assert.deepEqual(output.search, { count: 0, elapsedP50: null, elapsedP95: null })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 对标 Obsidian 批次 4：stash-doc（覆盖前备份）的 CLI 契约
// ═══════════════════════════════════════════════════════════════════════════

test('批次4：parseArgs 登记 --reason（漏登记会被静默忽略 → 回收站显示成用户自己删的）', () => {
  const a = parseArgs(['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'stash-doc', '--space', 'experience', '--path', 'a.md', '--reason', 'overwrite'])
  assert.equal(a.knowledge, 'stash-doc')
  assert.equal(a.space, 'experience')
  assert.equal(a.path, 'a.md')
  assert.equal(a.reason, 'overwrite')
})

test('批次4：op=stash-doc 复制内容进回收站且原文件保留（走 CLI 的实际入参口径）', async () => {
  const { dir } = fixture()
  try {
    const r = await runKnowledgeCommand({
      op: 'stash-doc', configDir: dir,
      args: { space: 'experience', path: 'workflow.md', reason: 'overwrite' },
    })
    assert.equal(r.code, 0, JSON.stringify(r.output))
    assert.equal(r.output.ok, true)
    assert.equal(r.output.reason, 'overwrite')
    // 原文件必须还在（调用方紧接着要写新内容，搬走就等于"备份 = 删除"）。
    // 直接查盘而不是走 op：内核没有"读原文"的 op（原文由服务端直接读盘），
    // 而这正是本用例要证明的事实 —— 备份**没有**动那个文件。
    assert.equal(readFileSync(join(dir, 'memory', 'personal', 'workflow.md'), 'utf-8').length > 0, true,
      '原文件内容应完好（备份是复制而非搬走）')
    assert.ok(existsSync(join(dir, 'memory', 'personal', 'workflow.md')), '备份不得移走原文件')
    // 回收站能看到这条备份，且 reason 如实
    const trash = await runKnowledgeCommand({ op: 'trash-list', configDir: dir })
    const item = (trash.output.items || []).find((it) => it.trashId === r.output.trashId)
    assert.ok(item, '回收站应有该备份条目')
    assert.equal(item.reason, 'overwrite')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次4：op=stash-doc 失败路径返回非 0（服务端据此放弃写入）', async () => {
  const { dir } = fixture()
  try {
    const r = await runKnowledgeCommand({
      op: 'stash-doc', configDir: dir,
      args: { space: 'experience', path: '不存在.md' },
    })
    // 非 0 退出码是"放弃写入"的信号（服务端不解析 error 字符串，只看 ok/status）——
    // 若这里也返回 0，备份失败会被当成成功 → 覆盖照常发生 → 备份形同虚设。
    assert.equal(r.code, 1)
    assert.equal(r.output.error, 'not-found')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── 检索语法层透传（2026-09-14 对标 Obsidian 批次 3）────────────────────────────
// 这一组钉的是**接线**而不是解析（解析在 shared/knowledge-query.test.mjs）。
// 本仓库反复踩过"逻辑单元都对、接线处漏一环"：参数没转发、返回值没透出，
// 症状是"功能看起来做了但没效果"。所以这里一路验到 CLI 的 output 结构。

test('批次3：op=search 透出算子元信息与 queryError（两层都不许吞）', async () => {
  const { dir, personal } = fixture()
  try {
    // 加一篇带标签的文档，让 tag: 过滤有素材
    writeFileSync(join(personal, 'notes.md'),
      '---\nname: notes\ntags: [财务]\n---\n- [会话|财务] 季度营收口径 -- 营收按权责发生制确认\n', 'utf-8')

    const ok = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: 'tag:财务', topK: 5 },
    })
    assert.equal(ok.code, 0)
    assert.equal(ok.output.query.filterOnly, true, 'CLI 必须透出"仅过滤"标记')
    assert.equal(ok.output.query.enumerate, true)
    assert.ok(ok.output.query.fields.includes('tag'))
    assert.equal(ok.output.orderedBy, 'path')
    assert.ok(ok.output.count >= 1, `tag:财务 应能搜到：${JSON.stringify(ok.output)}`)

    // 语法错误必须一路透到 CLI 输出：静默吞掉会退化成"0 条结果"（用户读成"库里没有"）
    const bad = await runKnowledgeCommand({
      op: 'search', configDir: dir, args: { query: '/[/', topK: 5 },
    })
    assert.equal(bad.code, 0, '语法错误不是命令失败，仍是正常返回')
    assert.match(String(bad.output.queryError), /^bad-regex/)
    assert.equal(bad.output.count, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('批次3：parseArgs 把 --query 原样传给 search（含算子与引号）', () => {
  // 真实 flag 形态：单一聚合子命令 `--knowledge <op>` + 子参数（`--topK` 驼峰）
  const a = parseArgs(['--knowledge', 'search', '--query', 'tag:财务 "季度 报告" -技术', '--topK', '3'])
  assert.equal(a.knowledge, 'search')
  // 算子串必须**原样**到达内核：CLI 层若按空白拆词，`"季度 报告"` 会被拆成两个词、
  // `-技术` 会丢掉负号 —— 语法层的语义在入口处就没了
  assert.equal(a.query, 'tag:财务 "季度 报告" -技术')
  assert.equal(a.topK, 3)
})
