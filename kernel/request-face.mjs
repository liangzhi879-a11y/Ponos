// 请求面组装（原 engine.mjs 中部，P1-6 拆出）：历史裁剪、失真正文锚点、孤儿 tool_use 修补、
// 请求面（getBase/getRevision/getSystem/getSkip）构造与缓存判定。
// 注意：compact.mjs 依赖 patchOrphanToolUses——engine.mjs 以 re-export 维持该导出面。
import { streamMessages } from './api.mjs'
import { contentEpoch, estimateMessage, estimateRequest } from './context.mjs'
import { perfCount } from './perf.mjs'
import { join } from 'node:path'
import { isRequestFaceCacheOn } from './engine-config.mjs'
import { retryStream } from './stream-runtime.mjs'


// P1-8：孤儿 tool_use 补丁——压缩/恢复破坏消息链时，为无配对 tool_result 的
// tool_use 追加合成 is_error tool_result（保 API 请求消息链合法，防 400）。
// 纯派生（不入日志）：每次请求前重建，日志保持权威。
// 终局裁剪（2026-09-10 长输出锁死修复）：单条超长消息（模型把成果直接写在
// 输出里）逼近/超过端点窗口时，压缩按轮次边界切不动最新一条巨消息、预算收窄
// 也无解。请求面裁剪最长内容块（头尾各 30% + 标记）——只作用于本次请求的
// 深拷贝，不污染 transcript/派生缓存。返回裁剪后的消息副本，无可裁内容 → null。
export function trimOversizedRequestCopy(msgs) {
  let biggest = null
  let biggestChars = 0
  for (const m of msgs) {
    if (!m || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      const field = b?.type === 'thinking' ? 'thinking' : b?.type === 'text' ? 'text' : b?.type === 'tool_result' ? 'content' : null
      if (!field) continue
      const s = String(b[field] ?? '')
      if (s.length > biggestChars) { biggestChars = s.length; biggest = { b, field, s } }
    }
  }
  if (!biggest || biggestChars < 100_000) return null
  try {
    const copy = JSON.parse(JSON.stringify(msgs))
    let target = null
    let maxChars = 0
    for (const m of copy) {
      if (!m || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        const field = b?.type === 'thinking' ? 'thinking' : b?.type === 'text' ? 'text' : b?.type === 'tool_result' ? 'content' : null
        if (!field) continue
        const s = String(b[field] ?? '')
        if (s.length > maxChars) { maxChars = s.length; target = { b, field, s } }
      }
    }
    if (!target) return null
    const keep = Math.floor(target.s.length * 0.3)
    target.b[target.field] = target.s.slice(0, keep) + '\n…【中间内容过长，已裁剪】…\n' + target.s.slice(-keep)
    return copy
  } catch {
    return null
  }
}

// 渐进式披露索引（2026-09-11）：压缩不动时的兜底——把超窗历史替换为紧凑索引
// （每条一行：行号 + 角色 + 内容前 60 字符），模型保留"全局地图"，需要细节时
// Read transcript 文件按行号展开（transcript 已入 Read 白名单，见 createEngine）。
// 行号 = 消息在派生历史中的序号（与 transcript 文件行序近似对齐）。
export function buildHistoryIndex(msgs) {
  const lines = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    let head = ''
    if (typeof m?.content === 'string') {
      head = m.content
    } else if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_use') { head = `[工具 ${b.name}] ${JSON.stringify(b.input ?? {}).slice(0, 50)}`; break }
        if (b?.type === 'tool_result') { head = String(b.content ?? '').slice(0, 60); break }
        if (b?.type === 'text' && b.text) head = b.text
      }
    }
    head = String(head || '(空)').replace(/\s+/g, ' ').slice(0, 60)
    lines.push(`${i + 1} ${m?.role === 'assistant' ? '助手' : '用户'} ${head}`)
  }
  return lines.join('\n')
}

