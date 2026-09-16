// S3 回归网①：团队源 + 同步盘四行为对策（spec §7.1/§7.2、§9「S3 同步盘」、批注 #10）
// ---------------------------------------------------------------------------
// 覆盖 §9 的 S3 三项之一：**同步盘对拍** —— 手工制造网盘冲突副本，断言"重放结果与单副本一致"，
// 且**不原地改名**。另覆盖 §7.1 四行为对策（冲突副本吸收 / 无 fs.watch / 占位符检测 / 校验写）
// 与批注 #10（目录改名容错：只认 team.json 内容，不认目录名）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import {
  TEAM_LAYOUT, logicalNameOf, listCopies, replayFileCopies, writeVerifiedSync, detectPlaceholderSync,
  detectGitAncestor, scanTeamDirs, clearScanCache, measureTeamSource, openTeamSource, ensureTeamDirs, teamPaths,
} from '../shared/team-source.mjs'
import { mergeMemberLogCopies } from '../shared/team-members.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)) }
function cleanup(p) {
  for (let i = 0; i < 8; i++) {
    try { rmSync(p, { recursive: true, force: true }); return } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

test('冲突副本识别：网盘常见命名都归一到同一逻辑名（只识别、不改名）', () => {
  const cases = [
    ['log-d_1.jsonl', 'log-d_1.jsonl', false],
    ['log-d_1 (1).jsonl', 'log-d_1.jsonl', true],
    ['log-d_1(2).jsonl', 'log-d_1.jsonl', true],
    ['log-d_1 - 副本.jsonl', 'log-d_1.jsonl', true],
    ['log-d_1 副本.jsonl', 'log-d_1.jsonl', true],
    ['log-d_1 - 副本 (2).jsonl', 'log-d_1.jsonl', true],
    ['log-d_1 - Copy.jsonl', 'log-d_1.jsonl', true],
    ['log-d_1 (copy 1).jsonl', 'log-d_1.jsonl', true],
    ['notes.md', 'notes.md', false],
    ['other.jsonl', 'other.jsonl', false],
  ]
  for (const [input, logical, isCopy] of cases) {
    const r = logicalNameOf(input)
    assert.equal(r.logical, logical, `${input} 的逻辑名`)
    assert.equal(r.isCopy, isCopy, `${input} 是否副本`)
  }
})

test('同步盘对拍：有冲突副本时重放 ≡ 无副本时重放（经去重），且**副本文件原样保留**', () => {
  const parse = (line) => JSON.parse(line)
  const rootA = tmp('yfw-s3-clean-')
  const rootB = tmp('yfw-s3-conflict-')
  try {
    const LINES = [
      '{"by":"u_owner","seq":1,"op":"add","memberId":"u_a"}',
      '{"by":"u_owner","seq":2,"op":"add","memberId":"u_b"}',
      '{"by":"u_owner","seq":3,"op":"role","memberId":"u_b","role":"editor"}',
      '{"by":"u_owner","seq":4,"op":"revoke","memberId":"u_a"}',
    ]
    // A：干净目录（无冲突副本）—— 基线
    const pa = ensureTeamDirs(rootA)
    writeFileSync(join(pa.membersDir, 'log-d_1.jsonl'), LINES.join('\n') + '\n', 'utf-8')
    const repA = replayFileCopies(pa.membersDir, 'log-d_1.jsonl', { parseLine: parse })
    const mergedA = mergeMemberLogCopies([{ name: 'log-d_1.jsonl', records: repA.records }])

    // B：同样内容 + 网盘冲突副本（副本是**部分/重复**的，正是同步中间态的常见形态）
    const pb = ensureTeamDirs(rootB)
    writeFileSync(join(pb.membersDir, 'log-d_1.jsonl'), LINES.join('\n') + '\n', 'utf-8')
    writeFileSync(join(pb.membersDir, 'log-d_1 (1).jsonl'), LINES.slice(0, 2).join('\n') + '\n', 'utf-8')      // 部分副本
    writeFileSync(join(pb.membersDir, 'log-d_1 - 副本.jsonl'), LINES.join('\n') + '\n', 'utf-8')               // 完整重复
    writeFileSync(join(pb.membersDir, 'log-d_1 - Copy.jsonl'), LINES[0] + '\n', 'utf-8')                        // 单行重复

    const copies = listCopies(pb.membersDir, 'log-d_1.jsonl')
    assert.deepEqual(copies.map((c) => c.name), [
      'log-d_1.jsonl', 'log-d_1 (1).jsonl', 'log-d_1 - Copy.jsonl', 'log-d_1 - 副本.jsonl',
    ], '本体排前，副本按码元序（顺序确定 ⇒ 重放可复现）')

    const repB = replayFileCopies(pb.membersDir, 'log-d_1.jsonl', { parseLine: parse })
    assert.equal(repB.records.length, 11, '吸收 = 多读（4+2+1+4 行），不是改写')
    const mergedB = mergeMemberLogCopies([{ name: 'log-d_1.jsonl', records: repB.records }])

    // 对拍：去重后与干净目录**逐字一致**（这就是 §9 要求的"重放结果须与单副本一致"）
    assert.deepEqual(mergedB, mergedA, '冲突副本不得改变重放结果')
    assert.equal(mergedB.length, 4)

    // **不原地改名**：读完后所有副本文件仍在（§7.1 明确"列目录按名吸收后重放，不原地改名"）
    assert.deepEqual(readdirSync(pb.membersDir).sort(), [
      'log-d_1 (1).jsonl', 'log-d_1 - Copy.jsonl', 'log-d_1 - 副本.jsonl', 'log-d_1.jsonl',
    ].sort(), '吸收过程绝不能改名或删除副本（改名会在别人的同步里制造更多冲突）')
  } finally { cleanup(rootA); cleanup(rootB) }
})

test('副本见证：本体被整体删除，仍能从其他副本复原（§5.9「删掉整个日志文件」）', () => {
  const root = tmp('yfw-s3-witness-')
  try {
    const p = ensureTeamDirs(root)
    const LINES = ['{"by":"u_o","seq":1,"op":"add","memberId":"u_x"}', '{"by":"u_o","seq":2,"op":"add","memberId":"u_y"}']
    // 某成员本机保留的见证副本（网盘上本体被误删）
    writeFileSync(join(p.membersDir, 'log-d_1 - 副本.jsonl'), LINES.join('\n') + '\n', 'utf-8')
    const rep = replayFileCopies(p.membersDir, 'log-d_1.jsonl', { parseLine: JSON.parse })
    const merged = mergeMemberLogCopies([{ name: 'log-d_1 - 副本.jsonl', records: rep.records }])
    assert.equal(merged.length, 2, '本体不在时，仅凭副本仍能复原全部记录')
    assert.deepEqual(merged.map((r) => r.memberId), ['u_x', 'u_y'])
  } finally { cleanup(root) }
})

test('校验写：.tmp → 校验 → rename → 回读；期望哈希不符则报错且不覆盖目标', () => {
  const root = tmp('yfw-s3-write-')
  try {
    const target = join(root, 'team.json')
    const r = writeVerifiedSync(target, 'hello 团队\n')
    assert.equal(readFileSync(target, 'utf-8'), 'hello 团队\n')
    assert.equal(r.bytes, Buffer.byteLength('hello 团队\n'))
    assert.equal(readdirSync(root).filter((n) => n.includes('.tmp')).length, 0, '成功路径不应残留 .tmp')

    // 期望哈希不符：必须抛错，且**目标文件保持旧内容**（不能写坏）
    assert.throws(() => writeVerifiedSync(target, 'new content', { expectHash: 'deadbeef' }), /校验失败/)
    assert.equal(readFileSync(target, 'utf-8'), 'hello 团队\n', '校验失败时目标文件必须保持原样')
    assert.equal(readdirSync(root).filter((n) => n.includes('.tmp')).length, 0, '校验失败时应清掉临时文件')
  } finally { cleanup(root) }
})

test('占位符检测：空文件标"可疑"但不算占位符；读不到内容的才算（不把在线文件当空文件覆盖）', () => {
  const root = tmp('yfw-s3-placeholder-')
  try {
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    const e = detectPlaceholderSync(empty)
    assert.equal(e.placeholder, false, '空文件本身合法（新建日志）⇒ 不能一律当占位符')
    assert.equal(e.reason, 'empty-file')
    assert.equal(detectPlaceholderSync(empty, { zeroSizeIsPlaceholder: true }).placeholder, true, '可显式开启严格模式')

    const good = join(root, 'good.jsonl')
    writeFileSync(good, '{"a":1}\n')
    assert.deepEqual(detectPlaceholderSync(good), { placeholder: false, reason: 'ok', size: 8 })

    assert.equal(detectPlaceholderSync(join(root, 'missing')).reason, 'absent', '不存在的文件不是占位符')
    assert.equal(detectPlaceholderSync(root).reason, 'directory')

    // 占位符在重放里必须被**跳过并如实报告**（不静默丢弃、也不当成空内容）
    const dir = join(root, 'members')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'log-d_9.jsonl'), '')
    const rep = replayFileCopies(dir, 'log-d_9.jsonl', { parseLine: JSON.parse })
    assert.deepEqual(rep.records, [], '空副本不产生记录')
    assert.deepEqual(rep.skipped, [], '空副本不是"跳过"，而是合法的空内容')
  } finally { cleanup(root) }
})

