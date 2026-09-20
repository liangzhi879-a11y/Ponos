// kit/lib/devkit-rules.mjs —— **CT12：DevKit 边界**（发行物不得含开发门禁）
// ---------------------------------------------------------------------------
// 用户口径（2026-09-20）：『确保正式打包不会带 devkit，也就是发行给用户的版本不带 kit 及相关配置』。
//
// 为什么这条要单独成规则、而不是"在打包脚本里加两行排除"：
//   实测漏洞 —— `scripts/pack-source-zip.mjs`（源码交付包，文件头注释声明『给客户/外部』）的排除规则里
//   **既没有 `kit/` 也没有 `AGENTS.md`**，而它的候选清单来自 `git ls-files`（含全部跟踪文件）
//   ⇒ **59 个 devkit 文件**（`kit/` 58 + `AGENTS.md` 1）会随源码包发出去。
//   只在那一处加两行 = 把"哪几份清单要同步"这个坑再挖一遍（本仓已经为同类漂移付过多次账）。
//   所以：**真源**在 `kit/manifest/devkit.json` —— 本模块是它**唯一的匹配实现**，
//   打包脚本 import 它、规则核它，谁都不许再抄一份路径清单。
//
// 与 CT11 的分工（两者常被混）：
//   · CT11 = agent 入口**送达**（自动注入 + 便携版同步）——管"要**有**什么"；
//   · CT12 = devkit **外泄**（发行物不得含）——管"要**没有**什么"。
//   两者在调试渠道上正好相**反**：`AGENTS.md` 在调试版里**必须有**（CT11 管），在发行物里**必须无**（CT12 管）。
//   这就是 `devChannelAllow[]` 存在的理由 —— 例外必须被显式登记，不能靠"反正扫不到"。
//
// ★ 本模块**零外部依赖**（不 import js-yaml 之类）：kit 的规则要能在干净克隆、仅装 node 的情况下跑
//   （CI 的 kit 测试就是那个场景）。所以 electron-builder.yml 用**行级结构提取**，不用 YAML 解析器。

import { readFileSync } from 'node:fs'
import { finding, checkResult, RED } from './report.mjs'

const ROOT = new URL('../../', import.meta.url)
/** 真源路径（相对仓根）—— 全仓唯一 */
export const DEVKIT_TRUTH = 'kit/manifest/devkit.json'

/** 把真源的路径模式转成**锚定**正则。★ 唯一实现：打包脚本与规则都调它，别再各写一遍。
 *  - 以 `/` 结尾 ⇒ 目录前缀（`kit/` 命中 `kit/xxx`，**不**命中 `kitfoo/`）
 *  - 否则 ⇒ 仓根文件精确匹配（`AGENTS.md` 只命中根那份，**不**命中 `sub/AGENTS.md`） */
export function devkitMatcher(pattern) {
  const s = String(pattern)
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return s.endsWith('/') ? new RegExp(`^${esc}`) : new RegExp(`^${esc}$`)
}

/** 读真源。`read` 可注入（测试/提交态读取）；缺省读工作树。返回 `{ ok, devkit, error }` —— 不抛。 */
export function loadDevkit({ read } = {}) {
  let text
  try {
    text = read ? read(DEVKIT_TRUTH) : readFileSync(new URL(DEVKIT_TRUTH, ROOT), 'utf8')
  } catch (e) {
    return { ok: false, devkit: null, error: `读不到：${e.message}` }
  }
  if (text === null || text === undefined) return { ok: false, devkit: null, error: '读不到（读取器返回空）' }
  try {
    const devkit = JSON.parse(text)
    if (!devkit || typeof devkit !== 'object') return { ok: false, devkit: null, error: '不是一个对象' }
    if (!Array.isArray(devkit.patterns)) return { ok: false, devkit: null, error: '缺少 patterns[]' }
    return { ok: true, devkit, error: null }
  } catch (e) {
    return { ok: false, devkit: null, error: `JSON 解析失败：${e.message}` }
  }
}

