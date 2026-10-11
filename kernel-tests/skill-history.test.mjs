// kernel/skill-history.mjs —— 技能版本历史与回滚（演化 P2 §4.4 第 5/6 条）纯 IO 测试。
// 跑法：node --test kernel-tests/skill-history.test.mjs
//
// 钉住的关键行为（每条都能因**一处**改动变红）：
//   ① 快照 = 旧版正文进 `.history/<ts>.md`；首次安装无旧版 ⇒ no-skill（正常路径，不是错误）
//   ② 保留 10 版（剪枝按名=时间升序删最旧）
//   ③ 路径安全：id/ts 双白名单 + 越界拒绝（`..`/绝对路径/Windows 设备名一律抛错）
//   ④ CHANGELOG 追加（不重写文件、不覆盖用户自己写的内容）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HISTORY_KEEP, assertSafeSkillId, assertSafeTs, skillHistoryDir, skillVersionPath,
  versionStamp, snapshotSkill, listSkillVersions, readSkillVersion, pruneHistory, appendSkillChangelog,
} from '../kernel/skill-history.mjs'

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yfw-skillhist-'))
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ } }

function seedSkill(root, id, content) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

test('★ 路径安全：id/ts 双白名单（`..`/绝对路径/设备名/畸形时间戳一律抛错）', () => {
  assert.equal(assertSafeSkillId('gxtz-ip-tables'), 'gxtz-ip-tables')
  // 首尾空白先 trim 再校验：'  a  ' 与 'a' 是同一个技能（拼路径前已归一，不产生歧义）
  assert.equal(assertSafeSkillId('  gxtz-ip-tables  '), 'gxtz-ip-tables', '首尾空白归一（不是放行空白）')
  for (const bad of ['', '..', '../etc', 'a/b', 'a\\b', 'NUL', 'con', 'a.', '-lead', 'x y']) {
    assert.throws(() => assertSafeSkillId(bad), /非法技能 id/, `应拒: ${JSON.stringify(bad)}`)
  }
  const ok = versionStamp(new Date('2026-10-10T06:12:33.123Z'))
  assert.equal(ok, '2026-10-10T06-12-33-123Z')
  assert.equal(assertSafeTs(ok), ok)
  for (const bad of ['', '..', '/etc/passwd', '2026-10-10', 'x']) {
    assert.throws(() => assertSafeTs(bad), /非法版本号/, `应拒: ${JSON.stringify(bad)}`)
  }
})

test('★ 路径越界双保险：history 目录必须落在技能根之内', () => {
  const root = mkRoot()
  try {
    const d = skillHistoryDir(root, 'gxtz-ip-tables')
    assert.equal(d, path.join(path.resolve(root), 'gxtz-ip-tables', '.history'))
    assert.throws(() => skillHistoryDir(root, '../x'), /非法技能 id/)
  } finally { rm(root) }
})

test('★ 首次安装：无 SKILL.md ⇒ no-skill（正常路径，不是错误）；有则快照进 .history', () => {
  const root = mkRoot()
  try {
    const none = snapshotSkill({ skillRoot: root, id: 'skill-a' })
    assert.equal(none.ok, false)
    assert.equal(none.reason, 'no-skill', '没有旧版可备份是正常路径（调用方不报错）')

    seedSkill(root, 'skill-a', 'v1 正文')
    const r = snapshotSkill({ skillRoot: root, id: 'skill-a', ts: '2026-10-10T06-00-00-000Z' })
    assert.equal(r.ok, true)
    assert.equal(r.ts, '2026-10-10T06-00-00-000Z')
    assert.equal(fs.readFileSync(r.path, 'utf-8'), 'v1 正文')
    assert.equal(readSkillVersion({ skillRoot: root, id: 'skill-a', ts: r.ts }), 'v1 正文')
  } finally { rm(root) }
})

