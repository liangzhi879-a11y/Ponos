// kit/lib/brand-rules.mjs —— CT10：品牌声明点与品牌真源一致（品牌标识与名称的**统一管理**）
//
// **唯一真源 = `kit/manifest/brand.json`**（`BRAND_TRUTH`）：层名（app / kernel）、**14 条**声明点、
// 废弃别名、已知广泛存在，全在那一个文件里。本规则只做一件事：把真源里登记的每条声明点与
// 它在文件里的**实际取值**对账 —— 于是"改真源 = 重新定义品牌，门禁告诉你哪里还没跟上"。
//
// ── 为什么需要它（本批的背景）─────────────────────────────────────────────
// 品牌名此前**分散在 4 个载体**里各写一份（`electron-builder.yml` 的 productName、`index.html` 的
// `<title>`、`version.mjs` 的两行版本线注释、`versions.json` 的 lines[].label），改一处不会有人告诉你
// 另三处没跟上；而"内核层统一为 `ponos`（无 turbo）"这类口径也就没有机械判据。
//
// ── 三条纪律（判据的边界，别把范围读大）─────────────────────────────────
// ① **只查声明点指向的那段文本**（某 key 的值 / `<title>` 的内容 / 某行注释 / 台账里某个 label），
//    **不扫整文件、更不扫全仓** —— 全仓还有一批 `Ponos-Turbo` 散在 `kernel/`、`kernel-tests/`
//    与 `docs/` 的**叙述性文本**里（真源 `knownWidespread` 已如实登记这些数字），那是**独立工作项**；
//    若这里改成扫全仓，CT10 会永远红、红灯失去信息量（"经常红的门禁等于没有门禁"）。
// ② **判据全部来自真源**：层名与字面量都写在 `brand.json` 的 `expects` 里 ⇒ 规则里**不硬编码任何
//    层名/字面量**；硬编码的只有 declaration 的 **id 名单**（`REQUIRED_DECLARATIONS`）（那是"必须凑齐"的结构约束，
//    不是品牌内容）。
// ③ **fail-closed**：真源读不到 / JSON 坏 / declaration 名单不齐 ⇒ 红；某条声明点**取不到值**（文件缺失、
//    key 被删、格式变了）同样 ⇒ 红 —— "取不到"不等于"没问题"（窗口标题丢了也不会有人来报）。
//
// ── 零依赖的取值实现（不许新增依赖）──────────────────────────────────────
// `json-key` / `json-pointer` 走 `JSON.parse`；`yaml-scalar` 只做**行级**解析
// （`/^\s*key:\s*(.+)$/m`，去掉引号与行尾注释）—— 本仓需要的 yaml 只有 `appId` / `productName`
// 两个标量，为它引一个 yaml 解析库是多余的（且本批明令不许加依赖）；
// `html-title` 用 `/<title>([^<]*)<\/title>/`；`comment-label` 在源码里找**含该常量名的整行注释**。
//
// 行号一律用"在原始文本里 indexOf → 数 `\n`"（同样不引依赖）。
import { RED, finding, checkResult } from './report.mjs'

/** 品牌真源（相对仓根）。消费方（`scripts/brand.mjs`、GUI、测试）都用这个常量，不各自写路径 */
export const BRAND_TRUTH = 'kit/manifest/brand.json'

/**
 * 必须凑齐的 **14 条**声明点 id（结构约束）。★ 加声明点时**改这里**，规则与提示文案都会跟着走。
 * 每条的 file/kind/取值位置/expects/why 全部来自真源 —— 这里只是"少一条就算真源不合法"的名单。
 * 为什么少一条要红：声明点是"品牌在用户可见处的落点"，静默少一条等于某个落点从此无人看管。
 */
export const REQUIRED_DECLARATIONS = [
  'product-name', 'window-title', 'app-id', 'npm-name',
  'app-label', 'kernel-label', 'lines-label-app', 'lines-label-kernel',
  // ★ 第 9–14 条：复核审查指出"8 条 = 过度承诺"后补的 —— 这些都是**用户可见或对外分发**的声明点，
  //   而且 kernel/package.json 那两条实测**残留着废弃别名**（`Ponos-turbo 内核独立部署包`），
  //   恰恰证明了"没登记的声明点会悄悄漂移"。加进来后才算真的"统一管理"。
  'meta-description', 'shortcut-name', 'copyright', 'pkg-description',
  'kernel-pkg-name', 'kernel-pkg-description',
]

