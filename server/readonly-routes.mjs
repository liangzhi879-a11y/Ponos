// server/readonly-routes.mjs —— 内核只读聚合（用量 / 审计）（P1 批次 2 迁出）
// ---------------------------------------------------------------------------
// 为什么单独一个模块、而**不**和 auth-routes 放一起：两者性质完全不同。
//   · auth-routes 是"身份面"（写口令、写档案），安全敏感、有状态；
//   · 本模块是"只读聚合面"（跑内核 `--usage` / `--audit` 子进程并按 TTL 缓存），
//     性能敏感、有缓存。
// 混放会让"安全复核"与"性能调优"互相干扰——要看的东西不在一个关注点上。
//
// 迁出时**逐字保留**了原实现里的三段关键设计（都在下方注释里，不要精简掉）：
//   1. **异步 spawn**（K2.1）：原为 execFileSync，实测把桥的事件循环堵住 10.8–19.6s，
//      期间全部 WS 帧/HTTP 响应/控制请求一起停摆。异步化后**创造了并发**（同步版天然串行），
//      故同参请求由 kernelReadonly 内部单飞合并。
//   2. **桥侧 TTL + stale-while-revalidate**（K2.2）：全量聚合要 10.8–19.6s，而缓存命中
//      是**零扫描**。三种非失败态：fresh（命中且新）/ stale（命中但旧：立即回旧值 + 后台刷新）
//      / computing（冷启动未就绪：立刻 503，刷新留后台跑完 ⇒ 下次轮询即有值）。
//   3. **503 与 502 的区分**：computing 是"还没算好"（503，调用方重试即可），
//      failed 才是真失败（502）。
import { createReadonlyCache } from './readonly-cache.mjs'
import { kernelReadonly } from './kernel-readonly.mjs'

const READONLY_PATHS = new Set(['/api/usage', '/api/audit'])

/** 本模块认领的路径 */
export function isReadonlyPath(pathname) {
  return READONLY_PATHS.has(pathname)
}

// 单例**懒建**是刻意的（原实现有同名注释，勿改成立即求值）：
//   一是 TTL 来自环境变量 PONOS_USAGE_CACHE_TTL_MS，而 env 可能在模块求值之后才被上层补齐
//   （内核侧 perf.mjs 踩过同一个坑：cli.mjs 的 settings.env 注入晚于所有 ESM 求值）；
//   二是本进程若只是被测试 import 而没起服务，也不该白建一份状态。
let _readonlyCache = null
function getReadonlyCache() {
  if (_readonlyCache) return _readonlyCache
  const ttlMs = Number(process.env.PONOS_USAGE_CACHE_TTL_MS) || undefined
  _readonlyCache = createReadonlyCache({
    ttlMs: ttlMs || 10_000,
    // 后台刷新失败**只记日志**：绝不能外抛（未处理的 rejection 会掀掉整个桥），
    // 也绝不能让本次请求失败——本次已回旧值，用户无感。
    onWarn: (m) => { try { console.error(`[bridge][readonly] ${m}`) } catch { /* 日志失败不影响响应 */ } },
  })
  return _readonlyCache
}

/**
 * 处理只读聚合端点；不由本模块负责时返回 null。
 *
 * @param {object} p
 * @param {string} p.pathname
 * @param {URLSearchParams} p.searchParams
 * @param {() => NodeJS.ProcessEnv} p.buildChildEnv  桥的子进程环境构造器（**按引用**传入：
 *        它每次调用都重读 config，传求值结果会让配置改动不再生效）
 * @param {Function} [p.runner]  测试注入口：默认 `kernelReadonly`（生产不传）。
 *        本模块自身值得测的是**参数拼装与状态码映射**（computing→503 / failed→502 / 正常→raw 透传），
 *        而这三件事都不需要真起内核子进程——单测里 spawn 内核既慢又违反本仓库"单测不起内核"的纪律，
 *        故留这个窄口子；语义不因此改变（断言的是装配逻辑，内核行为由 kernel-readonly 自己的测试覆盖）。
 * @param {{get: Function}} [p.cache]  测试注入口：默认懒建的只读缓存单例（生产不传）
 * @returns {Promise<{status:number,body:any,raw?:boolean}|null>}
 *   `raw:true` 时 body 是已就绪字符串（内核聚合结果是原样透传的 JSON 文本，不二次 stringify）
 */
export async function handleReadonlyRoute({ pathname, searchParams, buildChildEnv, runner = kernelReadonly, cache }) {
  if (!isReadonlyPath(pathname)) return null

  const sub = pathname === '/api/usage' ? '--usage' : '--audit'
  const flags = []
  for (const k of ['scope', 'sessionId', 'project', 'from', 'to']) {
    const v = searchParams.get(k)
    if (v) flags.push(`--${k}`, v)
  }
  // 键 = 子命令 + 全部影响结果的 flags。env **不必**入键：buildChildEnv() 每次重读 config，
  // 但其中唯一影响聚合结果的是 PONOS_CONFIG_DIR ← YFW_HOME，而它是模块级常量（进程内恒定）；
  // 其余注入项（provider / effort / 日志等级）只作用于会话运行，不改历史记录。
  // 将来若 YFW_HOME 变成可热改，这里必须一并入键。
  const t0 = Date.now()
  const key = `${sub}|${flags.join(' ')}`
  const got = await (cache || getReadonlyCache()).get(key, () => runner([sub, ...flags], { env: buildChildEnv(), cwd: process.cwd() }))
  const ms = Date.now() - t0

  if (got.state === 'computing') {
    try { console.error(`[bridge][readonly] ${sub} ms=${ms} COMPUTING(cold) args=${flags.join(' ') || '-'}`) } catch { /* 日志失败不影响响应 */ }
    return { status: 503, body: { error: '用量聚合首次计算中，请稍后重试' } }
  }
  if (got.state === 'failed') {
    const msg = got.error?.message || String(got.error)
    try { console.error(`[bridge][readonly] ${sub} ms=${ms} FAILED args=${flags.join(' ') || '-'}: ${msg}`) } catch { /* 日志失败不影响响应 */ }
    return { status: 502, body: { error: msg } }
  }
  try {
    console.error(`[bridge][readonly] ${sub} ms=${ms} ${(got.payload || '').length}B state=${got.state} args=${flags.join(' ') || '-'}`)
  } catch { /* 日志失败不影响响应 */ }
  // 内核已在子进程侧完成序列化；**原样透传**避免二次 stringify（大 payload 下纯属浪费 CPU）
  return { status: 200, body: got.payload, raw: true }
}