test('★ 保留 10 版：写满 13 版 ⇒ 只剩最新 10，最旧 3 版被剪掉', () => {
  const root = mkRoot()
  try {
    seedSkill(root, 'skill-a', 'body')
    const pruned = []
    for (let i = 0; i < 13; i++) {
      const ts = `2026-10-10T06-00-${String(i).padStart(2, '0')}-000Z`
      const r = snapshotSkill({ skillRoot: root, id: 'skill-a', ts })
      pruned.push(...(r.pruned || []))
    }
    const list = listSkillVersions({ skillRoot: root, id: 'skill-a' })
    assert.equal(list.length, HISTORY_KEEP, `保留上限应为 ${HISTORY_KEEP}`)
    assert.equal(pruned.length, 3, '13 版写完后应剪掉 3 版')
    assert.equal(list[0].ts, '2026-10-10T06-00-12-000Z', '新→旧排序')
    assert.equal(list[list.length - 1].ts, '2026-10-10T06-00-03-000Z', '最旧的 3 版（00/01/02）已被剪')
    assert.equal(fs.existsSync(skillVersionPath(root, 'skill-a', '2026-10-10T06-00-02-000Z')), false)
  } finally { rm(root) }
})

test('listSkillVersions：无历史 ⇒ 空数组（不是错误）；带 bytes/at', () => {
  const root = mkRoot()
  try {
    assert.deepEqual(listSkillVersions({ skillRoot: root, id: 'skill-a' }), [])
    seedSkill(root, 'skill-a', 'body')
    snapshotSkill({ skillRoot: root, id: 'skill-a', ts: '2026-10-10T06-00-00-000Z' })
    const [v] = listSkillVersions({ skillRoot: root, id: 'skill-a' })
    assert.equal(v.ts, '2026-10-10T06-00-00-000Z')
    assert.equal(v.bytes, 4)
    assert.match(String(v.at), /^\d{4}-\d{2}-\d{2}T/)
  } finally { rm(root) }
})

test('readSkillVersion：不存在的版本 ⇒ null（调用方转 404，不猜内容）', () => {
  const root = mkRoot()
  try {
    assert.equal(readSkillVersion({ skillRoot: root, id: 'skill-a', ts: '2026-10-10T06-00-00-000Z' }), null)
  } finally { rm(root) }
})

test('★ CHANGELOG 追加：不重写文件（用户自己写的行必须留着）+ 不存在时带标题建', () => {
  const root = mkRoot()
  try {
    seedSkill(root, 'skill-a', 'body')
    const f = path.join(root, 'skill-a', 'CHANGELOG.md')
    const r1 = appendSkillChangelog({ skillRoot: root, id: 'skill-a', changeType: 'update', note: '候选 abc123', at: new Date('2026-10-10T06:00:00.000Z') })
    assert.equal(r1.ok, true)
    const first = fs.readFileSync(f, 'utf-8')
    assert.match(first, /# 变更记录/, '首次创建带标题')
    assert.match(first, /2026-10-10T06:00:00\.000Z · update · 候选 abc123/)

    // 模拟用户自己往里写一行：追加**不得**动它
    fs.appendFileSync(f, '- 手工记录：我改过触发词\n', 'utf-8')
    appendSkillChangelog({ skillRoot: root, id: 'skill-a', changeType: 'rollback', note: '回滚到 x', at: new Date('2026-10-10T07:00:00.000Z') })
    const second = fs.readFileSync(f, 'utf-8')
    assert.match(second, /手工记录：我改过触发词/, '用户自己写的行必须还在（追加而非重写）')
    assert.match(second, /rollback · 回滚到 x/)
    assert.ok(second.indexOf('手工记录') < second.indexOf('rollback'), '顺序即时间顺序')
  } finally { rm(root) }
})

test('pruneHistory：目录不存在 ⇒ 空数组（no-op，不抛）', () => {
  const root = mkRoot()
  try {
    assert.deepEqual(pruneHistory(root, 'ghost'), [])
  } finally { rm(root) }
})
