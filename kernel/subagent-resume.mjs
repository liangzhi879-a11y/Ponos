// kernel/subagent-resume.mjs —— 后台子代理任务的**快照与恢复**（SESS-08，2026-10-18）
//
// 【为什么单独一个模块、而不是写进 engine.mjs】（这一步踩了坑，记录下来）
//   第一版把登记直接放在 `engine.mjs` 的派发处与终态汇聚点（同步 `appendFileSync`）。
//   结果 `kernel-tests/subagent.test.mjs` 的「主 cancel」用例在 Windows 上**稳定 EPERM**：
//     · 该用例取消子代理后立刻 `rmSync` 临时目录；
//     · 派发/终态路径上多出的磁盘 IO 改变了「cleanup」与「子代理收尾」的相对时序
//       ⇒ 目录句柄未即时释放 ⇒ 删除失败；
//     · 改成 `setImmediate` 也**仍回归**（`setImmediate` 本身已进事件循环，多一轮宏任务）。
//   对照验证：`git checkout` 还原 engine.mjs 后该用例 20/20 通过 ⇒ 确系本改动引入。
//   ⇒ 结论：**不要在子代理派发/终态的热路径上做任何额外 IO**（哪怕异步、哪怕只是调度）。
//     故本模块从**外部**驱动：
//     · 快照 = 由 CLI 定时（低频）+ 退出前 调 `snapshotActiveSubAgents()`（engine 只提供**纯读**导出）
//     · 恢复 = 由 CLI 启动时调本模块，用 engine 已导出的 `spawnSubAgent` 走 resume 分支
//
// 【★ 必须说清的风险：恢复不是"恢复现场"，是"重跑任务"】
//   子代理若在崩溃前已产生副作用（写了文件、发了请求），重跑会**再来一次**。
//   故：① `attempts` 默认上限 1（只重试一次）；达上限标 failed 不再拉起 ——
//   否则"崩溃 → 拉起 → 再崩"会被无限放大，那是最危险的失败模式。
//   ② `PONOS_SUBAGENT_AUTO_RESUME=0` 整机关闭。
//   ③ 并发受 `LANE_MAX_CONCURRENT` 约束（复用既有槽位，不新造一套）。
import { readRegistry, upsertTask, claimInterruptedTasks, compact } from '../shared/subagent-registry.cjs'

const RESUME_PROMPT = '（内核重启后自动恢复：请从上次中断处继续，已完成的部分不要重复做。）'

/**
 * 把当前活跃的后台子代理任务写进登记（**由 CLI 定时/退出时调用**）。
 *
 * @param {string} dataHome
 * @param {Array<{taskId:string, agentId?:string, agentName?:string, prompt?:string, startedAt?:string, laneOptions?:object}>} active
 * @returns {number} 写入条数
 */
export function snapshotActiveSubAgents(dataHome, active) {
  if (!dataHome || !Array.isArray(active)) return 0
  let n = 0
  for (const t of active) {
    if (!t || !t.taskId) continue
    const ok = upsertTask(dataHome, t.taskId, {
      status: 'running',
      ...(t.agentId ? { agentId: t.agentId } : {}),
      ...(t.agentName ? { agentName: t.agentName } : {}),
      ...(t.prompt ? { prompt: String(t.prompt).slice(0, 4000) } : {}),
      ...(t.startedAt ? { startedAt: t.startedAt } : {}),
      ...(t.laneOptions ? { laneOptions: t.laneOptions } : {}),
      snapshotAt: new Date().toISOString(),
    })
    if (ok) n += 1
  }
  return n
}

