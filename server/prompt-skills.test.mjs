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
