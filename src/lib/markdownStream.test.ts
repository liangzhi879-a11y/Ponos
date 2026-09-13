// 流式 markdown 稳定前缀切分（R4）——node:test + node:assert（Node 24 原生 TS 剥离），运行：
//   node --test src/lib/markdownStream.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrefixFreezer, frozenPrefixLength } from './markdownStream.ts'

test('无空行：切点为 0（不能切在段落中间）', () => {
  assert.equal(frozenPrefixLength('一句话还没写完'), 0)
  assert.equal(frozenPrefixLength('第一行\n第二行'), 0)
})

test('空行边界：切点含其后的空行，两侧各自独立成段', () => {
  const text = '第一段\n\n第二段'
  const n = frozenPrefixLength(text)
  assert.equal(n, 5)
  assert.equal(text.slice(0, n), '第一段\n\n')
  assert.equal(text.slice(n), '第二段')
})

test('多个空行：取最后一个合法边界', () => {
  const text = 'a\n\nb\n\nc'
  assert.equal(text.slice(0, frozenPrefixLength(text)), 'a\n\nb\n\n')
})

test('文首的空行不算边界（避免切出空前缀）', () => {
  assert.equal(frozenPrefixLength('\n\n正文'), 0)
  assert.equal(frozenPrefixLength('   \n\n正文'), 0)
})

test('未闭合围栏内的空行不能切：退回到更早的合法边界', () => {
  const text = '引言\n\n```js\nconst a = 1\n\nconst b = 2\n'
  const n = frozenPrefixLength(text)
  assert.equal(text.slice(0, n), '引言\n\n', '围栏内的空行被跳过，切在围栏之前')
})

test('围栏闭合后，其后的空行恢复可切', () => {
  const text = '引言\n\n```js\nconst a = 1\n```\n\n后文'
  const n = frozenPrefixLength(text)
  assert.equal(text.slice(0, n), '引言\n\n```js\nconst a = 1\n```\n\n')
})

test('围栏内容里的"空行"不影响围栏外已成立的边界（奇偶性是位置属性）', () => {
  const f = createPrefixFreezer()
  const head = '甲\n\n'
  assert.equal(f.feed(head), 3)
  // 追加一个未闭合围栏：前缀结论不变（既有边界仍然合法）
  assert.equal(f.feed(head + '```\n'), 3)
})

test('只认完整行：末尾那半行不参与判定（它下一步可能长出内容）', () => {
  const f = createPrefixFreezer()
  // 末尾是"没有换行的空白"：不算空行边界（否则会把可能还在写的半行冻进前缀）
  assert.equal(f.feed('甲\n\n   '), 3)
  // 末尾是半截围栏行：仍按"围栏外"处理，上一行空行的边界照常成立
  assert.equal(f.feed('甲\n\n``'), 3)
  // 一旦补成完整围栏行，其后的空行就不再可切（奇偶性变奇）
  assert.equal(f.feed('甲\n\n```\ncode\n\n'), 3)
  assert.equal(f.feed('甲\n\n```\ncode\n```\n\n尾'), 17)
})

test('增量：切点单调推进，且总扫描量与文本长度同阶（不是每帧重扫全文）', () => {
  const f = createPrefixFreezer()
  const chunks: string[] = []
  let text = ''
  let last = 0
  for (let i = 0; i < 50; i++) {
    text += `第${i}段内容\n\n`
    chunks.push(text)
    const n = f.feed(text)
    assert.ok(n >= last, '切点只前进不回退')
    last = n
  }
  assert.equal(f.feed(text), text.length, '全文以空行结尾 ⇒ 整段可冻结')
  const total = text.length
  assert.ok(f.scannedChars <= total * 2 + 64, `扫描量 ${f.scannedChars} 应约等于文本长度 ${total}（允许常数倍）`)
})

test('同一文本重复 feed 是零成本（流式期"这一帧没有新内容"）', () => {
  const f = createPrefixFreezer()
  const text = '甲\n\n乙\n\n丙'
  f.feed(text)
  const before = f.scannedChars
  assert.equal(f.feed(text), f.feed(text))
  assert.equal(f.scannedChars, before, '重复喂入不增加扫描量')
})

test('文本被截断（半截 ASK_USER 标记）⇒ 结论作废，重扫', () => {
  const f = createPrefixFreezer()
  assert.equal(f.feed('正文\n\n更多\n\n<!-- ASK_USER 半截'), 8)
  // truncatePartialAskUser 会把标记起点之后砍掉 ⇒ 变短
  assert.equal(f.feed('正文\n'), 0, '截断后只剩一行，没有合法边界')
})

test('文本被整体回写（等长不同内容）⇒ 锚点识别并重扫', () => {
  const f = createPrefixFreezer()
  assert.equal(f.feed('甲甲甲\n\n乙'), 5)
  const rewritten = '丙丙丙\n\n丁'
  assert.equal(rewritten.length, '甲甲甲\n\n乙'.length)
  assert.equal(f.feed(rewritten), 5, '重扫后按新内容给切点')
  assert.equal(rewritten.slice(0, 5), '丙丙丙\n\n')
})

test('围栏外的边界在后续帧里始终保持合法（不会因新增内容而失效）', () => {
  const f = createPrefixFreezer()
  let text = '说明\n\n```\ncode\n```\n\n'
  const n1 = f.feed(text)
  assert.equal(text.slice(0, n1), text, '整段可冻结')
  text += '| a | b |\n|---|---|\n| 1 | 2 |'
  const n2 = f.feed(text)
  assert.equal(n2, n1, '表格还没出现空行 ⇒ 切点不动')
  text += '\n\n结尾'
  assert.equal(f.feed(text), text.length - 2, '表格后的空行推进切点')
})

test('缩进/空格的行不算空行边界（只有真空白行才切）', () => {
  assert.equal(frozenPrefixLength('  \n  正文'), 0)
})

// 不变量的**差分**断言：增量喂出来的结论，必须与"每帧丢弃状态、从头重算"逐字节一致。
// 这条覆盖前一条测不到的组合（围栏中途开合、截断、回写、列表/表格混排），也是"增量"
// 这个改动唯一可能出错的地方——它比任何单点用例都更能钉住语义。
test('差分：增量结论 ≡ 每帧从头重算（含围栏开合、截断、回写、混排）', () => {
  const stream = [
    '这是一段引言，还没写完',
    '，接着写完了。\n\n',
    '## 小节\n\n```js\nconst a = 1\n',
    '\nconst b = 2\n',          // 围栏内出现空行：这一处绝不能切
    '```\n\n',
    '| 列 | 值 |\n|---|---|\n| a | 1 |',
    '\n\n',
    '- 列表项一\n- 列表项二',
    '\n\n   ',                  // 末尾半行空白（不构成边界）
    '尾声\n\n',
  ]
  const f = createPrefixFreezer()
  let text = ''
  for (const chunk of stream) {
    text += chunk
    assert.equal(f.feed(text), frozenPrefixLength(text), `长度 ${text.length} 处增量与全量不一致`)
  }
  // 截断（truncatePartialAskUser 砍掉半截标记）与整体回写，也必须与全量结论一致
  for (const truncated of [text.slice(0, 12), text.slice(0, 40), '另起一段\n\n新的正文']) {
    assert.equal(f.feed(truncated), frozenPrefixLength(truncated), `截断/回写到 ${truncated.length} 后不一致`)
  }
})
