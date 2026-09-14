// M2：桌面侧 LLM 原本只有 run_command + submit_spec，无法读帮助/列目录/看数据格式，
// 只能凭训练记忆猜 —— 这是"接不进来"的核心原因之一。本文件锁死两个只读探索工具的安全边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { resolveExplorePath, listDir, readTextFile } = require('../electron/app-explore.cjs')

test('resolveExplorePath：只允许目标程序目录与用户数据目录之内', () => {
  const roots = ['C:/Apps/Aseprite', 'C:/Users/me/AppData/Roaming/Aseprite']
  assert.ok(resolveExplorePath(roots, 'C:/Apps/Aseprite/scripts') .startsWith('C:/Apps/Aseprite'))
  assert.throws(() => resolveExplorePath(roots, 'C:/Windows/System32'), /超出允许范围/)
  assert.throws(() => resolveExplorePath(roots, 'C:/Apps/../Windows'), /超出允许范围/, '路径穿越要挡住')
})

test('listDir：只列条目，不读内容', async () => {
  const r = await listDir({ path: 'C:/Apps/Aseprite' }, { roots: ['C:/Apps/Aseprite'], readdir: async () => [
    { name: 'aseprite.exe', isDirectory: () => false, size: 10 },
    { name: 'scripts', isDirectory: () => true, size: 0 },
  ] })
  assert.deepEqual(r.entries, [
    { name: 'aseprite.exe', type: 'file', size: 10 },
    { name: 'scripts', type: 'dir', size: 0 },
  ])
})

test('readTextFile：超上限截断并标记（不许把大文件灌进上下文）', async () => {
  const r = await readTextFile({ path: 'C:/Apps/Aseprite/a.txt', maxBytes: 5 }, {
    roots: ['C:/Apps/Aseprite'], readFile: async () => 'abcdefghij',
  })
  assert.equal(r.text, 'abcde')
  assert.equal(r.truncated, true)
})

test('readTextFile：二进制内容拒绝（回明确原因，不返回乱码）', async () => {
  const r = await readTextFile({ path: 'C:/Apps/Aseprite/a.bin' }, {
    roots: ['C:/Apps/Aseprite'], readFile: async () => Buffer.from([0, 1, 2, 0, 3]),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /二进制/)
})

test('两个工具越界时都返回错误而非抛异常（模型要能读到错误并改正）', async () => {
  const l = await listDir({ path: 'C:/Windows' }, { roots: ['C:/Apps/Aseprite'], readdir: async () => [] })
  assert.equal(l.ok, false)
  assert.match(l.error, /超出允许范围/)
  const r = await readTextFile({ path: 'C:/Windows/win.ini' }, { roots: ['C:/Apps/Aseprite'], readFile: async () => 'x' })
  assert.equal(r.ok, false)
})
