// S3 回归网①：团队源 + 同步盘四行为对策（spec §7.1/§7.2、§9「S3 同步盘」、批注 #10）
// ---------------------------------------------------------------------------
// 覆盖 §9 的 S3 三项之一：**同步盘对拍** —— 手工制造网盘冲突副本，断言"重放结果与单副本一致"，
// 且**不原地改名**。另覆盖 §7.1 四行为对策（冲突副本吸收 / 无 fs.watch / 占位符检测 / 校验写）
// 与批注 #10（目录改名容错：只认 team.json 内容，不认目录名）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import {
  TEAM_LAYOUT, TEAM_CONTAINER_DIR, logicalNameOf, listCopies, replayFileCopies, writeVerifiedSync, detectPlaceholderSync,
  detectGitAncestor, scanTeamDirs, clearScanCache, measureTeamSource, openTeamSource, ensureTeamDirs, teamPaths,
} from '../shared/team-source.mjs'
import { execFileSync } from 'node:child_process'
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
    const manifest = readFileSync(join(root, TEAM_CONTAINER_DIR, TEAM_LAYOUT.MANIFEST), 'utf-8')
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

test('teamPaths：布局六项齐全且**全部落在 .yfworking/ 容器内**（拼歪路径会静默写到别处，故逐项钉住）', () => {
  const p = teamPaths('/tmp/teamroot')
  // 写侧：一切团队留档都在容器内 ⇒ 用户的工作目录只多出 `.yfworking/` 一个条目
  assert.equal(p.container, join('/tmp/teamroot', '.yfworking'), '容器目录 = <团队根>/.yfworking')
  assert.equal(p.manifest, join('/tmp/teamroot', '.yfworking', 'team.json'))
  assert.equal(p.log('d_1'), join('/tmp/teamroot', '.yfworking', 'members', 'log-d_1.jsonl'))
  assert.equal(p.keyEnvelope('u_1'), join('/tmp/teamroot', '.yfworking', 'keys', 'u_1.env'))
  assert.equal(p.casBlob('abcdef123456'), join('/tmp/teamroot', '.yfworking', 'cas', 'ab', 'abcdef123456'), 'CAS = cas/<hash[0:2]>/<hash>')
  assert.equal(p.versionLog('f_1'), join('/tmp/teamroot', '.yfworking', 'versions', 'f_1.jsonl'))
  assert.equal(p.claimLog('f_1'), join('/tmp/teamroot', '.yfworking', 'claims', 'f_1.jsonl'))
  assert.equal(p.knowledgeDir, join('/tmp/teamroot', '.yfworking', 'knowledge'))
  assert.equal(p.experienceDir, join('/tmp/teamroot', '.yfworking', 'experience'))
  assert.equal(p.policyFile, join('/tmp/teamroot', '.yfworking', 'policies.json'))
  // 反向断言：**不得**再把团队文件写在团队根下（否则又和用户的工作文件混在一起）
  for (const [name, v] of [['manifest', p.manifest], ['members', p.membersDir], ['keys', p.keysDir], ['cas', p.casDir], ['versions', p.versionsDir], ['claims', p.claimsDir]]) {
    assert.ok(v.startsWith(p.container + sep), `${name} 必须位于容器内，实得 ${v}`)
  }
  // 旧布局路径仍被完整保留（双读回退要用）
  assert.equal(p.legacy.manifest, join('/tmp/teamroot', 'team.json'))
  assert.equal(p.legacy.casBlob('abcdef123456'), join('/tmp/teamroot', 'cas', 'ab', 'abcdef123456'))
})

