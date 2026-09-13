// 应用智控：由 LLM 生成 App Spec（Task 3.1 + 3.2）
//
// 设计要点（照计划的原则）：
//   · 可纯函数化的全部抽出（buildPrompt / extractSpec / snapshotForPrompt），
//     于是 `callLlm` 可注入 → 用**假 LLM** 就能回归全部逻辑，不需要真模型。
//   · 最多 MAX_ROUNDS 轮：把上一轮的错误**回喂**给模型要求修正；不无限循环。
//   · 试跑只跑 read 命令、最多 2 条；**write 绝不试跑**（会在目标应用里产生真实改动）。
//
// ★ 生成结果**不落盘**：必须经用户在界面上确认后才写（计划 Task 3.2 的硬要求）。
'use strict'

const MAX_ROUNDS = 3
/**
 * 素材喂给模型的字符上限。用户明确"不要期望 llm 分析生成很快完成，要让模型尽可能充分
 * 获取所有能控制的接口信息"——多页素材本身就更大，上限太小会把后面的页面截掉，模型又只能瞎猜。
 * 20k 字节约 6~8k token，对现代模型完全可接受。
 */
const SNAPSHOT_CHAR_CAP = 20000
const VERIFY_MAX_READS = 3

/** Spec 里允许的步骤动作（写进提示词，避免模型编造 act） */
const WEB_ACTS = ['goto', 'click', 'type', 'select', 'scroll', 'hover', 'js', 'wait', 'snapshot']
const DESKTOP_ACTS = ['cli', 'script', 'focus', 'type', 'key', 'wait']

/**
 * 各 act 的**字段契约 —— 唯一事实来源**，同时驱动「提示词」与「结构校验」。
 *
 * 为什么必须有它（真实故障）：用户实测生成命令，试跑报 `步骤 js 失败：js 缺少 expression`。
 * 根因是提示词只列了 act 名字、从不说每个 act 要什么字段，校验也只查 steps 非空 → 模型写出
 * `{act:'js'}`（或把表达式塞进 code/script）也能过校验，直到试跑才炸。
 * 更严重的是：提示词此前让模型"用探测素材里的选择器"，但执行器的 click/type/select/hover
 * 要的是 **ref**（快照里的元素编号）而不是 CSS 选择器 —— 契约写错，模型再聪明也写不对。
 *
 * 字段来源（已逐个核对实现）：
 *   electron/browser-executor.cjs —— goto.url / click.ref / type.ref+text / select.ref+value /
 *   scroll.ref|delta / hover.ref / js.expression / wait.ms|ref
 *   electron/app-runner-desktop.cjs —— cli.argv / script.lang+(file|code) / focus·type·key·wait
 * 注意 type/wait 在两侧**语义不同**（web 用 ref+text，desktop 用 value），所以按驱动分表。
 *
 * 表达法：required=全部必填（且）；anyOf=若干"组"，每组内部是"或"、组之间是"且"
 * （所以"有 a 或 b"要写成 anyOf: [['a','b']]）。
 */
const WEB_CONTRACT = {
  goto: { required: ['url'], note: 'url 可写绝对地址或相对路径（相对 target.url 解析）' },
  click: { required: ['ref'], note: 'ref 是**同一条命令内、前一个 snapshot 步骤**给出的元素编号；不要沿用生成时的编号' },
  type: { required: ['ref', 'text'], optional: ['clear'], note: 'text 里可用 ${参数名} 插值' },
  select: { required: ['ref', 'value'] },
  scroll: { anyOf: [['ref', 'delta']], note: 'ref（滚到某元素）或 delta（像素数，正数向下）二选一' },
  hover: { required: ['ref'] },
  js: { required: ['expression'], note: '**字段名就是 expression**（不是 code / script / value）；表达式在页面上下文求值，返回值即命令结果' },
  wait: { anyOf: [['ms', 'ref']], note: 'ms（毫秒）或 ref（等某元素出现）二选一' },
  snapshot: { optional: ['save'], note: '命令步骤里用 save:"键名" 把快照文本作为该命令的返回结果（读取类命令的标准写法）' },
}

