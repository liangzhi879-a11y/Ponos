// kernel-tests/atlas-test-helpers.mjs —— Atlas 测试共用的 fixture 构建器
// 不命名为 *.test.mjs：它不是测试入口，只是被各测试 import 的小工具。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAtlas } from '../kernel/atlas/store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function fixtureRoot(name) {
  return path.join(HERE, 'fixtures', 'atlas', name)
}

export function tempDir(prefix = 'ponos-atlas-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 只构建、不写盘：用于抽取/图/查询/渲染测试。 */
export function buildFixture(name, opts = {}) {
  const dir = opts.dir || path.join(os.tmpdir(), 'ponos-atlas-tests', `${name}-${process.pid}-${Math.random().toString(16).slice(2)}`)
  // 默认关闭外部正文抽取：fixture 里的 docx/pdf 是占位文件，测试不应依赖
  // 开发机是否装了 pdftotext / 自带 Python；需要正文的用例显式传 docText。
  return buildAtlas({ root: fixtureRoot(name), dir, write: false, docText: { enabled: false }, ...opts })
}

export function cardByPath(atlas, rel) {
  return (atlas.nodes || []).find((n) => n.path === rel) || null
}

export function edgeOf(atlas, type, fromPath, toPath) {
  const byId = new Map((atlas.nodes || []).map((n) => [n.id, n]))
  return (atlas.edges || []).find((e) => {
    if (e.type !== type) return false
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    return from?.path === fromPath && to?.path === toPath
  }) || null
}
