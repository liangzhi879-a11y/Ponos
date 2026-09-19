// kit/lib/dep-rules.mjs —— 依赖台账校验规则 P0、P1–P7
//
// ★ 2026-09-19 Task 7（Rider 2 / Rider 3 / Rider 4）在本文件收口了四件事，动机都来自实测：
//   · Rider 3：`ghost` 由 `ghost = []` 默认值改成**必传**。原默认值是失败开放 —— Task 7 若忘接线，
//     P2 会静默全绿（"幽灵依赖门禁"形同不存在），而测试还把这条错钉成了断言。
//     同理删掉从未被使用的 `files` 入参（brief 写明却在契约里悬空，谁都不知道该传什么）。
//   · Rider 2：新增 **P7**（台账包集 ↔ package.json 包集，双向）。P1/P2 都是**只读台账**的规则，
//     实测：从 package.json 删掉在用声明（zustand / xlsx / @types/node）而不同步台账，红灯数**一条不变**
//     （而且那 10 条 P1 会变成陈旧误报）。Task 10 的任务正是"删 10 个依赖" —— 没有 P7，
//     "删了却忘 sync"完全不会被任何规则发现，台账会与实际长期脱节（违反不变量 I1）。
//   · Rider 4-②：P6 标题写"四域体积已记账"但只核 3 键、通过条件还是 `keys.length > 0`
//     （有**任意**一个键就算通过）—— 标题与判据不一致，且判据宽到无法失败。现改为"核 3 键 + 缺项即未通过"，
//     标题同步改成"三域体积已记账"。**为什么不凑成 4 键**：只有 syncDeps 真正写下的键才可能被记账，
//     加第 4 个键（如 `runtime/skills-lock`）没有任何生产者，会让 P6 永远黄 —— 那不是纪律，是噪声。
//     3 个键的来源见 ledger.mjs 的 syncDeps（node_modules / runtime/python / runtime/skills）。
//   · Rider 4-③：补 P0（deps.json 缺失）的测试，并把 P0 写进 spec 的规则表（给 P0 分配规则号而不是并入 P1，
//     理由：P0 用的是**另一条判据轴**——"台账文件在不在"。并入 P1（"声明 ⊆ 有证据"）会把
//     "没台账"说成"某条声明没证据"，而那时根本没有声明可判定，报告会指向不存在的条目）。
import { RED, YELLOW, finding, checkResult } from './report.mjs'
import { readJson } from './ledger.mjs'

/** 与 package.json 对账的台账域（P7 的两个方向都只覆盖它们 —— 其余域的真源不是 package.json） */
export const PACKAGE_LEDGER_DOMAINS = ['npm-runtime', 'npm-dev']

/**
 * P7 纳入对账的 package.json 字段。
 *
 * ★ 刻意**不含** `peerDependencies`：peer 是"由宿主提供"的声明，npm 7+ 会自动安装它，
 *   但它是**消费方**的约束、不是本仓的分发内容。把它算进"包集"会得到两种坏结果：
 *   ① 台账方向：peer 包不在 dependencies 里 → 会把正常配置判成"台账陈旧"（假红）；
 *   ② 反向：peer 包若进了台账，删掉 peer 声明同样无法被 P1/P2 发现（正是 P7 要堵的缺口）。
 *   现状实测：本仓 package.json **没有** peerDependencies 字段（只有 dependencies/devDependencies），
 *   故这条排除当前是"语义正确且不影响真仓数字"的选择；一旦将来引入 peer 依赖，
 *   需要的是"peer 单独对账"，而不是塞进这一条。
 */
export const PACKAGE_DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