const DESKTOP_CONTRACT = {
  cli: { required: ['argv'], note: 'argv 为字符串数组，如 ["--version"]' },
  script: { required: ['lang'], anyOf: [['file', 'code']], note: 'lang 如 powershell/js，并用 file 或 code 提供脚本内容' },
  focus: { optional: ['ref'] },
  type: { required: ['value'], note: '向当前焦点窗口输入文本' },
  key: { required: ['value'], note: '如 "^s"、"Enter"' },
  wait: { anyOf: [['ms', 'ref']] },
}

const ACT_CONTRACT = { web: WEB_CONTRACT, desktop: DESKTOP_CONTRACT }
const contractFor = (act, driver) => (driver === 'desktop' ? DESKTOP_CONTRACT : WEB_CONTRACT)[act]

/** 把契约渲染成提示词条目（模型照着写，就不会再缺字段） */
function actContractLines() {
  const render = (act, table) => {
    const c = table[act]
    if (!c) return `· ${act}`
    const parts = []
    const req = (c.required || []).map((f) => `"${f}"`).join(' + ')
    if (req) parts.push(req)
    for (const g of c.anyOf || []) parts.push(g.map((f) => `"${f}"`).join(' 或 '))
    return `· ${act}：必填 ${parts.join('，并且 ') || '（无）'}${c.optional?.length ? `（可选 ${c.optional.map((f) => `"${f}"`).join('/')}）` : ''}${c.note ? ` —— ${c.note}` : ''}`
  }
  return [
    'web 步骤字段契约（**严格照这个写，字段名不能自创**）：',
    ...WEB_ACTS.map((a) => render(a, WEB_CONTRACT)),
    'desktop 步骤字段契约：',
    ...DESKTOP_ACTS.map((a) => render(a, DESKTOP_CONTRACT)),
  ].join('\n')
}

const SYSTEM_RULES = [
  '你是「应用即工具」的规格撰写器。用户会给你一个目标（网站或桌面应用）以及真实探测素材，你要产出**一个 JSON 对象**作为 App Spec。',
  '只输出 JSON 本体，不要解释、不要 Markdown 说明文字。',
  '结构要求：{"specVersion":1,"appId":"...","name":"...","desc":"...","target":{...},"expose":{"mode":"console"},"commands":[...]}。',
  'target：web 用 {"type":"web","url":"..."}；desktop 用 {"type":"desktop","exePath":"..."}。',
  'expose.mode 固定写 "console"（仅进入控制台的会话可见）；**禁止**写 "public"。',
  'commands 每项：{"action":"英文驼峰且唯一","title":"中文短标题","kind":"read|write","params":[{"name":"...","type":"string","required":true,"desc":"..."}],"steps":[...],"returns":{"type":"text|json","from":"保存键名"}}。',
  'params **必须是数组**（没有参数就写 []）；每个参数都要说明用途，方便用户填写。',
  'kind 判定：只读/查询/导出/查看 → "read"；提交/保存/修改/删除/发送/下发 → "write"。拿不准一律按 "write"（更保守）。',
  `web 的 steps.act 只能取：${WEB_ACTS.join(', ')}；desktop 的 steps.act 只能取：${DESKTOP_ACTS.join(', ')}。`,
  actContractLines(),
  '**元素引用规则（最容易写错，务必遵守）**：click/type/select/hover 要的是 ref（元素编号），**不是 CSS 选择器**；ref 只能由**同一条命令内前一步的 snapshot** 产生（快照按顺序从 1 编号，每次快照都会变），所以：',
  '· 命令内若要用 ref，steps 必须先有一步 {"act":"snapshot"}，再用该次快照里的 ref；',
  '· 拿不准 ref 时，**优先改用 js 表达式**直接操作最稳（例：{"act":"js","expression":"document.querySelector(\'#submit\').click()"}）；',
  '· 纯读取类命令首选 {"act":"goto"} + {"act":"snapshot","save":"r"}，或 {"act":"js","expression":"document.body.innerText"} —— 两者都不依赖 ref。',
  '命令参数在步骤里的写法固定为 ${参数名}（例：url:"/orders?id=${orderId}"、text:"${keyword}"），不要用 {{参数名}} 或其它写法。',
  '给出 3 到 8 条最有价值的命令，**尽量覆盖素材里出现的主要功能入口**（不同页面/不同表单都算）；',
  '其中至少 2 条 read 命令，且至少 1 条 read 命令**不需要参数**（便于系统自动试跑验证）。',
  '绝对不要写入口令、令牌、密钥、身份证号等敏感信息。',
].join('\n')

