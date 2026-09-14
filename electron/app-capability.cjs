// 应用智控：**能力清单**（Capability Surface）——Discovery 层的输出契约。
//
// ★ 为什么要有它：原来的探测产出是"一个级别"（process/script/uia，命中即停，全不中就拒绝生成）。
//   但封装真正需要的是"这个应用有哪些可控路径、每条有什么证据、下一步该怎么试"。
//   清单是把"探测结果"变成"模型可用的探索起点"的中间产物。
//
// ★ 关键概念区分（勿混）：
//   · channel（通道）= **发现阶段**的归类：cli / script / file / http / chunk / web-ui …
//   · driver（后端）= **执行阶段**由谁跑：process / script / file / http / browser / uia
//   两者多对一：例如 chunk 里挖到的接口，既可以 http 直调，也可以 browser+js 调（自带登录态）。
'use strict'

const CHANNELS = {
  cli:            { driver: 'process', label: '命令行接口' },
  'cli-external': { driver: 'process', label: '第三方/开源 CLI' },
  script:         { driver: 'script',  label: '脚本/扩展接口' },
  file:           { driver: 'file',    label: '本地数据/配置文件' },
  http:           { driver: 'http',    label: 'HTTP 接口' },
  chunk:          { driver: 'browser', label: '前端 chunk / 页面内接口' },
  'web-ui':       { driver: 'browser', label: '网页可交互控件' },
  unusable:       { driver: null,      label: '未发现可控路径' },
}

const CONFIDENCE_ORDER = { unusable: 0, probable: 1, verified: 2 }

/**
 * 构造一条能力。
 * ★ driver 由通道定义给出，**不接受调用方指定**：否则同一条路径可能在不同调用点被标成不同后端，
 *   下游（封装/执行）就会各写各的。
 * @param {keyof typeof CHANNELS} channel
 */
function capability(channel, { evidence = '', confidence = 'probable', next = '', probe = null } = {}) {
  const def = CHANNELS[channel]
  if (!def) throw new Error(`未知通道：${channel}`)
  if (!(confidence in CONFIDENCE_ORDER)) throw new Error(`未知可信度：${confidence}`)
  return { channel, driver: def.driver, label: def.label, confidence, evidence, next, probe }
}

/**
 * 三态结论。
 * ★ 只要有一条 verified 就是可接入 —— 不要因为同时存在 unusable 通道而降级：
 *   一个应用常有"这条走不通、那条走得通"的情况，降级会让本来能接的应用被判死。
 */
function verdictOf(capabilities = []) {
  const caps = Array.isArray(capabilities) ? capabilities : []
  if (caps.some((c) => c.confidence === 'verified')) return 'connectable'
  if (caps.some((c) => c.confidence === 'probable')) return 'weak'
  return 'unusable'
}

/** 组装清单（verified 优先，同级保持传入顺序） */
function buildCapabilitySurface({ target = {}, capabilities = [] } = {}) {
  const sorted = [...capabilities].sort(
    (a, b) => (CONFIDENCE_ORDER[b.confidence] ?? 0) - (CONFIDENCE_ORDER[a.confidence] ?? 0),
  )
  return {
    target,
    capabilities: sorted,
    verdict: verdictOf(sorted),
    hasVerified: sorted.some((c) => c.confidence === 'verified'),
    hasProbable: sorted.some((c) => c.confidence === 'probable'),
  }
}

const CONFIDENCE_TEXT = { verified: '已实测', probable: '待验证', unusable: '不可用' }

/** 给模型看的清单（探索起点） */
function renderSurfaceForPrompt(surface) {
  const caps = surface?.capabilities || []
  const usable = caps.filter((c) => c.channel !== 'unusable')
  if (!usable.length) return ''
  const lines = ['【已探明可控路径】（按可信度排序，优先从"已实测"的通道开始封装）']
  for (const c of usable) {
    lines.push(`· [${CONFIDENCE_TEXT[c.confidence]}] ${c.label}（channel=${c.channel} → driver=${c.driver}）`)
    if (c.evidence) lines.push(`  证据：${c.evidence}`)
    if (c.next) lines.push(`  下一步：${c.next}`)
  }
  return lines.join('\n')
}

/** 给人看的报告（面板展示 / 无法接入时的说明） */
function renderSurfaceReport(surface) {
  const caps = surface?.capabilities || []
  const verified = caps.filter((c) => c.confidence === 'verified')
  const probable = caps.filter((c) => c.confidence === 'probable')
  const dead = caps.filter((c) => c.confidence === 'unusable')
  const lines = []
  if (verified.length) {
    lines.push(`已实测可用的接入路径 ${verified.length} 条：`)
    for (const c of verified) lines.push(`· ${c.label}：${c.evidence || '—'}`)
  }
  if (probable.length) {
    lines.push(`待进一步确认 ${probable.length} 条（证据不足，尚不能断言可行）：`)
    for (const c of probable) lines.push(`· ${c.label}：${c.evidence || '—'}`)
  }
  if (dead.length) {
    lines.push('已排查且不成立的通道：')
    for (const c of dead) lines.push(`· ${c.label}：${c.evidence || '—'}`)
  }
  if (surface?.verdict === 'unusable') {
    lines.push('结论：**无法接入**（未发现任何可控路径）。建议：找该应用的官方 CLI / API 文档，或改用 web 方式接入。')
  } else if (surface?.verdict === 'weak') {
    lines.push('结论：证据不足，尚不能确认可接入（可补充程序路径、或提供官方文档链接后重试）。')
  }
  return lines.join('\n')
}

module.exports = {
  CHANNELS, CONFIDENCE_ORDER, CONFIDENCE_TEXT,
  capability, verdictOf, buildCapabilitySurface, renderSurfaceForPrompt, renderSurfaceReport,
}
