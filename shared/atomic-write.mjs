/**
 * 原子文件写入（2026-09-14，对标 Obsidian 批次 4）。
 *
 * ## 为什么必须有
 *
 * `writeFileSync(path, content)` 是**就地覆写**：内核把同一份 inode 的内容从偏移 0 开始替换。
 * 一旦进程在写到一半时终止（崩溃 / 断电 / 被 Electron 主进程强杀 / 磁盘满），
 * 文件就停在**半截状态** —— 对 Markdown 来说就是"用户三年来写的笔记只剩前 300 字节"，
 * 而且**没有任何报错留下**。这不是理论风险：本应用的保存路径在用户按 Ctrl+S 的同步链路上。
 *
 * `tmp + rename` 把"替换内容"变成**原子的目录项替换**：新内容先写到同目录的临时文件并 fsync，
 * 再 rename 覆盖目标。rename 在同一文件系统上是原子操作 —— 读者要么看到完整的旧内容、
 * 要么看到完整的新内容，**不存在半截**。写失败时临时文件被清掉，目标文件一个字节都没动。
 *
 * ## 三个容易做错的点
 *
 * 1. **临时文件必须与目标同目录**：跨文件系统的 rename 会 `EXDEV` 失败，退化成"复制 + 删除"
 *    就又失去了原子性。同目录保证同盘。
 * 2. **必须 fsync 文件再 rename**：否则 rename 可能先于数据落盘被持久化（ext4 延迟分配、
 *    Windows 写缓存），断电后新文件是空的或半截 —— 这就白做了。fsync 之后才 rename，
 *    顺序保证"目录里出现这个名字时，内容已经完整"。
 * 3. **临时名要能被人一眼认出且绝不撞车**：`.yfw-tmp-<pid>-<rand>-<basename>`，前缀点号让
 *    目录遍历（本仓库多处 `readdirSync` 会处理知识空间目录）与用户视线都能跳过它。
 *    随机段避免同一进程并发写同名文件时互相覆盖临时文件。
 *
 * ## 不做什么
 *
 * 不做"目录 fsync"（写完 rename 后 fsync 父目录，保证目录项本身持久化）。理由：在 Windows 上
 * 打开目录句柄做 fsync 不可用（Node 会抛 EPERM/EISDIR），而在 Linux/macOS 上其收益仅限于
 * "刚 rename 完就拔电"这种极小窗口。为了跨平台一致性，这里选择不做 —— 而不是在 Windows 上
 * 静默跳过（静默跳过比不做更糟：读者会以为已经做了）。
 */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 临时文件前缀：点号开头（遍历可跳过）+ 固定标识（人工排查时一眼认出是残留） */
const TMP_PREFIX = '.yfw-tmp-'

/** 单次尝试内的随机串（同进程并发写同一目标时避免临时名撞车） */
function randTag() {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * **瞬时** rename 失败的错误码（2026-10-18，由 loop-e2e 间歇假红追出的真实缺陷）。
 *
 * 为什么需要它：Windows 上 `renameSync` 覆盖一个**正被读句柄打开**的目标文件会偶发 `EPERM`。
 * 实测（写者 3000 次 rename、读者每 25ms `readFileSync` 同一文件）：**50 次 EPERM ≈ 1.7%**。
 *
 * 为什么这值钱：`kernel/loop.mjs#persist()` 正是 tmp+rename，而**桥主管与 GUI 都在轮询**
 * 循环状态文件（`aliveAt` 心跳就靠它）。persist 失败只 warning 一次然后静默 ⇒
 * 磁盘长期停留在旧状态 ⇒ 循环的 `nextRunAt` 永远是 0 ⇒ **内核被回收后主管无法唤醒**，
 * 断点续跑能力**静默失效**。这类失败不会报错、不会崩，只是"功能时有时无"——最难查的一类。
 *
 * 只重试**瞬时**错误：`ENOENT`（目标目录没了）、`EXDEV`（跨盘）、`ENOSPC`（磁盘满）
 * 重试多少次都不会成功，立即抛给调用方才是对的。
 */
export const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE'])

/** 同步睡眠（Node 主线程可用；仅用于重试退避的毫秒级等待） */
function sleepSyncMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  try {
    // Atomics.wait 在主线程可用（浏览器不允许，Node 允许），且不烧 CPU
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n)
  } catch {
    // 极端环境不支持就退化为忙等一小会儿（远好于"没有退避"）
    const t0 = Date.now()
    while (Date.now() - t0 < n) { /* spin */ }
  }
}