/** 本规则支持的取值形态（真源里 kind 写别的 ⇒ 结构不合法，红） */
export const DECL_KINDS = ['json-key', 'json-pointer', 'yaml-scalar', 'html-title', 'html-meta-description', 'comment-label']

/** `retiredAliases[].scope` 的合法值。★ 只有 `declarations` 是**已实现**的语义；
 *  `repo`（全仓禁）**没有实现** —— 真源若写成 repo 必须红，否则会给人"全仓都已受管"的错觉。 */
export const RETIRED_SCOPES = ['declarations']

/** 行号：在原始文本里 indexOf → 数换行（不引依赖；index<0 ⇒ null） */
function lineOfIndex(text, index) {
  if (index < 0 || index >= text.length) return null
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

const shortMsg = (e) => String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120)

/** 层名（真源 layers[] 里按 id 取；取不到 ⇒ null，由调用方报红 —— 规则不假设 app/kernel 一定存在） */
export function layerName(layers, id) {
  const hit = (Array.isArray(layers) ? layers : []).find((l) => l && l.id === id)
  return hit && typeof hit.name === 'string' && hit.name.trim() !== '' ? hit.name : null
}

/** 期望的人话（finding.expected 与 `brand.mjs` 的逐条打印共用一份，避免两处措辞漂移） */
export function describeExpects(decl, layers) {
  if (decl && decl.expects && decl.expects.literal !== undefined) return `字面量 "${decl.expects.literal}"`
  if (decl && decl.expects && decl.expects.layer !== undefined) {
    const name = layerName(layers, decl.expects.layer)
    return `层 ${decl.expects.layer} 的名称 "${name === null ? '(真源未定义)' : name}"`
  }
  return '(真源未给 expects)'
}

/** 取值位置的说明（hint 里告诉人"改哪一行/哪一段"） */
function whereOf(decl) {
  switch (decl.kind) {
    case 'json-key': return `顶层 "${decl.key}" 键的值`
    case 'json-pointer': return `"${decl.pointer}" 指向的那条记录`
    case 'yaml-scalar': return `"${decl.key}:" 那一行的值`
    case 'html-title': return '`<title>…</title>` 的内容'
    case 'comment-label': return `含 \`${decl.constName}\` 的那行注释`
    default: return String(decl.kind)
  }
}

/** `"` 这类字符在正则里要转义（key/常量名来自于真源，是数据不是代码） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 台账 `lines[]` 里某条（`id === idValue`）的某字段在**哪一行**。
 * 判据：逐行扫，记住最近一条 `"id": "…"`，遇到 `"label":` 且最近的 id 就是目标 ⇒ 命中。
 * 为什么不用 `indexOf`：`versions.json` 里同一个 id 可能在别处也出现（locator.name），
 * 取第一个命中会指到错误的行 —— 行号是给人按图索骥的，指错比没有更坏。
 */
function memberLine(text, idValue, key) {
  const lines = String(text).split('\n')
  const idRe = /"id"\s*:\s*"([^"]*)"/
  const keyRe = new RegExp(`"${escapeRe(key)}"\\s*:`)
  let lastId = null
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i])
    if (m) lastId = m[1]
    if (lastId === idValue && keyRe.test(lines[i])) return i + 1
  }
  return null
}

/**
 * 取出一条声明点的**实际值**与**它指向的那段文本**（别名扫描只看这段）。
 * @returns {{value:string, segment:string, line:number|null}|{missing:string}}
 *   `segment` = 声明点指向的原始文本（含引号/注释符），是 (b) 废弃别名判据的唯一输入口径。
 */
