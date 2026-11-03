// SEC-03 回归：工作流 webhook 必须是「回环 + 令牌闸（fail-closed）+ 体量上限」三件齐备。
//
// 【缺陷原形】kernel/cli.mjs 的 `wfHttpServer.listen(port, cb)` 不传 host ⇒ Node 绑 0.0.0.0；
//   createWebhookServer 的 `/wf/run/<id>` 与 `/wf/list` 零鉴权 ⇒ 同网段任意主机可触发工作流
//   （含 code 节点的任意 JS 执行）并枚举清单。
//
// 【为什么用源码断言 + 真服务器行为断言两条腿】
//   ① 源码断言防"有人把 host 或令牌闸删掉"（最便宜、跑得最快）。
//   ② 行为断言（真起一个 http server）才是真判据：源码写着 `127.0.0.1` 不代表 listen 传了它。
//      这里直接调 createWebhookServer() 并在测试进程内 listen 随机端口（不碰真 CLI），
//      逐条验证 503/401/413/200 四类响应。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWorkflowEngine } from '../kernel/workflow-engine.mjs'

const ROOT = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')
/** 剥掉整行注释（修复说明里会合法引用旧写法） */
const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

test('★ SEC-03 源码：listen 必须显式传回环 host（不传即绑 0.0.0.0）', () => {
  const src = strip(read('kernel/cli.mjs'))
  const m = src.match(/wfHttpServer\.listen\(([^)]*)\)/)
  assert.ok(m, '必须存在 wfHttpServer.listen(...) 调用')
  const args = m[1]
  assert.match(args, /WEBHOOK_HOST|'127\.0\.0\.1'|"127\.0\.0\.1"/,
    `listen 必须显式传回环 host（实得：listen(${args})）—— 不传时 Node 默认绑 0.0.0.0，同网段可连`)
  assert.match(src, /const\s+WEBHOOK_HOST\s*=\s*'127\.0\.0\.1'|listen\([^,]+,\s*'127\.0\.0\.1'/,
    '回环地址应当是显式常量或字面量，不得靠默认值')
})

test('★ SEC-03 源码：令牌闸必须在**一切路由之前**，且未配置令牌时 fail-closed', () => {
  const src = strip(read('kernel/workflow-engine.mjs'))
  const i = src.indexOf('function createWebhookServer(')
  assert.ok(i > -1)
  const body = src.slice(i, src.indexOf('\n  }', i))
  const tokenAt = body.indexOf('PONOS_WF_WEBHOOK_TOKEN')
  const runAt = body.indexOf("'/wf/run/'")
  const listAt = body.indexOf("'/wf/list'")
  assert.ok(tokenAt > -1, '必须读取 PONOS_WF_WEBHOOK_TOKEN')
  assert.ok(tokenAt < runAt && tokenAt < listAt,
    '令牌闸必须出现在 /wf/run 与 /wf/list 分支**之前**（否则先执行后校验，闸门形同虚设）')
  assert.match(body, /503|webhook-disabled/,
    '未配置令牌时必须显式拒绝（fail-closed），不得"没配就等于不校验"')
  assert.match(body, /401|unauthorized/, '令牌不匹配必须 401')
})

