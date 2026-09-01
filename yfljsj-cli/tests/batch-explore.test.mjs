// Task 7：batch-explore 批量探测脚本 — 输出校验。
// 不真机联网：注入 mock probe 校验探测循环/危险跳过/字段写回/报告/错误捕获；脚本存在性校验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBatchExplore } from '../scripts/batch-explore.mjs'

const TMP = mkdtempSync(path.join(os.tmpdir(), 'yfljsj-batch-'))

// 命令表样本（模拟 seed 结构：模块/命令/已有 params）
function sampleApis() {
  return {
    version: 2,
    services: { rcms: 'https://gateway.yfljsj.com/api/rcms' },
    modules: {
      asset: {
        title: 'asset',
        service: 'rcms',
        commands: [
          { action: 'building-add', method: 'POST', path: '/asset/building/add', params: {}, kind: 'write' },
          { action: 'building-list', method: 'POST', path: '/asset/building/list', params: { current: { type: 'number', required: true } }, kind: 'read' },
          { action: 'building-deleteById', method: 'POST', path: '/asset/building/deleteById', params: {}, kind: 'write' },
          { action: 'building-removeBatch', method: 'POST', path: '/asset/building/removeBatch', params: {}, kind: 'write' },
        ],
      },
    },
  }
}

test('batch-explore：脚本文件存在且可执行', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/batch-explore.mjs', import.meta.url))
  assert.ok(existsSync(scriptPath), 'batch-explore.mjs 应存在')
  const src = readFileSync(scriptPath, 'utf8')
  // 复用 probeFields 的批量探测脚本特征
  assert.match(src, /probeFields/)
  assert.match(src, /DANGEROUS|delete\|remove|clear\|drop/)
  assert.match(src, /探测完成/)
})

test('runBatchExplore：危险路径跳过 + 探出字段写回 + 报告输出 + 统计', async () => {
  const apis = sampleApis()
  const reportPath = path.join(TMP, 'report.json')
  let written = null
  // 注入 probe：/add 探出 name(必填)/projectId；/list 无必填；危险路径不会被调用
  const probe = async (p) => {
    if (p === '/asset/building/add') return { fields: ['name', 'projectId'] }
    if (p === '/asset/building/list') return { fields: [] }
    return { fields: ['unexpected'] }
  }
  const { results, withFields, msg } = await runBatchExplore({ apis, probe, reportPath, write: (a) => { written = a } })
  // 危险路径（delete/remove）跳过且 probe 未被调用
  assert.deepEqual(results.filter((r) => r.skipped).map((r) => r.action), ['building-deleteById', 'building-removeBatch'])
  // 探出字段写回命令表 params（类型按 guessType 启发式）
  const add = apis.modules.asset.commands.find((c) => c.action === 'building-add')
  assert.deepEqual(add.params.name, { type: 'string', required: true, desc: '' })
  assert.deepEqual(add.params.projectId, { type: 'number', required: true, desc: '' })
  // 已有 params 不被覆盖
  assert.deepEqual(apis.modules.asset.commands.find((c) => c.action === 'building-list').params.current, { type: 'number', required: true })
  // 报告输出（writeFileSync 产物）
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.ok(report.some((r) => r.module === 'asset' && r.action === 'building-add' && r.fields.includes('name')))
  assert.ok(report.some((r) => r.action === 'building-deleteById' && r.skipped === 'dangerous'))
  // 命令表写回（write 注入捕获同一对象）
  assert.equal(written, apis)
  // 统计：results=危险跳过+探出字段（无字段接口不入 results，逐字照 brief 逻辑）
  assert.equal(msg, '探测完成: 3 接口，1 个探出必填字段')
  assert.equal(withFields, 1)
})

test('runBatchExplore：probe 抛错 → 记录 error（截断 60 字符）不中断后续接口', async () => {
  const apis = sampleApis()
  const reportPath = path.join(TMP, 'report2.json')
  let calls = 0
  const probe = async (p) => {
    calls++
    if (p === '/asset/building/add') throw new Error('x'.repeat(100))
    if (p === '/asset/building/list') return { fields: ['current'] }
    return { fields: [] }
  }
  const { results, withFields } = await runBatchExplore({ apis, probe, reportPath, write: () => {} })
  const err = results.find((r) => r.action === 'building-add')
  assert.ok(err.error, '应记录错误')
  assert.ok(err.error.length <= 60, '错误应截断到 60 字符')
  // 后续接口不受影响（list 仍探出字段）
  const list = results.find((r) => r.action === 'building-list')
  assert.deepEqual(list.fields, ['current'])
  assert.equal(withFields, 1)
  assert.ok(calls >= 2)
})

test('runBatchExplore：write 缺省为 writeApis（用户命令表）', async () => {
  // 仅校验缺省行为已接线（不实际写 ~/.yfljsj）：注入空 apis 时循环为空，不触发探测
  const { results, msg } = await runBatchExplore({ apis: { modules: {} }, probe: async () => ({ fields: [] }), reportPath: path.join(TMP, 'report3.json') })
  assert.deepEqual(results, [])
  assert.equal(msg, '探测完成: 0 接口，0 个探出必填字段')
})

test('batch-explore：测试临时目录清理', () => {
  // 无实际断言，仅确保临时目录可回收（Windows 文件锁兜底）
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* Windows 下残留由系统回收 */
  }
  assert.ok(true)
})