test('容器隔离（本需求的核心）：建团队后工作目录里**只多出容器**一个条目', () => {
  const outer = tmp('yfw-s3-clean-')
  try {
    // workDir 就是用户的**工作目录**（真实场景里放的是申报材料）：团队根直接指向它
    const workDir = join(outer, '湖北某公司申报材料')
    mkdirSync(workDir, { recursive: true })
    // 先放几个"工作文件"，确认同步/建团队不碰它们
    writeFileSync(join(workDir, '知识产权汇总表.xlsx'), 'work-file')
    writeFileSync(join(workDir, '立项报告.docx'), 'work-file')
    const before = readdirSync(workDir).sort()

    const src = openTeamSource({ root: workDir })
    src.ensure()
    src.writeManifest({ teamId: 't_clean', name: '整洁团队', identCode: '123456789' })
    src.writeLog('d_1', '{"type":"add"}\n')
    src.writeKeyEnvelope('u_1', 'env')

    const after = readdirSync(workDir).sort()
    const added = after.filter((n) => !before.includes(n))
    assert.deepEqual(added, [TEAM_CONTAINER_DIR], `工作目录里只应新增容器一项，实得 ${JSON.stringify(added)}`)
    // 工作文件原样未动
    assert.equal(readFileSync(join(workDir, '知识产权汇总表.xlsx'), 'utf-8'), 'work-file')
    // 团队文件确实在容器里，而不是散在根下
    for (const rel of ['team.json', join('members', 'log-d_1.jsonl'), join('keys', 'u_1.env')]) {
      assert.equal(existsSync(join(workDir, TEAM_CONTAINER_DIR, rel)), true, `应在容器内: ${rel}`)
      assert.equal(existsSync(join(workDir, rel)), false, `不应散在团队根下: ${rel}`)
    }
  } finally { cleanup(outer) }
})

test('双读兼容：旧布局（团队根下）的团队仍能被发现、读到清单与内容', () => {
  const outer = tmp('yfw-s3-dual-')
  try {
    const dir = join(outer, '旧团队工作目录')
    mkdirSync(join(dir, 'members'), { recursive: true })
    mkdirSync(join(dir, 'keys'), { recursive: true })
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 't_old', name: '旧团队', identCode: '987654321' }))
    writeFileSync(join(dir, 'members', 'log-d_old.jsonl'), '{"type":"add","by":"u_a","seq":1}\n')
    writeFileSync(join(dir, 'keys', 'u_a.env'), 'legacy-env')

    // ① 扫描能发现（resolveRoot 也要认）
    clearScanCache()
    const scan = scanTeamDirs({ root: outer, maxDepth: 3 })
    assert.equal(scan.found.length, 1, '旧布局团队必须仍能被发现')
    assert.equal(scan.found[0].teamId, 't_old')
    assert.equal(scan.found[0].dir, dir, '报出的应是**团队根**（容器所在目录），不是容器本身')

    // ② 读清单/日志/信封都走旧布局回退
    const src = openTeamSource({ root: dir })
    assert.equal(src.readManifest().teamId, 't_old')
    assert.equal(src.layout(), 'legacy', '未迁移的旧团队应报告为 legacy 布局')
    assert.deepEqual(src.listLogNames(), ['log-d_old.jsonl'], '旧布局 members/ 里的日志名必须读得到')
    assert.equal(src.readLogCopies('d_old').records.length, 1)
    assert.equal(src.readKeyEnvelope('u_a'), 'legacy-env', '旧布局 keys/ 里的信封必须读得到（否则收不到邀请）')
    // CAS 读侧也要回退：在旧布局放一个内容块，读侧必须能取到它（否则历史版本读不出来）
    mkdirSync(join(dir, 'cas', 'de'), { recursive: true })
    writeFileSync(join(dir, 'cas', 'de', 'deadbeef'), 'legacy-blob')
    assert.equal(src.paths.read.casBlob('deadbeef'), join(dir, 'cas', 'de', 'deadbeef'), 'CAS 读侧要回退到旧布局')
    // 新布局里放同名块时以新布局为准
    mkdirSync(join(dir, TEAM_CONTAINER_DIR, 'cas', 'de'), { recursive: true })
    writeFileSync(join(dir, TEAM_CONTAINER_DIR, 'cas', 'de', 'deadbeef'), 'new-blob')
    assert.equal(src.paths.read.casBlob('deadbeef'), join(dir, TEAM_CONTAINER_DIR, 'cas', 'de', 'deadbeef'), '两边都有时新布局优先')

    // ③ 写侧仍进容器：新内容不再往工作目录根上摊
    src.writeLog('d_old', '{"type":"add","by":"u_b","seq":2}\n')
    assert.equal(existsSync(join(dir, TEAM_CONTAINER_DIR, 'members', 'log-d_old.jsonl')), true)
    assert.equal(existsSync(join(dir, 'members', 'log-d_old.jsonl')), true, '旧侧文件保持原样（不迁移、不删除）')
  } finally { cleanup(outer) }
})

