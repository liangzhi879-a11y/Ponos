// server/collab-routes.test.mjs —— `/file-collab/conflict` 的**路由级**端到端（含真实团队库）
// ---------------------------------------------------------------------------
// 与 `server/office-merge-exec.test.mjs` 的分工：那个测的是**编排层**（注入桩/夹具直接调 executeOfficeMerge）；
// 这个测的是**整条路由**：handleCollabRoute 收到 edit-merge ⇒ 真实团队库取版本 ⇒ 真实读盘/合并/落盘。
// 存在的理由：编排层对了，不代表接线对了 —— 路由参数、会话/团队解析、office 出口注入、
// 前端拿到的 body 形状，都是只有"从路由入口跑一遍"才能覆盖的失败点。本次接线正是靠这一层
// 才敢说"用户点那个按钮真的会落盘"。
//
// 团队库是真的（`createTeam` + `ingestFile` + `putBlob`），只有"三个版本的字节"是构造的：
//   · base   = 夹具原样，**从盘上 ingest 进团队库**（于是 currentPathOf 能定位到它）
//   · mine   = base + 改第 5 段（putBlob，代表"我这边的版本"）
//   · theirs = base + 改第 9 段，**同时写入磁盘**（团队库 blob 也放一份，供冲突判定用）
// 磁盘上那份就是 theirs —— 这正是运行时的真实情形（共享目录里的文件就是"别人已提交的状态"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTeam } from '../kernel/team-store.mjs'
import { ensureCollabDirs, ingestFile, putBlob } from '../kernel/file-collab.mjs'
import { resolveReadable, resolveWritable, assertSizeOk } from '../shared/fs-guard.mjs'
import { resolvePython } from '../kernel/knowledge-import.mjs'
import { createOfficeAccess } from './office-routes.mjs'
import { handleCollabRoute } from './collab-routes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, 'office-fixtures', 'tools')
const FIXTURE = join(HERE, 'office-fixtures', 'base.docx')

