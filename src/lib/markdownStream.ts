// 流式 markdown 的「稳定前缀」切分（R4，2026-09-13）
// ---------------------------------------------------------------------------
// 病根：`MarkdownTextPart` 每帧把**整段正文**交给 react-markdown 重解析（remark 解析
// → mdast→hast → React 元素 → 协调）。正文越长越贵，而每帧真正新增的只有末尾那一小段。
//
// 解法：把正文切成
// 「已冻结的稳定前缀」+「仍在增长的尾块」两块，前缀交给被 memo 的组件——**它只在前缀
// 真的推进时重解析**，其余帧只解析尾块。
//
// 切点必须落在**空行**上，且**不在代码围栏内**：
//   · 空行是块级结构的分界——段落/标题/表格/列表项都不会跨空行，所以切口两侧各自
//     独立解析的结果与整段解析一致（行内语法如 `*`、反引号同样不可能跨空行）。
//   · 围栏内的空行不算数：``` 里的空行切开会把一段代码劈成两段。
//   · 围栏奇偶性是**位置属性**（某点之前的围栏数不会随文本增长而变），所以"最后一个
//     合法边界"可以随扫描单调推进，不需要回看。
//
// 已知的**流式期**观感差异（刻意接受，见 R4 计划条目）：松散列表、缩进代码块里的空行
// 会让两侧各自成块（多一点点间距 / 编号仍连续）。**最终态不受影响**——MarkdownTextPart
// 只在 `status.type === 'running'` 时切分，消息完成即整段一次性解析，与改动前逐字节一致。
//
// 增量：`feed` 只扫「上次扫到的位置之后新增的完整行」，所以 N 帧总扫描量 O(文本长度)
// 而不是 O(N × 长度)。`scannedChars` 就是给测试断这条的。

export interface PrefixFreezer {
  /** 喂入当前全文（流式语义：只会增长），返回可冻结的前缀长度（切点含其后的空行）。 */
  feed(text: string): number
  /** 累计扫描过的字符数——增量语义的断言点（测试与诊断用） */
  readonly scannedChars: number
}

/** 一行是否为代码围栏（``` 或 ~~~，允许前置空格与 info string） */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/
/** 锚点长度：识别「文本被截断/回写」而不必整段比对 */
const ANCHOR = 32

export function createPrefixFreezer(): PrefixFreezer {
  let pos = 0        // 已扫描到的位置（只扫完整行，始终停在行首或文末）
  let fences = 0     // [0, pos) 内的围栏行数
  let lastEven = 0   // 最后一个「空行边界且此前围栏为偶数」的位置
  let anchor = ''    // [pos-ANCHOR, pos) 的内容快照
  let lastText = ''
  let scannedChars = 0
  let seenContent = false // 是否已经出现过非空行（文首的空行不构成"边界"）

  const reset = () => { pos = 0; fences = 0; lastEven = 0; anchor = ''; seenContent = false }

  return {
    get scannedChars() { return scannedChars },
    feed(text: string) {
      if (text === lastText) return lastEven
      // 变短 = 被截断（truncatePartialAskUser 会砍掉半截 ASK_USER 标记）；
      // 锚点不符 = 被整体回写。两种都让既有结论作废，从头扫。
      if (text.length < pos || text.slice(Math.max(0, pos - anchor.length), pos) !== anchor) reset()

      // 只处理**完整行**：末尾没有 \n 的那半行留给下一帧（围栏行可能被拆成两帧到达）
      for (;;) {
        const nl = text.indexOf('\n', pos)
        if (nl < 0) break
        const line = text.slice(pos, nl)
        scannedChars += line.length + 1
        if (line.trim() === '') {
          // 空行 + 不在围栏内 + 前面真的有过内容 ⇒ 这里可以切
          // （"前面有过内容"是必需的：否则文首的空行会切出一个空前缀，白挂一个组件）
          if (seenContent && fences % 2 === 0) lastEven = nl + 1
        } else {
          seenContent = true
          if (FENCE_RE.test(line)) fences++
        }
        pos = nl + 1
      }
      anchor = text.slice(Math.max(0, pos - ANCHOR), pos)
      lastText = text
      return lastEven
    },
  }
}

/** 一次性求切点（非流式调用方/测试用）。增量调用方请用 `createPrefixFreezer`。 */
export function frozenPrefixLength(text: string): number {
  return createPrefixFreezer().feed(text)
}
