// K1.4 请求面记忆化契约（2026-09-13「任务运行慢」系统性优化 Task 5）
// ---------------------------------------------------------------------------
// `requestMessages()` 一步内被调用 4–5 次（估算 ×2、看门狗提供者、reqFace、溢出分支的
// 裁剪/硬适配），每次重跑 patchOrphanToolUses(deriveHistory()) + 拼 system 前缀（0.77ms/次）；
// 更关键的是**同一数组身份**能让 K1.1 的估算记忆化整段命中。
//
// 本文件锁三件事：
//   1) **命中**：同键返回**同一数组引用**，且 patch 只被调 1 次（身份共享是目的，不是副作用）。
//   2) **失效**：四个键分量各自都能单独把缓存打掉——特别是 `contentEpoch` 这枚**保险丝**
//      （compact 原地改写只改块内容、不改数组结构），以及 session 的实际写路径（append /
//      压缩落地 / 加载）必须 bump revision。
//   3) **不陈旧**：patch 每次返回新对象时，重建后必须拿到**新值**（把"只缓存引用数组、
//      不缓存内容"这个前提钉进测试——否则一旦有人改成深拷贝缓存就会读到旧内容）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createRequestFace, patchOrphanToolUses } = await import('../kernel/engine.mjs')
const { createSessionStore } = await import('../kernel/session.mjs')
const { contentEpoch, bumpContentEpoch } = await import('../kernel/context.mjs')

/** 简易可编排装置：四个键分量各自独立可改，patch 可注入计数版 */
function harness({ patch, base = [{ role: 'user', content: '你好' }] } = {}) {
  const st = {
    rev: 1, skip: 0, sys: '系统提示 A', ep: contentEpoch(), base,
    calls: 0,
  }
  const face = createRequestFace({
    getBase: () => st.base,
    getRevision: () => st.rev,
    getSkip: () => st.skip,
    getSystem: () => st.sys,
    epoch: () => st.ep,
    on: () => true,
    ...(patch ? { patch } : {}),
  })
  return { st, face }
}

test('同键：返回同一数组引用（身份共享是目的——下游 K1.1 估算靠它整段命中）', () => {
  const { face } = harness()
  const a = face()
  const b = face()
  assert.equal(a, b, '同键必须返回同一引用（否则等于没缓存）')
})

test('同键：注入的计数版 patch 只被调用 1 次（构造真的只发生一次）', () => {
  let calls = 0
  const { face } = harness({ patch: (m) => { calls++; return patchOrphanToolUses(m) } })
  const faces = [face(), face(), face(), face(), face()]
  assert.equal(calls, 1, `5 次求值只应构造 1 次（实际 ${calls}）`)
  for (const f of faces) assert.equal(f, faces[0])
})

test('结构：system 前缀在前、空 system 不产出条目（与旧实现逐字一致）', () => {
  const { st, face } = harness()
  assert.deepEqual(face().map((m) => m.role), ['system', 'user'])
  st.sys = ''
  assert.deepEqual(face().map((m) => m.role), ['user'], '空 systemPrompt 不得塞空条目')
})

test('失效：revision +1 必重建', () => {
  const { st, face } = harness()
  const a = face()
  st.rev++
  const b = face()
  assert.notEqual(a, b, 'epoch/revision 变了必须重建')
})

test('失效：historySkip 变必重建（loop --fresh 只影响请求面，不入日志）', () => {
  const { st, face } = harness()
  const a = face()
  st.skip = 1
  const b = face()
  assert.notEqual(a, b)
  st.skip = 0
  assert.notEqual(face(), b, '回到旧 skip 也不得命中更早的缓存项（单槽，不做多值缓存）')
})

test('失效：systemPrompt 内容变必重建（键里存的是字符串本身，绝不拼进键串）', () => {
  const { st, face } = harness()
  const a = face()
  st.sys = '系统提示 B'
  assert.notEqual(face(), a, 'systemPrompt 变了必须重建')
})

