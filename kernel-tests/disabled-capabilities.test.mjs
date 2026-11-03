// kernel-tests/disabled-capabilities.test.mjs
// E2 Task 4 Step 4（2026-09-26）：停用注册表的第三类键 `capabilities`（能力类别开关）。
//
// 为什么单独一个文件：这个键的失败模式**不是"报错"而是"静默丢失"**——归一白名单少它一项，
// json 里写着 `capabilities: ['provider']`、归一后没了，GUI 显示"已关"、内核照旧全开。
// 本仓两次踩过同款坑（`--spaces` / `--confirm` 漏登记被静默忽略），故这条断言必须存在，
// 且必须**反向钉住白名单没被放开**（未知键仍要丢，否则归一就不再是白名单）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDisabled, readDisabled, writeDisabled, disabledPath } from '../kernel/disabled.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ponos-disabled-cap-'))

test('★ 归一白名单必须认 capabilities（否则客户层开关被静默丢弃）', () => {
  const n = normalizeDisabled({ agents: ['a'], skills: ['s'], capabilities: ['web'] })
  assert.deepEqual(n.capabilities, ['web'])
})

test('未知键仍然丢弃（不放开白名单语义）', () => {
  const n = normalizeDisabled({ agents: [], skills: [], capabilities: [], 别的: ['x'] })
  assert.equal(n['别的'], undefined)
})

test('capabilities 与另两个键同款纪律：去空、去重、保序', () => {
  const n = normalizeDisabled({ capabilities: [' web ', 'provider', 'web', '', null, 42] })
  assert.deepEqual(n.capabilities, ['web', 'provider', '42'], '去空/去重/保序（数字也被 String 化，与 agents/skills 同口径）')
})

test('capabilities 类型非法 ⇒ 当空处理（读失败不得变成"全开"，但也不得抛）', () => {
  assert.deepEqual(normalizeDisabled({ capabilities: 'provider' }).capabilities, [], '字符串不是清单')
  assert.deepEqual(normalizeDisabled(null).capabilities, [])
})

test('读写往返：capabilities 落盘 + 回读一致（写路径漏比这一键同样会静默丢）', () => {
  const dir = tmp()
  try {
    const w = writeDisabled({ configDir: dir, data: { agents: ['a'], skills: ['s'], capabilities: ['provider', 'web'] } })
    assert.equal(w.ok, true, w.error)
    assert.deepEqual(w.data.capabilities, ['provider', 'web'], '返回值必须带上它（GUI 靠返回值刷新界面）')
    const onDisk = JSON.parse(readFileSync(disabledPath({ configDir: dir }), 'utf-8'))
    assert.deepEqual(onDisk.capabilities, ['provider', 'web'], '磁盘上必须有（"只改内存"= 假开关）')
    assert.deepEqual(readDisabled({ configDir: dir }).capabilities, ['provider', 'web'])
    assert.equal(readDisabled({ configDir: dir }).ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('坏注册表：capabilities 同样退化为空数组 + ok=false（不抛）', () => {
  const dir = tmp()
  try {
    writeFileSync(disabledPath({ configDir: dir }), '{ 坏', 'utf-8')
    const r = readDisabled({ configDir: dir })
    assert.deepEqual(r.capabilities, [])
    assert.equal(r.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('不同 configDir 之间不串味（客户层文件与停用表都在 configDir 下）', () => {
  const a = tmp(); const b = tmp()
  try {
    writeDisabled({ configDir: a, data: { capabilities: ['shell'] } })
    assert.deepEqual(readDisabled({ configDir: b }).capabilities, [], 'b 目录不该看到 a 的能力开关')
    assert.deepEqual(readDisabled({ configDir: a }).capabilities, ['shell'])
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }) }
})
