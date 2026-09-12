// 内核【可用技能】块行为基线测试（S5 T1 ②-03 技能清单去重）
// ---------------------------------------------------------------------------
// 背景：bridge 宿主 appendSkillList 注入停用后（D1），技能清单唯一来源 =
// 内核 composeSystemPrompt【可用技能】块（技能根经 --add-dir 发现）。本测试
// 先行跨层 import ../kernel/prompt.mjs 锁住内核技能块行为（review-task5
// minor#3 已认可该受控 touchpoint），无论宿主后续如何改动，内核技能可见性
// 基线不变。纯函数测试：无 spawn、无网络、无真实 home，PONOS_MOCK_API 无需。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeSystemPrompt } from '../kernel/prompt.mjs'

// 最小技能集：父技能（带触发词与子技能）、无触发词子技能、独立技能、描述兜底独立技能
const SAMPLE_SKILLS = [
  { id: 'suite-parent', triggers: ['整理', '归档'], description: '套件父技能' },
  { id: 'child-a', triggers: ['子场景 a'], parent: 'suite-parent' },
  { id: 'child-b', triggers: [], description: '无触发词子技能', parent: 'suite-parent' },
  { id: 'standalone', triggers: ['独立场景'] },
  { id: 'desc-fallback', triggers: [], description: '用描述兜底的独立技能' },
]

test('技能块：skills 非空 → 输出含【可用技能】块，父条目内联子技能、触发词/描述入列', () => {
  const out = composeSystemPrompt({ toolNames: [], skills: SAMPLE_SKILLS })
  // 块头存在
  assert.match(out, /【可用技能】任务与以下技能匹配时，用 Skill 工具调用对应技能/)
  // 父技能条目：id + 触发词 + 父子内联（触发词 '、' 连接，子技能全量内联）
  assert.ok(out.includes('- suite-parent：整理、归档（子：child-a、child-b）'), '父条目应内联触发词与全部子技能')
  // 子技能不得单独成条（行首 token 不得为子 id）
  assert.ok(!/^- child-a：/m.test(out), '子技能 child-a 不得独立成条')
  assert.ok(!/^- child-b：/m.test(out), '子技能 child-b 不得独立成条')
  // 独立技能单独成条（触发词入列）
  assert.ok(out.includes('- standalone：独立场景'), '独立技能条目应含触发词')
  // 触发词为空 → 描述回退入列
  assert.ok(out.includes('- desc-fallback：用描述兜底的独立技能'), '无触发词技能应回退描述')
  // 整块位于系统提示内部（基础层仍在）
  assert.match(out, /你是 Ponos 的 AI 助手/)
})

test('技能块：skills 为空/缺省 → 不产出【可用技能】块', () => {
  const empty = composeSystemPrompt({ toolNames: [], skills: [] })
  assert.ok(!empty.includes('【可用技能】'), 'skills=[] 时不应产出技能块')
  const omitted = composeSystemPrompt({ toolNames: [] })
  assert.ok(!omitted.includes('【可用技能】'), 'skills 缺省（默认 []）时不应产出技能块')
})

// 【技能与编排】主动性区块（2026-09-12 触发侧修复）：技能"何时该用"的判据此前只存在于
// SKILL.md 正文（调用后才加载）⇒ 自发触发率≈0。判据必须落在无需调用即可见的位置。
test('技能与编排：skills/subagents 非空 → 区块出现在清单之前；两者皆空 → 不出现', () => {
  const both = composeSystemPrompt({ toolNames: [], skills: SAMPLE_SKILLS, subagents: [{ id: 'implementer', description: '实现者' }] })
  assert.match(both, /【技能与编排】/, '有技能或子 Agent 时应注入主动性区块')
  assert.ok(both.includes('先用 Skill 工具加载该技能'), '应含技能加载判据')
  assert.ok(both.includes('用 Agent 工具委派子 Agent'), '应含子 Agent 委派判据')
  assert.ok(both.indexOf('【技能与编排】') < both.indexOf('【可用技能】'),
    '区块必须在清单之前（先规则后清单）')
  // 只有子 Agent（无技能清单）→ 不得出现技能加载指引（chat 隔离的同源判据）
  const onlyAgents = composeSystemPrompt({ toolNames: [], subagents: [{ id: 'implementer', description: '实现者' }] })
  assert.match(onlyAgents, /【技能与编排】/)
  assert.ok(!onlyAgents.includes('先用 Skill 工具加载该技能'), '无技能清单时不得引导 Skill 工具')
  const neither = composeSystemPrompt({ toolNames: [] })
  assert.ok(!neither.includes('【技能与编排】'), '两者皆空时不应产出该区块')
  assert.ok(!neither.includes('Agent 工具委派'), '无子 Agent 时不得引导委派')
})