// 请求面硬适配（2026-09-11 持续稳定运行；同日升级渐进式披露）：压缩/收窄/裁剪均
// 无解时，把请求硬裁到窗口内——系统提示恒保留，其余只保留"最近一个完整 turn"
// （从尾部回退到真实 user turn 起点，tool_result 不拆散）。更早的历史**优先索引化
// 而非丢弃**：替换为一条 <history-index> 消息（每行主题 + 行号），模型按需 Read
// transcript 展开细节——视野收窄但全局地图不丢；索引化仍超窗才真丢弃。
// 孤儿 tool_use 由 patchOrphanToolUses 合成错误结果补齐消息链。单 turn 仍超时复用
// trimOversizedRequestCopy 裁最长块。返回新请求数组（纯请求面拷贝，transcript 不动）。
// 连末轮本身都放不下（病态单条超窗）返回 null（调用方落放弃执行文案，最终防线）。
export function fitRequestToWindow(msgs, { window, outputBudget = 2048, estimateMessage: estMsg, transcriptPath = '' }) {
  const w = Number(window)
  if (!Array.isArray(msgs) || msgs.length === 0 || !Number.isFinite(w) || w <= 0) return null
  const budget = Math.max(1024, Math.floor(w) - Math.max(1024, Number(outputBudget) || 1024) - 4096)
  const est = (list) => list.reduce((s, m) => s + (estMsg ? Math.max(1, estMsg(m)) : 100), 0)
  if (est(msgs) <= budget) return msgs
  const system = msgs[0]?.role === 'system' ? msgs[0] : null
  let rest = system ? msgs.slice(1) : [...msgs]
  // 保留最近一个完整 turn：从尾部回退到最后一个真实 user turn 起点
  let cut = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]
    if (m?.role === 'user' && !(Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result'))) { cut = i; break }
  }
  const dropped = rest.slice(0, cut)
  rest = rest.slice(cut)
  // 渐进式披露（2026-09-11）：被裁历史优先索引化（全局地图保留、可按行展开），
  // 索引化仍超窗才退回纯丢弃。
  if (dropped.length) {
    const indexText = `<history-index>\n历史索引（共 ${dropped.length} 条；需要细节时用 Read 读取 transcript 文件按行号展开${transcriptPath ? `：${transcriptPath}` : ''}）：\n${buildHistoryIndex(dropped)}\n</history-index>`
    const withIndex = system
      ? [system, { role: 'user', content: indexText }, ...rest]
      : [{ role: 'user', content: indexText }, ...rest]
    if (est(withIndex) <= budget) return patchOrphanToolUses(withIndex)
  }
  const base = system ? [system, ...rest] : rest
  if (est(base) <= budget) return patchOrphanToolUses(base)
  const trimmed = trimOversizedRequestCopy(base)
  if (trimmed && est(trimmed) <= budget) return trimmed
  return null
}

// 历史消息 → 纯文本投影（B1 上下文继承用，2026-09-11）：只带 text 块，剥离
// tool_use/tool_result（半截消息链会破坏 API 合法性；子任务只需知道"发生过什么"）。
export function messageTextOf(m) {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) {
    return m.content.filter((b) => b?.type === 'text').map((b) => String(b?.text ?? '')).filter(Boolean).join('\n').trim()
  }
  return ''
}

export function patchOrphanToolUses(msgs) {
  const out = []
  const unpaired = new Map() // tool_use id → { block, outIdx }
  for (const m of msgs) {
    // 防御：派生历史可能含 undefined 条目（旧格式 transcript 恢复），m?. 防护
    out.push(m)
    const idx = out.length - 1
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_use') unpaired.set(b.id, { block: b, outIdx: idx })
    } else if (m?.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_result') unpaired.delete(b.tool_use_id)
    }
  }
  if (!unpaired.size) return out
  // 2026-09-10 修复：合成 tool_result 必须紧跟 tool_use 所在消息的下一条
  //（Anthropic API 硬约束"tool_result blocks immediately after"）。旧实现补在
  // 数组末尾——崩溃残留的历史中段孤儿补不上，818 条消息处直接 400。
  // 按位置从后往前插入，索引不受前面插入影响。
  //
  // 2026-09-19 修复：上面那条约束是**消息级**的——"该 assistant 消息里的**全部** tool_use
  // 都要被紧邻的下一条消息回答"，不是"每个 tool_use 各有一条结果紧随其后"。旧实现逐个
  // 孤儿插一条独立 user 消息（且倒序），于是并行批次 assistant(use0,use1) 补成
  // assistant → user(→use1) → user(→use0)：use0 的结果被挤到第二位，API 继续 400
  //（报错点名的正是 call_00）。实况：`~/.yfw/.../37e6fd11-*.jsonl` 的 seq=16 有两个
  // tool_use，App 里"重启该会话"仍 400——因为**每次重试都重新补成这个非法形状**。
  // 故：按 assistant 消息分组，一组**只产出/只并入一条** user 消息，块序与 tool_use 一致。
  const byMsg = new Map() // outIdx → block[]（Map 插入序 = tool_use 原顺序）
  for (const { block, outIdx } of unpaired.values()) {
    const arr = byMsg.get(outIdx)
    if (arr) arr.push(block)
    else byMsg.set(outIdx, [block])
  }
  const synth = (block) => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: '（该工具调用因上下文压缩/恢复丢失，未执行，标记为错误）',
    is_error: true,
  })
  const result = [...out]
  for (const [outIdx, blocks] of [...byMsg].sort((a, b) => b[0] - a[0])) {
    const next = result[outIdx + 1]
    const nextHasResult = Array.isArray(next?.content) && next.content.some((b) => b?.type === 'tool_result')
    if (next?.role === 'user' && nextHasResult) {
      // 残缺批次（同一批 tool_use 只落了一部分结果）：紧邻的下一条已经带着这批的一部分
      // 结果，另插一条会把它们挤到第二位——犯的是同一条"immediately after"约束。只能
      // 并入同一条消息（结果块排在前：同一消息里 tool_result 必须先于 text）。这是唯一
      // 需要换掉既有对象的路径；换出来的是新对象，下面那条 insert 路径**不动任何既有
      // 对象**（session.seqsForMessages 靠对象引用反查 seq，替换会让压缩遮蔽区间反查失败）。
      const content = Array.isArray(next.content)
        ? [...blocks.map(synth), ...next.content]
        : [...blocks.map(synth), { type: 'text', text: String(next.content ?? '') }]
      result[outIdx + 1] = { ...next, content }
    } else {
      // 其余情形（无下一条的尾部孤儿 / 下一条是 assistant / 下一条是纯文本用户消息，
      // 例如用户抢在工具跑完前发的"继续"）：插一条新的，不影响任何既有消息。
      result.splice(outIdx + 1, 0, { role: 'user', content: blocks.map(synth) })
    }
  }
  return result
}

