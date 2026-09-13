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

/** 读应用清单；文件缺失/损坏返回空数组（不抛） */
function listApps({ roots }) {
  const reg = readJson(registryPath(roots))
  return Array.isArray(reg?.apps) ? reg.apps : []
}

function writeRegistry({ roots, apps }) {
  mkdirSync(rootOf(roots), { recursive: true })
  writeFileSync(registryPath(roots), JSON.stringify({ version: 1, apps }, null, 2), 'utf-8')
}

/** 新增或更新（同 id 为更新，不追加重复项） */
function upsertApp({ roots, app }) {
  if (!app?.id) throw new Error('upsertApp 需要 app.id')
  const apps = listApps({ roots })
  const i = apps.findIndex((a) => a.id === app.id)
  if (i >= 0) apps[i] = { ...apps[i], ...app }
  else apps.push(app)
  writeRegistry({ roots, apps })
  mkdirSync(join(rootOf(roots), app.id), { recursive: true })
  return app
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

module.exports = { listApps, upsertApp, removeApp, readSpec, writeSpec, setAppEnabled, listBackups, restoreSpec, BACKUP_RE }