test('双读并集：给旧团队追加记录后，**旧侧历史不丢**（日志不能"缺失回退"）', () => {
  const outer = tmp('yfw-s3-union-')
  try {
    const dir = join(outer, '混合态团队')
    mkdirSync(join(dir, 'members'), { recursive: true })
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 't_mix', name: '混合态', identCode: '111222333' }))
    // 旧侧有 2 条历史
    writeFileSync(join(dir, 'members', 'log-d_1.jsonl'), '{"type":"add","by":"u_a","seq":1}\n{"type":"add","by":"u_a","seq":2}\n')

    const src = openTeamSource({ root: dir })
    // 新代码追加第 3 条 → 落在容器侧（该文件在容器里**新建**）
    src.writeLog('d_1', '{"type":"add","by":"u_a","seq":3}\n')
    const r = src.readLogCopies('d_1')
    assert.equal(r.records.length, 3, '旧侧 2 条 + 容器侧 1 条都要在（只读一边就会丢历史）')
    assert.deepEqual(r.records.map((s) => JSON.parse(s).seq), [1, 2, 3], '顺序应为 先旧侧 后容器侧 = 时间序')

    // 重复记录（两侧出现同一条）不靠行级去重，而由 mergeMemberLogCopies 按 (by, seq) 折叠掉：
    // 这里钉的是"折叠结果正确"，而不是"并集里不能出现重复行"（后者会误删真的同内容的独立记录）。
    writeFileSync(join(dir, 'members', 'log-d_1.jsonl'), '{"type":"add","by":"u_a","seq":1,"ts":"2026-01-01T00:00:00.000Z"}\n{"type":"add","by":"u_a","seq":3,"ts":"2026-01-03T00:00:00.000Z"}\n')
    writeFileSync(join(dir, TEAM_CONTAINER_DIR, 'members', 'log-d_1.jsonl'), '{"type":"add","by":"u_a","seq":3,"ts":"2026-01-03T00:00:00.000Z"}\n')
    const rep = openTeamSource({ root: dir }).readLogCopies('d_1')
    const merged = mergeMemberLogCopies([{ name: 'log-d_1.jsonl', records: rep.records.map((s) => JSON.parse(s)) }])
    assert.deepEqual(merged.map((r) => r.seq), [1, 3], '折叠后不得出现重复的 (by,seq)')
  } finally { cleanup(outer) }
})

test('隐藏属性：POSIX 上点开头即隐藏故跳过；win32 上要真的调用 attrib +h 且失败不抛错', async () => {
  const { hideContainerSync } = await import('../shared/team-source.mjs')
  // POSIX：无需额外处理
  assert.equal(hideContainerSync('/tmp/x', { platform: 'linux' }).skipped, 'not-windows')
  assert.equal(hideContainerSync('/tmp/x', { platform: 'darwin' }).skipped, 'not-windows')
  // win32：本机真实执行一次（best-effort，失败也只返回 ok:false 不抛错）
  const dir = tmp('yfw-s3-hidden-')
  try {
    const target = join(dir, TEAM_CONTAINER_DIR)
    mkdirSync(target, { recursive: true })
    const r = hideContainerSync(target, { platform: 'win32' })
    assert.equal(r.ok, true, `attrib +h 应成功（reason: ${r.reason || ''}）`)
    if (process.platform === 'win32') {
      // 验证属性真的生效：`attrib` 输出里带 H
      const out = execFileSync('attrib', [target], { encoding: 'utf-8' })
      assert.match(out, /\bH\b/, `attrib 应显示隐藏位，实得: ${out.trim()}`)
    }
    // 目录不存在时：**不抛错**（best-effort 的契约）。注意 `attrib` 对不存在的路径返回码可能仍是 0，
    // 故这里只钉"不抛 + 结构完整"，不钉 ok 的取值——否则就是在钉 attrib 的未文档化行为。
    let bad = null
    assert.doesNotThrow(() => { bad = hideContainerSync(join(dir, '不存在的目录'), { platform: 'win32' }) })
    assert.equal(typeof bad.ok, 'boolean')
    assert.equal(bad.path, join(dir, '不存在的目录'))
  } finally { cleanup(dir) }
})
