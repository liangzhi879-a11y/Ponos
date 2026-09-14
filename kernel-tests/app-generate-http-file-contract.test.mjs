// M3：http / file 两个执行后端的**契约层**（提示词与结构校验共用的唯一真源）。
// 为什么单列一支测试：契约表同时驱动"给模型的提示词"与"校验模型的输出"，
// 两处一旦不一致，症状是"模型照下发的提示词写，却被同一套规则判非法"（D7 老毛病），真机上极难定位。
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  DRIVERS, ACTS_BY_DRIVER, actsFor, tableFor, validateSpecBasic, actContractLines, driverRulesLine,
  driverOf, HTTP_CONTRACT, FILE_CONTRACT, WEB_CONTRACT, DESKTOP_CONTRACT,
} = require('../electron/app-generate.cjs')

test('DRIVERS：新增 http / file（只增不改：既有四个值仍在）', () => {
  for (const d of ['browser', 'process', 'script', 'uia', 'http', 'file']) assert.ok(DRIVERS.includes(d), d)
})

test('ACTS_BY_DRIVER：http → request；file → read / query（只读，不含 write）', () => {
  assert.deepEqual(ACTS_BY_DRIVER.http, ['request'])
  assert.deepEqual(ACTS_BY_DRIVER.file, ['read', 'query'])
  assert.ok(!ACTS_BY_DRIVER.file.includes('write'), 'file 只读：不提供写操作（用户明确要求）')
})

test('tableFor：http/file 各用各的契约表（绝不能落到桌面表）', () => {
  assert.equal(tableFor('http'), HTTP_CONTRACT)
  assert.equal(tableFor('file'), FILE_CONTRACT)
  assert.equal(tableFor('browser'), WEB_CONTRACT)
  assert.equal(tableFor('process'), DESKTOP_CONTRACT)
  assert.equal(tableFor('script'), DESKTOP_CONTRACT)
  assert.equal(tableFor('uia'), DESKTOP_CONTRACT)
})

test('★ 不变量：每个驱动的每个 act 都必须有自己的字段契约（缺一条就会下发"写不对的提示词"）', () => {
  for (const d of DRIVERS) {
    const table = tableFor(d)
    for (const act of actsFor(d)) assert.ok(table[act], `driver=${d} act=${act} 在契约表里没有条目`)
  }
})

test('actContractLines / driverRulesLine：http 与 file 的字段说明真的下发', () => {
  const http = actContractLines('http')
  assert.ok(http.includes('request') && http.includes('"url"'), http)
  const file = actContractLines('file')
  assert.ok(file.includes('read') && file.includes('"path"'), file)
  assert.ok(file.includes('query') && file.includes('"select"'), file)
  assert.ok(driverRulesLine('http').includes('驱动：http'))
  assert.ok(driverRulesLine('file').includes('只读'), driverRulesLine('file'))
})

test('★ 向后兼容：既有 web / desktop / 历史别名 web Spec 照样合法', () => {
  const web = {
    specVersion: 1, appId: 'w', name: '某站', driver: 'browser', target: { type: 'web', url: 'https://e.com/' }, expose: { mode: 'console' },
    commands: [{ action: 'listAll', title: '查询全部', kind: 'read', params: [], steps: [{ act: 'goto', url: '/list' }, { act: 'snapshot', save: 'r' }] }],
  }
  assert.deepEqual(validateSpecBasic(web).errors, [])
  const desk = {
    specVersion: 1, appId: 'd', name: '本地', driver: 'process', target: { type: 'desktop', exePath: 'C:/x/y.exe' }, expose: { mode: 'console' },
    commands: [{ action: 'ver', title: '查看版本', kind: 'read', params: [], steps: [{ act: 'cli', argv: ['--version'], save: 'o' }] }],
  }
  assert.deepEqual(validateSpecBasic(desk).errors, [])
  assert.equal(validateSpecBasic({ ...web, driver: 'web' }).ok, true, '历史别名 web 仍合法')
})

test('http 驱动 Spec：字段齐 → 合法；缺 url → 报错点名该字段', () => {
  const okHttp = {
    specVersion: 1, appId: 'h', name: '接口', driver: 'http', target: { type: 'desktop', exePath: 'C:/x/y.exe' }, expose: { mode: 'console' },
    commands: [{ action: 'listItems', title: '查询条目', kind: 'read', params: [], steps: [{ act: 'request', url: 'https://api.example.com/items', save: 'items' }] }],
  }
  assert.deepEqual(validateSpecBasic(okHttp).errors, [])
  const badHttp = { ...okHttp, commands: [{ ...okHttp.commands[0], steps: [{ act: 'request' }] }] }
  const errs = validateSpecBasic(badHttp).errors
  assert.ok(errs.some((e) => e.includes('缺少必填字段 "url"')), errs.join('｜'))
})

test('file 驱动 Spec：字段齐 → 合法；缺 path → 报错点名该字段', () => {
  const okFile = {
    specVersion: 1, appId: 'f', name: '数据', driver: 'file', target: { type: 'desktop', exePath: 'C:/x/y.exe' }, expose: { mode: 'console' },
    commands: [{ action: 'readProject', title: '读取工程文件', kind: 'read', params: [], steps: [{ act: 'read', path: 'C:/x/p.json', format: 'json', save: 'doc' }] }],
  }
  assert.deepEqual(validateSpecBasic(okFile).errors, [])
  const badFile = { ...okFile, commands: [{ ...okFile.commands[0], steps: [{ act: 'read' }] }] }
  const errs = validateSpecBasic(badFile).errors
  assert.ok(errs.some((e) => e.includes('缺少必填字段 "path"')), errs.join('｜'))
})

test('★ file 驱动不接受写操作（write 不在允许 act 里，报错要点名允许的 act）', () => {
  const spec = {
    specVersion: 1, appId: 'f2', name: '数据', driver: 'file', target: { type: 'desktop', exePath: 'C:/x/y.exe' }, expose: { mode: 'console' },
    commands: [{ action: 'writeIt', title: '写入文件', kind: 'write', params: [], steps: [{ act: 'write', path: 'C:/x/p.json', from: 'doc' }] }],
  }
  const r = validateSpecBasic(spec)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('act 不合法') && e.includes('read')), r.errors.join('｜'))
})

test('driverOf：http / file 是合法驱动值（不再被推成 uia）', () => {
  assert.equal(driverOf({ driver: 'http', target: { type: 'desktop' } }), 'http')
  assert.equal(driverOf({ driver: 'file', target: { type: 'desktop' } }), 'file')
})
