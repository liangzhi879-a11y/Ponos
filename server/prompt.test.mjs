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
  assert.match(p, /回复规范/)
  assert.match(p, /Bash/)
  assert.match(p, /可用工具：Bash, Read/)
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
