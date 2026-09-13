// 对拍（Task 13）：内核直调 vs CLI 子进程（server 实际通道）——top-5 blockId 序列必须逐位相同。
// ---------------------------------------------------------------------------
// 为什么对拍的是"内核直调 vs 内核 CLI 子进程"：server 侧**没有**自己的检索实现，
// `/knowledge/search` 完全等于 `kernelReadonly(['--knowledge','search',...])` 的 stdout。
// 漂移风险因此只在 **CLI 参数组装 + JSON 序列化往返**（而非两套算法）。本测试把这个
// 往返钉死；算法内部漂移由 shared/ 与 kernel-tests/knowledge-*.test.mjs 覆盖。
//
// 隔离：子进程经 PONOS_HOME 指向 mkdtempSync 临时目录（resolveConfigDir 优先级：
// CLAUDE_CONFIG_DIR → PONOS_HOME → ~/.ponos）；CLAUDE_CONFIG_DIR 显式置空以免外部干扰。
// 绝不触碰真实 ~/.yfworking / ~/.yfw；不起 bridge。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createKnowledgeStore } from '../kernel/knowledge.mjs'

const CLI = new URL('../kernel/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-kpar-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'workflow.md'), [
    '---', 'name: workflow', 'description: 工作流心得', '---',
    '## 申报材料',
    '- [会话|申报材料] 四表联动交叉校验 -- RD/PS/IP/TOAI 的产品名称与收入口径必须对齐',
    '- [会话|申报材料] 建表前先冻结口径 -- 收入口径变更导致返工，先冻结再出表',
    '## 企微CLI化',
    '- [会话|企微CLI化] 只发文件传输助手 -- 真实沟通渠道的测试只发文件传输助手',
  ].join('\n') + '\n', 'utf-8')
  writeFileSync(join(personal, 'policy.md'), [
    '---', 'name: policy', '---',
    '- [会话|高企口径] RD表与PS表技术关联 -- 需说明研发项目与产品之间的技术关联',
  ].join('\n') + '\n', 'utf-8')
  return dir
}

function runCli(dir, argsList) {
  // 必须带 stream-json 两个标志：`--knowledge` 短路块位于 cli.mjs 的格式校验之后，
  // 缺标志会以 `kernel: only stream-json I/O format is supported` 退出。
  // 这也正是 server 侧 kernelReadonly 的实际调用形状（server/kernel-readonly.mjs:41）。
  const out = execFileSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', '--knowledge', ...argsList,
  ], {
    env: { ...process.env, PONOS_HOME: dir, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf-8',
    timeout: 60000,
  })
  return JSON.parse(out)
}

/** 与 server 侧同一路径：stdout 单行 JSON → parse。 */
function runCliRaw(dir, argsList) {
  return execFileSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json', '--knowledge', ...argsList,
  ], {
    env: { ...process.env, PONOS_HOME: dir, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf-8',
    timeout: 60000,
  })
}

/**
 * 去掉 `indexAge`（= 进程内 Date.now() - builtAt 的毫秒差，天生跨进程不可比），
 * 其余字段一律要求逐字相同——只放行这一个时间字段，其它漂移仍然会红。
 */
function withoutAge(o) {
  const { indexAge, ...rest } = JSON.parse(JSON.stringify(o))
  return rest
}

const QUERIES = [
  { query: '四表联动交叉校验', keywords: ['申报材料'] },
  { query: '收入口径', keywords: [] },
  { query: '文件传输助手', keywords: ['企微CLI化'] },
]

