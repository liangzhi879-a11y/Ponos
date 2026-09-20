// kit/lib/agent-entry-rules.mjs —— CT11：agent 自动注入入口 ↔ 真源一致
//
// 为什么需要这条规则（真事）：
//   入口文件（仓根 `AGENTS.md`）是"规范不必靠 agent 自觉去找"的那一层 —— 多数 agent 工具开工时**自动读它**，
//   Ponos 内核自己也自动发现它（`kernel/prompt.mjs#discoverAgentsMd`：从 cwd 逐级向上直到 `.git` 所在目录，
//   外加 `--add-dir` 的根）。但它此前**只存在于会话提示词的口头描述里，真源零登记、无任何校验** ⇒
//   改了真源而忘改入口**不会红** —— 与 `versions.json#lines[].label` 当初"无门禁、标签与口径正面冲突却永远不红"
//   是**同一类漏洞**（本仓 P1 批刚修过那一处）。CT11 就是把这个缺口堵上。
//
// 判据（全部读**提交态**，与 CT0–CT10 同口径）：
//   ① **fail-closed**：入口文件读不到 ⇒ 红（入口消失 = 规范失去自动送达的那一层，不是"没问题"）。
//   ② **必备锚点**：真源 `entry.mustMention[]` 里每条 `contains` 都必须在入口里出现；
//      缺哪条 ⇒ 一条红，并说明"为什么需要它"（人话，来自真源，不在规则里另写一份理由）。
//   ③ **不许长成第二份清单**：行数 > `entry.maxLines` ⇒ 红。
//      ★ 这是"单一真源"的结构性保障：入口一长，就必然把真源的内容抄一份，两份必然漂移。
//   ④ `evaluated` **如实**：= 实际核过的锚点数（健康态 = `mustMention.length`），
//      不许在"一条都没核到"时报成"全都通过"。
//
// 基线：`BASELINE_FORBIDDEN` 的判据是"除 CT9 外全部 CT" ⇒ CT11 自动**不可豁免**（刻意如此：
//   入口是给 agent 看的第一手材料，不许靠加一条基线蒙过去）。

import { RED, finding, checkResult } from './report.mjs'
import { AGENT_GUIDE } from './agent-guide.mjs'

/** 入口文件的默认路径（相对仓根）。真源登记了它 —— 这里只做"没登记"时的兜底。 */
export const DEFAULT_ENTRY_FILE = 'AGENTS.md'

/**
 * CT11 判据。
 *
 * @param {object} p
 * @param {(rel:string)=>string|null} p.readTracked  读**提交态**文件（读不到返回 null / 抛错都被兜住）
 * @param {object} [p.guide]                        真源（默认 `AGENT_GUIDE`，测试可注入夹具）
 * @returns {{check:object, findings:object[]}}
 */