test('批注 #10：只认 team.json 内容 —— 目录改名/复制后仍能被发现，与目录名无关', () => {
  const root = tmp('yfw-s3-rename-')
  try {
    clearScanCache()
    const a = join(root, '团队-A')
    const b = join(root, '随便叫什么都行')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'team.json'), JSON.stringify({ teamId: 't_aaa', name: '甲', identCode: '111111111' }))
    writeFileSync(join(b, 'team.json'), JSON.stringify({ teamId: 't_bbb', name: '乙', identCode: '222222222' }))

    const sc = scanTeamDirs({ root })
    assert.deepEqual(sc.found.map((f) => f.teamId).sort(), ['t_aaa', 't_bbb'], '按内容发现两个团队')
    assert.ok(sc.scanned >= 2, '应报告扫描过的目录数（供评估成本，批注 #6）')
    assert.equal(typeof sc.elapsedMs, 'number', '应报告耗时（只度量，不擅自定策略）')

    // 改名之后仍能找到（这正是 #10 要解决的场景）
    const renamed = join(root, '改成了别的名字')
    renameSync(a, renamed)
    clearScanCache()
    const sc2 = scanTeamDirs({ root })
    assert.ok(sc2.found.some((f) => f.teamId === 't_aaa' && f.dir === renamed), '目录改名后仍应按内容找到（并给出新路径）')

    // 坏 manifest 记警告而不是崩
    const c = join(root, 'bad')
    mkdirSync(c, { recursive: true })
    writeFileSync(join(c, 'team.json'), '{ 不是 JSON')
    clearScanCache()
    const sc3 = scanTeamDirs({ root })
    assert.ok(sc3.warnings.some((w) => w.kind === 'manifest-malformed'), '坏 manifest 应记警告并继续扫')

    // 搜索根不存在：如实报告，不假装"没找到团队"
    clearScanCache()
    const sc4 = scanTeamDirs({ root: join(root, '根本不存在') })
    assert.equal(sc4.found.length, 0)
    assert.ok(sc4.warnings.some((w) => w.kind === 'root-missing'), '"根不存在"与"根里没团队"必须可区分')
  } finally { cleanup(root) }
})

