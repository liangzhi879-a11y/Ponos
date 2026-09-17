// 内置工作流安装（Task 8）：按 version 比对 → 旧版本副本被覆盖升级。
// 注意：必须从 workflow-install.mjs 导入，不能 import bridge.mjs
//   （bridge.mjs 顶层会 listen(51517)，测试里会真的起桥并与用户运行中的应用抢端口，
//    其 EADDRINUSE 自愈逻辑还会 taskkill 用户进程）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBuiltinWorkflows, markBuiltinDeleted, readDeletedBuiltins, clearDeletedBuiltins } from './workflow-install.mjs'

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
    assert.deepEqual(r.contentUpdated, [])
    assert.deepEqual(r.skipped, ['b'])
    assert.match(readFileSync(join(dst, 'a', 'workflow.yml'), 'utf-8'), /version: 1\.0\.0/)
    // 源目录缺失 → 空结果，不抛
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: join(src, 'nope'), dstRoot: dst }), { installed: [], updated: [], contentUpdated: [], skipped: [], skippedByUser: [], legacyRemoved: [] })
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})

// C-1：旧版 bridge 把内置工作流装进技能根，而内核技能根优先（cli.mjs workflowRoots）→
// 技能根里的 legacy 同名副本会永久遮蔽新装副本（内置 spec-dev 恒 LEGACY_DSL）。
test('内置工作流安装：技能根 legacy 同名副本被备份并删除（解除遮蔽）', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src3-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst3-'))
  const legacy = mkdtempSync(join(tmpdir(), 'wf-legacy3-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 2.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    // 技能根里的旧版副本（旧格式、版本 1.0.0）：会被优先发现 → 必须删除
    mkdirSync(join(legacy, 'demo'), { recursive: true })
    writeFileSync(join(legacy, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start, next: null}]\n', 'utf-8')
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst, legacyRoots: [legacy] })
    assert.deepEqual(r.legacyRemoved, ['demo'])
    assert.equal(existsSync(join(legacy, 'demo', 'workflow.yml')), false, 'legacy 副本必须删除（否则仍被优先发现）')
    // 删除前已备份（备份名带 .legacy.，不会被工作流发现逻辑当作 workflow.yml）
    const bak = join(legacy, 'demo', 'workflow.v1.0.0.legacy.bak.yml')
    assert.ok(existsSync(bak), '删除前应留下 legacy 备份')
    assert.match(readFileSync(bak, 'utf-8'), /next: null/, '备份内容应是旧副本原文')
    // 目标侧同时装上了 v2
    assert.deepEqual(r.installed, ['demo'])
    assert.match(readFileSync(join(dst, 'demo', 'workflow.yml'), 'utf-8'), /version: 2\.0\.0/)
    // 技能根里无该 id 时不误报
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: src, dstRoot: join(dst, 'x'), legacyRoots: [legacy] }).legacyRemoved, [])
  } finally {
    rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }); rmSync(legacy, { recursive: true, force: true })
  }
})

// C-2：版本号相同但正文不同（老用户机上的旧格式残留正是这种形态）也必须覆盖升级 + 备份，
// 否则"按 version 比对"对本工作流自身是 no-op（连备份都不做）。
test('内置工作流安装：版本相同但正文不同 → 内容指纹兜底覆盖并备份', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src4-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst4-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    mkdirSync(join(dst, 'demo'), { recursive: true })
    // 同版本、旧格式正文
    writeFileSync(join(dst, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start, next: null}]\n', 'utf-8')
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r.updated, [], '版本相同不应计入 updated')
    assert.deepEqual(r.contentUpdated, ['demo'])
    assert.match(readFileSync(join(dst, 'demo', 'workflow.yml'), 'utf-8'), /edges: \[\]/, '正文应被覆盖为源内容')
    assert.ok(existsSync(join(dst, 'demo', 'workflow.v1.0.0.bak.yml')), '覆盖前应备份同版本旧副本')
    assert.match(readFileSync(join(dst, 'demo', 'workflow.v1.0.0.bak.yml'), 'utf-8'), /next: null/)
    // 仅行尾空白差异（CRLF/尾随空格）不算内容不同 → 跳过
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\r\nversion: 1.0.0\r\nnodes: [{id: s, type: start}]  \r\nedges: []\r\n', 'utf-8')
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: src, dstRoot: dst }), { installed: [], updated: [], contentUpdated: [], skipped: ['demo'], skippedByUser: [], legacyRemoved: [] })
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})

