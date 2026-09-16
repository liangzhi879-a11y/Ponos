// src/lib/sessionDistill.ts —— 历史会话「一键蒸馏到知识库」的纯逻辑层（2026-09-15，清单 P1）
//
// spec：docs/superpowers/specs/2026-09-15-session-distill-design.md
//
// 为什么单独成层（照 src/lib/dirPicker.ts 的既有纪律）：路径清洗、既有文件识别（幂等）、
// 超长裁剪、工具块降级全是有边界条件的逻辑，而仓库的 `.tsx` 无法被 `node --test` import ——
// 写进组件就等于没有单测。本模块**零运行时依赖**（只 `import type`，Node 原生 TS 会整句擦除），
// 故既能在 Node 里直接跑测试，也能进浏览器 bundle。
//
// 三个刻意的设计（改之前先读 spec §2）：
//   1. **机械提取，零模型**：同输入必须产出逐字节相同的输出（幂等 + 可测 + 无配置也能用）。
//      因此内容里**不含"当前时间"**，时间只取会话自身的 createdAt/updatedAt。
//   2. **预算按字节算**：服务端上限是 2MB 字节，而中文 1 字 3 字节 —— 按字符算预算会在
//      纯中文会话上超限被 413（体感是"蒸馏失败且原因不明"）。
//   3. **幂等靠会话键后缀 + 目录扫描复用**：会话标题会被改名、日期会随更新变化，
//      只有"路径里嵌一个终生不变的会话短键"才能把"同一会话蒸过没"认出来，避免产生 `-2.md` 副本。

import type { Conversation, Message, ContentBlock } from '../types/index.ts'

/** 蒸馏文档在知识空间内的相对目录。集中一处便于用户整目录清理，也不污染空间根 */
export const DISTILL_DIR = '会话蒸馏'
/** 蒸馏文档统一标签（frontmatter tags），供标签视图一眼筛出全部蒸馏产物 */
export const DISTILL_TAG = '会话蒸馏'
/**
 * 正文预算（字节）。远低于服务端 `MAX_DOC_BYTES = 2MB`：预算存在的意义是"文档仍可读、可检索"，
 * 而不是"贴着上限塞满"——顶格文档在阅读视图里翻不到底，检索块也会被切成上千个。
 */
export const DISTILL_BUDGET_BYTES = 600 * 1024
/** 单条消息正文上限（字节）：一条贴了几万字的日志输出不该占满整篇文档 */
export const DISTILL_MAX_MESSAGE_BYTES = 4000
/** 工具参数/工具结果上限（字节）：证据链留"够判断"的部分即可 */
export const DISTILL_MAX_TOOL_BYTES = 600
/** 头部保留比例（其余给尾部）：头含任务陈述、尾含结论与交付物，中间过程最可丢 */
export const DISTILL_HEAD_RATIO = 0.7
/** 截断标记的字节预留：标记本身也占体积，不预留就会让最终文档略超预算（预算就不再是预算） */
const MARKER_RESERVE_BYTES = 512
/** 提问清单最多列几条 */
export const DISTILL_MAX_QUESTIONS = 20
/** 提问清单单条上限（字节） */
const QUESTION_BYTES = 160
/** 文件名清洗后长度上限（按 code point 计）：太长会在 Windows 上逼近 260 字符路径上限 */
export const DISTILL_NAME_MAX = 48
/** 服务端单文档上限（server/knowledge-routes.mjs MAX_DOC_BYTES）：仅用于本地预判，判据仍在服务端 */
export const SERVER_MAX_DOC_BYTES = 2 * 1024 * 1024

// ── 字节工具（不依赖 Node Buffer：同一份逻辑要能在浏览器里跑） ──

/** UTF-8 字节数。手算而不 `new TextEncoder().encode()`：后者会为每次调用分配一个可能几十 KB 的数组 */
export function utf8Bytes(s: string): number {
  let n = 0
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * 按 UTF-8 字节裁剪（**不切断代理对/组合字符**：按 code point 累加，绝不 slice 字节）。
 * 返回裁剪结果与"是否发生了裁剪"——调用方几乎总要把后者变成一句留痕文案。
 */
export function clipToBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const src = String(s ?? '')
  if (maxBytes <= 0) return { text: '', truncated: src.length > 0 }
  let n = 0
  let i = 0
  for (const ch of src) {
    const cp = ch.codePointAt(0) ?? 0
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (n + w > maxBytes) return { text: src.slice(0, i), truncated: true }
    n += w
    i += ch.length
  }
  return { text: src, truncated: false }
}

