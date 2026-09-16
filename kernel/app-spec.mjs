// 应用智控：Spec 读取 / 校验 / 可见性判定 / 绑定读取
// 纯函数 + 零依赖：内核（kernel/cli.mjs）是独立进程，此处不得依赖 Electron。
//
// 本模块是「应用智控」在内核侧的**唯一读入口**：
//   - registry.json  → 应用清单
//   - <appId>/spec.json → 单应用命令表（App Spec）
//   - binding.json   → 当前会话绑定的应用（严格单开，值为字符串而非数组）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** expose 三态：private 永不接给 agent / console 仅进入控制台的会话可见 / public 全局 */
export const EXPOSE_MODES = ['private', 'console', 'public']

/**
 * 单应用命令数上限（防止工具池被单个应用撑爆，与 dyntools 的 LIMIT_DEFAULT 同思路）。
 * 注意：这是**安全上限**，不是"应该写多少条"的目标；命令质量由 app-agent.checkSpecQuality 把关。
 * 20 → 40：接口级封装（js+fetch）落地后，一个站点可暴露的有效命令明显变多，20 会成为硬顶。
 */
export const MAX_COMMANDS_PER_APP = 40

/** 缺省可见性：console（不进公共注册表，进入卡片才绑定） */
const DEFAULT_EXPOSE_MODE = 'console'

/** 宽容读 JSON：文件缺失/损坏一律返回 null，不抛（内核请求期间不应因坏文件崩） */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
}

const rootList = (roots) => (Array.isArray(roots) ? roots : (roots ? [roots] : []))

/**
 * 读所有 root 下的 registry.json，合并应用清单。
 * 兼容两种形状：[...] 或 { version, apps: [...] }
 * 同一 id 出现在多个 root 时**按首个 root 去重**，与 loadSpec 的"首个命中优先"口径保持一致
 * （否则会出现"列出两份、执行 root[0]、可见性按注册表 id 判定"的错配）。
 * @returns {Array<{id:string,name?:string,targetType?:string,enabled?:boolean}>}
 */
export function listApps({ roots = [] } = {}) {
  const out = []
  const seen = new Set()
  for (const root of rootList(roots)) {
    if (!root) continue
    const reg = readJson(join(root, 'registry.json'))
    const items = Array.isArray(reg) ? reg : (Array.isArray(reg?.apps) ? reg.apps : [])
    for (const a of items) {
      if (!a || !a.id || seen.has(a.id)) continue
      seen.add(a.id)
      out.push(a)
    }
  }
  return out
}

/**
 * 读单应用 spec.json（按 root 顺序，首个命中优先）。
 * **一致性防御**：若 spec 自带 appId 且与目录 appId 不符，视为数据损坏 → 返回 null。
 * （正常写入路径由 electron/app-registry.cjs 的 writeSpec 强制对齐 appId，不会产生不一致；
 *   此处仅防手改 JSON 造成的静默错配——否则会表现成"绑定了却一个工具都没有"。）
 * @returns {object|null}
 */
export function loadSpec({ roots = [], appId } = {}) {
  if (!appId) return null
  for (const root of rootList(roots)) {
    if (!root) continue
    const p = join(root, appId, 'spec.json')
    if (!existsSync(p)) continue
    const spec = readJson(p)
    if (!spec) return null
    if (spec.appId && spec.appId !== appId) return null
    return spec
  }
  return null
}

/**
 * 读当前会话绑定的应用 id。
 * 严格单开：binding.json 形如 { "<sessionId>": { appId, boundAt } }，值为字符串。
 * @returns {string|null}
 */
export function getBoundApp({ roots = [], sessionId = null } = {}) {
  if (!sessionId) return null
  for (const root of rootList(roots)) {
    if (!root) continue
    const binding = readJson(join(root, 'binding.json'))
    const appId = binding?.[sessionId]?.appId
    if (appId) return appId
  }
  return null
}

/**
 * 可见性三态判定（与 kernel/dyntools.mjs 的 visibilityOf 同构）。
 *   private → 永不可见（仅允许在控制台手工执行）
 *   console → 仅当本会话绑定的就是本应用（默认）
 *   public  → 始终可见（需用户显式开启；validateSpec 默认拒绝，见下）
 * 未知 mode 一律不可见（fail-safe：宁可少给，不可错给）。
 *
 * **绑定/作用域优先于 public**：`scopeAppId`（应用页模式，--app-page）存在时，本会话的工具池
 * 只含该应用——public 也不例外。否则"应用页"里会混进一堆与当前应用无关的公共工具，
 * 模型照样能绕开这个页面去调别的系统（用户开应用页的意图就是"只看这一个"）。
 * 判定顺序刻意是「private → scope → console/public」：
 *   · private 放在 scope 之前 = **不因作用域放宽**（fail-safe：作用域不是提权入口）；
 *   · scope 放在 console/public 之前 = 作用域是**过滤器**，不是"又一个绑定来源"。
 * `scopeAppId == null` 时行为与引入本维度之前**逐字一致**（缺省零回归）。
 *
 * 注意：`agentId` 为**预留参数**——当前版本可见性只按「会话绑定」判定，
 * agent 维度不参与（即 console 态下 = 该会话内所有 agent 均可调用）。
 * 若将来需要"同一会话内只给某 agent"，在此处收窄即可。
 *
 * @param {object} spec
 * @param {{agentId?:string|null, boundApp?:string|null, scopeAppId?:string|null}} ctx
 * @returns {boolean}
 */
