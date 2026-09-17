/**
 * fs-guard 单元测试（node:test）
 * 运行：node --test shared/fs-guard.test.mjs
 *
 * 覆盖 spec §7.1 攻击用例 1–5、9、10 的**逻辑层**（HTTP 层用例见 server/bridge-fs-guard.test.mjs）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveReadable,
  resolveWritable,
  assertExtAllowed,
  assertSizeOk,
  guardErrorResponse,
  FSGuardError,
} from './fs-guard.mjs'

/** 建一个隔离的临时根，内含 inside/ 与 sibling 目录 */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'fsguard-'))
  const root = join(base, 'root')
  const evil = join(base, 'root-evil') // 前缀绕过用：/root-evil 不得被 /root 放行
  mkdirSync(root, { recursive: true })
  mkdirSync(evil, { recursive: true })
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'ok.txt'), 'hello')
  writeFileSync(join(evil, 'pwn.txt'), 'pwn')
  return { base, root, evil }
}

const F = makeFixture()
process.on('exit', () => { try { rmSync(F.base, { recursive: true, force: true }) } catch {} })

const status = async (p) => {
  try { await p; return 200 } catch (e) { return e.code || e.message }
}

test('合法路径放行，并返回 realpath 后的绝对路径', async () => {
  const out = await resolveReadable(join(F.root, 'ok.txt'), { roots: [F.root], mode: 'enforce' })
  assert.equal(out, resolve(F.root, 'ok.txt'))
})

test('相对路径的越界访问被拦（EOUTSIDE）', async () => {
  const out = await status(resolveReadable(join(F.root, '..', 'root-evil', 'pwn.txt'), { roots: [F.root], mode: 'enforce' }))
  assert.equal(out, 'EOUTSIDE')
})

test('前缀绕过：/root-evil 不得被 /root 放行（必须用 path.relative 而非前缀比较）', async () => {
  // F.evil 的字面量确实以 F.root 开头（"root-evil" vs "root"），是经典前缀陷阱
  assert.ok(F.evil.startsWith(F.root), 'fixture 应构造出前缀相同的情形')
  const out = await status(resolveReadable(join(F.evil, 'pwn.txt'), { roots: [F.root], mode: 'enforce' }))
  assert.equal(out, 'EOUTSIDE')
})

test('符号链接指向根外 → 被 realpath 拦下', async (t) => {
  const link = join(F.root, 'escape-link')
  try {
    symlinkSync(F.evil, link, 'junction')
  } catch (e) {
    t.skip(`无法创建符号链接（可能缺权限）: ${e.message}`)
    return
  }
  const out = await status(resolveReadable(join(link, 'pwn.txt'), { roots: [F.root], mode: 'enforce' }))
  assert.equal(out, 'EOUTSIDE')
})

test('目标不存在（写新文件）时对最近的已存在父目录 realpath，仍能判定越界', async () => {
  const outsideNew = join(F.evil, 'brand-new.txt')
  const out = await status(resolveWritable(outsideNew, { roots: [F.root] }))
  assert.equal(out, 'EOUTSIDE')
})

test('目标不存在但位于允许根内 → 放行（写新文件不得被误拦）', async () => {
  const insideNew = join(F.root, 'sub', 'brand-new.txt')
  const out = await resolveWritable(insideNew, { roots: [F.root] })
  assert.equal(out, resolve(F.root, 'sub', 'brand-new.txt'))
})

test('denyRoots 是写的硬闸门：即使位于允许根内也拒（凭据目录保护）', async () => {
  const creds = join(F.root, 'settings.json')
  writeFileSync(creds, '{"token":"x"}')
  const out = await status(resolveWritable(creds, { roots: [F.root], denyRoots: [F.root] }))
  assert.equal(out, 'EOUTSIDE')
})

test('denyRoots 只作用于写；读同路径放行（D1-a：写排除数据根、读允许）', async () => {
  const creds = join(F.root, 'settings.json')
  writeFileSync(creds, '{"token":"x"}')
  const out = await resolveReadable(creds, { roots: [F.root], denyRoots: [F.root], mode: 'enforce' })
  assert.equal(out, resolve(F.root, 'settings.json'))
})

