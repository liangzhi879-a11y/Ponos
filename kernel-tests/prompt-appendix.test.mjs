// T1.4（治理计划 2026-10-20-token-context-governance）：附录段详略预算。
//
// 问题（问0）：系统提示里两段"长规则"每请求全量注入 —— 过程文件纪律 1,169 B +
// 经验沉淀指引 ≈1,757 B = 2.9 KB。它们的价值在**阶段收尾那一刻**，却要每一轮付一次钱。
//
// ★ 本任务**默认不压缩**（与 T1.1 不同）：这两段是**行为规则**，不是参考资料。
//   压成"规则见某技能"要求模型去加载那个技能，而技能是否安装、是否被触发都不由这里保证；
//   合规一旦下降，代价是"过程文件又散落回用户项目里"，比省 2.9 KB 贵得多。
//   故只提供机制 + 一行开关（`PONOS_PROMPT_APPENDIX=compact`），默认逐字节保持全文。
//
// 本文件钉住 6 条：
//   ① ★ 缺省（不设 env）逐字节等于全文（存量行为不变）
//   ② ★ 紧凑版必须真的省下 ≥1,000 B（否则机制等于没做）
//   ③ ★ 紧凑版必须保留**过程目录真实路径**（否则"往哪放"变成空话，规则不可执行）
//   ④ ★ 紧凑版必须保留**沉淀命令**与"别用 Write/Edit 改经验库"的禁令（错了会破坏用户记忆库）
//   ⑤ 紧凑版不得出现重复括号/重复段（拼接 bug 的形态）
//   ⑥ chat 模式两段都不注入（既有隔离语义不变）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPromptAppendix, compactProcessHygieneRuleText, compactSedimentInstruction,
} from '../kernel/prompt-appendix.mjs'
import { processHygieneRuleText } from '../shared/process-artifacts.mjs'
import { buildSedimentInstruction } from '../kernel/memory.mjs'

const b = (s) => Buffer.byteLength(String(s || ''), 'utf8')

test('① 缺省（mode 为空）逐字节等于全文（存量行为不变）', () => {
  const themes = ['workflow']
  const full = buildPromptAppendix({ mode: '', themes })
  assert.equal(full.compact, false)
  assert.equal(full.hygiene, processHygieneRuleText(), '过程纪律必须逐字节等于真源')
  assert.equal(full.sediment, buildSedimentInstruction({ themes }), '沉淀指引必须逐字节等于真源')
  // 任何非 'compact' 的取值都走全文（不做模糊匹配：那是隐式行为变更）
  for (const mode of ['full', 'FULL', '1', 'Compact', 'compact ']) {
    assert.equal(buildPromptAppendix({ mode, themes }).compact, false, `mode=${JSON.stringify(mode)} 不应开启紧凑`)
  }
})

test('★ ② 紧凑版必须真的省下 ≥1,000 B', () => {
  const themes = ['workflow', 'policy', 'project-application']
  const full = buildPromptAppendix({ mode: '', themes })
  const comp = buildPromptAppendix({ mode: 'compact', themes })
  assert.equal(comp.compact, true)
  const saved = (b(full.hygiene) + b(full.sediment)) - (b(comp.hygiene) + b(comp.sediment))
  assert.ok(saved >= 1_000, `实测只省 ${saved} B，不足 1,000 B（否则本任务等于没做）`)
})

test('★★ ③ 紧凑版必须保留过程目录真实路径（规则要可执行）', () => {
  const full = processHygieneRuleText()
  // 真源里的目录路径形如 `.ponos/process/`
  const m = full.match(/`.+?`/)
  assert.ok(m, '夹具自检：真源里应有反引号包裹的路径')
  const comp = compactProcessHygieneRuleText()
  assert.ok(comp.includes('`.ponos/process/'), `★ 紧凑版必须含过程目录路径（实测：${comp.slice(0, 80)}…）`)
  assert.match(comp, /阶段名/, '必须仍说明阶段名怎么起（否则目录结构无法自解释）')
})

test('★★ ④ 紧凑版必须保留沉淀命令与"别用 Write/Edit 改经验库"的禁令', () => {
  const comp = compactSedimentInstruction({ themes: ['workflow'] })
  assert.match(comp, /--knowledge append/, '★ 必须保留可执行的 append 命令（否则"沉淀"是无法执行的口号）')
  assert.match(comp, /--text/, '必须保留 --text 的格式要求')
  assert.match(comp, /--theme/, '必须保留 --theme 可选值')
  assert.match(comp, /不要用 Write\/Edit 去改经验库/, '★ 这条禁令错了会破坏用户记忆库，必须保留')
  assert.match(comp, /严禁写入密钥/, '敏感信息禁令必须保留（合规红线）')
})

test('⑤ 紧凑版不得出现重复括号/重复段（拼接 bug 的形态）', () => {
  const comp = compactProcessHygieneRuleText()
  // 实测踩过：只替换前缀会留下"过程物（…）（…）"两串括号
  assert.equal(/）（/.test(comp), false, `紧凑版出现连续括号，疑似拼接 bug：${comp}`)
  assert.equal((comp.match(/过程物/g) || []).length, 1, '「过程物」只应出现一次')
})

test('⑥ chat 模式两段都不注入（既有隔离语义不变）', () => {
  const r = buildPromptAppendix({ mode: 'compact', themes: ['workflow'], skipHygiene: true, skipSediment: true })
  assert.equal(r.hygiene, '')
  assert.equal(r.sediment, '')
  // 空 themes 时沉淀指引仍可用（回落到内置主题），不抛
  assert.ok(compactSedimentInstruction({}).length > 0)
})
