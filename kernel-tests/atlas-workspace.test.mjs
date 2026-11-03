// kernel-tests/atlas-workspace.test.mjs —— workspace 解析、通用层/域、walk 模式 .gitignore
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildAtlas } from '../kernel/atlas/store.mjs'
import { renderL1 } from '../kernel/atlas/render.mjs'
import { cardByPath, edgeOf, tempDir } from './atlas-test-helpers.mjs'

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function writeJson(root, rel, value) {
  write(root, rel, JSON.stringify(value, null, 2))
}

test('workspace：裸包名/子路径解析到 src，跨包 import 成边', (t) => {
  const root = tempDir('atlas-workspace-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writeJson(root, 'package.json', {
    name: 'demo-monorepo',
    private: true,
    workspaces: ['packages/*', 'examples/*'],
  })
  writeJson(root, 'packages/a/package.json', {
    name: '@demo/a',
    exports: { '.': './dist/index.js', './util': './dist/util.js' },
  })
  write(root, 'packages/a/src/index.ts', '// A 包入口\nexport const a = 1\n')
  write(root, 'packages/a/src/util.ts', '// A 工具\nexport const util = 1\n')
  writeJson(root, 'packages/b/package.json', {
    name: '@demo/b',
    exports: { '.': './dist/index.js' },
  })
  write(root, 'packages/b/src/index.ts', [
    '// B 包入口',
    "import { a } from '@demo/a'",
    "import { util } from '@demo/a/util'",
    "import fs from 'node:fs'",
    'export const b = a + util + Boolean(fs)',
    '',
  ].join('\n'))
  writeJson(root, 'examples/demo/package.json', {
    name: 'demo-extension',
    exports: { '.': './dist/index.js' },
  })
  write(root, 'examples/demo/src/index.ts', "// 示例\nimport { b } from '@demo/b'\nexport const demo = b\n")

  const atlas = buildAtlas({ root, dir: path.join(root, '.atlas'), write: false, docText: { enabled: false } })

  assert.equal(atlas.summary.workspace.packages, 3)
  assert.equal(atlas.summary.workspace.resolvedImports, 3)
  assert.equal(atlas.summary.unresolved.external, 1) // node:fs

  assert.ok(edgeOf(atlas, 'imports', 'packages/b/src/index.ts', 'packages/a/src/index.ts'))
  assert.ok(edgeOf(atlas, 'imports', 'packages/b/src/index.ts', 'packages/a/src/util.ts'))
  assert.ok(edgeOf(atlas, 'imports', 'examples/demo/src/index.ts', 'packages/b/src/index.ts'))

  const b = cardByPath(atlas, 'packages/b/src/index.ts')
  assert.equal(b.domain, 'packages/b')
  assert.equal(b.package, '@demo/b')
  assert.equal(b.layer, 'packages')

  const domainA = atlas.nodes.find((n) => n.id === 'domain:packages/a')
  const domainB = atlas.nodes.find((n) => n.id === 'domain:packages/b')
  assert.equal(domainA.name, '@demo/a')
  assert.equal(domainB.name, '@demo/b')

  const l1 = renderL1(atlas)
  assert.match(l1, /层：.*packages/)
  assert.match(l1, /packages\/a @demo\/a/)
  assert.match(l1, /packages\/b @demo\/b/)
})

test('无 workspaces 声明：探测 packages/apps，层按通用顶层目录投影', (t) => {
  const root = tempDir('atlas-workspace-fallback-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  writeJson(root, 'package.json', { name: 'generic-app' })
  writeJson(root, 'packages/foo/package.json', { name: 'foo', exports: './dist/index.js' })
  write(root, 'packages/foo/src/index.js', '// foo 入口\nexport const foo = 1\n')
  writeJson(root, 'apps/bar/package.json', { name: 'bar' })
  write(root, 'apps/bar/src/main.js', "// bar 入口\nimport { foo } from 'foo'\nexport const bar = foo\n")
  write(root, 'src/boot.js', '// 启动\nexport const boot = 1\n')
  write(root, 'scripts/tool.mjs', '// 工具\nexport const tool = 1\n')
  write(root, 'docs/readme.md', '# 文档\n')

  const atlas = buildAtlas({ root, dir: path.join(root, '.atlas'), write: false, docText: { enabled: false } })
  assert.equal(atlas.summary.workspace.packages, 2)
  assert.equal(atlas.summary.workspace.resolvedImports, 1)
  assert.ok(edgeOf(atlas, 'imports', 'apps/bar/src/main.js', 'packages/foo/src/index.js'))

  const layers = new Set(atlas.layers.map((l) => l.id))
  for (const id of ['packages', 'apps', 'src', 'tooling', 'docs', 'root']) assert.ok(layers.has(id), id)
  assert.equal(cardByPath(atlas, 'packages/foo/src/index.js').domain, 'packages/foo')
  assert.equal(cardByPath(atlas, 'apps/bar/src/main.js').domain, 'apps/bar')
  assert.match(renderL1(atlas), /层：.*packages/)
})

test('walk 模式读取 .gitignore：锚定/目录/反选/嵌套规则都生效', (t) => {
  const root = tempDir('atlas-walk-ignore-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  write(root, '.gitignore', [
    '# 忽略构建产物与生成文件',
    'dist/',
    '*.generated.mjs',
    '!keep.generated.mjs',
    '/root-only.txt',
    '',
  ].join('\n'))
  write(root, 'root-only.txt', 'root only')
  write(root, 'sub/root-only.txt', 'sub root-only')
  write(root, 'sub/keep.generated.mjs', 'export const keep = 1\n')
  write(root, 'sub/drop.generated.mjs', 'export const drop = 1\n')
  write(root, 'packages/app/.gitignore', '*.tmp\nnested/ignored/\n')
  write(root, 'packages/app/src/index.ts', '// app\nexport const app = 1\n')
  write(root, 'packages/app/src/debug.tmp', 'tmp')
  write(root, 'packages/app/nested/keep.ts', 'export const keep = 1\n')
  write(root, 'packages/app/nested/ignored/a.ts', 'export const a = 1\n')
  write(root, 'packages/app/dist/bundle.js', 'export const bundle = 1\n')
  write(root, 'packages/app/keep.generated.mjs', 'export const keep = 1\n')
  write(root, 'packages/app/drop.generated.mjs', 'export const drop = 1\n')
  write(root, '.pi/state.json', '{"secret":true}\n')

  const atlas = buildAtlas({
    root,
    dir: path.join(root, '.ponos', 'atlas'),
    write: false,
    docText: { enabled: false },
  })
  assert.equal(atlas.meta.scanMode, 'walk')

  for (const rel of [
    'sub/root-only.txt',
    'sub/keep.generated.mjs',
    'packages/app/src/index.ts',
    'packages/app/nested/keep.ts',
    'packages/app/keep.generated.mjs',
  ]) assert.ok(cardByPath(atlas, rel), `应保留 ${rel}`)

  for (const rel of [
    'root-only.txt',
    'sub/drop.generated.mjs',
    'packages/app/src/debug.tmp',
    'packages/app/nested/ignored/a.ts',
    'packages/app/dist/bundle.js',
    'packages/app/drop.generated.mjs',
    '.pi/state.json',
  ]) assert.equal(cardByPath(atlas, rel), null, `应忽略 ${rel}`)

  const ignore = (atlas.meta.excluded || []).find((e) => e.rule === 'gitignore')
  assert.ok(ignore, 'meta.excluded 必须留下 gitignore 计数')
  assert.ok(ignore.count >= 5)
  assert.ok((atlas.layers || []).some((l) => l.id === 'packages'))
})
