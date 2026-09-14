// server/loop-translate.mjs —— GUI → 内核 /loop 指令转译（打通点，spec 5.5）
// ---------------------------------------------------------------------------
// 背景：GUI（ScheduleGuide / 用户手输）发的是**纯文本** `/loop 10m <任务>`，而内核
// cli.mjs 无斜杠指令解析 → 该文本被当作普通 prompt 交给模型，loop 状态机永不启动
// （断链根因，2026-09-14 修复）。
// 本模块在 bridge 的 GUI send 热路径前置拦截并转译为内核原生载荷：
//   start 形式 → { type:'user', message, loop:{…} }（走内核既有 loop 通道）
//   指令族     → { type:'loop_command', op, args }（走 Task4 新增路由）
// 解析复用 kernel/loop-commands.mjs（纯函数、零 IO、无副作用 → 直 import 安全）。
import { parseLoopDirective } from '../kernel/loop-commands.mjs'

/**
 * GUI 文本 → 内核载荷（纯函数：无 IO、无进程/会话依赖、无副作用）。
 * @param {string} content GUI 发来的原始文本
 * @returns {null | { type:'user', message:{role:'user',content:string}, loop:object }
 *                 | { type:'loop_command', op:string, args:string[] }}
 *   null ⇒ 非 /loop 文本或解析异常：调用方必须按**原路径逐字直通**（零回归锁②，
 *   绝不吞用户输入）。解析异常一律折叠为 null（转译层永不抛给发送热路径）。
 */
export function translateLoopSend(content) {
  let d = null
  try { d = parseLoopDirective(content) } catch { d = null } // 解析异常 = 非指令（直通）
  if (!d) return null
  if (d.kind === 'op') return { type: 'loop_command', op: d.op, args: d.args }
  const o = d.opts
  return {
    type: 'user',
    message: { role: 'user', content: o.prompt || o.goal || o.until || '' },
    loop: {
      count: o.count, until: o.until, everyMs: o.everyMs, fresh: o.fresh,
      goal: o.goal, doneWhen: o.doneWhen,
      maxCostUsd: o.maxCostUsd, maxSteps: o.maxSteps, maxWallMs: o.maxWallMs,
    },
  }
}
