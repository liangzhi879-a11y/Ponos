import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genApis, inferSensitiveParams } from '../scripts/gen-apis.mjs'
import { migrateApis } from '../yfljsj.mjs'

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
  assert.deepEqual(pageCmd.params.current, { type: 'number', required: true, desc: '页码（从1开始）', auto: false })
  assert.deepEqual(pageCmd.params.size, { type: 'number', required: true, desc: '每页条数' })
})

// ==================== 合并前审阅修复 I-4：敏感字段推断 ====================

test('genApis 敏感字段推断：PII 资源读接口声明敏感字段（required:false 响应字段）', () => {
  const out = genApis(sample)
  const sysUserPage = out.modules.user.commands.find(c => c.action === 'sysUser-page')
  assert.ok(sysUserPage)
  for (const f of ['password', 'mobile', 'idCard', 'phone']) {
    assert.equal(sysUserPage.params[f].sensitive, true, `${f} 应标 sensitive`)
    assert.equal(sysUserPage.params[f].required, false, `${f} 是响应字段声明，非必填请求参数`)
  }
  // 分页参数仍在（合并不冲突）
  assert.equal(sysUserPage.params.current.type, 'number')
  assert.equal(sysUserPage.params.size.type, 'number')
  // 非 PII 资源（asset/building）不声明敏感字段
  const b = out.modules.asset.commands.find(c => c.action === 'building-list')
  assert.ok(!b.params.password && !b.params.mobile)
})

test('inferSensitiveParams：非 PII 路径 / 写动作 / 空片段不声明', () => {
  assert.ok(inferSensitiveParams('/user/sysUser/page')) // PII 资源 + 读动作
  assert.equal(inferSensitiveParams('/asset/building/list'), undefined) // 非 PII 资源
  assert.equal(inferSensitiveParams('/user/sysUser/add'), undefined) // 写动作不声明（响应 PII 主要出现在读接口）
  assert.equal(inferSensitiveParams('/user/sysUser/downloadTemplate'), undefined) // 模板动作
  assert.equal(inferSensitiveParams('/x'), undefined)
})

// ==================== Task 1：命令表 v2 — params 对象定义 + v1 无损迁移 ====================

test('genApis v2：params 升级为对象定义', () => {
  const out = genApis(sample)
  const pageCmd = out.modules.asset.commands.find(c => c.action === 'building-page')
  // v2: { current: {type:'number', required:true, desc:...}, size: {...} }
  assert.equal(pageCmd.params.current.type, 'number')
  assert.equal(pageCmd.params.current.required, true)
  assert.equal(pageCmd.params.size.type, 'number')
})

test('migrateApis：v1 字符串 params 无损迁移 v2', () => {
  const v1 = {
    version: 1,
    services: { rcms: 'x' },
    modules: { asset: { title: 'asset', service: 'rcms', commands: [
      { action: 'building-page', method: 'POST', path: '/asset/building/page', params: { current: 'number', size: 'number' }, kind: 'read' },
    ] } },
  }
  const v2 = migrateApis(v1)
  assert.equal(v2.version, 2)
  assert.equal(v2.modules.asset.commands[0].params.current.type, 'number')
  assert.equal(v2.modules.asset.commands[0].params.current.required, true)
})

// ==================== Task 6：核心命令字段模板（真机实测沉淀） ====================

const coreCalls = [
  { path: '/workbench/projectInfo/add', methods: 'POST', chunks: [] },
  { path: '/workbench/projectAppro/add', methods: 'POST', chunks: [] },
  { path: '/enterprise/declare/rdItem/add', methods: 'POST', chunks: [] },
]

function findCmd(out, path) {
  return Object.values(out.modules).flatMap(m => m.commands).find(c => c.path === path)
}

test('genApis 核心链路字段模板：projectInfo-add 补齐完整字段', () => {
  const out = genApis(coreCalls)
  const cmd = findCmd(out, '/workbench/projectInfo/add')
  assert.ok(cmd)
  const p = cmd.params
  // 必填字段
  assert.deepEqual(p.projectName, { type: 'string', required: true, desc: '项目名称' })
  assert.deepEqual(p.projectCode, { type: 'string', required: true, desc: '项目编号' })
  // 枚举 + 来源标注
  assert.deepEqual(p.projectSource, { type: 'string', required: false, desc: '项目来源', enum: ['1', '2'], source: '参考已有项目' })
  assert.deepEqual(p.projectType.enum, ['1-1'])
  // 非模板命令无核心字段
  const page = findCmd(genApis([{ path: '/workbench/projectInfo/list', methods: 'POST', chunks: [] }]), '/workbench/projectInfo/list')
  assert.ok(!page.params.projectName)
})

test('genApis 核心链路字段模板：projectAppro-add 12 字段完整（含 source/enum）', () => {
  const out = genApis(coreCalls)
  const cmd = findCmd(out, '/workbench/projectAppro/add')
  assert.ok(cmd)
  const p = cmd.params
  const keys = Object.keys(p)
  assert.equal(keys.length, 12)
  assert.deepEqual(p.projectId, { type: 'number', required: true, desc: '项目ID', source: 'projectInfo-list.id' })
  assert.deepEqual(p.techEconTarget, { type: 'number', required: true, desc: '主要技术经济目标', enum: [1, 3] })
  assert.equal(p.headPersonId.source, 'user/sysUser/getUserList.id')
  assert.equal(p.dept.required, false)
})

test('genApis 核心链路字段模板：rdItem-add 补齐完整字段', () => {
  const out = genApis(coreCalls)
  const cmd = findCmd(out, '/enterprise/declare/rdItem/add')
  assert.ok(cmd)
  const p = cmd.params
  assert.equal(Object.keys(p).length, 11)
  assert.deepEqual(p.year, { type: 'number', required: true, desc: '年度' })
  assert.deepEqual(p.sourceProjectId, { type: 'number', required: true, desc: '关联项目ID', source: 'projectInfo-list.id' })
  assert.equal(p.startTime.format, 'yyyy-MM-dd')
  // 全部必填
  for (const v of Object.values(p)) assert.equal(v.required, true)
})
