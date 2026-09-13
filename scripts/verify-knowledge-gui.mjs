// scripts/verify-knowledge-gui.mjs —— S2 知识 GUI 静态校验（spec §5/§8、计划 Task 10）
//
// 只校验"机器能判"的硬约束：裸 hex / emoji / 行数预算 / 数据层纪律。
// 视觉与交互（四视图、四主题回归、只读空间禁用、跳转高亮…）本仓库无 DOM 测试环境，
// 属人工走查，清单见 .superpowers/sdd/2026-09-13-knowledge-core-S1/s2-task-10-report.md。
//
// 失败即退出码 1（供 CI/主控串联）。**不要为了让本脚本通过而放宽这里的正则或阈值**：
// 超标就改代码（spec §11.3 已把"无校验脚本"列为验收缺口，本脚本即为补上）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

/** 行数按 `wc -l` 口径（末尾换行不算一行）——先去掉结尾换行再数，否则每个文件都被多算 1 行 */
const countLines = (src) => src.replace(/\r?\n$/, '').split('\n').length
const rel = (p) => p.slice(ROOT.length + 1).split('\\').join('/')

const ROOT = process.cwd()
const KB_DIR = join(ROOT, 'src/components/knowledge')

/** 递归收集 .ts/.tsx（图谱视图有 graph/ 子目录，漏掉子目录等于漏检） */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p, out); continue }
    if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// 颜色硬约束：颜色一律走 themes.css 的 CSS 变量，组件内不得出现字面 hex。
// 3/6/8 位都拦（#fff / #ffffff / #ffffffcc）——只拦 6 位会漏掉简写与带 alpha 的写法。
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g

// emoji 硬约束（spec §5「lucide only，禁 emoji」）。范围取"默认就是图形表情"的区块：
//   1F000-1FAFF 表情/图形/交通等主体区、2600-27BF 杂项符号与装饰符、2B00-2BFF 补充箭头符号、
//   FE0F/20E3 变体选择符与键帽、E0020-E007F 标签字符。
// **刻意不含 2190-21FF（← → ⇒）**：中文注释里用箭头示意数据流是仓库既有风格（十余处），
// 那是排版符号不是 emoji，拦它只会逼出无意义的注释改写。
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}]/u

const KB_LINE_LIMIT = 400
const PANEL_LINE_LIMIT = 200

const files = walk(KB_DIR)
check(files.length > 0, `发现知识组件 ${files.length} 个文件（${rel(KB_DIR)}）`)

for (const f of files) {
  const r = rel(f)
  const src = readFileSync(f, 'utf-8')
  const hex = src.match(HEX_RE)
  check(!hex, `无裸 hex：${r}${hex ? ` → ${[...new Set(hex)].join(' ')}` : ''}`)
  const emoji = src.match(EMOJI_RE)
  check(!emoji, `无 emoji：${r}${emoji ? ` → ${[...new Set(emoji)].join(' ')}` : ''}`)
  const lines = countLines(src)
  check(lines <= KB_LINE_LIMIT, `行数 ≤ ${KB_LINE_LIMIT}：${r}（${lines} 行）`)
}

// 宿主面板单独收紧到 200 行（spec §8：防巨石面板 —— SkillsPanel 693 行的教训）
const panelPath = join(KB_DIR, 'KnowledgePanel.tsx')
check(existsSync(panelPath), 'KnowledgePanel.tsx 存在')
if (existsSync(panelPath)) {
  const n = countLines(readFileSync(panelPath, 'utf-8'))
  check(n < PANEL_LINE_LIMIT, `KnowledgePanel.tsx < ${PANEL_LINE_LIMIT} 行（实际 ${n} 行）`)
}

// S2 Task 10：经验面板简化目标 ≤ 200 行（spec §10 D4）
const expPath = join(ROOT, 'src/components/settings/ExperiencePanel.tsx')
check(existsSync(expPath), 'ExperiencePanel.tsx 存在')
if (existsSync(expPath)) {
  const n = countLines(readFileSync(expPath, 'utf-8'))
  check(n <= PANEL_LINE_LIMIT, `ExperiencePanel.tsx ≤ ${PANEL_LINE_LIMIT} 行（实际 ${n} 行）`)
}

// 数据层纪律：知识组件不得自己 fetch —— 必须走 src/lib/knowledgeApi.ts / src/hooks/useKnowledge.ts
// （超时、错误整形、缓存失效都在那两处；组件里裸 fetch 会绕过它们，是重复实现的开端）
for (const f of files) {
  check(!/\bfetch\s*\(/.test(readFileSync(f, 'utf-8')), `不裸 fetch：${rel(f)}`)
}

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
