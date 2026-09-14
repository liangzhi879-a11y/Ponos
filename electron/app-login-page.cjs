// 应用智控：登录相关的**页面级纯函数**（零 Electron 依赖，可被 node --test 直接加载）。
//
// ★ 为什么独立成文件：`LOGIN_PATH_RE`（"这个地址像不像登录页"）是**唯一真源**——
//   `app-login-wall.cjs`（登录墙分级）与 `app-login.cjs`（登录编排的成功判定）都应 require 它，
//   避免两处各写一份正则、日后只改一处导致判定漂移。
'use strict'

/**
 * "这个 path 像登录页吗"——唯一真源，勿在别处复制。
 * 覆盖 /login、/signin、/sign-in、/sign_in、/auth/login、/user/login、/account/login、/passport、/sso，
 * 以及带任意前缀的形态（/zh/login、/app/signin）与带尾斜杠的形态（/login/）。
 */
const LOGIN_PATH_RE = /(^|\/)(login|signin|sign-in|sign_in|auth\/login|user\/login|account\/login|passport|sso)(\/|$)/i

/** 快照里是否还有密码框 —— "人还停在登录页"的特征：label 提到密码 + tag 是输入类控件 */
function snapshotHasPassword(page) {
  const list = Array.isArray(page?.interactives) ? page.interactives : []
  return list.some((e) => /password|密码/i.test(String(e?.label || '')) && /textbox|input/i.test(String(e?.tag || '')))
}

/**
 * 判断快照是否表明"已登录"（登录编排的三路成功信号之一，另一路是"cookie 指纹变化"）。
 *   a) `page.logged_in === true` —— 引擎给的强信号，直接为真（哪怕是"修改密码"页也认，因为它确实是登录态）；
 *   b) 页面上**还有密码框** —— 认为仍停在登录页，为假；
 *   c) 当前地址**不在**登录页 + 传进来的起始 url **本身是登录页** —— 为真（登录成功后跳走的典型形态）。
 *
 * ★ 刻意偏保守：拿不准一律返回 false。理由：在登录页上误判"成功"会让调用方带着未登录态继续抓页面，
 *   最终给用户一条残缺的命令，比多等一会儿糟得多；而"起始页不是登录页"时，
 *   "当前页没有密码框"根本不构成成功证据（页面可能还没渲染完）。
 *
 * @param {object|null} snapshot 浏览器快照（取其 page 字段）
 * @param {string} url 本次操作的起始地址（用于判断"原本是不是在登录页"）
 * @returns {boolean}
 */
function loginSucceeded(snapshot, url) {
  const page = snapshot?.page
  if (!page) return false
  if (page.logged_in === true) return true
  if (snapshotHasPassword(page)) return false
  const current = String(page.url || '')
  if (!current) return false
  let onLoginPage = false
  try { onLoginPage = LOGIN_PATH_RE.test(new URL(current).pathname) } catch { onLoginPage = false }
  if (onLoginPage) return false
  let startWasLoginPage = false
  try { startWasLoginPage = LOGIN_PATH_RE.test(new URL(String(url || '')).pathname) } catch { startWasLoginPage = false }
  return startWasLoginPage
}

module.exports = { LOGIN_PATH_RE, snapshotHasPassword, loginSucceeded }
