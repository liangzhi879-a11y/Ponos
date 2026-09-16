// src/lib/sessionDistill.test.ts
// node --test src/lib/sessionDistill.test.ts
//
// 覆盖 spec A1/A2/A4/A7 + 每个纯函数的边界。这些逻辑的错法都很安静：
// 文件名里带 `?` 会让写入以"神秘失败"结束、超长裁剪不留痕会让用户以为蒸的是全文、
// 复用识别漏掉就每蒸一次多一份副本、字节预算算错就被服务端 413。
// 都属于"没人测就等于没有"。断言只对**行为**，不对实现细节（改实现不该改测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTILL_DIR,
  DISTILL_TAG,
  SERVER_MAX_DOC_BYTES,
  clipToBytes,
  conversationKey,
  conversationToMarkdown,
  describeDistillError,
  distillDocId,
  distillRelPath,
  fenceBlock,
  findDistilledEntry,
  formatStamp,
  pickDefaultDistillSpace,
  planDistill,
  sanitizeDistillName,
  truncateToBytes,
  utf8Bytes,
} from './sessionDistill.ts'
import type { Conversation, Message, ContentBlock } from '../types/index.ts'

// —— 测试夹具 ——

function block(b: Partial<ContentBlock> & { type: ContentBlock['type'] }): ContentBlock {
  return { id: `b${Math.random()}`, content: '', ...b } as ContentBlock
}

function msg(role: Message['role'], blocks: ContentBlock[], ts = 1_700_000_000_000): Message {
  return { id: `m${Math.random()}`, role, content: blocks, timestamp: ts }
}

/** 2026-09-15 10:00 本地时间（用本地构造避免时区导致日期断言漂移） */
const T = new Date(2026, 8, 15, 10, 0, 0).getTime()
const T2 = new Date(2026, 8, 16, 11, 30, 0).getTime()

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'abcd1234efgh5678',
    title: '知识库导入功能开发',
    messages: [],
    createdAt: T,
    updatedAt: T,
    model: 'claude-sonnet-4',
    ...over,
  }
}

// —— 字节工具 ——

test('utf8Bytes：ASCII/中文/emoji 计数与 TextEncoder 一致', () => {
  const cases = ['', 'abc', '中文三字节', 'a中🙂b', '🙂🙂', 'é']
  const enc = new TextEncoder()
  for (const s of cases) {
    assert.equal(utf8Bytes(s), enc.encode(s).length, `utf8Bytes(${JSON.stringify(s)})`)
  }
  assert.equal(utf8Bytes('中'), 3)
  assert.equal(utf8Bytes('🙂'), 4, '代理对必须算 4 字节，不能按 UTF-16 长度算 2')
  assert.equal(utf8Bytes(undefined as unknown as string), 0, '脏输入不抛，按 0 处理')
})

test('clipToBytes / truncateToBytes：按字节裁、不切断 emoji、maxBytes=0 与负数安全', () => {
  assert.deepEqual(clipToBytes('abc', 3), { text: 'abc', truncated: false })
  assert.deepEqual(clipToBytes('abc', 2), { text: 'ab', truncated: true })
  // 中文：3 字节一个 → 4 字节上限只能留下 1 个字
  assert.deepEqual(clipToBytes('中文测试', 4), { text: '中', truncated: true })
  const emoji = clipToBytes('a🙂b', 2)   // 'a'(1) + '🙂'(4) 超限 ⇒ 只留 'a'
  assert.equal(emoji.text, 'a')
  assert.equal(emoji.truncated, true)
  assert.equal(emoji.text.includes('\uFFFD'), false, '不得产出半个代理对（U+FFFD）')
  assert.deepEqual(clipToBytes('abc', 0), { text: '', truncated: true })
  assert.deepEqual(clipToBytes('', 0), { text: '', truncated: false }, '空串不算被截断')
  assert.deepEqual(clipToBytes('abc', -5), { text: '', truncated: true })
  assert.equal(truncateToBytes('中文测试', 7), '中文')
})