/**
 * 带**瞬时错误重试**的 `renameSync`。
 *
 * @param {string} from 临时文件（同目录、同文件系统）
 * @param {string} to 目标文件
 * @param {object} [o]
 * @param {number} [o.attempts] 最多尝试次数（默认 8）
 * @param {number} [o.baseDelayMs] 首次退避毫秒（默认 15；之后线性递增，封顶 200）
 * @param {(from:string,to:string)=>void} [o.renameImpl] 测试注入
 * @param {(ms:number)=>void} [o.sleepImpl] 测试注入
 * @returns {void}
 */
export function renameWithRetrySync(from, to, o = {}) {
  const attempts = Number.isFinite(Number(o.attempts)) && Number(o.attempts) > 0
    ? Math.floor(Number(o.attempts))
    : 8
  const baseDelayMs = Number.isFinite(Number(o.baseDelayMs)) && Number(o.baseDelayMs) >= 0
    ? Number(o.baseDelayMs)
    : 15
  const renameImpl = o.renameImpl || renameSync
  const sleepImpl = o.sleepImpl || sleepSyncMs

  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    try {
      renameImpl(from, to)
      return
    } catch (e) {
      lastErr = e
      // 确定性错误（ENOENT/EXDEV/ENOSPC…）：重试只会拖慢失败，立即抛
      if (!RENAME_RETRY_CODES.has(String(e && e.code || ''))) throw e
      if (i === attempts - 1) break
      // 退避递增（封顶 200ms）：避免高频硬撞同一个锁
      sleepImpl(Math.min(baseDelayMs * (i + 1), 200))
    }
  }
  throw lastErr || new Error('rename failed')
}

/**
 * 原子写入文本。成功返回写入字节数（便于调用方核对）；失败**抛错**且保证目标文件未被改动。
 *
 * 失败时抛错而不是"回退成普通写入"：普通写入正是本函数要消灭的东西，
 * 回退等于"看着安全、真出事时半截文件"——比直接失败更危险。
 *
 * @param {string} absPath 目标文件
 * @param {string|Buffer} content
 * @param {object} [opts]
 * @param {number} [opts.mode] 文件权限（如密码库要求 `0o600`）。POSIX 生效；Windows 忽略。
 *   ★ 2026-10-18 新增：`electron/vault.cjs` 用它保证密码库文件 0600，没有这个参数就没法迁移过来。
 */
export function writeFileAtomicSync(absPath, content, opts = {}) {
  const dir = dirname(absPath)
  mkdirSync(dir, { recursive: true })
  const mode = Number.isInteger(opts.mode) ? opts.mode : undefined
  const tmp = join(dir, `${TMP_PREFIX}${process.pid}-${randTag()}-${basename(absPath)}`)
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf-8')
  let fd = null
  try {
    fd = mode === undefined ? openSync(tmp, 'w') : openSync(tmp, 'w', mode)
    if (buf.length) writeSync(fd, buf, 0, buf.length, 0)
    fsyncSync(fd)      // 见文件头第 2 点：必须在 rename 之前
    closeSync(fd)
    fd = null
  } catch (e) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关或已失效 */ } }
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不该掩盖原始错误 */ }
    throw e
  }
  try {
    // 同一文件系统内的目录项替换 = 原子（要么旧要么新，不存在半截）
    // ★ 2026-10-18：改用 renameWithRetrySync —— Windows 上目标文件正被读句柄打开时
    //   rename 会偶发 EPERM（实测 1.7%），本文件被知识库写入/配置保存等多处使用，
    //   静默失败会让"保存成功"变成"其实没写进去"。详见 RENAME_RETRY_CODES 的注释。
    renameWithRetrySync(tmp, absPath)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 同上 */ }
    throw e
  }
  // ★ POSIX：rename 不继承 tmp 的 mode（新文件按 umask 建），显式再设一次以保证密码库 0600
  if (mode !== undefined) {
    try { chmodSync(absPath, mode) } catch { /* Windows 上多为 no-op；失败不影响机密性 */ }
  }
  return buf.length
}

/** 临时文件名的判定（供清理残留 / 目录遍历跳过使用，与写入端同源） */
export function isAtomicTmpName(name) {
  return String(name ?? '').startsWith(TMP_PREFIX)
}

/**
 * 清理某目录下的**残留临时文件**（上一次进程被强杀时留下的）。
 *
 * 只在明确知道"该目录此刻不该有活跃写入"时调用（当前用于知识空间目录被重新扫描前）。
 * 不按 mtime 判断新旧：进程被杀的临时文件可能刚刚生成，而按时间阈值清理会把并发写入
 * 正在使用的临时文件删掉 —— 那会把一次成功写入变成失败（rename 时源已不存在）。
 */
export function cleanupAtomicTmpSync(dir) {
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!isAtomicTmpName(name)) continue
      try { rmSync(join(dir, name), { force: true }); removed += 1 } catch { /* 忽略：可能是别处正在写 */ }
    }
  } catch { /* 目录不存在/不可读 → 无残留可清 */ }
  return removed
}