export function extractDeclaration(decl, text) {
  if (typeof text !== 'string') return { missing: '文件读不到（不存在 / 路径变了 / 不在扫描域）' }
  switch (decl.kind) {
    case 'json-key': {
      let j
      try { j = JSON.parse(text) } catch (e) { return { missing: `不是合法 JSON（${shortMsg(e)}）` } }
      if (!Object.hasOwn(j, decl.key)) return { missing: `顶层没有 "${decl.key}" 键` }
      const value = String(j[decl.key])
      const m = new RegExp(`^[ \\t]*"${escapeRe(decl.key)}"\\s*:`, 'm').exec(text)
      return { value, segment: value, line: m ? lineOfIndex(text, m.index) : null }
    }
    case 'json-pointer': {
      // 只支持 `数组名[字段=值].字段名` 这一种形态（本仓够用；不引 JSON Pointer 库，也不假装是通用实现）
      const m = /^(\w+)\[(\w+)=([^\]]+)\]\.(\w+)$/.exec(String(decl.pointer || ''))
      if (!m) return { missing: `pointer 形态不支持："${decl.pointer}"（支持「数组名[字段=值].字段名」）` }
      let j
      try { j = JSON.parse(text) } catch (e) { return { missing: `不是合法 JSON（${shortMsg(e)}）` } }
      const arr = j[m[1]]
      if (!Array.isArray(arr)) return { missing: `顶层没有数组 "${m[1]}"` }
      const hit = arr.find((e) => e && String(e[m[2]]) === m[3])
      if (!hit) return { missing: `${m[1]}[] 里没有 ${m[2]}=${m[3]} 那条` }
      const raw = hit[m[4]]
      if (typeof raw !== 'string' || raw.trim() === '') return { missing: `${m[2]}=${m[3]} 那条的 "${m[4]}" 取不到值` }
      return { value: raw, segment: raw, line: memberLine(text, m[3], m[4]) }
    }
    case 'yaml-scalar': {
      // ★ 只支持这一种简单形态（行级 `key: value`）—— 见文件头「零依赖的取值实现」
      const re = new RegExp(`^[ \\t]*${escapeRe(decl.key)}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm')
      const m = re.exec(text)
      if (!m) return { missing: `没有 "${decl.key}:" 这一行` }
      const raw = m[1].replace(/\s+#.*$/, '').trim()
      const unq = raw.replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
      if (unq === '') return { missing: `"${decl.key}" 的值为空` }
      return { value: unq, segment: raw, line: lineOfIndex(text, m.index) }
    }
    case 'html-title': {
      const m = /<title>([^<]*)<\/title>/i.exec(text)
      if (!m) return { missing: '没有 <title>…</title>' }
      if (m[1].trim() === '') return { missing: '<title> 的内容是空的' }
      return { value: m[1].trim(), segment: m[1], line: lineOfIndex(text, m.index) }
    }
    case 'html-meta-description': {
      // `<meta name="description" content="…">` —— 属性顺序/引号形态都不固定，所以只认"该标签里出现
      // `name=description`" + 取 `content` 的值；取不到就 fail-closed 报"取不到值"（不静默绿）。
      const tag = /<meta\b[^>]*name\s*=\s*["']?description["']?[^>]*>/i.exec(text)
      if (!tag) return { missing: '没有 <meta name="description" …> 标签' }
      const c = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag[0])
      const val = (c && (c[1] !== undefined ? c[1] : c[2])) || ''
      if (val.trim() === '') return { missing: '<meta name="description"> 的 content 是空的' }
      return { value: val.trim(), segment: tag[0], line: lineOfIndex(text, tag.index) }
    }
    case 'comment-label': {
      // 「含该常量名的那一行注释」：只认**整行注释**（行首 `//`），取该行去掉注释符后的文本。
      // 为什么是"整行注释"而不是"该常量所在的行"：常量行（`export const APP_VERSION = …`）是**代码**，
      // 声明点指的是它上面那行人读的说明；两者混起来会让判据随"注释写在哪一行"漂移。
      const lines = String(text).split('\n')
      const idx = lines.findIndex((l) => /^[ \t]*\/\//.test(l) && l.includes(decl.constName))
      if (idx < 0) return { missing: `没有含 "${decl.constName}" 的那行注释` }
      const seg = lines[idx].replace(/^[ \t]*\/\/[ \t]?/, '')
      if (seg.trim() === '') return { missing: `含 "${decl.constName}" 的注释行是空的` }
      return { value: seg.trim(), segment: lines[idx], line: idx + 1 }
    }
    default:
      return { missing: `未知 kind："${decl.kind}"` }
  }
}

/**
 * 读真源（**消费方共用**：`brandCheck` 与 `scripts/brand.mjs` 都走这里，避免两处解析漂移）。
 * @returns {{truth:object|null, problems:string[]}} `problems` 非空 = 真源不可用/结构不合法（调用方报红）
 */
export function loadBrandTruth({ readTracked } = {}) {
  const read = (f) => { try { return typeof readTracked === 'function' ? readTracked(f) : null } catch { return null } }
  const text = read(BRAND_TRUTH)
  if (text === null) {
    return { truth: null, problems: [`读不到品牌真源 ${BRAND_TRUTH}（文件缺失 / 路径变了；本规则读的是**提交态** ⇒ 新建的真源必须先提交）`] }
  }
  let truth
  try {
    truth = JSON.parse(text)
  } catch (e) {
    return { truth: null, problems: [`${BRAND_TRUTH} 不是合法 JSON：${shortMsg(e)}`] }
  }
  const problems = []
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return { truth: null, problems: [`${BRAND_TRUTH} 的顶层必须是对象`] }
  if (!Array.isArray(truth.layers) || truth.layers.length === 0) problems.push('layers[] 缺失或为空（层名是判据的来源）')
  if (!Array.isArray(truth.declarations)) problems.push('declarations[] 缺失')
  else {
    const ids = truth.declarations.map((d) => (d && d.id) || '(无 id)')
    const missing = REQUIRED_DECLARATIONS.filter((id) => !ids.includes(id))
    // ★ 条数**从 REQUIRED_DECLARATIONS 现读**（不写死）：早先这里硬编码「8 条」，名单扩到 14 后提示仍说 8
    //   —— 提示文案与判据不一致，会让人以为「只缺这几条」，实际是「必须凑齐的名单变了」。
    if (missing.length) problems.push(`${REQUIRED_DECLARATIONS.length} 条 declaration 不齐，缺：${missing.join(' / ')}`)
    for (const d of truth.declarations) {
      if (!d || typeof d !== 'object') { problems.push('declarations[] 里有非对象条目'); continue }
      if (!d.id) problems.push('有一条 declaration 没有 id')
      if (!d.file) problems.push(`declaration ${d.id} 没有 file`)
      if (!DECL_KINDS.includes(d.kind)) problems.push(`declaration ${d.id} 的 kind 不支持："${d.kind}"`)
      if (!d.expects || (d.expects.layer === undefined && d.expects.literal === undefined)) {
        problems.push(`declaration ${d.id} 没有可判的 expects（需 layer 或 literal）`)
      }
      // ★ severityIfWrong 的含义是"这一条错了会怎样"；本门禁只支持 red（品牌声明点一律**不可**降级：
      //   它既不能进基线豁免 —— BASELINE_FORBIDDEN 覆盖除 CT9 外的全部 CT —— 也不该只报不拦）。
      if (d.severityIfWrong !== RED) problems.push(`declaration ${d.id} 的 severityIfWrong 必须是 "${RED}"（品牌声明点不允许"只报不拦"）`)
    }
  }
  // ★ 下面两块以前**没被校验**，但 finding 文案却宣称"已校验"（复核审查抓到的"说法与实现不符"）。
  //   现在真校验：`retiredAliases` 的 `scope` 也真正参与判断（不再是"声明了却没意义"的装饰字段）。
  if (!Array.isArray(truth.retiredAliases)) problems.push('retiredAliases[] 缺失（废弃别名是判据的来源）')
  else {
    for (const a of truth.retiredAliases) {
      if (!a || typeof a !== 'object') { problems.push('retiredAliases[] 里有非对象条目'); continue }
      if (!a.alias) problems.push('有一条 retiredAliases 没有 alias')
      if (!a.replaceWith) problems.push(`retiredAliases ${a.alias} 没有 replaceWith（hint 要告诉人改成什么）`)
      // scope 只有两种合法语义：'declarations' = 只在受管声明点里禁（当前唯一的语义，防门禁变噪声）；
      // 'repo' = 全仓禁（**当前没有实现**，若真源写成 repo 就必须红 —— 否则会给人"全仓都已受管"的错觉）。
      if (!RETIRED_SCOPES.includes(a.scope)) {
        problems.push(`retiredAliases ${a.alias} 的 scope 不支持："${a.scope}"（合法值：${RETIRED_SCOPES.join(' / ')}；repo 语义未实现）`)
      }
    }
  }
  if (!Array.isArray(truth.knownWidespread)) problems.push('knownWidespread[] 缺失（规模快照要如实登记，哪怕数字会漂移）')
  else {
    for (const k of truth.knownWidespread) {
      if (!k || typeof k !== 'object') { problems.push('knownWidespread[] 里有非对象条目'); continue }
      if (!k.alias) problems.push('有一条 knownWidespread 没有 alias')
      if (!k.counts || typeof k.counts !== 'object') problems.push(`knownWidespread ${k.alias} 缺少 counts（不要写裸数字：规模必须带口径）`)
      if (!k.recompute) problems.push(`knownWidespread ${k.alias} 缺少 recompute（数字会漂移 ⇒ 必须给出可复算命令）`)
      if (!k.why) problems.push(`knownWidespread ${k.alias} 缺少 why（要说明为什么不在门禁范围）`)
    }
  }
  return { truth, problems }
}

/** 把真源里 `knownWidespread` 的规模摘要成一句人话（用于 finding 的 hint）
 *
 * ★ 这里刻意**不把数字写死**：`knownWidespread[].counts` 是"在某次提交上量的快照"，会随仓库演进漂移。
 * 所以只把真源登记的数字**如实转述**，并告诉读者"要当前值就按 `recompute` 自己跑"——
 * 避免出现"文档里的数字"与"真实规模"两处各说一套（本仓已经吃过"写死数字必然漂移"的亏）。 */
function wideSummary(truth) {
  const list = Array.isArray(truth?.knownWidespread) ? truth.knownWidespread : []
  if (!list.length) return ''
  return list.map((k) => {
    const c = k.counts || {}
    const fam = c.aliasFamily
    const ex = c.exactCaseSensitive
    const bits = []
    if (ex) bits.push(`精确写法 ${ex.lines} 处/${ex.files} 文件`)
    if (fam) bits.push(`含各种写法共 ${fam.lines} 处/${fam.files} 文件`)
    const at = k.measuredAt ? `（@${k.measuredAt} 量的快照` + (k.recompute ? '，要当前值按真源里的 recompute 命令自己跑）' : '）') : ''
    return `${k.alias}：${bits.join('、')}${at}`
  }).join('；')
}

/** 真源结构问题 → 一条红 finding（subject 固定为 brand.json，因为问题出在真源本身） */
function truthProblemFinding(problem) {
  return finding({
    rule: 'CT10', severity: RED, subject: 'brand.json',
    expected: `真源可读且结构合法（layers[] + ${REQUIRED_DECLARATIONS.length} 条 declarations + retiredAliases + knownWidespread）`,
    actual: problem,
    hint: `修 ${BRAND_TRUTH}（它是品牌的唯一真源）；声明点清单见 kit/README.md「品牌标识与名称的统一管理」一节，`
      + '或用 `node scripts/brand.mjs show` 打印当前真源',
  })
}

/**
 * CT10 主判据。
 * @param {{readTracked:Function, files?:string[]}} p
 *   `readTracked(file)` 是**已绑定 root 的读取器**（与其它 CT 规则同口径：契约规则传的是**提交态**读取器）。
 *   `files` 是本次扫描域（只用于把"读不到"讲清楚：是文件缺失，还是不在扫描域里）。
 * @returns {{check:{rule:string,title:string,evaluated:number,passed:boolean}, findings:object[]}}
 */
export function brandCheck({ readTracked = null, files = null } = {}) {
  const dir = Array.isArray(files) ? new Set(files) : null
  const { truth, problems } = loadBrandTruth({ readTracked })
  const findings = []
  const push = (f) => findings.push(f)

  // ── (c) 真源本身不可读 / 结构不合法 ────────────────────────────────────
  for (const p of problems) push(truthProblemFinding(p))
  if (truth === null) {
    return {
      check: checkResult({
        rule: 'CT10', title: '品牌声明点与品牌真源一致（名称/标识的统一管理）',
        // ★ evaluated 如实：真源不可读时**一条声明点都没检查**（不是"检查了若干条且都过"）
        evaluated: 0, passed: false,
      }),
      findings,
    }
  }

  const aliasOf = (Array.isArray(truth.retiredAliases) ? truth.retiredAliases : [])
    .filter((a) => a && typeof a.alias === 'string' && a.alias.trim() !== '')
  const decls = (Array.isArray(truth.declarations) ? truth.declarations : []).filter((d) => d && d.id)
  const read = (f) => { try { return typeof readTracked === 'function' ? readTracked(f) : null } catch { return null } }
  const texts = new Map()
  let bad = 0

  for (const decl of decls) {
    if (!texts.has(decl.file)) texts.set(decl.file, read(decl.file))
    const text = texts.get(decl.file)
    const got = extractDeclaration(decl, text)
    const inDomain = dir === null || dir.has(decl.file)
    const where = whereOf(decl)

    if (got.missing) {
      bad++
      push(finding({
        rule: 'CT10', severity: RED, subject: decl.id, file: decl.file, line: null,
        expected: describeExpects(decl, truth.layers),
        actual: `（取不到值：${got.missing}）`,
        hint: `该声明点是 ${decl.file} 的${where} —— 补回来（或改 ${BRAND_TRUTH} 里这条 declaration 的 file/kind/取值位置）`
          + `；★ 取不到值不等于"没问题"（声明点消失=品牌在这处没人看管）`
          + `${inDomain ? '' : `；另外 ${decl.file} 不在本次扫描域（files）里`}`,
      }))
      continue
    }

    // ── (a) 层名 / 字面量必须相符 ────────────────────────────────────────
    const exp = decl.expects || {}
    let ok = true
    let layerNote = ''
    if (exp.literal !== undefined) {
      ok = got.value === String(exp.literal)
    } else {
      const name = layerName(truth.layers, exp.layer)
      if (name === null) {
        // 真源里 referenced 的层不存在：这是真源的问题，按 declaration 报出（比只报 brand.json 好定位）
        bad++
        push(finding({
          rule: 'CT10', severity: RED, subject: decl.id, file: BRAND_TRUTH, line: null,
          expected: `真源 layers[] 里有 id=${exp.layer} 的层名`,
          actual: `layers[] 里没有 id=${exp.layer}（或它的 name 为空）`,
          hint: `在 ${BRAND_TRUTH} 的 layers[] 补上该层，或把这条 declaration 的 expects.layer 改成真实存在的层`,
        }))
        continue
      }
      // 层判据 = "实际值里**出现**该层名（不区分大小写）"：层名是**名字**不是整串标签，
      // 声明点通常还带别的说明文字（如「YFWorking 应用（ponos 内核版）」）
      ok = got.value.toUpperCase().includes(name.toUpperCase())
      if (!ok) layerNote = `（该值里没有层名 "${name}"）`
    }
    if (!ok) {
      bad++
      push(finding({
        rule: 'CT10', severity: RED, subject: decl.id, file: decl.file, line: got.line,
        expected: describeExpects(decl, truth.layers),
        // ★ actual 恒等于"实际取到的值"（不加装饰）—— 期望侧已写清缺的东西，说明进 hint
        actual: got.value,
        hint: `改 ${decl.file} 的${where}，让它${exp.literal !== undefined ? '精确等于期望字面量' : '包含该层名（不区分大小写）'}`
          + `${layerNote}；`
          + `或改品牌真源 ${BRAND_TRUTH} 重新定义品牌（\`node scripts/brand.mjs set <layer> <name>\` 会同步可安全同步的声明点，并列出仍需手工改的）`,
      }))
    }

    // ── (b) 受管声明点里出现废弃别名（★ 只看这段文本；别名匹配不区分大小写）──────
    for (const a of aliasOf) {
      const seg = String(got.segment)
      if (seg.toUpperCase().includes(a.alias.toUpperCase())) {
        bad++
        push(finding({
          rule: 'CT10', severity: RED, subject: decl.id, file: decl.file, line: got.line,
          expected: `不含废弃别名 "${a.alias}"（应替换为 "${a.replaceWith}"）`,
          actual: got.value,
          hint: `把 ${decl.file} 的${where}里的 "${a.alias}" 改成 "${a.replaceWith}"`
            + `（废弃理由：${a.why || '见品牌真源 retiredAliases'}）；`
            + `★ 只查**受管声明点**这一段文本（不扫整文件、更不扫全仓）—— 真源登记了散在 kernel/、kernel-tests/ 与 docs 的`
            + `同类叙述文本${wideSummary(truth)}，那是独立工作项，不在本门禁范围`,
        }))
      }
    }
  }

  return {
    check: checkResult({
      rule: 'CT10', title: '品牌声明点与品牌真源一致（名称/标识的统一管理）',
      // 如实：实际检查了几条声明点（真源里 declaration 的条数；健康态 = 8）
      evaluated: decls.length,
      passed: bad === 0 && problems.length === 0,
    }),
    findings,
  }
}