/** 没有探测素材时追加的补充规则：明确告诉模型"你在靠公开知识推断"，并要求保守 */
const NO_PROBE_RULES = [
  '注意：本次**没有拿到页面/程序的探测素材**（可能是登录后才可见、纯前端渲染或抓取被拒）。',
  '请基于该站点/程序的公开常识推断最常见的操作路径，并遵守：',
  '· 优先用「导航到某个 URL + snapshot 取快照」这类**不依赖具体选择器**的命令；',
  '· 万不得已才用选择器，且只用最保守的写法（如 input[type=search]、button[type=submit]、form 等通用选择器）；',
  '· commands 数量取小（1~3 条），不要编造细节参数；',
  '· 每条命令的 title 里不必标注，但不要假装你看到过页面。',
].join('\n')

/** 把浏览器快照裁成适合塞进提示词的形状（真实字段：page/interactives[{ref,tag,label,path_hint}]） */
function snapshotForPrompt(snap) {
  if (!snap || typeof snap !== 'object') return null
  const out = {
    page: snap.page
      ? { url: snap.page.url, title: snap.page.title, readyState: snap.page.readyState, loading: snap.page.loading, captcha: snap.page.captcha, logged_in: snap.page.logged_in }
      : undefined,
    text: typeof snap.text === 'string' ? snap.text.slice(0, 4000) : undefined,
    // info：页面上的非交互文本（label/value，如表格数据与状态文案）。真实快照的正文在这里，
    // 而它此前没进提示词——模型只看得到可点元素，看不到"页面里有什么内容"。
    info: Array.isArray(snap.info) ? snap.info.slice(0, 80) : undefined,
    interactives: Array.isArray(snap.interactives)
      ? snap.interactives.slice(0, 120).map((e) => ({ ref: e.ref, tag: e.tag, label: e.label, path_hint: e.path_hint, href: e.href }))
      : undefined,
  }
  return out
}

/**
 * 组装提示词。纯函数——同一入参必得同一出参，便于测试与排障。
 * @param {{target:object, probeMaterial:object, previousErrors?:string[], probeMode?:'browser'|'http'|'http-thin'|'none'}} p
 *   probeMode 决定素材可信度：browser（真实 DOM 快照）> http（后台抓取的静态 HTML）> http-thin（页面是 JS 壳）
 *   > none（没拿到素材 → 追加 NO_PROBE_RULES，让模型靠公开知识保守推断）
 * @returns {{system:string, user:string}}
 */
function buildPrompt({ target, probeMaterial, previousErrors, probeMode } = {}) {
  const parts = []
  parts.push(`目标：${JSON.stringify(target || {})}`)
  const material = { ...(probeMaterial || {}) }
  if (Array.isArray(previousErrors) && previousErrors.length) material.previousErrors = previousErrors
  const noMaterial = !probeMaterial || (typeof probeMaterial === 'object' && Object.keys(probeMaterial).length === 0)
  const mode = probeMode || (noMaterial ? 'none' : 'browser')
  if (mode === 'browser') parts.push(`探测素材（JSON，来自真实页面的 DOM 快照）：\n${JSON.stringify(material).slice(0, SNAPSHOT_CHAR_CAP)}`)
  else if (mode === 'http') {
    const pages = Array.isArray(material.pages) ? material.pages.length : 0
    parts.push(
      `探测素材（JSON，来自 ${pages ? `${pages + 1} 个` : ''}页面的 HTML 静态解析${
        pages ? '，已覆盖首页与同源主要页面' : '；页面若有 JS 渲染可能不完整'
      }）：\n${JSON.stringify(material).slice(0, SNAPSHOT_CHAR_CAP)}`,
    )
    if (pages) parts.push(`请**优先覆盖这些页面里暴露的主要功能入口**（表单/按钮/导航），而不是只写首页能做的事。`)
  } else if (mode === 'http-thin') parts.push(`探测素材（JSON，来自页面 HTML，但该页面疑似**前端渲染的空壳**，素材很少，仅供参考）：\n${JSON.stringify(material).slice(0, SNAPSHOT_CHAR_CAP)}`)
  else parts.push('探测素材：（无）')
  if (Array.isArray(previousErrors) && previousErrors.length) {
    parts.push(`上一轮结果有问题（结构校验或试跑失败），错误如下：\n${previousErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n请针对这些错误修正后，仅输出修正完的完整 JSON。`)
  }
  parts.push('请产出完整 App Spec JSON。')
  const system = mode === 'none' || mode === 'http-thin' ? `${SYSTEM_RULES}\n${NO_PROBE_RULES}` : SYSTEM_RULES
  return { system, user: parts.join('\n\n') }
}

