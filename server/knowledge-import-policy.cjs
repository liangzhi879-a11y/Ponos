// 知识库文件导入的可配置上限（2026-09-14）。
//
// 为什么需要这个模块：内核 `IMPORT_LIMITS` 的 500 文件 / 300MB 是**整批拒绝**式护栏
// （超一个就全不导），企业知识库动辄上千文件时直接不可用；但也不能简单删掉——
// 它是内存占用与超时的唯一保护。故做成"默认保守 + 可显式放宽"，
// 并把放宽的责任交给调用方（设置项 / GUI），而不是让内核自己猜。
//
// 与 `log-policy.cjs` 完全同构（同一套范式，避免两处各写一套）：
//   · DEFAULT_* / *_LIMITS 冻结常量
//   · normalize* 任意输入 → 合法值（非法一律回落默认，永不抛）
//   · config.json 持久化，桥与主进程是两个进程 → 带 TTL 的缓存让改动免重启生效
// GUI 侧镜像在 `src/lib/knowledgeImportUi.ts`，由 parity 测试钉住两侧数字一致
// —— 两侧各写一套数字是这类"设置项"最典型的漂移点（GUI 允许 5000、服务端却钳到 500，
// 用户看到"设置没生效"而排查不到）。
const fs = require('fs')
const path = require('path')
const { resolveYfwHome } = require('./yfw-home.cjs')

const MB = 1024 * 1024

/** 默认上限：与内核 `IMPORT_LIMITS` 的历史默认**保持一致**（改默认值要同时改内核那一份）。 */
const DEFAULT_IMPORT_POLICY = Object.freeze({
  maxFiles: 500,
  maxTotalBytes: 300 * MB,
})

// 钳制区间（GUI 与本模块共用同一组数字）。
// 上限不是随便定的：单次导入要把全部文件的转换结果放进内存与 stdout 缓冲，
// 20000 文件 / 20GB 已远超"一次导入"的合理边界（再多应分批），
// 故到这一档就拒绝——继续放宽不如改成分批。
const IMPORT_POLICY_LIMITS = Object.freeze({
  minFiles: 1, maxFiles: 20000,
  minTotalBytes: 1 * MB, maxTotalBytes: 20 * 1024 * MB,
})

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** 任意输入 → 合法策略（非法/缺失/损坏一律回落默认档，**永不抛**）。 */
function normalizeImportPolicy(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return {
    maxFiles: clampInt(r.maxFiles, IMPORT_POLICY_LIMITS.minFiles, IMPORT_POLICY_LIMITS.maxFiles, DEFAULT_IMPORT_POLICY.maxFiles),
    maxTotalBytes: clampInt(r.maxTotalBytes, IMPORT_POLICY_LIMITS.minTotalBytes, IMPORT_POLICY_LIMITS.maxTotalBytes, DEFAULT_IMPORT_POLICY.maxTotalBytes),
  }
}

function configPath(home) {
  return path.join(home || resolveYfwHome(), 'config.json')
}

/** 读 config.json 的 `knowledgeImport`（缺失/损坏 → 默认；永不抛，也绝不创建文件）。 */
function readImportPolicy({ home = resolveYfwHome() } = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf-8'))
    return normalizeImportPolicy(cfg && cfg.knowledgeImport)
  } catch (_) {
    return normalizeImportPolicy(null)
  }
}

// 带 TTL 的缓存：桥进程持有内核子进程，改设置后无法互相通知；靠 TTL（默认 5s）
// 让新值在不重启的前提下生效，同时避免每次导入都读一遍 config.json。
const _cache = new Map() // home -> { at, policy }
function readImportPolicyCached({ home = resolveYfwHome(), ttlMs = 5000 } = {}) {
  const now = Date.now()
  const hit = _cache.get(home)
  if (hit && now - hit.at < ttlMs) return hit.policy
  const policy = readImportPolicy({ home })
  _cache.set(home, { at: now, policy })
  return policy
}
function _resetImportPolicyCache() { _cache.clear() }

module.exports = {
  DEFAULT_IMPORT_POLICY,
  IMPORT_POLICY_LIMITS,
  normalizeImportPolicy,
  readImportPolicy,
  readImportPolicyCached,
  _resetImportPolicyCache,
}
