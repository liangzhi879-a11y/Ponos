import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 工作目录选择器（DirectoryPicker）依赖的三个 bridge 端点契约。
//
// 回归来源（2026-09-16 用户报「任务模式选目录，快捷目录读取失败」）：
// `/known-folders` 当时写成 `reply(200, { folders })` —— reply 是
// `(code, headers, body)` 三参签名，少传第三参就把 headers 当成了 body：
// 回执变成「200 + 空响应体」，渲染层 `res.json()` 解析空串抛错 → `loadNav` 的
// catch 记 `foldersFailed=true` → 左栏"快捷入口"恒显「读取失败」，且因为 HTTP
// 状态是 200，任何只看 status 的检查都照不出来。
//
// 因此这里的断言刻意落在**响应体可解析 + 字段类型**上，而不是只断言 status：
// 三个端点共用同一个 reply()，谁漏了 body 都在这里现形。

process.env.YFW_BRIDGE_NO_LISTEN = '1'
const { httpServer } = await import('./bridge.mjs')

let port = 0
let server = null

before(async () => {
  await new Promise((resolve) => {
    server = httpServer.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
  assert.ok(port > 0, 'random port should be allocated')
})

after(() => {
  return new Promise((resolve) => {
    if (server) server.close(resolve)
    else resolve()
  })
})

const getJson = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  assert.equal(res.status, 200, `${path} 应回 200`)
  assert.match(
    res.headers.get('content-type') || '', /application\/json/,
    `${path} 的 Content-Type 应为 application/json（漏 body 的写法连这个头都不在）`,
  )
  const text = await res.text()
  assert.notEqual(text, '', `${path} 响应体不能为空（空体 ⇒ 渲染层 res.json() 抛错）`)
  return JSON.parse(text)   // 解析失败直接红：这正是回归现场的报错点
}

test('GET /known-folders 返回 { folders: [...] } 且字段类型正确', async () => {
  const body = await getJson('/known-folders')
  assert.ok(Array.isArray(body.folders), 'folders 应为数组（normalizeFolders 只认这个字段）')
  for (const f of body.folders) {
    assert.equal(typeof f.name, 'string')
    assert.ok(f.name, 'name 非空')
    assert.equal(typeof f.path, 'string')
    assert.ok(f.path, 'path 非空')
    assert.equal(typeof f.kind, 'string')
    // bridge 只回真实存在的目录：分隔符已归一为正斜杠（渲染层不再换分隔符）
    assert.ok(!f.path.includes('\\'), `path 应使用正斜杠：${f.path}`)
  }
  // 主目录必然存在，故至少有一项；这一条同时兜住"整个列表被吞成空"的写法
  assert.ok(body.folders.some(f => f.kind === 'home'), '应含 kind=home 的主目录入口')
})

test('GET /drives 返回 { drives: [...] }', async () => {
  const body = await getJson('/drives')
  assert.ok(Array.isArray(body.drives), 'drives 应为数组')
  for (const d of body.drives) {
    assert.equal(typeof d.name, 'string')
    assert.equal(typeof d.path, 'string')
  }
})

test('GET /list-dir 返回 { path, parent, entries, truncated }', async () => {
  const body = await getJson(`/list-dir?path=${encodeURIComponent(process.cwd())}`)
  assert.equal(typeof body.path, 'string')
  assert.equal(typeof body.parent, 'string')
  assert.ok(Array.isArray(body.entries), 'entries 应为数组')
  assert.equal(typeof body.truncated, 'boolean')
})

// 源码级守卫：两参 reply(...) 除 204 无体外一律视为漏 body 的写法。
// 通用正则而非死记某一行——同一个坑在任何新端点上重现都会被拦下。
test('bridge.mjs 中不存在漏掉 body 的两参 reply 调用（204 除外）', () => {
  const src = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf-8')
  const offenders = [...src.matchAll(/reply\(\s*(\d+)\s*,\s*\{[^{}]*\}\s*\)/g)]
    .filter((m) => m[1] !== '204')
    .map((m) => m[0].replace(/\s+/g, ' '))
  assert.deepEqual(offenders, [], `这些 reply 调用缺少第三个参数 body：${offenders.join(' | ')}`)
})