// 用户删除记账（2026-09-17 修复）：删除内置工作流后重启不得复活。
// 病灶：安装器语义为「目标不存在 → 安装」，删除动作不留痕迹 ⇒ 删了重启又装回来，
//       用户侧表现为「删了还在、agent 照样能调用」。
test('用户删除记账：删除内置工作流后安装器不再装回，清除记账后恢复', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    // 首次安装：正常落地
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: src, dstRoot: dst }).installed, ['demo'])
    // 用户删除（删本体 + 记账）——等价于 DELETE 路由 + markBuiltinDeleted 的组合
    rmSync(join(dst, 'demo'), { recursive: true, force: true })
    assert.equal(markBuiltinDeleted({ srcRoot: src, dstRoot: dst, id: 'demo' }), true, '内置 id 应写入记账')
    assert.deepEqual(readDeletedBuiltins({ dstRoot: dst }), ['demo'])
    // 重启（再跑安装）：不得复活
    const r2 = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r2.installed, [], '已删除的内置工作流不得被自动装回')
    assert.deepEqual(r2.skippedByUser, ['demo'])
    assert.equal(existsSync(join(dst, 'demo', 'workflow.yml')), false, '重启后本体不应存在')
    // 记账文件不会被当成工作流：`.builtin-deleted.json` 是 `.` 前缀（列表/内核均跳过）
    assert.equal(existsSync(join(dst, '.builtin-deleted.json')), true)
    // 恢复路径：清除记账 → 下次安装重新落地
    assert.equal(clearDeletedBuiltins({ dstRoot: dst }), true)
    assert.deepEqual(readDeletedBuiltins({ dstRoot: dst }), [])
    assert.deepEqual(installBuiltinWorkflows({ srcRoot: src, dstRoot: dst }).installed, ['demo'])
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})

test('用户删除记账：三条刻意约束（非内置不记账 / 用户自建同名不被接管 / 目标存在时记账不生效）', () => {
  const src = mkdtempSync(join(tmpdir(), 'wf-src-'))
  const dst = mkdtempSync(join(tmpdir(), 'wf-dst-'))
  try {
    mkdirSync(join(src, 'demo'), { recursive: true })
    writeFileSync(join(src, 'demo', 'workflow.yml'), 'name: demo\nversion: 1.0.0\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    // ① 非内置 id 不记账（防污染记账文件 / 误挡用户自建工作流的重建）
    assert.equal(markBuiltinDeleted({ srcRoot: src, dstRoot: dst, id: 'user-own' }), false)
    assert.deepEqual(readDeletedBuiltins({ dstRoot: dst }), [])
    // ② 用户删掉后**自建同名**：目标存在 ⇒ 记账不得生效，安装器走正常版本比对
    //    （否则一次重启就会把用户自己写的工作流静默换成内置版）
    markBuiltinDeleted({ srcRoot: src, dstRoot: dst, id: 'demo' })
    mkdirSync(join(dst, 'demo'), { recursive: true })
    writeFileSync(join(dst, 'demo', 'workflow.yml'), 'name: demo\nversion: 9.9.9\nnodes: [{id: s, type: start}]\nedges: []\n', 'utf-8')
    const r = installBuiltinWorkflows({ srcRoot: src, dstRoot: dst })
    assert.deepEqual(r.skippedByUser, [], '目标存在时记账不得挡住安装器的正常比对')
    assert.deepEqual(r.updated, ['demo'], '用户自建的同名工作流按版本比对被升级（既有语义，未变）')
    assert.deepEqual(r.skipped, [])
    // ③ 重复记账幂等
    assert.equal(markBuiltinDeleted({ srcRoot: src, dstRoot: dst, id: 'demo' }), false, '同一 id 重复记账返回 false')
    assert.deepEqual(readDeletedBuiltins({ dstRoot: dst }), ['demo'])
  } finally { rmSync(src, { recursive: true, force: true }); rmSync(dst, { recursive: true, force: true }) }
})
