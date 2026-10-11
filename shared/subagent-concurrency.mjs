// 子代理并发上限的**策略纯函数**（第 10 项，2026-09-17）。
//
// 为什么放在 shared/ 而不是 server/bridge.mjs：bridge.mjs 是**入口模块**（import 即起
// 服务器、会 bind 端口），测试无法安全 import 它取纯函数——实测直接 import 会去 bind
// 运行中应用的 51517，若应用没开就会真起一个桥（危险）。策略放这里，桥与内核各自引用，
// 单测直接跑纯函数，无需起任何进程。
//
// 三值语义（桥、内核、前端三处必须一致）：
//   null → **自动**：不注入 env，内核按系统配置推导（推荐默认）
//   0    → **不限**：与内核 PONOS_LANE_MAX_CONCURRENT 的 0 语义一致
//   N>0  → 并发上限（取整并 clamp 到 [1, 32]）
// 注意"自动"刻意不用 0 表示——0 在内核里是"不限"，混用会直接改变行为。

/** 并发上限的硬上界：再大既无实际收益，也会同时向模型 API 打出过多请求。 */
export const MAX_SUBAGENTS_CAP = 32

/**
 * 归一子代理并发上限配置值。
 * @param {unknown} v 配置值（可能来自旧 config.json、表单字符串或非法输入）
 * @returns {number|null} null=自动（不注入 env）；0=不限；正整数=上限
 */
export function normalizeMaxSubAgents(v) {
  if (v === null || v === undefined || v === '' || v === 'auto') return null
  // 只接受数字与数字串：数组/对象/布尔等一律退回"自动"。
  // 为什么要显式挡：`Number([]) === 0`、`Number(true) === 1`，宽松转换会把非法输入
  // 变成"不限"或"上限 1"——两种都是危险的方向（前者打爆 API，后者静默串行）。
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n <= 0) return 0
  return Math.min(MAX_SUBAGENTS_CAP, Math.max(1, Math.floor(n)))
}

/**
 * 按系统配置推导默认并发上限（第 10 项"默认根据系统配置设置最大并发值"）。
 * clamp 到 [2, 8]：下限 2 保证"并发"这件事本身可用（1 即串行、失去意义）；
 * 上限 8 防止在超大核机器上把模型 API 打爆（并发子代理会同时发请求）。
 * 探测失败退回旧的固定值 4，保证行为可预期。
 * @param {number} cores 本机可用并行度（由调用方探测后传入，便于测试）
 */
export function defaultLaneConcurrency(cores) {
  const n = Number(cores)
  if (!Number.isFinite(n) || n < 1) return 4
  return Math.max(2, Math.min(8, Math.floor(n) - 1))
}
