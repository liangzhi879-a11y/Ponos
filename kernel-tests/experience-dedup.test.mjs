// kernel-tests/experience-dedup.test.mjs —— 经验供给 A16/A18/A20（逐 Task 追加）
// Task 3 先行：active 过滤（写入侧 = 服务端读取侧都早已就绪，**真实缺口**是内核注入侧）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMemoryIndex, buildRelevantMemory, memoryBytes,
  renderThemeList, EL0_MAX_BYTES, EL0_TARGET_BYTES,
} from '../kernel/memory.mjs'

/** 造一个含 active:true / active:false 两个主题的记忆根（★ 扁平文件形状）
 *  与服务端 server/experience.mjs 的写入（kernel/memory.mjs:83-85）同构：
 *    --- front --- \n 条目
 *  注意：实测主题是 root/<主题>.md（themePath :29-31），不是目录，也不是 _front.md
 */
function mkMemoryRoot(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'mem-active-'))
  const defs = [
    { theme: '启用主题', active: 'true' },
    { theme: '停用主题', active: 'false' },
    { theme: '无front主题', active: undefined }, // 验证：缺省视为启用（与 readTheme 默认值一致）
    ...extra,
  ]
  for (const { theme, active } of defs) {
    const head = ['---', `name: ${theme}`, `description: ${theme}`]
    if (active !== undefined) head.push(`active: ${active}`)
    head.push('---')
    const lines = [...head, `- [会话|标签] ${theme} 的条目 -- 全文`]
    writeFileSync(join(root, `${theme}.md`), `${lines.join('\n')}\n`, 'utf8')
  }
  return root
}

// ── Task 3：A16 内核注入侧尊重 front.active ──────────────────────────────────

test('buildMemoryIndex 跳过 active:false 的主题（A16）', () => {
  const root = mkMemoryRoot()
  const text = buildMemoryIndex({ root, maxBytes: 4096 })    // ★ 实测签名 {root, maxBytes}
  assert.ok(text.includes('启用主题'), '启用主题应被注入')
  assert.ok(!text.includes('停用主题'), '停用主题不应被注入')
})

test('buildMemoryIndex 缺省 front（即无 active 字段）视为启用（与 readTheme 默认值兼容）', () => {
  const root = mkMemoryRoot()
  const text = buildMemoryIndex({ root, maxBytes: 4096 })
  assert.ok(text.includes('无front主题'), '无 active 字段时按"启用"处理（兼容现网无 front 旧主题）')
})

test('buildRelevantMemory 同样跳过 active:false 的主题（A16：两个注入函数都要覆盖）', () => {
  const root = mkMemoryRoot()
  const text = buildRelevantMemory({ root, keywords: ['启用主题', '停用主题', '无front主题'], maxBytes: 4096 })
  assert.ok(!String(text).includes('停用主题'), '停用主题不应被相关记忆注入')
  assert.ok(String(text).includes('启用主题') || String(text).includes('无front主题'),
    '启用/无front 主题至少其一应被相关记忆注入')
})

// ── Task 4：S4.5① 去重 —— 移除 server/bridge.mjs 两处常驻经验注入调用 ────────

const BRIDGE = new URL('../server/bridge.mjs', import.meta.url)

test('★ server/bridge.mjs 不再有 buildExperienceIndex 的注入调用（去重）', () => {
  const src = readFileSync(BRIDGE, 'utf8')
  // 排除 import/export/注释行 ⇒ 只数"实际调用"：应为 0
  const callLines = src.split(/\r?\n/).filter((l) =>
    l.includes('buildExperienceIndex')
      && !/^\s*(import|export|\/\/|\/\*|\*)/.test(l)
      && !l.match(/^\s*\}/),  // 排除纯注释里的 stray 提及
  )
  assert.deepEqual(callLines, [], `不应再有注入调用，实际: ${JSON.stringify(callLines)}`)
})

test('server/bridge.mjs 仍保留 import 与 re-export（供 verify:experience-inject 与测试使用）', () => {
  const src = readFileSync(BRIDGE, 'utf8')
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*(import|export)/.test(l) && l.includes('buildExperienceIndex'))
  assert.ok(importLines.length >= 2, `import 与 re-export 都应保留，实际: ${JSON.stringify(importLines)}`)
})

