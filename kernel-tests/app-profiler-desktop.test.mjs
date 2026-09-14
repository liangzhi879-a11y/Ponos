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

// ---- 安装目录 / .bat 包装器（真机 2026-09-14 Aseprite 反馈） ----
//
// 用户对 `D:\Program Files (x86)\Aseprite` 发起封装 → 界面只说"该目标未发现 CLI / 脚本接口"。
// 真实情况：① 填的是**安装目录**（旧实现见 isFile()=false 就直接判死）；② 该目录下
// `aseprite.exe --help` 有 5.8KB 完整帮助（Aseprite 自带 CLI）；③ 用户手上的 `ase-cli.bat`
// 包装器则因"批处理不能被 execFile 直接拉起"而恒失败。三者叠加成一句误导性结论。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('defaultProcessProbe：填安装目录 → 解析出同名主程序（辅助 .exe 不抢主位）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prof-dir-'))
  const dir = join(root, 'Aseprite')
  mkdirSync(dir, { recursive: true })
  // 空文件跑不出帮助，但**解析**这一步必须成功：失败原因里应出现主程序路径，而不是"是目录"
  writeFileSync(join(dir, 'aseprite.exe'), '', 'utf-8')
  writeFileSync(join(dir, 'gen.exe'), '', 'utf-8')
  try {
    const r = await defaultProcessProbe({ exePath: dir })
    assert.equal(r.ok, false, '空 exe 没有输出，仍应判失败')
    assert.ok(!r.reason.includes('是目录'), `目录应被解析而不是拒绝：${r.reason}`)
    assert.ok(r.reason.includes(join(dir, 'aseprite.exe')), `要报出解析到的主程序：${r.reason}`)
    assert.equal(r.exePath, join(dir, 'aseprite.exe'))
    assert.equal(r.tried.length, 4, '--help/-h/--version//? 四个开关都要试过并留证')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('defaultProcessProbe：目录里有多个 .exe 且无同名 → 如实要求指定具体程序（不瞎猜）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prof-multi-'))
  const dir = join(root, 'tools')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'alpha.exe'), '', 'utf-8')
  writeFileSync(join(dir, 'beta.exe'), '', 'utf-8')
  try {
    const r = await defaultProcessProbe({ exePath: dir })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('没有可确定的主程序'), `多候选必须要求用户指定：${r.reason}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('defaultProcessProbe：Windows 批处理包装器能跑起来（CRLF，走 shell）', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-bat-'))
  const bat = join(dir, 'my-cli.bat')
  // ★ 必须 CRLF：cmd.exe 解析 LF 行尾的批处理会错乱（真机里用户的 ase-cli.bat 正是 LF，
  //   于是 cmd 报"'…cmd' 不是内部或外部命令"，被误读成"这程序没有 CLI"）
  writeFileSync(bat, '@echo off\r\necho MY-CLI-USAGE-LINE\r\n', 'utf-8')
  try {
    const r = await defaultProcessProbe({ exePath: bat })
    assert.equal(r.ok, true, `批处理包装器应当被视为可用 CLI：${JSON.stringify(r.tried || r.reason)}`)
    assert.ok(r.help.includes('MY-CLI-USAGE-LINE'), `要拿到批处理的帮助输出：${r.help}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('probeDesktop：失败时把每层真实原因带回（供界面如实展示）', async () => {
  const r = await probeDesktop({ exePath: 'C:/definitely/not/here/nope.exe' })
  assert.equal(r.level, 'uia')
  assert.equal(r.evidence.level, 'uia')
  assert.ok(Array.isArray(r.evidence.attempts), 'attempts 必须存在')
  const cli = r.evidence.attempts.find((a) => a.level === 'process')
  const script = r.evidence.attempts.find((a) => a.level === 'script')
  assert.ok(cli.reason.includes('不存在'), `CLI 层原因要具体：${cli.reason}`)
  assert.ok(script?.reason, '脚本层原因也要给')
})

test('probeDesktop：探测抛错 → 原因里带上异常信息（不再只有一句笼统结论）', async () => {
  const r = await probeDesktop({ exePath: 'a.exe', deps: {
    processProbe: async () => { throw new Error('EPERM') },
    scriptProbe: async () => { throw new Error('ENOENT') },
  } })
  assert.equal(r.level, 'uia')
  assert.ok(r.evidence.attempts[0].reason.includes('EPERM'))
  assert.ok(r.evidence.attempts[1].reason.includes('ENOENT'))
})
