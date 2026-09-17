// 旧布局 → `.yfworking/` 容器 的手动迁移工具回归网（2026-09-17）。
//
// 为什么要有它：这是**唯一会动用户/共享盘已有数据**的入口，且团队目录常常同时被其他成员的客户端
// 扫描。误删或半迁移（清单搬走、cas 没搬）会让团队直接不可用，故必须钉住：
//   · 迁移是"移动"而非"复制+删除"语义：内容逐字节不变、旧位置清空、容器齐全；
//   · 任何一项不到位就**整体回滚**，绝不留下半迁移状态（宁可不迁移）；
//   · 目标已存在同名条目时**跳过而不是覆盖**（覆盖 = 静默丢数据）；
//   · 往返（迁移 → 回滚）后与迁移前完全一致（可逆）；
//   · 真实旧布局团队迁移后仍能被 `openTeamSource` 正常读取（迁移不破坏可用性）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..')
const { TEAM_ITEMS, inspect, migrate, unmigrate } = require(join(ROOT, 'scripts', 'migrate-team-container.cjs'))
const { openTeamSource, teamPaths, TEAM_CONTAINER_DIR } = await import('../shared/team-source.mjs')
const { TEAM_LAYOUT } = await import('../shared/team-source.mjs')

const tmp = () => mkdtempSync(join(tmpdir(), 'yfw-mig-'))

/** 造一个"旧布局"团队：元数据摊在团队根下，外加两个用户工作文件 */
function mkLegacyTeam(root, name = '旧团队') {
  mkdirSync(join(root, 'members'), { recursive: true })
  mkdirSync(join(root, 'keys'), { recursive: true })
  mkdirSync(join(root, 'cas', 'ab'), { recursive: true })
  mkdirSync(join(root, 'versions'), { recursive: true })
  mkdirSync(join(root, 'claims'), { recursive: true })
  writeFileSync(join(root, TEAM_LAYOUT.MANIFEST), JSON.stringify({ teamId: 't_mig', name, identCode: '123456789' }))
  writeFileSync(join(root, 'members', 'log-d_1.jsonl'), '{"type":"add","by":"u_a","seq":1}\n')
  writeFileSync(join(root, 'keys', 'u_a.env'), 'env-content')
  writeFileSync(join(root, 'cas', 'ab', 'abc123'), 'blob-content')
  writeFileSync(join(root, 'versions', 'f_1.jsonl'), '{"versionId":"abc123"}\n')
  writeFileSync(join(root, 'claims', 'f_1.jsonl'), '{"type":"checkout"}\n')
  writeFileSync(join(root, '工作文件.xlsx'), 'work')
  return root
}

test('迁移：团队条目全部进容器，内容逐字节不变，旧位置清空，工作文件不受影响', () => {
  const dir = mkLegacyTeam(tmp())
  const before = {
    log: readFileSync(join(dir, 'members', 'log-d_1.jsonl'), 'utf8'),
    env: readFileSync(join(dir, 'keys', 'u_a.env'), 'utf8'),
    blob: readFileSync(join(dir, 'cas', 'ab', 'abc123'), 'utf8'),
    work: readFileSync(join(dir, '工作文件.xlsx'), 'utf8'),
  }
  const r = migrate(dir)
  assert.deepEqual(r.errors, [])
  assert.equal(r.rolledBack, false)
  assert.equal(r.moved.length, 6, `应搬 6 项，实得 ${JSON.stringify(r.moved)}`)
  // 容器内齐全
  for (const n of ['team.json', 'members', 'keys', 'cas', 'versions', 'claims']) {
    assert.ok(existsSync(join(dir, TEAM_CONTAINER_DIR, n)), `容器内应有 ${n}`)
  }
  // 旧位置清空
  for (const n of TEAM_ITEMS) assert.equal(existsSync(join(dir, n)), false, `团队根下不该再有 ${n}`)
  // 内容逐字节不变（rename 语义，不是"复制+改"）
  assert.equal(readFileSync(join(dir, TEAM_CONTAINER_DIR, 'members', 'log-d_1.jsonl'), 'utf8'), before.log)
  assert.equal(readFileSync(join(dir, TEAM_CONTAINER_DIR, 'keys', 'u_a.env'), 'utf8'), before.env)
  assert.equal(readFileSync(join(dir, TEAM_CONTAINER_DIR, 'cas', 'ab', 'abc123'), 'utf8'), before.blob)
  // 工作文件没被碰
  assert.equal(readFileSync(join(dir, '工作文件.xlsx'), 'utf8'), before.work)
  // 工作目录里只剩"工作文件 + 容器"
  assert.deepEqual(readdirSync(dir).sort(), ['工作文件.xlsx', TEAM_CONTAINER_DIR].sort())
})

test('迁移后团队仍可正常读取（迁移不得破坏可用性）', () => {
  const dir = mkLegacyTeam(tmp())
  migrate(dir)
  const src = openTeamSource({ root: dir })
  assert.equal(src.layout(), 'container', '迁移后应报告为新布局')
  assert.equal(src.readManifest().teamId, 't_mig')
  assert.deepEqual(src.listLogNames(), ['log-d_1.jsonl'])
  assert.equal(src.readKeyEnvelope('u_a'), 'env-content')
  assert.equal(src.readLogCopies('d_1').records.length, 1)
})

