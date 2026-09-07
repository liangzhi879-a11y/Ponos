import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAskUserPayload, extractAskUserBlocks } from './askuser.mjs'

const VALID = '{"questions":[{"id":"q1","header":"测试","question":"要不要继续？","options":[{"label":"继续","description":"继续推进"}],"multiSelect":false}],"context":"背景"}'

test('严格 JSON 载荷解析成功', () => {
  const d = parseAskUserPayload(VALID)
  assert.ok(d)
  assert.equal(d.questions[0].question, '要不要继续？')
  assert.equal(d.context, '背景')
})

test('JS 对象字面量风格（键/中文值不带引号、尾逗号）解析成功', () => {
  const src = `{questions:[{id:q1, header:下一步, question:是否继续, options:[{label:继续, description:保持现状},{label:停止}], multiSelect:false,}], context:任务背景,}`
  const d = parseAskUserPayload(src)
  assert.ok(d)
  assert.equal(d.questions[0].header, '下一步')
  assert.equal(d.questions[0].options.length, 2)
  assert.equal(d.questions[0].options[1].description, undefined)
})

test('markdown 代码围栏包裹的载荷解析成功', () => {
  const src = '```json\n' + VALID + '\n```'
  const d = parseAskUserPayload(src)
  assert.ok(d)
  assert.equal(d.questions[0].id, 'q1')
})

test('载荷含 --> 箭头（描述里出现）时按 } 结尾正确闭合', () => {
  const src = '{"questions":[{"id":"q1","header":"h","question":"选哪个？","options":[{"label":"A","description":"x --> y"},{"label":"B","description":""}],"multiSelect":false}],"context":""}'
  const d = parseAskUserPayload(src)
  assert.ok(d)
  assert.equal(d.questions[0].options[0].description, 'x --> y')
})

test('非法载荷返回 null', () => {
  assert.equal(parseAskUserPayload('not json at all'), null)
  assert.equal(parseAskUserPayload('{"a":1}'), null)
  assert.equal(parseAskUserPayload(''), null)
})

test('extract 剥离完整卡片并返回 payloadText', () => {
  const text = '前言文本\n<!--ASK_USER\n' + VALID + '\n-->\n结尾'
  const r = extractAskUserBlocks(text)
  assert.equal(r.blocks.length, 1)
  assert.equal(r.blocks[0].payloadText, VALID)
  assert.equal(r.clean, '前言文本\n\n结尾')
})

test('extract 宽容 <!-- 与 ASK_USER 间空白', () => {
  const r = extractAskUserBlocks('a <!-- ASK_USER ' + VALID + ' --> b')
  assert.equal(r.blocks.length, 1)
  assert.equal(r.clean, 'a  b')
})

test('extract 多张卡片逐一剥离', () => {
  const text = `<!--ASK_USER ${VALID} --> 中段 <!--ASK_USER ${VALID} --> 尾`
  const r = extractAskUserBlocks(text)
  assert.equal(r.blocks.length, 2)
  assert.equal(r.clean, ' 中段  尾')
})

test('extract 未闭合半截标记：已完成块剥离，未闭合尾部留在 clean 交给渲染层截断', () => {
  const text = '正文\n<!--ASK_USER ' + VALID + ' -->\n然后 <!--ASK_USER 未闭合'
  const r = extractAskUserBlocks(text)
  assert.equal(r.blocks.length, 1)
  // 未闭合部分保留在 clean（由前端渲染层 truncatePartialAskUser 截断兜底）
  assert.equal(r.clean, '正文\n\n然后 <!--ASK_USER 未闭合')
})

test('extract 完全未闭合：无块，尾部保留在 clean（渲染层截断）', () => {
  const r = extractAskUserBlocks('正文 <!--ASK_USER 半截')
  assert.equal(r.blocks.length, 0)
  assert.equal(r.clean, '正文 <!--ASK_USER 半截')
})

test('extract 无卡片：原样返回', () => {
  const r = extractAskUserBlocks('普通文本')
  assert.equal(r.blocks.length, 0)
  assert.equal(r.clean, '普通文本')
})

test('payload 解析失败仍能剥离（保证原始 HTML 不进渲染层）', () => {
  const text = '说明\n<!--ASK_USER {broken payload\n-->\n结尾'
  const r = extractAskUserBlocks(text)
  assert.equal(r.blocks.length, 1)
  assert.equal(parseAskUserPayload(r.blocks[0].payloadText), null)
  assert.equal(r.clean, '说明\n\n结尾')
})
