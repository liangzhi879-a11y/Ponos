// kernel/candidate-facts.mjs —— 候选**事实行**的唯一实现（2026-10-14 抽出）。
//
// 为什么抽成独立模块：起草（draft-intent）与评审（review-prompt）都要把候选的实测数字给模型看，
// 而这正是"模型有没有依据"的分水岭。此前只有评审侧有（`review-prompt.mjs#renderFacts`），
// 起草侧只给"命中 N 次" ⇒ agent 只能**自己去扫转录**重算（实测：一个起草任务跑了 82 步、
// 自己扫 30 天 jsonl 数出 816 次 Bash 失败）。同一份事实两处各算一遍必然漂移 ⇒ 收成一处。
//
// 纪律：
//  · **纯函数**、零 IO、无时钟、无随机（同输入逐字同输出 ⇒ 可单测）；
//  · **语言中立**（`key=value`）：内核不出自然语言文案（文案在前端 i18n），数字与标识符跨语言可读。

/**
 * 把候选 metrics 渲染成**语言中立的事实清单**（`key=value`，空格分隔）。
 *
 * @param {object} candidate 候选行
 * @returns {string} 如 `rule=OPP-1 subject=WebFetch failures=54 calls=143 errRate=37.8% multiple=9.4`
 *                   无任何可用事实时返回 `（无可用事实）`（**不编**）。
 */
export function renderFacts(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {}
  const m = (c.metrics && typeof c.metrics === 'object' && !Array.isArray(c.metrics)) ? c.metrics : {}
  const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(1)}%` : null)
  // 顺序固定（同输入逐字同输出）；null/空值跳过（不给模型看一堆 `x=null`）
  const pairs = [
    ['rule', typeof c.ruleId === 'string' ? c.ruleId : null],
    ['subject', typeof c.subject === 'string' && c.subject ? c.subject : null],
    ['hits', Number.isFinite(Number(c.count)) ? Number(c.count) : null],
    ['score', Number.isFinite(Number(c.score)) ? Number(c.score) : null],
    ['sessions', Number.isFinite(Number(m.sessions)) ? Number(m.sessions) : null],
    ['activeSessions', Number.isFinite(Number(m.activeSessions)) ? Number(m.activeSessions) : null],
    ['failures', Number.isFinite(Number(m.failures)) ? Number(m.failures) : null],
    ['calls', Number.isFinite(Number(m.calls)) ? Number(m.calls) : null],
    ['errRate', pct(m.errRate)],
    ['baselineRate', pct(m.baselineRate)],
    ['multiple', Number.isFinite(Number(m.multiple)) ? Number(m.multiple) : null],
    ['tool', typeof m.toolName === 'string' ? m.toolName : null],
    ['toolList', Array.isArray(m.tools) && m.tools.length ? m.tools.map(String).join('+') : null],
    ['distinctTools', Number.isFinite(Number(m.distinctTools)) ? Number(m.distinctTools) : null],
    ['avgCalls', Number.isFinite(Number(m.avgCalls)) ? Number(m.avgCalls) : null],
    ['session', typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : null],
    ['stallHeals', Number.isFinite(Number(m.stallHeals)) ? Number(m.stallHeals) : null],
    ['errorStreakMax', Number.isFinite(Number(m.errorStreakMax)) ? Number(m.errorStreakMax) : null],
    ['maxSimilarity', Number.isFinite(Number(m.maxSimilarity)) ? Number(m.maxSimilarity) : null],
  ]
  const out = pairs.filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}=${v}`)
  return out.length ? out.join(' ') : '（无可用事实）'
}