test('NUL / 控制字符 → EBADARG(400)', async () => {
  assert.equal(await status(resolveReadable('a\u0000b', { roots: [F.root], mode: 'enforce' })), 'EBADARG')
  assert.equal(await status(resolveReadable('a\u001fb', { roots: [F.root], mode: 'enforce' })), 'EBADARG')
})

test('空路径 / 非字符串 → EBADARG(400)', async () => {
  assert.equal(await status(resolveReadable('', { roots: [F.root], mode: 'enforce' })), 'EBADARG')
  assert.equal(await status(resolveReadable(null, { roots: [F.root], mode: 'enforce' })), 'EBADARG')
})

test('读侧默认 warn：越界只告警不拦（S1：/list-dir 的合法需求是任意目录）', async () => {
  const prev = process.env.YFW_FS_GUARD
  delete process.env.YFW_FS_GUARD
  try {
    const out = await resolveReadable(join(F.evil, 'pwn.txt'), { roots: [F.root] })
    assert.equal(out, resolve(F.evil, 'pwn.txt'), 'warn 级别应返回路径而不是抛错')
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_GUARD; else process.env.YFW_FS_GUARD = prev
  }
})

test('写侧默认 enforce：越界直接抛（S1：/write-file 仅 1 个调用点，误伤面最小）', async () => {
  const prev = process.env.YFW_FS_GUARD
  delete process.env.YFW_FS_GUARD
  try {
    assert.equal(await status(resolveWritable(join(F.evil, 'x.txt'), { roots: [F.root] })), 'EOUTSIDE')
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_GUARD; else process.env.YFW_FS_GUARD = prev
  }
})

test('YFW_FS_GUARD=off 时全部放行（单开关应急回滚）', async () => {
  const prev = process.env.YFW_FS_GUARD
  process.env.YFW_FS_GUARD = 'off'
  try {
    const out = await resolveWritable(join(F.evil, 'x.txt'), { roots: [F.root], denyRoots: [F.root] })
    assert.equal(out, resolve(F.evil, 'x.txt'))
  } finally {
    if (prev === undefined) delete process.env.YFW_FS_GUARD; else process.env.YFW_FS_GUARD = prev
  }
})

test('扩展名白名单', () => {
  assert.doesNotThrow(() => assertExtAllowed('/a/b.html', ['html', 'htm']))
  assert.throws(() => assertExtAllowed('/a/b.svg', ['html', 'htm']), (e) => e.code === 'EBADEXT' && e.status === 415)
  assert.doesNotThrow(() => assertExtAllowed('/a/b.svg')) // 不传 = 不校验
})

test('体积上限', () => {
  assert.doesNotThrow(() => assertSizeOk(100, 200))
  assert.throws(() => assertSizeOk(300, 200), (e) => e.code === 'ETOOLARGE' && e.status === 413)
})

test('denyPaths：凭据文件读也被拒（EPROTECTED）——读侧默认 warn 不拦越界，故这条必须独立生效', async () => {
  const creds = join(F.root, 'settings.json')
  writeFileSync(creds, '{"token":"x"}')
  // 注意：reads 的 roots 设成 root（creds 在内部 ⇒ 允许根不拦），只有 denyPaths 能拦
  const out = await status(resolveReadable(creds, { roots: [F.root], denyPaths: [creds], mode: 'warn' }))
  assert.equal(out, 'EPROTECTED', 'warn 级别下凭据拒绝仍须生效')
})

test('denyPaths：写同样被拒，且不影响同目录其它文件', async () => {
  const creds = join(F.root, 'auth.json')
  writeFileSync(creds, '{}')
  assert.equal(await status(resolveWritable(creds, { roots: [F.root], denyPaths: [creds] })), 'EPROTECTED')
  const ok = await resolveWritable(join(F.root, 'sub', 'normal.json'), { roots: [F.root], denyPaths: [creds] })
  assert.equal(ok, resolve(F.root, 'sub', 'normal.json'), '不得过度误伤')
})

test('guardErrorResponse 不回显路径（避免端点变成目录探测工具）', () => {
  const r = guardErrorResponse(new FSGuardError('EOUTSIDE', 'target is outside allowed roots', 403))
  assert.deepEqual(r, { status: 403, body: { error: 'target is outside allowed roots', code: 'EOUTSIDE' } })
  assert.ok(!JSON.stringify(r).includes(F.root), '错误体不得含任何解析后的路径')
  assert.equal(guardErrorResponse(new Error('其它错误')), null)
})
