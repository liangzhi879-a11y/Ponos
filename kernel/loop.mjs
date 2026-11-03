// kernel/loop.mjs —— loop 运行时控制器（spec 3.3/3.4/5.3）
// ---------------------------------------------------------------------------
// 职责：loop 状态机（次数/until/every/fresh）·预算硬停·无进展升级·状态持久化·指令族。
// 边界（安全短路序，spec 3.4）：预算/无进展**先于**验证器判定 —— 防止"验证器反复失败
// → 无限重试烧钱"。所有方法幂等 + 静默降级：任何异常都不得中断主 loop（沿用 health 风格）。
// 持久化：<configDir>/loop/<sessionId>.json（原子写 tmp+rename）；只存控制面，不存对话。
// 并入对账（2026-10-09 四条线合并）：execFile = 主干 f857d6a9 异步版 snapshot 的
// `git rev-parse`（真异步，防阻塞事件循环）；execFileSync = 分支 P1-3 applyPendingRollback
// 的 `git stash/reset`（审批后的安全铁律流，必须同步走到位）。两侧都要，缺一即运行时红。
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diskWrite, getDiskTelemetry } from './disk-write.mjs'
// ★ 2026-10-18：rename 带瞬时错误重试 —— Windows 上目标文件正被读句柄打开时
//   rename 会偶发 EPERM（实测 1.7%），而 persist 失败会让磁盘长期停在旧状态、
//   循环的 nextRunAt 永远是 0 ⇒ 内核被回收后主管无法唤醒（断点续跑静默失效）。
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import { costOf } from './cost.mjs'
import { formatLoopReplay, formatLoopStatus } from './loop-commands.mjs'
import { verifyDoneWhen } from './loop-verify.mjs'

const SCHEMA_VERSION = 1
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'budget_exceeded', 'no_progress', 'stalled'])
// wire `loop` 帧 end.reason 为封闭集合（零回归锁③：旧 GUI 按枚举解析）；自由文本原因只入 state.endReason
const END_REASONS = new Set(['completed', 'until_hit', 'cancelled', 'judge_error', 'verify_hit', 'budget_exceeded', 'no_progress', 'failed'])

// ★ 并入对账（2026-10-09 四条线合并）：参数须显式 JSDoc 声明 —— checkJs 对解构参数只从
//   默认值反推类型（wire/engine 无默认值 ⇒ 访问即 TS2339；其余属性虽从默认值推断成
//   更窄的类型，一律按 any 登记以零级联）。纯注解，零运行时变化。
/**
 * @param {object} [opts]
 * @param {any} [opts.wire]      帧出口（loop/status/warning 等；缺省静默）
 * @param {any} [opts.engine]    引擎接口（queueNext/judgeUntil/setFreshWindow 等）
 * @param {any} [opts.store]
 * @param {string} [opts.configDir]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.cwd]
 * @param {any} [opts.env]
 * @param {any} [opts.prices]    注入单价（resolveModelPrices 结果；null = 内置默认）
 */
