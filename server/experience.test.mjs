import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// 通过注入 HOME 重定向 personal 目录：模块导出 PERSONAL_DIR 基于 process.env.PONOS_TEST_HOME
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ponos-exp-home-'))
process.env.PONOS_TEST_HOME = testHome
const mod = await import('./experience.mjs')

beforeEach(() => { mod.ensurePersonalDir() })
afterEach(() => { fs.rmSync(testHome, { recursive: true, force: true }) })

test('ensurePersonalDir 预置 7 个主题文件', () => {
  for (const t of mod.DEFAULT_THEMES) {
    assert.ok(fs.existsSync(path.join(testHome, '.ponos', 'memory', 'personal', `${t}.md`)), `${t}.md 缺失`)
  }
})

test('hashLine 稳定且区分内容', () => {
  assert.equal(mod.hashLine('abc'), mod.hashLine('abc'))
  assert.notEqual(mod.hashLine('abc'), mod.hashLine('abd'))
})

test('listExperiences 返回条目与 frontmatter 状态', () => {
  const file = path.join(testHome, '.ponos', 'memory', 'personal', 'communication.md')
  fs.writeFileSync(file, '---\nname: communication\ndescription: 沟通偏好\nactive: true\n---\n- [会话A] 用户偏好简洁回复\n- [会话B] 报告用中文\n', 'utf-8')
  const list = mod.listExperiences()
  const comm = list.find(x => x.theme === 'communication')
  assert.ok(comm)
  assert.equal(comm.active, true)
  assert.equal(comm.entryCount, 2)
})

test('setThemeActive 更新 frontmatter', () => {
  mod.setThemeActive('communication', false)
  const list = mod.listExperiences()
  assert.equal(list.find(x => x.theme === 'communication').active, false)
})

test('deleteThemeEntry 按行 hash 删除', () => {
  const file = path.join(testHome, '.ponos', 'memory', 'personal', 'communication.md')
  fs.writeFileSync(file, '---\nname: communication\nactive: true\n---\n- [A] 第一条\n- [B] 第二条\n', 'utf-8')
  const list = mod.listExperiences()
  const comm = list.find(x => x.theme === 'communication')
  const target = comm.entries.find(e => e.text.includes('第一条'))
  const res = mod.deleteThemeEntry('communication', target.hash)
  assert.equal(res.ok, true)
  assert.equal(res.deleted, 1)
  assert.equal(mod.listExperiences().find(x => x.theme === 'communication').entryCount, 1)
})

test('buildExperienceSection 按 updatedAt 降序且受 maxBytes 截断', () => {
  const base = testHome + '/.ponos/memory/personal/'
  fs.writeFileSync(base + 'a.md', '---\nname: a\nactive: true\n---\n- [A] ' + 'x'.repeat(100) + '\n', 'utf-8')
  fs.writeFileSync(base + 'b.md', '---\nname: b\nactive: true\n---\n- [B] ' + 'y'.repeat(100) + '\n', 'utf-8')
  const now = Date.now()
  fs.utimesSync(base + 'a.md', new Date(now - 10000), new Date(now - 10000))
  fs.utimesSync(base + 'b.md', new Date(now - 5000), new Date(now - 5000))
  const sec = mod.buildExperienceSection(200)
  assert.ok(sec.includes('y'.repeat(100)), '应优先含最近更新的 b')
  assert.ok(sec.length <= 400, '截断后不会远超上限')
})

test('buildExperienceSection 空库返回空串', () => {
  assert.equal(mod.buildExperienceSection(), '')
})

test('buildExperienceSection 单主题配额：一个主题不能挤占全部段落', () => {
  const base = testHome + '/.ponos/memory/personal/'
  // 主题 a 有 5 条短条目（总 ~80B），主题 b 有 1 条
  fs.writeFileSync(base + 'a.md', '---\nname: a\nactive: true\n---\n' + '- [A] 第一条经验内容\n- [A] 第二条经验内容\n- [A] 第三条经验内容\n- [A] 第四条经验内容\n- [A] 第五条经验内容\n', 'utf-8')
  fs.writeFileSync(base + 'b.md', '---\nname: b\nactive: true\n---\n- [B] 唯一长条目\n', 'utf-8')
  const sec = mod.buildExperienceSection(4096)
  assert.ok(sec.includes('[b]'), '配额不应把后序主题全部挤掉')
  const quota = Math.floor(4096 / 3)
  // a 的贡献不得超过配额 + 单条溢出余量
  const aBlock = sec.slice(sec.indexOf('[a]'))
  const aEnd = aBlock.indexOf('\n- [b]') > 0 ? aBlock.indexOf('\n- [b]') : aBlock.length
  assert.ok(aEnd <= quota + 60, `主题 a 占用 ${aEnd}B 超出配额 ${quota}B`)
})

