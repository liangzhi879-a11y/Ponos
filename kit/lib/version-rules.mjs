// kit/lib/version-rules.mjs —— 版本台账校验规则 V1–V8′
//
// 设计口径：check 一律**回读宿主文件**重新解析，绝不信任台账里存的值 ——
// 否则台账写错时"自己验证自己"，门禁失去意义（V7 是这条口径最锋利的实例：
// 判据恒为已提交的 skills-lock.json，台账里存的哈希不参与判定）。
import { RED, finding, checkResult } from './report.mjs'
import { trackedFiles, readTracked } from './scan.mjs'
import {
  parseByLocator, keyOfVersion, listCommonPy, sha256File, readSkillFrontmatterVersion,
  readJson, SKILLS_JSON, SKILLS_DIR, COMMON_DIR,
} from './ledger.mjs'

/** `dev X.Y` ↔ `X.Y.0`；`dev X.Y.Z` ↔ `X.Y.Z`（与 scripts/bump-version.mjs 的映射规则同源） */
export function kernelMirrorOf(value) {
  const semver = String(value).replace(/^dev\s+/, '').trim()
  return semver.split('.').length === 2 ? `${semver}.0` : semver
}

export function runVersionRules({ root, versions, files } = {}) {
  const tracked = files || trackedFiles({ root })
  const trackedSet = new Set(tracked)
  const checks = []
  const findings = []

  if (!versions) {
    findings.push(finding({ rule: 'V0', severity: RED, subject: 'versions.json', hint: '跑 npm run kit:sync 生成台账' }))
    return { checks, findings }
  }

  const entries = [...(versions.lines || []), ...(versions.contracts || []), ...(versions.manual || [])]

  // ── V1：可解析-回读 ────────────────────────────────────────────────────
  // 按 locator 解析（不按台账里存的行号 —— 行号会随无关改动漂移，那是"存储位置"不是契约）
  let v1bad = 0
  for (const e of entries) {
    const p = parseByLocator({ root, file: e.file, locator: e.locator })
    if (!p) {
      v1bad++
      findings.push(finding({ rule: 'V1', severity: RED, subject: keyOfVersion(e), file: e.file,
        expected: String(e.value), actual: '(解析失败)', hint: '宿主文件缺失或常量名已改；确认后跑 kit:sync' }))
      continue
    }
    if (String(p.value) !== String(e.value)) {
      v1bad++
      findings.push(finding({ rule: 'V1', severity: RED, subject: keyOfVersion(e), file: e.file, line: e.line,
        expected: String(e.value), actual: String(p.value), hint: '台账与宿主文件不一致：跑 kit:sync 更新台账，或修宿主文件' }))
    }
  }
  checks.push(checkResult({ rule: 'V1', title: '台账值可从宿主文件解析-回读', evaluated: entries.length, passed: v1bad === 0 }))

  // ── V1b：台账键唯一 ───────────────────────────────────────────────────
  const seen = new Map()
  let v1b = 0
  for (const e of entries) {
    const k = keyOfVersion(e)
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  for (const [k, n] of seen) if (n > 1) { v1b++; findings.push(finding({ rule: 'V1b', severity: RED, subject: k, actual: `${n} 条`, hint: '台账键重复；同名的 SCHEMA_VERSION 必须靠 file 区分' })) }
  checks.push(checkResult({ rule: 'V1b', title: '台账键（id@file）唯一', evaluated: entries.length, passed: v1b === 0 }))

  // ── V2：宿主文件存在（判据是"已入库"） ─────────────────────────────────
  let v2 = 0
  for (const e of versions.lines || []) {
    if (!e.file || !trackedSet.has(e.file)) {
      v2++
      findings.push(finding({ rule: 'V2', severity: RED, subject: keyOfVersion(e), file: e.file, hint: '每条版本线的宿主文件必须已入库' }))
    }
  }
  checks.push(checkResult({ rule: 'V2', title: '每条版本线有已入库的宿主文件', evaluated: (versions.lines || []).length, passed: v2 === 0 }))

  // ── V3：历史链连续 + 末条 to == 当前值 ─────────────────────────────────
  const records = (versions.history && versions.history.records) || []
  const byKey = new Map()
  for (const r of records) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r) }
  let v3 = 0
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (let i = 1; i < sorted.length; i++) {
      if (String(sorted[i].from) !== String(sorted[i - 1].to)) {
        v3++
        findings.push(finding({ rule: 'V3', severity: RED, subject: key, expected: String(sorted[i - 1].to), actual: String(sorted[i].from),
          hint: `历史链断裂（${sorted[i - 1].at} → ${sorted[i].at}）：台账 history.records 必须首尾相接` }))
      }
    }
    const cur = entries.find((e) => keyOfVersion(e) === key)
    if (cur && String(sorted[sorted.length - 1].to) !== String(cur.value)) {
      v3++
      findings.push(finding({ rule: 'V3', severity: RED, subject: key, expected: String(sorted[sorted.length - 1].to), actual: String(cur.value),
        hint: '当前值与历史末条不一致；版本变更必须在 history.records 留记录（防静默降级）' }))
    }
  }
  checks.push(checkResult({ rule: 'V3', title: '版本历史链连续且与当前值一致', evaluated: records.length, passed: v3 === 0 }))

  // ── V4：内核线跨载体映射 ───────────────────────────────────────────────
  let v4 = 0
  const kernelLine = (versions.lines || []).find((l) => l.id === 'KERNEL_VERSION')
  if (kernelLine && kernelLine.mirrorValue != null) {
    const expect = kernelMirrorOf(kernelLine.value)
    if (String(kernelLine.mirrorValue) !== expect) {
      v4++
      findings.push(finding({ rule: 'V4', severity: RED, subject: 'KERNEL_VERSION↔kernel/package.json', file: 'kernel/package.json',
        expected: expect, actual: String(kernelLine.mirrorValue), hint: "映射规则：'dev X.Y' → 'X.Y.0'（scripts/bump-version.mjs 同源）" }))
    }
  }
  checks.push(checkResult({ rule: 'V4', title: '内核线跨载体映射一致', evaluated: kernelLine ? 1 : 0, passed: v4 === 0 }))

  // ── V5：data-schema 必须有迁移说明 ────────────────────────────────────
  const schemaEntries = entries.filter((e) => e.kind === 'data-schema')
  const v5 = schemaEntries.filter((e) => !e.migrationNote || !String(e.migrationNote).trim())
  for (const e of v5) {
    findings.push(finding({ rule: 'V5', severity: RED, subject: keyOfVersion(e), file: e.file,
      hint: 'kind=data-schema 的版本变更必须写明迁移方式（migrationNote）；无迁移也须显式写"向后兼容，无需迁移"' }))
  }
  checks.push(checkResult({ rule: 'V5', title: 'data-schema 条目有迁移说明', evaluated: schemaEntries.length, passed: v5.length === 0 }))

  // ── V6：技能三方一致（skills.json ↔ frontmatter ↔ 台账） ───────────────
  const skillsJson = readJson({ root, rel: SKILLS_JSON, fallback: [] }) || []
  const jsonVer = new Map(skillsJson.map((s) => [s.id, s.version]))
  let v6 = 0
  for (const s of versions.skills || []) {
    const file = `${SKILLS_DIR}/${s.id}/SKILL.md`
    const fm = readSkillFrontmatterVersion({ root, file })
    const j = jsonVer.get(s.id)
    if (fm === null) { v6++; findings.push(finding({ rule: 'V6', severity: RED, subject: s.id, file, hint: 'SKILL.md 缺 version frontmatter' })); continue }
    if (String(fm) !== String(j)) { v6++; findings.push(finding({ rule: 'V6', severity: RED, subject: s.id, file, expected: String(j), actual: String(fm), hint: 'public/skills.json 与 SKILL.md 版本不一致' })) }
  }
  checks.push(checkResult({ rule: 'V6', title: '技能版本三方一致', evaluated: (versions.skills || []).length, passed: v6 === 0 }))

  // ── V7：skills-lock 哈希（D5：lock 记录"本地安装后"哈希） ────────────────
  // ★ 判据是**已提交的 lock 文件**（skills-lock.json），不是台账里存的值。
  //   原因：sync 会重写台账；若拿台账里的哈希比对文件，跑一次 sync 就必然全绿 → 门禁自证。
  const lock = readJson({ root, rel: 'skills-lock.json', fallback: { skills: {} } }) || { skills: {} }
  const lockField = (versions.skillsLock && versions.skillsLock.field) || 'computedHash'
  let v7 = 0
  const lockIds = Object.keys(lock.skills || {})
  for (const id of lockIds) {
    const file = `${SKILLS_DIR}/${id}/SKILL.md`
    const actual = sha256File({ root, file })
    const expected = lock.skills[id] ? lock.skills[id][lockField] : undefined
    if (actual === null) { v7++; findings.push(finding({ rule: 'V7', severity: RED, subject: id, file, hint: 'lock 里登记了该技能，但 SKILL.md 不存在' })); continue }
    if (actual !== expected) {
      v7++
      findings.push(finding({ rule: 'V7', severity: RED, subject: id, file: 'skills-lock.json',
        expected: String(expected || '(空)').slice(0, 12), actual: actual.slice(0, 12),
        hint: `SKILL.md 与 ${lockField} 不符：改动是有意的则跑 npm run kit:sync 重算 lock，否则回退 SKILL.md` }))
    }
  }
  checks.push(checkResult({ rule: 'V7', title: 'skills-lock 哈希与本地文件一致', evaluated: lockIds.length, passed: v7 === 0 }))

  // ── V8 / V8b / V8'：_common 工具覆盖 ─────────────────────────────────
  const ct = versions.commonTools || { baseline: [], entries: [] }
  const actualPy = listCommonPy(tracked)
  const actualSet = new Set(actualPy)
  const entrySet = new Set((ct.entries || []).map((e) => e.file.replace(`${COMMON_DIR}/`, '')))
  let v8 = 0
  for (const e of ct.entries || []) {
    const n = e.file.replace(`${COMMON_DIR}/`, '')
    if (!actualSet.has(n)) { v8++; findings.push(finding({ rule: 'V8', severity: RED, subject: n, file: e.file, hint: '台账登记了不存在的 .py（文件已删除/改名）' })) }
  }
  checks.push(checkResult({ rule: 'V8', title: '台账登记的工具文件都存在', evaluated: (ct.entries || []).length, passed: v8 === 0 }))

  let v8b = 0
  for (const n of actualPy) {
    if (!entrySet.has(n)) { v8b++; findings.push(finding({ rule: 'V8b', severity: RED, subject: n, actual: '未登记', hint: '实有 .py 必须全部登记（跑 kit:sync 会自动补，version 可空）' })) }
  }
  checks.push(checkResult({ rule: 'V8b', title: '实有 .py 全部在台账中', evaluated: actualPy.length, passed: v8b === 0 }))

  // V8'：**新增**文件必须自证版本（存量 98 个豁免 —— 这是 D6 与 spec §5.4 的划界）
  const baselineSet = new Set(ct.baseline || [])
  const addedFiles = actualPy.filter((n) => !baselineSet.has(n))
  let v8p = 0
  for (const n of addedFiles) {
    const entry = (ct.entries || []).find((e) => e.file.endsWith(`/${n}`))
    if (!entry || entry.version == null) {
      v8p++
      findings.push(finding({ rule: "V8'", severity: RED, subject: n, file: `${COMMON_DIR}/${n}`,
        hint: '新增的 _common 脚本必须声明 __version__ 或显式登记版本（防止欠账继续扩大）' }))
    }
  }
  checks.push(checkResult({ rule: "V8'", title: '新增 _common 脚本自证版本', evaluated: addedFiles.length, passed: v8p === 0 }))

  return { checks, findings }
}