/** 从模型输出里抠出 Spec；三种格式都试，全失败返回 null（不抛错） */
function extractSpec(llmText) {
  const text = String(llmText || '')
  if (!text.trim()) return null
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s)
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null
    } catch {
      return null
    }
  }
  // ① ```json 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const got = tryParse(fence[1].trim())
    if (got) return got
  }
  // ② 整段就是 JSON
  const direct = tryParse(text.trim())
  if (direct) return direct
  // ③ 首个 { 到末个 } 的子串
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s >= 0 && e > s) {
    const got = tryParse(text.slice(s, e + 1))
    if (got) return got
  }
  return null
}

/**
 * 结构自检。
 * ★ 诚实说明：内核 kernel/app-spec.mjs 的 validateSpec 是 Spec 结构的**定义真源**，
 *   但截至本次实现，全仓库**没有任何调用点**（cli.mjs 挂载工具时并不校验），
 *   所以「Spec 是否合法」当前实际由本函数把关。
 *   另外打包产物不含 kernel/ 源码（electron-builder 的 files 白名单），主进程也 require 不到它。
 * @returns {{ok:boolean, errors:string[]}}
 */
const actSetFor = (driver) => (driver === 'desktop' ? DESKTOP_ACTS : WEB_ACTS)

/** 字段"有值"的判定：字符串非空、数组非空、其它非 null/undefined */
const hasField = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)

/**
 * 逐步骤校验字段契约。真实故障驱动的补充（见 ACT_CONTRACT 注释）：
 * 此前只查 "steps 不能为空"，于是缺 expression 的 js 步骤、把 ref 写成 selector 的点击步骤
 * 都能通过校验，一路走到试跑才报错——用户看到的就是"试跑未通过"。
 */
function validateStepFields(step, at, driver, errors) {
  if (!step || typeof step !== 'object') { errors.push(`${at} 不是对象`); return }
  const act = step.act
  if (!act || typeof act !== 'string') { errors.push(`${at} 缺少 act`); return }
  const acts = actSetFor(driver)
  if (!acts.includes(act)) {
    errors.push(`${at}.act 不合法：${act}（${driver === 'desktop' ? 'desktop' : 'web'} 只允许 ${acts.join(' / ')}）`)
    return
  }
  const c = contractFor(act, driver) || {}
  for (const f of c.required || []) {
    if (hasField(step[f])) continue
    // js 专治：模型常把表达式塞进 code/script/value —— 点名告诉它改哪个字段名
    const alias = act === 'js' ? ['code', 'script', 'value', 'expr'].find((k) => hasField(step[k])) : undefined
    errors.push(`${at}（${act}）缺少必填字段 "${f}"${alias ? `——内容写在了 "${alias}"，请改名为 "${f}"` : ''}`)
  }
  for (const g of c.anyOf || []) {
    if (!g.some((f) => hasField(step[f]))) errors.push(`${at}（${act}）至少要有其中一个字段：${g.map((f) => `"${f}"`).join(' 或 ')}`)
  }
  // ref 误写成 selector 是最常见的错法（执行器要元素编号，不要 CSS 选择器），直接点名纠正
  if ((c.required || []).includes('ref') && !hasField(step.ref) && hasField(step.selector)) {
    errors.push(`${at}（${act}）要的是 "ref"（元素编号，来自同一条命令内前一步的 snapshot），不是 CSS 选择器 "selector"；若想按选择器操作请改用 js 步骤`)
  }
}

