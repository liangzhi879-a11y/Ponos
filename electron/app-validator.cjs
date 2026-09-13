// 漂移修复（Task 3.4）：命令因目标应用改版而失效时，**只修失败的那几条命令**。
//
// 四条硬规则（照着计划，但失败来源按真实代码修正）：
//   ① 必先备份 —— 复用 registry.writeSpec（它覆盖前自动备份）。
//   ② 只改失败的命令 —— 其余命令原样保留、逐字节不动。
//   ③ 必须回报 repaired —— 改了什么（旧→新摘要）要说清楚，**不得静默**。
//   ④ broken 不自动修复 —— 目标本身不可用（URL 非法 / exePath 不存在）时修命令没有意义。
//
// ★ 与计划的**有意偏差**：计划要求"从 checkApp().issues 用 /命令 (\w+)/ 提取失败命令"，
//   但真实 checkApp（app-profiler.cjs:142）只做静态校验（URL/exePath/结构），
//   从不产生"命令 X 失败"这类 issue —— 该前提在真实代码里不成立。
//   真实的失败来源是**执行历史**（<appId>/history/<date>.jsonl，成功失败都留痕，见 app-runner.cjs:20），
//   故此处按"每个 action 的最近一次执行结果"判定失败命令。
//
// ★ 安全性：失败命令必须**换新**才写盘；修完对**整份 Spec** 再校验一次，
//   不合法就整体放弃（"宁可不修，不可改坏"）。
'use strict'
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const registry = require('./app-registry.cjs')
const profiler = require('./app-profiler.cjs')
const { validateSpecBasic, extractSpec, SYSTEM_RULES } = require('./app-generate.cjs')

const MAX_REPAIR = 5
const HISTORY_DAYS = 14
const rootOf = (roots) => (Array.isArray(roots) ? roots[0] : roots)

/** 读执行历史（最近 days 天）。坏行/坏文件跳过——历史是留痕，不是唯一真源，不能因一行坏数据炸掉修复。 */
function readHistory({ roots, appId, days = HISTORY_DAYS }) {
  const dir = join(rootOf(roots), appId, 'history')
  let files = []
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() } catch { return [] }
  const since = Date.now() - days * 86400000
  const out = []
  for (const f of files.slice(-days)) {
    let txt = ''
    try { txt = readFileSync(join(dir, f), 'utf-8') } catch { continue }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e?.at && Date.parse(e.at) < since) continue
        out.push(e)
      } catch { /* 跳过坏行 */ }
    }
  }
  return out
}

/**
 * 失败命令 = 该 action 的**最近一次**执行 ok===false。
 * 只认最近一次：某命令历史上失败过、后来手工或重试成功了，就不该再被算作待修。
 * @returns {{action:string, error:string, at:string}[]}
 */
function findFailingCommands({ roots, appId, days = HISTORY_DAYS }) {
  const hist = readHistory({ roots, appId, days })
  const last = new Map()
  for (const e of hist) {
    if (!e?.action) continue
    const prev = last.get(e.action)
    if (!prev || String(e.at || '') >= String(prev.at || '')) last.set(e.action, e)
  }
  const out = []
  for (const [action, e] of last) if (e.ok === false) out.push({ action, error: String(e.error || '执行失败'), at: e.at || '' })
  return out.sort((a, b) => String(a.action).localeCompare(String(b.action)))
}

/** 新旧对比摘要（给用户看"到底改了哪里"，避免"修复了但不知道改了啥"） */
function summarize(cmd) {
  return {
    title: String(cmd?.title || ''),
    kind: String(cmd?.kind || ''),
    steps: Array.isArray(cmd?.steps) ? cmd.steps.length : 0,
    params: Array.isArray(cmd?.params) ? cmd.params.length : 0,
  }
}

/** 单条命令的修复提示词（在生成规则上追加"只输出这一条命令"的约束） */
function buildCommandPrompt({ spec, command, error }) {
  const system = `${SYSTEM_RULES}\n\n补充：这次只修**一条**命令。只输出这一个命令对象的 JSON（不要数组、不要外层 spec、不要解释文字）。`
  const user = [
    `应用：${spec?.name || spec?.appId}（target=${JSON.stringify(spec?.target || {})}）`,
    `原命令（执行失败）：${JSON.stringify(command)}`,
    `失败原因（来自真实执行报错）：${error}`,
    '请输出修正后的这一条命令 JSON（action 必须与原命令完全相同）。',
  ].join('\n\n')
  return { system, user }
}

/** 从模型输出里抠出单条命令（兼容"整份 spec / 命令数组 / 单个命令对象"三种形态） */
function extractCommand(text) {
  const j = extractSpec(text)
  if (!j) return null
  if (Array.isArray(j.commands) && j.commands.length) return j.commands[0]
  if (j.action) return j
  return null
}

