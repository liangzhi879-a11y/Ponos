// kit/lib/kit-root.test.mjs —— 根解析（含"调试版里跑门禁"这条新路径）
//
// 为什么这些用例值得写：`resolveKitRoot` 是"调试版里能不能跑门禁"的**唯一开关**。它判错的两种后果都很隐蔽：
//   · 判"可用"但实际不是 git 仓顶层（例如便携版在仓库内部，`git ls-files` 在该目录下是 0 条）
//     ⇒ 门禁跑起来"每条都红"，假红比不跑更糟 —— 它教人不再相信红灯；
//   · 判"不可用"但其实能跑 ⇒ 开发在调试版里自查不了门禁（用户口径：开发就在调试版上跑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveKitRoot, gitTopLevel, samePath, rootFailureHint, defaultHere, devSourceMarkerName,
} from './kit-root.mjs'

const REPO = defaultHere() // 测试在本仓里跑 ⇒ 默认自身位置 = 仓库根

test('★ 真实仓：默认位置就是 git 仓顶层 ⇒ 就地跑（source=repo，行为与从前一致）', () => {
  const info = resolveKitRoot({ env: {} })
  assert.equal(info.ok, true)
  assert.equal(info.source, 'repo', '在仓库里跑时不该走任何借用路径')
  assert.equal(samePath(info.root, REPO), true)
  assert.equal(samePath(gitTopLevel(REPO), REPO), true, '判据是"自身 == git 顶层"，不是"在某个仓里"')
})

test('★ env 优先：YFW_KIT_ROOT 一给就用它（测试/多仓场景；既有行为不变）', () => {
  const info = resolveKitRoot({ env: { YFW_KIT_ROOT: '/some/other/repo' } })
  assert.equal(info.source, 'env')
  assert.equal(info.ok, true, 'env 是显式意图 ⇒ 不做 git 校验（否则"指到还没 init 的目录"会莫名失败）')
  assert.match(info.why, /YFW_KIT_ROOT/)
})

test('★★ 调试版：自身不是 git 仓顶层、但带 dev-source marker ⇒ 借源仓真值', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    const marker = devSourceMarkerName()
    assert.ok(marker, '真源应登记 dev-source marker 名（channelEvidence.debug.markers）')
    writeFileSync(join(tmp, marker), JSON.stringify({ sourceRoot: REPO }))
    const info = resolveKitRoot({ here: tmp, env: {} })
    assert.equal(info.ok, true, '调试版必须能跑门禁 —— 这是用户明确要的能力')
    assert.equal(info.source, 'dev-source')
    assert.equal(samePath(info.root, REPO), true, '根要指向**源仓**（便携版代码本就是它的副本 ⇒ 结果等价）')
    assert.match(info.why, /源仓/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ 便携版在仓库内部也算"自身不是顶层" ⇒ 仍走 marker 借源仓（本机实况）', () => {
  // 实况：`release/YFWorking` 在仓库里，`gitTopLevel` 会返回**仓库根**（≠ 自身）⇒ 必须落到 marker 分支。
  // 若这里误判成"可用"，在本机跑便携版门禁就会得到满屏假红（`release/` 被 gitignore ⇒ ls-files 空）。
  const fake = join(REPO, 'release', 'YFWorking')
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    const marker = devSourceMarkerName()
    writeFileSync(join(tmp, marker), JSON.stringify({ sourceRoot: REPO }))
    const info = resolveKitRoot({ here: fake, env: {} }) // 借真实"便携版目录"当入口，marker 从别处模拟不了 ⇒ 用 tmp 验同一分支
    const info2 = resolveKitRoot({ here: tmp, env: {} })
    assert.equal(info2.source, 'dev-source')
    // 直接断言"在仓内部但不是顶层 ⇒ gitTopLevel ≠ here"（这是判据本身）
    const top = gitTopLevel(fake)
    assert.ok(top === null || !samePath(top, fake),
      '便携版目录绝不能被评为"自身是 git 顶层" —— 否则真值域为空、门禁全红')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ fail-closed：既不是仓顶层、也没有 marker ⇒ 明确失败 + 能照着做的诊断', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    const info = resolveKitRoot({ here: tmp, env: {} })
    assert.equal(info.ok, false, '认不出来就必须拒绝（不许拿一个读不到真值的根去跑出假红）')
    assert.equal(info.source, 'none')
    const hint = rootFailureHint(info)
    assert.match(hint, /YFW_KIT_ROOT/, '诊断要给能照做的办法')
    assert.match(hint, /git 提交态|git ls-files/, '要说清"为什么不行"（真值来自 git 提交态）')
    assert.match(hint, /node kit\/cli\.mjs check/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ marker 在但 sourceRoot 无效 ⇒ 也是失败（不许当"可用"含糊过去）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    writeFileSync(join(tmp, devSourceMarkerName()), JSON.stringify({ sourceRoot: join(tmp, '不存在') }))
    const info = resolveKitRoot({ here: tmp, env: {} })
    assert.equal(info.ok, false)
    assert.equal(info.source, 'dev-source', '要能区分"这是调试版但源仓没了"与"根本不是调试版"')
    assert.match(info.why, /sourceRoot/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ marker 损坏（非 JSON）⇒ 失败而不是抛栈', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    writeFileSync(join(tmp, devSourceMarkerName()), '{ 这不是 JSON')
    const info = resolveKitRoot({ here: tmp, env: {} })
    assert.equal(info.ok, false)
    assert.match(info.why, /sourceRoot/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ 非 git 目录：gitTopLevel 返回 null（不抛）—— 拿到栈就没法给出可照做的诊断', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kitroot-'))
  try {
    assert.equal(gitTopLevel(tmp), null)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('★ samePath：Windows 大小写/分隔符/尾斜杠都要归一（否则"同一个目录"判不等 ⇒ 误判不可用）', () => {
  assert.equal(samePath('C:\\Foo\\Bar', 'c:/foo/bar/'), true)
  assert.equal(samePath('C:/foo', 'C:/foo/other'), false)
  assert.equal(samePath('C:/foo', 'C:/foobar'), false, '前缀相同但不是同一个目录')
})

test('★ defaultHere = kit 的上一级（仓/便携版根）—— CLI 与 GUI 都靠它，别写错层级', () => {
  assert.equal(samePath(defaultHere(), REPO), true, 'kit/lib/kit-root.mjs → 上两级 = 根')
})
