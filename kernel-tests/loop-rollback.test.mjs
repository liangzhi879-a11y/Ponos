// loop 回滚：stash 保护 + reset --hard（P1-3）。回滚此前只登记审批、从不执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createLoopController } from '../kernel/loop.mjs'

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf-8' })).trim()
}
function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-rb-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'v1', 'utf-8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
function mkCtrl(dir, sessionId = 'sess-rb') {
  const configDir = join(dir, 'home')
  mkdirSync(configDir, { recursive: true })
  return createLoopController({
    wire: { loop: () => {}, warning: () => {}, system: () => {} },
    engine: { queueNext: () => {}, judgeUntil: async () => ({ done: false }) },
    store: null, configDir, sessionId, cwd: dir, env: {},
  })
}

// 并入对账（2026-10-09 四条线合并）：本文件是对着**同步版** snapshot() 写的（分支 777a6ff4
// 里它是 execFileSync）；主干 f857d6a9「三处同步 git 调用改真异步」后 snapshot() 变为
// 「打点即后台刷新、同步返回旧值」——首调必然返回空串，紧随其后的 rollback() 读到空引用即拒绝。
// 生产链路里 snapshot() 与 rollback() 隔着人工审批，刷新早已落地；测试必须显式等刷新落地。
// 顺便消掉一个 Windows 假红：在飞的 git 子进程以临时仓库为 cwd，finally 的 rmSync 会 EPERM
//（实测等它退出即恢复；maxRetries 对"活进程 cwd"一例实测不生效），会把真正的断言失败掩盖成环境错误。
async function snapshotLanded(c, ms = 3000) {
  c.snapshot() // 打点（触发后台刷新）；此刻的同步返回值必然还是旧值，不可用
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ref = String(c.status().snapshotRef || '')
    if (/^[0-9a-f]{7,40}$/i.test(ref)) return ref
    await new Promise((r) => setTimeout(r, 25))
  }
  return '' // 超时返回空串，交给用例照常断言红（不得静默放过）
}
// 清理属非断言面：只吞 Windows 句柄边角（EPERM/EBUSY/ENOTEMPTY 即 Node rm 文档所列可重试码），
// 其余错误照抛；临时目录残留可接受（同 disk-wait-wire / bash-timeout 等先例）。
function rmTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'ENOTEMPTY') throw e
  }
}

test('回滚：未提交改动被 stash 保护，工作区回到快照', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    const ref = await snapshotLanded(c)
    assert.ok(/^[0-9a-f]{7,40}$/i.test(ref), 'snapshot 应记录 HEAD sha')
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    writeFileSync(join(dir, 'new.txt'), 'untracked', 'utf-8')
    const reg = c.rollback()
    assert.equal(reg.needApproval, true)
    assert.equal(c.status().pendingApproval.kind, 'rollback')

    const r = c.applyPendingRollback()
    assert.equal(r.ok, true)
    assert.equal(r.applied, true)
    assert.equal(r.ref, ref)
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'v1', '已跟踪文件应回到快照')
    assert.equal(existsSync(join(dir, 'new.txt')), false, '未跟踪文件应被 stash -u 收走')
    const stashes = git(dir, ['stash', 'list'])
    assert.ok(stashes.includes(r.stashMsg), '改动应存在于 stash 中可找回')
    assert.equal(c.status().pendingApproval, null)
  } finally { rmTmp(dir) }
})

test('回滚记入 history（note 含 rollback:ref）', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    const ref = await snapshotLanded(c)
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    c.rollback()
    c.applyPendingRollback()
    const h = c.status().history
    assert.equal(h.length, 1)
    assert.equal(h[0].note, `rollback:${ref}`)
  } finally { rmTmp(dir) }
})

test('无 pendingApproval → 不执行任何动作', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir)
    c.start({ prompt: 'x', count: 3 })
    await snapshotLanded(c)
    const r = c.applyPendingRollback()
    assert.equal(r.applied, false)
  } finally { rmTmp(dir) }
})

test('非法快照引用 → 拒绝执行且不改工作区', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir, 'sess-rb2')
    c.start({ prompt: 'x', count: 3 })
    await snapshotLanded(c)
    c.rollback()
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    // 通过落盘文件把 detail 改坏（模拟状态文件被篡改），再 load 回来
    const f = join(dir, 'home', 'loop', 'sess-rb2.json')
    const raw = JSON.parse(readFileSync(f, 'utf-8'))
    raw.pendingApproval = { kind: 'rollback', detail: 'HEAD~1; rm -rf /' }
    writeFileSync(f, JSON.stringify(raw), 'utf-8')
    assert.equal(c.load(), true)
    const r = c.applyPendingRollback()
    assert.equal(r.ok, false)
    assert.equal(r.applied, false)
    assert.ok(String(r.error).includes('非法'), '错误信息应说明引用非法')
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'CHANGED', '拒绝执行时不得改动工作区')
    assert.equal(c.status().pendingApproval, null)
  } finally { rmTmp(dir) }
})

