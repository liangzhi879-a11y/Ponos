import { test, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-home-'))
process.env.PONOS_TEST_HOME = testHome
const exp = await import('./experience.mjs')
exp.ensurePersonalDir()
const pkg = await import('./packager.mjs')

// 造一个可导出的迷你经验库 + config
const personal = path.join(testHome, '.ponos', 'memory', 'personal')
fs.writeFileSync(path.join(personal, 'finance.md'),
  '---\nname: finance\nactive: true\n---\n- [会话] 研发费用口径 6 项\n- [会话] 密码在 sk-abc 开头\n', 'utf-8')
fs.writeFileSync(path.join(testHome, '.ponos', 'config.json'),
  JSON.stringify({ activeProvider: 'p', providers: [{ id: 'p', authToken: 'sk-secret' }] }), 'utf-8')

let zipPath = ''

beforeEach(() => {
  zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-out-')), 'exp.zip')
})

afterEach(() => {
  fs.rmSync(path.dirname(zipPath), { recursive: true, force: true })
})

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true })
})

test('导出 zip 含 manifest 与 personal 文件', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['personal'], configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'manifest.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.deepEqual(manifest.included, ['personal'])
  assert.ok(fs.existsSync(path.join(staging, 'personal', 'finance.md')))
  fs.rmSync(staging, { recursive: true, force: true })
})

test('敏感词过滤跳过命中条目', async () => {
  const res = await pkg.exportPackage({
    outPath: zipPath, included: ['personal'], sensitiveWords: ['密码'], configRedact: true,
  })
  assert.equal(res.ok, true)
  assert.ok(res.skipped.length > 0)
})

test('config 类型导出时 authToken 脱敏', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['config'], configRedact: true })
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  const cfg = JSON.parse(fs.readFileSync(path.join(staging, 'config', 'config.json'), 'utf-8'))
  assert.notEqual(cfg.providers[0].authToken, 'sk-secret')
  assert.equal(cfg.providers[0].authToken, '')
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.equal(manifest.redacted, true) // 脱敏包须带 redacted 标记
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsJson 写入 chats 目录（新格式：sets.json + sessions/，无旧单文件）', async () => {
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson: '{"conversations":[]}', configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  const sets = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sets.json'), 'utf-8'))
  assert.deepEqual(sets, { sets: [] })
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions')))
  assert.ok(!fs.existsSync(path.join(staging, 'chats', 'chat-store.json')))
  fs.rmSync(staging, { recursive: true, force: true })
})

function makeZipWith(entries, outPath) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-make-'))
  for (const [rel, content] of Object.entries(entries)) {
    const fp = path.join(staging, rel)
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, content, 'utf-8')
  }
  spawnSync(pkg.TAR_CMD, ['-a', '-c', '-f', outPath, '-C', staging, '.'])
  fs.rmSync(staging, { recursive: true, force: true })
}

test('导入拒绝缺失 manifest 的 zip', async () => {
  const badZip = path.join(path.dirname(zipPath), 'bad.zip')
  makeZipWith({ 'random.txt': 'x' }, badZip)
  const res = await pkg.importPackage(badZip, { conflict: 'skip' })
  assert.equal(res.ok, false)
})

test('导入个人经验 merge 模式按行去重', async () => {
  // 目标库已有一条
  fs.writeFileSync(path.join(personal, 'finance.md'),
    '---\nname: finance\nactive: true\n---\n- [旧] 已有条目\n', 'utf-8')
  // 打包：含一条重复 + 一条新增
  const zip = path.join(path.dirname(zipPath), 'merge.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['personal'] }),
    'personal/finance.md': '---\nname: finance\nactive: true\n---\n- [旧] 已有条目\n- [新] 新增条目\n',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'merge' })
  assert.equal(res.ok, true)
  const after = fs.readFileSync(path.join(personal, 'finance.md'), 'utf-8')
  assert.ok(after.includes('新增条目'))
  assert.equal((after.match(/已有条目/g) || []).length, 1)
})

test('导入 overwrite 模式覆盖已有文件', async () => {
  const zip = path.join(path.dirname(zipPath), 'ow.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['personal'] }),
    'personal/finance.md': '---\nname: finance\nactive: true\n---\n- [覆盖] 新内容\n',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'overwrite' })
  assert.equal(res.ok, true)
  assert.ok(fs.readFileSync(path.join(personal, 'finance.md'), 'utf-8').includes('新内容'))
})

test('导入 chats 返回 chatStoreJson 且不直接写盘', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'] }),
    'chats/chat-store.json': '{"conversations":[{"id":"c1"}]}',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  const parsed = JSON.parse(res.chatStoreJson)
  assert.equal(parsed.conversations[0].id, 'c1')
})

test('invalid conflict 值返回 ok:false', async () => {
  const zip = path.join(path.dirname(zipPath), 'badconflict.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['personal'] }),
    'personal/finance.md': 'x',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'merg' })
  assert.equal(res.ok, false)
  assert.match(res.error, /skip\/overwrite\/merge/)
})

