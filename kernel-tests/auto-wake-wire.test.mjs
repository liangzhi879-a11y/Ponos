// 接线对账（2026-09-21 长任务可靠性 P0 Task 4）。
//
// 两件必须钉住的事：
// ① cli 的唤醒必须**复用** kernel/auto-wake.mjs 的判定与文本构造 —— 不许在 cli 里另写一套
//    阈值/文案（否则两处漂移，改了纯函数却不生效）。
// ② 唤醒必须**显式拉起** handleUser —— 只调 engine.queueNext() 时，消息由 handleUser 的
//    finally 兜底消费（轮末 drainNextPending），而轮次已结束时不会再跑 finally
//    ⇒ 消息永远躺在 pendingNext 里没人处理（"注入了但没人动"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cliSrc = readFileSync(join(here, '..', 'kernel', 'cli.mjs'), 'utf8')
const cfgSrc = readFileSync(join(here, '..', 'kernel', 'engine-config.mjs'), 'utf8')

/** 取 onBackgroundFinished 的实现片段（只截首段，避免跨函数误匹配） */
function wakeSeg() {
  const i = cliSrc.indexOf('function onBackgroundFinished')
  assert.ok(i > 0, 'cli.mjs 应定义 onBackgroundFinished（后台完成唤醒入口）')
  return cliSrc.slice(i, i + 3000)
}

test('cli 从 auto-wake.mjs 引入判定与文本构造（不另写阈值）', () => {
  assert.match(cliSrc, /from '\.\/auto-wake\.mjs'/, '应 import auto-wake.mjs')
  assert.match(cliSrc, /shouldAutoWake\(/, '应调用 shouldAutoWake 判定')
  assert.match(cliSrc, /buildWakeText\(/, '应调用 buildWakeText 构造注入文本')
})

test('cli 唤醒注入标 systemInjection（D6：展示层静默，不产生用户气泡）', () => {
  assert.match(wakeSeg(), /systemInjection: true/, '注入必须标 systemInjection')
})

test('cli 唤醒显式拉起下一轮（handleUser），不只依赖轮末兜底', () => {
  assert.match(wakeSeg(), /handleUser\(/, '空闲内核必须被显式拉起')
})

test('cli 唤醒带合并窗口（防多个后台任务连环唤醒刷屏）', () => {
  assert.match(wakeSeg(), /WAKE_MERGE_WINDOW_MS/, '应使用合并窗口常量')
})

test('预算重置只在真用户消息上（systemInjection 插话不得重置，防自我延续）', () => {
  assert.match(cliSrc, /if \(msg\?\.systemInjection !== true\) wakeUsed = 0/, '应在 handleUser 中按 systemInjection 区分重置')
})

test('engine-config 暴露 AUTO_WAKE_MAX（env 可调、默认 5、支持 0 关闭）', () => {
  assert.match(cfgSrc, /PONOS_AUTO_WAKE_MAX/, '应支持 PONOS_AUTO_WAKE_MAX')
  assert.match(cfgSrc, /export const AUTO_WAKE_MAX = envNonNeg\('PONOS_AUTO_WAKE_MAX', 5\)/, '默认 5 且走 envNonNeg（0 有效）')
})

test('唤醒回调已接入 createEngine（否则永不触发）', () => {
  assert.match(cliSrc, /onBackgroundFinished,/, 'opts 中应传入 onBackgroundFinished')
})
