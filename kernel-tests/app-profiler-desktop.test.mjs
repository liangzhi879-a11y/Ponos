// Task 1.8：desktop 三级探测（命中即停 + 安全守卫）
process.env.PONOS_MOCK_API = '1'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { probeDesktop, defaultProcessProbe, defaultScriptProbe, isSystemPath } = require('../electron/app-profiler.cjs')

test('process 命中即停（不再探 script/uia）', async () => {
  let scriptCalled = false
  const r = await probeDesktop({ exePath: 'a.exe', deps: {
    processProbe: async () => ({ ok: true, help: 'usage: a' }),
    scriptProbe: async () => { scriptCalled = true; return { ok: true } },
  } })
  assert.equal(r.level, 'process')
  assert.equal(scriptCalled, false, '命中 process 后不应再探 script')
})

test('process 失败 → script 命中', async () => {
  const r = await probeDesktop({ exePath: 'a.exe', deps: {
    processProbe: async () => ({ ok: false }),
    scriptProbe: async () => ({ ok: true, scriptDirs: ['lua'] }),
  } })
  assert.equal(r.level, 'script')
})

test('process/script 都失败 → uia 兜底', async () => {
  const r = await probeDesktop({ exePath: 'a.exe', deps: {
    processProbe: async () => ({ ok: false }),
    scriptProbe: async () => ({ ok: false }),
  } })
  assert.equal(r.level, 'uia')
})

test('探测抛错不吞（降级但保留证据）', async () => {
  const r = await probeDesktop({ exePath: 'a.exe', deps: {
    processProbe: async () => { throw new Error('EPERM') },
    scriptProbe: async () => { throw new Error('ENOENT') },
  } })
  assert.equal(r.level, 'uia')
})

test('exePath 缺失 → 直接 uia（不崩溃）', async () => {
  const r = await probeDesktop({ exePath: undefined, deps: { processProbe: async () => ({ ok: false }), scriptProbe: async () => ({ ok: false }) } })
  assert.equal(r.level, 'uia')
  assert.ok(r.evidence.note.includes('exePath'))
})

// ---- 安全守卫（探测会真的拉起进程，守卫必须在执行之前拦住） ----

test('defaultProcessProbe：拒绝相对路径（不执行任何进程）', async () => {
  const r = await defaultProcessProbe({ exePath: 'relative.exe' })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('绝对路径'))
})

test('defaultProcessProbe：不存在的路径 → 拒绝', async () => {
  const r = await defaultProcessProbe({ exePath: 'C:/definitely/not/here/nope.exe' })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('不存在'))
})

test('defaultProcessProbe：系统目录 → 拒绝（Windows 与 POSIX 双分支）', () => {
  if (process.platform === 'win32') {
    const winDir = process.env.SystemRoot || 'C:\\Windows'
    assert.equal(isSystemPath(winDir + '\\System32\\cmd.exe'), true)
  } else {
    assert.equal(isSystemPath('/usr/bin/env'), true)
  }
  // 普通用户目录不判为系统目录
  assert.equal(isSystemPath(process.platform === 'win32' ? 'C:\\Users\\me\\app.exe' : '/home/me/app'), false)
})

test('defaultProcessProbe：系统目录下的 exe → 拒绝且不动进程', async () => {
  const target = process.platform === 'win32'
    ? (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe'
    : '/bin/sh'
  const r = await defaultProcessProbe({ exePath: target })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('系统目录'))
})

test('defaultProcessProbe：缺 exePath → 结构化失败（不抛）', async () => {
  const r = await defaultProcessProbe({ exePath: undefined })
  assert.equal(r.ok, false)
})

test('defaultScriptProbe：缺参/非法路径 → 结构化失败（不抛）', async () => {
  assert.equal((await defaultScriptProbe({ exePath: undefined })).ok, false)
  assert.equal((await defaultScriptProbe({ exePath: 'relative.exe' })).ok, false)
})

test('defaultScriptProbe：真实目录（node 自身所在目录无脚本目录也应结构化返回）', async () => {
  const r = await defaultScriptProbe({ exePath: process.execPath })
  assert.equal(typeof r.ok, 'boolean')
})
