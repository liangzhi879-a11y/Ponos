// kernel/atlas/coverage.mjs —— 结构边覆盖的显式说明
// ---------------------------------------------------------------------------
// “0 条边”有两种含义：真的没有依赖，或这个语言的边抽取器还没实现。
// 对 agent 来说后者是**最贵的假阴性**（会据此判断“改这里没有影响”）。
// 因此在边覆盖不完整时，card/impact/related 必须把“不完整”说出口，
// 而不是让 0 条边冒充事实。
//
// JS/TS/Python 有 import 解析；C/C++ 自 include 分片落地起解析**引号形式**的
// `#include "…"`。若一个 C/C++ 文件的引号 include 全部解析失败，仍要提示“关系可能
// 不完整”—— supported=true 只表示我们试过，不表示结果完整。
// 其它语言若实际解析出了 import（stats.importsResolved > 0），按已覆盖处理。

const STRUCTURED_EDGE_LANGS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'py',
])
const CPP_LANGS = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx'])

/**
 * @param {any} node
 * @returns {{supported:boolean, partial?:boolean, reason:string|null, unresolved?:number, lang:string}}
 */
export function edgeCoverage(node) {
  const lang = String(node?.lang || '').toLowerCase()
  if (!node || (node.kind !== 'code' && node.kind !== 'test')) {
    return { supported: true, reason: null, lang }
  }
  if (CPP_LANGS.has(lang)) {
    const resolved = Number(node?.stats?.importsResolved) || 0
    const unresolved = Number(node?.stats?.importsUnresolved) || 0
    if (resolved === 0 && unresolved > 0) {
      return { supported: true, partial: true, reason: 'include-unresolved', unresolved, lang }
    }
    return { supported: true, partial: false, reason: null, lang }
  }
  if (STRUCTURED_EDGE_LANGS.has(lang)) return { supported: true, reason: null, lang }
  if (Number(node?.stats?.importsResolved) > 0) return { supported: true, reason: null, lang }
  return { supported: false, reason: 'import-extractor-unavailable', lang }
}

/** 给模型看的一句话说明；supported 时返回空串（调用方不用判空）。 */
export function coverageLabel(cov) {
  if (!cov || (cov.supported && !cov.partial)) return ''
  if (cov.reason === 'include-unresolved') {
    return `该文件的 ${cov.unresolved || '若干'} 个引号 #include 均未在索引内解析，关系可能不完整（请用 Grep 确认调用方）`
  }
  return `${cov.lang ? '.' + cov.lang + ' ' : ''}结构边未解析，关系可能不完整（请用 Grep 确认调用方）`
}
