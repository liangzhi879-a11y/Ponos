// server/import-jobs.mjs —— 知识库批量导入的异步任务注册表（2026-09-14）
// ---------------------------------------------------------------------------
// 为什么要有这一层：大批量导入动辄跑数分钟到十几分钟（OCR/视觉按分钟计），一次 HTTP 请求
// 等在那里的代价是"没有进度 + 超时窗口一到就连进度一起丢"。改成"立即返回 jobId、后台跑、
// 调用方轮询"后，进度成了唯一的事实来源，于是这份注册表必须保证三件事：
//   1) 进度**单调**（只前进不后退），否则进度条会来回跳，用户读不出"还要多久"；
//   2) 结果取**末行**（内核 stdout = 若干 NDJSON 进度行 + 末行结果），进度行与结果行必须分清；
//   3) 任务记录**有界**且**不漏掉运行中的**（见 evictForRoom 的长注释）。
//
// 本模块不复制任何内核逻辑：argv 由路由层组装（那里是 flag 映射的唯一事实来源），
// 进程由 server/kernel-stream.mjs 起，错误文本 → { error, code } 的映射由调用方注入
// （`server/knowledge-routes.mjs` 的那张 `IMPORT_ERROR_STATUS` 表是唯一真源）——
// 在这里再抄一份"什么码算 403"必然与同步路径漂移，而漂移是静默的。
import { randomUUID } from 'node:crypto'
import { spawnKernelStreaming } from './kernel-stream.mjs'

/** 任务保留期：结束后留 10 分钟供轮询取结果（GUI 轮询间隔 ~500ms，正常几百毫秒内就取走了） */
export const JOB_TTL_MS = 10 * 60 * 1000

/**
 * 注册表硬上限（并发 + 历史）。为什么必须有：每个任务背后是一个真内核进程（约 50–70MB RSS）
 * 加一份报告对象，而 jobId 是调用方随时可再发的；没有上限时"点到手抖/脚本重试"就能把桥拖垮。
 * 50 的具体理由：GUI 一次导入只开一个任务，50 足够容纳"多人共用一台机器 + 短时间连续重试"，
 * 又远小于进程内存出问题的量级。
 */
export const MAX_IMPORT_JOBS = 50

/** jobId → job（job 是可变内部对象，对外只经 getImportJob 折成契约形状） */
const jobs = new Map()

/**
 * 调用方未注入映射时的兜底：**宁可给一句定式消息，也绝不透 stderr 原文**
 * （内核崩溃时那段是 Node code frame + 绝对路径栈，属于服务端实现细节）。
 * 生产路径由 `knowledge-routes` 注入完整映射表（那里才有状态码/码表）。
 */
function defaultMapError() {
  return { error: '导入失败：内核异常退出（详见服务端日志）', code: 'kernel-failed' }
}

/**
 * 完成百分比：与 GUI `src/lib/knowledgeImportUi.ts:importPercent` 逐位同口径
 * （四舍五入的整数、total≤0 时 0、上限 100）。
 * 两端各写一套算法的后果是进度的**显示口径**漂移（轮询拿到 33、进度条算出 33.3），
 * 而这类偏差没有测试就会一直存在 —— 由 `knowledge-import-jobs.test.mjs` 的一致性用例钉住。
 */
export function importPercent({ done, total }) {
  const t = Math.floor(Number(total))
  const d = Math.floor(Number(done))
  if (!Number.isFinite(t) || t <= 0) return 0
  if (!Number.isFinite(d) || d <= 0) return 0
  return Math.min(100, Math.round((d / t) * 100))
}

/** 非负整数归约（进度行可能来自任意形状的 JSON，坏值一律丢，不污染进度） */
function nonNegInt(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.floor(n))
}

/**
 * 归约一行 NDJSON。
 * 三类行：进度行（`{type:'progress',phase,…}`）、结果行（报告对象）、以及**解析不了的垃圾行**
 * —— 内核在 stderr 上可能插别的东西、进程被 kill 时可能留半行，这些一律忽略：
 * 契约要求"进度行解析失败不得影响最终结果判定"。
 */