/**
 * 认领并恢复上次退出遗留的后台子代理任务。
 *
 * @param {object} o
 * @param {string} o.dataHome       数据根（engine 的 configDir）
 * @param {(input: object) => Promise<any>} o.spawnSubAgent engine 导出的派发函数（走 resume 分支）
 * @param {() => number} o.runningCount 当前正在跑的后台任务数（供并发上限判断）
 * @param {number} o.maxConcurrent  并发上限（复用 LANE_MAX_CONCURRENT）
 * @param {boolean} [o.autoResume]  显式开关（默认读 PONOS_SUBAGENT_AUTO_RESUME）
 * @param {number} [o.maxAttempts]  重试上限（默认 1）
 * @param {(msg: string, meta?: object) => void} [o.log]
 * @returns {Promise<{claimed:number, resumed:number, skipped:number, disabled?:boolean}>}
 */
export async function resumeOrphanedSubAgents(o) {
  const {
    dataHome, spawnSubAgent, runningCount, maxConcurrent,
    autoResume, maxAttempts: maxAttemptsIn, log,
  } = o || {}

  const enabled = autoResume !== undefined
    ? autoResume === true
    : process.env.PONOS_SUBAGENT_AUTO_RESUME !== '0'
  if (!enabled) return { claimed: 0, resumed: 0, skipped: 0, disabled: true }
  if (!dataHome || typeof spawnSubAgent !== 'function') {
    return { claimed: 0, resumed: 0, skipped: 0 }
  }

  const maxAttempts = Number.isFinite(Number(maxAttemptsIn))
    ? Number(maxAttemptsIn)
    : (Number(process.env.PONOS_SUBAGENT_RESUME_MAX_ATTEMPTS) || 1)

  let claimed = []
  try {
    // 先折叠历史（JSONL 会随任务增长），再认领。
    // 认领会把 running/queued 改写为 interrupted 并自增 attempts ——
    // 这一步必须先落盘：若拉起过程中再崩，attempts 已累积，下一轮就会停手。
    compact(dataHome)
    claimed = claimInterruptedTasks(dataHome, { maxAttempts })
  } catch (e) {
    log?.('subagent resume: claim failed', { err: String(e && e.message).slice(0, 200) })
    return { claimed: 0, resumed: 0, skipped: 0 }
  }
  if (claimed.length === 0) return { claimed: 0, resumed: 0, skipped: 0 }

  const cap = Number(maxConcurrent)
  const nowRunning = () => (typeof runningCount === 'function' ? Number(runningCount()) || 0 : 0)

  let resumed = 0
  let skipped = 0
  for (const t of claimed) {
    // 并发上限：按**实时**计数判断（每拉起一个，计数应随之增加；若宿主计数不含未完成派发，
    // 这里退化为"按名单顺序最多拉起 cap 个"，仍不会超发）
    if (Number.isFinite(cap) && cap > 0 && nowRunning() + resumed >= cap) { skipped += 1; continue }
    try {
      // 不重新给完整 prompt —— 那会在会话里重复一遍原始任务；用 resume 分支复用同一 lane。
      void Promise.resolve(spawnSubAgent({ resume_task_id: t.taskId, prompt: RESUME_PROMPT }))
        .catch((e) => {
          try {
            upsertTask(dataHome, t.taskId, {
              status: 'failed', failureReason: `resume-failed: ${String(e && e.message).slice(0, 200)}`,
            })
          } catch { /* 忽略 */ }
        })
      resumed += 1
    } catch (e) {
      skipped += 1
      try {
        upsertTask(dataHome, t.taskId, {
          status: 'failed', failureReason: `resume-threw: ${String(e && e.message).slice(0, 200)}`,
        })
      } catch { /* 忽略 */ }
    }
  }
  if (resumed > 0 || skipped > 0) {
    log?.('subagent auto-resume', { claimed: claimed.length, resumed, skipped })
  }
  return { claimed: claimed.length, resumed, skipped }
}

/** 供诊断/UI 读取：当前登记里有几个"上次没跑完"的任务（纯读） */
export function listInterruptedTasks(dataHome) {
  try {
    return readRegistry(dataHome).tasks.filter((t) => t.status === 'interrupted' || t.status === 'running' || t.status === 'queued')
  } catch {
    return []
  }
}
