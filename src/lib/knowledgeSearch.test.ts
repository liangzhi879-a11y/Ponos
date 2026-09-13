// src/lib/knowledgeSearch.test.ts —— 搜索视图纯逻辑（node --test，S2 Task 7）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KB_FOCUS_SEARCH_EVENT, maxScore, parseKeywords, searchTerms, splitHighlight, strengthLevel,
} from './knowledgeSearch.ts'

test('parseKeywords：中文逗号/分号/空白都当分隔符，去重保序', () => {
  assert.deepEqual(parseKeywords('企微,CLI，文件传输; 助手'), ['企微', 'CLI', '文件传输', '助手'])
  assert.deepEqual(parseKeywords(' word , word ,, '), ['word'])
  assert.deepEqual(parseKeywords(''), [])
})

test('searchTerms：查询串在前、长词优先、去重', () => {
  // 长词在前：否则 `文件` 会先把 `文件传输助手` 切碎，同一处命中被高亮两次
  assert.deepEqual(searchTerms('文件传输助手', ['文件']), ['文件传输助手', '文件'])
  assert.deepEqual(searchTerms('  ', ['', '  ']), [])
  assert.deepEqual(searchTerms('a', ['a', 'ab']), ['ab', 'a'])
})

test('splitHighlight：命中片段切分（大小写不敏感）', () => {
  assert.deepEqual(splitHighlight('Hello World', ['world']), [
    { text: 'Hello ', hit: false }, { text: 'World', hit: true },
  ])
  assert.deepEqual(splitHighlight('命中关键词与关键词', ['关键词']), [
    { text: '命中', hit: false }, { text: '关键词', hit: true },
    { text: '与', hit: false }, { text: '关键词', hit: true },
  ])
})

test('splitHighlight：正则元字符必须转义（用户会搜 c++ / fs( ）', () => {
  assert.deepEqual(splitHighlight('用 c++ 写', ['c++']), [
    { text: '用 ', hit: false }, { text: 'c++', hit: true }, { text: ' 写', hit: false },
  ])
  // 不转义会抛 Invalid regular expression —— 通过即证明没抛
  assert.equal(splitHighlight('fs(1)', ['fs(']).filter(c => c.hit).length, 1)
})

test('splitHighlight：无词典/空文本不产生碎片', () => {
  assert.deepEqual(splitHighlight('abc', []), [{ text: 'abc', hit: false }])
  assert.deepEqual(splitHighlight('', ['a']), [])
  assert.deepEqual(splitHighlight('abc', ['zzz']), [{ text: 'abc', hit: false }])
})

test('strengthLevel：按本次最大分归一到 3 档（非法分母回落 1 档）', () => {
  assert.equal(strengthLevel(10, 10), 3)
  assert.equal(strengthLevel(5, 10), 2)
  assert.equal(strengthLevel(1, 10), 1)
  assert.equal(strengthLevel(2, 10), 1)      // 0.2 < 0.4
  assert.equal(strengthLevel(4, 10), 2)      // 0.4 边界含
  assert.equal(strengthLevel(7.5, 10), 3)    // 0.75 边界含
  assert.equal(strengthLevel(1, 0), 1)
  assert.equal(strengthLevel(1, Number.NaN), 1)
})

test('maxScore：取本集最大分，脏数据不影响', () => {
  assert.equal(maxScore([]), 0)
  assert.equal(maxScore([{ score: 3 } as never, { score: 9 } as never, { score: Number.NaN } as never]), 9)
})

test('事件名是仓库既有 yfworking: 前缀约定', () => {
  assert.match(KB_FOCUS_SEARCH_EVENT, /^yfworking:/)
})
