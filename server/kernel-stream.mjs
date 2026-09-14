// server/kernel-stream.mjs —— 内核子命令的**流式**转发（2026-09-14）
// ---------------------------------------------------------------------------
// 与 `server/kernel-readonly.mjs` 的唯一实质差别：**要不要逐行看 stdout**。
// 只读子命令（--usage/--audit/--agents/spaces…）的 stdout 恰好一行 JSON，攒全量再 JSON.parse
// 最省事；而批量导入加 `--progress` 后是「N 行 NDJSON 进度 + 末行结果」，且 N 随文件数增长
// （20000 个文件 ≈ 2MB 输出，再叠上报告里的 converted[] 明细）——若照 kernel-readonly 那样
// 把 stdout 攒成一个大字符串，就等于把"支持大批量导入"这件事本身做成了内存炸弹：
// 用户调大上限时，先炸的是桥进程。故本模块**只保留最近若干行**（够取末行结果即可），
// 逐行回调交给调用方归约，内存与文件数解耦。
//
// 三道保险（与 kernel-readonly 逐项对齐，同样必须**自己**实现，spawn 不像 execFileSync 白送）：
//   · timeout：超时即 kill 并 reject。不 kill 的话子进程挂死会让任务永久停在 running，
//     比同步版更糟（同步版超时必返回）。
//   · maxBuffer：这里算的是**累计产出**字节数，不是"保留的字节数"——保留量必然有界（见上），
//     拿保留量做上限等于没有上限；跑飞的子进程会一直吐到超时。
//   · 非零退出：reject 并把 stderr 交出去（**stdout 丢弃**，与 kernel-readonly 同纪律）。
//     为什么 stderr 必须保住：内核以 `[knowledge] <code>: <message>` 一行表达"这次请求被
//     闸门拒了"，那是路由唯一能据以区分"输入不合规（400/403/404/413）"与"内核崩了（500）"
//     的线索。stderr 只留前 8KB（错误信息够用即可，不无界增长）。
import { spawn } from 'node:child_process'
// 复用只读模块的解析：内核路径**唯一事实来源**（YFWORKING_KERNEL > install 候选 > home 缓存），
// 另开一套解析必然与 live 会话内核漂移，且这里漂移的后果是"任务用的内核和查询用的不是同一个"。
import { resolveKernelCli } from './kernel-readonly.mjs'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024
/** stderr 保留上限（与 kernel-readonly 同值：`e.message` 最终会进日志与错误分类） */
const STDERR_KEEP = 8192
/** 尾部保留行数：末行结果 + 少量余量（末行可能被截断/损坏，回溯几行才取得到结果） */
const TAIL_KEEP = 8

/**
 * 流式调用内核子命令。
 *
 * @param argsList 业务 argv（**不含** `--output-format/--input-format`，那两个由本模块补齐）
 * @param opts.onLine 每行回调（已按 `\n` 切分、已去 `\r`、已丢弃空行）。回调抛错被吞：
 *                    进度是旁路，消费者（桥/GUI）的异常不该让导入失败。
 * @returns `{ code:0, tail:string[], bytes:number }` —— `tail` 是最末若干**原始行**，
 *          调用方自行 JSON.parse（本模块不猜哪行是结果：`--progress` 与否决定末行是什么，
 *          那是调用方的知识，不是传输层的）。
 *          超时 / stdout 超限 / spawn 失败 / 非零退出一律 reject。
 */
export function spawnKernelStreaming(argsList = [], {
  env = process.env, cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER,
  onLine = null, tailKeep = TAIL_KEEP,
} = {}) {
  // 与 kernel-readonly 同源解析；解析失败（内核缺失/YFWORKING_KERNEL 指向不存在的文件）
  // 同步抛出，由调用方（任务注册表）折成任务失败。
  const cli = resolveKernelCli()
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, '--output-format', 'stream-json', '--input-format', 'stream-json', ...argsList], {
      env, cwd, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = []
    let pending = ''            // 跨 chunk 的**半行**：这是唯一会累积的字符串，天然有界
    let bytes = 0
    let err = ''
    let settled = false
    let timer = null
    const done = (fn, v) => {
      if (settled) return // 超时 kill 后 'close' 仍会来，只认第一次
      settled = true
      if (timer) clearTimeout(timer)
      fn(v)
    }
    const kill = () => { try { proc.kill() } catch { /* 已自行退出 */ } }
    const handleLine = (raw) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (!line.trim()) return
      tail.push(line)
      if (tail.length > tailKeep) tail.shift()
      if (typeof onLine === 'function') {
        try { onLine(line) } catch { /* 进度回调抛错不该影响导入（与内核 emitProgress 同纪律） */ }
      }
    }
    timer = setTimeout(() => { kill(); done(reject, new Error(`[kernel-stream] timeout ${timeoutMs}ms`)) }, timeoutMs)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => {
      bytes += Buffer.byteLength(d, 'utf8')
      if (bytes > maxBuffer) {
        kill()
        return done(reject, new Error(`[kernel-stream] stdout 超过上限 ${maxBuffer}B`))
      }
      pending += d
      // 按 `\n` 切分后**只留最后一段**（可能是半行）：新行就地回调、就地丢弃，
      // 于是"千文件批次的 stdout"不会在内存里留下任何痕迹。
      const parts = pending.split('\n')
      pending = parts.pop()
      for (const l of parts) handleLine(l)
    })
    proc.stderr.on('data', (d) => { if (err.length < STDERR_KEEP) err += d })
    proc.on('error', (e) => done(reject, e))
    proc.on('close', (code) => {
      // 结尾无换行的残留行：`console.log` 一定带 `\n`，但被 kill / 管道截断时可能留下半行。
      // 仍交给 onLine —— 解析失败的行会被调用方忽略，不会污染结果判定。
      if (pending) { const last = pending; pending = ''; handleLine(last) }
      if (code === 0) return done(resolve, { code: 0, tail: tail.slice(), bytes })
      // 非零退出：与 kernel-readonly 同形（stderr 原文，或固定 harness 消息）。
      // 调用方（路由/任务注册表）据此区分闸门行与非闸门失败。
      done(reject, new Error(err.trim() || `[kernel-stream] exit ${code}`))
    })
  })
}
