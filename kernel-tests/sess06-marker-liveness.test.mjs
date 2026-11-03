// SESS-06 修复验证（P2）：运行 marker 无 pid 存活校验、无启动清扫 ⇒ 误报恢复 + 残留堆积。
//
// 【缺陷实况（kernel/cli.mjs 启动段）】
//   ```js
//   if (existsSync(marker)) { ... wire.system('crash_recovered', { sessionId }) }
//   ```
//   只判断"文件存在"，然后**无条件**当作"上次非优雅退出（崩溃）"。两个后果：
//
//   ① **误报恢复**：进程被**带外杀死**（任务管理器 / SIGKILL / 断电）时 marker 自然残留 ——
//      那是正常的、可解释的；但脚本/CI 也可能只是**并行开了第二个实例**（同 sessionId），
//      此时"上次崩溃"是**假信号**，会误导排障方向。
//   ② **残留无限堆积**：marker 按 sessionId 命名，启动**只清自己这一个**。
//      其它 session 的孤儿 marker（对应进程早已不存在）会永远躺在 runs/ 里，
//      越积越多且再也无人读 —— 用户看到 runs 目录一堆 .running 会以为"还在跑"。
//
// 【修法】
//   · 读 marker 时校验 `prev.pid` 是否**仍存活**：存活 ⇒ 明确提示"可能有另一个实例在跑"
//     （而不是说"崩溃"），且**不发** crash_recovered（假信号比没信号更害）；
//   · 启动时**清扫** runDir 下 pid 已不存活的孤儿 marker，并把数量报到日志/返回里。
//
// ★ 诚实记录一个已知局限：pid 可能被系统复用（旧 marker 的 pid 恰好被新进程占用），
//   此时无法仅凭 pid 判断"是不是同一个进程"。彻底解决需要记录进程启动时间（Windows 上
//   可用 CreationTime），本次不做 —— 成本高于收益，且误判方向是"更保守"（不误报崩溃）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = readFileSync(new URL('../kernel/cli.mjs', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

test('★ SESS-06：读 marker 时必须校验 pid 是否仍存活', () => {
  // 定位 marker 的 crash 判定块
  const i = SRC.indexOf('previous run crashed')
  assert.ok(i > -1, '必须有"上次运行崩溃"的判定点')
  const block = SRC.slice(Math.max(0, i - 2000), i + 600)

  assert.match(block, /isPidAlive|pidAlive|kill\(\s*prev\.pid|kill\(\s*pid/,
    '必须校验 prev.pid 是否仍存活 —— 只判断"文件存在"会把带外杀死/并行实例都当成"崩溃"，'
    + '假信号比没信号更害（会把排障引到错误方向）')
})

test('★ SESS-06：pid 仍存活时不得发 crash_recovered（那是假信号）', () => {
  const i = SRC.indexOf('crash_recovered')
  assert.ok(i > -1, '必须有 crash_recovered 事件')
  const block = SRC.slice(Math.max(0, i - 1600), i + 300)
  // crash_recovered 必须处于"pid 不存活"的分支内
  assert.match(block, /if\s*\(\s*!?\s*(isPidAlive|pidAlive)/,
    'crash_recovered 必须只在"pid 已不存活"时才发 —— 否则并行实例会触发假的崩溃恢复提示')
})

test('★ SESS-06：启动时必须清扫 runDir 下的孤儿 marker', () => {
  // 必须有扫描 runs 目录并清理非存活 pid 的逻辑
  assert.match(SRC, /sweep|清扫|cleanStale|清理.*marker|orphan/i,
    '启动时必须清扫孤儿 marker —— 否则其它 session 的 .running 文件会永远留在 runs/ 里，'
    + '越积越多且无人读，用户会以为"还在跑"')
  // ★ 不锁死形参名（用 dir 还是 runDir 是实现自由）；要守的是"真的扫描了目录"
  const sweepIdx = SRC.search(/function sweepStaleMarkers|const sweepStaleMarkers/)
  assert.ok(sweepIdx > -1, '必须有 sweepStaleMarkers 实现')
  const sweepBody = SRC.slice(sweepIdx, sweepIdx + 1200)
  assert.match(sweepBody, /readdirSync\(/,
    '清扫必须真的扫描目录（不能只清自己那一个文件名）')
})

test('★ SESS-06：pid 存活检查必须把 EPERM 视为"存活"（不能误判）', () => {
  const i = SRC.indexOf('isPidAlive')
  assert.ok(i > -1, '必须有 isPidAlive 实现')
  const block = SRC.slice(i, i + 900)
  assert.match(block, /EPERM/,
    'process.kill(pid, 0) 抛 EPERM 表示"进程存在但无权限" —— 必须当作**存活**。'
    + '漏了它会把别的用户的进程误判成已死，进而误清 marker')
  assert.match(block, /ESRCH/,
    '只有 ESRCH（找不到进程）才能判定为"已死"')
})

test('★ SESS-06：清扫必须只删 marker，不得误删其它运行数据', () => {
  const i = SRC.indexOf('sweep') >= 0 ? SRC.indexOf('sweep') : SRC.indexOf('readdirSync(runDir')
  const block = SRC.slice(Math.max(0, i - 400), i + 1400)
  assert.match(block, /\.running/,
    '清扫只应针对 `.running` marker 文件 —— 不能顺手删目录里其它东西')
})