test('project 已存在 + skip 不抛错且计 conflicts', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-proj-'))
  const ponosTarget = path.join(proj, '.ponos')
  fs.mkdirSync(ponosTarget, { recursive: true })
  fs.writeFileSync(path.join(ponosTarget, 'keep.md'), '原有内容', 'utf-8')
  try {
    const zip = path.join(path.dirname(zipPath), 'proj.zip')
    makeZipWith({
      'manifest.json': JSON.stringify({ format_version: 1, included: ['project'] }),
      'project/data.txt': 'x',
    }, zip)
    const res = await pkg.importPackage(zip, { conflict: 'skip', projectCwd: proj })
    assert.equal(res.ok, true)
    assert.ok(res.conflicts >= 1)
    assert.ok(fs.existsSync(path.join(ponosTarget, 'keep.md')))
    assert.ok(res.restored.includes('project/.ponos (exists, skipped)'))
  } finally {
    fs.rmSync(proj, { recursive: true, force: true })
  }
})

test('redacted 包 + overwrite 拒绝覆盖 config', async () => {
  const zip = path.join(path.dirname(zipPath), 'redacted.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['config'], redacted: true }),
    'config/config.json': JSON.stringify({ activeProvider: 'x', providers: [{ id: 'x', authToken: '' }] }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'overwrite' })
  assert.equal(res.ok, true)
  assert.ok(res.conflicts >= 1)
  const cfg = JSON.parse(fs.readFileSync(path.join(testHome, '.ponos', 'config.json'), 'utf-8'))
  assert.equal(cfg.providers[0].authToken, 'sk-secret') // 未被空凭据覆盖
  assert.equal(cfg.activeProvider, 'p')
})

test('merge 时目标 JSON 非法 → 单文件跳过不拖垮整体', async () => {
  const expDir = path.join(testHome, '.ponos', 'memory', 'skill_experiences')
  fs.mkdirSync(expDir, { recursive: true })
  fs.writeFileSync(path.join(expDir, 'broken.json'), 'not-valid-json{', 'utf-8')
  const zip = path.join(path.dirname(zipPath), 'mergejson.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['skill_exp'] }),
    'skill_exp/broken.json': JSON.stringify({ ok: 1 }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'merge' })
  assert.equal(res.ok, true)
  assert.ok(res.conflicts >= 1)
  assert.equal(fs.readFileSync(path.join(expDir, 'broken.json'), 'utf-8'), 'not-valid-json{')
})

test('skills 导入递归恢复子目录文件（merge 安装本地缺失）', async () => {
  const zip = path.join(path.dirname(zipPath), 'skills.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['skills'] }),
    'skills/my-skill/SKILL.md': '# my-skill\n用法说明\n',
    'skills/my-skill/experience.json': JSON.stringify({ note: 'x' }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'merge' })
  assert.equal(res.ok, true)
  assert.ok(res.restored.includes('skills/my-skill/SKILL.md'))
  assert.ok(res.restored.includes('skills/my-skill/experience.json'))
  assert.ok(fs.existsSync(path.join(testHome, '.ponos', 'skills', 'my-skill', 'SKILL.md')))
})

test('skills 导入 merge 跳过已存在文件、overwrite 覆盖', async () => {
  const skillDir = path.join(testHome, '.ponos', 'skills', 'my-skill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '原有内容', 'utf-8')
  const zip = path.join(path.dirname(zipPath), 'skills2.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['skills'] }),
    'skills/my-skill/SKILL.md': '新内容\n',
  }, zip)
  const mergeRes = await pkg.importPackage(zip, { conflict: 'merge' })
  assert.equal(mergeRes.ok, true)
  assert.ok(mergeRes.conflicts >= 1)
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), '原有内容')
  const owRes = await pkg.importPackage(zip, { conflict: 'overwrite' })
  assert.equal(owRes.ok, true)
  assert.ok(owRes.restored.includes('skills/my-skill/SKILL.md'))
  assert.ok(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8').includes('新内容'))
})