// renameSync 需要同步用到；此处用动态 import 的包装保持测试可读
function await_rename(from, to) {
  return require('node:fs').renameSync(from, to)
}

test('.git 警告：团队源在 git 工作区内 → 警告但不阻断（§7.1）', () => {
  const root = tmp('yfw-s3-git-')
  try {
    const outer = join(root, 'repo')
    const teamDir = join(outer, '团队')
    mkdirSync(teamDir, { recursive: true })
    mkdirSync(join(outer, '.git'), { recursive: true })
    writeFileSync(join(teamDir, 'team.json'), JSON.stringify({ teamId: 't_git', name: '内网团队' }))

    const g = detectGitAncestor(teamDir)
    assert.equal(g.inGit, true, '应向上发现 .git')
    const src = openTeamSource({ root: teamDir })
    assert.ok(src.scanWarnings().some((w) => w.kind === 'in-git-repo'), 'scanWarnings 应给出 in-git-repo')

    clearScanCache()
    const sc = scanTeamDirs({ root: outer })
    assert.ok(sc.warnings.some((w) => w.kind === 'in-git-repo'), '扫描也应带出该警告')
    assert.equal(sc.found.length, 1, '但**不阻断**：团队仍被发现')

    // git 之外的目录不应误报
    const outside = join(root, '普通目录')
    mkdirSync(outside, { recursive: true })
    assert.equal(detectGitAncestor(outside, { upLevels: 1 }).inGit, false, 'upLevels 生效且不误报')
  } finally { cleanup(root) }
})

