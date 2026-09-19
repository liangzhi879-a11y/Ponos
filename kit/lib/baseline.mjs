// kit/lib/baseline.mjs —— 漂移基线：让门禁能在"有历史债"的仓库里当天上线且长期有效
//
// 设计不变量 I4：放行即人工 —— 基线是**独立文件、人工编辑、每条写 reason**。
// 为什么不能放进 sync 自动生成的台账：`sync` 会重写台账，若基线也在里面，
// "跑一次 sync"就等于"把所有问题自动放行"，门禁会被一次同步悄悄架空。
// （同一心智先例：docs/_anchors-allow.json 与自动生成的 docs/_anchors.json 分离。）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BASELINE_FILE = 'kit/manifest/drift-baseline.json'

export const KEY_SEP = '::'

/** 基线条目与 finding 的对账键（rule + subject 唯一确定一条欠账） */
export function keyOf({ rule, subject }) { return `${rule}${KEY_SEP}${subject}` }

/** 读基线；文件缺失/损坏一律返回空基线（门禁不能因坏文件崩掉） */
export function loadBaseline({ root }) {
  const p = join(root, BASELINE_FILE)
  const empty = { version: 1, _note: '已知漂移登记后不再报红，但条目数不得增加；减少时应摘除条目。', entries: [] }
  if (!existsSync(p)) return empty
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { ...empty, ...j, entries: Array.isArray(j.entries) ? j.entries : [] }
  } catch { return empty }
}

/** 套用基线：命中 → 降级为 baselined（附 reason）；未命中的原样保留。 */
export function applyBaseline(findings, baseline) {
  const map = new Map((baseline.entries || []).map((e) => [keyOf(e), e]))
  const findingsOut = findings.map((f) => {
    const e = map.get(keyOf(f))
    return e ? { ...f, severity: 'baselined', reason: e.reason || '（未写理由）' } : f
  })
  const present = new Set(findings.map(keyOf))
  const used = [...map.keys()].filter((k) => present.has(k))
  const unused = [...map.keys()].filter((k) => !present.has(k))
  return { findings: findingsOut, used, unused }
}

/**
 * 数量护栏：条目数不得超过台账记录值。
 * 没有它，基线会变成"遇红就塞"的垃圾桶，门禁在半年内必然失效。
 */
export function baselineGrowth({ baseline, recordedCount }) {
  if (recordedCount === null || recordedCount === undefined) return null
  const n = (baseline.entries || []).length
  if (n > recordedCount) return { exceeded: n, recordedCount }
  return null
}
