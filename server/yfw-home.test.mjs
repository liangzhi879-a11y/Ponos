import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveYfwHome } from './yfw-home.cjs'

// 每用例保存/还原相关 env（同一文件内顺序执行 OK；跨文件 env 竞争由
// node --test 按文件分进程天然隔离）。还原模式照抄 browser-common.test.mjs:189-203。
const KEYS = ['YFWORKING_HOME', 'CLAUDE_CONFIG_DIR']
function saveEnv() {
  const prev = {}
  for (const k of KEYS) prev[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  return () => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

test('resolveYfwHome: env 未设 → 默认 <homedir>/.yfworking', () => {
  const restore = saveEnv()
  try {
    assert.equal(resolveYfwHome(), join(homedir(), '.yfworking'))
  } finally { restore() }
})

test('resolveYfwHome: YFWORKING_HOME 设置 → 直接采用', () => {
  const restore = saveEnv()
  try {
    process.env.YFWORKING_HOME = 'D:\\iso-home\\new-yfw'
    assert.equal(resolveYfwHome(), 'D:\\iso-home\\new-yfw')
  } finally { restore() }
})

test('resolveYfwHome: 仅 CLAUDE_CONFIG_DIR → 采用之', () => {
  const restore = saveEnv()
  try {
    process.env.CLAUDE_CONFIG_DIR = 'C:\\tmp\\cc-home'
    assert.equal(resolveYfwHome(), 'C:\\tmp\\cc-home')
  } finally { restore() }
})

test('resolveYfwHome: YFWORKING_HOME 优先于 CLAUDE_CONFIG_DIR', () => {
  const restore = saveEnv()
  try {
    process.env.CLAUDE_CONFIG_DIR = 'C:\\tmp\\cc-home'
    process.env.YFWORKING_HOME = 'D:\\iso-home\\new-yfw'
    assert.equal(resolveYfwHome(), 'D:\\iso-home\\new-yfw')
  } finally { restore() }
})

test('resolveYfwHome: YFWORKING_HOME 置空串视为未设（falsy）', () => {
  const restore = saveEnv()
  try {
    process.env.YFWORKING_HOME = ''
    process.env.CLAUDE_CONFIG_DIR = 'C:\\tmp\\cc-home'
    assert.equal(resolveYfwHome(), 'C:\\tmp\\cc-home')
  } finally { restore() }
})
