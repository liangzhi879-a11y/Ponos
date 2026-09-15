// SV1 技能版本守卫 fixtures：verifySkillVersions（skills.mjs）两形态 lock/缺文件/匹配/过期。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySkillVersions } from '../kernel/skills.mjs'

function lockDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-sv1-'))
  if (obj !== null) writeFileSync(join(dir, 'skills.lock.json'), JSON.stringify(obj))
  return dir
}
const SKILLS = [
  { id: 'a', version: '1.0.0' },
  { id: 'b', version: '2.0.0' },
  { id: 'c', version: '' }, // 磁盘技能无版本 → 不参与校验（want 存在但 disk 空不报）
]

test('缺 lock 文件 → 零激活', () => {
  const dir = lockDir(null)
  try { assert.deepEqual(verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS }), { outdated: [] }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('顶层形态 lock：匹配无 outdated / 过期报 id+lock+disk', () => {
  const dir = lockDir({ a: '1.0.0', b: '9.0.0' })
  try {
    const r = verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS })
    assert.equal(r.outdated.length, 1)
    assert.deepEqual(r.outdated[0], { id: 'b', lock: '9.0.0', disk: '2.0.0' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('嵌套形态 lock { skills: {...} } 同语义；顶层 skills 键被跳过', () => {
  const dir = lockDir({ skills: { a: '1.0.0', b: '9.0.0' }, unrelated: 'x' })
  try {
    const r = verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS })
    assert.equal(r.outdated.length, 1)
    assert.equal(r.outdated[0].id, 'b')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lock 损坏 JSON → 容错空结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-sv1-'))
  try { writeFileSync(join(dir, 'skills.lock.json'), '{oops') } catch {}
  try { assert.deepEqual(verifySkillVersions({ lockPath: join(dir, 'skills.lock.json'), skills: SKILLS }), { outdated: [] }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