test('skill_exp 导出敏感词过滤经验条目', async () => {
  const expDir = path.join(testHome, '.ponos', 'memory', 'skill_experiences')
  fs.mkdirSync(expDir, { recursive: true })
  fs.writeFileSync(path.join(expDir, 'gxtz-test.json'), JSON.stringify({
    skill_name: 'gxtz-test',
    schema_version: 1,
    experiences: [
      { id: 1, content: '使用 sk-abc 访问 API，password 为 xxx' },
      { id: 2, content: '干净的经验记录' },
    ],
  }), 'utf-8')
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['skill_exp'], sensitiveWords: ['password'], configRedact: true })
  assert.equal(res.ok, true)
  assert.ok(res.skipped.some(s => s.type === 'skill_exp'))
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  const data = JSON.parse(fs.readFileSync(path.join(staging, 'skill_exp', 'gxtz-test.json'), 'utf-8'))
  assert.equal(data.experiences.length, 1)
  assert.ok(data.experiences[0].content.includes('干净'))
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chats 导出按会话拆分（sets.json + sessions/<id>.json，无旧单文件）', async () => {
  const chatsJson = JSON.stringify({
    conversationSets: [{ id: 'set1', name: '财务项目', createdAt: 1 }],
    conversations: [
      { id: 'c1', title: 'a', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' },
      { id: 'c2', title: 'b', messages: [], createdAt: 1, updatedAt: 3, model: 'x', setId: undefined },
    ],
  })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sets.json')))
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c1.json')))
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c2.json')))
  assert.ok(!fs.existsSync(path.join(staging, 'chats', 'chat-store.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.equal(manifest.chat_format, 2)
  const sets = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sets.json'), 'utf-8'))
  assert.equal(sets.sets.length, 1)
  const c1 = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sessions', 'c1.json'), 'utf-8'))
  assert.equal(c1.setId, 'set1')
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chats 导出解包 zustand persist 包装（{state,version}）——回归：真实运行包不静默跳过', async () => {
  // renderer 传的是 localStorage['ponos-chat'] 原值（zustand persist 序列化为
  // {state:{...},version:0}），而非裸 {conversations, conversationSets}；此前该形状
  // 命中 !Array.isArray(data.conversations) 静默跳过，导出的 zip 零会话且仍标 chat_format:2
  const chatsJson = JSON.stringify({
    state: {
      conversationSets: [{ id: 'set1', name: '财务项目', createdAt: 1 }],
      conversations: [{ id: 'c1', title: 'a', messages: [], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' }],
    },
    version: 0,
  })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, configRedact: true })
  assert.equal(res.ok, true)
  assert.ok(!res.skipped.some(s => s.type === 'chats'))
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c1.json')))
  const sets = JSON.parse(fs.readFileSync(path.join(staging, 'chats', 'sets.json'), 'utf-8'))
  assert.equal(sets.sets.length, 1)
  assert.equal(sets.sets[0].id, 'set1')
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'))
  assert.equal(manifest.chat_format, 2)
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsFilter: setId 与 conversationIds 只导出所选会话', async () => {
  const chatsJson = JSON.stringify({
    conversationSets: [{ id: 'set1', name: '财务项目', createdAt: 1 }],
    conversations: [
      { id: 'c1', title: 'a', messages: [], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' },
      { id: 'c2', title: 'b', messages: [], createdAt: 1, updatedAt: 3, model: 'x', setId: undefined },
    ],
  })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, chatsFilter: { setId: 'set1' }, configRedact: true })
  assert.equal(res.ok, true)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-pkg-un-'))
  spawnSync(pkg.TAR_CMD, ['-xf', zipPath, '-C', staging])
  assert.ok(fs.existsSync(path.join(staging, 'chats', 'sessions', 'c1.json')))
  assert.ok(!fs.existsSync(path.join(staging, 'chats', 'sessions', 'c2.json')))
  fs.rmSync(staging, { recursive: true, force: true })
})

test('chatsFilter.setId 不存在且无 conversationIds 时返回错误', async () => {
  const chatsJson = JSON.stringify({ conversationSets: [], conversations: [] })
  const res = await pkg.exportPackage({ outPath: zipPath, included: ['chats'], chatsJson, chatsFilter: { setId: 'nope' }, configRedact: true })
  assert.equal(res.ok, false)
})

test('导入新格式 chats：聚合 sets + conversations（不写盘）', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-new.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'], chat_format: 2 }),
    'chats/sets.json': JSON.stringify({ sets: [{ id: 'set1', name: '财务项目', createdAt: 1 }] }),
    'chats/sessions/c1.json': JSON.stringify({ id: 'c1', title: 'a', messages: [], createdAt: 1, updatedAt: 2, model: 'x', setId: 'set1' }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.chats)
  assert.equal(res.chats.sets.length, 1)
  assert.equal(res.chats.conversations.length, 1)
  assert.equal(res.chats.conversations[0].setId, 'set1')
  assert.equal(res.chatStoreJson, null)
})

test('导入新格式 chats：损坏会话文件 conflicts++ 且整体 ok', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-bad.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'], chat_format: 2 }),
    'chats/sets.json': JSON.stringify({ sets: [] }),
    'chats/sessions/good.json': JSON.stringify({ id: 'g', title: 'ok', messages: [], createdAt: 1, updatedAt: 2, model: 'x' }),
    'chats/sessions/bad.json': '{ not json !!!',
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.conflicts >= 1)
  assert.equal(res.chats.conversations.length, 1)
})

test('导入旧格式 chats：仍返回 chatStoreJson 整体写回', async () => {
  const zip = path.join(path.dirname(zipPath), 'chats-old.zip')
  makeZipWith({
    'manifest.json': JSON.stringify({ format_version: 1, included: ['chats'] }),
    'chats/chat-store.json': JSON.stringify({ conversations: [{ id: 'old1', title: 'x', messages: [], createdAt: 1, updatedAt: 2, model: 'x' }], activeConversationId: null, lastCwd: '' }),
  }, zip)
  const res = await pkg.importPackage(zip, { conflict: 'skip' })
  assert.equal(res.ok, true)
  assert.ok(res.chatStoreJson)
  assert.equal(res.chats, null)
  assert.ok(res.chatStoreJson.includes('old1'))
})