/** 只要裁剪后的文本（不留痕的调用点用；需要留痕的用 `clipToBytes`） */
export function truncateToBytes(s: string, maxBytes: number): string {
  return clipToBytes(s, maxBytes).text
}

/**
 * 代码围栏：围栏长度取"文本内最长反引号串 + 1"（CommonMark 规则）。
 * 为什么不是固定 ```：工具参数是 JSON，字符串里出现 ``` 完全可能（模型常常在参数里贴 markdown），
 * 固定长度会被内层围栏**提前闭合**，后半段正文就跑到围栏外变成普通段落（结构坏掉）。
 */
export function fenceBlock(text: string, lang = ''): string {
  const src = String(text ?? '')
  let run = 0
  let best = 0
  for (const ch of src) {
    if (ch === '`') { run++; best = Math.max(best, run) } else run = 0
  }
  const fence = '`'.repeat(Math.max(3, Math.min(best + 1, 40)))
  return `${fence}${lang}\n${src}\n${fence}`
}

// ── 命名与路径 ──

/** Windows 保留设备名（`CON.md` 这类文件在 Windows 上根本建不出来，写入会以"神秘失败"告终） */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * 会话标题 → 可用于文件名的片段。
 * 清洗：控制字符删除、Windows 非法字符 `\ / : * ? " < > |` 换 `-`、空白压 `-`、
 * 合并重复 `-`、剥掉首尾 `-`/`.`/空格（尾点与尾空格在 Windows 上是非法结尾）、
 * 保留 Windows 保留名（追加 `-doc`）、超长截断到 `maxLen` 个 code point。
 * 空标题回落 `会话`：宁可名字平淡，也不能生成空文件名（那是必然失败的写入）。
 */
export function sanitizeDistillName(title: string, maxLen: number = DISTILL_NAME_MAX): string {
  let s = String(title ?? '')
    // 控制字符（含 \r\n\t）换 `-` 而不是删掉：删掉会把两个词粘成一个（"换\n行" → "换行"），
    // 而文件名是用户唯一能看到的标识，粘词会让人认不出这是哪个会话
    .replace(/[\u0000-\u001f\u007f]/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+/, '')
    .replace(/[-. ]+$/, '')
  if (s.length > maxLen) s = [...s].slice(0, maxLen).join('')
  s = s.replace(/[-. ]+$/, '')   // 截断后可能又露出尾点/尾 `-`
  if (!s) return '会话'
  if (RESERVED_NAMES.has(s.toLowerCase())) return `${s}-doc`
  return s
}

/** FNV-1a 32 位（会话 id 不含足够字母数字时兜底：短键必须仍然是"对同一会话稳定"的） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 会话短键（路径内嵌，幂等的锚点）：取 id 内前 8 个字母数字；不足则退化为 id 的 FNV-1a。
 * 为什么不用标题：标题可改、可重名，做幂等锚点必然漂移。
 */
export function conversationKey(conv: { id?: string }): string {
  const raw = String(conv?.id ?? '')
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length >= 8) return alnum.slice(0, 8)
  if (alnum.length >= 4) return alnum
  return fnv1a(raw || 'conversation')
}

