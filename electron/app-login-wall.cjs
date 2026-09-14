// 应用智控：**登录墙检测**（纯函数、零 Electron 依赖 —— 不得顶层 require Electron，必须能被 node --test 直接加载）。
//
// ★ 为什么要有它：用户诉求"允许在获取的过程中提示用户登录"。但"见标题带登录二字就弹窗"
//   会给大量无需登录的站点白弹窗口（用户明确要求：**仅高置信度自动弹窗，中/弱信号只提示**）。
//   所以这里把信号分三级：
//     high   = 密码框 / 快照 logged_in=false / 地址是登录页    → 允许自动 openWindow
//     medium = 标题或正文提到登录（只看正文前 1500 字符）        → 只在面板提示
//     low    = 疑似前端空壳且交互线索极少                       → 只在面板提示
//   只有 high 才自动弹窗，其余一律交给用户判断（HIGH_ONLY）。
'use strict'

// LOGIN_PATH_RE 的**唯一出处**是 app-login-page.cjs（登录编排的成功判定也用它）——此处只复用，不复制。
const { LOGIN_PATH_RE, snapshotHasPassword } = require('./app-login-page.cjs')

/** 允许自动弹窗的置信度集合（唯一定义处，勿在别处再写一遍字符串判断） */
const HIGH_ONLY = ['high']

const LOGIN_TEXT_RE = /(请登录|立即登录|去登录|账号登录|密码登录|登录已过期|未登录|重新登录|请先登录|sign\s?in|log\s?in|please log in|session expired)/i