function reduceLine(job, line) {
  let evt
  try { evt = JSON.parse(line) } catch { return }
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return
  // 判 `type` 且判 `phase`：只有**同时**满足才是进度事件，避免把恰好含 `type` 字段的报告
  // 当成进度行丢掉（那会让任务以"没取到结果"失败）
  if (evt.type === 'progress' && typeof evt.phase === 'string') return reduceProgress(job, evt)
  // 非进度行里最后出现的那一个 = 内核的末行结果（同步路径的 stdout 契约就是这个对象）
  job.lastResult = evt
}

/** 进度行 → 任务状态。plan 定 total（"先查文件数"），process 递进，done 收尾 */
function reduceProgress(job, evt) {
  const total = nonNegInt(evt.total)
  if (total !== null) job.total = total
  // plan 是**第一条**进度行（枚举完文件立即发），此刻 done 归零；
  // 只认第一条 plan：万一将来内核重复发 plan（重试/多源），后面的不能把进度拽回去。
  if (!job.planSeen) { job.planSeen = true; job.done = 0 }
  if (evt.phase === 'plan') {
    const tb = nonNegInt(evt.totalBytes)
    if (tb !== null) job.totalBytes = tb
    const rj = nonNegInt(evt.rejected)
    if (rj !== null) job.rejected = rj
    return
  }
  const d = nonNegInt(evt.done)
  // 进度按**循环下标**推进（内核契约保证收敛到 total），但到达顺序不保证：
  // 只允许前进，落后/乱序/重放的行不把进度条拉回去（单调性是轮询模式下唯一的观感保证）。
  if (d !== null && d > job.done) job.done = d
  if (job.total > 0 && job.done > job.total) job.done = job.total
  if (typeof evt.current === 'string' && evt.current) job.current = evt.current
  // 收尾行不带 current：清掉，免得 UI 在"已处理 N/N"旁边继续显示最后一个文件名
  if (evt.phase === 'done') job.current = null
}

/** 从尾部原始行里回溯找最后一个"非进度"的 JSON 对象（onLine 未被接/尾部有半行时的兜底） */
function resultFromTail(tail) {
  for (let i = (tail || []).length - 1; i >= 0; i--) {
    let v
    try { v = JSON.parse(tail[i]) } catch { continue }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    if (v.type === 'progress' && typeof v.phase === 'string') continue
    return v
  }
  return null
}

/**
 * TTL 回收：结束后保留 ttlMs 再删除。
 * `unref()` 是硬要求：保留期只是"让人还能再查一眼"的便利，不是业务本身——
 * 一个 ref'd 定时器会让 bridge/CLI 脚本在最后一个请求结束后迟迟不退（测试进程尤其明显）。
 */
function scheduleTtl(job) {
  job.timer = setTimeout(() => { jobs.delete(job.id) }, job.ttlMs)
  if (job.timer && typeof job.timer.unref === 'function') job.timer.unref()
}

function removeJob(id) {
  const job = jobs.get(id)
  if (!job) return
  if (job.timer) { clearTimeout(job.timer); job.timer = null }
  jobs.delete(id)
}

/**
 * 腾位置。**只淘汰已结束的任务，绝不淘汰运行中的**：
 * 淘汰一个 running 任务不会让它背后的内核进程停下——进程照旧往空间里写文件，而它的进度与
 * 报告已经查不到了（任务记录没了 ⇒ 调用方看到 404 ⇒ "到底导进去几篇"永远无从得知）。
 * 那正是最难收拾的状态：有写入、无账目。相比之下"注册表暂时多留一条记录"的代价可以忽略。
 * 因此全在运行时**超限放行**（返回而不淘汰），把上限当作内存护栏而不是并发闸门 ——
 * 真要限制并发该在"开始新任务"那一步拒（429），那是另一个决定，不在本模块擅自加。
 */
function evictForRoom(maxJobs) {
  if (!(maxJobs > 0)) return
  while (jobs.size >= maxJobs) {
    let oldest = null
    for (const j of jobs.values()) {
      if (j.status === 'running') continue
      if (!oldest || j.endedAt < oldest.endedAt) oldest = j
    }
    if (!oldest) return // 全在运行 → 超限放行（理由见上）
    removeJob(oldest.id)
  }
}

