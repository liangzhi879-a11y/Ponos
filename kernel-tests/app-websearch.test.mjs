// M2：用户明确要求"原生应用常有开源 CLI，LLM 执行时需要联网确认"。
// 探测不到本机 CLI ≠ 没有 CLI：模型应能联网确认并给出线索。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildSearchBody, parseSearchResponse, searchWeb } = require('../electron/app-websearch.cjs')

test('buildSearchBody：带回数上限，避免一次抓回一大堆', () => {
  const b = buildSearchBody('Aseprite CLI', 5)
  assert.deepEqual(b.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
  assert.ok(JSON.stringify(b.messages).includes('Aseprite CLI'))
})

test('parseSearchResponse：抽取正文与来源清单', () => {
  const r = parseSearchResponse({
    content: [
      { type: 'text', text: 'Aseprite 提供 --batch 等命令行开关。' },
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', title: 'Aseprite CLI', url: 'https://www.aseprite.org/docs/cli/' },
      ] },
    ],
  })
  assert.ok(r.text.includes('--batch'))
  assert.deepEqual(r.sources, [{ title: 'Aseprite CLI', url: 'https://www.aseprite.org/docs/cli/' }])
})

test('parseSearchResponse：结果异常时返回空而不是抛（联网失败不该中断生成）', () => {
  assert.deepEqual(parseSearchResponse(null), { text: '', sources: [] })
  assert.deepEqual(parseSearchResponse({}), { text: '', sources: [] })
})

test('★ searchWeb：注入假 fetch 时能拿到结果；网络异常 → ok:false 带原因（不抛）', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '找到 aseprite-cli' }] }) })
  const r = await searchWeb({ query: 'aseprite cli', provider: { url: 'https://api.example/v1/messages', token: 't', model: 'm' }, fetchImpl: okFetch })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('aseprite-cli'))

  const bad = await searchWeb({ query: 'x', provider: { url: 'u', token: 't', model: 'm' }, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ECONNREFUSED/)
})

test('searchWeb：没有 provider 配置时如实报错（不静默返回空）', async () => {
  const r = await searchWeb({ query: 'x', provider: null, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /未配置|provider/i)
})