// ★ 严格密码框正则：要求 `type` 前是空白（挡住 `<input data-type="password">` 这类自定义属性，
//   HTML 属性名不允许内嵌连字符后又被当成独立属性），且值必须是完整的 password
//  （挡住 `<input type="passwordx">`）。
//   app-http-probe.cjs 里的宽松版 `/<input[^>]+type\s*=\s*["']?password/i` 这两类都会误判。
const STRICT_PASSWORD_INPUT_RE = /<input\b[^>]*\stype\s*=\s*["']?password["'\s/>]/i

function urlOf(...cands) {
  for (const c of cands) if (typeof c === 'string' && c) return c
  return ''
}

function parse(u) {
  try { return new URL(u) } catch { return null }
}

/** 素材里可用的原始 HTML（目前 extractPageMaterial 不返回，属**防御性**分支：将来补上即自动启用严格复核） */
function rawHtmlOf(material) {
  if (!material || typeof material !== 'object') return ''
  for (const k of ['rawHtml', 'html', 'raw']) {
    if (typeof material[k] === 'string' && material[k]) return material[k]
  }
  return ''
}

/** 表单字段里的密码框 —— 抽取层把 type 归一化到字段上，且只扫 <form> 内，通常比全局宽松 hasPassword 可靠。
 *  ★ 残留风险：attr() 的正则没有词边界，`<input data-type="password">` 会被读成 type=password，
 *    故**原文可用时以严格正则为准**（见 passwordEvidence 的优先级）。 */
function hasPasswordField(material) {
  const forms = Array.isArray(material?.forms) ? material.forms : []
  return forms.some((f) => {
    const fields = Array.isArray(f?.fields) ? f.fields : []
    return fields.some((x) => String(x?.type || '').toLowerCase() === 'password'
      && String(x?.tag || 'input').toLowerCase() === 'input')
  })
}

/**
 * 密码框证据（登录墙最强的硬信号），带**误报加固**。
 * 复核优先级（越靠前越可信）：原始 HTML 的严格正则 > 表单字段 > 宽松 hasPassword：
 *   1) 素材带原始 HTML（rawHtml/html/raw）→ 以严格正则为准（原文可复核时它就是权威），
 *      能挡住 data-type="password"、type="passwordx"，也能挡住下面第 2 项的"字段被污染"问题；
 *   2) 无原文但有表单字段 → forms[].fields[] 里有 tag=input && type=password；
 *   3) 都拿不到 → **保留** hasPassword 为强信号，但标注"未复核"。
 *      ★ 取舍：漏判真实登录墙的代价（用户拿不到素材、功能不可用）远大于多弹一次窗口的代价；
 *        而严格复核所需的原文当前抽取层不返回，故此处不做"无据降级"，只如实标注。
 * @returns {{hit:boolean, strict:boolean, source:'none'|'raw-html'|'raw-html-rejected'|'field'|'hasPassword'}}
 */
function passwordEvidence(material) {
  if (!material || typeof material !== 'object') return { hit: false, strict: true, source: 'none' }
  const raw = rawHtmlOf(material)
  if (raw) {
    return STRICT_PASSWORD_INPUT_RE.test(raw)
      ? { hit: true, strict: true, source: 'raw-html' }
      : { hit: false, strict: true, source: 'raw-html-rejected' }
  }
  if (hasPasswordField(material)) return { hit: true, strict: true, source: 'field' }
  if (material.hasPassword !== true) return { hit: false, strict: true, source: 'none' }
  return { hit: true, strict: false, source: 'hasPassword' }
}

function passwordReason(ev) {
  if (ev.source === 'field') return '表单里有密码字段（登录墙强信号）'
  if (ev.strict) return '页面上有密码输入框（登录墙强信号）'
  // 宽松判定且无原文可复核：如实标注，便于面板/报告提示"建议人工确认"
  return '页面上疑似有密码输入框（登录墙强信号；hasPassword 为宽松判定、未复核，可能是 data-type/type=passwordx 之类误报）'
}

/** loginUrl：优先同源的表单 action，其次（本页就是登录页时）本页地址；跨站 action 一律忽略（返回 null） */
function pickLoginUrl(material, pageUrl) {
  const base = parse(pageUrl)
  const forms = Array.isArray(material?.forms) ? material.forms : []
  for (const f of forms) {
    if (!f || !f.action) continue
    try {
      const u = new URL(String(f.action), pageUrl)
      if (base && u.origin === base.origin && /^https?:$/.test(u.protocol)) return u.toString()
    } catch { /* 非法 action 忽略 */ }
  }
  if (base && LOGIN_PATH_RE.test(base.pathname)) return base.toString()
  return null
}

/**
 * 判断"这个页面是不是登录墙"，并给出置信度分级（只有 high 允许自动弹窗）。
 * @param {{material?:object, page?:object, url?:string}} p
 *   material 来自 app-http-probe（静态 HTML 解析），page 来自浏览器快照的 page 字段
 * @returns {{needed:boolean, confidence:'high'|'medium'|'low'|'none', reasons:string[], loginUrl:string|null}}
 */
function detectLoginWall({ material, page, url } = {}) {
  const pageUrl = urlOf(url, material?.url, page?.url)
  const reasons = []
  let confidence = 'none'
  const bump = (level) => {
    const order = { none: 0, low: 1, medium: 2, high: 3 }
    if (order[level] > order[confidence]) confidence = level
  }

  const pw = passwordEvidence(material)
  if (pw.hit) {
    bump('high'); reasons.push(passwordReason(pw))
  }
  if (snapshotHasPassword(page)) {
    bump('high'); reasons.push('快照里有密码输入框（登录墙强信号）')
  }
  if (page?.logged_in === false) {
    bump('high'); reasons.push('页面明确显示未登录（快照 logged_in=false）')
  }
  const u = parse(pageUrl)
  if (u && LOGIN_PATH_RE.test(u.pathname)) {
    bump('high'); reasons.push(`地址像登录页（${u.pathname}）`)
  }

  // 文字信号只看标题/描述/正文前 1500 字符：正文很长时，"登录"二字常出现在页脚/帮助链接里，不足为凭
  const title = String(material?.title || page?.title || '')
  const desc = String(material?.description || '')
  const text = String(material?.text || '')
  if (LOGIN_TEXT_RE.test(title) || LOGIN_TEXT_RE.test(desc) || LOGIN_TEXT_RE.test(text.slice(0, 1500))) {
    bump('medium'); reasons.push('页面文字提到登录（可能是登录墙提示，请人工确认）')
  }

  const interactives = Number(material?.interactives ?? (Array.isArray(page?.interactives) ? page.interactives.length : NaN))
  if (Number.isFinite(interactives) && interactives < 3 && (material?.spa === true || material?.site?.pagesFetched === 1)) {
    bump('low'); reasons.push('页面疑似前端渲染的空壳且可交互线索极少（可能登录后才渲染）')
  }

  return { needed: confidence !== 'none', confidence, reasons, loginUrl: pickLoginUrl(material, pageUrl) }
}

module.exports = { detectLoginWall, HIGH_ONLY, LOGIN_PATH_RE, LOGIN_TEXT_RE, STRICT_PASSWORD_INPUT_RE }