/** 本地日期 `YYYY-MM-DD`（非法时间戳返回空串，路径里就不带日期段，而不是 `NaN-NaN-NaN`） */
function formatDay(ms: number | undefined): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm`（同上，非法值返回空串） */
export function formatStamp(ms: number | undefined): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 蒸馏文档在空间内的相对路径：`<dir>/<createdAt 日期>-<清洗标题>-<会话键>.md`。
 *
 * 日期前缀取 **createdAt** 而不是 updatedAt：updatedAt 会随每次续聊变化 ⇒ 同一会话两次蒸馏
 * 得到两个路径（重复文件），幂等就废了；createdAt 终生不变。
 */
export function distillRelPath(conv: Conversation, dir: string = DISTILL_DIR): string {
  const folder = String(dir || DISTILL_DIR).replace(/^\/+|\/+$/g, '') || DISTILL_DIR
  const day = formatDay(conv?.createdAt)
  const name = sanitizeDistillName(conv?.title || '')
  const parts = [day, name, conversationKey(conv)].filter(Boolean)
  return `${folder}/${parts.join('-')}.md`
}

/** docId = `<spaceId>/<空间内相对路径>`（与内核/知识面板的既有口径一致） */
export function distillDocId(spaceId: string, rel: string): string {
  return `${String(spaceId || '').replace(/\/+$/, '')}/${String(rel || '').replace(/^\/+/, '')}`
}

/**
 * 在目标目录的列举结果里找"这篇会话既有的蒸馏文件"。
 * 判据只看**会话键后缀**（`-<key>.md`）：标题改过名、日期段变过都不影响复用 ——
 * 这正是"重复蒸馏 = 更新同一篇，而不是新建 `-2.md`"的实现处。
 */
export function findDistilledEntry<T extends { name?: string; path: string; type?: string }>(
  entries: T[] | undefined,
  conv: { id?: string },
): T | null {
  const key = conversationKey(conv).toLowerCase()
  for (const e of entries ?? []) {
    if (!e || typeof e.path !== 'string') continue
    if (e.type === 'dir') continue
    const name = String(e.name || e.path.split('/').pop() || '').toLowerCase()
    if (name.endsWith(`-${key}.md`)) return e
  }
  return null
}

/** 目标空间（本模块只依赖结构，不 import knowledgeApi —— 被测模块零运行时依赖的纪律） */
export interface DistillTarget {
  id: string
  name?: string
  /** false = 只读（知识包 `pack-*`）；缺省按可写处理（老后端不返回该字段时与既有 UI 同口径） */
  writable?: boolean
  source?: string
}

/**
 * 默认目标空间：上次选择（仍可写）→ 首个用户空间 → `session-memory` → 任一可写空间。
 *
 * 排序理由：蒸馏笔记是**用户知识**，用户空间（`source:'user'`）是自然归宿；内置可写空间里
 * `session-memory`（会话记忆）语义最贴近，"个人经验"（`experience`）是模型按条目格式维护的
 * 策展库，不该被整篇转录塞进去（条目解析见 U4）。只读空间**不进候选**——UI 预判与后端 403
 * 是双保险，不是替代（后端仍是判据）。
 */
export function pickDefaultDistillSpace<T extends DistillTarget>(
  targets: T[] | undefined,
  lastUsedId?: string | null,
): T | null {
  const writable = (targets ?? []).filter(t => t && t.writable !== false)
  if (!writable.length) return null
  const last = lastUsedId ? writable.find(t => t.id === lastUsedId) : undefined
  if (last) return last
  const user = writable.find(t => t.source === 'user')
  if (user) return user
  const memory = writable.find(t => t.id === 'session-memory')
  if (memory) return memory
  return writable[0]
}

// ── 正文渲染 ──

function clipMarked(text: string, maxBytes: number): string {
  const { text: out, truncated } = clipToBytes(text, maxBytes)
  if (!truncated) return out
  const removed = utf8Bytes(text) - utf8Bytes(out)
  return `${out}\n…（本段超出 ${maxBytes} 字节上限，已省略约 ${removed} 字节）`
}

function firstText(blocks: ContentBlock[]): string {
  for (const b of blocks ?? []) {
    if (b?.type === 'text' && typeof b.content === 'string' && b.content.trim()) return b.content
  }
  return ''
}

function toolName(b: ContentBlock): string {
  const n = (b?.metadata as Record<string, unknown> | undefined)?.toolName
  return typeof n === 'string' && n ? n : '未知工具'
}

/**
 * 单个内容块 → Markdown 片段（`''` = 该块不产出内容）。
 * 降级规则（spec D8）：text 原样保真；thinking 默认丢弃；tool_use/tool_result 保留为
 * "工具调用 + 参数/结果"（降级但**不丢弃** —— 否则"为什么改了这个文件"的证据链就断了）；
 * image/file 只留占位（附件本体不入库）。
 */
function blockToMarkdown(b: ContentBlock, opts: Required<Pick<DistillOptions, 'includeThinking' | 'maxMessageBytes' | 'maxToolBytes'>>): string {
  if (!b || typeof b !== 'object') return ''
  const content = typeof b.content === 'string' ? b.content : ''
  switch (b.type) {
    case 'text': {
      if (!content.trim()) return ''
      return clipMarked(content, opts.maxMessageBytes)
    }
    case 'thinking': {
      if (!opts.includeThinking) return ''
      const body = clipMarked(content, opts.maxToolBytes)
      if (!body.trim()) return ''
      // 引用块：思考是"旁注"，不该与正文争夺标题层级
      return `**思考**\n\n${body.split('\n').map(l => `> ${l}`).join('\n')}`
    }
    case 'tool_use': {
      const args = clipMarked(content, opts.maxToolBytes)
      const head = `**工具调用** \`${toolName(b)}\``
      const call = args.trim() ? `${head}\n\n${fenceBlock(args, 'json')}` : head
      // 转录加载层会把按 tool_use_id 匹配到的结果挂在 tool_use 块上（历史回放时工具输出不丢）
      const res = b.result
      if (res && typeof res.content === 'string' && res.content.trim()) {
        const out = clipMarked(res.content, opts.maxToolBytes)
        const label = res.isError ? '**工具结果（失败）**' : '**工具结果**'
        return `${call}\n\n${label}\n\n${fenceBlock(out)}`
      }
      return call
    }
    case 'tool_result': {
      const isErr = (b.metadata as Record<string, unknown> | undefined)?.isError === true
      const out = clipMarked(content, opts.maxToolBytes)
      return `${isErr ? '**工具结果（失败）**' : '**工具结果**'}\n\n${fenceBlock(out)}`
    }
    case 'image':
      return '〔图片〕'
    case 'file': {
      const name = (b.metadata as Record<string, unknown> | undefined)?.fileName
      return typeof name === 'string' && name ? `〔文件：${name}〕` : '〔文件〕'
    }
    default:
      return ''
  }
}