test('fenceBlock：围栏长度随文本内最长反引号串增长（内层 ``` 不得提前闭合外层）', () => {
  assert.equal(fenceBlock('x'), '```\nx\n```')
  assert.equal(fenceBlock('x', 'json'), '```json\nx\n```')
  const inner = 'a\n```js\nb\n```\nc'
  const fenced = fenceBlock(inner)
  assert.ok(fenced.startsWith('````\n'), '文本含 ``` ⇒ 外层围栏取 4 个反引号')
  assert.ok(fenced.endsWith('\n````'))
  // 极端：超长反引号串要被钳到上限，不能生成 40+ 个反引号
  const long = '`'.repeat(80)
  assert.ok(fenceBlock(long).startsWith('````````````````````````````````````````\n'), '围栏钳到 40')
})

// —— 命名与路径 ——

test('sanitizeDistillName：非法字符/控制字符/尾点/空标题/保留名/超长', () => {
  assert.equal(sanitizeDistillName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(sanitizeDistillName('  多  空   白  '), '多-空-白')
  assert.equal(sanitizeDistillName('尾点...'), '尾点')
  assert.equal(sanitizeDistillName('尾空格   '), '尾空格')
  assert.equal(sanitizeDistillName('换\n行\r符\t'), '换-行-符')
  assert.equal(sanitizeDistillName(''), '会话', '空标题必须回落到可用的名字（空文件名必然写失败）')
  assert.equal(sanitizeDistillName('   '), '会话')
  assert.equal(sanitizeDistillName('CON'), 'CON-doc', 'Windows 保留设备名不能当文件名')
  assert.equal(sanitizeDistillName('nul'), 'nul-doc')
  const long = sanitizeDistillName('长'.repeat(200))
  assert.equal([...long].length, 48, '超长按 code point 截到 48')
  assert.equal(sanitizeDistillName('中文标题保留'), '中文标题保留', '中文本身就是合法文件名字符')
})

test('conversationKey：同一会话稳定、不同会话不同、非字母数字 id 走哈希兜底', () => {
  assert.equal(conversationKey({ id: 'abcd1234efgh5678' }), 'abcd1234')
  assert.equal(conversationKey({ id: 'abcd1234efgh5678' }), conversationKey({ id: 'abcd1234efgh5678' }))
  assert.notEqual(conversationKey({ id: 'aaaa1111' }), conversationKey({ id: 'bbbb2222' }))
  const h1 = conversationKey({ id: '会话-一' })
  const h2 = conversationKey({ id: '会话-二' })
  assert.match(h1, /^[0-9a-f]{8}$/, '全非字母数字 id 退化为 FNV-1a')
  assert.notEqual(h1, h2)
  assert.equal(conversationKey({}), conversationKey({}), '缺 id 也不得抛')
  assert.equal(conversationKey({ id: 'ab12' }), 'ab12', '4–7 位短键直接用（仍稳定）')
})

test('distillRelPath：日期取 createdAt（不是 updatedAt）、目录可覆盖、脏时间戳不留 NaN', () => {
  const c = conv()
  assert.equal(distillRelPath(c), `${DISTILL_DIR}/2026-09-15-知识库导入功能开发-abcd1234.md`)
  // 续聊后 updatedAt 变了：路径**必须**不变，否则每次蒸馏都在建新文件（幂等破裂）
  assert.equal(distillRelPath({ ...c, updatedAt: T2 }), distillRelPath(c))
  assert.equal(distillRelPath(c, '/会话/'), '会话/2026-09-15-知识库导入功能开发-abcd1234.md')
  assert.equal(distillRelPath(conv({ createdAt: 0, updatedAt: 0 })), `${DISTILL_DIR}/知识库导入功能开发-abcd1234.md`)
  assert.equal(distillRelPath(conv({ title: 'a/b' })), `${DISTILL_DIR}/2026-09-15-a-b-abcd1234.md`)
  assert.ok(!distillRelPath(conv({ createdAt: Number.NaN })).includes('NaN'))
})

test('distillDocId：拼 `<space>/<rel>`，容忍多余斜杠', () => {
  assert.equal(distillDocId('notes', '会话蒸馏/a.md'), 'notes/会话蒸馏/a.md')
  assert.equal(distillDocId('notes/', '/会话蒸馏/a.md'), 'notes/会话蒸馏/a.md')
})

test('findDistilledEntry：按会话键后缀复用（标题/日期变了也能认出同一次蒸馏）', () => {
  const c = conv()
  const entries = [
    { name: '会话蒸馏', path: '会话蒸馏', type: 'dir' as const },
    { name: '2026-09-15-旧标题-abcd1234.md', path: '会话蒸馏/2026-09-15-旧标题-abcd1234.md', type: 'file' as const },
    { name: '2026-09-15-别人的-ffff9999.md', path: '会话蒸馏/2026-09-15-别人的-ffff9999.md', type: 'file' as const },
  ]
  const hit = findDistilledEntry(entries, c)
  assert.equal(hit?.path, '会话蒸馏/2026-09-15-旧标题-abcd1234.md', '标题改过名也要复用同一篇')
  assert.equal(findDistilledEntry([entries[2]], c), null)
  assert.equal(findDistilledEntry([], c), null)
  assert.equal(findDistilledEntry(undefined, c), null)
  // 目录项自身即便名字碰巧匹配也不算命中（那是目录，不是蒸馏文件）
  assert.equal(findDistilledEntry([{ name: 'x-abcd1234.md', path: 'x', type: 'dir' }], c), null)
})

// —— 空间选择 ——

test('pickDefaultDistillSpace：上次选择 → 用户空间 → session-memory → 任一可写；只读不进候选', () => {
  const spaces = [
    { id: 'pack-foo', name: '只读包', writable: false, source: 'pack' },
    { id: 'experience', name: '个人经验', writable: true, source: 'experience' },
    { id: 'session-memory', name: '会话记忆', writable: true, source: 'memory' },
    { id: 'notes', name: '我的笔记', writable: true, source: 'user' },
  ]
  assert.equal(pickDefaultDistillSpace(spaces)?.id, 'notes', '默认落在用户空间')
  assert.equal(pickDefaultDistillSpace(spaces, 'session-memory')?.id, 'session-memory', '上次选择优先')
  assert.equal(pickDefaultDistillSpace(spaces, 'pack-foo')?.id, 'notes', '上次选择若已变只读则忽略')
  assert.equal(pickDefaultDistillSpace([spaces[0], spaces[2]])?.id, 'session-memory', '无用户空间时退到会话记忆')
  assert.equal(pickDefaultDistillSpace([spaces[0]])?.id, undefined, '全只读 ⇒ 无可选目标')
  assert.equal(pickDefaultDistillSpace([spaces[0]]), null)
  assert.equal(pickDefaultDistillSpace(undefined), null)
  // writable 缺省（老后端不返回该字段）按可写处理，与既有 UI 口径一致
  assert.equal(pickDefaultDistillSpace([{ id: 'x', source: 'user' }])?.id, 'x')
})

// —— Markdown 生成 ——

test('conversationToMarkdown：frontmatter/元信息表/提问清单/逐轮正文齐备', () => {
  const c = conv({ cwd: 'C:/work', messageCount: 2, tags: ['研发'] })
  const messages = [
    msg('user', [block({ type: 'text', content: '把知识库导入做出来' })], T),
    msg('assistant', [block({ type: 'text', content: '已完成，见下。' })], T + 1000),
  ]
  const r = conversationToMarkdown(c, messages)
  assert.ok(r.content.startsWith('---\n'), 'frontmatter 必须在首行（内核只认首行 frontmatter）')
  assert.ok(r.content.includes(`tags: [${DISTILL_TAG}, 研发]`))
  assert.ok(r.content.includes(`conversation: ${c.id}`))
  assert.ok(r.content.includes('# 会话蒸馏 · 知识库导入功能开发'))
  assert.ok(r.content.includes('| 工作目录 | `C:/work` |'))
  assert.ok(r.content.includes('## 提问清单'))
  assert.ok(r.content.includes('1. 把知识库导入做出来'))
  assert.ok(r.content.includes('## 对话正文'))
  assert.ok(r.content.includes('### 1 · 用户'))
  assert.ok(r.content.includes('### 2 · 助手'))
  assert.equal(r.truncated, false)
  assert.equal(r.omitted, 0)
})

test('空会话 / 无正文：仍产出可读文档，且不留空标题', () => {
  const empty = conversationToMarkdown(conv(), [])
  assert.ok(empty.content.includes('# 会话蒸馏'), '空会话也要有标题（否则索引里是一篇无名文档）')
  assert.ok(empty.content.includes('本会话没有可提取的正文内容'))
  assert.equal(empty.truncated, false)

  // 只有 thinking：默认丢弃 ⇒ 不得留下一个空标题
  const thinking = conversationToMarkdown(conv(), [msg('assistant', [block({ type: 'thinking', content: '想一下' })])])
  assert.ok(!thinking.content.includes('### 1 · 助手'), '纯思考消息不该占一个空小节')
  assert.ok(!thinking.content.includes('想一下'), '默认不收录思考')
})

test('includeThinking=true 时思考以引用块收录', () => {
  const r = conversationToMarkdown(
    conv(),
    [msg('assistant', [block({ type: 'thinking', content: '先看目录\n再读文件' })])],
    { includeThinking: true },
  )
  assert.ok(r.content.includes('**思考**'))
  assert.ok(r.content.includes('> 先看目录'))
  assert.ok(r.content.includes('> 再读文件'))
})

test('代码块保真：正文里的围栏结构原样保留（含内层围栏）', () => {
  const code = '说明：\n\n```ts\nexport const a = 1\n```\n\n以及 ```js 行内围栏'
  const r = conversationToMarkdown(conv(), [msg('assistant', [block({ type: 'text', content: code })])])
  assert.ok(r.content.includes('```ts\nexport const a = 1\n```'), '代码块不得被转义/破坏')
})

test('工具块降级：tool_use 带参数与挂接结果、tool_result 失败标记、图片/文件占位', () => {
  const use = block({
    type: 'tool_use',
    content: '{\n  "path": "a.md"\n}',
    metadata: { toolName: 'Read' },
    result: { content: 'file body', isError: false },
  })
  const useErr = block({
    type: 'tool_use',
    content: '{}',
    metadata: { toolName: 'Bash' },
    result: { content: 'boom', isError: true },
  })
  const tr = block({ type: 'tool_result', content: 'stdout···', metadata: { isError: true } })
  const img = block({ type: 'image', content: 'base64…' })
  const file = block({ type: 'file', content: '', metadata: { fileName: 'report.pdf' } })
  const r = conversationToMarkdown(conv(), [msg('assistant', [use, useErr, tr, img, file])])
  assert.ok(r.content.includes('**工具调用** `Read`'))
  assert.ok(r.content.includes('```json\n{\n  "path": "a.md"\n}\n```'))
  assert.ok(r.content.includes('**工具结果**\n\n```\nfile body\n```'), '挂接在 tool_use 上的结果不得丢')
  assert.ok(r.content.includes('**工具结果（失败）**'))
  assert.ok(r.content.includes('〔图片〕'))
  assert.ok(r.content.includes('〔文件：report.pdf〕'))
  assert.ok(!r.content.includes('base64'), '图片字节不入库')
})

test('单条消息超限：留痕裁剪（写明省略了多少字节）', () => {
  const long = '字'.repeat(2000)   // 6000 字节
  const r = conversationToMarkdown(conv(), [msg('user', [block({ type: 'text', content: long })])], { maxMessageBytes: 300 })
  assert.ok(r.content.includes('已省略约'), '裁剪必须留痕：静默截断等于骗用户"这是全文"')
  assert.ok(!r.content.includes(long), '超限内容不得整段进文档')
})

test('A7 超长会话：头尾保留 + 省略标记 + 文档字节不超预算/远低于服务端上限', () => {
  const messages: Message[] = []
  for (let i = 0; i < 40; i++) {
    messages.push(msg('user', [block({ type: 'text', content: `第${i}问：${'字'.repeat(200)}` })], T + i))
    messages.push(msg('assistant', [block({ type: 'text', content: `第${i}答：${'答'.repeat(200)}` })], T + i + 1))
  }
  const budget = 20_000
  const r = conversationToMarkdown(conv(), messages, { budgetBytes: budget })
  assert.equal(r.truncated, true)
  assert.ok(r.omitted > 0)
  assert.ok(r.content.includes(`此处省略 ${r.omitted} 条消息`), '省略必须留痕并说明保留策略')
  assert.ok(r.content.includes('第0问'), '头部（任务陈述）必须留下')
  assert.ok(r.content.includes('第39答'), '尾部（结论）必须留下')
  assert.ok(!r.content.includes('第20问答'), '中段过程应被裁掉')
  const bytes = utf8Bytes(r.content)
  assert.ok(bytes <= budget, `字节预算必须成立：${bytes} > ${budget}`)
  assert.ok(bytes < SERVER_MAX_DOC_BYTES)
})

test('formatStamp：合法时间戳 → 本地 `YYYY-MM-DD HH:mm`，脏值 → 空串', () => {
  assert.equal(formatStamp(T), '2026-09-15 10:00')
  assert.equal(formatStamp(undefined), '')
  assert.equal(formatStamp(0), '')
  assert.equal(formatStamp(Number.NaN), '')
})

// —— 计划（幂等/复用/字节口径） ——

test('A2 幂等：同一会话两次 planDistill → 同 path/docId/content 逐字节相同', () => {
  const c = conv()
  const messages = [
    msg('user', [block({ type: 'text', content: '问题一' })], T),
    msg('assistant', [block({ type: 'text', content: '回答一' })], T + 1),
  ]
  const a = planDistill({ conversation: c, messages, spaceId: 'notes' })
  const b = planDistill({ conversation: c, messages, spaceId: 'notes' })
  assert.deepEqual(a, b, '机械提取必须完全可复现（含"内容里不含当前时间"这条约束）')
  assert.equal(a.path, `${DISTILL_DIR}/2026-09-15-知识库导入功能开发-abcd1234.md`)
  assert.equal(a.docId, `notes/${a.path}`)
  assert.equal(a.bytes, utf8Bytes(a.content))
  assert.equal(a.reused, false)
})

test('复用既有文件：entries 命中 → reused=true 且沿用原 path（不新建 -2.md）', () => {
  const existing = { name: '2026-09-15-旧名-abcd1234.md', path: '会话蒸馏/2026-09-15-旧名-abcd1234.md', type: 'file' as const }
  const plan = planDistill({
    conversation: conv(),
    messages: [msg('user', [block({ type: 'text', content: 'hi' })])],
    spaceId: 'notes',
    entries: [existing],
  })
  assert.equal(plan.reused, true)
  assert.equal(plan.path, existing.path)
  assert.equal(plan.docId, `notes/${existing.path}`)
})

test('planDistill：目标目录列举拿不到（[] / undefined）时退化为新建，不阻断写入', () => {
  assert.equal(planDistill({ conversation: conv(), messages: [], spaceId: 'notes', entries: [] }).reused, false)
  assert.equal(planDistill({ conversation: conv(), messages: [], spaceId: 'notes' }).reused, false)
  assert.equal(planDistill({ conversation: conv(), messages: [], spaceId: 'notes' }).spaceId, 'notes')
})

// —— 失败文案 ——

test('describeDistillError：只读空间给"怎么解决"，其余码保留原始错误（不吞错）', () => {
  const ro = { id: 'pack-foo', name: '只读包', writable: false }
  const m403 = describeDistillError(403, 'space is read-only', ro)
  assert.ok(m403.includes('只读包'))
  assert.ok(m403.includes('换一个可写空间'), '必须给出可照做的下一步')
  assert.ok(describeDistillError(undefined, 'space is read-only', ro).includes('只读'), '状态码缺失时按错误文本兜底判只读')
  assert.ok(describeDistillError(404, 'space not found', { id: 'ghost' }).includes('ghost'))
  assert.ok(describeDistillError(409, 'conflict').includes('外部修改'))
  assert.ok(describeDistillError(413, 'document too large（上限 2MB）').includes('2MB'))
  assert.ok(describeDistillError(400, 'invalid path').includes('invalid path'))
  assert.ok(describeDistillError(undefined, 'ECONNREFUSED').includes('ECONNREFUSED'), '未知错误必须原样带出')
  assert.ok(describeDistillError(500, '').includes('知识服务出错'))
})
