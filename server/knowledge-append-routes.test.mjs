// S6：`/knowledge/append` 与 `/knowledge/tags` 路由测试。
// 纪律同 knowledge-routes.test.mjs：**直调 handler + 注入假 callKernel**，不起 bridge、
// 不起内核子进程（本仓库有"测试起桥误杀运行中应用"的前车之鉴）。
//
// 本文件钉住的是**路由层的映射规则**（转发成什么 argv、状态码怎么定），
// 不是内核校验本身（那在 kernel-tests/memory-append.test.mjs）。分层的理由：
// 路由一旦"重写一套判据"，两处口径必然漂移 —— 故这里只验证它**没有**自作主张。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleKnowledgeRoute } from './knowledge-routes.mjs'

function ctx({ method = 'GET', url = '/knowledge/tags', body = null, callKernel } = {}) {
  const u = new URL(`http://x${url}`)
  return {
    method, pathname: u.pathname, searchParams: u.searchParams,
    readJsonBody: async () => body,
    callKernel: callKernel || (async () => '{}'),
  }
}
/** 假内核：记录 argv，返回预设 JSON 字符串 */
function fakeKernel(responder = () => ({})) {
  const calls = []
  const fn = async (argsList) => {
    calls.push(argsList)
    return JSON.stringify(responder(argsList))
  }
  fn.calls = calls
  return fn
}

test('GET /knowledge/tags 薄转发为 `--knowledge tags`，原样回内核结果', async () => {
  const payload = { tags: [{ tag: '应用智控', count: 18, theme: 'workflow', single: false }], total: 1, singleCount: 0 }
  const callKernel = fakeKernel(() => payload)
  const r = await handleKnowledgeRoute(ctx({ callKernel }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, payload)
  assert.deepEqual(callKernel.calls, [['--knowledge', 'tags']])
})

test('POST /knowledge/append 转发 tag/text/theme（顺序与逐个存在性都由内核解析）', async () => {
  const callKernel = fakeKernel(() => ({ ok: true, theme: 'workflow', tag: '应用智控', deduped: false }))
  const r = await handleKnowledgeRoute(ctx({
    method: 'POST', url: '/knowledge/append',
    body: { tag: '应用智控', text: '写入通道必须 append-only，因为 Write 是覆盖语义', theme: 'workflow' },
    callKernel,
  }))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, theme: 'workflow', tag: '应用智控', deduped: false })
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'append', '--text', '写入通道必须 append-only，因为 Write 是覆盖语义', '--tag', '应用智控', '--theme', 'workflow'])
})

test('append 省略 tag/theme 时不追加空 flag（空串等于没给）', async () => {
  const callKernel = fakeKernel(() => ({ ok: true, deduped: false }))
  await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/append', body: { text: '一段足够长的经验正文内容用于验证转发', tag: '', theme: null }, callKernel }))
  assert.deepEqual(callKernel.calls[0], ['--knowledge', 'append', '--text', '一段足够长的经验正文内容用于验证转发'])
})

test('append 缺 text → 400，且**不调内核**（必填校验是路由唯一该做的判断）', async () => {
  const callKernel = fakeKernel()
  for (const body of [{}, { text: '' }, { text: '   ' }]) {
    const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/append', body, callKernel }))
    assert.equal(r.status, 400)
  }
  assert.equal(callKernel.calls.length, 0)
})

test('闸门拒绝（内核退出码 1 + stderr `[knowledge]` 前缀）→ 400 并带上理由', async () => {
  // kernelReadonly 非零退出即 reject 且**丢弃 stdout**；cli 因此额外写一行 stderr
  //（`kernel/cli.mjs` 的 --knowledge 分支）。路由据此把"内容不合规"映射成 400 ——
  // 调用方必须能区分"我的经验被闸门拒了"与"内核崩了"。若这条链路断了，
  // 用户只会看到一个无信息量的 500，无从知道为什么被拒。
  const callKernel = async () => { throw new Error('[knowledge] too-short: 正文仅 3 字符（< 20）：入库后会被关联侧过滤') }
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/append', body: { text: '太短了' }, callKernel }))
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /too-short/)
  assert.match(String(r.body.error), /20/)
})

test('非闸门类失败（超时/崩溃）不被误标为 400 —— 冒泡为 500', async () => {
  const callKernel = async () => { throw new Error('[kernel-readonly] timeout 60000ms') }
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/append', body: { text: '一段足够长的正文用于验证错误分类' }, callKernel }))
  assert.equal(r.status, 500, '内核崩了不该告诉调用方"是你的内容不合规"')
})

test('内核以 exit 0 + 错误体返回时同样映射 400（双保险）', async () => {
  const callKernel = fakeKernel(() => ({ error: 'protocol', message: '协议文本不是经验' }))
  const r = await handleKnowledgeRoute(ctx({ method: 'POST', url: '/knowledge/append', body: { text: '【上下文锚定】注入文本' }, callKernel }))
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'protocol')
})

test('append 是 POST-only：GET /knowledge/append 落回 null（不冒充 405）', async () => {
  const r = await handleKnowledgeRoute(ctx({ method: 'GET', url: '/knowledge/append' }))
  assert.equal(r, null)
})
