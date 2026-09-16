// 应用注册表：CRUD + 落盘 + Spec 读写（写前自动备份）
//
// 数据根：~/.yfworking/apps/
//   registry.json         应用清单 { version, apps: [...] }
//   <appId>/spec.json     单应用命令表（App Spec）
//   <appId>/spec.bak.<ts>.json   旧版备份（可回滚，绝不静默丢旧版）
//
// ★ appId 的唯一真源是**目录名**：writeSpec 会强制把 spec.appId 对齐为参数 appId，
//   因为内核侧 loadSpec 以目录名取 Spec、可见性判定又用注册表 id——
//   任何错配都会表现成"进控制台绑定了，却一个工具都没有"的静默失败。
'use strict'
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }
const rootOf = (roots) => (Array.isArray(roots) ? roots[0] : roots)
const registryPath = (roots) => join(rootOf(roots), 'registry.json')

/**
 * 应用序号（自动分配的 id）形态：`app-` + 序号。
 * ★ 只有这个前缀参与"最大序号"推算：`001` / `002` / `my-app` 这类非规范 id 只当**占用**，
 *   不许它们把序号带偏（否则已有 `999` 目录就会让新应用从 app-1000 开始）。
 */
const APP_ID_SEQ_RE = /^app-(\d+)$/
/**
 * 根目录 → 已"发放但尚未落盘"的 id。**并发/重复调用的去重靠它**：
 * 纯扫盘的话，同一进程内连续两次 nextAppId（两个对话框同时打开）会算出同一个 id；
 * 这里把已发出的 id 先**预留**，直到 upsertApp 真的把它写进注册表（落盘后扫盘就能看到，预留即失效）。
 * ★ 只保证**同一进程内**不重复。跨进程（多开 GUI）理论上仍可能撞车，
 *   但 appId 是目录名，重复 id 会表现为"两个应用共用一份 Spec"，代价明确、且多开 GUI 并非正常用法；
 *   为此加文件锁/原子占位属过度设计（真实写路径 upsertApp → mkdirSync(recursive) 也不会抛错兜底）。
 */
const reservations = new Map()

/** 某根目录下**已被占用**的全部 id：注册表记录 ∪ 目录名（目录名才是 appId 的唯一真源，可能尚未登记） */
function takenAppIds({ roots }) {
  const ids = new Set()
  for (const a of listApps({ roots })) if (a?.id != null && a.id !== '') ids.add(String(a.id))
  try {
    for (const name of readdirSync(rootOf(roots))) ids.add(name)
  } catch { /* 目录还不存在 = 一个应用都没有，不是错误 */ }
  return ids
}

/**
 * 自动分配下一个应用序号（工具识别号）：`app-001`、`app-002`…
 *
 * 规则（用户侧的诉求：id 不再让人手填，但它是内核侧 `app_<slug>_<action>` 工具名的真源，必须稳定且不撞）：
 *   · 扫**注册表记录 + 目录名**两处占用 —— 只扫一处必漏（真实环境里存在只有目录、没进注册表的遗留）；
 *   · 取形如 `app-<数字>` 的最大序号 +1，3 位补零（序号 ≥1000 时自然变 4 位，仍是合法 id）；
 *   · 候选若已被占用（含 `001` / `my-app` 这类非规范 id）就继续向后找，**绝不返回一个已存在的 id**；
 *   · 无任何应用时从 `app-001` 开始；
 *   · 同进程内重复调用不会给出同一个 id（靠上面的 reservations 预留）。
 * @param {{roots: string|string[]}} args
 * @returns {string}
 */
function nextAppId({ roots } = {}) {
  const root = String(rootOf(roots))
  const taken = takenAppIds({ roots })
  let reserved = reservations.get(root)
  if (!reserved) { reserved = new Set(); reservations.set(root, reserved) }
  let max = 0
  for (const id of taken) {
    const m = APP_ID_SEQ_RE.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (let n = max + 1; ; n += 1) {
    const candidate = `app-${String(n).padStart(3, '0')}`
    if (taken.has(candidate) || reserved.has(candidate)) continue
    reserved.add(candidate)
    return candidate
  }
}

/**
 * 用户需求（M1）在注册表里的上限。
 * ★ 必须与 electron/app-agent.cjs 的 REQUIREMENT_MAX_CHARS **同口径**（那里是提示词的权威截断点）；
 *   这里再截一次只是防止超长文本原样落盘。改一处要改两处。
 */
const REQUIREMENT_MAX_CHARS = 2000

/**
 * 需求字段归一化：只接受字符串；空白 → 空串（表示"没填"，用户清空后要能真的清掉）；
 * 非字符串（数字/对象/数组）→ 空串（宁可当没填，也不要把 `[object Object]` 存进注册表）。
 * 超长**截断而非报错**：一个字段超限不该让整次保存失败。
 * ★ 老条目没有这个字段，读出来就是 undefined，语义等同"无需求"，不需要迁移。
 */
function normalizeRequirementField(value) {
  if (value == null) return ''
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, REQUIREMENT_MAX_CHARS)
}

