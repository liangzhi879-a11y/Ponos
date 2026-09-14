// server/knowledge-trash-routes.test.mjs —— 删除管理路由的回归（2026-09-14）
//
// 这层是**薄转发**，所以真正要钉的是"转发本身有没有漏"：
//   ① 字段 → argv 的映射（漏一个 = 该能力静默不存在，且表现为"内核说参数不对"）；
//   ② 错误码 → HTTP 状态码（403/404/410/400 混淆会让 GUI 给出做不到的建议）；
//   ③ `all` 只认严格 true（写成 `"false"` 却清空了整个回收站是最坏的一种 bug）；
//   ④ 非内核错误必须继续抛出（超时/崩溃是 5xx，不能被伪装成"参数错误"的 400）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleKnowledgeRoute } from './knowledge-routes.mjs'

/** 调一次路由，返回 {status, body}；`callKernel` 用桩，记录收到的 argv */
async function call(method, pathname, body, kernel) {
  const seen = []
  const r = await handleKnowledgeRoute({
    method,
    pathname,
    searchParams: new URLSearchParams(),
    readJsonBody: async () => body,
    callKernel: async (args) => {
      seen.push(...args)
      if (typeof kernel === 'function') return kernel(args)
      return kernel ?? '{"ok":true}'
    },
  })
  return { status: r?.status, body: r?.body, argv: seen.join(' ') }
}

/** 内核以 stderr + 非零退出失败时，kernelReadonly 会把 stderr 原样抛出 */
async function callErr(method, pathname, body, stderr) {
  const r = await handleKnowledgeRoute({
    method, pathname, searchParams: new URLSearchParams(),
    readJsonBody: async () => body,
    callKernel: async () => { throw new Error(stderr) },
  })
  return { status: r?.status, body: r?.body }
}

test('trash 路由: GET /knowledge/trash → trash-list（读，不带 --space）', async () => {
  const r = await call('GET', '/knowledge/trash', null, '{"count":2,"items":[{"trashId":"20260914-1630-ab12"}]}')
  assert.equal(r.status, 200)
  assert.equal(r.argv, '--knowledge trash-list')
  assert.equal(r.body.count, 2)
})

test('trash 路由: DELETE /knowledge/delete → delete-doc（spaceId/space 双字段兼容）', async () => {
  const a = await call('DELETE', '/knowledge/delete', { spaceId: '研发资料', path: 'a/b.md' })
  assert.equal(a.argv, '--knowledge delete-doc --space 研发资料 --path a/b.md')
  // 只认 `spaceId` 会让 GET 系列风格的调用方拿到"空间不存在"这种误导性报错
  const b = await call('DELETE', '/knowledge/delete', { space: '研发资料', path: 'a/b.md' })
  assert.equal(b.argv, '--knowledge delete-doc --space 研发资料 --path a/b.md')
  // 缺 path 时**不补空串**：让内核按 bad-path 明确报错（而不是静默删掉什么）
  const c = await call('DELETE', '/knowledge/delete', { spaceId: '研发资料' })
  assert.equal(c.argv, '--knowledge delete-doc --space 研发资料')
})

test('trash 路由: DELETE /knowledge/delete-space → delete-space --confirm 透传', async () => {
  const r = await call('DELETE', '/knowledge/delete-space', { spaceId: '研发资料', confirm: '研发资料' })
  assert.equal(r.argv, '--knowledge delete-space --space 研发资料 --confirm 研发资料')
  // 不给 confirm 时**不传该 flag**：内核会按 confirm-mismatch 拒，并给出"需要输入什么"的上下文
  const noConfirm = await call('DELETE', '/knowledge/delete-space', { spaceId: '研发资料' })
  assert.equal(noConfirm.argv, '--knowledge delete-space --space 研发资料')
})

test('trash 路由: DELETE /knowledge/restore → restore --trash-id（trashId/id 兼容）', async () => {
  const a = await call('DELETE', '/knowledge/restore', { trashId: '20260914-1630-ab12' })
  assert.equal(a.argv, '--knowledge restore --trash-id 20260914-1630-ab12')
  const b = await call('DELETE', '/knowledge/restore', { id: '20260914-1630-ab12' })
  assert.equal(b.argv, '--knowledge restore --trash-id 20260914-1630-ab12')
})

