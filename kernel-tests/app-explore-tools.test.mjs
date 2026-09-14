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

// ---------- ★ M2 实质失效修复：工具结果必须带 `summary` ----------
//
// 原实现只返回结构化字段（entries / text），而 app-agent 的 toolResultText **只读 `summary`**：
// `list_dir` 成功 → 模型收到"（无摘要）"（目录内容全丢）、`read_file` 成功 → 正文全丢、
// 越界 → 连"超出允许范围"都读不到（与教义里"照错误改正即可"直接矛盾）。
// 单测原来只断言原始返回体 → 形式具备、实质失效。以下用例锁死"模型实际能读到什么"。

test('★ listDir 成功：summary 必须含真实文件名（不是"无摘要"）', async () => {
  const r = await listDir({ path: 'C:/Apps/Aseprite' }, { roots: ['C:/Apps/Aseprite'], readdir: async () => [
    { name: 'aseprite.exe', isDirectory: () => false, size: 10 },
    { name: 'scripts', isDirectory: () => true, size: 0 },
  ] })
  assert.equal(r.ok, true)
  assert.ok(r.summary.includes('aseprite.exe'), `要含真实文件名：${r.summary}`)
  assert.ok(r.summary.includes('scripts'), `要含子目录名：${r.summary}`)
  assert.ok(r.summary.includes('10B'), `要含体积（模型据此判断该不该读）：${r.summary}`)
  assert.ok(!r.summary.includes('无摘要'), '不许再出现"无摘要"')
})

test('★ listDir 空目录：summary 说"空目录"（也是有效情报，不是"无摘要"）', async () => {
  const r = await listDir({ path: 'C:/Apps/Aseprite/empty' }, { roots: ['C:/Apps/Aseprite'], readdir: async () => [] })
  assert.equal(r.summary, '(空目录)')
})

test('★ readTextFile 成功：summary 必须含正文（模型要真的"看得到"内容）', async () => {
  const r = await readTextFile({ path: 'C:/Apps/Aseprite/notes.txt' }, {
    roots: ['C:/Apps/Aseprite'], readFile: async () => 'theme=dark\nlang=zh',
  })
  assert.equal(r.ok, true)
  assert.ok(r.summary.includes('theme=dark'), `要含正文：${r.summary}`)
  assert.ok(r.summary.includes('lang=zh'))
})

test('★ readTextFile 截断：summary 里要带截断提示与总字节数（模型要知道自己只看到一部分）', async () => {
  const r = await readTextFile({ path: 'C:/Apps/Aseprite/a.txt', maxBytes: 5 }, {
    roots: ['C:/Apps/Aseprite'], readFile: async () => 'abcdefghij',
  })
  assert.equal(r.summary.startsWith('abcde'), true, r.summary)
  assert.match(r.summary, /已截断，共 10 字节/)
})

test('★ 越界时 summary 也要含"超出允许范围"（错误必须真的到模型手上，且 ok:false）', async () => {
  const l = await listDir({ path: 'C:/Windows' }, { roots: ['C:/Apps/Aseprite'], readdir: async () => [] })
  assert.equal(l.ok, false)
  assert.match(l.summary, /列目录失败/)
  assert.match(l.summary, /超出允许范围/)
  const r = await readTextFile({ path: 'C:/Windows/win.ini' }, { roots: ['C:/Apps/Aseprite'], readFile: async () => 'x' })
  assert.equal(r.ok, false)
  assert.match(r.summary, /读取失败/)
  assert.match(r.summary, /超出允许范围/)
})

test('★ 二进制拒绝时 summary 要说清原因（不是"无摘要"）', async () => {
  const r = await readTextFile({ path: 'C:/Apps/Aseprite/a.bin' }, {
    roots: ['C:/Apps/Aseprite'], readFile: async () => Buffer.from([0, 1, 2, 0]),
  })
  assert.equal(r.ok, false)
  assert.match(r.summary, /读取失败：.*二进制/)
})

// ---------- ★ 修复：路径守卫大小写 ----------
//
// 真实现象（Windows）：`C:/PROGRAM FILES/Aseprite/scripts` 被判越界；更严重的是
// exploreRoots 用 basename 派生的小写名（aseprite）对不上真实目录（%APPDATA%\Aseprite）
// → 设计文档 §4.3 承诺的"用户数据目录"在真实机器上基本读不到。
// 两条都要守住：① win32 大小写不敏感；② 绝不能因此被 `..` 穿越。

test('★ win32：大小写不同的合法路径要放行（且返回原样路径给 fs）', () => {
  const got = resolveExplorePath(['C:/Apps/ASE'], 'C:/APPS/ASE/scripts', { caseInsensitive: true })
  assert.equal(got, 'C:/APPS/ASE/scripts', '返回的必须是模型给的原样路径（小写化会让大小写敏感的文件系统读不到）')
  if (process.platform === 'win32') {
    // 平台默认（不给 opts）也必须放行——真实 Windows 上就是这样被拒的
    assert.ok(resolveExplorePath(['C:/Apps/ASE'], 'C:/APPS/ASE/scripts'))
    assert.ok(resolveExplorePath(['c:/Program Files/Aseprite'], 'C:/PROGRAM FILES/Aseprite/scripts'))
  }
})

test('★ 大小写不敏感不得把守卫改松：`..` 穿透与相邻目录前缀仍必须被拦', () => {
  assert.throws(() => resolveExplorePath(['C:/Apps/ASE'], 'C:/apps/ase/../Windows', { caseInsensitive: true }), /超出允许范围/)
  assert.throws(() => resolveExplorePath(['C:/Apps/ASE'], 'C:/APPS/ASE/../../Windows', { caseInsensitive: true }), /超出允许范围/)
  assert.throws(() => resolveExplorePath(['C:/Apps/ASE'], 'C:/APPS/ASEX/scripts', { caseInsensitive: true }), /超出允许范围/, '前缀相近的兄弟目录不算在内')
  assert.throws(() => resolveExplorePath(['C:/Apps/ASE'], 'D:/APPS/ASE/scripts', { caseInsensitive: true }), /超出允许范围/, '换盘符不算在内')
})

test('大小写敏感语义（macOS/Linux）保持原样：`Foo` 与 `foo` 是两个目录', () => {
  assert.throws(() => resolveExplorePath(['/opt/Apps/ASE'], '/opt/Apps/ase/x', { caseInsensitive: false }), /超出允许范围/)
  assert.ok(resolveExplorePath(['/opt/Apps/ASE'], '/opt/Apps/ASE/x', { caseInsensitive: false }))
})
