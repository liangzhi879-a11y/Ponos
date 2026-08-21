import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { discoverAgentsMd, buildBaseSystemPrompt, composeSystemPrompt } from '../kernel/prompt.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'yfw-prompt-'))
}

test('buildBaseSystemPrompt：含 YFWorking 身份 + 工具纪律与回复规范', () => {
  const p = buildBaseSystemPrompt({ toolNames: ['Bash', 'Read'] })
  assert.match(p, /YFWorking/, '基础提示词应含 YFWorking 身份')
  assert.match(p, /工具纪律/)
  assert.match(p, /探索纪律/)
  assert.match(p, /回复规范/)
  assert.match(p, /Bash/)
  assert.match(p, /可用工具：Bash, Read/)
})

test('buildBaseSystemPrompt（A1/A2/A3）：并行纪律 + no-bash 探索边界 + todo-first', () => {
  const p = buildBaseSystemPrompt({ toolNames: ['Bash', 'Read', 'Glob', 'Grep'] })
  // A1 并行纪律：只读工具可并行（带具体示例）、写/执行类串行
  assert.match(p, /并行调用/)
  assert.match(p, /同时 Read a\.mjs \+ Read b\.mjs \+ Grep 一个符号/)
  assert.match(p, /Bash\/Edit\/Write\/Agent\/Task 等写与执行类工具必须串行/)
  // A2 todo-first：复杂任务先用 TodoWrite 建立清单
  assert.match(p, /TodoWrite 建立任务清单/)
  // A3 no-bash 探索边界：禁止一切读文件变体（含 python open/heredoc）
  assert.match(p, /禁止用 Bash 读\/搜文件内容/)
  assert.match(p, /cat\/sed\/od\/head\/tail\/less 与 python/)
  assert.match(p, /Bash 仅用于系统命令\/测试\/构建\/git/)
})

test('buildBaseSystemPrompt：cwd 注入当前工作目录（对照 claude Primary working directory）', () => {
  const withCwd = buildBaseSystemPrompt({ toolNames: ['Read'], cwd: '/x/proj' })
  assert.match(withCwd, /当前工作目录：\/x\/proj/)
  assert.match(withCwd, /相对路径均相对于此目录解析/)
  // 无 cwd 时不含该行（CLI 无 addDirs 场景不注入空目录）
  const noCwd = buildBaseSystemPrompt({ toolNames: ['Read'] })
  assert.ok(!noCwd.includes('当前工作目录：'))
})

test('composeSystemPrompt：cwd 透传至基础层', () => {
  const composed = composeSystemPrompt({ toolNames: ['Bash'], agents: [], append: '', cwd: '/x/proj' })
  assert.match(composed, /当前工作目录：\/x\/proj/)
})

test('discoverAgentsMd：cwd 向上至 git root 发现 AGENTS.md，含 addDirs 根目录', () => {
  const dir = tmpDir()
  try {
    // git root + 子目录各放一个 AGENTS.md
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), '# 项目根指令\n', 'utf-8')
    writeFileSync(join(dir, 'sub', 'AGENTS.md'), '# 子目录指令\n', 'utf-8')
    // 从最深目录发现：近者优先，两个都命中
    let found = discoverAgentsMd({ cwd: join(dir, 'sub', 'deeper'), addDirs: [] })
    assert.equal(found.length, 2)
    assert.ok(found[0].path.endsWith('sub' + sep + 'AGENTS.md'))
    assert.ok(found[1].path.endsWith(sep + 'AGENTS.md'))
    assert.equal(found[0].content.trim(), '# 子目录指令')
    // addDirs 根目录的 AGENTS.md 也发现
    const addDir = tmpDir()
    writeFileSync(join(addDir, 'AGENTS.md'), '# 附加指令\n', 'utf-8')
    found = discoverAgentsMd({ cwd: dir, addDirs: [addDir] })
    assert.ok(found.some((f) => f.path === join(addDir, 'AGENTS.md')))
    rmSync(addDir, { recursive: true, force: true })
    // 去重：同一路径不重复
    found = discoverAgentsMd({ cwd: dir, addDirs: [dir] })
    const paths = found.map((f) => f.path)
    assert.equal(new Set(paths).size, paths.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('composeSystemPrompt（P8 业务适配）：技能块父子结构 + 触发词 + Skill 调用纪律', () => {
  const skills = [
    { id: 'suite', name: 'suite', description: '父技能描述', triggers: ['高企认定', '知识产权', '研发立项'], parent: '', subskills: [] },
    { id: 'sub1', name: 'sub1', description: '子一', triggers: [], parent: 'suite', subskills: [] },
    { id: 'standalone', name: 'standalone', description: '独立技能', triggers: [], parent: '', subskills: [] },
  ]
  const composed = composeSystemPrompt({ toolNames: ['Bash'], agents: [], append: '', cwd: '', skills })
  assert.match(composed, /用 Skill 工具调用对应技能/)
  assert.match(composed, /不得自行模拟或改用其它方式/)
  // 父技能条目：触发词 + 内联子技能；子技能不单独成条
  assert.match(composed, /- suite：高企认定、知识产权、研发立项（子：sub1）/)
  assert.ok(!composed.includes('- sub1：'), '子技能不独立成条')
  // 无触发词技能回退描述
  assert.match(composed, /- standalone：独立技能/)
  // 无技能时不注入技能块
  const none = composeSystemPrompt({ toolNames: ['Bash'], agents: [], append: '', cwd: '', skills: [] })
  assert.ok(!none.includes('【可用技能】'))
})

test('composeSystemPrompt：base → AGENTS.md（带来源）→ append（最后最高优先级）', () => {
  const composed = composeSystemPrompt({
    toolNames: ['Bash'],
    agents: [{ path: '/x/AGENTS.md', content: '# 项目指令\n- 规则A' }],
    append: '# GUI 提示词\n身份声明与格式规范',
  })
  const baseIdx = composed.indexOf('工具纪律')
  const agentsIdx = composed.indexOf('# 项目指令（/x/AGENTS.md）')
  const appendIdx = composed.indexOf('# GUI 提示词')
  assert.ok(baseIdx >= 0 && agentsIdx > baseIdx && appendIdx > agentsIdx, '顺序：base < AGENTS.md < append')
  assert.match(composed, /- 规则A/)
  assert.match(composed, /身份声明与格式规范/)
  // 无 append 时也正常
  const noAppend = composeSystemPrompt({ toolNames: ['Bash'], agents: [], append: '' })
  assert.match(noAppend, /工具纪律/)
})