export interface DistillOptions {
  /** 空间内相对目录，缺省 `会话蒸馏` */
  dir?: string
  /** 正文预算（字节），缺省 600KB */
  budgetBytes?: number
  maxMessageBytes?: number
  maxToolBytes?: number
  /** 是否收录 thinking 块（缺省 false：体量常占全文一半以上且检索价值最低） */
  includeThinking?: boolean
  maxQuestions?: number
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user': return '用户'
    case 'assistant': return '助手'
    case 'system': return '系统'
    case 'tool': return '工具'
    default: return role || '未知'
  }
}

/**
 * 会话 → 蒸馏 Markdown（机械结构化提取）。
 *
 * 结构：frontmatter（标签/时间/模型/会话 id）→ 标题 → 元信息表 → 提问清单 → 逐轮正文 → 生成说明。
 * 提问清单是"人先看哪"的索引（首条用户消息往往就是任务陈述），也是检索时最常命中的一块。
 * 超长裁剪：头 70% + 尾 30%，中间插**显式省略标记**（不留痕的截断等同于骗用户"这是全文"）。
 */
export function conversationToMarkdown(
  conv: Conversation,
  messages: Message[],
  opts: DistillOptions = {},
): { content: string; truncated: boolean; omitted: number } {
  const o = {
    includeThinking: opts.includeThinking === true,
    maxMessageBytes: Math.max(1, opts.maxMessageBytes ?? DISTILL_MAX_MESSAGE_BYTES),
    maxToolBytes: Math.max(1, opts.maxToolBytes ?? DISTILL_MAX_TOOL_BYTES),
  }
  const budget = Math.max(0, Math.floor(opts.budgetBytes ?? DISTILL_BUDGET_BYTES))
  const maxQuestions = Math.max(0, Math.floor(opts.maxQuestions ?? DISTILL_MAX_QUESTIONS))

  const list = (messages ?? []).filter(m => m && typeof m === 'object')
  const title = String(conv?.title || '未命名会话')

  const tags = [DISTILL_TAG, ...((conv?.tags ?? []).filter(t => typeof t === 'string' && t.trim() && t.trim() !== DISTILL_TAG))]
  const front = [
    '---',
    `title: ${title.replace(/\r?\n/g, ' ')}`,
    `tags: [${tags.join(', ')}]`,
    `conversation: ${conv?.id ?? ''}`,
    `model: ${conv?.model ?? ''}`,
    `created: ${formatStamp(conv?.createdAt)}`,
    `updated: ${formatStamp(conv?.updatedAt)}`,
    'source: yfworking/distill',
    '---',
    '',
  ].join('\n')

  const metaRows: Array<[string, string]> = [
    ['会话 ID', `\`${conv?.id ?? ''}\``],
    ['创建时间', formatStamp(conv?.createdAt) || '—'],
    ['最近更新', formatStamp(conv?.updatedAt) || '—'],
    ['模型', conv?.model ? `\`${conv.model}\`` : '—'],
    ['工作目录', conv?.cwd ? `\`${conv.cwd}\`` : '—'],
    ['消息数', String(conv?.messageCount ?? list.length)],
  ]
  const header = [
    front,
    `# 会话蒸馏 · ${title}`,
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    ...metaRows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
  ].join('\n')

  // 提问清单：只取"用户消息里的第一个 text 块"，按时间顺序，逐条按字节裁剪
  const questions: string[] = []
  for (const m of list) {
    if (m.role !== 'user') continue
    const t = firstText(m.content).replace(/\s+/g, ' ').trim()
    if (!t) continue
    questions.push(clipToBytes(t, QUESTION_BYTES).text)
    if (questions.length >= maxQuestions) break
  }
  let questionBlock = ''
  if (questions.length) {
    const userTotal = list.filter(m => m.role === 'user').length
    questionBlock = [
      '## 提问清单',
      '',
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      ...(userTotal > questions.length ? ['', `> 另有 ${userTotal - questions.length} 条追问未在此列出。`] : []),
      '',
    ].join('\n')
  }

  // 逐轮渲染（先渲染好再按预算挑选：预算裁剪要对"已渲染字节数"判断，而不是对原始文本）
  const turns: string[] = []
  list.forEach((m, i) => {
    const parts = (m.content ?? [])
      .map(b => blockToMarkdown(b, o))
      .filter(s => s.trim())
    if (!parts.length) return   // 无正文（纯占位/纯 thinking）的消息不占位，免得正文全是空标题
    const stamp = formatStamp(m.timestamp)
    const head = `### ${i + 1} · ${roleLabel(m.role)}${stamp ? `（${stamp}）` : ''}`
    turns.push(`${head}\n\n${parts.join('\n\n')}\n`)
  })

  // 页脚也计入预算：漏掉它会让"预算 600KB"实际产出 600KB + 页脚（预算就不再是预算）
  const footerBlock = [
    '',
    '---',
    '',
    '本文由 YFWorking「一键蒸馏到知识库」按**机械结构化提取**生成（不调用模型，结果可复现）：',
    '内容逐轮取自原始会话，超长部分已按上限裁剪并留痕；完整原文见原始会话的回放/导出。',
    '',
  ].join('\n')

  const headBytes = utf8Bytes(header) + utf8Bytes(questionBlock) + utf8Bytes(footerBlock)
  const bodyBudget = Math.max(0, budget - headBytes - MARKER_RESERVE_BYTES)
  const turnBytes = turns.map(t => utf8Bytes(t))

  let headCount = 0
  let tailCount = 0
  let omitted = 0
  {
    const headBudget = Math.floor(bodyBudget * DISTILL_HEAD_RATIO)
    const tailBudget = bodyBudget - headBudget
    let used = 0
    while (headCount < turns.length && used + turnBytes[headCount] <= headBudget) {
      used += turnBytes[headCount]
      headCount++
    }
    let usedTail = 0
    while (tailCount < turns.length - headCount && usedTail + turnBytes[turns.length - 1 - tailCount] <= tailBudget) {
      usedTail += turnBytes[turns.length - 1 - tailCount]
      tailCount++
    }
    omitted = turns.length - headCount - tailCount
  }

  const bodyParts: string[] = ['## 对话正文', '']
  bodyParts.push(...turns.slice(0, headCount))
  if (omitted > 0) {
    bodyParts.push(
      `> …（此处省略 ${omitted} 条消息：为控制文档体积，仅保留最早的 ${headCount} 条与最近的 ${tailCount} 条）…`,
      '',
    )
  }
  if (tailCount > 0) bodyParts.push(...turns.slice(turns.length - tailCount))
  if (!turns.length) {
    bodyParts.push('> 本会话没有可提取的正文内容（可能正文未加载成功，或全部为思考/占位块）。', '')
  }

  const content = [header, questionBlock, bodyParts.join('\n'), footerBlock].join('\n')
  return { content, truncated: omitted > 0, omitted }
}

