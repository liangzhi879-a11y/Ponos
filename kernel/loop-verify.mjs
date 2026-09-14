// kernel/loop-verify.mjs —— loop 完成条件双层验证器（spec 3.2）
// ---------------------------------------------------------------------------
// 第一层「命令式验真」：确定性最高，逐条执行 expect 退出码（默认 0）。
//   **必须经 engine.tools.run({name:'Bash'})** —— 验真命令同样受五段式执行管线
//   （白名单 → 权限/审批 → 频率 → Schema → 有界重试）与审计约束，禁止自建 spawn 绕过。
//   退出码基准：Bash 工具以 isError = (code !== 0) 表达（kernel/tools.mjs:134-137）。
// 第二层「LLM 判词」：命令层全过后才调用（省预算），判定必须 done === true 才通过。
// 任一层异常/超时 → 该条不通过（fail-closed：绝不把"验证失败"当"已达成"）。
const DEFAULT_CMD_TIMEOUT_MS = 120_000

async function withTimeout(p, ms, onTimeout) {
  if (!ms || ms <= 0) return p
  let timer = null
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(onTimeout || `超时（${ms}ms）`)), ms) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * @param {Array<{type:'cmd',run:string,expect?:number,timeoutMs?:number}|{type:'judge',text:string}>} doneWhen
 * @param {{ tools:any, judge:(o:{target:string})=>Promise<{done:boolean,reason?:string}>, signal?:any, timeoutMs?:number }} deps
 * @returns {Promise<{passed:boolean|null, results:Array, reason:string}>}
 */
export async function verifyDoneWhen(doneWhen = [], deps = {}) {
  const { tools, judge, timeoutMs = DEFAULT_CMD_TIMEOUT_MS } = deps
  const specs = Array.isArray(doneWhen) ? doneWhen.filter(Boolean) : []
  if (!specs.length) return { passed: null, results: [], reason: '未配置完成条件' }
  const results = []
  for (const spec of specs) {
    const t0 = Date.now()
    if (spec.type === 'cmd') {
      try {
        const r = await withTimeout(
          tools.run({ name: 'Bash', input: { command: String(spec.run) } }, {}),
          Number(spec.timeoutMs) || timeoutMs,
          `验真命令超时：${spec.run}`,
        )
        // Bash 工具只以 isError 表达「退出码是否为 0」（无原始退出码，见 kernel/tools.mjs
        // 的 finish(content, isError)），因此仅支持 expect === 0（缺省）；显式要求非 0
        // 退出码无法判定 → fail-closed，不猜。
        const expect = spec.expect === undefined ? 0 : Number(spec.expect)
        const ok = expect === 0 ? r?.isError !== true : false
        results.push({ spec, type: 'cmd', run: spec.run, ok, ms: Date.now() - t0, output: String(r?.content ?? '').slice(0, 400) })
        if (!ok) {
          const why = expect !== 0 ? `不支持自定义退出码（expect=${expect}，Bash 工具仅暴露 0/非 0）` : `退出码非 0：${String(r?.content ?? '').slice(0, 200)}`
          return { passed: false, results, reason: `命令未通过：${spec.run} → ${why}` }
        }
      } catch (e) {
        results.push({ spec, type: 'cmd', run: spec.run, ok: false, ms: Date.now() - t0, reason: e?.message || String(e) })
        return { passed: false, results, reason: `命令执行异常：${spec.run} → ${e?.message || String(e)}` }
      }
    } else if (spec.type === 'judge') {
      try {
        const j = await withTimeout(judge({ target: String(spec.text) }), timeoutMs, `判词超时：${spec.text}`)
        const ok = j?.done === true
        results.push({ spec, type: 'judge', ok, ms: Date.now() - t0, reason: String(j?.reason ?? '') })
        if (!ok) return { passed: false, results, reason: `判词判定未达成：${j?.reason || spec.text}` }
      } catch (e) {
        results.push({ spec, type: 'judge', ok: false, ms: Date.now() - t0, reason: e?.message || String(e) })
        return { passed: false, results, reason: `判词异常：${e?.message || String(e)}` }
      }
    } else {
      results.push({ spec, type: String(spec.type || 'unknown'), ok: false, ms: Date.now() - t0, reason: '未知条件类型' })
      return { passed: false, results, reason: `未知条件类型：${spec.type}` }
    }
  }
  return { passed: true, results, reason: '全部完成条件通过' }
}