/**
 * 启动一个后台导入任务。
 *
 * @param args      业务 argv（路由层组装，**不含** `--progress`——那是"异步任务"的实现细节，
 *                  由本模块追加：同步路径的 stdout 契约恰好一行 JSON，加进度行就把它破坏了）
 * @param spawnStream 流式 spawn 实现（可注入；测试注入假实现，绝不真起内核进程）
 * @param mapError  内核失败文本 → `{ error, code? }`（可注入；生产注入路由那份映射表）
 * @returns `{ jobId, promise }` —— `promise` 供测试 await 与优雅关停，**永不 reject**
 *          （任务失败是正常终态，不是调用方的异常）
 */
export function startImportJob({
  args = [], spawnStream = spawnKernelStreaming, mapError = defaultMapError,
  env, cwd, timeoutMs, maxBuffer, ttlMs = JOB_TTL_MS, maxJobs = MAX_IMPORT_JOBS,
} = {}) {
  const job = {
    id: randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    planSeen: false,
    done: 0, total: 0, current: null, totalBytes: 0, rejected: 0,
    report: null, error: null, code: null, lastResult: null,
    ttlMs, timer: null,
  }
  evictForRoom(maxJobs)
  jobs.set(job.id, job)

  const finish = () => {
    job.endedAt = Date.now()
    scheduleTtl(job)
  }
  const argv = args.includes('--progress') ? [...args] : [...args, '--progress']
  // Promise.resolve().then(...)：把"同步抛出"（内核路径解析失败）与"异步 reject"统一成一条路，
  // 调用方不必写两套错误处理
  const promise = Promise.resolve()
    .then(() => spawnStream(argv, {
      env, cwd, timeoutMs, maxBuffer,
      onLine: (line) => reduceLine(job, line),
    }))
    .then((res) => {
      // 末行取结果：优先用 onLine 归约出来的最后一条非进度行（不占额外内存），
      // 拿不到时回溯 spawn 给的尾部若干行（调用方可能没接 onLine，或末行是半行/垃圾）
      const report = job.lastResult ?? resultFromTail(res?.tail)
      if (!report) {
        // exit 0 却没有结果行：不正常（同步路径同情形回 502）。这里按失败收尾而不是回一个
        // 空报告——空报告会被 GUI 渲染成"导入了 0 个文件，成功"，那是彻头彻尾的假信息。
        job.status = 'error'
        job.error = '导入失败：内核未返回结果（stdout 无 JSON 结果行）'
        job.code = 'kernel-failed'
        finish()
        console.warn('[knowledge-import] 任务', job.id, '退出码 0 但无结果行，尾行数', (res?.tail || []).length)
        return
      }
      job.status = 'done'
      job.report = report
      // 完成即收敛到 total：内核进度按下标推进、正常必然已到 total，但万一收尾的 done 行丢了
      // （输出被截断），不补这一下就会让"已完成的任务"显示 99% —— 进度条卡住比没有进度更糟。
      if (job.total > 0) job.done = job.total
      job.current = null
      finish()
    }, (e) => {
      const msg = String(e?.message || e)
      let mapped = null
      try { mapped = mapError(msg) } catch { mapped = null }
      job.status = 'error'
      job.error = (mapped && mapped.error) || defaultMapError().error
      job.code = (mapped && mapped.code) || null
      job.current = null
      finish()
    })
  return { jobId: job.id, promise }
}

/**
 * 查询任务（契约 §1 的响应形状：running/done/error 三态，percent 用 GUI 同口径）。
 * 未知 id → null（路由折成 404：与"任务还在跑但还没开始"必须能分开——前者提示"任务不存在或
 * 已过保留期"，后者提示"正在统计文件数"）。
 */
export function getImportJob(id) {
  const job = jobs.get(String(id ?? ''))
  if (!job) return null
  if (job.status === 'running') {
    return {
      status: 'running', done: job.done, total: job.total,
      current: job.current ?? '', percent: importPercent(job), startedAt: job.startedAt,
    }
  }
  if (job.status === 'done') {
    return {
      status: 'done', done: job.done, total: job.total, percent: importPercent(job),
      report: job.report, startedAt: job.startedAt, endedAt: job.endedAt,
    }
  }
  return {
    status: 'error', error: job.error, ...(job.code ? { code: job.code } : {}),
    startedAt: job.startedAt, endedAt: job.endedAt,
  }
}

/** 仅测试用：清空注册表并摘掉所有 TTL 定时器（unref 的定时器不会挂住进程，但会跨用例串味） */
export function _resetImportJobs() {
  for (const id of [...jobs.keys()]) removeJob(id)
  jobs.clear()
}