export function agentEntryCheck({ readTracked, guide = AGENT_GUIDE } = {}) {
  const entry = guide && guide.entry ? guide.entry : {}
  const file = entry.file || DEFAULT_ENTRY_FILE
  // ★ 真源没登记入口 = 真源自己残缺（另一处"无门禁"漏洞）⇒ 红，而不是静默用兜底值放过去
  const anchors = Array.isArray(entry.mustMention) ? entry.mustMention.filter((m) => m && m.id && m.contains) : []
  const maxLines = Number.isInteger(entry.maxLines) && entry.maxLines > 0 ? entry.maxLines : null

  const findings = []
  const read = (f) => { try { return typeof readTracked === 'function' ? readTracked(f) : null } catch { return null } }
  const text = read(file)

  if (text === null || text === undefined) {
    findings.push(finding({
      rule: 'CT11', severity: RED, subject: 'entry-missing', file, line: null,
      expected: `仓根存在 ${file}（agent 开工时自动读的入口）`,
      actual: '（读不到：提交态里没有这个文件）',
      hint: `把 ${file} 补回**仓库根**（★ 子目录无效：工具只看根）；入口只放"入口 + 红线 + 坑"，`
        + `完整清单在 ${'kit/lib/agent-guide.mjs'}（\`npm run kit:agent\` 可打印）。`
        + `★ 若确实要改名/搬位置，改真源 \`entry.file\` 而不是绕过门禁。`,
    }))
    return {
      check: checkResult({
        rule: 'CT11', title: 'agent 自动注入入口与真源一致（规范能被自动送达）',
        evaluated: 0, passed: false,
      }),
      findings,
    }
  }

  const lines = text.split('\n')
  const missing = []
  for (const a of anchors) {
    if (!text.includes(a.contains)) {
      missing.push(a)
      findings.push(finding({
        rule: 'CT11', severity: RED, subject: a.id, file, line: null,
        expected: `入口里应出现锚点文本：${JSON.stringify(a.contains)}`,
        actual: '（入口里找不到这段文本）',
        hint: `${a.why || '（真源未写 why）'}`
          + ` ⇒ 把这条补进 ${file}（一句话即可），或在真源 \`entry.mustMention\` 里说明为什么不再需要它。`,
      }))
    }
  }

  if (maxLines !== null && lines.length > maxLines) {
    findings.push(finding({
      rule: 'CT11', severity: RED, subject: 'entry-too-long', file, line: null,
      expected: `行数 ≤ ${maxLines}（入口要短）`,
      actual: `${lines.length} 行`,
      hint: `${entry.maxLinesWhy || '入口写长会变成第二份清单。'}`
        + ` ⇒ 把细节挪进真源（\`kit/lib/agent-guide.mjs\`），入口只留"入口 + 红线 + 坑"。`,
    }))
  }

  // ★ 入口必须能随"更新"进入**便携版（调试版）**。用户口径：人工测试跑的就是 release 里的便携版，
  //   "确保调试版更新了不会掉"。实测此前**完全没保障**：`AGENTS.md` 不在任何同步清单里
  //   ⇒ 便携版从来没有入口、调试版里的 agent 静默地不受规范约束（症状是"从来没有过"，不是"掉了"）。
  //   这里核"清单里还有它" ⇒ 谁把清单项删掉就红（不然"不会掉"全凭人记）。
  const syncPaths = Array.isArray(entry.portableSync?.paths) ? entry.portableSync.paths.filter((p) => p && p.file) : []
  let syncedChecked = 0
  if (!syncPaths.length) {
    findings.push(finding({
      rule: 'CT11', severity: RED, subject: 'no-portable-sync', file: 'kit/lib/agent-guide.mjs', line: null,
      expected: '真源 `entry.portableSync.paths[]` 至少有 1 条（入口要能随更新进便携版）',
      actual: '（0 条）',
      hint: '为 0 时本判据会**恒真通过**（扫 0 条也报通过）⇒ 至少登记"打包同步 + 启动 autoSync"这两条路径。',
    }))
  }
  for (const p of syncPaths) {
    const body = read(p.file)
    if (body === null || body === undefined) {
      findings.push(finding({
        rule: 'CT11', severity: RED, subject: `portable-sync-missing:${p.file}`, file: p.file, line: null,
        expected: `文件存在且清单里含 ${(p.mustContain || []).join(' / ')}`,
        actual: '（读不到这个文件）',
        hint: `${p.what || ''} —— 文件不见了，说明这条路已失效；★ 入口进不了便携版，调试版里的 agent 就静默不受约束。`,
      }))
      continue
    }
    syncedChecked += 1
    for (const needle of p.mustContain || []) {
      if (!body.includes(needle)) {
        findings.push(finding({
          rule: 'CT11', severity: RED, subject: `portable-sync:${p.file}`, file: p.file, line: null,
          expected: `清单里应含 ${JSON.stringify(needle)}`,
          actual: '（文件里找不到这段文本）',
          hint: `${p.what || ''} —— ★ 删掉它 = 调试版（人工测试环境）里不再有 agent 入口，`
            + '而且**症状是静默的**（面板上看不出来）。若确实要改成别的机制，改真源 `entry.portableSync`。',
        }))
      }
    }
  }

  // ★ `pending[]` = 条件判据（比"登记成 todo 等人去做"强）：文件**还没入库**时跳过（不计 evaluated、
  //   不报红 —— 否则未跟踪文件会让门禁永远红，而"永远红"等于没有红灯）；
  //   一旦该文件**出现在提交态**（入库了），就**自动**开始核它的 `mustContain` ⇒ 无需人工记得"补登记"。
  for (const p of Array.isArray(entry.portableSync?.pending) ? entry.portableSync.pending : []) {
    if (!p || !p.file) continue
    const body = read(p.file)
    if (body === null || body === undefined) continue // 未入库：跳过（这正是 pending 的语义）
    syncedChecked += 1
    for (const needle of p.mustContain || []) {
      if (!body.includes(needle)) {
        findings.push(finding({
          rule: 'CT11', severity: RED, subject: `portable-sync:${p.file}`, file: p.file, line: null,
          expected: `清单里应含 ${JSON.stringify(needle)}`,
          actual: '（文件里找不到这段文本）',
          hint: `${p.what || ''} —— ★ 这个文件已经入库（能从提交态读到），所以 pending 已转为正式判据：`
            + '把入口留在清单里；若确实要换机制，改真源 `entry.portableSync`。',
        }))
      }
    }
  }

  // ★ 反向：真源登记了锚点却一条都没核到（例如 mustMention 被清空）⇒ 红。
  //   否则"锚点列表为空"会变成**恒真通过**（扫 0 条、报 passed=true）—— 本仓反复强调要防的做假形态。
  if (anchors.length === 0) {
    findings.push(finding({
      rule: 'CT11', severity: RED, subject: 'no-anchors', file: 'kit/lib/agent-guide.mjs', line: null,
      expected: '真源 `entry.mustMention[]` 至少有 1 条锚点',
      actual: '（0 条）',
      hint: '锚点列表为空时本规则会变成**恒真通过**（扫 0 条也报通过）⇒ 至少登记"必须指向真源"这一条。',
    }))
  }

  return {
    check: checkResult({
      rule: 'CT11', title: 'agent 自动注入入口与真源一致（规范能被自动送达，且能进便携版）',
      // 如实：实际核过的检查点数（必备锚点 + 便携版同步路径；健康态 = 真源登记数之和）
      evaluated: anchors.length + syncedChecked,
      passed: findings.length === 0,
    }),
    findings,
  }
}