test('安全：目标已存在同名条目时跳过而非覆盖（覆盖等于静默丢数据）', () => {
  const dir = mkLegacyTeam(tmp())
  // 容器里先放一个同名但内容不同的 team.json（模拟并发/重复执行）
  mkdirSync(join(dir, TEAM_CONTAINER_DIR), { recursive: true })
  writeFileSync(join(dir, TEAM_CONTAINER_DIR, TEAM_LAYOUT.MANIFEST), 'EXISTING-DO-NOT-OVERWRITE')
  const r = migrate(dir)
  assert.ok(r.errors.some((e) => /已存在/.test(e)), `应报"已存在"并跳过，实得 ${JSON.stringify(r.errors)}`)
  assert.equal(r.rolledBack, true, '有错即整体回滚')
  // 关键：容器里原有的内容**必须原样**，旧位置也**必须回滚**
  assert.equal(readFileSync(join(dir, TEAM_CONTAINER_DIR, TEAM_LAYOUT.MANIFEST), 'utf8'), 'EXISTING-DO-NOT-OVERWRITE')
  assert.equal(existsSync(join(dir, 'members')), true, '回滚后旧布局条目应回到团队根下')
  assert.equal(readFileSync(join(dir, 'members', 'log-d_1.jsonl'), 'utf8'), '{"type":"add","by":"u_a","seq":1}\n')
  assert.equal(readFileSync(join(dir, TEAM_LAYOUT.MANIFEST), 'utf8').includes('t_mig'), true, '清单应已回滚')
})

test('可逆：迁移 → 回滚 后与迁移前一致，且容器被清理', () => {
  const dir = mkLegacyTeam(tmp())
  const snapshot = readdirSync(dir).sort()
  migrate(dir)
  const back = unmigrate(dir)
  assert.deepEqual(back.errors, [])
  assert.equal(back.moved.length, 6)
  assert.deepEqual(readdirSync(dir).sort(), snapshot, '往返后目录内容应与初始一致')
  assert.equal(existsSync(join(dir, TEAM_CONTAINER_DIR)), false, '容器已空 ⇒ 应被移除，不留空壳')
  assert.equal(readFileSync(join(dir, 'cas', 'ab', 'abc123'), 'utf8'), 'blob-content', '内容逐字节不变')
})

test('幂等/无副作用：非团队目录、已迁移目录都会被安全跳过', () => {
  // ① 非团队目录：没有任何旧布局条目 ⇒ 不动作、不报错
  const plain = tmp()
  writeFileSync(join(plain, '随便.txt'), 'x')
  const r = migrate(plain)
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.errors, [])
  assert.ok(r.skipped.some((s) => /没有旧布局条目/.test(s)))
  assert.equal(existsSync(join(plain, TEAM_CONTAINER_DIR)), false, '不该为无关目录建容器')
  assert.deepEqual(readdirSync(plain), ['随便.txt'])

  // ② 已迁移的目录再跑一次：静默跳过（可安全重复执行）
  const dir = mkLegacyTeam(tmp())
  migrate(dir)
  const again = migrate(dir)
  assert.deepEqual(again.moved, [])
  assert.deepEqual(again.errors, [])
  assert.equal(inspect(dir).legacyItems.length, 0)

  // ③ 不存在的目录：报错但不抛
  const missing = migrate(join(tmp(), '不存在'))
  assert.ok(missing.errors.length > 0)
})

test('预演不落盘：inspect 只读，不建容器、不移文件', () => {
  const dir = mkLegacyTeam(tmp())
  const info = inspect(dir)
  assert.equal(info.legacyItems.length, 6)
  assert.equal(info.containerExists, false)
  assert.equal(existsSync(join(dir, TEAM_CONTAINER_DIR)), false, 'inspect 必须纯只读')
  assert.equal(existsSync(join(dir, 'team.json')), true)
})

test('迁移后必须提示重启（旧进程仍读团队根下的清单，会表现成"团队凭空消失"）', () => {
  const { restartNoticeLines } = require(join(ROOT, 'scripts', 'migrate-team-container.cjs'))

  // ① 检测到应用在运行 ⇒ 必须出现"重启"字样，并点明症状（否则用户不知为何团队变空）
  const running = restartNoticeLines([1234, 5678], true).join('\n')
  assert.match(running, /重启应用/, '必须明确要求重启')
  assert.match(running, /1234, 5678/, '应列出 PID 便于用户确认')
  assert.match(running, /成员显示为 0/, '应说明重启前的症状，否则用户会以为数据丢了')

  // ② 没检测到运行中的进程 ⇒ 说明下次启动即生效（不要无端吓唬用户）
  const idle = restartNoticeLines([], true).join('\n')
  assert.match(idle, /未检测到运行中的应用/)
  assert.doesNotMatch(idle, /请立即重启/)

  // ③ 什么都没搬动（如"无需迁移"或全部跳过）⇒ 不输出任何提示（避免噪音）
  assert.deepEqual(restartNoticeLines([1234], false), [])
  assert.deepEqual(restartNoticeLines([], false), [])
})