test('★ SEC-03 行为：未配置令牌 ⇒ 503；错令牌 ⇒ 401；正确令牌 ⇒ 放行', async (t) => {
  const prev = process.env.PONOS_WF_WEBHOOK_TOKEN
  delete process.env.PONOS_WF_WEBHOOK_TOKEN
  const engine = createWorkflowEngine({ configDir: process.cwd() })
  const server = engine.createWebhookServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  t.after(() => new Promise((r) => server.close(r)))

  // ① 未配置令牌：一切请求 503（含 /wf/list —— 它同样泄露清单）
  for (const [method, path] of [['GET', '/wf/list'], ['POST', '/wf/run/x']]) {
    const res = await fetch(base + path, { method })
    assert.equal(res.status, 503, `${method} ${path} 在未配置令牌时必须 503（fail-closed）`)
    const j = await res.json()
    assert.equal(j.error, 'webhook-disabled')
  }

  // ② 配置令牌后：错令牌 401，正确令牌放行（/wf/list 会成功；/wf/run 因工作流不存在返回 400）
  process.env.PONOS_WF_WEBHOOK_TOKEN = 'test-token-abc'
  const r401 = await fetch(base + '/wf/list', { headers: { 'x-yfw-webhook-token': 'wrong' } })
  assert.equal(r401.status, 401, '错令牌必须 401')
  const rNoAuth = await fetch(base + '/wf/list')
  assert.equal(rNoAuth.status, 401, '缺令牌必须 401')

  const ok = await fetch(base + '/wf/list', { headers: { 'authorization': 'Bearer test-token-abc' } })
  assert.equal(ok.status, 200, '正确令牌（Authorization: Bearer）必须放行')
  const body = await ok.json()
  assert.ok(Array.isArray(body.workflows), '/wf/list 应返回 workflows 数组')

  // ③ 体量上限：声明超大 content-length 直接 413
  const big = await fetch(base + '/wf/run/x', {
    method: 'POST',
    headers: { 'x-yfw-webhook-token': 'test-token-abc', 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
    body: '{}',
  }).catch((e) => ({ status: 0, err: e }))
  // 有些 fetch 实现会自行改 content-length；无论 413 还是连接被销毁，都不许"被完整接受"
  assert.ok(big.status === 413 || big.status === 0,
    `超大 body 必须被拒（413 或连接销毁），实得 ${big.status}`)

  if (prev === undefined) delete process.env.PONOS_WF_WEBHOOK_TOKEN
  else process.env.PONOS_WF_WEBHOOK_TOKEN = prev
})

test('★ SEC-03 源码：body 上限必须存在（不得先全量入内存再判尺寸）', () => {
  const src = strip(read('kernel/workflow-engine.mjs'))
  assert.match(src, /MAX_WEBHOOK_BODY/, '必须有 body 上限常量')
  assert.match(src, /413/, '超限必须 413')
  assert.match(src, /total\s*\+=\s*chunk\.length|declared\s*>\s*MAX_WEBHOOK_BODY/,
    '必须边读边计量或先看 content-length，不能只靠读完再判')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-18 统一验收时追加：边读边计量路径的 413 **响应要能被客户端收到**
//
// 现场（真起服务器实测）：
//   有 content-length 且声明超限 → 413 正常返回（浏览器/curl 的常规路径）
//   无 content-length（chunked）边走边计量超限 → 客户端 **ECONNRESET**，收不到 413
// 原因：`send(413)` 后立刻 `req.destroy()`，响应还没刷出就把 socket 干掉了。
//
// 为什么这算缺陷：安全上请求确实被拒了，但**响应语义不可靠** ——
//   合法客户端（用 chunked 发大 body 的正常集成方）无法区分"被拒"与"网络故障"，
//   只会看到连接重置而不知道是自己 body 太大。排查成本高、体验差。
// ─────────────────────────────────────────────────────────────────────────────

test('★ 413 响应必须真的送达客户端（不得 send 后立刻 destroy 吃掉响应）', async () => {
  const { readFileSync } = await import('node:fs')
  // ★ 必须剥注释再扫 —— 修复说明里**合法引用**了旧写法 `send(413); req.destroy()`，
  //   不剥就会在**文档**上报红（本仓已踩过多次的同一坑：修复注释绊倒自己的扫描器）。
  const strip2 = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const src = strip2(readFileSync(new URL('../kernel/workflow-engine.mjs', import.meta.url), 'utf8'))
  const body = src.slice(src.indexOf('function createWebhookServer('))

  const afterLoop = body.slice(body.indexOf('total > MAX_WEBHOOK_BODY'))
  const branch = afterLoop.slice(0, 600)
  assert.match(branch, /413/, '边读边计量的超限分支必须回 413')
  // 关键：destroy 必须被延后（绑到 finish/close 事件或 setTimeout），不能紧跟在 send 之后同步调用
  const immediateDestroy = /send\(\s*413[^)]*\)\s*\n\s*(?:req\.)?destroy\(/.test(branch)
  assert.ok(!immediateDestroy,
    'send(413) 之后不得**同步**调用 req.destroy() —— 响应还没刷出就断连，'
    + '客户端只会看到 ECONNRESET 而收不到 413（正常集成方无法区分"被拒"与"网络故障"）')
  assert.match(branch, /finish|setTimeout|setImmediate/,
    '超限后应等响应刷出（res 的 finish 事件）或设超时兜底再断开连接')
})
