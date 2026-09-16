// kernel-tests/knowledge-delete-tool.test.mjs —— agent 工具 KnowledgeDelete 的回归（2026-09-14）
//
// 三层都要钉，缺一层就有一种错法漏过去：
//   ① 工具**契约**：schema（action 枚举/required）、入 chat 禁用表、与 bridge 的禁用表一致；
//   ② 参数**归一**：action 分派、`all` 只认严格 true、缺参时给出**可照做**的提示；
//   ③ 返回**形状**：成功给 JSON、失败给 isError + 人话（模型据此决定要不要换个 action 重试）。
//
// 全部通过 `ctx.knowledgeStore` 注入假 store —— 工具级用例不落盘、不起进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createToolRegistry, CHAT_MODE_DISALLOWED } from '../kernel/tools.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 可注入的假 store：把"收到了什么参数"记下来，并按需返回内核同形状的结果 */
function fakeStore(overrides = {}) {
  const calls = []
  return {
    calls,
    load() { calls.push(['load']) },
    listTrash() {
      calls.push(['listTrash'])
      return { dir: '/tmp/.trash', count: 1, bytes: 12, stray: 0, items: [{ trashId: '20260914-1630-ab12', kind: 'doc', available: true }] }
    },
    // ⚠️ override 是**函数**，必须调用（`??` 只做取值会返回函数本身 → 工具读到
    // `r.ok === undefined` → 报「删除未执行（undefined）」，看着像内核返回异常）
    deleteDoc(a) { calls.push(['deleteDoc', a]); return overrides.deleteDoc ? overrides.deleteDoc(a) : { ok: true, kind: 'doc', spaceId: a.space, path: a.path, trashId: '20260914-1630-ab12', indexSync: 'reloaded' } },
    deleteSpace(a) { calls.push(['deleteSpace', a]); return overrides.deleteSpace ? overrides.deleteSpace(a) : { ok: true, kind: 'space', spaceId: a.space, trashId: '20260914-1630-ab12', indexSync: 'reloaded' } },
    restore(a) { calls.push(['restore', a]); return overrides.restore ? overrides.restore(a) : { ok: true, kind: 'doc', path: 'a.md', renamed: false, indexSync: 'reloaded' } },
    purge(a) { calls.push(['purge', a]); return overrides.purge ? overrides.purge(a) : { ok: true, purged: 1, bytes: 12, indexSync: 'unchanged' } },
  }
}

/** 取工具定义（registry 只在有 memoryRoot 时构造知识工具） */
function tools() {
  return createToolRegistry({ cwd: ROOT, memoryRoot: join(ROOT, 'memory', 'personal') })
}

/**
 * 跑一次工具。假 store 走 **ctx** 注入（`run(toolUse, ctx)` 的第二参）——
 * 不是 registry 的构造选项。搞错位置的表现很隐蔽：工具会**静默 fallback 到真 store**，
 * 于是"注入了假 store"的用例其实在真磁盘上跑（早期这里就踩过，报的是空间不存在）。
 */
async function run(store, input) {
  return await tools().run({ name: 'KnowledgeDelete', input }, { knowledgeStore: store })
}

test('KnowledgeDelete: 契约 —— schema 的 action 枚举与 required', () => {
  const reg = tools()
  const schemas = reg.toolSchemas ? reg.toolSchemas() : []
  const def = schemas.find((t) => t.name === 'KnowledgeDelete')
  assert.ok(def, '工具必须注册（否则模型看不到删除能力）')
  assert.deepEqual(def.input_schema.properties.action.enum, ['list', 'doc', 'space', 'restore', 'purge'])
  assert.deepEqual(def.input_schema.required, ['action'])
  // 描述里必须说清"软删除 vs 彻底删除"的区别：模型据此决定要不要提醒用户
  assert.match(def.description, /回收站/)
  assert.match(def.description, /不可恢复/)
})

