import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genApis } from '../scripts/gen-apis.mjs'

const sample = [
  { path: '/asset/building/list', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/add', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/page', methods: 'POST', chunks: ['a.js'] },
  { path: '/asset/building/deleteById', methods: 'POST', chunks: ['a.js'] },
  { path: '/user/sysUser/page', methods: 'POST', chunks: ['b.js'] },
]

test('genApis 按模块分组生成命令表', () => {
  const out = genApis(sample)
  assert.ok(out.modules.asset)
  assert.ok(out.modules.user)
  // asset 模块 4 个命令
  assert.equal(out.modules.asset.commands.length, 4)
  // action 命名：资源-动作
  const actions = out.modules.asset.commands.map(c => c.action)
  assert.ok(actions.includes('building-list'))
  assert.ok(actions.includes('building-add'))
  assert.ok(actions.includes('building-deleteById'))
})

test('genApis 服务归属推断（user→upms, asset→rcms）', () => {
  const out = genApis(sample)
  assert.equal(out.modules.user.service, 'upms')
  assert.equal(out.modules.asset.service, 'rcms')
  assert.ok(out.services.rcms.includes('gateway.yfljsj.com'))
})

test('genApis 分页接口自动标注 page 参数', () => {
  const out = genApis(sample)
  const pageCmd = out.modules.asset.commands.find(c => c.action === 'building-page')
  assert.deepEqual(pageCmd.params, { current: 'number', size: 'number' })
})
