// S5.1：图谱**层级**（`doc` / `entry`）的回归测试。
//
// 被钉住的三件事（spec `2026-09-13-knowledge-relations-s51-design.md` §5）：
//   ① **条目级图真的有条目**：节点 id 是 `docId#n`、带 `docId`+`line`（点节点要能定位到块）、
//      边是 tag/content/ref 三类关联。这一层存在的理由：真实库 **74/76 条经验挤在同一文件内**，
//      文档级图把条目间的关联全塌成自环过滤 ⇒ 文档级只剩 1 条跨文档边（用户看到"像没做图谱"）。
//   ② **文档级不回归**：缺省 `level` 必须与 S2/S5 逐字一致（节点 kind='doc'、边是文档间链接）。
//   ③ **`--level` 转发真的通了**：这条用**真进程**跑——上次新增 `--related` 时，
//      `cli.mjs` 的 parseArgs 解析了它、却**忘了登记进转发给内核的 args 对象**，
//      于是 flag 被静默吞掉（`graph --related` 图层开了却没有边），单测直调
//      `runKnowledgeCommand` 完全没抓到。这次一开始就用真进程锁住。
//
// 隔离纪律：mkdtempSync 临时目录；真进程走 PONOS_HOME 并清 PONOS_CONFIG_DIR
// （防宿主环境把它指到真实库），不起 bridge、不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKnowledgeCommand } from '../kernel/knowledge-cli.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'kernel', 'cli.mjs')
const DOC = 'experience/a.md'

// 5 条同 tag（tag 边必然存在）+ 1 条异 tag（内容层噪声边界）
const LINES = [
  '- [会话|企微CLI化] 渠道纪律 -- 涉及真实沟通渠道的测试一律只发文件传输助手，避免打扰真人',
  '- [会话|企微CLI化] 步骤字段契约 -- js 步骤需 expression、click 类需 ref，写错会静默失败很久',
  '- [会话|企微CLI化] 同步前预演 -- 用 rsync 增量同步目录时先 dry-run 预览变更清单再执行',
  '- [会话|企微CLI化] 联查去重 -- 多表联查先按业务键去重再聚合，否则分母翻倍让比率失真',
  '- [打包发布] 打包核对 -- 上传前逐项核对文件名与发布清单，避免版本错配带来的返工',
]

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-klevel-'))
  const personal = join(dir, 'memory', 'personal')
  mkdirSync(personal, { recursive: true })
  writeFileSync(join(personal, 'a.md'), ['---', 'name: a', '---', ...LINES].join('\n') + '\n', 'utf-8')
  return dir
}

/** 真进程跑 `--knowledge graph [额外参数]`，返回解析后的 JSON 输出 */
function runCli(dir, extra = []) {
  const r = spawnSync(process.execPath, [
    CLI, '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--knowledge', 'graph', ...extra,
  ], {
    encoding: 'utf-8',
    env: { ...process.env, PONOS_HOME: dir, PONOS_CONFIG_DIR: '' },
    cwd: ROOT,
  })
  assert.equal(r.status, 0, `真进程退出码应为 0，stderr=${r.stderr}`)
  return JSON.parse(r.stdout.trim())
}

test('条目级图：节点是条目（带 docId/line）、边是 tag/content/ref 三类关联', async () => {
  const dir = fixture()
  try {
    const { output, code } = await runKnowledgeCommand({ op: 'graph', configDir: dir, args: { level: 'entry' } })
    assert.equal(code, 0)
    assert.equal(output.level, 'entry')
    assert.ok(output.nodes.length >= 5, `条目级节点应 ≥5，实得 ${output.nodes.length}`)
    for (const n of output.nodes) {
      assert.equal(n.kind, 'entry', '条目级节点 kind 必须是 entry（doc 会让调用方按文档解读）')
      assert.match(n.id, /^experience\/a\.md#\d+$/, '节点 id 是 docId#n')
      assert.equal(n.docId, DOC, '必须带 docId —— 点节点后要知道打开哪篇')
      assert.equal(typeof n.line, 'number', '必须带 line（数值）—— 否则点进去还得自己找条目')
      assert.ok(n.label && n.label.length > 0, 'label 不能空（空标题在图上是个无名方块）')
      // 类型前缀不该出现在 label 里（前缀只标类型，占 label 纯属浪费）
      assert.ok(!n.label.startsWith('会话|'), 'label 应是去类型前缀后的内容摘要')
    }
    assert.ok(output.edges.length > 0, '条目级必须有边（真实库文档级只有 1 条，条目级 286 条）')
    const kinds = new Set(output.edges.map((e) => e.kind))
    for (const k of kinds) assert.ok(['tag', 'content', 'ref'].includes(k), `边类型只能是三类关联，实得 ${k}`)
    assert.ok(kinds.has('tag'), '同 tag 条目间应产出 tag 边')
    // duplicate 不进图（去重提示不是阅读路径，S5 §5.5）
    assert.ok(!kinds.has('duplicate'))
    // 端点必须在节点集合内（否则前端画不出边、只能静默丢弃）
    const ids = new Set(output.nodes.map((n) => n.id))
    for (const e of output.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `边端点 ${e.from}→${e.to} 应在节点集合内`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('文档级不回归：缺省 level 节点是文档、边不是条目级三类', async () => {
  const dir = fixture()
  try {
    const { output } = await runKnowledgeCommand({ op: 'graph', configDir: dir, args: {} })
    assert.notEqual(output.level, 'entry', '缺省不得走进条目级')
    assert.ok(output.nodes.length > 0)
    for (const n of output.nodes) assert.equal(n.kind, 'doc', '缺省仍是文档级节点')
    for (const e of output.edges) assert.equal(e.kind, undefined, '文档级边没有条目级 kind 字段')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真进程：`--level entry` 必须真的转发到内核（上次 `--related` 漏登记的同款防线）', () => {
  const dir = fixture()
  try {
    const withFlag = runCli(dir, ['--level', 'entry'])
    assert.equal(withFlag.level, 'entry', '`--level entry` 没转发 → flag 被静默吞掉，层级按钮点了没反应')
    assert.ok(withFlag.nodes.length >= 5)
    assert.equal(withFlag.nodes[0].kind, 'entry')

    // 反向断言：不带 flag 时必须**不是**条目级（防"永远返回 entry"式的假通过）
    const noFlag = runCli(dir)
    assert.notEqual(noFlag.level, 'entry')
    assert.equal(noFlag.nodes[0].kind, 'doc')

    // 非法值落回文档级（枚举而非自由值；不因脏参数打断浏览）
    const bad = runCli(dir, ['--level', 'nonsense'])
    assert.notEqual(bad.level, 'entry', '非法层级应落回文档级')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