// ── Task 5：S4.5③ 字节口径统一 ─────────────────────────────────────────────

test('memoryBytes 按 UTF-8 字节计（中文不得被当成 1 字节）', () => {
  assert.equal(memoryBytes('abc'), 3)
  assert.equal(memoryBytes('中文'), 6, '2 个汉字 = 6 字节（非 2）')
  assert.equal(memoryBytes('中a'), 4)
})

test('memoryBytes 与 Buffer.byteLength 一致（单一真源）', () => {
  for (const s of ['', 'a', '中文', 'emoji🙂']) {
    assert.equal(memoryBytes(s), Buffer.byteLength(s, 'utf8'))
  }
})

test('buildMemoryIndex 的预算按字节判（而非按字符漏报）—— 7 个中文主题 ≤ EL0_MAX_BYTES', () => {
  const root = mkdtempSync(join(tmpdir(), 'mem-buf-'))
  // 7 个主题全为中文（每条 ~2x 字字节差）—— 按"字符"批会低估约一半
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(root, `中文主题${i}.md`),
      `---\nname: 中文主题${i}\nactive: true\n---\n- [会话|标签] 中文主题${i} 的第一条中文条目 -- 全文\n- [会话|标签] 中文主题${i} 的第二条中文条目 -- 全文\n- [会话|标签] 中文主题${i} 的第三条中文条目 -- 全文\n`, 'utf-8')
  }
  const out = buildMemoryIndex({ root, maxBytes: EL0_MAX_BYTES })
  assert.ok(memoryBytes(out) <= EL0_MAX_BYTES,
    `7 个中文主题的 EL0 应 ≤${EL0_MAX_BYTES} B；实际 ${memoryBytes(out)} 字节`)
})
// ── Task 6：S4.5④-1 EL0 主题清单渲染（−4931 B/轮，A14/G3 的载体）──────────────

/** 造记忆根：扁平文件 root/<主题>.md（★ 实测形状：不是目录，也不是 _front.md） */
function mkFlatRoot(themes) {
  const root = mkdtempSync(join(tmpdir(), 'mem-el0-'))
  for (const { theme, active = 'true', entries = 3 } of themes) {
    const lines = ['---', `name: ${theme}`, `description: ${theme}`, `active: ${active}`, '---']
    for (let i = 0; i < entries; i++) lines.push(`- [会话|标签] ${theme} 的第 ${i} 条摘要 -- 全文${i}`)
    writeFileSync(join(root, `${theme}.md`), `${lines.join('\n')}\n`, 'utf8')
  }
  return root
}

test('EL0：输出主题清单形态（- [主题] N 条）', () => {
  const root = mkFlatRoot([{ theme: '经验沉淀', entries: 4 }])
  const text = buildMemoryIndex({ root })
  assert.ok(/^- \[经验沉淀\] 4 条/m.test(text), `应为主题清单形态，实际:\n${text}`)
})

test('A14：EL0 恒在 ≤512 B（7 主题 ≈200 B）', () => {
  const root = mkFlatRoot(Array.from({ length: 7 }, (_, i) => ({ theme: `主题${i}`, entries: 5 })))
  const text = buildMemoryIndex({ root })
  assert.ok(memoryBytes(text) <= EL0_MAX_BYTES, `EL0 应 ≤${EL0_MAX_BYTES} B，实际 ${memoryBytes(text)}`)
  assert.ok(memoryBytes(text) <= EL0_TARGET_BYTES * 2, `应接近目标 ~${EL0_TARGET_BYTES} B，实际 ${memoryBytes(text)}`)
})

test('★ 保留全部主题名 + 条数（不得只留前 N 个 —— spec :475）', () => {
  const themes = Array.from({ length: 40 }, (_, i) => ({ theme: `主题${i}`, entries: i + 1 }))
  const text = buildMemoryIndex({ root: mkFlatRoot(themes) })
  for (const t of themes) assert.ok(text.includes(t.theme), `缺主题名: ${t.theme}`)
  assert.ok(text.includes('40 条'), '应含条数')
})

