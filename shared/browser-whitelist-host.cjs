'use strict'
// browser-whitelist-host.cjs — 浏览器白名单「主机名」归一化的**单一来源**。
//
// 为什么单独抽出来（2026-09-17 真实事故）：
// 白名单的**写入端**在 server/bridge.mjs（ESM，addBrowserWhitelist），**读取端**在
// electron/browser-common.cjs（CJS，isWhitelisted）。两边各写一套校验就会分叉，而这条链
// 路上"分叉"的后果特别恶劣——内核按宽松口径判断"这个值可以加白名单"于是弹审批、用户点同意、
// 写入端却按更严的口径静默拒掉：**用户白点一次，模型还收到"已批准请重试"的假回执而反复重试**。
// 真实表现：agent 用浏览器打开 `file:///C:/...`（hostname 为空串）→ 内核把空值顶替成中文
// 占位符「该域名」→ 审批弹窗显示"加入浏览器白名单：该域名" → 用户同意 → 写入端正则
// /^[a-z0-9.-]+$/ 对中文不匹配 → 静默 return false → 内核仍回"已批准" ⇒ 无限循环。
// 本模块把"什么算合法主机名"收成一个函数，两侧共用，从根上消除分叉。
//
// 形态沿用 server/yfw-home.cjs 的先例：**CJS 单文件**，ESM（bridge/kernel）与 CJS
// （electron）双侧都能引——ESM 侧 `import { normalizeWhitelistHost } from '...cjs'`
// 由 cjs-module-lexer 识别字面量导出，与 yfw-home.cjs 的用法一致。
//
// 口径（入参是 **hostname**，不是整条 URL）：
//   · 普通域名：a-z 0-9 `-` `_`，点分段；不接受首尾点、连续点、空段（防 `..` 与 `.` 混入）
//   · IPv6 字面量：`[::1]` 这类带方括号形式（`new URL('http://[::1]:80/').hostname` 即此形）
//   · 其余一律 null：空/纯空白、含端口或路径分隔符、含中文（如「该域名」这类占位文字）、
//     含协议头、含空格或其它符号
// 长度上限 253（DNS 主机名上限），防异常长串进配置文件。
//
// 注意：**不做"是否本机/是否可信"的判断**——那是 isWhitelisted 的默认表与白名单文件的职责；
// 本函数只回答"这个字符串是不是一个可以写进白名单的主机名"。

const MAX_HOST_LEN = 253

function normalizeWhitelistHost(raw) {
  if (typeof raw !== 'string') return null
  const h = raw.trim().toLowerCase()
  if (!h || h.length > MAX_HOST_LEN) return null
  // IPv6 字面量：[::1]、[2001:db8::1]
  if (/^\[[0-9a-f:.]+\]$/.test(h)) return h
  // 普通域名：点分段、每段非空、段内只允许字母数字连字符下划线
  const labels = h.split('.')
  if (labels.some((s) => !s || !/^[a-z0-9_-]+$/.test(s))) return null
  return h
}

module.exports = { normalizeWhitelistHost, MAX_HOST_LEN }
