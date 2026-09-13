// 应用命令执行器（Task 2.1）：解释执行 App Spec 的 steps（browser 驱动）
//
// 行为约定（写死，别自己发挥）：
//   1. read 命令：直接执行。
//   2. write 命令：**本模块不做审批**（审批在内核侧，见 Task 2.4 的权限规则；
//      控制台手工执行由 UI 二次确认，见 src/components/apps/AppConsole.tsx）；
//      但必须写 history 留痕。
//   3. 任何执行（含失败）都追加一行到 <root>/<appId>/history/<YYYY-MM-DD>.jsonl。
//   4. 步骤里的 ${param} 用命令入参插值；缺必填参数 → 报错返回，**不执行任何动作**。
'use strict'
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const registry = require('./app-registry.cjs')
const { interpolate, checkRequired, snapshotToText } = require('./app-util.cjs')
const { desktopRunner } = require('./app-runner-desktop.cjs')

const rootOf = (roots) => (Array.isArray(roots) ? roots[0] : roots)

/** 留痕：一天一个 jsonl，追加一行（失败也不阻断执行结果的返回） */
function appendHistory({ roots, appId, entry }) {
  try {
    const dir = join(rootOf(roots), appId, 'history')
    mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify(entry) + '\n', 'utf-8')
  } catch (e) {
    // 留痕失败不得把"命令其实成功了"变成报错（磁盘满/权限），仅静默，由调用方日志层承接
  }
}

/** 把 step 映射为浏览器执行器的 params（只取该 act 需要的字段，避免把未知字段灌进执行器） */
function stepParams(step, args) {
  const p = {}
  if (step.url != null) p.url = interpolate(step.url, args)
  if (step.selector != null) p.selector = interpolate(step.selector, args)
  if (step.ref != null) p.ref = step.ref
  if (step.value != null) p.value = interpolate(step.value, args)
  if (step.text != null) p.text = interpolate(step.text, args)
  if (step.key != null) p.key = step.key
  if (step.expression != null) p.expression = interpolate(step.expression, args)
  if (step.direction != null) p.direction = step.direction
  if (step.ms != null) p.ms = step.ms
  if (step.mode != null) p.mode = step.mode
  return p
}

/**
 * 执行一条命令（browser 驱动）。
 * @param {{roots:any, appId:string, action:string, args?:object, executor:object, sessionId:string}} p
 * @returns {Promise<{ok:boolean, data:any, error:string|null, kind:string, durationMs:number}>}
 */
async function runCommand({ roots, appId, action, args = {}, executor, sessionId, spec: specOverride, persist = true }) {
  const startedAt = Date.now()
  // specOverride：生成阶段的"试跑"用——此时 Spec 还没落盘（用户尚未确认），
  // 配套 persist=false 不写 history，避免给一个还不存在的应用留下执行记录。
  const spec = specOverride || registry.readSpec({ roots, appId })
  const cmd = spec?.commands?.find((c) => c.action === action)
  const base = { appId, action, args, kind: cmd?.kind ?? 'unknown', at: new Date().toISOString() }

  const fail = (error) => {
    const r = { ok: false, data: null, error, kind: base.kind, durationMs: Date.now() - startedAt }
    if (persist) appendHistory({ roots, appId, entry: { ...base, ok: false, error } })
    return r
  }

  if (!spec) return fail(`应用 Spec 不存在：${appId}`)
  if (!cmd) return fail(`未找到命令：${action}`)
  if (!executor) return fail('浏览器执行器未就绪')

  const req = checkRequired(cmd.params, args)
  if (!req.ok) return fail(req.errors.join('；'))

  try {
    let saved = null
    for (const step of cmd.steps || []) {
      const res = await executor.exec(sessionId, step.act, stepParams(step, args))
      if (!res?.ok) return fail(`步骤 ${step.act} 失败：${res?.error || '未知错误'}`)
      // snapshot 动作用 snapshotToText 归一（真实快照没有顶层 text；原先直接读 text 会让
      // save 拿到整坨快照对象——真机验收记录见 electron/app-util.cjs 的 snapshotToText 注释）
      if (step.save) saved = step.act === 'snapshot' ? snapshotToText(res.snapshot) : (res.data ?? res)
    }
    const durationMs = Date.now() - startedAt
    if (persist) appendHistory({ roots, appId, entry: { ...base, ok: true, durationMs } })
    return { ok: true, data: saved, error: null, kind: cmd.kind, durationMs }
  } catch (e) {
    return fail(String(e?.message || e))
  }
}

module.exports = { runCommand, interpolate, checkRequired, appendHistory, desktopRunner }