export function createLoopController({ wire, engine, store = null, configDir = '', sessionId = '', cwd = '', env = process.env, prices: pricesIn = null } = {}) {
  const file = join(configDir, 'loop', `${sessionId}.json`)
  // 单价来源（P1-2）：cli 传入 resolveModelPrices() 的结果（provider > 内置价表 > 估算）。
  // 未注入时保持改前行为：env 硬编码默认（零回归）。
  //
  // 审查缺陷（T2-FIX 缺陷 1）：原先只校验 pricePerMInput，注入 `{pricePerMInput:10, source:'provider'}`
  // 这类**缺字段**的价会被采纳 → pricePerMOutput/cacheReadRatio = NaN → costOf 返回 NaN →
  // costUsd = NaN、帧上 costUsd = null，且 `NaN > maxCostUsd` 恒为 false ⇒ **预算硬停静默失效**
  //（钱数不设上限）。修法：三字段齐备才采纳注入值；任一不合法则**整体回落** env 兜底，
  // 绝不允许"部分注入 + 部分兜底"混用（混用会产生谁都解释不了的单价）。
  //
  // 宽幅审查缺陷 3（加固补全）：仅用 `Number.isFinite(Number(x))` 仍不够 —— `Number(null) === 0`
  // 且 `isFinite(0) === true`，故注入 `{pricePerMInput:null, pricePerMOutput:null,
  // cacheReadRatio:null, source:'provider'}` 会被判为"合法"，于是单价**全为 0** →
  // costUsd 恒 0 → `0 > maxCostUsd` 恒 false ⇒ 预算硬停**再次静默失效**（与缺陷 1 同类危害）。
  // 故先要求原始值本身"真的给了数"（number 或非空数值字符串；null/undefined/''/布尔/对象一律算未提供），
  // 且输入/输出 > 0（与 kernel/model-prices.mjs 的 posNum 同源：0 视为未配置，避免 0 成本让硬停失效），
  // 缓存比例 >= 0（0 是合法语义：缓存读不折扣）。
  const numField = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null }
    return null
  }
  const inP = numField(pricesIn?.pricePerMInput)
  const outP = numField(pricesIn?.pricePerMOutput)
  const ratioP = numField(pricesIn?.cacheReadRatio)
  const pricesOk = !!pricesIn && inP !== null && inP > 0 && outP !== null && outP > 0 && ratioP !== null && ratioP >= 0
  // ★ 2026-10-09 并入对账（P0-5 × P1-2）：写入溢价（P0-5）只走 env 旋钮（resolveModelPrices
  //   不提供 cache_write 单价）——注入与回落两侧都必须带上该字段，否则 costOf 拿不到 env 值、
  //   溢价旋钮被静默旁路（默认 1.25 = Anthropic 5 分钟档；1 小时 TTL 传 2）。
  const cacheWriteRatio = Number(env.PONOS_PRICE_CACHE_WRITE_RATIO) || 1.25
  const prices = pricesOk
    ? { pricePerMInput: inP, pricePerMOutput: outP, cacheReadRatio: ratioP, cacheWriteRatio }
    : {
        pricePerMInput: Number(env.PONOS_PRICE_PER_M_INPUT) || 0.2,
        pricePerMOutput: Number(env.PONOS_PRICE_PER_M_OUTPUT) || 1.2,
        cacheReadRatio: Number(env.PONOS_CACHE_READ_RATIO) || 0.1,
        cacheWriteRatio,
      }
  // 审查缺陷（T2-FIX 缺陷 2）：priceSource 原先与价字段校验**相互独立** —— 注入 `{source:'provider'}`
  // （无任何价格）会标成 'provider'，而数字其实是 env/硬编码估算值（"假精度误导"）。
  // 修法：两者同源判定 —— 只有**采纳了注入价**时才取注入的 source，否则一律 'estimate'。
  const priceSource = pricesOk && pricesIn.source ? String(pricesIn.source) : 'estimate'
  const noProgressN = Math.max(1, Number(env.PONOS_LOOP_NOPROGRESS_N) || 3)
  const onStall = String(env.PONOS_LOOP_ON_STALL || 'reflect_and_ask')
  let persistWarned = false
  let verifyImpl = (doneWhen, deps) => verifyDoneWhen(doneWhen, deps)

  let state = freshState()
  function freshState() {
    return {
      version: SCHEMA_VERSION, status: 'idle', goal: '', doneWhen: [], prompt: '',
      // until 参与持久化：--until 的判词达成即停由**控制器**在 nextDecision 内执行
      // （P1-5 收口），目标必须落盘，否则 --resume 恢复后停止条件丢失
      //（会退化为按次数/预算收尾）。
      until: '',
      index: 0, count: null, everyMs: 0, fresh: false,
      budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
      usageAcc: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      costUsd: 0, steps: 0, priceSource,
      noProgress: { streak: 0, lastFingerprint: '', threshold: noProgressN },
      onStall, injections: [],
      startedAt: '', updatedAt: '', endedAt: '', endReason: '',
      // 调度字段（spec §3.2）：nextRunAt = 下次该跑的时刻（持久语义，bridge 主管据此唤醒）；
      // aliveAt = 内核最近一次心跳。二者只由内核写（单写者原则）。
      // nextRunAt 语义：0/缺失 = 无待触发（已完成/已暂停/待审批/正在跑都不该被主管唤醒）；
      // 只有 running 且处于「等下次触发」窗口才写未来时间戳。
      nextRunAt: 0, aliveAt: '',
      history: [], pendingApproval: null, snapshotRef: '',
    }
  }

  // —— 持久化（原子写；失败静默但提示一次，绝不阻断循环） ——
  function persist() {
    // disk-site: loop-state —— 状态变化时偶发落盘（tmp+rename 原子写）。
    // 【为何把 mkdir 也包进来】：原 try 覆盖 mkdir+write+rename，mkdir 失败同样走"提示一次"；
    // 若只包 write+rename，mkdir 的失败会从包装外逸出成未捕获异常 ⇒ 行为改变。
    const w = diskWrite(getDiskTelemetry(), 'loop-state', () => {
      state.updatedAt = new Date().toISOString()
      state.aliveAt = state.updatedAt // 心跳随每次落盘刷新（主管据此判"内核是否还活着"）
      // ★★ 2026-10-18：改用 writeFileAtomicSync（它 **fsync 后 rename** + rename 重试 + 失败清理）。
      //
      // 原来是手写 `writeFileSync(tmp) + renameSync`，两个缺口：
      //   ① **无 fsync** ⇒ 断电/蓝屏时 rename 可能先于数据落盘被持久化（ext4 延迟分配、
      //      Windows 写缓存）⇒ 新文件是空的或半截。`shared/atomic-write.mjs` 文件头明确
      //      写着"必须 fsync 文件再 rename"，但本处一直没照做（全仓 19+ 处手写版本都这样）。
      //      后果与 ENG-11 同族：`nextRunAt` 丢了 ⇒ 桥主管不会唤醒 ⇒ 断点续跑静默失效。
      //   ② rename 无重试 ⇒ Windows 上被读句柄占用时偶发 EPERM（ENG-11 已实测 1.7%）。
      // 目录创建也交给它（mkdirSync recursive），故上面不再单独 mkdir。
      writeFileAtomicSync(file, JSON.stringify(state, null, 2))
    })
    if (!w.ok) {
      // 既有语义逐字保留：失败静默但**提示一次**（文案一字未改），只是"出错"的来源改为 !w.ok
      if (!persistWarned) {
        persistWarned = true
        try { wire?.warning?.({ level: 'loop_persist', message: 'loop 状态落盘失败（磁盘不可写？），断点续跑能力不可用' }) } catch { /* 静默 */ }
      }
    }
    return w.ok
  }

  function emit(state_, data = {}) { try { wire?.loop?.(state_, data) } catch { /* 事件失败不阻断 */ } }

  function fingerprintOf(outcome) {
    const d = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    // ★ 本轮无工具调用 ⇒ 指纹**为空串**（2026-11-01）：调用点写着"指纹为空 → 不计无进展"，
    //   但原实现总返回 `${files}|${errs}`（最少 `'|'`）⇒ 那个分支永不可达，而"连续 N 轮无工具"
    //   反而被当成"连续 N 轮指纹相同"直接升级等人工审批。空串语义必须真的成立。
    if (!d.length) return ''
    // 参与签名：`${name}:${path}:${sig}`。sig 缺失（旧内核/未登记类工具）时退化为 `${name}:${path}`
    // —— 与改前逐字一致（零回归）：旧帧下"同路径即无进展"的判定不变。
    const tag = (t) => `${t.name}:${t.path}${t.sig ? `:${t.sig}` : ''}`
    // ★ 不再按"有没有 path"过滤：Bash/Agent/Workflow/Skill/MCP 等执行类工具**恒无 path**，
    //   原过滤把它们全部丢掉 ⇒ "只跑 Bash 的轮次"与"空转轮次"同形（误停）。签名侧已给它们
    //   补了输入哈希（engine#toolSig），这里按"非错误"收全。
    const files = d.filter((t) => !t.isError).map(tag).sort().join(',')
    const errs = d.filter((t) => t.isError).map((t) => `${t.name}:${String(t.errorText || '').slice(0, 60)}`).sort().join(',')
    return `${files}|${errs}`
  }

  // —— 指令族 ——
  function start(opts = {}) {
    state = freshState()
    state.status = 'running'
    state.goal = String(opts.goal || '')
    state.until = String(opts.until || '')
    state.doneWhen = Array.isArray(opts.doneWhen) ? opts.doneWhen : []
    state.prompt = String(opts.prompt || opts.goal || '')
    state.count = opts.count === null || opts.count === undefined ? null : Math.max(1, Number(opts.count) || 1)
    state.everyMs = Number(opts.everyMs) || 0
    state.fresh = opts.fresh === true
    state.budget = {
      maxCostUsd: Number(opts.maxCostUsd) || 0,
      maxSteps: Number(opts.maxSteps) || 0,
      maxWallMs: Number(opts.maxWallMs) || 0,
    }
    state.startedAt = new Date().toISOString()
    state.priceSource = priceSource
    persist()
    emit('start', {
      index: 0, total: state.count, until: String(opts.until || ''), fresh: state.fresh,
      goal: state.goal, everyMs: state.everyMs, budget: state.budget, priceSource: state.priceSource,
      // prompt 必须回传：GUI 排程卡发的是 `/loop --every 5m <任务>`（无 --goal），
      // 若只回传 goal，前端面板/胶囊的"目标"行会空白（看起来像没生效）。
      prompt: state.prompt,
      doneWhen: state.doneWhen.map((d) => d.run || d.text),
    })
    return state
  }

  function isActive() { return state.status === 'running' || state.status === 'pausing' || state.status === 'awaiting_approval' || state.status === 'verifying' }

  function stop(reason = 'cancelled') {
    const wasActive = isActive()
    const frameReason = END_REASONS.has(String(reason)) ? String(reason) : 'cancelled'
    state.status = reason === 'budget_exceeded' ? 'budget_exceeded' : 'cancelled'
    state.endReason = reason
    state.endedAt = new Date().toISOString()
    state.nextRunAt = 0 // 终态不再有待触发的下一轮（防陈旧 nextRunAt 触发无谓复活）
    persist()
    if (wasActive || reason === 'budget_exceeded') emit('end', { reason: frameReason, index: state.index, total: state.count, goal: state.goal, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)) })
    return state
  }

  function pause() {
    if (!isActive()) return state
    state.status = 'pausing' // 当前轮跑完转 paused（轮次边界停，不打断进行中的轮）
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function resume() {
    if (TERMINAL.has(state.status)) return state
    // 人工介入即开新的计数窗口：awaiting_approval 状态下 streak 已达阈值，若不清零，
    // approve 后第一轮指纹照旧 → 立刻再次升级为 awaiting_approval（人工确认等于白点一次）。
    const wasAwaiting = state.status === 'awaiting_approval'
    state.status = 'running'
    state.pendingApproval = null
    if (wasAwaiting) { state.noProgress.streak = 0; state.noProgress.lastFingerprint = '' }
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return state
  }

  function approve() { return resume() }

  function setBudget(patch = {}) {
    for (const k of ['maxCostUsd', 'maxSteps', 'maxWallMs']) {
      if (patch[k] !== undefined) state.budget[k] = Number(patch[k]) || 0
    }
    persist()
    emit('status', { status: state.status, budget: state.budget })
    return state
  }

  function inject(text) {
    const t = String(text ?? '').trim()
    if (!t) return state
    state.injections.push(t)
    persist()
    try { engine?.queueNext?.(t) } catch { /* 注入失败不阻断 */ }
    return state
  }

  function snapshot() {
    // 轻量检查点：记录 git HEAD（回滚目标）；非 git 仓库则跳过（静默）
    // ★ 必须真异步（2026-09-21 失速事故，真异步版）：execFileSync 会**同步阻塞整个事件
    // 循环** —— git 在索引锁争用/磁盘近满/安全软件拦查时可能长时间不返回，一卡就把内核
    // 所有 timer 一起冻住（实测事故：924s 静默期内连 30s 硬看门狗与 100s 心跳都没跑过，
    // 进程零 TCP、CPU delta=0，直到事件循环解冻才触发退出）。
    // 为什么"后台刷新 + 保持同步返回"而不是把本函数改成 async：
    //   · 本函数挂在控制器公开 API 上（见文件末尾 return），改 async 会波及所有调用形态；
    //     而 git rev-parse HEAD 正常只毫秒级 —— 不值得为它改调用契约。
    //   · rollback() 读的是 state.snapshotRef（**不是**本函数的返回值），而它只可能在本
    //     函数之后很久、经人工审批才被调用 ⇒ 那时后台刷新早已落地，回滚点照样有值。
    //   · 读失败（非 git / git 不可用 / 超时）静默跳过，与旧版同一支 —— 无快照可回滚。
    // ★★ windowsHide（2026-09-29）：内核进程由桥启动，而桥**没有控制台**（被 Electron 以
    //   windowsHide 起）⇒ 内核内起子进程若不显式带，Windows 会新建控制台窗口 = 用户看到黑窗。
    //   （windowsHide 不会被继承，每一层都要写；有守卫扫描全仓 spawn 调用点。）
    execFile('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return
      try {
        state.snapshotRef = String(stdout).trim()
        persist()
      } catch { /* 持久化失败不阻断循环 */ }
    })
    return state.snapshotRef
  }

  function rollback() {
    if (!state.snapshotRef) return { ok: false, error: '无可回滚快照（非 git 仓库或尚未打点）' }
    state.pendingApproval = { kind: 'rollback', detail: state.snapshotRef }
    persist()
    emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval })
    return { ok: true, needApproval: true, ref: state.snapshotRef }
  }

  /**
   * 执行待审批的动作（当前只有回滚）。P1-3：修复前 rollback 只登记 pendingApproval
   * 与快照引用，**从不真正执行** —— 用户以为有回滚保护，实则没有。
   *
   * 安全铁律（用户确认策略）：先 `git stash push -u` 保护未提交改动（含未跟踪文件），
   * **成功才** `git reset --hard`。stash 失败即中止回滚，绝不为回滚丢弃用户改动。
   * 仅作用于 git 跟踪范围；非 git 仓库降级报错。
   */
  function applyPendingRollback() {
    const p = state.pendingApproval
    if (!p || p.kind !== 'rollback') return { applied: false }
    const ref = String(p.detail || '')
    // ① 引用形状白名单：git sha 十六进制 7-40 位。避免把任意字符串塞进 git 参数。
    if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      state.pendingApproval = null
      persist()
      return { applied: false, ok: false, error: `快照引用非法，已拒绝执行：${ref}` }
    }
    // ② 保护未提交改动
    let stashMsg = ''
    let stashed = false
    try {
      stashMsg = `yf-loop-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const out = execFileSync('git', ['stash', 'push', '-u', '-m', stashMsg], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      // 宽幅审查缺陷 M-4：工作树本来干净时，`git stash push` 的退出码同样是 0，
      // 但**并未创建任何 stash**（stdout 为 "No local changes to save"）。
      // 此时若照旧回报"回滚前的改动已存入 stash「…」"，用户会去找一个不存在的 stash
      //（`git stash pop` 扑空），属真实的信息误导。故按 git 的实际输出判定是否真创建。
      stashed = !/No local changes to save/i.test(String(out || ''))
    } catch (e) {
      // ③ stash 失败 → 中止（不 reset），不丢用户改动
      state.pendingApproval = null
      persist()
      return { applied: false, ok: false, error: `已取消回滚：改动保护（git stash）失败，为避免丢失未提交改动不执行 reset。${e?.message || ''}`.trim() }
    }
    // ④ 回到快照
    try {
      execFileSync('git', ['reset', '--hard', ref], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      state.pendingApproval = null
      persist()
      const tail = stashed ? `（改动已在 stash「${stashMsg}」中，可用 git stash pop 找回）` : ''
      return { applied: false, ok: false, error: `回滚失败：${e?.message || String(e)}${tail}` }
    }
    state.history.push({
      index: state.index, ts: new Date().toISOString(), usage: null,
      costUsd: Number(state.costUsd.toFixed(4)), steps: 0, toolCount: 0,
      filesChanged: 0, errors: 0, verify: null, judged: false, note: `rollback:${ref}`,
    })
    state.pendingApproval = null
    persist()
    emit('status', { status: state.status, index: state.index, total: state.count })
    return { applied: true, ok: true, ref, stashMsg: stashed ? stashMsg : '' }
  }

  function status() { return { ...state } }
  function formatStatus() { return formatLoopStatus(state) }
  function replay(n = 10) { return formatLoopReplay(state.history, n) }
  function memory() {
    const fails = state.history.filter((h) => h.verify && h.verify.passed === false).length
    const rules = state.injections.length ? `\n人工补充：\n- ${state.injections.join('\n- ')}` : ''
    return `【loop 记忆】目标：${state.goal || state.prompt || '(未设定)'}\n验证失败轮次：${fails}/${state.history.length}\n无进展连续：${state.noProgress.streak}/${state.noProgress.threshold}${rules}`
  }

  /** 下一轮投递载荷（cli 直接入队） */
  function nextPayload(until = '') {
    const extra = state.injections.length ? `\n\n【loop 人工补充】\n- ${state.injections.join('\n- ')}` : ''
    return {
      message: { role: 'user', content: state.prompt + extra },
      loop: { count: state.count, until, fresh: state.fresh, index: state.index },
    }
  }

  async function runVerify() {
    const specs = state.doneWhen.length ? state.doneWhen : (state.goal ? [{ type: 'judge', text: state.goal }] : [])
    if (!specs.length) return null
    try {
      return await verifyImpl(specs, { tools: engine?.tools, judge: (o) => engine.judgeUntil(o), signal: engine?.signal })
    } catch (e) {
      return { passed: false, results: [], reason: `验证器异常：${e?.message || String(e)}` }
    }
  }

  /**
   * 统一的「继续下一轮」出口：先做 --until 判词（P1-5：判定从 cli 侧移入，终止逻辑单点收口），
   * 再写 nextRunAt 并落盘。
   * nextRunAt 是持久语义 —— 内核进程被回收/崩溃后，bridge 主管据此把循环唤醒
   * （见 server/loop-supervisor.mjs）。delayMs===0 表示「立即，内核自己会投递」。
   *
   * 时序与帧形状严格保持改前（零回归锁③）：改前由 cli 在 decision==='next' 后判定，
   * 并**多发一条**只含 index/total/judged/reason/error 的 iter 帧 —— 此处照旧。
   *
   * `@returns` 显式声明（不写时 TS 把 `'stop'|'next'` 字面量**拓宽成 string**，
   * 调用方 onTurnEnd 的返回类型是同一联合 ⇒ 两处 return 各报一条 TS2322）。
   * @param {any} delayMs
   * @param {any} rationale
   * @returns {Promise<{ action: 'stop'|'next'|'wait', delayMs: number, rationale: string }>}
   */
  async function nextDecision(delayMs, rationale) {
    if (state.until) {
      let j = null
      try { j = await engine.judgeUntil({ target: state.until }) } catch { j = { done: false, error: true } }
      emit('iter', {
        index: state.index, total: state.count,
        judged: j?.done === true, reason: j?.reason || '', error: !!j?.error,
      })
      if (j?.done) { stop('until_hit'); return { action: 'stop', delayMs: 0, rationale: 'until_hit' } }
      if (j?.error) { stop('judge_error'); return { action: 'stop', delayMs: 0, rationale: 'judge_error' } }
    }
    const d = Number(delayMs) || 0
    state.nextRunAt = Date.now() + d
    persist()
    return { action: 'next', delayMs: d, rationale }
  }

  /**
   * 一轮**开始执行**时的钩子（cli 在投递下一轮载荷、进入轮次前调用）：
   * 等待窗口到此结束 —— nextRunAt 清零。
   * 为什么必须清：若保留已到点的 nextRunAt，磁盘上就出现「正在跑 + 已到点」的组合，
   * bridge 主管据此会与内核双投递、连跑两轮（spec §4.3）。等待窗口只在轮末由
   * nextDecision() 重新武装。
   * 幂等：无待触发（0/缺失）时直接返回，不产生多余落盘。
   */
  function markTurnStart() {
    if (!state.nextRunAt) return state
    state.nextRunAt = 0
    persist()
    return state
  }

  /**
   * 轮末驱动（cli 在 finally 的 loop 推进处调用）。
   * @param {{ outcome?: any }} [opts]
   * @returns {Promise<{ action:'next'|'wait'|'stop', delayMs:number, rationale:string }>}
   */
  async function onTurnEnd({ outcome } = {}) {
    if (!isActive()) return { action: 'wait', delayMs: 0, rationale: `status=${state.status}` }
    // 1. 累计用量/成本/步数
    try {
      const u = outcome?.usage
      if (u) for (const k of Object.keys(state.usageAcc)) state.usageAcc[k] += Number(u[k]) || 0
      state.costUsd = costOf(state.usageAcc, prices)
    } catch { /* 成本计算失败不阻断 */ }
    const digest = Array.isArray(outcome?.toolDigest) ? outcome.toolDigest : []
    state.steps += digest.length
    const filesChanged = digest.filter((t) => !t.isError && t.path).length

    // 1.5 待人工审批（停滞升级 / 回滚登记）→ **不再自行推进，也不再重复注入**
    // 缺陷背景（2026-09-15 实测复现）：停滞分支会注入一条反思消息并把 status 置为
    // awaiting_approval，而 awaiting_approval 属于 isActive() ⇒ cli 在那条被注入消息的
    // 轮末又进 onTurnEnd（cli.mjs 的 `if (loop.isActive())`），指纹不变 ⇒ streak 继续
    // 增长 ⇒ 再注入一条反思 …… 形成"每轮一次 API 调用"的无限自续跑（管道 mock 下 60s
    // 内跑到第 19 轮仍未停）。设计意图是"停下来要人介入"，不是继续跑。
    // 只挡自动推进：人工确认（/loop approve → resume()）会把 status 拨回 running，
    // 之后照常推进。此处**不推进 index、不更新指纹、不写 history**——等待轮不是一次迭代
    //（否则轮次显示会从 3/3 一路涨到 13/3），停滞本身也已在升级那一刻记入 history。
    if (state.status === 'awaiting_approval') {
      // 宽幅审查缺陷 M-3：不推进的分支必须显式清 nextRunAt，把"无待触发"这条不变式
      // **钉在生产者侧**，而不是只靠消费者的 `status !== 'running'` 守卫兜住。
      // 否则一旦后续出现只看 nextRunAt 的消费者（Phase 2/3 的"改间隔""全局循环列表"），
      // 就会把一个等待人工审批的循环判成"待触发"甚至去唤醒它 —— 那会**绕过审批门**。
      state.nextRunAt = 0
      persist()
      return { action: 'wait', delayMs: 0, rationale: 'awaiting_approval' }
    }

    // 1.6 轮次条目（后续全部分支共用；index 已在此推进——本函数只在"轮末"被调用一次）
    const historyEntry = {
      index: state.index + 1, ts: new Date().toISOString(),
      usage: outcome?.usage || null, costUsd: Number(state.costUsd.toFixed(4)),
      steps: digest.length, toolCount: digest.length, filesChanged,
      errors: digest.filter((t) => t.isError).length,
      verify: null, judged: false, note: '',
    }
    state.index += 1

    // 2. 无进展指纹（轮次维度，补既有时间维度 LOOP_STALL_MS 的空档）
    // 语义：连续相同指纹轮数。首次记录即算第 1 轮（第 1 轮不可能"与前一轮相同"），
    // 后续每轮指纹不变则 +1；达到阈值（默认 3，env PONOS_LOOP_NOPROGRESS_N）即升级。
    // 指纹为空（本轮无工具调用）→ 不计无进展（纯文本轮无法判定是否实质推进，保守不误停）。
    const fp = fingerprintOf(outcome)
    if (fp && fp === state.noProgress.lastFingerprint) state.noProgress.streak += 1
    else if (fp) state.noProgress.streak = 1
    else state.noProgress.streak = 0
    state.noProgress.lastFingerprint = fp

    // 3. 短路序：pausing → 预算 → 无进展 → 验证 → 次数
    if (state.status === 'pausing') {
      state.status = 'paused'
      // 宽幅审查缺陷 M-3：暂停分支同样必须清 nextRunAt（同 awaiting_approval 的理由）——
      // 否则一个已暂停的循环在磁盘上仍带着"未来要触发"的时间戳，后续任何只看
      // nextRunAt 的消费者（或未来的全局调度视图）都会误判它在排队等执行。
      state.nextRunAt = 0
      state.history.push(historyEntry)
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'paused', index: state.index, total: state.count })
      return { action: 'wait', delayMs: 0, rationale: 'paused' }
    }

    const overBudget = (state.budget.maxCostUsd > 0 && state.costUsd > state.budget.maxCostUsd)
      || (state.budget.maxSteps > 0 && state.steps > state.budget.maxSteps)
      || (state.budget.maxWallMs > 0 && Date.now() - Date.parse(state.startedAt) > state.budget.maxWallMs)
    if (overBudget) {
      state.history.push({ ...historyEntry, note: 'budget_exceeded' })
      stop('budget_exceeded')
      return { action: 'stop', delayMs: 0, rationale: 'budget_exceeded' }
    }

    if (state.noProgress.streak >= state.noProgress.threshold) {
      state.history.push({ ...historyEntry, note: 'no_progress' })
      if (onStall === 'stop') { stop('no_progress'); return { action: 'stop', delayMs: 0, rationale: 'no_progress' } }
      try {
        engine?.queueNext?.(`【loop 无进展预警】连续 ${state.noProgress.streak} 轮无实质进展（文件未变更/重复相同错误）。请换一种策略推进，或说明当前阻塞点与需要的帮助。`)
      } catch { /* 静默 */ }
      state.status = 'awaiting_approval'
      state.pendingApproval = { kind: 'no_progress', detail: `连续 ${state.noProgress.streak} 轮无进展` }
      state.endReason = 'stalled'
      // 宽幅审查缺陷 M-3（第三条同类路径）：无进展升级为待审批时也要清 nextRunAt。
      // 这里是"循环已经不再自己推进、在等人"的第三个入口，与前两处（awaiting_approval
      // 短路分支、pausing 分支）同源 —— 三处都清，才能说"不推进 ⇔ nextRunAt=0"这条
      // 不变式在生产者侧真的闭合，而不是靠消费者逐个记得加 status 守卫。
      state.nextRunAt = 0
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), noProgressStreak: state.noProgress.streak })
      emit('status', { status: 'awaiting_approval', pendingApproval: state.pendingApproval, index: state.index, total: state.count })
      return { action: 'stop', delayMs: 0, rationale: 'no_progress' }
    }

    // 4. 完成条件（doneWhen 优先；否则 --until/goal 判词）
    if (state.doneWhen.length) {
      state.status = 'verifying'
      const v = await runVerify()
      historyEntry.verify = v ? { passed: v.passed, results: (v.results || []).map((r) => ({ run: r.run, type: r.type, ok: r.ok })) } : null
      historyEntry.note = v?.reason || ''
      state.status = 'running'
      state.history.push(historyEntry)
      if (v?.passed === true) {
        state.status = 'done'; state.endReason = 'verify_hit'; state.endedAt = new Date().toISOString()
        state.nextRunAt = 0
        persist()
        emit('iter', { index: state.index, total: state.count, steps: state.steps, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
        emit('end', { reason: 'verify_hit', index: state.index, total: state.count, goal: state.goal, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)) })
        return { action: 'stop', delayMs: 0, rationale: 'verify_hit' }
      }
      persist()
      emit('iter', { index: state.index, total: state.count, steps: state.steps, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak, verify: historyEntry.verify })
      // 次数耗尽 + done_when 未达成 → 失败收尾。
      // 修复前此处直接 return 'next'（不检查 count）→ `--done` 永不通过的 loop 无视次数上限
      // **无限跑**（只能靠预算/无进展/人工停），属"烧钱死循环"。语义上轮数用尽而目标未达成
      // 是失败而非完成，故用 'failed'（'completed' 保留给无 done_when 的"跑满 N 轮"）。
      if (state.count !== null && state.index >= state.count) {
        state.status = 'done'; state.endReason = 'failed'; state.endedAt = new Date().toISOString()
        state.nextRunAt = 0
        persist()
        emit('end', { reason: 'failed', index: state.index, total: state.count, goal: state.goal, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), verify: historyEntry.verify })
        return { action: 'stop', delayMs: 0, rationale: 'failed' }
      }
      return nextDecision(state.everyMs, `verify_failed: ${v?.reason || ''}`)
    }

    state.history.push(historyEntry)
    persist()
    emit('iter', { index: state.index, total: state.count, steps: state.steps, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)), filesChanged, noProgressStreak: state.noProgress.streak })
    if (state.count !== null && state.index >= state.count) {
      state.status = 'done'; state.endReason = 'completed'; state.endedAt = new Date().toISOString()
      state.nextRunAt = 0
      persist()
      emit('end', { reason: 'completed', index: state.index, total: state.count, goal: state.goal, priceSource: state.priceSource, costUsd: Number(state.costUsd.toFixed(4)) })
      return { action: 'stop', delayMs: 0, rationale: 'completed' }
    }
    return nextDecision(state.everyMs, 'continue')
  }

  function load() {
    try {
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf-8'))
      if (Number(parsed?.version) !== SCHEMA_VERSION) return false
      if (TERMINAL.has(String(parsed?.status))) return false // 已终结不重启
      state = { ...freshState(), ...parsed, budget: { ...freshState().budget, ...(parsed.budget || {}) }, noProgress: { ...freshState().noProgress, ...(parsed.noProgress || {}) } }
      // 审查缺陷（T2-FIX 缺陷 3）：`{...freshState(), ...parsed}` 会让**磁盘旧值**覆盖构造时
      // 解析出的 priceSource —— resume 后首轮标签停留在上一进程的来源（如 'provider'），
      // 而 costUsd 已按本次注入价重算 ⇒ 标签与实际单价错配（下一轮 iter 帧才自愈）。
      // 来源必须与本次进程采用的单价同源，故合并后强制回写。
      state.priceSource = priceSource
      // resumed start 帧补 priceSource（**纯增字段**，既有字段一个不少）：否则 UI 在 resume
      // 后拿不到本轮的真实价格来源，只能等下一次 iter 帧。
      emit('start', { index: state.index, total: state.count, until: state.until || '', fresh: state.fresh, goal: state.goal, everyMs: state.everyMs, budget: state.budget, prompt: state.prompt, priceSource: state.priceSource, resumed: true })
      return true
    } catch { return false }
  }

  return {
    start, onTurnEnd, status, formatStatus, pause, resume, stop, setBudget, approve, inject,
    snapshot, rollback, applyPendingRollback, replay, memory, load, persist, isActive, nextPayload, markTurnStart,
    engine, // 暴露注入的 engine（cli 与测试共用同一实例；测试改其 queueNext 可断言注入）
    // 测试注入点（生产代码不调用）
    __setVerifyForTest(fn) { verifyImpl = fn },
  }
}
