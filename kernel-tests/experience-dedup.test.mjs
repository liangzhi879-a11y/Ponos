// kernel-tests/experience-dedup.test.mjs —— 经验供给 A16/A18/A20（逐 Task 追加）
// Task 3 先行：active 过滤（写入侧 = 服务端读取侧都早已就绪，**真实缺口**是内核注入侧）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemoryIndex, buildRelevantMemory } from '../kernel/memory.mjs'

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