// 应用智控：纯工具函数（占位符插值与必填校验）
//
// 独立成文件是刻意的：`app-runner.cjs`（执行器）与 `app-runner-desktop.cjs`（desktop 三级
// 执行）都要用这两个函数，若放在 app-runner.cjs 再由 desktop 侧 require，就形成
// app-runner ⇄ app-runner-desktop 循环依赖（CJS 下表现为函数为 undefined，且报错极隐晦）。
'use strict'

/**
 * 替换参数占位符（未提供则替换为空串，与 plan 约定一致）。
 *
 * 为什么要额外认 `{{name}}`：提示词规定的是 `${name}`，但真机验收时模型（deepseek-v4-flash）
 * 写出了 `{{orderNo}}`——只认一种写法就会让**参数化命令静默失效**（参数不生效且试跑阶段因
 * "需参数被跳过"而查不出来）。宽容解析两种写法，比指望模型每次都写对更可靠。
 */
function interpolate(input, args = {}) {
  if (typeof input !== 'string') return input
  return input
    .replace(/\$\{(\w+)\}/g, (_m, k) => (args[k] == null ? '' : String(args[k])))
    .replace(/\{\{(\w+)\}\}/g, (_m, k) => (args[k] == null ? '' : String(args[k])))
}

/** 快照文本上限：工具结果要进模型的上下文，整棵交互树全塞进去会白烧 token */
const SNAPSHOT_TEXT_CAP = 4000

/**
 * 把浏览器执行器返回的快照转成**模型可读的文本**（app-runner 的 save 语义唯一实现）。
 *
 * 真实快照（electron/browser-common.cjs 的 buildSnapshot）形状是
 *   { page:{url,title,readyState,...}, alerts, changes, interactives, info, downloads, viewport, scrollY, truncated }
 * **没有顶层 text/url/title**。真机验收发现 app-runner 原先读 `res.snapshot.text`，
 * 于是 save 拿到的是整个快照对象（1KB+ JSON）而不是可读文本——而测试里的假执行器都带了
 * `text` 字段，把这个问题完整地掩盖了过去。
 */
function snapshotToText(snap, { cap = SNAPSHOT_TEXT_CAP } = {}) {
  if (snap == null) return ''
  if (typeof snap === 'string') return snap.slice(0, cap)
  if (typeof snap !== 'object') return String(snap)
  // 兼容仍带 text 的执行器（既有假执行器/未来实现）：有就直接用，语义不变
  if (typeof snap.text === 'string' && snap.text) return snap.text.slice(0, cap)

  const lines = []
  const page = snap.page || {}
  if (page.title || page.url) lines.push(`页面：${page.title || ''}${page.url ? `（${page.url}）` : ''}`)
  if (page.captcha) lines.push('注意：页面出现验证码')
  if (page.logged_in === false) lines.push('注意：登录可能已过期')
  for (const a of snap.alerts || []) lines.push(`提示：${a}`)
  const inter = Array.isArray(snap.interactives) ? snap.interactives : []
  if (inter.length) {
    lines.push(`可交互元素（共 ${inter.length} 个）：`)
    for (const e of inter.slice(0, 120)) {
      lines.push(`  #${e.ref} [${e.tag}] ${e.label}${e.value ? ` = ${e.value}` : ''}${e.path_hint ? ` @${e.path_hint}` : ''}`)
    }
  }
  const info = Array.isArray(snap.info) ? snap.info : []
  if (info.length) {
    lines.push(`页面内容（共 ${info.length} 条）：`)
    for (const i of info.slice(0, 80)) lines.push(`  ${i.label}${i.value ? `：${i.value}` : ''}`)
  }
  for (const d of snap.downloads || []) lines.push(`下载：${d.filename}（${d.status || ''}）`)
  const text = lines.join('\n')
  return text.length > cap ? `${text.slice(0, cap)}\n…（已截断）` : text
}

/** 校验必填参数；缺参一律**不执行任何动作**并返回错误清单 */
function checkRequired(params = [], args = {}) {
  const errors = []
  for (const p of params || []) {
    if (p?.required && (args?.[p.name] == null || args[p.name] === '')) {
      errors.push(`缺少必填参数：${p.name}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

module.exports = { interpolate, checkRequired, snapshotToText, SNAPSHOT_TEXT_CAP }
