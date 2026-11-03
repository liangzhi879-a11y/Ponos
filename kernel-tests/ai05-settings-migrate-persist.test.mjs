// AI-05 修复验证（P3）：settings 迁移只在内存生效 —— schemaVersion 永久停在旧值。
//
// 【缺陷】`kernel/settings.mjs` 的 `loadSettings` 调 `migrateSettings(user)` 拿到迁移后的数据，
//   **但从不写回** settings.json。后果：
//   · 每次启动都要重跑一遍迁移（白费）；
//   · 磁盘上的 `schemaVersion` 永远是旧值 ⇒ 任何"按版本判断"的下游逻辑（诊断、兼容分支、
//     甚至是"是否需要提示用户重新配置"）都永远看到旧版本；
//   · 迁移链越长，这个问题的可见后果越大（未来 v1→v2→v3 时，每次启动都要串行重跑全部迁移）。
//
// 【修法】迁移后**原子回写** + 留 `.bak`：
//   · 只在真的发生迁移（`migrated === true`）时写，避免每次启动都碰磁盘；
//   · 写失败**只记日志、不阻断启动**（配置读不出来比"版本号没更新"严重得多）；
//   · `.bak` 是回退保障：迁移函数写错了，用户还能拿回原文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings } from '../kernel/settings.mjs'
import { SCHEMA_VERSION } from '../version.mjs'

const mkdir = () => mkdtempSync(join(tmpdir(), 'ponos-ai05-'))

test('★ AI-05：迁移后必须把新 schemaVersion 回写到 settings.json', () => {
  const dir = mkdir()
  try {
    const p = join(dir, 'settings.json')
    // v0：没有 schemaVersion 字段（旧文件形态）
    writeFileSync(p, JSON.stringify({ permissions: { allow: [] } }, null, 2), 'utf8')

    const r = loadSettings({ configDir: dir, cwd: '' })
    assert.ok(r, 'loadSettings 必须返回结果')

    const after = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(after.schemaVersion, SCHEMA_VERSION,
      `迁移后磁盘上的 schemaVersion 必须是 ${SCHEMA_VERSION} —— `
      + `实得 ${JSON.stringify(after.schemaVersion)}（说明迁移只在内存生效，没回写）`)
    // 原有配置项不能丢
    assert.ok(after.permissions, '迁移回写不得丢掉原有配置项')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★ AI-05：回写前必须留 .bak（迁移函数写错了用户还能拿回原文件）', () => {
  const dir = mkdir()
  try {
    const p = join(dir, 'settings.json')
    const original = { permissions: { allow: ['Bash:git *'] } }
    writeFileSync(p, JSON.stringify(original, null, 2), 'utf8')

    loadSettings({ configDir: dir, cwd: '' })

    const bak = `${p}.bak`
    assert.ok(existsSync(bak), `必须留下 ${bak} 作为回退保障`)
    const bakData = JSON.parse(readFileSync(bak, 'utf8'))
    assert.deepEqual(bakData, original,
      '.bak 必须是**迁移前**的原样内容，否则回退没有意义')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★ AI-05：已是最新版本时不得重写文件（避免每次启动都碰磁盘）', () => {
  const dir = mkdir()
  try {
    const p = join(dir, 'settings.json')
    const fresh = { schemaVersion: SCHEMA_VERSION, permissions: { allow: [] } }
    writeFileSync(p, JSON.stringify(fresh, null, 2), 'utf8')
    const before = readFileSync(p, 'utf8')

    loadSettings({ configDir: dir, cwd: '' })

    assert.equal(readFileSync(p, 'utf8'), before,
      '已是最新版本时不得改写文件 —— 否则每次启动都产生无谓的磁盘写与 .bak 堆积')
    assert.ok(!existsSync(`${p}.bak`),
      '未发生迁移时不应产生 .bak（否则备份目录会被无意义文件填满）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★ AI-05：回写失败不得阻断启动（配置读得出来比版本号新更重要）', () => {
  const dir = mkdir()
  try {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['x'] } }, null, 2), 'utf8')
    // 制造"写不进去"：把文件设为只读（Windows 上 fs 会抛 EACCES/EPERM）
    try { require('node:fs').chmodSync(p, 0o444) } catch { /* 可能不支持 */ }

    // 关键：不抛异常，且仍返回内存中的迁移结果
    const r = loadSettings({ configDir: dir, cwd: '' })
    assert.ok(r, '回写失败时 loadSettings 仍必须正常返回（不得阻断启动）')
  } finally {
    try { require('node:fs').chmodSync(join(dir, 'settings.json'), 0o666) } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