test('KnowledgeDelete: 入 chat 禁用表，且与 bridge 的表逐字一致', (t) => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('KnowledgeDelete'))
  // 它是**写盘**能力，必须与 KnowledgeImport 同类处置
  assert.ok(CHAT_MODE_DISALLOWED.includes('KnowledgeImport'))

  // bridge 那张表按**源码文本**比对，不 import：bridge.mjs 顶层会 listen 一个端口，
  // import 它等于在测试里起服务器（实测报 EADDRINUSE + "测试结束后仍异步活动"）。
  // 手法与 chat-mode.test.mjs 一致 —— 两张表分处 kernel 与 server，漂移的后果是
  // "某个入口的纯聊会话多了一项写盘能力"，必须在测试里钉住。
  // 纯内核形态（本仓无 server/）没有可比对的另一张表：跨层比对无对象，跳过；
  // 上面两条内核侧断言仍然生效（它们才是内核自己的契约）。
  const bridgePath = join(ROOT, 'server', 'bridge.mjs')
  if (!existsSync(bridgePath)) { t.skip('本仓无 server/bridge.mjs（纯内核形态），跳过跨层一致性比对'); return }
  const bridgeSrc = readFileSync(bridgePath, 'utf-8')
  const m = bridgeSrc.match(/export const CHAT_DISALLOWED = \[([^\]]*)\]/)
  assert.ok(m, 'bridge 的 CHAT_DISALLOWED 必须存在')
  const bridgeList = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.deepEqual(bridgeList.sort(), [...CHAT_MODE_DISALLOWED].sort())
  assert.ok(bridgeList.includes('KnowledgeDelete'))
})

test('KnowledgeDelete: action=list 读回收站，不触碰写方法', async () => {
  const store = fakeStore()
  const r = await run(store, { action: 'list' })
  assert.equal(r.isError, false)
  assert.equal(JSON.parse(r.content).count, 1)
  // 关键：list 一次写方法都不能调（读操作越界 = 意外删除的来源）
  assert.deepEqual(store.calls.map((c) => c[0]), ['listTrash'])
})

test('KnowledgeDelete: action=doc 透传 space/path 并回结构化结果', async () => {
  const store = fakeStore()
  const r = await run(store, { action: 'doc', space: '研发资料', path: 'sub/b.md' })
  assert.equal(r.isError, false)
  assert.deepEqual(store.calls.find((c) => c[0] === 'deleteDoc')[1], { space: '研发资料', path: 'sub/b.md' })
  const out = JSON.parse(r.content)
  assert.equal(out.trashId, '20260914-1630-ab12')
  assert.equal(out.indexSync, 'reloaded')
})

test('KnowledgeDelete: action=space 必须带 confirm（缺了由内核拒，工具如实转达）', async () => {
  const store = fakeStore({
    deleteSpace: () => ({ ok: false, error: 'confirm-mismatch', message: 'delete-space: 需要 --confirm <空间id>' }),
  })
  const r = await run(store, { action: 'space', space: '研发资料' })
  assert.equal(r.isError, true)
  // 错误里必须带上码与**可照做的说明**（模型据此知道要补 confirm 再试）
  assert.match(r.content, /confirm-mismatch/)
  assert.match(r.content, /--confirm/)
  const passed = store.calls.find((c) => c[0] === 'deleteSpace')[1]
  assert.deepEqual(passed, { space: '研发资料', confirm: null })
})

test('KnowledgeDelete: 权限拒绝如实转达（内置库 protected-space / 知识包 readonly-space）', async () => {
  const store = fakeStore({
    deleteSpace: () => ({ ok: false, error: 'protected-space', message: 'experience 是内置空间，只允许删除其中条目' }),
    deleteDoc: () => ({ ok: false, error: 'readonly-space', message: 'pack-demo 是只读知识包' }),
  })
  const a = await run(store, { action: 'space', space: 'experience', confirm: 'experience' })
  assert.equal(a.isError, true)
  assert.match(a.content, /protected-space/)

  const b = await run(store, { action: 'doc', space: 'pack-demo', path: 'p.md' })
  assert.equal(b.isError, true)
  assert.match(b.content, /readonly-space/)
})