test('安全/契约：本模块**不含 fs.watch 使用**（§7.1 明确禁用）；team.json 不含任何密钥字段', () => {
  // 断言的是"没有使用"，不是"字符串不出现"——注释里写着"禁用 fs.watch"是**应该**出现的，
  // 若直接对整份源码做正则，会把注释误判为违规（首轮就是这么假红的）。先剥注释再查。
  const raw = readFileSync(join(REPO_ROOT, 'shared', 'team-source.mjs'), 'utf-8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.equal(/\bwatch\s*\(|\bwatchFile\s*\(|\bunwatchFile\s*\(/.test(code), false,
    '§7.1 明确"轮询扫描，不用 fs.watch"（网盘事件不可靠）')

  const root = tmp('yfw-s3-nokey-')
  try {
    const src = openTeamSource({ root })
    src.ensure()
    src.writeManifest({ teamId: 't_nokey', name: '无密钥团队', identCode: '123456789', scrypt: { N: 2 ** 15 } })
    const manifest = readFileSync(join(root, TEAM_LAYOUT.MANIFEST), 'utf-8')
    assert.equal(/teamKey|privateKey|secretKey|"key"/i.test(manifest), false,
      '§7.2：team.json 是明文，**绝不含团队密钥**（团队密钥只在 keys/<memberId>.env 信封里）')
  } finally { cleanup(root) }
})

test('L2 服务器源：明确未实现（§7.1 表 / 定案 14）——不得预埋实现', () => {
  const root = tmp('yfw-s3-l2-')
  try {
    assert.throws(() => openTeamSource({ kind: 'l2-server', root }), /未实现|S5/,
      'L2 属 S5，调用应明确报错而不是假装可用')
  } finally { cleanup(root) }
})

test('体积度量：只度量不阻断（批注 #8 未定）', () => {
  const root = tmp('yfw-s3-measure-')
  try {
    mkdirSync(join(root, 'members'), { recursive: true })
    writeFileSync(join(root, 'members', 'log-d_1.jsonl'), 'x'.repeat(1000))
    const m = measureTeamSource(root)
    assert.equal(m.files, 1)
    assert.equal(m.bytes, 1000)
    assert.equal(m.overWarnBytes, false)
    assert.equal(m.truncated, false)
  } finally { cleanup(root) }
})

test('teamPaths：§7.2 布局六项齐全（拼歪路径会静默写到别处，故逐项钉住）', () => {
  const p = teamPaths('/tmp/teamroot')
  assert.equal(p.manifest, join('/tmp/teamroot', 'team.json'))
  assert.equal(p.log('d_1'), join('/tmp/teamroot', 'members', 'log-d_1.jsonl'))
  assert.equal(p.keyEnvelope('u_1'), join('/tmp/teamroot', 'keys', 'u_1.env'))
  assert.equal(p.casBlob('abcdef123456'), join('/tmp/teamroot', 'cas', 'ab', 'abcdef123456'), 'CAS = cas/<hash[0:2]>/<hash>')
  assert.equal(p.versionLog('f_1'), join('/tmp/teamroot', 'versions', 'f_1.jsonl'))
  assert.equal(p.claimLog('f_1'), join('/tmp/teamroot', 'claims', 'f_1.jsonl'))
})
