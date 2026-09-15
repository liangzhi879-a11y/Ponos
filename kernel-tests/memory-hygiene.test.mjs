// S5 Task 3：记忆条目的源头数据卫生（spec §9.1，真实库实测问题）
// ---------------------------------------------------------------------------
// 实测：真实库 `~/.yfw/memory/personal` 有 7 条 `full` 仅 10 字的空模板条目
// （`流程要点：用户回答：`、`业务要点（请注意）：`），它们是 captureMemoryCandidates
// 模板化写入的产物；两两文本全同 → 关联层 cos=1.000，会灌入"完美相似但零信息"的边。
// 处置：**修源头**（本文件的断言）+ 关联侧 MIN_LEN 防御（shared 层已有用例）。
// 边界纪律：既有条目的读取兼容性**不得**改变（存量垃圾仍能被读出），故只测"不再产生新的"。
// 隔离：一律 mkdtempSync + PONOS_HOME，绝不碰真实 ~/.yfworking / ~/.yfw。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureMemoryCandidates, appendMemoryEntry, readMemoryEntries, memoryRoot } from '../kernel/memory.mjs'

const tmpDirs = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-mem-hyg-'))
  tmpDirs.push(dir)
  const prev = process.env.PONOS_HOME
  process.env.PONOS_HOME = dir // 双保险：任何模块若按 PONOS_HOME 兜底也必须落到临时目录
  return { dir, root: memoryRoot(dir), restore: () => { if (prev === undefined) delete process.env.PONOS_HOME; else process.env.PONOS_HOME = prev } }
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

test('S5 Task3：空模板输入不产生条目（实测形态①：去前缀后为空 —— 流程要点：用户回答：）', () => {
  const f = fixture()
  try {
    // 强流程信号词 + 无正文：旧实现产出 summary=`流程要点：流程是：`、full=`流程是：`
    // → relationContent 去前缀后为空字符串（正是实测 7 条垃圾的形态）
    assert.deepEqual(captureMemoryCandidates({ userText: '流程是：' }), [])
    assert.deepEqual(captureMemoryCandidates({ userText: '推荐做法：', tag: '应用智控' }), [])
    // 偏好/纠正/业务三类同样过闸（模板词 + 空正文）
    assert.deepEqual(captureMemoryCandidates({ userText: '我喜欢：' }), [])
    assert.deepEqual(captureMemoryCandidates({ userText: '以后不要：' }), [])
    assert.deepEqual(captureMemoryCandidates({ userText: '请注意：' }), [])
  } finally { f.restore() }
})

test('S5 Task3：空模板输入不产生条目（实测形态②：内容恰是触发词本身 —— 业务要点（请注意）：）', () => {
  const f = fixture()
  try {
    // 无中文冒号 → 去前缀不生效，但内容 == 触发词 → 同样是零信息模板（实测第二条形态）
    assert.deepEqual(captureMemoryCandidates({ userText: '请注意' }), [])
    assert.deepEqual(captureMemoryCandidates({ userText: '记住' }), [])
    assert.deepEqual(captureMemoryCandidates({ userText: '我喜欢' }), [])
    // 只剩标点的形态（③ 的补充）
    assert.deepEqual(captureMemoryCandidates({ userText: '请注意：。，' }), [])
  } finally { f.restore() }
})

test('S5 Task3：正常内容仍产生条目（含**简短但真实**的偏好，不得被长度阈值误杀）', () => {
  const f = fixture()
  try {
    const a = captureMemoryCandidates({ userText: '流程是：先备份 settings.json，再补上缺失的开引号，最后跑一次全量测试' })
    assert.equal(a.length, 1)
    assert.equal(a[0].theme, 'workflow')
    assert.equal(a[0].summary, '流程要点：流程是：先备份 settings.json，再补上缺失的开引号，最后跑一次全量测试')
    assert.ok(a[0].full.includes('开引号'))
    // 简短偏好（去前缀后 11 字 < MIN_LEN=20）：源头**必须保留**——它是真实用户偏好，
    // 关联侧用户可以看不到它，但记忆/检索不能把它丢掉（源头丢数据不可逆）
    const b = captureMemoryCandidates({ userText: '记住：导出目录必须用绝对路径' })
    assert.equal(b.length, 1)
    assert.equal(b[0].theme, 'workflow')
    assert.ok(b[0].full.includes('绝对路径'))
    // 正常业务要点
    const c = captureMemoryCandidates({ userText: '必须用：PS 表与 RD 表交叉校验后再导出申报材料' })
    assert.equal(c.length, 1)
    assert.equal(c[0].theme, 'project-application')
  } finally { f.restore() }
})

test('S5 Task3：端到端——模板输入不入库，正常内容入库（写盘后文件只有 1 条）', () => {
  const f = fixture()
  try {
    // 模拟 kernel/cli.mjs:847-853 的轮末捕获写法
    const inputs = ['流程是：', '请注意', '流程是：先备份 settings.json，再补上缺失的开引号，最后跑一次全量测试']
    for (const content of inputs) {
      for (const c of captureMemoryCandidates({ userText: content, tag: '应用智控' })) {
        appendMemoryEntry({ root: f.root, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full })
      }
    }
    const entries = readMemoryEntries({ root: f.root, theme: 'workflow' })
    assert.equal(entries.length, 1, '模板输入不得落盘（只有正常内容那一条）')
    assert.ok(entries[0].full.includes('开引号'))
    assert.ok(!readFileSync(join(f.root, 'workflow.md'), 'utf-8').includes('用户回答'))
  } finally { f.restore() }
})

test('S5 Task3：存量垃圾条目的**读取兼容性不变**（仍能读出，只在索引/关联侧被过滤）', () => {
  const f = fixture()
  try {
    mkdirSync(f.root, { recursive: true })
    // 真实库实测形态原样落盘（无 ' -- ' 分隔符：parseEntryLine 使 full == summary）
    writeFileSync(join(f.root, 'workflow.md'), [
      '---', 'name: workflow', 'description: 工作流', '---',
      '- [会话] 流程要点：用户回答：',
      '- [会话|应用智控] 正常条目 -- 正文内容足够长，用于确认存量文件里正常条目不受影响',
    ].join('\n') + '\n', 'utf-8')
    const entries = readMemoryEntries({ root: f.root, theme: 'workflow' })
    assert.equal(entries.length, 2, '存量垃圾必须仍可读出（不得因源头修复而改变读取行为）')
    assert.equal(entries[0].summary, '流程要点：用户回答：')
    assert.equal(entries[0].full, '流程要点：用户回答：')
    assert.equal(entries[1].tag, '应用智控')
  } finally { f.restore() }
})