/**
 * 默认的重新生成实现：走真模型（callLlm 由调用方注入，测试可替换）。
 * ★ 未注入 callLlm 时返回 null（= 修不了），**绝不假装修复成功**。
 */
function defaultRegenerateCommand(deps = {}) {
  const callLlm = deps.callLlm
  return async ({ spec, command, error }) => {
    if (typeof callLlm !== 'function') return null
    const { system, user } = buildCommandPrompt({ spec, command, error })
    const r = await callLlm({ system, user })
    if (!r?.ok) return null
    return extractCommand(r.text)
  }
}

/**
 * 修复漂移：找出失败命令 → 逐条重新生成 → 整体校验 → 写盘（写前自动备份）。
 * @param {{roots:any, appId:string, deps?:object, maxRepair?:number}} p
 * @returns {Promise<{ok:boolean, reason:string|null, repaired:Array, failed:Array, backup:string|null, status?:string}>}
 */
async function repairApp({ roots, appId, deps = {}, maxRepair = MAX_REPAIR }) {
  const readSpec = deps.readSpec || registry.readSpec
  const writeSpec = deps.writeSpec || registry.writeSpec
  const checkApp = deps.checkApp || profiler.checkApp
  const findFailures = deps.findFailures || findFailingCommands
  const listBackups = deps.listBackups || registry.listBackups
  const regenerate = deps.regenerateCommand || defaultRegenerateCommand(deps)
  const validate = deps.validate || validateSpecBasic

  const spec = readSpec({ roots, appId })
  if (!spec || typeof spec !== 'object') {
    return { ok: false, reason: 'Spec 不存在或损坏，无法修复（请先生成或手工写入 Spec）', repaired: [], failed: [], backup: null }
  }

  // 规则 ④：broken 不自动修复
  const chk = await checkApp({ spec })
  if (chk?.status === 'broken') {
    return {
      ok: false,
      reason: `应用状态为 broken（${(chk.issues || [])[0] || '目标不可用'}），不自动修复——请先修正目标本身`,
      repaired: [], failed: [], backup: null, status: chk.status,
    }
  }

  const failures = await findFailures({ roots, appId })
  if (!failures.length) {
    // 规则 ①：没有失败命令时**不写盘**，也就不产生备份（不做无意义备份淹没备份列表）
    return { ok: false, reason: '没有发现执行失败的命令（无需修复）', repaired: [], failed: [], backup: null, status: chk?.status || 'healthy' }
  }

  const cmds = Array.isArray(spec.commands) ? spec.commands.slice() : []
  const repaired = []
  const failed = []
  for (const f of failures.slice(0, maxRepair)) {
    const idx = cmds.findIndex((c) => c?.action === f.action)
    if (idx < 0) { failed.push({ action: f.action, reason: 'Spec 中已无该命令' }); continue }
    let next = null
    try {
      next = await regenerate({ spec, command: cmds[idx], error: f.error })
    } catch (e) {
      failed.push({ action: f.action, reason: `重新生成抛错：${String(e?.message || e)}` })
      continue
    }
    if (!next || typeof next !== 'object') { failed.push({ action: f.action, reason: '重新生成未成功' }); continue }
    if (next.action !== cmds[idx].action) {
      // 宁可放弃这一条，也不要错位覆盖到别的命令上
      failed.push({ action: f.action, reason: '重新生成的 action 与原命令不一致（已放弃该条，避免错位覆盖）' })
      continue
    }
    repaired.push({ action: f.action, from: summarize(cmds[idx]), to: summarize(next), reason: f.error })
    cmds[idx] = { ...next }
  }

  if (!repaired.length) {
    return { ok: false, reason: '失败的命令都没能重新生成出来，Spec 未改动', repaired: [], failed, backup: null, status: chk?.status }
  }

  const nextSpec = { ...spec, commands: cmds }
  const v = validate(nextSpec)
  if (!v.ok) {
    // 规则：宁可不修，不可改坏
    return {
      ok: false,
      reason: `修复后的 Spec 不合法，已放弃写盘（原 Spec 未被改动）：${v.errors.slice(0, 3).join('；')}`,
      repaired: [], failed, backup: null, status: chk?.status,
    }
  }

  writeSpec({ roots, appId, spec: nextSpec })
  return { ok: true, reason: null, repaired, failed, backup: listBackups({ roots, appId })[0]?.name || null, status: chk?.status }
}

module.exports = {
  repairApp, findFailingCommands, readHistory, buildCommandPrompt, extractCommand,
  defaultRegenerateCommand, summarize, MAX_REPAIR, HISTORY_DAYS,
}