test('trash 路由: purge —— all 只认严格 true（字符串 "false" 绝不能清空回收站）', async () => {
  const all = await call('DELETE', '/knowledge/purge', { all: true })
  assert.equal(all.argv, '--knowledge purge --all')

  // 以下是**最坏 bug 的防线**：把 `"false"`/0/1 之类当成"清空"，会一次销毁整个回收站
  for (const bad of ['false', '', 0, 1, null, undefined, 'true']) {
    const r = await call('DELETE', '/knowledge/purge', { all: bad, trashId: '20260914-1630-ab12' })
    assert.equal(r.argv, '--knowledge purge --trash-id 20260914-1630-ab12', `all=${JSON.stringify(bad)} 被误判成清空`)
  }
  // 只有 all 且没有 trashId 时才是清空
  const one = await call('DELETE', '/knowledge/purge', { trashId: '20260914-1630-ab12' })
  assert.equal(one.argv, '--knowledge purge --trash-id 20260914-1630-ab12')
})

test('trash 路由: 错误码 → HTTP 状态码（403/404/410/400 不可混）', async () => {
  const cases = [
    ['readonly-space', 403],     // 知识包只读：换"选择"能解决，不是参数错
    ['protected-space', 403],    // 内置库不许删整库
    ['bad-path', 400],
    ['confirm-mismatch', 400],
    ['missing-space', 400],
    ['bad-trash-id', 400],
    ['unknown-space', 404],
    ['not-found', 404],
    ['unknown-trash-id', 404],
    // 410 与 404 刻意分开：记录还在、内容不在磁盘 → GUI 把「还原」置灰而不是给个做不到的建议
    ['payload-missing', 410],
    ['space-exists', 409],
    ['name-exhausted', 409],
    ['bad-root', 500],
  ]
  for (const [code, status] of cases) {
    const r = await call('DELETE', '/knowledge/delete', { spaceId: 'x', path: 'a.md' }, JSON.stringify({ error: code, message: `${code} 的说明` }))
    assert.equal(r.status, status, `${code} 应为 ${status}，实际 ${r.status}`)
    assert.equal(r.body.error, code)
    assert.equal(r.body.message, `${code} 的说明`)
  }
})

test('trash 路由: stderr 形态（exit≠0）也要映射，且剥离重复的码前缀', async () => {
  const r = await callErr('DELETE', '/knowledge/delete-space', {},
    '[knowledge] protected-space: delete-space: experience 是内置空间，只允许删除其中条目')
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'protected-space')
  // 不能原样吐回 `protected-space: protected-space: …`（body.error 已经给了码）
  assert.equal(r.body.message, 'delete-space: experience 是内置空间，只允许删除其中条目')
  assert.equal(r.body.message.startsWith('protected-space'), false)
})

test('trash 路由: 未登记的码落到 400，但绝不静默变成 200', async () => {
  const r = await call('DELETE', '/knowledge/delete', { spaceId: 'x', path: 'a.md' }, '{"error":"brand-new-code"}')
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'brand-new-code')
})

test('trash 路由: 非内核错误必须是 5xx（不能伪装成 400 参数错误）', async () => {
  // callTrashOp 只把 `[knowledge] ` 前缀的 stderr 归为"调用方问题"；其余（超时/内核崩）
  // 一律**继续抛出**，由路由外层统一变成 500。这条断言钉的是"抛出而非吞掉"：
  // 若被吞成 400，前端会把"内核崩了"提示成"你的参数不对"，把用户引向完全错误的排查方向。
  const r = await callErr('DELETE', '/knowledge/delete', {}, 'ETIMEDOUT: 内核超时')
  assert.equal(r.status, 500)
  assert.match(JSON.stringify(r.body), /ETIMEDOUT|内核/)
})

test('trash 路由: 删除动词用 DELETE，GET 不能被当成删除', async () => {
  // `GET /knowledge/delete` 不该匹配任何删除分支（避免"点个链接就删库"这类问题的土壤）
  const r = await call('GET', '/knowledge/delete', null, '{"ok":true}')
  assert.equal(r.status, undefined)   // 未匹配 → 交给上层（null）
  assert.equal(r.argv, '')
})

test('trash 路由: 成功响应原样回传（含 renamed / indexSync，GUI 要用来提示）', async () => {
  const payload = { ok: true, kind: 'doc', spaceId: '研发资料', path: 'sub/b-2.md', renamed: true, indexSync: 'reloaded' }
  const r = await call('DELETE', '/knowledge/restore', { trashId: '20260914-1630-ab12' }, JSON.stringify(payload))
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, payload)
})
