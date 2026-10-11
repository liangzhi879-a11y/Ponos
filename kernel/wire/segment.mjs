// kernel/wire/segment.mjs —— 文本增量切帧（**跨协议唯一真源**）
// ---------------------------------------------------------------------------
// 从 kernel/api.mjs 搬出（2026-09-23，OpenAI 协议兼容）：Anthropic 与 OpenAI 两个解析器
// 都要按同一策略切帧，而 wire/openai.mjs 不能反向 import api.mjs（循环依赖）。
//
// ★ 为什么**必须**共用而不是各写一份：本文件里的两条逻辑都是用真实事故换来的，任何
//   协议路径漏掉其中之一都会立即复现旧病：
//    ① 只按段落切 ⇒ 模型写整段无空行时该段被扣到流末才吐，观感是"卡住几个字、不是流式输出"；
//       且旧实现 `return rest` 的尾巴不进 for...of ⇒ **同一 delta 内 "\n\n" 之后的文字永久丢失**。
//    ② 未闭合的 HTML 注释（`<!--` 尚无配对 `-->`）不得在中间切帧——ASK_USER 提问卡与
//       MILESTONE 进度标记**都是 HTML 注释**，而桥侧是逐帧正则提取、要求同一帧内闭合。
//       按字符数硬切会把 93 字的 ASK_USER 标记切成 7 帧 ⇒ 卡片 0 命中、且原始
//       `<!--ASK_USER {...` 原样漏进气泡（探针实证：切帧数 7、命中 0、7 帧全原样转发）。
//
// 原始事故记录（2026-09-12）详见 kernel/api.mjs 的对应注释块。

// 默认 16 字：本仓实测慢模型（qwen/vLLM 约 15 B/s）下 ≈1s 一跳，观感接近连续；
// 调到 1 即"每 delta 一帧"（最大流式粒度，帧数最多）。设 0/非法值回落默认。
export const TEXT_FLUSH_CHARS = () => Math.max(1, Number(process.env.PONOS_TEXT_FLUSH_CHARS) || 16)

// 未闭合注释的押后上限：模型写出永不闭合的 `<!--` 时不得把整段扣住（那恰是"卡住几个字"
// 的病根），超过上限即放弃押后、照常吐帧。0 = 关闭押后（退回纯长度切分）。
export const MARKER_HOLD_MAX = () => {
  const raw = process.env.PONOS_TEXT_MARKER_HOLD_MAX
  if (raw === undefined || raw === '') return 2048
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 2048
}

/** 返回"必须押后的起点"：无未闭合注释时 = buf.length（可自由切分）。 */
export function holdStart(buf) {
  const max = MARKER_HOLD_MAX()
  if (!max) return buf.length
  const i = buf.lastIndexOf('<!--')
  if (i < 0 || buf.indexOf('-->', i + 4) !== -1) return buf.length
  return buf.length - i > max ? buf.length : i // 超上限 = 放弃押后（防坏标记扣住整段）
}

/**
 * 切点 pos 是否落在某个 HTML 注释**内部**。判据必须是"注释内部"而非"当前押后区内"：
 * 注释一旦闭合押后就释放了，若只看押后区，载荷内的 `\n\n` 会在闭合的瞬间变回合法切点、
 * 把已完整的标记重新切成两帧（夹具实证：`<!--MILESTONE-OK 1/3 读代码\n\n继续跑-->`
 * 在 `-->` 到达后被从 `\n\n` 处切开）。取"最后一个 `<!--` 是否晚于最后一个 `-->`"。
 */
export function insideComment(s, pos) {
  const head = s.slice(0, pos)
  return head.lastIndexOf('<!--') > head.lastIndexOf('-->')
}

/**
 * 将文本增量累积并按段落边界切分：产出 1..n 个 `{type: kind, text}` 段。
 * **返回未消费的尾巴**（生成器 return 值）——调用方必须显式取值并留在缓冲里；
 * 用 `for...of` 消费会静默丢弃尾巴（那是"同一 delta 内段界后文字永久丢失"的成因）。
 */
export function* segmentText(buffer, kind = 'text') {
  let rest = buffer
  while (rest) {
    const holdAt = holdStart(rest)
    const idx = rest.indexOf('\n\n')
    if (idx >= 0 && !insideComment(rest, idx + 2)) {
      const seg = rest.slice(0, idx + 2)
      rest = rest.slice(idx + 2)
      if (seg.trim()) yield { type: kind, text: seg }
      continue
    }
    // 无段界但已够长：先吐，避免整段被扣到流末（帧数仍远少于逐 delta 直发）
    if (rest.length >= TEXT_FLUSH_CHARS() && holdAt === rest.length) {
      yield { type: kind, text: rest }
      rest = ''
    }
    break
  }
  return rest
}