/** 一份文件清单里，哪些踩到了 devkit 边界（`allowDevChannel` 时按真源例外放行）。
 *  files 用 `/` 分隔的相对路径（`\` 会被归一，免得 Windows 侧调用方先踩坑）。 */
export function devkitLeaks(files, devkit, { allowDevChannel = false } = {}) {
  const rules = (devkit?.patterns || []).map((p) => ({ path: p.path, why: p.why, re: devkitMatcher(p.path) }))
  const allow = new Set(allowDevChannel ? (devkit?.devChannelAllow || []).map((p) => p.path) : [])
  const out = []
  for (const f of files || []) {
    const rel = String(f).replace(/\\/g, '/')
    const hit = rules.find((r) => r.re.test(rel))
    if (!hit) continue
    if (allow.has(hit.path)) continue
    out.push({ rel, path: hit.path, why: hit.why })
  }
  return out
}

/** 打包期自查（供打包脚本在写 zip 之前调用）：命中即抛，**不产出包**。
 *  ★ 只在打包脚本里"记一条日志"是不够的：包照样出、照样发 —— 所以这里默认抛。 */
export function assertNoDevkit(files, devkit, opts = {}) {
  const leaks = devkitLeaks(files, devkit, opts)
  if (!leaks.length) return leaks
  const lines = leaks.slice(0, 20).map((l) => `  - ${l.rel}（命中 ${l.path}）`)
  if (leaks.length > 20) lines.push(`  … 另有 ${leaks.length - 20} 个`)
  throw new Error(
    `DevKit 边界：入包清单里有 ${leaks.length} 个开发门禁文件，已中止（不写包）。\n` +
      lines.join('\n') +
      `\n  规则见 ${DEVKIT_TRUTH}；这份清单只服务本仓开发，发行物里不该有它。`,
  )
}

/** 把 electron-builder.yml 的 `files:` / `extraResources:` 段里的**入包路径条目**提取出来。
 *  零依赖（不引 YAML 解析器）：只认"顶层键开段 + 段内条目"，够覆盖本仓这份配置的形状。
 *  ★ 三个必须做对的细节（都对不上就会**误报 devkit**，门禁变成噪声）：
 *    ① `!` 开头的条目是排除项 ⇒ 跳过（`!public/sample-skills` 不是"包含"）；
 *    ② `extraResources` 的子项是 `{from, to, filter}` ⇒ 只取 `from`（`to` 是包内落点，不是"入了什么"）；
 *    ③ ★ `filter:` 下面那串 `**\/*` 是**文件过滤**、不是入包路径 —— 必须按**缩进**跳过，
 *       否则每条 extraResources 都会凭空多出一个 `**\/*`，被判成"全包含 devkit"（假红）。
 *       实测本仓：不按缩进跳过 ⇒ 5 条 `extraResources: **\/*` 假命中。 */
