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
const SNAPSHOT_CHAR_CAP = 20000
const VERIFY_MAX_READS = 2

/** Spec 里允许的步骤动作（写进提示词，避免模型编造 act） */
const WEB_ACTS = ['goto', 'click', 'type', 'select', 'scroll', 'hover', 'js', 'wait', 'snapshot']
const DESKTOP_ACTS = ['cli', 'script', 'focus', 'type', 'key', 'wait']

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
  '步骤里用到的选择器要来自探测素材中的真实元素；**选择器不确定就干脆不要写这条命令**，不要编造。',
  '命令参数在步骤里的写法固定为 ${参数名}（例：url:"/orders?id=${orderId}"、value:"${orderNo}"），不要用 {{参数名}} 或其它写法。',
  '给出 1 到 5 条最有价值的命令；至少 1 条 read 命令，且该 read 命令最好**不需要参数**（便于系统自动试跑验证）。',
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
  else if (mode === 'http') parts.push(`探测素材（JSON，来自页面 HTML 的静态解析；页面若有 JS 渲染可能不完整）：\n${JSON.stringify(material).slice(0, SNAPSHOT_CHAR_CAP)}`)
  else if (mode === 'http-thin') parts.push(`探测素材（JSON，来自页面 HTML，但该页面疑似**前端渲染的空壳**，素材很少，仅供参考）：\n${JSON.stringify(material).slice(0, SNAPSHOT_CHAR_CAP)}`)
  else parts.push('探测素材：（无）')
  if (Array.isArray(previousErrors) && previousErrors.length) {
    parts.push(`上一轮输出不合法，错误如下：\n${previousErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n请仅输出修正后的完整 JSON。`)
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
    const seen = new Set()
    for (const [i, c] of spec.commands.entries()) {
      const at = `commands[${i}]`
      if (!c?.action || typeof c.action !== 'string') errors.push(`${at} 缺少 action`)
      else if (seen.has(c.action)) errors.push(`${at} action 重复：${c.action}`)
      else seen.add(c.action)
      if (c?.kind !== 'read' && c?.kind !== 'write') errors.push(`${at} kind 必须是 read 或 write`)
      if (c?.params !== undefined && !Array.isArray(c.params)) errors.push(`${at} params 必须是数组`)
      if (!Array.isArray(c?.steps) || c.steps.length === 0) errors.push(`${at} steps 不能为空`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 生成 Spec（≤maxRounds 轮，失败回喂修正）。
 * @param {{target:object, probeMaterial:object, callLlm:Function, maxRounds?:number, onProgress?:Function, validate?:Function}} p
 * @returns {Promise<{ok:boolean, spec:object|null, rounds:number, issues:string[], raw:string}>}
 */
async function generateSpec({ target, probeMaterial, probeMode, callLlm, maxRounds = MAX_ROUNDS, onProgress, validate } = {}) {
  const check = validate || validateSpecBasic
  const issues = []
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
      if (!r?.ok) failures.push({ action: c.action, error: String(r?.error || '执行失败') })
    } catch (e) {
      failures.push({ action: c.action, error: String(e?.message || e) })
    }
  }
  return { ok: failures.length === 0, tried, failures, notRun, skipped: needsArgs.map((c) => c.action) }
}

module.exports = {
  buildPrompt, extractSpec, generateSpec, verifySpec, validateSpecBasic, snapshotForPrompt,
  MAX_ROUNDS, VERIFY_MAX_READS, SNAPSHOT_CHAR_CAP, SYSTEM_RULES, NO_PROBE_RULES, WEB_ACTS, DESKTOP_ACTS,
}