// K1.4 请求面记忆化（2026-09-13 系统性优化）：`requestMessages()` 在一步内被调用 4–5 次
// （估算 ×2、看门狗提供者、`reqFace`、溢出分支的裁剪/硬适配各一次），每次都要重跑
// `patchOrphanToolUses(deriveHistory())` + 拼 system 前缀。实测 0.77ms/次 ⇒ ~3.9ms/步；
// 更关键的是**同一数组身份**能让下游 K1.1 的估算记忆化整段命中（否则每步至少两次全量估算）。
//
// 失效键 = `(session.revision, historySkip, systemPrompt 引用, contentEpoch)`：
//   · `revision` —— session 的派生纪元（见 session.mjs `deriveRev`），覆盖 append/压缩/恢复；
//   · `historySkip` —— `loop --fresh` 窗口起点，只影响请求面、不入日志，故必须入键；
//   · systemPrompt 存**字符串本身**、用 `===` 比（实测：V8 驻留字面量 + `===` 先比身份、
//     不等再比内容 ⇒ 实为"内容比较 + 身份快路径"）。**绝不**把它拼进键**串**——那等于每次
//     求值都付一遍 20KB 拼接成本，等于没优化。副作用是同内容的等值新串不误判为变
//     （`setSystemPrompt` 传 `a + b` 不白付重建），代价仅命中路径上一次 ~20KB memcmp；
//   · `contentEpoch` —— 保险丝：compact 的原地改写（`freeShrink`/`ageOutToolResults`）改的是
//     块内容而非数组结构，理论上数组身份不变、内容已变。此处刻意不依赖"已证明无第三处改写
//     点"这一结论，多一枚纪元即多一层保证（多失效一次只多算、不会错算）。
//
// **求值顺序有意为之**：先 `getBase()` 再 `getRevision()`。`revision` 在 `deriveMessages()`
// 真实重建时才 +1，若反序，遇到"nodes 变了但还没重建"的窗口会先读到旧纪元、再拿到新数组
// ⇒ 把新结果存在旧键下（不会错算，但白丢一次命中）。
//
// **唯一别名点**（人工确认，PR 须点名）：`fitRequestToWindow` 在装得下时 `return msgs`
// 原样返回入参引用（engine.mjs 早退分支），被 `engine-fit-request.test.mjs` 的
// `assert.equal(r, msgs)` 钉死。命中缓存后该引用会跨调用共享，故下游**必须**只读——
// 已逐点审计：主循环 `reqFace` → `retryStream` → `api.streamMessages`（只 `filter`
// 拆 system/rest）+ `JSON.stringify`；`estimateRequest` 只读；`trimOversizedRequestCopy`
// 走 `JSON.parse(JSON.stringify(...))` 深拷贝。全仓 `messages` 无任何原地写。
export const REQUEST_FACE_FIELDS = ['getBase', 'getRevision', 'getSystem', 'getSkip']
export function createRequestFace(opts = {}) {
  for (const f of REQUEST_FACE_FIELDS) {
    if (typeof opts[f] !== 'function') throw new TypeError(`createRequestFace: ${f} 必须是函数`)
  }
  const {
    getBase, getRevision, getSystem, getSkip,
    patch = patchOrphanToolUses,
    epoch = contentEpoch,
    on = isRequestFaceCacheOn,
  } = opts
  let cache = null
  return function requestFace() {
    if (!on()) {
      cache = null // 关缓存时不留残留（重新打开不会命中陈旧项）
      return build(getBase(), getSystem())
    }
    const base = getBase()               // 先派生（可能触发 revision 变更，见上）
    const rev = getRevision()
    const skip = getSkip()
    const sys = getSystem()
    const ep = epoch()
    if (cache && cache.rev === rev && cache.skip === skip && cache.sys === sys && cache.epoch === ep) {
      perfCount('reqHit')                // K0：命中率——「缓存没生效」与「缓存关了」的区别
      return cache.face
    }
    const face = build(base, sys)
    cache = { rev, skip, sys, epoch: ep, face }
    return face
  }
  function build(base, sys) {
    const msgs = patch(base)
    return [{ role: 'system', content: sys }].filter((m) => m.content).concat(msgs)
  }
}
