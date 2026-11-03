// kernel-tests/skill-drafts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftsRoot, writeDraft, readDraft, listDrafts, removeDraft, DRAFT_DIR_NAME } from '../kernel/skill-drafts.mjs'

const cfg = () => mkdtempSync(join(tmpdir(), 'yfw-drafts-'))
const DOC = '---\nname: "demo-skill"\ndescription: "做一件事"\n---\n\n# 角色定位\n\n做事。\n'

test('draftsRoot 位于 <configDir>/skills/.drafts（点目录 ⇒ 技能发现扫不到）', () => {
  const c = cfg()
  assert.equal(draftsRoot({ configDir: c }), join(c, 'skills', DRAFT_DIR_NAME))
  assert.equal(DRAFT_DIR_NAME, '.drafts')
})

test('writeDraft 落盘成功，能被 readDraft 读回', () => {
  const c = cfg()
  const r = writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const back = readDraft({ configDir: c, id: 'demo-skill' })
  assert.equal(back.content, DOC)
})

test('writeDraft 校验不过时**不落盘**', () => {
  const c = cfg()
  const r = writeDraft({ configDir: c, id: 'Bad_Id', content: DOC, existingIds: [] })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.code === 'ID_FORMAT'))
  assert.equal(existsSync(join(draftsRoot({ configDir: c }), 'Bad_Id')), false)
})

test('.drafts 目录不会被当作技能（无 .drafts/SKILL.md 这个形态）', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  assert.equal(existsSync(join(c, 'skills', DRAFT_DIR_NAME, 'SKILL.md')), false)
  // .drafts 下的条目是目录，且其 SKILL.md 在第二层
  assert.equal(existsSync(join(draftsRoot({ configDir: c }), 'demo-skill', 'SKILL.md')), true)
})

test('listDrafts 列出草稿及其校验状态', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  const list = listDrafts({ configDir: c })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'demo-skill')
  assert.equal(list[0].validation.ok, true)
})

test('removeDraft 删除草稿目录', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  assert.equal(removeDraft({ configDir: c, id: 'demo-skill' }).ok, true)
  assert.equal(readDraft({ configDir: c, id: 'demo-skill' }), null)
})

test('路径穿越被拒：id 带 .. 或分隔符时拒绝', () => {
  const c = cfg()
  for (const bad of ['../evil', 'a/b', '..', 'a\\b']) {
    const r = writeDraft({ configDir: c, id: bad, content: DOC, existingIds: [] })
    assert.equal(r.ok, false, `应拒绝 ${bad}`)
  }
})

test('原子写：写入过程不留半截文件（.tmp 残留为 0）', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  const leftovers = readdirSync(join(draftsRoot({ configDir: c }), 'demo-skill')).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('meta 会随草稿落盘（供 GUI 显示来源：生成 / 导入）', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [], meta: { origin: 'import', sourcePath: '/x/y' } })
  const back = readDraft({ configDir: c, id: 'demo-skill' })
  assert.equal(back.meta.origin, 'import')
  assert.equal(back.meta.sourcePath, '/x/y')
})

test('readDraft 容忍手工损坏的 meta.json（不抛错，退化为空 meta）', () => {
  const c = cfg()
  writeDraft({ configDir: c, id: 'demo-skill', content: DOC, existingIds: [] })
  writeFileSync(join(draftsRoot({ configDir: c }), 'demo-skill', '_meta.json'), '{ 坏 JSON', 'utf-8')
  const back = readDraft({ configDir: c, id: 'demo-skill' })
  assert.equal(back.id, 'demo-skill')
  assert.deepEqual(back.meta, {})
})
