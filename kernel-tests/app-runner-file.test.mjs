// M3：file 执行后端（**只读**）。全部只碰注入的假 deps.readFile —— 不碰真实文件系统，
// 因为这里要验的是"守卫拦不拦得住"，用真文件反而要造一堆临时目录、且清理会 flake。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { fileRunner, selectJson, parseReadValue, FILE_FORMATS } = require('../electron/app-runner-file.cjs')

const ROOT = process.platform === 'win32' ? 'C:/apps/demo' : '/apps/demo'
const P = (name) => `${ROOT}/${name}`

const SPEC = (steps, params = []) => ({
  specVersion: 1, appId: 'f', name: '本地文件', driver: 'file',
  target: { type: 'desktop', exePath: P('app.exe') },
  expose: { mode: 'console' },
  commands: [{ action: 'readProject', title: '读取工程', kind: 'read', params, steps }],
})

/** 假 readFile：只在"已知文件表"里读得到，其余按 ENOENT 抛（与真实 fs 同形） */
const fakeDeps = (files) => ({
  readFile: async (p) => {
    if (!(p in files)) {
      const e = new Error(`ENOENT: no such file or directory, open '${p}'`)
      e.code = 'ENOENT'
      throw e
    }
    return Buffer.from(files[p])
  },
})

const run = (opts) => fileRunner({ appId: 'f', action: 'readProject', args: {}, roots: [ROOT], ...opts })

test('1. read：纯文本原样回传，ok:true', async () => {
  const r = await run({ spec: SPEC([{ act: 'read', path: P('notes.txt') }]), deps: fakeDeps({ [P('notes.txt')]: 'hello\nworld' }) })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data, 'hello\nworld')
  assert.equal(r.kind, 'read')
})

test('2. read + format:json：回传解析后的对象（不是字符串）', async () => {
  const doc = { order: { id: 7 }, items: [{ name: 'a' }, { name: 'b' }] }
  const r = await run({ spec: SPEC([{ act: 'read', path: P('p.json'), format: 'json' }]), deps: fakeDeps({ [P('p.json')]: JSON.stringify(doc) }) })
  assert.equal(r.ok, true, r.error || '')
  assert.deepEqual(r.data, doc)
  assert.equal(typeof r.data, 'object')
})

test('3. query + 点分路径：取到嵌套值', async () => {
  const r = await run({
    spec: SPEC([{ act: 'query', path: P('p.json'), format: 'json', select: 'order.id' }]),
    deps: fakeDeps({ [P('p.json')]: JSON.stringify({ order: { id: 7 } }) }),
  })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data, 7)
})

test('4. query + [*] 展开：返回名字数组', async () => {
  const r = await run({
    spec: SPEC([{ act: 'query', path: P('p.json'), format: 'json', select: 'items[*].name' }]),
    deps: fakeDeps({ [P('p.json')]: JSON.stringify({ items: [{ name: 'a' }, { name: 'b' }] }) }),
  })
  assert.equal(r.ok, true, r.error || '')
  assert.deepEqual(r.data, ['a', 'b'])
})

test('selectJson：$ 前缀可省；空结果回 []（不是 undefined）；非法路径空手而归而不是乱猜', () => {
  const doc = { items: [{ name: 'a' }, { name: 'b' }] }
  assert.deepEqual(selectJson(doc, '$.items[*].name'), ['a', 'b'])
  assert.deepEqual(selectJson(doc, 'items[*].missing'), [])
  assert.deepEqual(selectJson(doc, 'nothing.here'), [])
  assert.equal(selectJson(doc, ''), doc, '空 select ⇒ 原样返回')
  // ★ 钉住计划原有语义（不是本任务的改进点）：展开后**恰好剩一个**元素时回标量、剩 0 个时回 []。
  //   类型不稳定的隐患已记入报告"遗留问题"，改它属于另一处语义变更（M5 展示层也要同步），不在本任务内。
  assert.equal(selectJson({ items: [{ name: 'a' }] }, 'items[*].name'), 'a')
  assert.deepEqual(selectJson({ items: [] }, 'items[*].name'), [])
})

test('5. 路径越界 / 穿越：ok:false + 错误含"超出允许范围"，且**不抛异常**', async () => {
  const deps = fakeDeps({ [`${ROOT}/notes.txt`]: 'ok' })
  const outside = await run({ spec: SPEC([{ act: 'read', path: 'C:/Windows/System32/drivers/etc/hosts' }]), deps })
  assert.equal(outside.ok, false)
  assert.ok(outside.error.includes('超出允许范围'), outside.error)
  const traversal = await run({ spec: SPEC([{ act: 'read', path: `${ROOT}/../secret.txt` }]), deps })
  assert.equal(traversal.ok, false)
  assert.ok(traversal.error.includes('超出允许范围'), traversal.error)
  // ★ 不抛：越界是"这条命令失败了"，不是异常（抛出去会让 IPC 层 500，模型看到的是栈而不是原因）
  await assert.doesNotReject(run({ spec: SPEC([{ act: 'read', path: '/etc/passwd' }]), deps }))
})