function validateSpecBasic(spec, { allowPublic = false } = {}) {
  const errors = []
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['Spec 不是对象'] }
  if (spec.specVersion !== 1) errors.push('specVersion 必须为 1')
  if (!spec.name || typeof spec.name !== 'string') errors.push('缺少 name')
  const t = spec.target
  if (!t || typeof t !== 'object') errors.push('缺少 target')
  else if (t.type === 'web') {
    try {
      const u = new URL(String(t.url || ''))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('target.url 必须是 http/https')
    } catch {
      errors.push('target.url 不是合法 URL')
    }
  } else if (t.type === 'desktop') {
    if (!t.exePath || typeof t.exePath !== 'string') errors.push('desktop 缺少 target.exePath')
  } else {
    errors.push(`target.type 不合法：${String(t.type)}`)
  }
  // allowPublic 默认 false：LLM 生成路径不得写出 public（否则该应用的工具在所有会话可见，绕过绑定机制）。
  // 只有用户在界面上显式选择「全局可用」时才由调用方传 true。
  if (spec.expose?.mode === 'public' && !allowPublic) {
    errors.push('expose.mode=public 需在界面上显式开启「全局可用」（默认不允许，避免绕过控制台绑定机制）')
  }
  if (!Array.isArray(spec.commands)) errors.push('commands 必须是数组')
  else if (spec.commands.length === 0) errors.push('commands 不能为空（至少 1 条命令）')
  else {
    // driver 决定可用 act 集合：spec.driver 优先（已生成过的 spec 可能带），否则按 target.type
    const driver = spec.driver === 'desktop' || t?.type === 'desktop' ? 'desktop' : 'web'
    const seen = new Set()
    for (const [i, c] of spec.commands.entries()) {
      const at = `commands[${i}]`
      if (!c?.action || typeof c.action !== 'string') errors.push(`${at} 缺少 action`)
      else if (seen.has(c.action)) errors.push(`${at} action 重复：${c.action}`)
      else seen.add(c.action)
      if (c?.kind !== 'read' && c?.kind !== 'write') errors.push(`${at} kind 必须是 read 或 write`)
      if (c?.params !== undefined && !Array.isArray(c.params)) errors.push(`${at} params 必须是数组`)
      if (!Array.isArray(c?.steps) || c.steps.length === 0) errors.push(`${at} steps 不能为空`)
      else c.steps.forEach((s, j) => validateStepFields(s, `${at}.steps[${j}]`, driver, errors))
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 生成 Spec（≤maxRounds 轮，失败回喂修正）。
 * @param {{target:object, probeMaterial:object, callLlm:Function, maxRounds?:number, onProgress?:Function, validate?:Function}} p
 * @returns {Promise<{ok:boolean, spec:object|null, rounds:number, issues:string[], raw:string}>}
 */
/**
 * @param {object} p
 * @param {string[]} [p.seedErrors] 外部先验错误（典型：上一份 Spec 的**试跑失败原因**）。
 *   有它才能做到"试跑不过 → 回喂失败原因让模型改 → 再试跑"，而不是把跑不通的命令丢给用户。
 */
async function generateSpec({ target, probeMaterial, probeMode, callLlm, maxRounds = MAX_ROUNDS, onProgress, validate, seedErrors } = {}) {
  const check = validate || validateSpecBasic
  const issues = Array.isArray(seedErrors) ? seedErrors.slice() : []
  let raw = ''
  let round = 0
  // 流式增量节流：模型可能几十 token/秒，逐 token 发 IPC 会把渲染层刷爆。
  // 累计到 200 字符或每 150ms 才发一次，界面看到的是真实内容而非假打字机。
  let lastEmitAt = 0
  let pendingDelta = ''
  for (round = 1; round <= maxRounds; round++) {
    const { system, user } = buildPrompt({ target, probeMaterial, probeMode, previousErrors: issues.length ? issues.slice() : undefined })
    onProgress?.({ phase: 'round', round, maxRounds, detail: `第 ${round}/${maxRounds} 轮：请求模型生成 Spec…` })
    lastEmitAt = 0
    pendingDelta = ''
    const r = await callLlm({
      system,
      user,
      onDelta: (d, total) => {
        pendingDelta += d || ''
        const now = Date.now()
        if (now - lastEmitAt >= 150 || pendingDelta.length >= 200) {
          lastEmitAt = now
          onProgress?.({ phase: 'stream', round, maxRounds, chars: total, delta: pendingDelta })
          pendingDelta = ''
        } else {
          onProgress?.({ phase: 'stream', round, maxRounds, chars: total })
        }
      },
    })
    if (pendingDelta) {
      onProgress?.({ phase: 'stream', round, maxRounds, chars: (r?.text || '').length, delta: pendingDelta })
      pendingDelta = ''
    }
    if (!r?.ok) {
      // 模型调用失败（网络/鉴权/超时）：不假装重试成功，直接把真实原因抛给界面
      issues.push(`模型调用失败：${r?.error || '未知错误'}`)
      onProgress?.({ phase: 'error', round, maxRounds, detail: issues[issues.length - 1] })
      return { ok: false, spec: null, rounds: round, issues, raw: r?.text || '' }
    }
    raw = r.text
    onProgress?.({ phase: 'parse', round, maxRounds, chars: raw.length, detail: `已收到 ${raw.length} 字符，正在解析 JSON…` })
    const spec = extractSpec(raw)
    if (!spec) {
      issues.push('输出不是合法 JSON')
      onProgress?.({ phase: 'invalid', round, maxRounds, detail: '模型输出不是合法 JSON，准备回喂修正' })
      continue
    }
    // appId 唯一真源是目录名；这里只补全缺省字段，最终以写盘时对齐
    const normalized = { ...spec, expose: { ...(spec.expose || {}), mode: spec.expose?.mode === 'public' ? 'console' : (spec.expose?.mode || 'console') } }
    const v = check(normalized)
    if (!v.ok) {
      issues.push(...v.errors)
      onProgress?.({ phase: 'invalid', round, maxRounds, detail: `结构校验未通过：${v.errors.slice(0, 3).join('；')}` })
      continue
    }
    onProgress?.({ phase: 'parsed', round, maxRounds, detail: `已生成 ${normalized.commands.length} 条命令` })
    return { ok: true, spec: normalized, rounds: round, issues, raw }
  }
  return { ok: false, spec: null, rounds: round - 1, issues, raw }
}

/**
 * 实跑验证（Task 3.2）：只试跑 read 命令、最多 VERIFY_MAX_READS 条。
 * 硬规则：write 绝不试跑；没有可跑的 read → ok:false 并说明原因（否则等于没验证）。
 * @returns {Promise<{ok:boolean, tried:string[], failures:{action:string,error:string}[], notRun:string[], skipped:string[]}>}
 */
async function verifySpec({ spec, runCommand, sessionId, maxReads = VERIFY_MAX_READS, onProgress } = {}) {
  const cmds = Array.isArray(spec?.commands) ? spec.commands : []
  const reads = cmds.filter((c) => c.kind === 'read')
  const notRun = cmds.filter((c) => c.kind !== 'read').map((c) => c.action)
  const needsArgs = reads.filter((c) => (c.params || []).some((p) => p.required))
  const runnable = reads.filter((c) => !(c.params || []).some((p) => p.required))
  const tried = []
  const failures = []

  if (runnable.length === 0) {
    const why = reads.length
      ? '可试跑的查询命令都需要参数，无法自动验证（建议至少提供一条无需参数的查询命令）'
      : '无法验证：请至少提供一条查询类命令（kind: read）'
    onProgress?.({ phase: 'verify', detail: why })
    return { ok: false, tried, failures: [{ action: '-', error: why }], notRun, skipped: needsArgs.map((c) => c.action) }
  }

  for (const c of runnable.slice(0, maxReads)) {
    tried.push(c.action)
    onProgress?.({ phase: 'verify', detail: `试跑查询命令 ${c.action}…` })
    try {
      const r = await runCommand({ action: c.action, args: {}, sessionId })
      if (!r?.ok) {
        const error = String(r?.error || '执行失败')
        failures.push({ action: c.action, error })
        // 失败原因必须立刻上报：用户看到的就是"试跑未通过"，不给出原因等于让他猜
        onProgress?.({ phase: 'verify', detail: `试跑失败 ${c.action}：${error.slice(0, 200)}` })
      }
    } catch (e) {
      const error = String(e?.message || e)
      failures.push({ action: c.action, error })
      onProgress?.({ phase: 'verify', detail: `试跑失败 ${c.action}：${error.slice(0, 200)}` })
    }
  }
  return { ok: failures.length === 0, tried, failures, notRun, skipped: needsArgs.map((c) => c.action) }
}

module.exports = {
  buildPrompt, extractSpec, generateSpec, verifySpec, validateSpecBasic, validateStepFields, snapshotForPrompt,
  MAX_ROUNDS, VERIFY_MAX_READS, SNAPSHOT_CHAR_CAP, SYSTEM_RULES, NO_PROBE_RULES, WEB_ACTS, DESKTOP_ACTS,
  ACT_CONTRACT, WEB_CONTRACT, DESKTOP_CONTRACT, contractFor, actContractLines,
}