export function runDepRules({ root, deps, ghost, pkg, packagePath = 'package.json' } = {}) {
  // ★ Rider 3：ghost 必传。给默认值 `[]` 是**失败开放**（忘接线 → P2 全绿 → 门禁失效却看不出来），
  //   故宁可抛错：调用方必须显式回答"幽灵依赖算出来是什么"。sync 与 check 共用 ledger.computeGhost。
  if (ghost === undefined) {
    throw new Error('runDepRules: 缺少 ghost 入参（请传 ledger.mjs 的 computeGhost(...) 结果；禁止用默认 [] 静默放行 P2）')
  }
  const checks = []
  const findings = []
  if (!deps) {
    // P0：台账文件本身缺失。它是"另一条判据轴"（文件在不在），故单列规则号而非并入 P1（见文件头注释）。
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
  const missing = SIZES_KEYS.filter((k) => !sizes[k])
  for (const k of missing) {
    findings.push(finding({ rule: 'P6', severity: YELLOW, subject: `sizes.${k}`, actual: '未记录', hint: '跑 kit:sync 采集体积（仅趋势，无阈值）' }))
  }
  // 标题与判据对齐（Rider 4-②）：核的键就是 SIZES_KEYS（= syncDeps 真正会写的 3 个），
  // 且"通过"必须是**全部**键都在 —— 旧写法 `Object.keys(sizes).length > 0` 只要有任意一个键就通过，
  // 断言不可能独立失败（漏记两项也照样绿）。
  checks.push(checkResult({ rule: 'P6', title: `三域体积已记账（${SIZES_KEYS.length} 键齐备）`,
    evaluated: SIZES_KEYS.length, passed: missing.length === 0 }))

  // ── P7：台账包集 ↔ package.json 包集（双向；Rider 2） ────────────────
  // 为什么必须有：P1/P2 都只读台账，"宿主删了声明却忘 sync"两条规则都不会报红 ——
  // 实测把 zustand/xlsx/@types/node 从 package.json 删掉，红灯数仍是 14（一条不变），
  // 而台账里那 10 条 P1 反而成了陈旧误报。P7 把"台账是否还配得上宿主"变成门禁。
  const pkgData = pkg === undefined ? readJson({ root, rel: packagePath, fallback: null }) : pkg
  // 台账方向：按 (包名, 域) 逐条报，subject 与 P1 同构（`name@域`），才能一眼指回
  // package.json#dependencies / #devDependencies 的哪一段。
  const ledgerByDomain = PACKAGE_LEDGER_DOMAINS
    .flatMap((dom) => (deps.domains?.[dom]?.packages || []).map((p) => ({ name: p.name, dom })))
  const ledgerNames = new Set(ledgerByDomain.map((p) => p.name))
  const pkgNames = new Set(PACKAGE_DEP_FIELDS.flatMap((f) => Object.keys(pkgData?.[f] || {})))
  let p7bad = 0
  if (pkgData === null || pkgData === undefined) {
    p7bad++
    findings.push(finding({ rule: 'P7', severity: RED, subject: packagePath, actual: '(读不到)',
      hint: 'package.json 是依赖台账的输入真源，读不到就无法对账（确认它已入库并在 root 下）' }))
  } else {
    for (const { name, dom } of [...ledgerByDomain].sort((a, b) => a.name.localeCompare(b.name) || a.dom.localeCompare(b.dom))) {
      if (!pkgNames.has(name)) {
        p7bad++
        findings.push(finding({ rule: 'P7', severity: RED, subject: `${name}@${dom}`,
          expected: `${PACKAGE_DEP_FIELDS.join(' | ')} 中的声明`, actual: '缺失',
          hint: `台账声明了该包而 package.json 里没有它 → 台账陈旧（或包已被删）：确认后重跑 npm run kit:sync` }))
      }
    }
    for (const name of [...pkgNames].sort()) {
      if (!ledgerNames.has(name)) {
        p7bad++
        findings.push(finding({ rule: 'P7', severity: RED, subject: `${name}@package.json`,
          expected: '台账里有对应条目', actual: '未登记',
          hint: `package.json 声明了该包但台账没有它 → 漏登记：重跑 npm run kit:sync（不要手改 deps.json）` }))
      }
    }
  }
  checks.push(checkResult({ rule: 'P7', title: '台账包集与 package.json 双向一致',
    // evaluated = 参与对账的**包数**（两边并集），不是两边条数之和 —— 同一个包在两边都有时
    // 只算一次，否则"名数"会让分母随重复项膨胀，读数失去意义。
    evaluated: new Set([...ledgerNames, ...pkgNames]).size, passed: p7bad === 0 }))

  return { checks, findings }
}

/** P6 核对的键 = `syncDeps` 真正写下的三个（改这里必须同步改 ledger.mjs 的 syncDeps） */
export const SIZES_KEYS = ['node_modules', 'runtime/python', 'runtime/skills']

/** PyPI 包名归一：不区分大小写、`_` 与 `-` 等价（Pillow/pillow、pywin32/pywin32） */
export function normalizePy(name) { return String(name).toLowerCase().replace(/_/g, '-') }
