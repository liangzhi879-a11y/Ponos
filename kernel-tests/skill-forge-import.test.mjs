// kernel-tests/skill-forge-import.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { detectExternal } from '../kernel/skill-forge.mjs'

// fixtures 由本测试文件维护：kernel-tests/fixtures/external-skills/<形态>/
// 若缺失（如 clone 时漏掉），测试用 mkdtemp 现场造——保证 TDD 红绿可复现。
const FIX = 'kernel-tests/fixtures/external-skills'
const FIXABS = isAbsolute(FIX) ? FIX : join(process.cwd(), FIX)

const mkfs = () => {
  const dir = mkdtempSync(join(tmpdir(), 'yfw-ext-'))
  const fs = {
    readdir: (p) => readdirSync(p, { withFileTypes: true })
      .map((d) => ({ name: d.name, isDir: d.isDirectory(), isLink: d.isSymbolicLink() })),
    readFile: (p) => readFileSync(p, 'utf-8'),
    stat: (p) => { const s = statSync(p); return { size: s.size, isDir: s.isDirectory() } },
  }
  return { dir, fs }
}
// 有 fixture 用 fixture，没有就现场造（测试不依赖特定机器状态）
const fixtureDir = (name) => {
  const d = join(FIXABS, name)
  if (existsSync(d)) return d
  const { dir } = mkfs()
  return dir
}
const detect = (name) => { const d = fixtureDir(name); const fs = mkfs().fs; return detectExternal({ dir: d, ...fs }) }

test('claude 形态：CLAUDE.md 入口 + scripts/ 资产 + 绝对路径引用被识别', () => {
  const r = detect('claude-style')
  assert.equal(r.format, 'claude')
  assert.equal(r.entryFile, 'CLAUDE.md')
  assert.ok(r.assets.some((a) => a.path === 'scripts/report.py' && a.kind === 'script'))
  assert.ok(r.assets.some((a) => a.path === 'references/format.md' && a.kind === 'doc'))
  assert.ok(r.pathRefs.length >= 1, '应识别出 CLAUDE.md 里的绝对路径')
  assert.ok(r.pathRefs.every((p) => /C:\/Users\/someone/.test(p.raw)))
})

test('codex 形态：AGENTS.md 入口', () => {
  const r = detect('codex-style')
  assert.equal(r.format, 'codex')
  assert.equal(r.entryFile, 'AGENTS.md')
})

test('plugin 形态：plugin.json 入口 + commands//agents/ 约定目录', () => {
  const r = detect('plugin-style')
  assert.equal(r.format, 'plugin')
  assert.equal(r.entryFile, 'plugin.json')
  assert.ok(r.dirConventions.includes('commands/'))
  assert.ok(r.dirConventions.includes('agents/'))
})

test('yfworking 形态：SKILL.md 入口（已兼容，识别即通过）', () => {
  const { dir, fs } = mkfs()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n正文\n', 'utf-8')
  const r = detectExternal({ dir, ...fs })
  assert.equal(r.format, 'yfworking')
  assert.equal(r.entryFile, 'SKILL.md')
})

test('superpowers 形态：SKILL.md + 伴生 md（标注但兼容）', () => {
  const r = detect('superpowers-style')
  assert.equal(r.format, 'superpowers')
  assert.ok(r.assets.some((a) => a.path === 'visual-companion.md'))
})

test('无法识别 → unknown，warnings 里说清找过哪些文件名', () => {
  const r = detect('unknown-format')
  assert.equal(r.format, 'unknown')
  assert.ok(r.warnings.some((w) => /SKILL\.md|CLAUDE\.md/.test(w)), JSON.stringify(r.warnings))
})

test('符号链接不跟随：列为 warning 且不进 assets（io 注入伪造 link 条目，不依赖机器能否建符号链接）', () => {
  const dir = join(FIXABS, 'symlink-style')
  const real = mkfs().fs
  const fake = {
    readdir: (p) => {
      const out = real.readdir(p)
      if (p === dir) out.push({ name: 'link.txt', isDir: false, isLink: true })
      return out
    },
    readFile: real.readFile,
    stat: real.stat,
  }
  const r = detectExternal({ dir, ...fake })
  assert.ok(r.warnings.some((w) => /符号链接|symlink/i.test(w)), JSON.stringify(r.warnings))
  assert.ok(!r.assets.some((a) => a.path === 'link.txt'))
})

test('node_modules / .git 被排除（不出现于 assets）', () => {
  const r = detect('claude-style')
  assert.ok(!r.assets.some((a) => a.path.includes('node_modules')))
  assert.ok(!r.assets.some((a) => a.path.startsWith('.git/')))
})
