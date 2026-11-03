// kernel/prompt-appendix.mjs —— 附录段（append 通道）的详略预算（T1.4，2026-10-20）
// ---------------------------------------------------------------------------
// 问题（问0）：系统提示里有两段"长规则"是**每请求全量注入**的：
//   · 过程文件纪律（实测 1,169 B，`shared/process-artifacts.mjs#processHygieneRuleText`）
//   · 经验沉淀指引（实测 ≈1,757 B，`kernel/memory.mjs#buildSedimentInstruction`）
// 合计 ≈2.9 KB。它们的价值在**阶段收尾那一刻**，却要每一轮都付一次钱。
//
// ★ 为什么**默认不压缩**（与本计划其它任务不同）：
//   这两段是**行为规则**，不是参考资料。压成一句话"规则见 Skill X"要求模型去加载那个技能
//   ——而技能是否安装、是否被触发，都不由这里保证。合规一旦下降，代价是"过程文件又散落回
//   用户项目里"，那比省 2.9 KB 贵得多。故本任务只提供**机制 + 一行开关**，默认保持全文，
//   由使用者在确认合规不受影响后再开。
//
// ★ 开关：`PONOS_PROMPT_APPENDIX=compact` ⇒ 用紧凑版（保留可执行的**关键命令与禁令**，
//   只压缩解释性文字）；缺省 / 其它值 ⇒ 逐字节保持全文。回退只需去掉这个环境变量。
//
// ★ 紧凑版**必须**保留的三件事（有可红断言）：
//   ① 过程目录的实际路径（否则模型不知道往哪放，规则变成空话）；
//   ② 沉淀命令（否则"沉淀"变成一句无法执行的口号）；
//   ③ "不要用 Write/Edit 改经验库"的禁令（这条错了会破坏用户记忆库）。

import { processHygieneRuleText } from '../shared/process-artifacts.mjs'
import { buildSedimentInstruction } from './memory.mjs'

/** 紧凑版过程纪律：只留"放哪 + 不许动什么"（解释性文字去掉） */
export function compactProcessHygieneRuleText() {
  // 直接对全文做"取前两条要点"以外的重建 —— 但**目录路径必须与真源同源**：
  // 从真源全文里把带路径的第一条原样抠出来，避免在这里重写一份路径常量（两处必漂移）。
  const full = processHygieneRuleText()
  const lines = full.split('\n')
  const head = lines[0]                                   // 【过程文件纪律（阶段收尾）】
  const withPath = lines.find((l) => l.includes('`') && l.includes('阶段名')) || ''
  return [
    head,
    // 原样保留"放哪"那条（含真源路径）—— 这是规则可执行的前提；只把开头的冗长定语压掉，
    // **不能只替换前缀**（那会留下两串括号："过程物（…）（…）"，实测踩过）
    withPath.replace(/- 你为完成任务临时写的\*\*过程物\*\*（[^）]*）/, '- 过程物（探针脚本/日志/临时导出）'),
    '- 交付物留在用户指定位置；**禁止**移动或删除用户原有文件、git 已跟踪文件、非本次任务产出物（归集只移动不删除）。',
    '- 阶段收尾前自检项目根一层：`tmp-*`、`*-probe.*`、`*.log`、`verify-*.mjs` 等移入过程目录。',
  ].filter(Boolean).join('\n')
}

/** 紧凑版沉淀指引：保留命令 + 主题 + 禁令，去掉逐条举例与说明 */
export function compactSedimentInstruction({ themes = [] } = {}) {
  const full = buildSedimentInstruction({ themes })
  const lines = full.split('\n')
  const marker = lines[0]                                  // 空行
  const head = lines.find((l) => l.includes('用 Bash 执行下面的命令')) || ''
  const cmdLines = []
  let inCmd = false
  for (const l of lines) {
    if (l.startsWith('node ') || l.startsWith('"') || l.startsWith('--')) { inCmd = true; cmdLines.push(l); continue }
    if (inCmd && l.trim() === '') break
  }
  const themeLine = lines.find((l) => l.startsWith('--theme 从这些主题')) || ''
  const fmtLine = lines.find((l) => l.startsWith('--text 的格式')) || ''
  const forbid = lines.find((l) => l.includes('不要用 Write/Edit 去改经验库')) || ''
  const sensitive = lines.find((l) => l.startsWith('严禁写入密钥')) || ''
  return [marker, head, ...cmdLines, themeLine, fmtLine, sensitive, forbid].filter((l) => l !== undefined).join('\n')
}

/**
 * 取本轮的附录段文本（过程纪律 + 沉淀指引），按 `mode` 选详略。
 *
 * @param {{mode?: string, themes?: string[], skipHygiene?: boolean, skipSediment?: boolean}} [p]
 * @returns {{hygiene: string, sediment: string, compact: boolean}}
 */
export function buildPromptAppendix({ mode = '', themes = [], skipHygiene = false, skipSediment = false } = {}) {
  const compact = mode === 'compact'
  return {
    compact,
    hygiene: skipHygiene ? '' : (compact ? compactProcessHygieneRuleText() : processHygieneRuleText()),
    sediment: skipSediment ? '' : (compact ? compactSedimentInstruction({ themes }) : buildSedimentInstruction({ themes })),
  }
}
