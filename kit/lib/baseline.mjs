// kit/lib/baseline.mjs —— 漂移基线：让门禁能在"有历史债"的仓库里当天上线且长期有效
//
// 设计不变量 I4：放行即人工 —— 基线是**独立文件、人工编辑、每条写 reason**。
// 为什么不能放进 sync 自动生成的台账：`sync` 会重写台账，若基线也在里面，
// "跑一次 sync"就等于"把所有问题自动放行"，门禁会被一次同步悄悄架空。
// （同一心智先例：docs/_anchors-allow.json 与自动生成的 docs/_anchors.json 分离。）
//
// 本文件的调用点在 Task 3 的 `check` 接线（kit/cli.mjs）：那里把扫描出的 findings
// 交给 applyBaseline / reportWithBaseline 生成报告，并从 versions.history 取
// recordedCount / recordedRedCount 交给 baselineGrowth 做数量护栏。本任务不接 CLI。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeReport } from './report.mjs'

export const BASELINE_FILE = 'kit/manifest/drift-baseline.json'

/**
 * 基线条目与 finding 的对账键（rule + subject 唯一确定一条欠账）。
 * 用 JSON 数组序列化而不是 `rule + '::' + subject`：后者会让
 * {rule:'A::B', subject:'C'} 与 {rule:'A', subject:'B::C'} 撞成同一个键，
 * 于是"没命中"的 finding 会被别人的条目悄悄放行。
 */
export function keyOf({ rule, subject }) { return JSON.stringify([rule, subject]) }

/**
 * **契约对账类规则不支持基线豁免**（`BASELINE_FORBIDDEN` 红）。
 *
 * ★ 为什么必须有这条（第 4 批收口，审查实测的通路）：第 3 批把"为在途差异加的红灯基线"删掉了
 *   （规则真值改取提交态），但**能力本身还在** —— 审查在 HEAD 上实测：往 `drift-baseline.json` 加一条
 *   `{rule:'CT1', subject:'routes ANY /zzz-red', severity:'red'}` + 把 `baselineCount 5→6 /
 *   baselineRedCount 0→1` ⇒ **EXIT=0**（只多一行「⚠ 基线放行」）。即"删了条目，没关掉通路"，
 *   下次有人可以再走一遍。这里的判据把通路关掉：契约红灯**一律**降不了级。
 *
 * 分类判据（为什么是"除 CT9 外的全部 CT"）：`CT0–CT8` 的红灯语义都是"契约面 与 提交物/登记 不一致"，
 *   处置动作只有三种 —— **修代码 / `npm run kit:sync` / 在 `contract-scope.json` 逐条登记**；
 *   **没有一种**是"记一笔欠账长期放行"（I4「放行即人工且可见」在这里的正确解法是修正契约面本身）。
 *   `CT9` 是例外且正当：它是"渲染层调了后端不存在的端点"的**历史欠账**（黄、只报不拦、D8），
 *   那 5 条基线正是它该有的用法 ⇒ **保留**可豁免。
 *
 * 保守方向：`/^CT/` 前缀 + 白名单 `CT9` ⇒ 将来新增的 CT 号自动落入"禁豁免"（fail-closed）；
 *   契约高亮不因"忘了更新名单"而漏掉。
 */
export const BASELINE_EXEMPT_ALLOWED = ['CT9']
export function baselineForbidden(rule) {
  const r = String(rule == null ? '' : rule)
  return r.startsWith('CT') && !BASELINE_EXEMPT_ALLOWED.includes(r)
}

/**
 * 基线条目必须是**普通对象**。
 * ★ 为什么要单独判形状（Task 2 复审低危项）：`loadBaseline` 初版只校验 `Array.isArray(entries)`，
 *   元素形状不管。人工编辑该文件时写成 `"entries": [null]`（或字符串/数字）是现实路径，
 *   于是 `null.reason` 直接抛 `TypeError: Cannot read properties of null (reading 'reason')` ——
 *   门禁从"报红"变成"崩掉"，与本文件"不能因坏文件崩掉"的声明相反。
 *   数组也不算合法条目：它有 `.reason`（undefined）不会崩，但 `keyOf` 会把
 *   `[undefined, undefined]` 序列化成 `[null,null]`，是"碰巧撞上别人"的隐患。
 */
