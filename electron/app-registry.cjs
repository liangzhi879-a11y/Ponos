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
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
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

module.exports = { listApps, upsertApp, removeApp, readSpec, writeSpec, setAppEnabled }