test('systemPrompt 的键比较是 **===**：同内容不误判为变，省掉一次无谓重建', () => {
  // 实测澄清（写测试时踩到）：V8 会驻留相同的字符串字面量，故 `===` 在字符串上**先比身份、
  // 不等时再比内容**——即"同内容不同对象"仍算命中。这比纯身份比更好：`setSystemPrompt`
  // 即使传了拼装出的等值新串（`a + b`）也不会白付一次 0.77ms 重建；而内容真变时必然 miss。
  // 代价只是命中路径上一次 ~20KB 的 memcmp（µs 级），远小于重建。
  const { st, face } = harness()
  st.sys = '系统提示 ' + 'A'            // 非驻留对象，内容与 '系统提示 A' 逐字相同
  assert.notEqual(st.sys === '系统提示 A', false, '前提：内容相等')
  const a = face()
  st.sys = '系统提示 ' + 'A'            // 又一个新对象，内容依旧相同
  assert.equal(face(), a, '内容相同的 systemPrompt 不该触发重建（否则 statusline 刷新会白付代价）')
})

test('失效（保险丝）：contentEpoch +1 即使 revision 不变也必须重建', () => {
  // 场景：compact 的原地改写（freeShrink / ageOutToolResults）只改**块内容**、
  // 不改 nodes/数组结构 ⇒ revision 与数组身份都不变，但内容已变。
  const { st, face } = harness()
  const a = face()
  bumpContentEpoch()
  st.ep = contentEpoch()
  const b = face()
  assert.notEqual(a, b, 'contentEpoch 是保险丝：数组结构没变但内容变了，也必须重建')
})

test('不陈旧：patch 每次返回新对象 ⇒ 重建后必须拿到**新值**（只缓存引用，不缓存内容）', () => {
  let n = 0
  const { st, face } = harness({
    // 模拟"每次返回新对象"的派生（真实场景：孤儿补丁插入合成 tool_result）
    patch: () => [{ role: 'user', content: `第 ${++n} 版` }],
  })
  const at = (f) => f[1].content // [0] 是 system 前缀
  assert.equal(at(face()), '第 1 版')
  assert.equal(at(face()), '第 1 版', '同键命中期间不得重新派生')
  st.rev++
  assert.equal(at(face()), '第 2 版', '重建后必须反映最新内容（锁住"只缓存引用"的前提）')
})

test('关缓存：每次都是新数组，且重新打开不留陈旧项', () => {
  let on = false
  let calls = 0
  const st = { rev: 1, skip: 0, sys: 'S', ep: 0, base: [] }
  const face = createRequestFace({
    getBase: () => st.base, getRevision: () => st.rev, getSkip: () => st.skip, getSystem: () => st.sys,
    epoch: () => st.ep, on: () => on,
    patch: (m) => { calls++; return patchOrphanToolUses(m) },
  })
  const a = face()
  assert.notEqual(face(), a, '关缓存时不得共享引用')
  assert.equal(calls, 2)
  on = true
  const c = face()          // 打开后的第一次求值 = 冷启动，必须重建
  assert.equal(calls, 3)
  assert.equal(face(), c, '打开后应恢复命中')
  assert.equal(calls, 3, '命中不得再构造')
})

test('参数校验：缺键分量直接抛（防止"少传一个 getter"静默退化成恒 miss）', () => {
  assert.throws(() => createRequestFace({ getBase: () => [], getRevision: () => 0, getSkip: () => 0 }), /getSystem/)
  assert.throws(() => createRequestFace({}), /getBase/)
})

// —— session 侧：revision 必须与 derive 缓存**结构上**同步（不是靠调用方记得 bump）——