function isEntryObject(e) { return !!e && typeof e === 'object' && !Array.isArray(e) }

/** 读基线；文件缺失/损坏一律返回空基线（门禁不能因坏文件崩掉） */
export function loadBaseline({ root }) {
  const p = join(root, BASELINE_FILE)
  const empty = { version: 1, _note: '已知漂移登记后不再报红，但条目数不得增加；减少时应摘除条目。', entries: [] }
  if (!existsSync(p)) return empty
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    // ★ 刻意**不**在这里过滤掉非对象元素（"坏元素直接丢掉"看似更省事）：静默丢弃会把
    //   "有人手工把文件写坏了"藏起来，与 I4「放行必须人工且**可见**」相反。
    //   这里原样返回，由 applyBaseline 把每个坏元素显式报成一条 BASELINE_NO_REASON 红灯。
    return { ...empty, ...j, entries: Array.isArray(j.entries) ? j.entries : [] }
  } catch { return empty }
}

/**
 * 套用基线：命中 → 降级为 baselined（附 reason）；未命中的原样保留。
 *
 * ★ 2026-09-19 裁定（spec §7.3 豁免规则）：**基线不得无声抹平红灯**。
 *   初版无条件降级，实测"加一行 JSON 就能把红灯变绿"，且报告首行照样打印「✅ 通过」——
 *   整个门禁可被单行人工编辑绕过，与 I4「放行即人工」的初衷相反
 *   （I4 要的是"人工且**可见**"，不是"人工即可静默"）。
 *   但完全禁止豁免红也不可行：P0 落地时仓库本身有 20 条锁哈希红，红不可豁免则门禁永远绿不了。
 *   故：可豁免，但必须**显式认领 + 始终可见 + 数量封顶**。
 *
 *   规则 1：默认只豁免**黄**。命中红灯时，只有条目显式写了 severity:'red' 才豁免；
 *          没写就不豁免（随手加 {rule,subject,reason} 只能豁免黄）。
 *   规则 2：reason 必填非空。缺失/空白 → 条目**不生效**，并额外报一条红 BASELINE_NO_REASON
 *          （把"I4 无处强制"变成"违反 I4 本身就是红灯"）。
 *   规则 3：降级时记 baselinedFrom（保留原始 severity），报告的"其中红灯 M 条"靠它。
 *   规则 4（第 4 批收口）：**契约对账类规则（CT0–CT8）一律不许降级**，条目本身报一条红
 *          `BASELINE_FORBIDDEN`（"该规则不支持豁免"）—— 见 `baselineForbidden` 的注释：
 *          删条目没关通路时，单行 JSON 人工编辑又能把契约红灯变绿（实测）。`CT9` 保留可豁免。
 */