test('★ EL0 不含条目摘要正文（否则又变回 L2）', () => {
  const text = buildMemoryIndex({ root: mkFlatRoot([{ theme: '经验沉淀', entries: 3 }]) })
  assert.ok(!text.includes('全文0'), 'EL0 不得含条目正文')
  assert.ok(!text.includes('的第 0 条摘要'), 'EL0 不得含条目摘要')
})

test('A16：停用主题不出现在 EL0', () => {
  const root = mkFlatRoot([{ theme: '启用主题' }, { theme: '停用主题', active: 'false' }])
  const text = buildMemoryIndex({ root })
  assert.ok(text.includes('启用主题'))
  assert.ok(!text.includes('停用主题'))
})

test('renderThemeList：lean 档只去日期，不漏主题名与条数', () => {
  const lean = renderThemeList([{ theme: 'A', count: 2, latest: '2026-09-20' }], { lean: true })
  assert.ok(lean.includes('A'))
  assert.ok(lean.includes('2 条'))
  assert.ok(!lean.includes('2026-09-20'))
})

// ── Task 6 附加锁（计划未点名，但改的是"形态"，形态必须有锁）────────────────

test('EL0 保留串头 needle【个人经验索引】（knowledge-inject-e2e 的 NEEDLES 依赖它）', () => {
  const text = buildMemoryIndex({ root: mkFlatRoot([{ theme: 'workflow', entries: 3 }]) })
  assert.ok(text.includes('【个人经验索引】'), 'e2e 断言依赖该串头，EL0 化不得丢')
})

test('EL0 不含任何文件绝对路径（比"路径指向临时目录"更强的隔离）', () => {
  const root = mkFlatRoot([{ theme: 'workflow', entries: 3 }])
  const text = buildMemoryIndex({ root })
  assert.ok(!text.includes(root), 'EL0 不得回显记忆根路径')
  assert.ok(!/[A-Za-z]:[\/]/.test(text), 'EL0 不得含 Windows 绝对路径（原形态的每行 · 路径 已裁掉）')
})

test('EL0 含 0 条主题（主题文件存在但无条目）—— 主题名完整性优先（spec :475）', () => {
  const root = mkFlatRoot([{ theme: '空主题', entries: 0 }, { theme: '有料主题', entries: 2 }])
  const text = buildMemoryIndex({ root })
  // 0 条主题仍列出：模型据此知道"这个主题存在但还没沉淀"，与"库没有这个主题"可区分
  assert.ok(/^- \[空主题\] 0 条/m.test(text), `实际:\n${text}`)
  assert.ok(/^- \[有料主题\] 2 条/m.test(text))
})

test('EL0 空库/无 root 时返回空串（调用方据此判"无注入"，与原行为一致）', () => {
  assert.equal(buildMemoryIndex({ root: '' }), '')
  const empty = mkdtempSync(join(tmpdir(), 'mem-el0-empty-'))
  assert.equal(buildMemoryIndex({ root: empty }), '')
})

test('★ 主题数超过字节上限时**不截断**（主题名完整性 > 字节上限；A14 的边界登记）', () => {
  // 这是**有意**的取舍：spec :475 要求"保留全部主题名"，故 lean 之后不再裁。
  // 代价：主题数 ~15 以上时 lean 输出可能 >512 B ⇒ A14 会被突破（真实库 7 主题 = 254 B，安全）。
  // 本用例把该边界**锁成事实**：将来若改为"前 N 个 + 末行提示剩余"，此测试会红 ⇒ 提醒那是 spec 变更。
  const themes = Array.from({ length: 40 }, (_, i) => ({ theme: `主题${i}`, entries: 1 }))
  const text = buildMemoryIndex({ root: mkFlatRoot(themes) })
  assert.ok(text.split('\n').filter((l) => l.startsWith('- [')).length === 40,
    '40 个主题必须全部出现（不截断）')
  assert.ok(memoryBytes(text) > EL0_MAX_BYTES,
    '该形态确会超 512 B —— 记录下来，便于将来判断 A14 是否被真实数据突破')
})
