// 应用智控：**登录墙检测**（纯函数、零 Electron 依赖 —— 不得顶层 require Electron，必须能被 node --test 直接加载）。
//
// ★ 为什么要有它：用户诉求"允许在获取的过程中提示用户登录"。但"见标题带登录二字就弹窗"
//   会给大量无需登录的站点白弹窗口（用户明确要求：**仅高置信度自动弹窗，中/弱信号只提示**）。
//   所以这里把信号分三级：
//     high   = 密码框 / 快照 logged_in=false / 地址是登录页    → 允许自动 openWindow
//     medium = 标题或正文提到登录（只看正文前 1500 字符）        → 只在面板提示
//     low    = 疑似前端空壳且交互线索极少                       → 只在面板提示
//   只有 high 才自动弹窗，其余一律交给用户判断（HIGH_ONLY）。
// ★ 密码框信号的可信度由**抽取层**决定：app-http-probe.cjs 的 attr()（属性名带左边界）与
//   hasPassword（严格正则）已在源头挡住 `data-type="password"`、`type="passwordx"` 之类误报；
//   本模块不再自己复核原文（生产者从不返回 rawHtml/html/raw，那条路径生产不可达）。
'use strict'

// LOGIN_PATH_RE 的**唯一出处**是 app-login-page.cjs（登录编排的成功判定也用它）——此处只复用，不复制。
const { LOGIN_PATH_RE, snapshotHasPassword } = require('./app-login-page.cjs')

/** 允许自动弹窗的置信度集合（唯一定义处，勿在别处再写一遍字符串判断）。
 *  ★ 冻结：它是"只有 high 才自动弹窗"的唯一开关，绝不能被外部 push 污染（HIGH_ONLY.includes 用法不受影响）。 */
const HIGH_ONLY = Object.freeze(['high'])

const LOGIN_TEXT_RE = /(请登录|立即登录|去登录|账号登录|密码登录|登录已过期|未登录|重新登录|请先登录|sign\s?in|log\s?in|please log in|session expired)/i

function urlOf(...cands) {
  for (const c of cands) if (typeof c === 'string' && c) return c
  return ''
}

function parse(u) {
  try { return new URL(u) } catch { return null }
}

/** 表单字段里的密码框 —— 抽取层（app-http-probe.cjs）把 type 归一化到字段上，只扫 <form> 内。
 *  ★ 可信前提：抽取层的 attr() 已带左边界，`data-type="password"` 不会再被读成 type=password（见那边的注释）。 */
function hasPasswordField(material) {
  const forms = Array.isArray(material?.forms) ? material.forms : []
  return forms.some((f) => {
    const fields = Array.isArray(f?.fields) ? f.fields : []
    return fields.some((x) => String(x?.type || '').toLowerCase() === 'password'
      && String(x?.tag || 'input').toLowerCase() === 'input')
  })
}

/**
 * 密码框证据（登录墙最强的硬信号）。两个来源都建立在**源头已收紧的严格判定**上：
 *   1) forms[].fields[] 里有 tag=input && type=password（抽取层按属性边界取 type）；
 *   2) material.hasPassword（抽取层用严格正则扫原文，能挡住 data-type="password" 与 type="passwordx"）。
 * ★ 这里**不再**有"素材带原文则重新复核"的分支：真实生产者（fetchPageMaterial / harvestSite）
 *   从不返回 rawHtml/html/raw，那条分支生产不可达（死代码）；而且它的"原文没命中即否决"会短路
 *   上面两个真实信号，把真登录墙判成 none（潜伏漏报）。判定只认源头修好的信号。
 * @returns {{hit:boolean, source:'none'|'field'|'hasPassword'}}
 */
function passwordEvidence(material) {
  if (!material || typeof material !== 'object') return { hit: false, source: 'none' }
  if (hasPasswordField(material)) return { hit: true, source: 'field' }
  if (material.hasPassword === true) return { hit: true, source: 'hasPassword' }
  return { hit: false, source: 'none' }
}

function passwordReason(ev) {
  return ev.source === 'field'
    ? '表单里有密码字段（登录墙强信号）'
    : '页面上有密码输入框（登录墙强信号）'
}

/** 表单 action 解析：必须是同源的 http(s) 地址，否则返回 null（跨站 action 绝不给登录窗口导航） */
function sameOriginAction(f, pageUrl, base) {
  if (!f || !f.action) return null
  try {
    const u = new URL(String(f.action), pageUrl)
    if (!base || u.origin !== base.origin) return null
    if (!/^https?:$/.test(u.protocol)) return null
    return u
  } catch { return null }
}

/**
 * 挑一个"最像登录页"的地址给登录窗口导航。
 * ★ 为什么不能"取第一个带 action 的同源表单"：真实站点首页常把**搜索框排在登录入口之前**
 *   （甚至就在同一个登录页上），取第一个会把登录窗口导航到搜索结果页——用户在那儿根本找不到
 *   登录框，只会以为功能坏了；同时 spec.auth.loginUrl 也会记下一个假登录地址。
 *   所以按证据强弱打分，只取分最高者：
 *     3 = 表单里有密码字段（几乎确定是登录表单）
 *     2 = 表单 action 路径本身像登录页（/login、/signin、/sso…）
 *     1 = 本页就是登录页（此时同源 action 视为登录提交地址）
 *     0 = 与登录无关（搜索/筛选/订阅表单）→ 跳过；一个都不够分就退回本页地址或 null。
 */
function pickLoginUrl(material, pageUrl) {
  const base = parse(pageUrl)
  const forms = Array.isArray(material?.forms) ? material.forms : []
  const pageIsLogin = !!(base && LOGIN_PATH_RE.test(base.pathname))
  let best = null
  let bestScore = 0
  for (const f of forms) {
    const action = sameOriginAction(f, pageUrl, base)
    if (!action) continue
    const fields = Array.isArray(f?.fields) ? f.fields : []
    const hasPw = fields.some((x) => String(x?.type || '').toLowerCase() === 'password')
    const score = hasPw ? 3 : (LOGIN_PATH_RE.test(action.pathname) ? 2 : (pageIsLogin ? 1 : 0))
    if (score > bestScore) { bestScore = score; best = action.toString() }
  }
  if (best) return best
  if (base && pageIsLogin) return base.toString()
  return null
}

/**
 * 判断"这个页面是不是登录墙"，并给出置信度分级（只有 high 允许自动弹窗）。
 * @param {{material?:object, page?:object, url?:string}} p
 *   material 来自 app-http-probe（静态 HTML 解析），page 来自浏览器快照的 page 字段
 * @returns {{needed:boolean, confidence:'high'|'medium'|'low'|'none', reasons:string[], loginUrl:string|null}}
 */
function detectLoginWall(p) {
  // ★ 不能写 `= {}` 默认值：那对 undefined 生效、对 null 仍会 TypeError，而本模块自述"任何异常输入都不抛"。
  const { material, page, url } = p || {}
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

module.exports = { detectLoginWall, HIGH_ONLY, LOGIN_PATH_RE, LOGIN_TEXT_RE }