export function applyBaseline(findings, baseline) {
  const entries = baseline.entries || []
  const valid = []
  const noReason = []
  for (const e of entries) {
    if (isEntryObject(e) && typeof e.reason === 'string' && e.reason.trim() !== '') valid.push(e)
    else noReason.push(e)
  }
  // 规则 4：契约类条目**不生效**（既不降级，也不算"已用"）⇒ 见下面两处分支
  const forbidden = valid.filter((e) => baselineForbidden(e.rule))
  const allowed = valid.filter((e) => !baselineForbidden(e.rule))
  const map = new Map(allowed.map((e) => [keyOf(e), e]))
  const forbMap = new Map(forbidden.map((e) => [keyOf(e), e]))
  const findingsOut = findings.map((f) => {
    const fb = forbMap.get(keyOf(f))
    if (fb) {
      return {
        ...f,
        hint: `${f.hint || ''}（基线里有为它登记的条目，但 **${f.rule} 属契约对账类规则：不支持豁免** ⇒ 条目不生效。`
          + '契约红灯的处置只有三种：修代码 / `npm run kit:sync` / 在 `contract-scope.json` 逐条登记；请删除该条目）'.trim(),
      }
    }
    const e = map.get(keyOf(f))
    if (!e) return f
    // 规则 1：红灯必须有条目显式认领
    const red = f.severity === 'red'
    if (red && e.severity !== 'red') {
      return { ...f, hint: `${f.hint || ''}（基线里登记了该条但未显式认领红灯，故仍报红；确认要豁免请在该条目加 "severity": "red"）`.trim() }
    }
    return { ...f, severity: 'baselined', baselinedFrom: f.severity, reason: e.reason }
  })
  // 规则 2：缺 reason 的条目不生效，本身作为一条红灯
  for (const e of noReason) {
    const o = isEntryObject(e) ? e : {}
    findingsOut.push({
      rule: 'BASELINE_NO_REASON', severity: 'red',
      subject: `${o.rule || '?'} ${o.subject || '?'}`,
      message: '基线条目缺 reason（不变量 I4：放行必须写明理由）—— 该条目已被忽略',
      hint: isEntryObject(e)
        ? '给该条目补上 reason；确属误加则直接删除条目'
        : '该条目不是对象（文件被写坏或手工编辑出错），请改成 {rule, subject, reason} 形状',
    })
  }
  // 规则 4：契约类条目**无条件报红**（即使没有任何 finding 命中它 —— "留着条目"就是留着下次走的通路）
  for (const e of forbidden) {
    findingsOut.push({
      rule: 'BASELINE_FORBIDDEN', severity: 'red',
      subject: `${e.rule} ${e.subject || '?'}`,
      message: `${e.rule} 属契约对账类规则：**不支持基线豁免**（该条目已被忽略，红灯不会被降级）`,
      hint: '契约对账类红灯只能靠修契约面本身消除：修代码 / `npm run kit:sync`（台账按提交态落盘）/ 在 '
        + '`kit/manifest/contract-scope.json` 逐条登记（人工、带 reason）。请删除该条基线；'
        + '（`CT9` 是"渲染层幽灵 fetch"的历史欠账，仍可登记豁免）',
    })
  }
  const present = new Set(findings.map(keyOf))
  const allKeys = [...map.keys(), ...forbMap.keys()]
  // 契约类条目一律不算"已用"：它们不生效 ⇒ 报告里应出现"可摘除"提示（否则会长期挂着装作在挡事）
  const used = allKeys.filter((k) => present.has(k) && !forbMap.has(k))
  const unused = allKeys.filter((k) => !present.has(k) || forbMap.has(k))
  const effective = findingsOut.filter((f) => f.severity !== 'baselined').length
  return { findings: findingsOut, used, unused, ignoredNoReason: noReason.length, forbidden: forbidden.length, effective }
}

/**
 * 套用基线并**重建**报告（renderHuman 路径上的入口）。
 * 为什么必须重建：`summary` 是派生快照 —— 复用旧 report 只替换 findings，
 * summary.red 会停在旧值（红灯计数脏），"绿灯里藏着放行"就会被算错。
 */
export function reportWithBaseline(findings, baseline, opts = {}) {
  return makeReport({ ...opts, findings: applyBaseline(findings, baseline).findings })
}

/**
 * 数量护栏：① 条目总数 ② 其中豁免红灯的条数 —— 均不得超过台账记录值。
 * 没有它，基线会变成"遇红就塞"的垃圾桶，门禁在半年内必然失效。
 * 两条护栏都没超时返回 null；记录值缺失（null/undefined）视为不管。
 */
export function baselineGrowth({ baseline, recordedCount, recordedRedCount }) {
  const entries = baseline.entries || []
  const n = entries.length
  const redN = entries.filter((e) => isEntryObject(e) && e.severity === 'red').length
  const out = { exceeded: null, redExceeded: null, recordedCount, recordedRedCount, count: n, redCount: redN }
  if (recordedCount !== null && recordedCount !== undefined && n > recordedCount) out.exceeded = n
  if (recordedRedCount !== null && recordedRedCount !== undefined && redN > recordedRedCount) out.redExceeded = redN
  if (out.exceeded === null && out.redExceeded === null) return null
  return out
}