test('session.revision：append 前后必变（写路径的唯一入口是 invalidate）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const s = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'rev-append' })
    const r0 = s.revision()
    s.appendUser('第一条')
    assert.notEqual(s.revision(), r0, 'append 必须 bump（否则请求面永远停在空历史）')
    const r1 = s.revision()
    s.appendAssistant([{ type: 'text', text: '回复' }], { model: 'm' })
    assert.notEqual(s.revision(), r1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('session.revision：压缩落地必变（遮蔽区间替换 nodes）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const s = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'rev-compact' })
    const u1 = s.appendUser('一')
    s.appendAssistant([{ type: 'text', text: '答一' }], { model: 'm' })
    const u2 = s.appendUser('二')
    const r0 = s.revision()
    s.appendCompactionSummary({ summary: '摘要', coveredSeqs: [u1.seq, u2.seq] })
    assert.notEqual(s.revision(), r0, '压缩落地必须 bump')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('session.revision：bump 落在**真实重建**上，命中不 bump（否则缓存永不命中）', () => {
  // 设计意图：bump 有两处——invalidate()（写路径立即生效）与 deriveMessages() 的重建分支
  // （兜住"改了 nodes 却忘了 invalidate"）。前者若尚未重建，后者会再 +1，即"多失效一次"，
  // 只多算不会错算。本用例锁后半句：**命中路径绝不能 bump**。
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const s = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'rev-rebuild' })
    s.appendUser('一')          // invalidate → +1（此时尚未重建）
    s.deriveMessages()          // 真实重建 → +1
    const r = s.revision()
    for (let i = 0; i < 5; i++) {
      s.deriveMessages()        // 全部命中
      assert.equal(s.revision(), r, '命中路径不得 bump——否则每步都换纪元，缓存恒 miss')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('顺序不变式：写入后**首次**求值即建档，同行第二次求值就命中', () => {
  // 这是 K1.4 里最容易写错的一处：revision 有两处 bump（invalidate + 重建），若工厂先读
  // revision、后调 getBase()，就会"先读到旧纪元、再拿到新数组"⇒ 把新结果存在旧键下，
  // 白丢一次命中（第二次求值仍 miss，第三次才命中）。本用例把"第一步就命中"钉死。
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const s = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'rev-order' })
    let calls = 0
    const face = createRequestFace({
      getBase: () => s.deriveMessages(),
      getRevision: () => s.revision(),
      getSkip: () => 0,
      getSystem: () => 'SYS',
      on: () => true,
      patch: (m) => { calls++; return patchOrphanToolUses(m) },
    })
    s.appendUser('一')          // 一次写入（invalidate 已 bump，重建尚未发生）
    const a = face()            // 首次：重建 + 建档
    assert.equal(calls, 1)
    const b = face()            // 同行第二次：必须已命中，而不是再重建
    assert.equal(b, a, '写入后第二次求值就该命中（反序读键会在这里露馅）')
    assert.equal(calls, 1, `重建只应发生 1 次（实际 ${calls}）`)
    s.appendUser('二')          // 再写一次 → 必须重新建档
    assert.notEqual(face(), a)
    assert.equal(calls, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('session.revision：load() 后派生纪元已推进（窗口化截断与重建都在案）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const mk = (id) => createSessionStore({ configDir: dir, cwd: dir, sessionId: id })
    const a = mk('rev-load')
    a.appendUser('持久化的一条')
    const b = mk('rev-load')
    const before = b.revision()
    await b.load()
    assert.notEqual(b.revision(), before, 'load 重建 surface 必须 bump（否则恢复会话会拿到空请求面）')
    assert.ok(b.deriveMessages().length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('端到端：session + 工厂——append 后请求面必须反映新历史（不陈旧）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reqface-'))
  try {
    const s = createSessionStore({ configDir: dir, cwd: dir, sessionId: 'rev-e2e' })
    const face = createRequestFace({
      getBase: () => s.deriveMessages(),
      getRevision: () => s.revision(),
      getSkip: () => 0,
      getSystem: () => 'SYS',
      on: () => true,
    })
    const a = face()
    assert.equal(a.length, 1, '空历史只剩 system 前缀')
    s.appendUser('新增')
    const b = face()
    assert.notEqual(a, b)
    assert.equal(b.length, 2, 'append 后请求面必须带上新消息（缓存若漏失效这里会停在 1）')
    assert.equal(face(), b, '再次求值应命中')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
