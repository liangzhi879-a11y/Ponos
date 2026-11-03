// shared/subagent-registry.cjs —— 后台子代理任务登记的**落盘版**（SESS-08，2026-10-18）
//
// 【缺陷】`kernel/engine.mjs` 的 `pendingSubAgents` 是**进程内 Map**：
//   内核一退（崩溃/被 kill/重启），子代理任务就从世界上消失了 —— 既查不到、也无法续跑。
//   而子代理的**会话文件（lane transcript）其实还在磁盘上**（`createSessionStore` 按 taskId 落盘）
//   ⇒ 缺的只是"索引"：没人记得有哪些任务在跑、对应哪个 lane 文件。
//
// 【存储形态：**追加式 JSONL**，不是读-改-写 JSON】
//   ⚠️ 第一版用"读整个 JSON → 改 → tmp+rename 写回"，实测在 Windows 上稳定 EPERM：
//     · `renameSync` 覆盖已存在文件时会短暂独占句柄，而任务状态变化是**高频**的；
//     · 测试清理临时目录（rmSync）会撞上这个占用 ⇒ 稳定失败（不是 flaky）。
//     · 更根本的是**竞态**：多个任务并发更新时，"读到的旧版本覆盖新版本"会丢更新。
//   ⇒ 改为**只追加**（`appendFileSync` 一行一条事件），彻底避开两者：
//     · 追加不覆盖、不需要 rename ⇒ 无独占窗口；
//     · 并发追加由 OS 的 O_APPEND 保证原子性（单行不交错）⇒ 无丢更新。
//   读时：按行解析，**同一 taskId 取最后一条**（后写覆盖先写，语义等价于 upsert）。
//
// 【三条纪律】
//   ① **损坏容错**：坏行跳过（不是整文件报废）；整个文件读不了也不抛 —— 宁可丢一次恢复机会，
//      也不能让内核起不来。
//   ② **只记不猜**：status 只有五态；进程崩溃留下的 running 由启动侧改写为 interrupted 再决定是否拉起，
//      不在本模块里"猜"它是否还在跑（那需要 pid 之类外部信息）。
//   ③ **压缩**：JSONL 会随任务数增长。提供 `compact()` 把历史折叠成"每任务一条最新记录"，
//      由调用方在合适时机（如启动时）调用。
const { existsSync, readFileSync, mkdirSync, appendFileSync } = require('node:fs')
// ★ 2026-10-18：注册表压缩重写必须 fsync 后 rename（写坏会让所有子代理记录丢失）
const { writeFileAtomicSync } = require('./atomic-write.mjs')
const { join, dirname } = require('node:path')

/** 允许的状态（越界值规整为 'interrupted'，避免脏数据永久污染索引） */
const STATUSES = ['queued', 'running', 'done', 'failed', 'interrupted']

/** 索引文件路径（`<dataHome>/subagents/registry.jsonl`） */
function registryPath(dataHome) {
  return join(dataHome, 'subagents', 'registry.jsonl')
}

/**
 * 读取并折叠索引：同一 taskId 取**最后一条**。**绝不抛异常**（纪律 ①）。
 * @param {string} dataHome
 * @returns {{ tasks: object[], corrupted?: boolean, badLines?: number }}
 */
function readRegistry(dataHome) {
  const p = registryPath(dataHome)
  try {
    if (!existsSync(p)) return { tasks: [] }
    const raw = readFileSync(p, 'utf-8')
    const byId = new Map()
    let badLines = 0
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      let rec
      try { rec = JSON.parse(t) } catch { badLines += 1; continue }   // 坏行跳过，不报废整文件
      if (!rec || typeof rec.taskId !== 'string' || rec.taskId === '') { badLines += 1; continue }
      // 后写覆盖先写（等价 upsert）；未给 status 的增量更新沿用上一条
      const prev = byId.get(rec.taskId) || {}
      byId.set(rec.taskId, {
        ...prev,
        ...rec,
        status: STATUSES.includes(rec.status) ? rec.status : (prev.status || 'interrupted'),
      })
    }
    return { tasks: [...byId.values()], ...(badLines > 0 ? { badLines } : {}) }
  } catch {
    return { tasks: [], corrupted: true }
  }
}

/**
 * 追加一条事件（**不做读-改-写**）。
 * @returns {boolean} 是否写成功（失败不抛，供调用方记日志）
 */
function appendRecord(dataHome, record) {
  const p = registryPath(dataHome)
  try {
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 登记/更新一条任务（= 追加一条最新记录）。
 * @param {string} dataHome
 * @param {string} taskId
 * @param {object} patch 要合并的字段（`status` 会按 STATUSES 校验）
 * @returns {boolean}
 */
function upsertTask(dataHome, taskId, patch) {
  if (!taskId) return false
  const rec = { ...(patch || {}), taskId, updatedAt: new Date().toISOString() }
  if (patch && patch.status !== undefined && !STATUSES.includes(patch.status)) {
    rec.status = 'interrupted'
  }
  if (!rec.createdAt) rec.createdAt = rec.updatedAt
  return appendRecord(dataHome, rec)
}

/**
 * 把"上次运行时留下的 running/queued"改写为 interrupted，并返回需要恢复的任务。
 *
 * ★ 为什么必须先改写再返回：这些任务**下一刻就会被自动拉起**。
 *   若不改写，拉起过程中若再次崩溃，索引里仍是 running ⇒ 下一轮会把它当成
 *   "又一个正在跑的" ⇒ **崩溃循环会被无限放大**。
 *   改写后即便再崩，attempts 计数也会累积，达到上限就不再拉起。
 *
 * @returns {object[]} 需要恢复的任务（attempts 已自增）
 */
function claimInterruptedTasks(dataHome, { maxAttempts = 1 } = {}) {
  const { tasks } = readRegistry(dataHome)
  const claimed = []
  for (const t of tasks) {
    if (t.status !== 'running' && t.status !== 'queued') continue
    const attempts = Number(t.attempts) || 0
    if (attempts >= maxAttempts) {
      // 达上限：标 failed 且不再拉起（防崩溃循环）
      upsertTask(dataHome, t.taskId, {
        status: 'failed', failureReason: `max-resume-attempts(${maxAttempts})`, attempts,
      })
      continue
    }
    upsertTask(dataHome, t.taskId, { status: 'interrupted', attempts: attempts + 1 })
    claimed.push({ ...t, status: 'interrupted', attempts: attempts + 1 })
  }
  return claimed
}

/**
 * 折叠历史：把 JSONL 重写成"每任务一条最新记录"（纪律 ③）。
 * 用 tmp + rename（此处**低频**，一次性压缩；不像逐次更新那样高频撞锁）。
 * @returns {boolean}
 */
function compact(dataHome) {
  const p = registryPath(dataHome)
  try {
    if (!existsSync(p)) return true
    const { tasks } = readRegistry(dataHome)
    // ★ 2026-10-18（自查自己的代码）：compact 也是"读-改-全文重写"，原来没有 fsync。
    //   压缩失败若留下空/半截 registry，会让**所有子代理任务记录**丢失 ⇒ 无法恢复。
    //   改用 writeFileAtomicSync（fsync + rename 重试 + 失败清理）。
    writeFileAtomicSync(p, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''))
    return true
  } catch {
    return false
  }
}

module.exports = {
  STATUSES,
  registryPath,
  readRegistry,
  appendRecord,
  upsertTask,
  claimInterruptedTasks,
  compact,
}
