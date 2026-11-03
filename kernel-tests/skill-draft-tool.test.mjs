// kernel-tests/skill-draft-tool.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry, CHAT_MODE_DISALLOWED, MUTATING_FILE_TOOLS } from '../kernel/tools.mjs'
import { classifyTool } from '../kernel/approval-mode.mjs'

const cfg = () => mkdtempSync(join(tmpdir(), 'yfw-sdt-'))
const DOC = '---\nname: "demo-skill"\ndescription: "做一件事"\n---\n\n# 角色定位\n\n做事。\n'
// createToolRegistry **没有** configDir 参数（复核 A1）：handler 内按内核惯例
// resolve(memoryRoot, '..', '..') 反推 configDir ⇒ 测试必须传 memoryRoot。
const reg = (configDir) => createToolRegistry({
  cwd: configDir, addDirs: [configDir], skipPermissions: true,
  memoryRoot: join(configDir, 'memory', 'personal'),
})
// 执行入口形态照 Step 1 实读（与 disabled-registry / knowledge-* 等既有测试同款）：
// run({ name, input }, ctx) → { content, isError }
const call = async (c, input) => {
  const r = await reg(c).run({ name: 'SkillDraft', input }, {})
  return { text: String(r?.content ?? ''), isError: !!r?.isError }
}

test('SkillDraft 在工具池里，且与 Write/Edit 同档（登记进 WRITE_TOOLS，不得落入 unknown）', () => {
  assert.ok(reg(cfg()).toolNames.includes('SkillDraft'), '工具池里应有 SkillDraft')
  // ★ 核心断言（复核补）：登记面②的正确性钉。本仓 'write' 与 'unknown' 的允许档虽同为 'loose'，
  //   但只有 'write' 才是"与 Write/Edit 同档"的声明；漏登记会让工具在审批档语义上漂移、
  //   且今后若收紧 write 档（如引入 appTool 那样的保守类）会出现静默放行口子。
  assert.equal(classifyTool('SkillDraft'), 'write', '必须登记进 kernel/approval-mode.mjs 的 WRITE_TOOLS')
})

test('注册面③④：纯 chat 禁用清单 + lane 产物清单都含 SkillDraft（写盘能力不得在 chat 会话里可用）', () => {
  assert.ok(CHAT_MODE_DISALLOWED.includes('SkillDraft'), 'CHAT_MODE_DISALLOWED 必须含 SkillDraft（与桥侧同源拷贝逐字一致）')
  assert.ok(MUTATING_FILE_TOOLS.has('SkillDraft'), 'MUTATING_FILE_TOOLS 必须含 SkillDraft（lane 产物清单）')
})

test('action=create 落草稿到 .drafts/<id>/SKILL.md', async () => {
  const c = cfg()
  const r = await call(c, { action: 'create', id: 'demo-skill', intent: '做事', content: DOC })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /草稿已保存/)
  assert.ok(existsSync(join(c, 'skills', '.drafts', 'demo-skill', 'SKILL.md')))
})

test('校验不过时返回逐条错误，且**不落盘**', async () => {
  const c = cfg()
  const r = await call(c, { action: 'create', id: 'Bad_Id', intent: 'x', content: DOC })
  assert.equal(r.isError, true)
  assert.match(r.text, /ID_FORMAT/)
  assert.equal(existsSync(join(c, 'skills', '.drafts', 'Bad_Id')), false)
})

test('id 缺省时从 content 的 frontmatter name 推导（create 便利路径）', async () => {
  const c = cfg()
  const r = await call(c, { action: 'create', intent: '做事', content: DOC })
  assert.equal(r.isError, false, r.text)
  assert.ok(existsSync(join(c, 'skills', '.drafts', 'demo-skill', 'SKILL.md')), r.text)
})

test('缺 memoryRoot → 明确报不可用（不假装成功）', async () => {
  const r = await createToolRegistry({ cwd: cfg() }).run({ name: 'SkillDraft', input: { action: 'create', id: 'x-skill', content: DOC } }, {})
  assert.equal(r.isError, true)
  assert.match(String(r.content), /不可用|memoryRoot/)
})

test('action=import 越界路径被拒（不在授权目录内）', async () => {
  const c = cfg()
  const r = await call(c, { action: 'import', id: 'ext-skill', sourcePath: join(c, '..', 'outside-' + Date.now()) })
  assert.equal(r.isError, true)
  assert.match(r.text, /拒绝|越界|不允许|不在/)
})

test('action=import 对授权目录内的外部技能产出侦察报告，且**源目录不被改写**', async () => {
  const c = cfg()
  const src = join(c, 'ext', 'claude-style')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'CLAUDE.md'), '# 报表工具\n\n生成报表。\n', 'utf-8')
  const before = readFileSync(join(src, 'CLAUDE.md'), 'utf-8')
  const r = await call(c, { action: 'import', id: 'report-tool', sourcePath: src })
  assert.equal(r.isError, false, r.text)
  assert.match(r.text, /侦察完成/, r.text)
  assert.equal(readFileSync(join(src, 'CLAUDE.md'), 'utf-8'), before, '源目录必须原样')
  assert.equal(existsSync(join(src, 'SKILL.md')), false, '源目录不得被写入 SKILL.md')
})