test('6. 二进制（含 \\0）：ok:false，错误说明疑似二进制', async () => {
  const r = await run({
    spec: SPEC([{ act: 'read', path: P('app.exe') }]),
    deps: fakeDeps({ [P('app.exe')]: Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]) }),
  })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('二进制'), r.error)
})

test('7. 超过 maxBytes：truncated:true，data 只含前 maxBytes', async () => {
  const big = `HEAD${'x'.repeat(100)}`
  const r = await run({ spec: SPEC([{ act: 'read', path: P('big.txt'), maxBytes: 4 }]), deps: fakeDeps({ [P('big.txt')]: big }) })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data, 'HEAD')
  assert.equal(r.data.length, 4)
})

test('7b. format:json 被截断 ⇒ 报错要说清"是被截断导致不完整"，并指向 query', async () => {
  const r = await run({
    spec: SPEC([{ act: 'read', path: P('big.json'), format: 'json', maxBytes: 8 }]),
    deps: fakeDeps({ [P('big.json')]: JSON.stringify({ a: 1, b: 2, c: 3 }) }),
  })
  assert.equal(r.ok, false)
  assert.ok(/截断/.test(r.error), r.error)
  assert.ok(r.error.includes('query'), r.error)
})

test('7c. format:json 解析失败 ⇒ 可读错误 + 解析位置信息（不是一句"JSON.parse 失败"）', async () => {
  const r = await run({ spec: SPEC([{ act: 'read', path: P('bad.json'), format: 'json' }]), deps: fakeDeps({ [P('bad.json')]: '{"a":1,,}' }) })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('JSON'), r.error)
  assert.ok(/position|第 \d+/.test(r.error), `要给解析位置：${r.error}`)
})

test('7d. parseReadValue / FILE_FORMATS：格式白名单（未知 format 按 text）', () => {
  assert.deepEqual(FILE_FORMATS, ['text', 'json'])
  assert.deepEqual(parseReadValue({ text: 'x', format: 'exe', truncated: false }), { ok: true, value: 'x' })
})

test('8. roots 缺失 / 未知 action / 混入 write act：分别可读失败，且都不抛', async () => {
  const noRoots = await fileRunner({ appId: 'f', action: 'readProject', args: {}, spec: SPEC([{ act: 'read', path: P('notes.txt') }]), deps: fakeDeps({ [P('notes.txt')]: 'x' }) })
  assert.equal(noRoots.ok, false)
  assert.ok(noRoots.error.includes('roots'), noRoots.error)

  const unknown = await run({ action: 'nope', spec: SPEC([{ act: 'read', path: P('notes.txt') }]), deps: fakeDeps({ [P('notes.txt')]: 'x' }) })
  assert.equal(unknown.ok, false)
  assert.ok(unknown.error.includes('未找到命令'), unknown.error)

  let readCalls = 0
  const write = await run({
    spec: SPEC([{ act: 'write', path: P('notes.txt'), text: 'hacked' }]),
    deps: { readFile: async () => { readCalls++; return Buffer.from('x') } },
  })
  assert.equal(write.ok, false)
  assert.ok(write.error.includes('file 驱动只读'), write.error)
  assert.equal(readCalls, 0, '只读后端：遇到 write 不得先读一遍再说失败')
})

test('9. 缺必填参数（params.required）→ 不读任何文件', async () => {
  let readCalls = 0
  const r = await run({
    action: 'readProject', args: {},
    spec: SPEC([{ act: 'read', path: P('${file}'), }], [{ name: 'file', required: true }]),
    deps: { readFile: async () => { readCalls++; return Buffer.from('x') } },
  })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('file'), r.error)
  assert.equal(readCalls, 0)
})

test('10. path 支持 ${参数名} 插值（与 desktop/http 后端同口径：app-util.interpolate）', async () => {
  const r = await fileRunner({
    appId: 'f', action: 'readProject', args: { name: 'p' },
    spec: SPEC([{ act: 'read', path: `${P('${name}.json')}`, format: 'json' }], [{ name: 'name', required: true }]),
    roots: [ROOT],
    deps: fakeDeps({ [P('p.json')]: '{"ok":1}' }),
  })
  assert.equal(r.ok, true, r.error || '')
  assert.deepEqual(r.data, { ok: 1 })
})

test('11. 多步命令：以**最后一个 save** 的结果为准（与 desktop 后端同语义）', async () => {
  const r = await run({
    spec: SPEC([
      { act: 'query', path: P('p.json'), format: 'json', select: 'items[*].name', save: 'names' },
      { act: 'query', path: P('p.json'), format: 'json', select: 'order.id', save: 'id' },
    ]),
    deps: fakeDeps({ [P('p.json')]: JSON.stringify({ order: { id: 3 }, items: [{ name: 'a' }, { name: 'b' }] }) }),
  })
  assert.equal(r.ok, true, r.error || '')
  assert.equal(r.data, 3, '多步时以最后一个 save 的结果为准（与 desktop 后端同语义）')
})
