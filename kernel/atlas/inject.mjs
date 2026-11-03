// kernel/atlas/inject.mjs —— Atlas 注入面（settings 解析 + 主会话/子代理区块）
// ---------------------------------------------------------------------------
// 口径（spec §5.7）：
//   · 主会话默认 ≤4096 B、子代理 lane 默认 ≤2048 B；L0 必进（renderL1 的首两行就是
//     L0 的同一口径），L1 按域重要度填充；L2 单卡与正文**永不**注入。
//   · 不是模型自觉：区块由引擎在 composeSystemPrompt / spawnSubAgent 时拼入。
//   · 仪表：注入字节记 derived 渠道 + systemPrompt 来源；构建/查询计数在
//     inject-ledger 的 atlas 键（getInjectStats().atlas）。
import { readAtlasSnapshot } from './store.mjs'
import { resolveAtlasDir } from './config.mjs'
import { truncateBytes } from './render.mjs'
import { recordAtlas } from '../inject-ledger.mjs'
import { recordChannel, recordSource } from '../knowledge-inject.mjs'

export const ATLAS_INJECT_MAX_BYTES = 4096
export const ATLAS_LANE_INJECT_MAX_BYTES = 2048
const MIN_BUDGET = 256
const HINT = '需要文件职责/关系/影响面时用 ProjectAtlas(op=find|card|impact)；找正文/符号用 ProjectAtlas(op=search)（可加 path/domain 缩小）或 Grep。本块只给目录，不替代读源码；它是缓存快照，需要最新结构或大目录按范围重建时用 ProjectAtlas(op=build, path=...)。'
const HEAD = '【项目地图】（引擎注入的工作区静态索引）'

/**
 * settings 解析：env > settings.atlas > 默认。
 * 与 memory.injectMode 同款——`SETTINGS_DEFAULTS` 不登记 `atlas`，避免 diffFromDefault
 * 把"只设了 atlas 子键"的用户误报成配置漂移；默认值的唯一权威在本函数。
 *
 * 开关语义：缺省 = 启用；显式 false / 0 / "false" / "off" / "no" = 关闭。
 * `injectEnabled` 只管“系统提示里的地图块”，不影响 ProjectAtlas 工具是否可用：
 * 四臂消融需要 “tool-only”（有工具、无注入）这一臂，用 `atlas.inject=false` /
 * `PONOS_ATLAS_INJECT=0` 表达；`atlas.enabled=false` 仍然是工具与注入一起关。
 * 预算：只接受正有限数；0/负数/非数字回落默认（0 不能理解成"不注入"）。
 * @param {{settings?:any, env?:NodeJS.ProcessEnv}} [opts]
 * @returns {{enabled:boolean, injectEnabled:boolean, injectMaxBytes:number, laneInjectMaxBytes:number}}
 */
export function resolveAtlasSettings({ settings = null, env = process.env } = {}) {
  const a = settings && typeof settings === 'object' && settings.atlas && typeof settings.atlas === 'object'
    ? settings.atlas
    : {}
  const pick = (envKey, key) => (env && env[envKey] !== undefined ? env[envKey] : a[key])
  const isOff = (v) => v === false || v === 0 || /^(?:0|false|off|no)$/i.test(String(v ?? ''))
  const enabled = !isOff(pick('PONOS_ATLAS_ENABLED', 'enabled'))
  const injectEnabled = enabled && !isOff(pick('PONOS_ATLAS_INJECT', 'inject'))
  const budget = (envKey, key, fallback) => {
    const n = Number(pick(envKey, key))
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    enabled,
    injectEnabled,
    injectMaxBytes: budget('PONOS_ATLAS_INJECT_MAX_BYTES', 'injectMaxBytes', ATLAS_INJECT_MAX_BYTES),
    laneInjectMaxBytes: budget('PONOS_ATLAS_LANE_INJECT_MAX_BYTES', 'laneInjectMaxBytes', ATLAS_LANE_INJECT_MAX_BYTES),
  }
}

function hasContent(atlas) {
  // metaOnly 快路径没有 nodes；构建时统计的 content 数就是同一批内容的计数。
  if (atlas?.metaOnly) return Number(atlas?.meta?.counts?.content) > 0
  return (atlas?.nodes || []).some((n) => n.kind !== 'domain' && n.kind !== 'layer')
}

/**
 * 构建注入区块。返回 { enabled, text, bytes, atlas, error? }。
 *
 * ★ 注入路径**只读快照，绝不构建/扫描**（2026-10-21 假死事故）：
 * 这里在 composeSystemPrompt 的同步路径上执行；缓存缺失、版本代差、文件变化都
 * 不能触发 buildAtlas。没有可用快照就注入空串，重建交给显式 ProjectAtlas(op=build)。
 * 旧快照可以继续注入（地图是导航，滞后比卡住会话可接受），HINT 会说明它是缓存快照。
 *
 * 失败/空工作区一律返回空串（**不抛**）：Atlas 是增强面，不能让会话起不来；
 * 调用方拿到空串就什么都不拼。`enabled:false` 与"启用但无内容"用 text==='' 区分不了时，
 * 看 `enabled` 与 `atlas` 即可（工具面另有"未启用"回执）。
 *
 * @param {{root?:string, settings?:any, env?:NodeJS.ProcessEnv, configDir?:string|null, budget?:number, lane?:boolean}} [opts]
 * @returns {{enabled:boolean, injectEnabled:boolean, text:string, bytes:number, atlas:any, error?:string}}
 */
export function buildAtlasBlock({ root, settings = null, env = process.env, configDir = null, budget = null, lane = false } = {}) {
  const resolved = resolveAtlasSettings({ settings, env })
  if (!resolved.enabled || !root) return { enabled: false, injectEnabled: false, text: '', bytes: 0, atlas: null }
  // tool-only 臂：工具仍可用，只是不往系统提示里放地图块。
  if (!resolved.injectEnabled) return { enabled: true, injectEnabled: false, text: '', bytes: 0, atlas: null }
  const max = Math.max(MIN_BUDGET, Number(budget) || (lane ? resolved.laneInjectMaxBytes : resolved.injectMaxBytes))
  let loaded
  try {
    const dir = resolveAtlasDir(root, { env, configDir }).dir
    loaded = readAtlasSnapshot({ root, dir })
  } catch (err) {
    recordAtlas({ error: true })
    return { enabled: true, injectEnabled: true, text: '', bytes: 0, atlas: null, error: err?.message || String(err) }
  }
  if (!loaded.ok || !hasContent(loaded)) return { enabled: true, injectEnabled: true, text: '', bytes: 0, atlas: loaded }

  const reserved = Buffer.byteLength(HEAD, 'utf8') + 2 + Buffer.byteLength(HINT, 'utf8')
  const bodyBudget = Math.max(MIN_BUDGET, max - reserved)
  // 预计算的 L1 是未截断全文；按本次预算截断后与现场 renderL1 逐字一致。
  const body = truncateBytes(String(loaded.l1 ?? ''), bodyBudget, { lineSafe: true }).replace(/^# /, '')
  const text = truncateBytes(`${HEAD}\n${body}\n${HINT}`, max)
  const bytes = Buffer.byteLength(text, 'utf8')

  recordAtlas({ injectBytes: bytes })
  recordChannel('derived', { calls: 1, hits: 1, injectedBytes: bytes })
  recordSource('systemPrompt', bytes)
  return { enabled: true, injectEnabled: true, text, bytes, atlas: loaded }
}
