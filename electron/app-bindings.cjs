// 应用绑定（严格单开）：sessionId → 至多一个 appId
//
// 设计要点：
//  1. **值是字符串而非数组** —— 物理上不可能多开，工具池规模天然受控（最多一个应用的命令）。
//     将来若要放开多开，把值改成数组即可，改动面仅限本文件。
//  2. **落盘而非内存** —— 内核是独立进程（main.cjs spawn bridge → kernel/cli.mjs），
//     主进程内存变量内核读不到；故绑定状态写 binding.json，由内核的「视图函数」每次求值读文件。
//     因为 setDynamicTools 收的是视图函数（每次求值），这天然实现「进入即生效、离开即消失」，
//     且零重启、零跨进程消息。
//  3. **文件格式与内核侧 kernel/app-spec.mjs 的 getBoundApp 保持一致**：
//     { "<sessionId>": { appId, boundAt } }
'use strict'
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }
const rootOf = (roots) => (Array.isArray(roots) ? roots[0] : roots)
const bindingPath = (roots) => join(rootOf(roots), 'binding.json')

function readAll(roots) {
  const v = readJson(bindingPath(roots))
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
}

function writeAll(roots, all) {
  mkdirSync(rootOf(roots), { recursive: true })
  writeFileSync(bindingPath(roots), JSON.stringify(all, null, 2), 'utf-8')
}

/** 读当前会话绑定的应用 id → appId | null */
function getBoundApp({ roots, sessionId }) {
  if (!sessionId) return null
  return readAll(roots)[sessionId]?.appId ?? null
}

/**
 * 绑定（覆盖语义 = 严格单开原子替换）。
 * 同会话再次调用会直接替换旧绑定，而非叠加。
 */
function bindApp({ roots, sessionId, appId }) {
  if (!sessionId) throw new Error('bindApp 需要 sessionId')
  if (!appId) throw new Error('bindApp 需要 appId')
  const all = readAll(roots)
  all[sessionId] = { appId, boundAt: new Date().toISOString() }
  writeAll(roots, all)
  return all[sessionId]
}

/**
 * 解绑。**仅当当前绑定的确实是 appId 时才清除**。
 * 必要性：用户快速切换 A→B 时，A 控制台的卸载事件可能晚于 B 的进入事件到达；
 * 若不做此校验，A 的离开会把 B 的绑定误清掉（agent 侧工具随即消失）。
 * @returns {boolean} 是否真的清除了
 */
function unbindApp({ roots, sessionId, appId }) {
  if (!sessionId) return false
  const all = readAll(roots)
  if (all[sessionId]?.appId !== appId) return false
  delete all[sessionId]
  writeAll(roots, all)
  return true
}

/** 读全部绑定（诊断/调试用，不改语义） */
function listBindings({ roots }) {
  return readAll(roots)
}

module.exports = { getBoundApp, bindApp, unbindApp, listBindings }
