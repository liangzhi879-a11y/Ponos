// 内置工作流安装（Task 8）：按 version 比对 → 旧版本副本被覆盖升级。
// 注意：必须从 workflow-install.mjs 导入，不能 import bridge.mjs
//   （bridge.mjs 顶层会 listen(51517)，测试里会真的起桥并与用户运行中的应用抢端口，
//    其 EADDRINUSE 自愈逻辑还会 taskkill 用户进程）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBuiltinWorkflows } from './workflow-install.mjs'

test('内置工作流安装：版本不同即覆盖（旧格式残留被升级）', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 2.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    mkdirSync(join(dst, 'demo'), { recursive: true })
    writeFileSync(join(dst, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start, next: null}]\n', 'utf-8')
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r.updated, ['demo'])
    assert.match(readFileSync(join(dst, 'demo', 'workflow.yml'), 'utf-8'), /version: 2\.0\.0/)
    // 覆盖前留下旧版本备份（回滚/排查用）
    assert.ok(existsSync(join(dst, 'demo', 'workflow.v1.0.0.bak.yml')), '旧版本应被备份')
    assert.match(readFileSync(join(dst, 'demo', 'workflow.v1.0.0.bak.yml'), 'utf-8'), /version: 1\.0\.0/)
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})

test('内置工作流安装：不存在即安装 / 版本相同即跳过', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src2-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst2-'))
  try {
    mkdirSync(join(src, 'a'), { recursive: true })
    writeFileSync(join(src, 'a', 'workflow.yml'), 'name: a\nversion: 1.0.0\nnodes: []\nedges: []\n', 'utf-8')
    mkdirSync(join(src, 'b'), { recursive: true })
    writeFileSync(join(src, 'b', 'workflow.yml'), 'name: b\nversion: 1.0.0\nnodes: []\nedges: []\n', 'utf-8')
    mkdirSync(join(dst, 'b'), { recursive: true })
    writeFileSync(join(dst, 'b', 'workflow.yml'), 'name: b\nversion: 1.0.0\nnodes: []\nedges: []\n', 'utf-8')
    mkdirSync(join(src, 'empty-dir'), { recursive: true }) // 无 workflow.yml → 不算工作流
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r.installed, ['a'])
    assert.deepEqual(r.updated, [])
    assert.deepEqual(r.skipped, ['b'])
    assert.match(readFileSync(join(dst, 'a', 'workflow.yml'), 'utf-8'), /version: 1\.0\.0/)
    // 源目录缺失 → 空结果，不抛
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: join(src, 'nope'), dstRoot: dst }), { installed: [], updated: [], skipped: [] })
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})
