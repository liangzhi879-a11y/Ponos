// yfwturbo dev 版本契约：单一数据源 version.mjs，格式 dev <major>.<minor>
// 升级 dev 版本时同步更新本测试的期望值（双处一致即完成一次版本 bump）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { YFW_VERSION } from '../version.mjs'

test('YFW_VERSION 符合 dev 版本格式', () => {
  assert.match(YFW_VERSION, /^dev \d+\.\d+$/, `非法版本格式: ${YFW_VERSION}`)
})

test('当前 dev 版本号（升级时同步更新）', () => {
  assert.equal(YFW_VERSION, 'dev 0.1')
})