export interface DistillPlan {
  spaceId: string
  /** 空间内相对路径（`.md`） */
  path: string
  docId: string
  content: string
  bytes: number
  /** true = 命中既有蒸馏文件（应带 mtime 写入以做冲突检测） */
  reused: boolean
  truncated: boolean
  omitted: number
  title: string
}

export interface DistillPlanInput {
  conversation: Conversation
  /** **完整**正文（历史会话的正文不在内存里，须由调用方先加载，见 spec D10） */
  messages: Message[]
  spaceId: string
  /** 目标目录的既有条目（listTree 结果；拿不到时传 [] → 退化为"新建"，不阻断写入） */
  entries?: Array<{ name?: string; path: string; type?: string }>
  options?: DistillOptions
}

/**
 * 蒸馏计划：把"路径选哪个、内容是什么、多大、是否复用既有文件"一次算清。
 * 组件只负责把结果展示出来并调用写通道 —— 决策留在可测的纯函数里（这是本模块存在的唯一理由）。
 */
export function planDistill(input: DistillPlanInput): DistillPlan {
  const { conversation, messages, spaceId } = input
  const dir = input.options?.dir ?? DISTILL_DIR
  const hit = findDistilledEntry(input.entries, conversation)
  const path = hit?.path || distillRelPath(conversation, dir)
  const { content, truncated, omitted } = conversationToMarkdown(conversation, messages, input.options)
  return {
    spaceId: String(spaceId || ''),
    path,
    docId: distillDocId(spaceId, path),
    content,
    bytes: utf8Bytes(content),
    reused: !!hit,
    truncated,
    omitted,
    title: String(conversation?.title || '未命名会话'),
  }
}

