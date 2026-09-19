// kit/lib/dep-rules.mjs —— 依赖台账校验规则 P1–P6
import { YELLOW, RED, finding, checkResult } from './report.mjs'

export function runDepRules({ root, deps, ghost = [] } = {}) {
  const checks = []
  const findings = []
  if (!deps) {
    findings.push(finding({ rule: 'P0', severity: RED, subject: 'deps.json', hint: '跑 npm run kit:sync 生成台账' }))
    return { checks, findings }
  }
  const all = Object.entries(deps.domains || {}).flatMap(([domain, d]) => (d.packages || []).map((p) => ({ ...p, domain })))

  // ── P1：声明必须有证据（unused 落地为红） ─────────────────────────────
  const unused = all.filter((p) => p.status === 'unused')
  for (const p of unused) {
    findings.push(finding({ rule: 'P1', severity: RED, subject: `${p.name}@${p.domain}`,
      actual: '零引用证据',
      hint: '确认无用后从 package.json 删除；若在用，检查是否走动态 import / 配置文件 / CLI（五类证据见 spec §6.2）' }))
  }
  checks.push(checkResult({ rule: 'P1', title: '每个声明依赖都有引用证据', evaluated: all.length, passed: unused.length === 0 }))

  // ── P2：幽灵依赖（源码 import 但未声明） ──────────────────────────────
  for (const g of ghost) {
    findings.push(finding({ rule: 'P2', severity: RED, subject: g, actual: '未声明',
      hint: '源码 import 了但 package.json 未声明：补声明，或改掉这个 import' }))
  }
  checks.push(checkResult({ rule: 'P2', title: '无幽灵依赖', evaluated: ghost.length, passed: ghost.length === 0 }))

  // ── P3：内核域恒零依赖 ────────────────────────────────────────────────
  const kernelPkgs = (deps.domains?.kernel?.packages) || []
  if (deps.domains?.kernel?.assertZero && kernelPkgs.length > 0) {
    findings.push(finding({ rule: 'P3', severity: RED, subject: 'kernel', actual: `${kernelPkgs.length} 个依赖`,
      hint: '内核必须零第三方依赖（server/deploy-smoke.test.mjs 已有同源断言）：内核要能 bun 打成单文件' }))
  }
  checks.push(checkResult({ rule: 'P3', title: '内核域零第三方依赖', evaluated: kernelPkgs.length, passed: kernelPkgs.length === 0 }))

  // ── P4：内嵌 Python 清单真源必须在 deps.json（B2 的机制性保障） ─────────
  const embeddedSrc = deps.domains?.['python-embedded']?.source || ''
  const p4bad = !embeddedSrc.includes('deps.json')
  if (p4bad) {
    findings.push(finding({ rule: 'P4', severity: RED, subject: 'python-embedded.source', actual: embeddedSrc,
      hint: '内嵌包清单的真源必须是 kit/manifest/deps.json#python.embedded；构建脚本改读台账（见 Task 11 B2）' }))
  }
  checks.push(checkResult({ rule: 'P4', title: '内嵌 Python 清单真源在台账', evaluated: 1, passed: !p4bad }))

  // ── P5：两套 Python 清单差集（黄灯 + 逐项列出，不红） ──────────────────
  const emb = new Set((deps.python?.embedded) || [])
  const sk = new Set((deps.domains?.['python-skills']?.packages || []).map((p) => normalizePy(p.name)))
  const embN = new Set([...emb].map(normalizePy))
  const onlySkills = [...sk].filter((n) => !embN.has(n)).sort()
  const onlyEmbedded = [...embN].filter((n) => !sk.has(n)).sort()
  if (onlySkills.length || onlyEmbedded.length) {
    findings.push(finding({ rule: 'P5', severity: YELLOW, subject: 'python.embedded-vs-requirements',
      expected: `${embN.size} 个（内嵌）`, actual: `仅技能侧 ${onlySkills.join(', ') || '(无)'} ｜ 仅内嵌 ${onlyEmbedded.join(', ') || '(无)'}`,
      hint: '内嵌集是分发态最小集，技能侧含可选增强包；差集属预期，但必须能一眼看出（spec §6.3 P5）' }))
  }
  checks.push(checkResult({ rule: 'P5', title: '两套 Python 清单差集可见', evaluated: embN.size + sk.size, passed: true }))

  // ── P6：体积记账（仅趋势，缺项只提示） ────────────────────────────────
  const sizes = deps.sizes || {}
  for (const k of ['node_modules', 'runtime/python', 'runtime/skills']) {
    if (!sizes[k]) findings.push(finding({ rule: 'P6', severity: YELLOW, subject: `sizes.${k}`, actual: '未记录', hint: '跑 kit:sync 采集体积（仅趋势，无阈值）' }))
  }
  checks.push(checkResult({ rule: 'P6', title: '四域体积已记账', evaluated: Object.keys(sizes).length, passed: Object.keys(sizes).length > 0 }))

  return { checks, findings }
}

/** PyPI 包名归一：不区分大小写、`_` 与 `-` 等价（Pillow/pillow、pywin32/pywin32） */
export function normalizePy(name) { return String(name).toLowerCase().replace(/_/g, '-') }