const TMPROOT = mkdtempSync(join(tmpdir(), 'yfw-collab-route-'))
process.on('exit', () => { try { rmSync(TMPROOT, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })

let seq = 0
const runPy = (script, args) => spawnSync(resolvePython(), [script, ...args], { encoding: 'utf-8' })
const mutate = (p, idx, text) => {
  const r = runPy(join(TOOLS, 'docx_mutate_probe.py'), ['set-text', p, String(idx), text])
  assert.equal(r.status, 0, r.stderr || r.stdout)
}
const sha = (p) => readFileSync(p).toString('base64').slice(0, 48) + ':' + readFileSync(p).length

/**
 * 搭一个真实的团队库 + 磁盘上的共享文件。
 * @param {'differ'|'conflict'} mode  theirs 与 mine 改**不同段**（可自动合并）还是**同一段**（真冲突）
 * @param {string} ext  目标文件扩展名（`.txt` 用来测"非 office 模态"——注意必须是**真实入库的文件名**：
 *                      运行时模态以 `currentPathOf` 读到的文件名为准，客户端传的 logicalName 只是兜底）
 */
function sandbox (mode, ext = '.docx') {
  const tag = `r${++seq}`
  const root = join(TMPROOT, tag)
  const configDir = join(root, 'config')
  const teamRoot = join(root, 'team')
  const diskDir = join(root, 'shared')
  for (const d of [configDir, teamRoot, diskDir]) ensureCollabDirs(d)
  const team = createTeam({ configDir, name: `T-${tag}`, dir: teamRoot })
  assert.equal(team.ok, true, JSON.stringify(team))

  const target = join(diskDir, `doc-${tag}${ext}`)
  const isOffice = ext === '.docx'
  if (isOffice) copyFileSync(FIXTURE, target)
  else writeFileSync(target, `base-${tag}\nline2\n`)
  const baseIngest = ingestFile({ teamRoot, absPath: target })
  assert.equal(baseIngest.ok, true, JSON.stringify(baseIngest))

  // mine：base + 我的改动
  const minePath = join(root, `mine-${tag}${ext}`)
  if (isOffice) {
    copyFileSync(FIXTURE, minePath)
    mutate(minePath, 5, `MINE-${tag}`)
  } else {
    writeFileSync(minePath, `mine-${tag}\nline2\n`)
  }
  const mineV = putBlob(teamRoot, readFileSync(minePath))
  assert.match(mineV.versionId, /^[0-9a-f]{64}$/, 'putBlob 应返回内容寻址的 versionId')

  // theirs：改第 9 段（differ）或第 5 段（conflict），并让它成为**磁盘当前内容**
  if (isOffice) copyFileSync(FIXTURE, target)
  if (isOffice) mutate(target, mode === 'conflict' ? 5 : 9, mode === 'conflict' ? `THEIRS-SAME-${tag}` : `THEIRS-${tag}`)
  else writeFileSync(target, `theirs-${tag}\nline2\n`)
  const theirsV = putBlob(teamRoot, readFileSync(target))
  assert.match(theirsV.versionId, /^[0-9a-f]{64}$/)

  return {
    tag, configDir, teamRoot, diskDir, target,
    teamId: team.teamId,
    fileId: baseIngest.fileId,
    versionIds: { base: baseIngest.versionId, mine: mineV.versionId, theirs: theirsV.versionId },
  }
}

const officeFor = (diskDir) => createOfficeAccess({
  sep,
  roots: { read: [diskDir], write: [diskDir], writeDeny: [], credentials: [] },
  guard: { resolveReadable, resolveWritable, assertSizeOk, findPythonExe: () => resolvePython() },
})

/** 走真实路由（与 bridge.mjs 的调用形状一致） */
const callConflict = (sb, body, { withOffice = true } = {}) => handleCollabRoute({
  method: 'POST',
  pathname: '/file-collab/conflict',
  searchParams: new URLSearchParams(),
  body: {
    teamId: sb.teamId,
    fileId: sb.fileId,
    logicalName: 'base.docx',
    baseVersionId: sb.versionIds.base,
    mineVersionId: sb.versionIds.mine,
    theirsVersionId: sb.versionIds.theirs,
    ...body,
  },
  sep,
  configDir: sb.configDir,
  findPythonExe: () => resolvePython(),
  ...(withOffice ? { office: officeFor(sb.diskDir) } : {}),
})

const readBlocks = async (p) => {
  const r = await officeFor(dirname(p)).readDocx(p)
  assert.equal(r.body?.ok, true, JSON.stringify(r.body))
  return r.body.blocks.map((b) => b.text || '').join('\n')
}

test('路由 e2e：edit-merge ⇒ 真的读团队库、真的合并、真的写回磁盘（两处改动都在）', async () => {
  const sb = sandbox('differ')
  const res = await callConflict(sb, { choice: 'edit-merge' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
  assert.ok(res.body.merge, 'edit-merge 必须带回 merge 结果（前端据此提示）')
  assert.equal(res.body.merge.ok, true, JSON.stringify(res.body.merge))
  assert.equal(res.body.merge.written, true, '应当真的落盘')
  assert.ok(res.body.merge.ops > 0)

  // **读回磁盘**确认（不信返回值；这是本轮唯一能证明"用户点按钮真的有效"的断言）
  const text = await readBlocks(sb.target)
  assert.match(text, new RegExp(`MINE-${sb.tag}`), '我这边的改动没合进去')
  assert.match(text, new RegExp(`THEIRS-${sb.tag}`), '磁盘那份的改动丢了')
})

test('路由 e2e：真冲突 ⇒ 报 conflict + 未落盘（磁盘字节不变）', async () => {
  const sb = sandbox('conflict')
  const before = sha(sb.target)
  const res = await callConflict(sb, { choice: 'edit-merge' })
  assert.equal(res.body.ok, false, '有冲突就不该报 ok')
  assert.equal(res.body.merge.reason, 'conflict')
  assert.ok(res.body.merge.conflicts.length >= 1, '必须把冲突明细带回前端（供逐处决定）')
  assert.equal(sha(sb.target), before, '有冲突时一个字节都不能改')
})

test('路由：未注入 office 出口时退回旧行为（只回报动作，不假装已合并）', async () => {
  const sb = sandbox('differ')
  const before = sha(sb.target)
  const res = await callConflict(sb, { choice: 'edit-merge' }, { withOffice: false })
  assert.equal(res.status, 200)
  assert.equal(res.body.action, 'merge-then-write', '决策仍照常回报')
  assert.equal(res.body.merge, undefined, '没接线时不得凭空给出 merge 结果')
  assert.equal(res.body.bytes, 0)
  assert.equal(sha(sb.target), before, '没接线时不该动文件')
})

test('路由：其它 choice 不受影响（use-mine / save-copy 照旧走原逻辑）', async () => {
  const sb = sandbox('differ')
  const mine = await callConflict(sb, { choice: 'use-mine' })
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.equal(mine.body.merge, undefined, '非 edit-merge 不触发合并')
  assert.ok(mine.body.bytes > 0, 'use-mine 应带回内容字节数')

  const copy = await callConflict(sb, { choice: 'save-copy' })
  assert.equal(copy.status, 200, JSON.stringify(copy.body))
  assert.equal(copy.body.action, 'save-draft')
  assert.equal(copy.body.merge, undefined)
})

test('路由：非 office 文件（真实入库的 .txt）⇒ 明确回报不支持，不假装成功', async () => {
  const sb = sandbox('differ', '.txt')
  const before = sha(sb.target)
  const res = await callConflict(sb, { choice: 'edit-merge' })
  // 本模块约定：`ok:false` 一律落到 400（唯一的例外见文件末尾的 unknown-endpoint → 404 用例）
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(res.body.ok, false)
  assert.equal(res.body.merge.reason, 'unsupported-modality')
  assert.equal(sha(sb.target), before, '不支持模态时不得动文件')
})

test('路由：模态以**入库的真实文件名**为准，不采信客户端传的 logicalName', async () => {
  // 这是刻意的安全取向：若按客户端传的名字挑合并算法，改个请求体就能让服务端用错误的算法
  // 处理真文件（例如把 .docx 说成 .txt）。故入库文件名优先。
  const sb = sandbox('differ') // 真实入库的是 docx
  const res = await callConflict(sb, { choice: 'edit-merge', logicalName: 'note.txt' })
  assert.equal(res.body.ok, true, '应按真实文件（docx）正常合并，而不是被伪造的名字带偏')
  assert.equal(res.body.merge.modality, 'docx')
  assert.equal(res.body.merge.written, true)
})

test('路由边界：/file-collab/ 前缀内未知端点 → 404；前缀外 → null（交回 bridge 继续派发）', async () => {
  const sb = sandbox('differ')
  const args = {
    method: 'GET', searchParams: new URLSearchParams(),
    body: null, sep, configDir: sb.configDir, findPythonExe: () => resolvePython(),
  }
  const unknown = await handleCollabRoute({ ...args, pathname: '/file-collab/not-a-route' })
  assert.equal(unknown.status, 404, '前缀内未知端点要明确 404，而不是静默 null（否则会被当成"不是本模块的事"继续派发）')
  assert.equal(unknown.body.code, 'unknown-endpoint')

  const outside = await handleCollabRoute({ ...args, pathname: '/not-collab' })
  assert.equal(outside, null, '前缀外的路径必须返回 null，交回 bridge 继续派发')
})
