// 生成侧守卫（原 engine.mjs 中部，P1-6 拆出）：计划尾/纯思考早停、生成重复与近重复检测、
// 工具调用规范键。与 guards.mjs（工具/循环侧判据）分工不同：本模块管「模型生成文本侧」。
import { countCjk } from './context.mjs'
import { NEAR_REPEAT_CODE_SKIP } from './engine-config.mjs'


// R3-2 计划尾检测：模型以"计划/承诺"措辞收尾但未执行工具调用（计划尾巴）。
// 匹配文本尾部 120 字符内的计划词；完成语（完成/结束/以上就是/无需…）优先否决，
// 避免误伤正常收尾。中英双语覆盖。
//
// 2026-09-16 口径收紧（活跃度巡检）：删掉 6 个**无动作指向或对用户说话**的裸词分支——
// `准备(好|一下)?`（"材料已准备就绪"→ 误判）、`稍等`/`待会`/`稍后`（多为对用户说的
// 客套话，如"生成需要稍等片刻"）、`再(继续|检查|验证|读|看)`（"再验证一下"也可以是
// 结论性说明）、`计划`（"这是本次申报的整理计划"→ 误判：这是**交付物名称**而非承诺）。
// 保留的分支都要求「后续动作动词」或「第一人称承诺主语」（先读/接下来…/开始实施/
// 需要先/我先/让我先/立即执行）。
//
// 权衡（判错两个方向的代价不对称，故意如此）：漏检 = 少注入一次推进指令，用户可发
// 「继续」接续，代价可控；误判 = 注入"你承诺了后续动作"**并清空 textBuf**（见
// engine.mjs 计划尾分支）——已流式展示的那段内容不落 transcript、被重新生成，且把
// 正常收尾强行拉回工具轮。故取"宁漏勿滥"。若要恢复某项，须同时补该形态的误伤对照。
export const PLAN_TAIL_RE = /(先(读|看|查|确认|检查|验证|尝试|搜索|获取|执行|开始)|(接下来|然后|接着|下一步)[^，。；：！？\n]{0,6}(读|看|查|检查|验证|处理|执行|写|改|搜索|获取|开始|做|要|实现|修复|运行|测试|生成)|开始(实施|执行|动手|做|写|改|处理)|需要先|我先|让我(先|开始|试)|立即(开始|动手|执行)|first,?\s+let|next,?\s+(i|let|we)|let me (start|begin|first)|i will (first|start|begin|now)|i'?m going to (first|start|begin|now)|to do this,?\s+(i|we)|i need to (first|start|begin))/i
export const PLAN_TAIL_DONE_RE = /(已完成|完成|搞定|结束|成功|以上就是|以上就是全部|已处理|没有更多|无需|不需要|不需要了|bye|done|complete|finished|that'?s all|no more)/i
export function isPlanTail(text) {
  const tail = String(text ?? '').slice(-120)
  if (PLAN_TAIL_DONE_RE.test(tail)) return false
  return PLAN_TAIL_RE.test(tail)
}

// 思考型模型早停判定（2026-09-09 截断事故）：模型以 end_turn 正常收尾、但正文
// 最后一段思考标签闭合后没有实质回答内容（"想完即停"）。Qwen3.8-27B 等弱模型
// 在复杂 system prompt 下偶发此形态——由回合守卫注入续写指令自愈，不把半截思考
// 当答案展示给用户。判定口径保守：仅当文本末尾存在 </think> 且其后再无实质内容
// （<10 非空白字符）才命中，正常"思考+完整回答"不受影响。
export function isThinkOnly(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  const i = t.lastIndexOf('</think>')
  if (i < 0) return false
  return t.slice(i + '</think>'.length).trim().length < 10
}

// —— 生成死循环检测（思考/文本重复打转）——
// 单次模型流内滚动检测"周期重复"：窗口尾部出现同一长度 p 的内容段连续重复 ≥minRepeats 次
// 即判定退化循环（本地模型 CoT/文本打转的典型形态：同一段话不断自我复制）。作用面 = 一次
// API 调用的流式文本（thinking 与 text 同窗口合并）。只扫尾部窗口避免长正常输出误判，
// 最小周期/次数保守取值压低误伤（自然重复短分隔线、代码里偶发重复行不触发）。
export function detectGenerationRepeat(windowText, { minPeriod = 20, minRepeats = 3, maxPeriod = 100 } = {}) {
  const s = String(windowText || '')
  if (s.length < minPeriod * minRepeats) return null
  const upper = Math.min(maxPeriod, Math.floor(s.length / minRepeats))
  for (let p = minPeriod; p <= upper; p++) {
    const unit = s.slice(-p)
    let repeats = 1
    for (let i = s.length - 2 * p; i >= 0 && s.slice(i, i + p) === unit; i -= p) repeats++
    if (repeats >= minRepeats) return { p, repeats }
  }
  return null
}

// —— 生成"近似重复"检测（编织变体死循环；守卫③b 配套）——
// 与 detectGenerationRepeat（逐字符精确周期）互补：后者只抓"同一整段原样复制 ≥3 次"，
// 抓不到措辞微变的变体重述循环（"Let me run it." / "Let me run it now." 交织）。本检测
// 逐句做归一化 + 字符 bigram 指纹，每个新完成句与先前句池（back 上限）比较 Jaccard ≥ sim
// 记 1 个"近邻"；最近 recent 个新句的平均近邻数 ≥ avg 即判退化循环。设计取舍：
//   · 不依赖周期/固定句式对齐（编织循环序列位置漂移，句对齐会错位）——只统计"新句是旧句
//     变体的密度"，序列漂移免疫；
//   · 用完整句 + 较长指纹门槛压低误伤——正常长文/代码的新句几乎不与旧句高相似（平均近邻
//     ≈0），死循环反复重述旧内容（平均近邻 ≥1.2，标定见守卫常量注释）；
//   · 返回"最近一次触发"结构（调用方命中即收尾中断，无需闩）。
// 有状态工厂：流式 chunk 逐块喂入（内部保留未闭合尾句 pending），thinking/text 同窗累计
// （与 genWindow 语义一致）。每个 for-await 流（每次 API 调用）应新建实例。
export const NR_SENT_SPLIT_RE = /[。！？!?…\n\r]+/u
export const nrNorm = (raw) => String(raw ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
export const nrGrams = (s) => {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}
export function nrJaccard(g1, g2) {
  if (!g1.size || !g2.size) return 0
  let inter = 0
  for (const g of g1) if (g2.has(g)) inter++
  return inter / (g1.size + g2.size - inter)
}
// 代码单元识别（近重复守卫代码误伤系统性修复，见 NEAR_REPEAT_CODE_SKIP 注释）：
// 单元级特征——CJK 占比低（中文散文整体豁免）+ 结构性代码信号（强符号 / 函数调用 /
// 代码关键字）达到阈值即判"代码行"。纯符号行（{} 缩进等）归一化后 < minChars，本就
// 被长度门槛排除，无需在此处理。
// 设计权衡：宁可多豁免（代码误判收尾比漏检代价高——真死循环仍有守卫③精确重复、工具
// 重复提醒 ⑤ 与迭代/时长上限兜底），故对英文散文混代码引用句从宽。
export const NR_CODE_STRONG_RE = /[{}[\]\\;=<>`:@]/g   // 结构强符号（()、"、. 属散文常见，不计）
export const NR_CODE_CALL_RE = /[A-Za-z_$][\w$]*\s*\(/g  // 函数/方法调用形态 identifier(
export const NR_CODE_KEYWORD_RE = /(const|let|var|function|return|import|export|require|class|extends|new|await|async|throw|=>)\b/i
export function isCodeLikeUnit(raw, { cjkRatioMax = 0.5, minStrong = 2 } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return false
  if (countCjk(s) / s.length > cjkRatioMax) return false // CJK 主导（中/日/韩散文）不判代码
  const strong = (s.match(NR_CODE_STRONG_RE) || []).length
  if (strong >= minStrong) return true
  if (strong === 0) return false // 无强符号：调用/关键字在散文中常见（"see foo() in docs"），不据此判代码
  const calls = (s.match(NR_CODE_CALL_RE) || []).length
  return calls > 0 || NR_CODE_KEYWORD_RE.test(s)
}
export function createNearRepeatDetector({ minChars = 6, maxChars = 800, pendingCap = 4096, back = 48, sim = 0.6, recent = 10, avg = 1.2, codeSkip = true } = {}) {
  if (!(recent > 0) || !(avg > 0) || !(sim > 0)) return { push: () => null } // 关闭态 no-op
  let pending = ''
  const pool = []   // { u, g }：最近 back 个完整句（u 归一化原文，g bigram 集——避免重复计算）
  const hist = []   // 每个已处理新句的近邻数（最近 recent 个参与均值判定）
  const push = (text) => {
    pending += String(text ?? '')
    // pending 上限：极端"无句界长流"（base64/长代码/纯散文不停顿）会让 pending 无限增长
    // 且每 chunk 重算整段（O(n²)）。只留尾部（丢句边界可接受——那部分无法切句本就不参与检测）。
    if (pending.length > pendingCap) pending = pending.slice(-pendingCap)
    if (pending.length <= minChars) return null
    const parts = pending.split(NR_SENT_SPLIT_RE)
    pending = parts.pop() ?? '' // 尾部未闭合，留待下一块补齐（流式切句）
    let hit = null
    for (const part of parts) {
      if (codeSkip && isCodeLikeUnit(part)) continue // 代码行不进句池/直方（系统性防误判）
      const u = nrNorm(part)
      if (u.length < minChars || u.length > maxChars) continue // 过长单元无判别力且污染指纹池
      const g = nrGrams(u)
      let m = 0
      for (const old of pool) if (nrJaccard(g, old.g) >= sim) m++
      pool.push({ u, g })
      if (pool.length > back) pool.shift()
      hist.push(m)
      if (hist.length > recent) hist.shift()
      if (hist.length === recent && hist.reduce((a, b) => a + b, 0) / recent >= avg) {
        hit = { avgNeighbor: +((hist.reduce((a, b) => a + b, 0)) / recent).toFixed(2), window: recent }
        break // 一次触发即报，调用方收尾中断，不再推进句池
      }
    }
    return hit
  }
  return { push }
}

// 工具调用规范键（重复检测用）：name + 参数深排序后 JSON——同工具同参数（忽略键序）判同一次。
// 超大参数截前 4K 参与比较（仅用于等值判定；同前缀极长参数误判风险可忽略）。
export function canonicalToolCallKey(toolUse) {
  if (!toolUse) return ''
  const name = String(toolUse.name || '')
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
    return v
  }
  let input = toolUse.input
  try { input = JSON.stringify(sort(input ?? {})) } catch { input = JSON.stringify(input ?? {}) }
  if (input.length > 4096) input = input.slice(0, 4096)
  return `${name}\u0000${input}`
}