test('对拍：直调与 CLI 子进程的 top-5 blockId 序列逐位一致（3 组查询）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    for (const q of QUERIES) {
      const direct = store.search({ ...q, topK: 5 })
      const cliOut = runCli(dir, ['search', '--query', q.query, '--keywords', q.keywords.join(','), '--topK', '5'])
      const directIds = direct.items.map((i) => i.blockId)
      const cliIds = cliOut.items.map((i) => i.blockId)
      assert.deepEqual(cliIds, directIds, `查询「${q.query}」双端不一致`)
      assert.equal(cliOut.count, direct.count)
      assert.equal(cliOut.degraded, direct.degraded)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：search 全量输出经 JSON 往返无漂移（server 拿到的就是直调结果）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    for (const q of QUERIES) {
      const direct = store.search({ ...q, topK: 5 })
      const raw = runCliRaw(dir, ['search', '--query', q.query, '--keywords', q.keywords.join(','), '--topK', '5'])
      // 单行 JSON（server 的 readFileSync+JSON.parse 形状；多行会破坏分帧假设）。
      // 注：console.log 会补一个尾换行，判据是"去掉尾换行后无内嵌换行"。
      assert.equal(raw.replace(/\r?\n$/, '').includes('\n'), false, 'stdout 必须是单行 JSON')
      const cliOut = JSON.parse(raw)
      assert.deepEqual(withoutAge(cliOut), withoutAge(direct), `查询「${q.query}」JSON 往返漂移`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：CLI 的 spaces / stats / entries 与直调一致', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    const cliSpaces = runCli(dir, ['spaces'])
    assert.deepEqual(
      cliSpaces.spaces.map((s) => [s.id, s.docCount]),
      store.getSpaces().map((s) => [s.id, s.docCount]),
    )
    const cliStats = runCli(dir, ['stats'])
    assert.equal(cliStats.docs, store.stats().docs)
    assert.equal(cliStats.blocks, store.stats().blocks)

    const cliEntries = runCli(dir, ['entries', '--id', 'experience/workflow.md'])
    assert.deepEqual(
      cliEntries.entries.map((e) => e.summary),
      store.listEntries('experience/workflow.md').map((e) => e.summary),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('对拍：CLI 未命中/降级查询与直调同形（含空 query）', () => {
  const dir = fixture()
  try {
    const store = createKnowledgeStore({ configDir: dir })
    store.load({ force: true })
    // 空 query：直调返回空结果；CLI 亦须返回同形（不得报错）
    const directEmpty = store.search({ query: '', topK: 5 })
    assert.deepEqual(
      withoutAge(runCli(dir, ['search', '--query', '', '--topK', '5'])),
      withoutAge(directEmpty),
    )
    // 零命中乱码：走降级路，双端 degraded 标记与结果必须一致
    const directMiss = store.search({ query: 'zzzzqqqq', topK: 5 })
    const cliMiss = runCli(dir, ['search', '--query', 'zzzzqqqq', '--topK', '5'])
    assert.deepEqual(withoutAge(cliMiss), withoutAge(directMiss))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引可弃：删除 .index 后自动重建，结果与删除前完全一致', () => {
  const dir = fixture()
  try {
    const first = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load({ force: true })
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    assert.ok(first.length >= 2, '前置：删除前应有多条结果（否则"一致"无意义）')
    // 前置：索引确实已落盘（否则 rm 是空操作，"可弃"未真正被验证）
    assert.ok(existsSync(join(dir, 'knowledge', '.index')), '前置：.index 应已生成')
    rmSync(join(dir, 'knowledge', '.index'), { recursive: true, force: true })
    assert.equal(existsSync(join(dir, 'knowledge', '.index')), false)
    const second = (() => {
      const s = createKnowledgeStore({ configDir: dir })
      s.load() // 无 force：索引缺失应自动重建
      return s.search({ query: '收入口径', topK: 5 }).items.map((i) => i.blockId)
    })()
    assert.deepEqual(second, first)
    // 重建后 CLI 侧同样一致（server 通道也受益于"索引可弃"）
    const cliIds = runCli(dir, ['search', '--query', '收入口径', '--topK', '5']).items.map((i) => i.blockId)
    assert.deepEqual(cliIds, first)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