/**
 * 失败文案：把后端码/HTTP 状态翻译成"用户能照着做"的一句话。
 * 关键取舍：**不吞错**（未知错误也把原始 error 拼出来），且 403 必须给出**怎么解决**
 * （去换一个可写空间），否则用户只看到"space is read-only"这种没法照做的英文短语。
 */
export function describeDistillError(
  status: number | undefined,
  error: string,
  space?: DistillTarget | null,
): string {
  const who = space?.name || space?.id || '目标空间'
  const raw = String(error ?? '')
  const readOnly = status === 403 || /read-?only/i.test(raw)
  if (readOnly) {
    return `${who} 是只读空间（知识包 pack-* 与内置只读库不允许写入）。请在「写入到」里换一个可写空间后重试。`
  }
  switch (status) {
    case 400: return `路径或内容被拒绝（只能写空间内的相对 .md 路径）：${raw}`
    case 404: return `${who} 不存在（可能已被删除）。请刷新空间列表后重试。`
    case 409: return '该文件在磁盘上已被外部修改（Obsidian/VSCode 等）。请选择是覆盖外部版本，还是放弃本次蒸馏。'
    case 413: return '会话内容超过单篇文档上限（2MB），已被服务端拒绝。请缩短会话或调小蒸馏预算。'
    case 500:
    case 502: return `知识服务出错：${raw || '未知错误'}`
    default: return `蒸馏失败：${raw || '未知错误'}`
  }
}
