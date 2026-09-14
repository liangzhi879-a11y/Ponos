// 应用智控：浏览器自动化分区键（partition key）的**唯一真源**。
//
// ★ 为什么需要它（用户诉求 + 真实缺口）：
//   「很多应用或网站需要登录才能暴露所有端口……要确保用户手动登陆后，LLM 可以获取到登录状态。」
//   原实现的分区键是 **chat sessionId**（`persist:automation-<sessionId>`，browser-executor.cjs:588），
//   于是：① 换个会话/新开会话就得重新登录；② 「新增应用」阶段还没有正式 appId，
//   与保存后的执行路径可能落到不同分区 → 用户刚登录过却又要登录。
//
// 取值规则（两条理由写在 spec §3.1，勿随手改）：
//   · web 目标 → `app-site-<host>`（去 www）：cookie 本来就按域名存，同站点共享登录态 = 真实浏览器语义；
//     且从"填网址那一刻"起就稳定，不受"ID 还没填/保存后 ID 才确定"影响。
//   · desktop 目标 → `app-<appId>`：无 cookie 语义，键只影响下载目录与事件标签。
//   · 兜底 `app-probe`：与既有 PROBE_SESSION 同名，保持兼容。
'use strict'

/** 主机名（小写）；非法输入返回 null（绝不抛——调用点常在错误路径上） */
function hostOf(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase()
    return h || null
  } catch {
    return null
  }
}

/** 清洗成可安全进分区名/文件路径的片段（分区名会出现在 userData 目录名里） */
function sanitizeId(s) {
  const cleaned = String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned || 'unknown'
}

/** 分区键：web 按站点、desktop 按 appId，取不到就 app-probe */
function appSessionKey({ appId, target } = {}) {
  const t = target || {}
  if (t.type === 'web') {
    const host = hostOf(t.url)
    if (host) return `app-site-${host.replace(/^www\./, '')}`
    return appId ? `app-${sanitizeId(appId)}` : 'app-probe'
  }
  return appId ? `app-${sanitizeId(appId)}` : 'app-probe'
}

/** 分区字符串唯一出处（browser-executor 与 app-login 都必须用它） */
function partitionFor(key) {
  return 'persist:automation-' + String(key || 'app-probe')
}

module.exports = { appSessionKey, partitionFor, hostOf, sanitizeId }