export function isAppVisible(spec, { agentId = null, boundApp = null, scopeAppId = null } = {}) {
  if (!spec) return false
  const mode = spec.expose?.mode || DEFAULT_EXPOSE_MODE
  if (!EXPOSE_MODES.includes(mode)) return false
  if (mode === 'private') return false
  // 作用域优先于 console/public（含 public 不得旁路，见上）
  if (scopeAppId != null) return spec.appId === scopeAppId
  if (mode === 'console') return !!boundApp && boundApp === spec.appId
  return true // public
}

/**
 * 解析本会话"当前应该接哪个应用"——**作用域（应用页）优先于绑定（控制台）**。
 *
 * 存在的唯一理由：让「工具注入」（app-tools）与「权限规则注入」（app-permissions）共用
 * 同一口径。若两处各写一遍 `scopeAppId ? … : getBoundApp(…)`，一旦口径分叉就会出现
 * 「工具池给 A、规则按 B 注入」——症状是 read 被拒/ write 不弹窗，而两边代码各自看都对。
 *
 * 语义：
 *   · scopeAppId 非空 → 该 id 即作用域，读它的 spec（**不看 binding.json**）；
 *   · scopeAppId 为空/null → 现有行为：读 binding.json 的绑定（恒为 console 态的单开绑定）。
 *   · spec 取不到（应用不存在/无 spec.json）→ 返回 `{ appId, spec: null }`：
 *     调用方（cli.mjs）据此 warn，否则表现为"模型说没有这个工具"而毫无线索。
 *
 * @param {{roots?:string[], sessionId?:string|null, scopeAppId?:string|null}} p
 * @returns {{appId:string|null, spec:object|null}}
 */
export function resolveScopedApp({ roots = [], sessionId = null, scopeAppId = null } = {}) {
  const appId = scopeAppId != null && scopeAppId !== '' ? scopeAppId : getBoundApp({ roots, sessionId })
  if (!appId) return { appId: null, spec: null }
  return { appId, spec: loadSpec({ roots, appId }) }
}

/**
 * Spec 结构校验（纯机械判定，不含 LLM 判断）。
 *
 * @param {object} spec
 * @param {{allowPublic?:boolean, expectAppId?:string}} [opts]
 *   allowPublic  默认 false —— `expose.mode='public'` 会被判为错误。
 *                这是红线一「默认不进公共注册表」的机制性保障：
 *                Spec 由 LLM 按用户给的网址/路径生成，若放任其写出 public，
 *                该应用的工具会在**所有会话**可见、无需进入控制台，直接绕过绑定机制。
 *                只有 GUI 中用户显式勾选"全局可用"时才传 true。
 *   expectAppId  若提供，则要求 spec.appId 与之相等（防止目录 id 与 Spec id 错配）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSpec(spec, { allowPublic = false, expectAppId } = {}) {
  const errors = []
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['spec 必须是对象'] }
  }
  if (spec.specVersion !== 1) errors.push('specVersion 必须为 1')
  if (!spec.appId) errors.push('缺少 appId')
  if (expectAppId && spec.appId !== expectAppId) {
    errors.push(`spec.appId（${spec.appId}）与期望的 ${expectAppId} 不一致`)
  }
  if (!spec.name) errors.push('缺少 name')
  if (!['web', 'desktop'].includes(spec.target?.type)) errors.push('target.type 必须为 web 或 desktop')

  const mode = spec.expose?.mode
  if (mode != null && !EXPOSE_MODES.includes(mode)) {
    errors.push(`expose.mode 必须为 ${EXPOSE_MODES.join(' / ')}`)
  }
  if (mode === 'public' && !allowPublic) {
    errors.push('expose.mode=public 需用户显式开启（默认不允许，避免绕过控制台绑定机制）')
  }

  if (!Array.isArray(spec.commands)) {
    errors.push('commands 必须是数组')
    return { ok: errors.length === 0, errors }
  }

  if (spec.commands.length > MAX_COMMANDS_PER_APP) {
    errors.push(`commands 数量超过上限 ${MAX_COMMANDS_PER_APP}`)
  }

  const seen = new Set()
  for (const c of spec.commands) {
    if (!c || typeof c !== 'object') { errors.push('命令必须是对象'); continue }
    if (!c.action) errors.push('命令缺少 action')
    else if (seen.has(c.action)) errors.push(`action 重复：${c.action}`)
    else seen.add(c.action)

    if (!['read', 'write'].includes(c.kind)) {
      errors.push(`命令 ${c.action || '?'} 的 kind 必须为 read 或 write`)
    }
    // params 必须是数组：与工作流 inputs 同构，才能直接喂 deriveInputSchema()
    if (c.params != null && !Array.isArray(c.params)) {
      errors.push(`命令 ${c.action || '?'} 的 params 必须是数组`)
    }
    if (!Array.isArray(c.steps) || c.steps.length === 0) {
      errors.push(`命令 ${c.action || '?'} 缺少 steps`)
    }
  }

  return { ok: errors.length === 0, errors }
}