// —— lean 纪律段（2026-09-09 本地弱模型适配，P2）——
// 口径：只剪有引擎守卫兜底的细则；功能协议核心（工具纪律 6 条、回复规范、
// 可用工具列表、技能块）一字不动。缺省 tier 输出与改动前逐条相等（零回归锁）。
test('lean：tier=lean 保留功能核心，删除有守卫兜底的细则', () => {
  const out = composeSystemPrompt({ toolNames: ['Bash', 'Read'], tier: 'lean' })
  // 保留：身份、工具纪律 6 条、回复规范、可用工具列表
  assert.match(out, /你是 Ponos 的 AI 助手/)
  assert.ok(out.includes('修改文件前先 Read 读取确认现状'))
  assert.ok(out.includes('编辑用 Edit，old_string 需精确且唯一'))
  assert.ok(out.includes('工具结果如实反映，失败时报告错误信息，不编造结果。'))
  assert.ok(out.includes('【回复规范】'))
  assert.ok(out.includes('回答直接、简洁、专业'))
  assert.ok(out.includes('可用工具：Bash, Read。'))
  // 删除：GBK 细则、TodoWrite 长句、命令合并、探索与动手分离（有引擎守卫兜底）
  assert.ok(!out.includes('GBK'), 'lean 应删除 GBK 乱码细则')
  assert.ok(!out.includes('TodoWrite'), 'lean 应删除 TodoWrite 长句')
  assert.ok(!out.includes('命令合并'), 'lean 应删除命令合并细则')
  assert.ok(!out.includes('探索与动手分离'), 'lean 应删除探索与动手分离细则')
  // 精简后明显变短（< full 的 70%）
  const full = composeSystemPrompt({ toolNames: ['Bash', 'Read'] })
  assert.ok(out.length < full.length * 0.7, `lean 应显著精简（${out.length} vs ${full.length}）`)
})

test('lean：tier 缺省（full）输出与历史基线逐条相等（云端零回归锁）', () => {
  // 与改动前 buildBaseSystemPrompt 的原文逐条核对：全部纪律条目仍在且位置顺序一致
  const out = composeSystemPrompt({ toolNames: [] })
  const expectOrder = [
    '你是 Ponos 的 AI 助手',
    '【工具纪律】',
    '修改文件前先 Read 读取确认现状',
    '编辑用 Edit，old_string 需精确且唯一',
    '查找文件路径用 Glob',
    '并行调用：',
    'Bash 输出可能被截断',
    '工具结果如实反映',
    '【任务轮次纪律】',
    '计划尾巴',
    '不允许认错即停',
    '长任务每步落地',
    'GBK',
    '【探索纪律】',
    '动手前先完整理解任务：一次读清',
    '搜索精准：',
    '信息一次取足：',
    '【改动聚焦】',
    '最小改动：只修改完成任务必需的文件（任务描述明确文件范围时优先遵循）',
    '收敛范围：',
    '复杂任务先规划：',
    '探索只用专用工具：',
    '命令合并：',
    '探索与动手分离：',
    '【回复规范】',
    '回答直接、简洁、专业',
    '引用代码时标注 file_path:line',
    '需要用户决策时列出选项',
  ]
  let pos = -1
  for (const s of expectOrder) {
    const i = out.indexOf(s)
    assert.ok(i > pos, `full 基线条目顺序错乱或缺失：${s.slice(0, 30)}`)
    pos = i
  }
})