/**
 * 落盘前归一化条目：只为 `requirement` 收口，其余字段原样透传。
 * ★ 为什么不加严格字段白名单：app:upsert 的调用方可能带别的字段（历史遗留/后续扩展），
 *   白名单会**静默丢字段**——宁可多留一个键，也不要让调用方以为存上了却没存。
 */
function sanitizeApp(app) {
  const next = { ...app }
  if ('requirement' in next) next.requirement = normalizeRequirementField(next.requirement)
  return next
}

/** 读应用清单；文件缺失/损坏返回空数组（不抛） */
function listApps({ roots }) {
  const reg = readJson(registryPath(roots))
  return Array.isArray(reg?.apps) ? reg.apps : []
}

function writeRegistry({ roots, apps }) {
  mkdirSync(rootOf(roots), { recursive: true })
  writeFileSync(registryPath(roots), JSON.stringify({ version: 1, apps }, null, 2), 'utf-8')
}

/** 新增或更新（同 id 为更新，不追加重复项）；写入前归一化 requirement */
function upsertApp({ roots, app }) {
  if (!app?.id) throw new Error('upsertApp 需要 app.id')
  const entry = sanitizeApp(app)
  const apps = listApps({ roots })
  const i = apps.findIndex((a) => a.id === entry.id)
  if (i >= 0) apps[i] = { ...apps[i], ...entry }
  else apps.push(entry)
  writeRegistry({ roots, apps })
  mkdirSync(join(rootOf(roots), entry.id), { recursive: true })
  // 该 id 已落盘（扫盘即可见），预留可以撤销——不撤也不会出错，但会让 Map 无界增长
  reservations.get(String(rootOf(roots)))?.delete(String(entry.id))
  return entry
}

function removeApp({ roots, appId }) {
  writeRegistry({ roots, apps: listApps({ roots }).filter((a) => a.id !== appId) })
  rmSync(join(rootOf(roots), appId), { recursive: true, force: true })
}

/** 读 Spec（原样返回；写路径已保证 appId 与目录一致） */
function readSpec({ roots, appId }) {
  return readJson(join(rootOf(roots), appId, 'spec.json'))
}

/**
 * 写 Spec。**覆盖前自动备份旧版**（'spec.bak.<ts>.json'）。
 * ★ 强制 `spec.appId = appId`：目录名是 appId 的唯一真源。
 * @returns {string} 写入路径
 */
function writeSpec({ roots, appId, spec }) {
  const dir = join(rootOf(roots), appId)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'spec.json')
  if (existsSync(p)) {
    writeFileSync(join(dir, `spec.bak.${Date.now()}.json`), readFileSync(p), 'utf-8')
  }
  const next = { ...spec, appId }
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return p
}

/** 更新应用状态字段（enabled 等），避免调用方自己拼整对象 */
function setAppEnabled({ roots, appId, enabled }) {
  const apps = listApps({ roots })
  const i = apps.findIndex((a) => a.id === appId)
  if (i < 0) return null
  apps[i] = { ...apps[i], enabled }
  writeRegistry({ roots, apps })
  return apps[i]
}

/**
 * 备份文件名白名单：'spec.bak.<毫秒时间戳>.json'。
 * ★ 为什么必须是正则白名单而不是拼接路径：restoreSpec 的 backupName 来自渲染层，
 *   若直接 join 目录，'../../x' 这类输入就能读写到 apps 目录之外。白名单把可疑输入挡在拼路径之前。
 */
const BACKUP_RE = /^spec\.bak\.(\d{10,16})\.json$/

/**
 * 列出某个应用的 Spec 备份，按备份号**倒序**（最新在前，符合"想回滚到刚才那版"的直觉）。
 * 目录不存在 / 无备份 → 空数组（不抛）。
 * @returns {{name:string, ts:number}[]}
 */
function listBackups({ roots, appId }) {
  const dir = join(rootOf(roots), appId)
  let names = []
  try { names = readdirSync(dir) } catch { return [] }
  const out = []
  for (const n of names) {
    const m = BACKUP_RE.exec(n)
    if (m) out.push({ name: n, ts: Number(m[1]) })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/**
 * 回滚到指定备份。
 * ★ 复用 writeSpec 落盘 ⇒ **恢复前也会先备份当前版本**，于是"回滚"本身可再回滚
 *   （用户误点回滚不会造成不可逆丢失）。
 * @returns {object} 恢复后的 Spec
 * @throws 备份名不合法 / 备份不存在或损坏
 */
function restoreSpec({ roots, appId, backupName }) {
  const name = String(backupName || '')
  if (!BACKUP_RE.test(name)) throw new Error(`备份名不合法：${name}`)
  const src = join(rootOf(roots), appId, name)
  const spec = readJson(src)
  if (!spec || typeof spec !== 'object') throw new Error(`备份不存在或已损坏：${name}`)
  writeSpec({ roots, appId, spec })
  return spec
}

module.exports = { listApps, upsertApp, removeApp, readSpec, writeSpec, setAppEnabled, listBackups, restoreSpec, nextAppId, BACKUP_RE, REQUIREMENT_MAX_CHARS }
