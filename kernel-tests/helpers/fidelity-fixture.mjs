// 保真审计的**真实形态**夹具（2026-09-17）。
//
// 为什么需要它：`auditSummaryFidelity` 的判定基准是"摘要被**明确要求**保留的实质事实"
// （`<key-info>` 契约 = 任务清单 / 文件变更 / 最近决策），而**不是**原文里出现的所有实体
// （旧口径：分母与摘要容量无关 ⇒ 必然饱和 ⇒ 每次压缩都误报，已废弃）。
// 因此测试不能再靠"往文本里塞路径"造实体——必须给引擎真实的 Write/Edit、TodoWrite 与决策文本，
// 否则基准为空、审计走 skipped（不出声）。下面这个 helper 就是干这个的。
import { mustKeepFacts } from '../../kernel/compact.mjs'

/** 由实质事实（文件路径）构造"真实形态"的 covered：Write/Edit + TodoWrite + 决策文本。 */
export function coveredWithFacts(paths, { todos = [], decisions = [], tool = 'Write' } = {}) {
  const content = paths.map((p) => ({
    type: 'tool_use', id: `${tool}:${p}`, name: tool, input: { file_path: p, content: 'x' },
  }))
  if (todos.length) {
    content.push({ type: 'tool_use', id: 'todo:1', name: 'TodoWrite', input: { todos: todos.map((c) => ({ content: c })) } })
  }
  const msgs = [{ role: 'assistant', content }]
  for (const d of decisions) msgs.push({ role: 'assistant', content: [{ type: 'text', text: d }] })
  return msgs
}

/** 该 covered 的判定基准（供测试构造期望值，避免硬编码实体名而耦合实现细节）。 */
export function basisOf(covered) {
  return mustKeepFacts(covered)
}

/** 一组典型工程文件（足够构成有效基准，且都能通过 isSubstantiveFact） */
export const SAMPLE_FILES = [
  'C:/proj/src/lib/alpha.ts',
  'C:/proj/src/lib/beta.ts',
  'C:/proj/kernel/compact.mjs',
  'C:/proj/kernel/health.mjs',
  'C:/proj/shared/knowledge-core.mjs',
  'C:/proj/server/bridge.mjs',
]

/** 更长的一组（用于构造"missing≥3 但 ratio<0.5"的边界档位）；路径之间无子串包含关系 */
export const LONG_FILES = [
  'C:/proj/src/lib/alpha.ts',
  'C:/proj/src/lib/beta.ts',
  'C:/proj/src/lib/gamma.ts',
  'C:/proj/kernel/loop.mjs',
  'C:/proj/kernel/tools.mjs',
  'C:/proj/shared/kb-core.mjs',
  'C:/proj/server/gateway.mjs',
  'C:/proj/electron/preload.cjs',
  'C:/proj/docs/plan.md',
  'C:/proj/tests/unit.test.mjs',
]