test('stash 失败（cwd 非 git 仓库）→ 中止回滚，不丢用户文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-nogit-'))
  const c = mkCtrl(dir, 'sess-nogit')
  try {
    // 手工构造一个"有快照引用但 cwd 不是 git 仓库"的状态：模拟仓库被移除/损坏
    const stDir = join(dir, 'home', 'loop')
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, 'sess-nogit.json'), JSON.stringify({
      version: 1, status: 'running', prompt: 'x', index: 1, count: 3,
      snapshotRef: 'abcdef1',
      pendingApproval: { kind: 'rollback', detail: 'abcdef1' },
      budget: { maxCostUsd: 0, maxSteps: 0, maxWallMs: 0 },
      noProgress: { streak: 0, lastFingerprint: '', threshold: 3 },
      history: [], usageAcc: {}, costUsd: 0, steps: 0, injections: [],
    }), 'utf-8')
    writeFileSync(join(dir, 'precious.txt'), 'do-not-lose', 'utf-8')
    assert.equal(c.load(), true)
    const r = c.applyPendingRollback()
    assert.equal(r.ok, false)
    assert.equal(r.applied, false)
    assert.ok(String(r.error).includes('git stash'), '错误信息应说明是改动保护失败')
    assert.equal(existsSync(join(dir, 'precious.txt')), true, '用户文件不得丢失')
    assert.equal(c.status().pendingApproval, null, '待审批状态应被清掉，不悬挂')
  } finally { rmTmp(dir) }
})

// 宽幅审查 M-4（真实信息缺陷）：工作树本来干净时 `git stash push` 的退出码同样是 0，
// 但**并未创建任何 stash**（stdout 为 "No local changes to save"）。修复前实现只按退出码
// 判定成功，于是回执会写"回滚前的改动已存入 stash「yf-loop-rollback-…」"——用户照此去
// `git stash pop` 会扑空。修法：按 git 的实际输出判定，未真创建则 stashMsg 置空。
test('M-4 工作树干净时回滚 → 不得谎报"改动已存入 stash"（未创建即须置空）', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir, 'sess-clean')
    c.start({ prompt: 'x', count: 3 })
    // 先等快照刷新落地（后台 persist 会写 home/，必须赶在 .gitignore 提交前完成）
    const ref = await snapshotLanded(c)
    // 夹具把配置目录建在仓库内（home/），而控制器会**持续**往里面落盘状态 ⇒ 树永远不干净。
    // 故先用 .gitignore 把 home/ 排除（git 的"干净"判定会忽略被 ignore 的路径，
    // 且 `stash push -u` 也不会把 ignored 文件收进 stash），才能构造出 M-4 要测的
    // "git stash 无事可做（No local changes to save）"这一真实场景。
    writeFileSync(join(dir, '.gitignore'), 'home/\n', 'utf-8')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'ignore-home'])
    assert.equal(git(dir, ['status', '--porcelain']), '', '前置条件：工作树必须干净')

    const reg = c.rollback()
    assert.equal(reg.needApproval, true)
    const r = c.applyPendingRollback()
    assert.equal(r.ok, true, '干净树回滚本身应当成功')
    assert.equal(r.applied, true)
    assert.equal(r.ref, ref)
    assert.equal(r.stashMsg, '', '未真的创建 stash 时不得回报 stash 名（否则用户 pop 扑空）')
    assert.equal(git(dir, ['stash', 'list']), '', '干净树回滚不得凭空产生 stash')
    assert.equal(existsSync(join(dir, 'a.txt')), true, '干净树回滚不得删文件')
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'v1')
  } finally { rmTmp(dir) }
})

test('M-4 反面对照：有未提交改动时仍必须回报 stash 名（修复不得过严）', async () => {
  const dir = mkRepo()
  try {
    const c = mkCtrl(dir, 'sess-dirty')
    c.start({ prompt: 'x', count: 3 })
    await snapshotLanded(c)
    writeFileSync(join(dir, 'a.txt'), 'CHANGED', 'utf-8')
    c.rollback()
    const r = c.applyPendingRollback()
    assert.equal(r.ok, true)
    assert.ok(r.stashMsg.length > 0, '确有改动时必须回报 stash 名供找回')
    assert.ok(git(dir, ['stash', 'list']).includes(r.stashMsg))
  } finally { rmTmp(dir) }
})