export function ymlPathEntries(text, keys = ['files', 'extraResources']) {
  const out = []
  let cur = null // 当前段（顶层键名）
  let itemIndent = null // 段内"直接子项"的缩进（`- ` 与 `from:`/`to:` 都在这一层）
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.match(/^\s*/)[0].length
    const top = raw.match(/^([A-Za-z_][\w-]*):/)
    if (top && indent === 0) {
      cur = keys.includes(top[1]) ? top[1] : null
      itemIndent = null
      continue
    }
    if (!cur) continue
    const dash = raw.match(/^(\s*)-\s*(.*?)\s*$/)
    if (dash) {
      const ind = dash[1].length
      if (itemIndent === null) itemIndent = ind
      if (ind > itemIndent) continue // ★ 嵌套子列表（`filter:` 里的 `**/*`）：不是入包路径
      let v = dash[2].replace(/^['"]|['"]$/g, '')
      if (!v || v.startsWith('!')) continue // 排除项
      const fromTo = v.match(/^(?:from|to)\s*:\s*(.+)$/)
      if (fromTo) v = fromTo[1].replace(/^['"]|['"]$/g, '')
      out.push({ key: cur, value: v })
      continue
    }
    const child = raw.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!child) continue
    if (itemIndent !== null && child[1].length <= itemIndent) continue
    if (child[2] !== 'from') continue // `filter:` / `to:` 等子键不是"入包内容"清单（`to` 是包内落点）
    const v = child[3].replace(/^['"]|['"]$/g, '')
    if (v) out.push({ key: cur, value: v })
  }
  return out
}

/** 一个包含模式（如 `dist/**\/*`、`kit/**\/*`、`**\/*`）会不会把 devkit 带进来。
 *  ★ `**\/*` / `*` / `.`（全包含）必须判 **true** —— 这正是"哪天有人把 files 改成 `**\/*`"的场景，
 *    也是本判据存在的核心理由（白名单今天干净 ≠ 明天干净）。 */
export function includeHitsDevkit(value, devkit) {
  let s = String(value).trim().replace(/^\.\//, '')
  if (s === '' || s === '.' || s === '*' || s === '**' || s === '**/*' || s === '**\\*') return true
  s = s.replace(/\/\*\*\/\*$/, '').replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '')
  for (const p of devkit?.patterns || []) {
    const dp = String(p.path).replace(/\/$/, '')
    if (s === dp) return true
    if (dp.startsWith(s + '/')) return true // 模式是 devkit 的祖先目录（含 kit ⇒ 含 kit/xxx）
    if (s.startsWith(dp + '/')) return true // 模式指向 devkit 内部
  }
  return false
}

/**
 * CT12 本体。判据（每条都能失败，且都指向一件真实会出的事）：
 *  ① 真源可读 + JSON 合法 + `patterns[]` 非空 —— 空 patterns 会让本规则**恒真通过**（扫 0 条报通过）；
 *  ② `devChannelAllow[]` 每项都必须在 `patterns[]` 里 —— 否则那是条**永不生效的例外**（读的人会以为它放行了什么）；
 *  ③ 匹配实现自证：`kit/cli.mjs` / `AGENTS.md` **必须**命中，`src/App.tsx` **必须**不命中
 *     （防"匹配被改成恒不命中"这种最隐蔽的做假）；
 *  ④ 例外机制自证：开 `allowDevChannel` ⇒ `AGENTS.md` 放行；不开 ⇒ 拦住
 *     （防例外被写成"什么都放行"）；
 *  ⑤ 各发行面仍**引用真源**（逐个查文本里有 `devkit-rules` / `devkit.json`）——
 *     防有人把引用删掉、退回各自维护一份排除清单；
 *  ⑥ `electron-builder.yml` 的 `files` / `extraResources` **结构**上不含 devkit
 *     （含 `**\/*` 这种全包含 ⇒ 红）。
 */
export function devkitBoundaryCheck({ readTracked, read } = {}) {
  const findings = []
  const readAny = (p) => {
    try {
      const v = readTracked ? readTracked(p) : (read ? read(p) : readFileSync(new URL(p, ROOT), 'utf8'))
      return v === undefined ? null : v
    } catch {
      return null
    }
  }

  let evaluated = 0
  const loaded = loadDevkit({ read: (p) => readAny(p) })
  if (!loaded.ok) {
    findings.push(finding({
      rule: 'CT12', severity: RED, subject: 'devkit-truth-unreadable', file: DEVKIT_TRUTH, line: null,
      expected: `可读且合法的 JSON（含非空 patterns[]）`,
      actual: loaded.error || '（读不到）',
      hint: '真源读不到 ⇒ 本规则无从判定（不是"没问题"）。若确实要换真源位置，先改这里与各消费端。',
    }))
    return { check: checkResult({ rule: 'CT12', title: 'DevKit 边界：发行物不得含开发门禁', evaluated: 0, passed: false }), findings }
  }
  const devkit = loaded.devkit
  evaluated += 1

  if (devkit.patterns.length === 0) {
    findings.push(finding({
      rule: 'CT12', severity: RED, subject: 'no-patterns', file: DEVKIT_TRUTH, line: null,
      expected: 'patterns[] 至少有 1 条（发行物禁含的 devkit 路径）',
      actual: '（0 条）',
      hint: '为空时"扫 0 条"会变成**恒真通过** —— 正是本仓反复在防的做假形态；至少要登记 `kit/` 与 `AGENTS.md`。',
    }))
  }

  const names = new Set(devkit.patterns.map((p) => p.path))
  for (const a of devkit.devChannelAllow || []) {
    if (!names.has(a.path)) {
      findings.push(finding({
        rule: 'CT12', severity: RED, subject: `allow-not-in-patterns:${a.path}`, file: DEVKIT_TRUTH, line: null,
        expected: `devChannelAllow 里的 ${JSON.stringify(a.path)} 也应出现在 patterns[]`,
        actual: '（patterns[] 里没有它）',
        hint: '例外只对"本就在禁含清单里的路径"有意义；否则它是条**永不生效的例外** —— 读的人会以为它放行了什么。',
      }))
    }
  }

  // ③ 匹配实现自证（3 条）
  const selfProof = [
    ['kit/cli.mjs', true, 'kit/ 覆盖 DevKit 本体'],
    ['AGENTS.md', true, 'agent 自动注入入口'],
    ['src/App.tsx', false, '产品源码不该被误拦（不然规则会逼人乱加例外）'],
  ]
  for (const [rel, want, why] of selfProof) {
    evaluated += 1
    const got = devkitLeaks([rel], devkit).length > 0
    if (got !== want) {
      findings.push(finding({
        rule: 'CT12', severity: RED, subject: `matcher-proof:${rel}`, file: DEVKIT_TRUTH, line: null,
        expected: `${rel} ⇒ ${want ? '命中' : '不命中'}（${why}）`,
        actual: got ? '命中' : '不命中',
        hint: '匹配实现（kit/lib/devkit-rules.mjs#devkitMatcher）与真源对不上。★ 若"命中"整类失效，本规则会**恒真通过** —— 这比漏一个文件更危险。',
      }))
    }
  }

  // ④ 例外机制自证（2 条）
  const allowOn = devkitLeaks(['AGENTS.md'], devkit, { allowDevChannel: true }).length === 0
  const allowOff = devkitLeaks(['AGENTS.md'], devkit).length > 0
  evaluated += 2
  if (!allowOn) {
    findings.push(finding({
      rule: 'CT12', severity: RED, subject: 'dev-channel-allow-broken', file: DEVKIT_TRUTH, line: null,
      expected: 'allowDevChannel=true 时 AGENTS.md 被放行（调试版必须带它 —— CT11 管这件事）',
      actual: '仍被拦住',
      hint: '调试版（release/YFWorking 与 portable-debug zip）里 agent 要靠这个入口受规范约束；放行不了 ⇒ 调试版要么缺入口、要么被迫绕过规则。',
    }))
  }
  if (!allowOff) {
    findings.push(finding({
      rule: 'CT12', severity: RED, subject: 'dev-channel-allow-overbroad', file: DEVKIT_TRUTH, line: null,
      expected: 'allowDevChannel=false（发行物）时 AGENTS.md 必须被拦住',
      actual: '被放行了',
      hint: '★ 例外被写成"什么都放行"= 规则失效。发行物里出现 agent 入口，收件人会以为要按它组织开发。',
    }))
  }

  // ⑤ 各发行面仍**引用真源**。
  //   ★ 只对 `guard.kind === 'reference'`（可写 import 的 JS/脚本）要求"文本里出现引用"：
  //     `electron-builder.yml` 是**声明式配置**，没法 import 规则模块 —— 它由下面 ⑥ 的**结构校验**守
  //     （"白名单里有没有 devkit"）。若一并要求它"引用真源"，只会得到一条永远红的假红 ——
  //     而假红会让整条规则被无视（本仓最忌）。
  for (const s of devkit.releaseSurfaces || []) {
    const file = s?.guard?.file
    if (!file) continue
    if (s.guard.kind === 'structural') continue
    const body = readAny(file)
    if (body === null) {
      // ★ 条件判据（与 CT11 的 `pending` 同一套语义，理由也一样）：
      //   `scripts/pack-source-zip.mjs` 与 `scripts/package-portable-zip.mjs` 目前被**本地
      //   `.git/info/exclude` 排除**（开发者本机在途文件，尚未入库）⇒ CT12 读**提交态**会读不到。
      //   若照常报红，门禁会**永远红** —— 而"永远红"等于没有红灯（红灯失去信息量）。
      //   ⇒ 未入库：跳过（不报红、不计 evaluated）；**一旦入库：自动开始核**（无需人工记得补登记）。
      if (s.guard.pending) continue
      findings.push(finding({
        rule: 'CT12', severity: RED, subject: `surface-missing:${file}`, file, line: null,
        expected: `仍存在且引用真源（${DEVKIT_TRUTH}）`,
        actual: '（读不到这个文件）',
        hint: `${s.what || s.id || ''} —— 发行面文件不见了 ⇒ 这条路已失效，本规则却还以为它在把关。`
          + '★ 若它本来就没入库（只是本机在途），应在真源里给它标 `guard.pending: true`，而不是删掉这条登记。',
      }))
      continue
    }
    evaluated += 1
    if (!/devkit-rules|devkit\.json/.test(body)) {
      findings.push(finding({
        rule: 'CT12', severity: RED, subject: `surface-not-guarded:${file}`, file, line: null,
        expected: `文本里应出现 devkit-rules / devkit.json（表示它从真源取清单）`,
        actual: '（没找到引用）',
        hint: `${s.what || ''}：★ 排除清单必须**从真源取**，不能各抄一份 —— 抄一份就是下一个"改了这处忘了那处"，`
          + '而这类漏的后果是**把内部开发配置发给客户**（本批修的就是这个：59 个 devkit 文件差点随源码包发出）。',
      }))
    }
  }

  // ⑥ electron-builder.yml 的结构校验（含"全包含"识别）
  const ymlFile = 'electron-builder.yml'
  const yml = readAny(ymlFile)
  evaluated += 1
  if (yml === null) {
    findings.push(finding({
      rule: 'CT12', severity: RED, subject: 'yml-missing', file: ymlFile, line: null,
      expected: '可读（NSIS 安装包的入包白名单在这里）',
      actual: '（读不到）',
      hint: '安装包是主要发行物；读不到它的配置 ⇒ 无法判定发行物是否带 devkit。',
    }))
  } else {
    const entries = ymlPathEntries(yml)
    const hits = entries.filter((e) => includeHitsDevkit(e.value, devkit))
    evaluated += 1
    if (hits.length) {
      findings.push(finding({
        rule: 'CT12', severity: RED, subject: 'installer-includes-devkit', file: ymlFile, line: null,
        expected: `files / extraResources 不含 devkit（当前白名单 ${entries.length} 条）`,
        actual: hits.map((h) => `${h.key}: ${h.value}`).join('、'),
        hint: '★ 最常见形态是把 `files` 改成 `**/*`（"顺手全带上"）—— 那会一次性把 59 个 devkit 文件打进安装包。'
          + '要么显式列出需要的路径，要么把 devkit 加进 build 的排除项（`!kit/**/*`）。',
      }))
    }
  }

  return {
    check: checkResult({
      rule: 'CT12',
      title: 'DevKit 边界：发行物不得含开发门禁（kit/ 与相关配置）',
      evaluated,
      passed: findings.length === 0,
    }),
    findings,
  }
}