test('KnowledgeDelete: action=purge 的 all 只认严格 true（否则按单条走）', async () => {
  const store = fakeStore()
  await run(store, { action: 'purge', all: true })
  assert.deepEqual(store.calls.find((c) => c[0] === 'purge')[1], { trashId: null, all: true })

  // `"false"` / 1 / 0 这类写法**绝不能**被当成"清空回收站"（那是最坏的一种 bug）
  for (const bad of ['false', 'true', 1, 0, null]) {
    const s2 = fakeStore()
    await run(s2, { action: 'purge', trashId: '20260914-1630-ab12', all: bad })
    assert.deepEqual(
      s2.calls.find((c) => c[0] === 'purge')[1],
      { trashId: '20260914-1630-ab12', all: false },
      `all=${JSON.stringify(bad)} 被误判成清空`,
    )
  }
})

test('KnowledgeDelete: action=restore 透传 trashId（含 id 别名不生效——工具只认 trashId）', async () => {
  const store = fakeStore()
  await run(store, { action: 'restore', trashId: '20260914-1630-ab12' })
  assert.deepEqual(store.calls.find((c) => c[0] === 'restore')[1], { trashId: '20260914-1630-ab12' })
})

test('KnowledgeDelete: 参数缺失/未知 action 给出可照做的错误（不是静默成功）', async () => {
  // 缺 action
  const a = await run(fakeStore(), {})
  assert.equal(a.isError, true)
  assert.match(a.content, /list \/ doc \/ space \/ restore \/ purge/)

  // 未知 action
  const b = await run(fakeStore(), { action: 'delete-everything' })
  assert.equal(b.isError, true)
  assert.match(b.content, /未知 action/)

  // 未知 action 时**不能**顺手调任何写方法
  const store = fakeStore()
  await run(store, { action: 'nope' })
  assert.equal(store.calls.some((c) => ['deleteDoc', 'deleteSpace', 'purge', 'restore'].includes(c[0])), false)
})

test('KnowledgeDelete: 未配置 memoryRoot 时明确报不可用（而不是假装成功）', async () => {
  const reg = createToolRegistry({ cwd: ROOT })
  const r = await reg.run({ name: 'KnowledgeDelete', input: { action: 'list' } }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /memoryRoot|不可用/)
})

test('KnowledgeDelete: store 抛异常被兜住，转成 isError（模型可换个动作重试）', async () => {
  const store = fakeStore()
  store.deleteDoc = () => { throw new Error('磁盘只读') }
  const r = await run(store, { action: 'doc', space: 'a', path: 'b.md' })
  assert.equal(r.isError, true)
  assert.match(r.content, /磁盘只读/)
})

test('KnowledgeDelete: 工具体不得绕过 store 直接删文件（源码级守卫）', () => {
  // 与 knowledge-import-tool.test.mjs 同一手法：删除的落盘逻辑必须只有一份
  // （kernel/knowledge.mjs 的回收站实现），工具内出现 rm/unlink/rename 就意味着
  // 有人在工具里另写了一套删除 —— 那套不会有权限门、不会有路径校验、不会有回收站。
  const src = readFileSync(join(ROOT, 'kernel', 'tools.mjs'), 'utf-8')
  const start = src.indexOf('KnowledgeDelete: {')
  assert.ok(start > 0)
  const rest = src.slice(start)
  // ⚠️ `\r?\n`：tools.mjs 是 CRLF，只写 `\n` 会**从不匹配**（`end` 恒 -1 → 退化成全文扫描）
  const end = rest.search(/\r?\n {4}[A-Za-z][A-Za-z0-9]*: \{\r?\n/)
  assert.ok(end > 0, '必须能切出 KnowledgeDelete 这个工具的体（否则退化成全文扫描）')
  const body = rest.slice(0, end).split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const forbidden of ['rmSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'cpSync', 'writeFileSync', 'realpathSync']) {
    assert.equal(body.includes(forbidden), false, `工具体不得直接做文件系统写操作：${forbidden}`)
  }
  // 必须经由内核 store 的 API（权限/路径/回收站都封在里面）
  assert.match(body, /createKnowledgeStore/)
  assert.match(body, /deleteGate|deleteDoc|deleteSpace|listTrash|restore|purge/)
})