test('buildExperienceSection 全局去重：相同内容只注入一次', () => {
  const base = testHome + '/.ponos/memory/personal/'
  const dup = '- [会话] 完全相同的经验内容' + 'x'.repeat(40) + '\n'
  fs.writeFileSync(base + 'a.md', '---\nname: a\nactive: true\n---\n' + dup + dup, 'utf-8')
  fs.writeFileSync(base + 'b.md', '---\nname: b\nactive: true\n---\n' + dup, 'utf-8')
  const sec = mod.buildExperienceSection(4096)
  const count = (sec.match(/完全相同的经验内容/g) || []).length
  assert.equal(count, 1, '重复内容应只注入一次，实际注入 ' + count + ' 次')
})

test('refreshIndex 写出 _index.json', () => {
  mod.refreshIndex()
  const idx = JSON.parse(fs.readFileSync(path.join(testHome, '.ponos', 'memory', 'personal', '_index.json'), 'utf-8'))
  assert.ok(idx.themes.communication)
})

test('parseEntryLine：标签+摘要+全文 三段解析', () => {
  const p = mod.parseEntryLine('- [会话|PS材料] 摘要一句话 -- 全文完整要点')
  assert.equal(p.tag, 'PS材料')
  assert.equal(p.summary, '摘要一句话')
  assert.equal(p.full, '全文完整要点')
})

test('parseEntryLine：旧格式 - [会话] 内容 兼容（无标签，摘要=全文）', () => {
  const p = mod.parseEntryLine('- [会话] 和胜材料盖章链路完整流程')
  assert.equal(p.tag, null)
  assert.equal(p.summary, '和胜材料盖章链路完整流程')
  assert.equal(p.full, '和胜材料盖章链路完整流程')
})

test('listExperiences 条目携带 tag/summary/full', () => {
  const file = path.join(testHome, '.ponos', 'memory', 'personal', 'workflow.md')
  fs.writeFileSync(file, '---\nname: workflow\nactive: true\n---\n- [会话|成果转化材料] 摘要A -- 全文A\n- [会话] 旧条目\n', 'utf-8')
  const list = mod.listExperiences()
  const wf = list.find(x => x.theme === 'workflow')
  assert.equal(wf.entryCount, 2)
  const tagged = wf.entries.find(e => e.tag === '成果转化材料')
  assert.ok(tagged, '应解析出任务标签条目')
  assert.equal(tagged.summary, '摘要A')
  assert.equal(tagged.full, '全文A')
})

test('buildExperienceIndex：按 主题|标签 分组聚合 + 未标注条目单列', () => {
  const base = testHome + '/.ponos/memory/personal/'
  fs.writeFileSync(base + 'workflow.md', '---\nname: workflow\nactive: true\n---\n- [会话|PS材料] 摘要1 -- 全文1\n- [会话|PS材料] 摘要2 -- 全文2\n- [会话|成果转化材料] 摘要3 -- 全文3\n- [会话] 未标注旧条目\n', 'utf-8')
  const idx = mod.buildExperienceIndex()
  assert.ok(idx.includes('[workflow|PS材料] 2 条'), '标签分组应聚合计数，实际：' + idx)
  assert.ok(idx.includes('[workflow|成果转化材料] 1 条'))
  assert.ok(idx.includes('[workflow] 1 条未标注经验'))
  // 索引只含目录行，不含全文内容
  assert.ok(!idx.includes('全文1'), '索引不应携带全文')
  // 读取指引存在
  assert.ok(idx.includes('用 Read'), '索引应含按需读取指引')
})

test('buildExperienceIndex：按最近更新排序，超限时丢旧索引行不截断条目', () => {
  const base = testHome + '/.ponos/memory/personal/'
  fs.writeFileSync(base + 'a.md', '---\nname: a\nactive: true\n---\n- [会话|标签A] 摘要 -- 全文' + 'y'.repeat(50) + '\n', 'utf-8')
  fs.writeFileSync(base + 'b.md', '---\nname: b\nactive: true\n---\n- [会话|标签B] 摘要 -- 全文' + 'z'.repeat(50) + '\n', 'utf-8')
  const now = Date.now()
  fs.utimesSync(base + 'a.md', new Date(now - 10000), new Date(now - 10000))
  fs.utimesSync(base + 'b.md', new Date(now - 5000), new Date(now - 5000))
  // 默认预算：b（最近）索引行排在 a 之前
  const idx = mod.buildExperienceIndex()
  assert.ok(idx.indexOf('[b|标签B]') < idx.indexOf('[a|标签A]'), '最近更新的 b 应排在前面')
  // 收紧预算到只能容纳 header + 约一条索引行：保留 b、丢弃 a（丢的是索引行，条目本身不截断）
  const headerLen = idx.indexOf('- [') // header 实际长度
  const tight = mod.buildExperienceIndex(headerLen + 200)
  assert.ok(tight.includes('[b|标签B]'), '超限应保留最近更新的 b')
  assert.ok(!tight.includes('[a|标签A]'), '超限应丢弃更旧的 a 索引行')
})

test('buildSedimentPrompt 包含 标签+摘要+全文 写入格式说明', () => {
  const p = mod.buildSedimentPrompt()
  assert.ok(p.includes('[会话|任务标签] 摘要 -- 全文'), '提示应说明新条目格式')
  assert.ok(p.includes('任务标签 ='), '提示应说明任务标签含义')
  assert.ok(p.includes('全文'), '提示应要求写全文')
})
