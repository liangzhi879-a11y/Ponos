// 过程文件归集：**执行层**的正反例（待办 860）
// ---------------------------------------------------------------------------
// 纯判据/计划已由 `shared/process-artifacts.test.mjs` 钉住；本文件只测"真的碰磁盘时会不会
// 伤到用户"。风险全在反例上，故每条正例都配一条"不该动的东西绝不动"：
//   ① 归集：临时脚本被搬走 + 用户文件/子目录/已入库文件留在原地；
//   ② 回退：搬回来**逐字节一致**；原处已有文件时不覆盖；重复回退幂等；
//   ③ 关闭闸：git 跟踪态读不到 ⇒ **整批放弃**（宁可少清理）；
//   ④ 真进程接线：`--process collect|restore|list` 三个 op 在真 CLI 上真的通
//      （本仓最贵的假阴性是"flag 漏登记 ⇒ 静默忽略"，只有真进程能抓到）；
//   ⑤ 引擎真轮次：收尾轮自动归集（假端点 SSE，走完整 kernel 链路）。
// 隔离：一律 mkdtempSync，绝不碰真实仓库/用户目录。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { collectProcessArtifacts, restoreProcessArtifacts, readTrackedPaths, scanRootCandidates, listProcessPhases } from '../kernel/process-hygiene.mjs'
import { relProcessRoot } from '../shared/process-artifacts.mjs'

const KERNEL_CLI = fileURLToPath(new URL('../kernel/cli.mjs', import.meta.url))
const tmpDirs = []
const fixture = () => { const d = mkdtempSync(join(tmpdir(), 'proc-hyg-')); tmpDirs.push(d); return d }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* Windows 句柄竞态：临时目录残留不影响断言 */ } } })

/** 一个"像用户项目"的目录：既有过程物，也有用户交付物、子目录、点目录。 */
function mkProject({ extra = {} } = {}) {
  const dir = fixture()
  writeFileSync(join(dir, 'tmp-probe.mjs'), 'console.log(1)\n', 'utf-8')   // 过程物（该收）
  writeFileSync(join(dir, 'cache-age-probe.mjs'), 'x\n', 'utf-8')          // 过程物（该收）
  writeFileSync(join(dir, 'run.log'), 'log line\n', 'utf-8')               // 过程物（该收）
  writeFileSync(join(dir, 'README.md'), '# 用户的说明\n', 'utf-8')          // 交付物（绝不能动）
  writeFileSync(join(dir, 'index.ts'), 'export const a = 1\n', 'utf-8')    // 源码（绝不能动）
  writeFileSync(join(dir, '营业执照.jpg'), 'binary-ish\n', 'utf-8')         // 申报材料（绝不能动）
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'tmp-inner.mjs'), 'x\n', 'utf-8')         // 子目录里的过程物：**不下钻**
  mkdirSync(join(dir, '.hidden'), { recursive: true })
  writeFileSync(join(dir, '.hidden', 'keep.txt'), 'x\n', 'utf-8')
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, k), v, 'utf-8')
  return dir
}

// ---------------------------------------------------------------------------
// ① 归集：只搬过程物，用户的东西一个不动
// ---------------------------------------------------------------------------
test('归集：过程物搬进 .ponos/process/<阶段>/，用户文件与子目录留在原地', async () => {
  const dir = mkProject()
  const r = await collectProcessArtifacts({ projectRoot: dir, phase: '阶段1-勘察', source: 'unit-test', now: '2026-09-22T00:00:00.000Z' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.collected.map((c) => c.from).sort(), ['cache-age-probe.mjs', 'run.log', 'tmp-probe.mjs'])
  const phaseDir = join(dir, '.ponos', 'process', '阶段1-勘察')
  for (const n of ['tmp-probe.mjs', 'cache-age-probe.mjs', 'run.log']) {
    assert.ok(existsSync(join(phaseDir, n)), `${n} 应已归集`)
    assert.ok(!existsSync(join(dir, n)), `${n} 不应还留在项目根`)
  }
  // ★ 反例：用户的东西**一个都不能动**（含子目录里的同名形态文件）
  for (const p of ['README.md', 'index.ts', '营业执照.jpg', 'src/tmp-inner.mjs', '.hidden/keep.txt']) {
    assert.ok(existsSync(join(dir, ...p.split('/'))), `${p} 必须原地不动`)
  }
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf-8'), '# 用户的说明\n', '内容逐字节未变')
  // 账本与索引
  const manifest = JSON.parse(readFileSync(join(phaseDir, 'manifest.json'), 'utf-8'))
  assert.equal(manifest.entries.length, 3)
  assert.equal(manifest.entries[0].status, 'collected')
  assert.match(manifest.entries[0].sha256, /^[0-9a-f]{64}$/, '账本必须记内容哈希（回退可比对）')
  const md = readFileSync(join(phaseDir, 'INDEX.md'), 'utf-8')
  assert.match(md, /tmp-probe\.mjs/)
  // 未归集项**按原因汇总计数**（不逐条列名）：INDEX 是给人一眼看懂的摘要，不是用户文件的
  // 全量清单——逐条列名会把"用户有哪些文件"印进一个随会话生成的文档里。逐条明细在
  // manifest.json 的 skipped 里（机器可读，需要时再查）。
  assert.match(md, /\| not-artifact \| 3 \|/, '未归集表要能解释"为什么没动 README.md 这类文件"')
  assert.match(md, /用户的正常文件/)
  const manifestSkipped = JSON.parse(readFileSync(join(phaseDir, 'manifest.json'), 'utf-8')).skipped
  assert.ok(manifestSkipped.some((s) => s.path === 'README.md' && s.reason === 'not-artifact'), '逐条明细在 manifest 里')
})

test('归集：自带 .gitignore（内容 *）⇒ 不污染用户的 git status', async () => {
  const dir = mkProject()
  await collectProcessArtifacts({ projectRoot: dir, phase: 'p' })
  const ig = join(dir, '.ponos/process/.gitignore')
  assert.ok(existsSync(ig), '必须有自带 ignore（否则用户 git status 里会多出这棵目录）')
  assert.equal(readFileSync(ig, 'utf-8').includes('*'), true)
  // 真 git 效果：未跟踪文件里不得出现 .yfworking
  try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }) } catch { return }
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  assert.ok(!st.includes('.ponos'), `git status 里不该出现归集目录：${st}`)
})

test('归集：没有可归集的文件时不建目录、不写空账本（空目录本身就是垃圾）', async () => {
  const dir = fixture()
  writeFileSync(join(dir, 'README.md'), 'x\n', 'utf-8')
  const r = await collectProcessArtifacts({ projectRoot: dir, phase: 'p' })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'nothing-to-collect')
  assert.equal(r.collected.length, 0)
  assert.ok(!existsSync(join(dir, '.ponos')), '不该为了"什么都没收"而造出隐藏目录')
})

test('归集：重复执行幂等（第二次没有可搬的，账本不重复登记）', async () => {
  const dir = mkProject()
  await collectProcessArtifacts({ projectRoot: dir, phase: 'p', now: 't1' })
  const before = JSON.parse(readFileSync(join(dir, '.ponos/process/p/manifest.json'), 'utf-8'))
  // 归集目录里又被塞回一个同名文件 → 第二次必须**跳过不覆盖**
  writeFileSync(join(dir, 'tmp-probe.mjs'), 'new content\n', 'utf-8')
  const r2 = await collectProcessArtifacts({ projectRoot: dir, phase: 'p', now: 't2' })
  assert.equal(r2.collected.length, 0)
  assert.equal(r2.skipped.find((s) => s.path === 'tmp-probe.mjs')?.reason, 'target-exists')
  const after = JSON.parse(readFileSync(join(dir, '.ponos/process/p/manifest.json'), 'utf-8'))
  assert.equal(after.entries.length, before.entries.length, '同一文件不得重复登记')
  assert.equal(readFileSync(join(dir, '.ponos/process/p/tmp-probe.mjs'), 'utf-8'), 'console.log(1)\n', '已归集的文件内容不得被覆盖')
})

test('归集：只扫描项目根一层（子目录绝不进候选）', async () => {
  const dir = mkProject()
  const names = scanRootCandidates(dir)
  assert.ok(!names.some((n) => n.includes('/') || n.includes('\\')), '候选只能是裸文件名')
  assert.ok(!names.includes('src'), '目录不得进候选')
  assert.ok(names.includes('tmp-probe.mjs'))
})

// ---------------------------------------------------------------------------
// ② 回退：逐字节一致、不覆盖、幂等
// ---------------------------------------------------------------------------
test('回退：文件搬回原处且内容一致；账本标记 restored', async () => {
  const dir = mkProject()
  await collectProcessArtifacts({ projectRoot: dir, phase: 'p', now: 't1' })
  const r = restoreProcessArtifacts({ projectRoot: dir, phase: 'p', now: 't2' })
  assert.equal(r.ok, true)
  assert.equal(r.restored.length, 3)
  assert.equal(readFileSync(join(dir, 'tmp-probe.mjs'), 'utf-8'), 'console.log(1)\n', '回退必须逐字节一致')
  assert.equal(readFileSync(join(dir, 'run.log'), 'utf-8'), 'log line\n')
  assert.ok(!existsSync(join(dir, '.ponos/process/p/tmp-probe.mjs')), '归集副本应已移走（不是复制）')
  const manifest = JSON.parse(readFileSync(join(dir, '.ponos/process/p/manifest.json'), 'utf-8'))
  assert.ok(manifest.entries.every((e) => e.status === 'restored' && e.restoredAt === 't2'))
  // 幂等：再回退一次 → 什么都没得回退，且不报错
  const r2 = restoreProcessArtifacts({ projectRoot: dir, phase: 'p' })
  assert.equal(r2.restored.length, 0)
  assert.ok(r2.skipped.every((s) => s.reason === 'already-restored'))
  assert.equal(readFileSync(join(dir, 'tmp-probe.mjs'), 'utf-8'), 'console.log(1)\n', '幂等回退不得动已回退的文件')
})

test('★ 回退：原处已有同名文件 ⇒ 跳过不覆盖（绝不丢数据）', async () => {
  const dir = mkProject()
  await collectProcessArtifacts({ projectRoot: dir, phase: 'p' })
  writeFileSync(join(dir, 'tmp-probe.mjs'), '用户新写的，不能被覆盖\n', 'utf-8')
  const r = restoreProcessArtifacts({ projectRoot: dir, phase: 'p' })
  assert.ok(!r.restored.some((x) => x.from === 'tmp-probe.mjs'))
  assert.equal(r.skipped.find((s) => s.from === 'tmp-probe.mjs')?.reason, 'origin-exists')
  assert.equal(readFileSync(join(dir, 'tmp-probe.mjs'), 'utf-8'), '用户新写的，不能被覆盖\n', '用户的新文件必须原样保留')
  assert.ok(existsSync(join(dir, '.ponos/process/p/tmp-probe.mjs')), '归集副本仍在（没被删）')
})

test('回退：没有账本 → 明确拒绝（不假装成功）', async () => {
  const dir = mkProject()
  const r = restoreProcessArtifacts({ projectRoot: dir, phase: '不存在' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'manifest-missing')
})

// ---------------------------------------------------------------------------
// ③ git 跟踪态：读不到 ⇒ 整批放弃（"宁可少清理"的核心分支）
// ---------------------------------------------------------------------------
test('git：非仓库 → 正常继续（没有"已跟踪"概念）', async () => {
  const dir = mkProject()
  const g = await readTrackedPaths(dir)
  assert.equal(g.isRepo, false)
  assert.equal(g.ok, true)
})

test('★ git：已入库的过程物**不动**（动了就毁用户的 diff）', async () => {
  const dir = mkProject()
  try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }) } catch { return } // 环境无 git：跳过（不假装通过）
  execFileSync('git', ['add', 'tmp-probe.mjs'], { cwd: dir, stdio: 'ignore' })  // 只需入索引，不必提交
  const g = await readTrackedPaths(dir)
  assert.equal(g.isRepo, true)
  assert.equal(g.ok, true)
  assert.ok(g.tracked.has('tmp-probe.mjs'), '暂存态即视为"已跟踪"')
  const r = await collectProcessArtifacts({ projectRoot: dir, phase: 'p' })
  assert.ok(!r.collected.some((c) => c.from === 'tmp-probe.mjs'), '已跟踪文件绝不能被搬走')
  assert.equal(r.skipped.find((s) => s.path === 'tmp-probe.mjs')?.reason, 'git-tracked')
  assert.ok(existsSync(join(dir, 'tmp-probe.mjs')))
  // 未跟踪的过程物照常归集（证明闸门是"按文件判"，不是"有仓库就全放弃"）
  assert.ok(r.collected.some((c) => c.from === 'run.log'))
})

test('★ git：仓库内但跟踪态读失败 ⇒ 整批放弃（绝不在不确定时搬文件）', async () => {
  const dir = mkProject()
  try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }) } catch { return }
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  // 破坏索引 ⇒ `git ls-files` 必然失败（模拟 dubious ownership / 索引损坏这类"读不到跟踪态"）
  writeFileSync(join(dir, '.git', 'index'), 'not-a-real-index', 'utf-8')
  const g = await readTrackedPaths(dir)
  assert.equal(g.ok, false, `索引损坏时应报"读不到"：${g.reason}`)
  const r = await collectProcessArtifacts({ projectRoot: dir, phase: 'p' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /git-ls-files-failed/)
  assert.equal(r.collected.length, 0, '不确定时一个文件都不许动')
  assert.ok(existsSync(join(dir, 'tmp-probe.mjs')), '整批放弃 ⇒ 文件全在原地')
  assert.ok(!existsSync(join(dir, '.ponos')), '放弃时连目录都不该建')
})

// ---------------------------------------------------------------------------
// ④ 红线：本机制**从不删除**
// ---------------------------------------------------------------------------
test('★ 执行层源码里不得出现任何删除调用（"清理"= 挪走留账，不是销毁）', async () => {
  const src = readFileSync(fileURLToPath(new URL('../kernel/process-hygiene.mjs', import.meta.url)), 'utf8')
  for (const bad of ['unlinkSync', 'rmSync', 'rmdirSync', 'unlink(', 'rm -rf', 'del /', 'Remove-Item']) {
    assert.ok(!src.includes(bad), `不得出现删除调用：${bad}`)
  }
  assert.match(src, /renameSync/, '搬运用 rename（同盘原子），而不是复制+删除')
})

// ---------------------------------------------------------------------------
// ⑤ 真进程：--process 三个 op（抓"flag 漏登记 ⇒ 静默忽略"）
// ---------------------------------------------------------------------------
function runProcessCli(args, cwd) {
  const out = execFileSync(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PONOS_CONFIG_DIR: cwd, PONOS_HOME: cwd }, timeout: 60_000, windowsHide: true,
  })
  return JSON.parse(out.trim().split('\n').pop())
}

test('真进程：collect → list → restore 三 op 都生效（含 --phase 转发）', async () => {
  const dir = mkProject()
  const c = runProcessCli(['--process', 'collect', '--phase', '阶段9-真进程', '--add-dir', dir], dir)
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.deepEqual(c.collected.map((x) => x.from).sort(), ['cache-age-probe.mjs', 'run.log', 'tmp-probe.mjs'])
  assert.ok(existsSync(join(dir, '.ponos/process/阶段9-真进程/tmp-probe.mjs')))
  const l = runProcessCli(['--process', 'list', '--add-dir', dir], dir)
  assert.equal(l.processDir, relProcessRoot())
  assert.deepEqual(l.phases.map((p) => p.phase), ['阶段9-真进程'], 'list 必须列出已归集阶段')
  assert.equal(l.phases[0].collected, 3)
  const r = runProcessCli(['--process', 'restore', '--phase', '阶段9-真进程', '--add-dir', dir], dir)
  assert.equal(r.restored.length, 3)
  assert.ok(existsSync(join(dir, 'tmp-probe.mjs')))
})

test('真进程：未知 op 报错 code=1（不静默当成"没有这个功能"）', async () => {
  const dir = mkProject()
  const proc = spawn(process.execPath, [KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--process', 'nope', '--add-dir', dir], {
    cwd: dir, env: { ...process.env, PONOS_CONFIG_DIR: dir, PONOS_HOME: dir },
  })
  let out = ''
  proc.stdout.on('data', (d) => { out += d })
  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => {
      try {
        const j = JSON.parse(out.trim().split('\n').pop())
        assert.equal(code, 1)
        assert.match(j.error, /unknown process op/)
        resolve()
      } catch (e) { reject(e) }
    })
  })
})

// ---------------------------------------------------------------------------
// ⑥ 提示词**真的进了请求**（PONOS_MOCK_SYS_PROBE：系统提示不落盘，这是唯一的端到端口子）
// ---------------------------------------------------------------------------
/**
 * 跑一个真内核进程，问一句 SYS_PROBE 探针，取回 `<bit 串>`。
 *
 * 必须按**事件聚合**再正则（本仓 chat-mode.test.mjs 的既有教训）：mock 会把长文本切成
 * 多个 text 块（`SYS_P` / `ROBE:` / `111`），在 raw stdout 上正则拼不出完整的 bit 串。
 */
async function probeSystemPrompt({ needles, extraArgs = [] }) {
  const dir = fixture()
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir, ...extraArgs,
  ], {
    cwd: dir,
    env: { ...process.env, PONOS_MOCK_API: '1', PONOS_MOCK_SYS_PROBE: needles.join('|'), PONOS_CONFIG_DIR: dir, PONOS_HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let raw = ''
  proc.stdout.on('data', (d) => {
    raw += d
    buf += d
    const lines = buf.split(String.fromCharCode(10))
    buf = lines.pop()
    for (const line of lines) { if (!line.trim()) continue; try { events.push(JSON.parse(line)) } catch { /* 脏行 */ } }
  })
  try {
    // 等 init 再发消息（与 chat-mode.test.mjs 同款：否则消息可能与内核启动竞态）
    const t0 = Date.now()
    while (Date.now() - t0 < 20_000 && !events.some((e) => e.type === 'system' && e.subtype === 'init')) await sleep(20)
    proc.stdin.write(JSON.stringify({ type: 'user', session_id: 'sys-probe', message: { role: 'user', content: '探针' } }) + String.fromCharCode(10))
    const t1 = Date.now()
    while (Date.now() - t1 < 30_000) {
      const text = events.filter((e) => e.type === 'assistant')
        .map((e) => (e.message?.content || []).map((b) => (b?.type === 'text' ? b.text : '')).join('')).join('')
      const bits = (text.match(/SYS_PROBE:([01]+)/) || [])[1]
      if (bits) return bits
      await sleep(30)
    }
    return null
  } finally { try { proc.kill() } catch { /* 已退出 */ } }
}

test('★ 提示词真的进了系统提示（任务模式），且 chat 模式不注入', async () => {
  const bits = await probeSystemPrompt({ needles: ['【过程文件纪律（阶段收尾）】', '.ponos/process/', '交付物与过程物分开'] })
  assert.equal(bits, '111', `任务模式的系统提示必须含过程文件纪律段（实际 bits=${bits}）`)
  const chatBits = await probeSystemPrompt({ needles: ['.ponos/process'], extraArgs: ['--session-mode', 'chat'] })
  assert.equal(chatBits, '0', `chat 模式不得注入本地文件纪律（无本地工具，注了只会诱导它承诺做不到的事）；实际 bits=${chatBits}`)
})

// ---------------------------------------------------------------------------
// ⑥ 引擎真轮次：收尾轮自动归集（假 Anthropic 端点 SSE，走完整内核链路）
// ---------------------------------------------------------------------------
test('★ 引擎真轮次：模型写过程物 → 收尾语 → 自动归集进 .ponos/process/', async () => {
  const dir = mkProject()
  writeFileSync(join(dir, 'tmp-probe.mjs'), 'console.log(1)\n', 'utf-8')
  const SESSION = 'prochy000-0000-0000-0000-000000000001'
  const api = await startScriptedApi()
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--resume', SESSION, '--add-dir', dir,
  ], {
    cwd: dir,
    env: {
      ...process.env,
      PONOS_MOCK_API: '',                          // 走真实 HTTP 路径（假端点在本地）
      PONOS_BASE_URL: `http://127.0.0.1:${api.port}`,
      PONOS_AUTH_TOKEN: 'test-token',
      PONOS_MODEL: 'test-model',
      PONOS_CONFIG_DIR: dir,
      PONOS_HOME: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  let stderr = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) { if (!line.trim()) continue; try { events.push(JSON.parse(line)) } catch { /* 脏行 */ } }
  })
  proc.stderr.on('data', (d) => { stderr += d })
  try {
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '生成一份临时脚本并收尾。' } }) + '\n')
    // 等待 result 事件 —— 归集在 `wire.result` **之前**执行，故 result 到达即归集已完成
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000 && !events.some((e) => e.type === 'result')) await sleep(50)
    assert.ok(events.some((e) => e.type === 'result'), `内核未发出 result 事件；stderr=${stderr.slice(-500)}`)
    const phaseDir = join(dir, '.ponos', 'process', `session-${SESSION.slice(0, 8)}`)
    assert.ok(existsSync(join(phaseDir, 'tmp-probe.mjs')), `收尾轮应把 tmp-probe.mjs 归集；stderr=${stderr.slice(-500)}`)
    assert.ok(existsSync(join(phaseDir, 'manifest.json')))
    assert.ok(existsSync(join(phaseDir, 'INDEX.md')))
    assert.ok(!existsSync(join(dir, 'tmp-probe.mjs')), '归集后项目根不该还留着它')
    // ★ 反例：用户文件仍在原处
    assert.ok(existsSync(join(dir, 'README.md')))
    assert.ok(existsSync(join(dir, 'src', 'tmp-inner.mjs')), '子目录里的东西不该被下钻归集')
    assert.match(stderr, /\[process-hygiene\]/, '应有一行结构化日志留痕（可观测）')
  } finally {
    try { proc.kill() } catch { /* 已退出 */ }
    await api.close()
  }
})

/**
 * 假 Anthropic 端点：第 1 轮让模型写一个 `tmp-probe.mjs`（真工具调用），
 * 第 2 轮（历史里已有 tool_result）给一句**收尾语**——这正是"阶段完成"的形态。
 */
async function startScriptedApi({ closeout = true } = {}) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 非 JSON */ }
      const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      const hasToolResult = JSON.stringify(body.messages || []).includes('tool_result')
      if (!hasToolResult) {
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在写临时脚本。' } })
        sse({ type: 'content_block_stop', index: 0 })
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_proc_1', name: 'Write', input: {} } })
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'tmp-probe-out.mjs', content: 'x\n' }) } })
        sse({ type: 'content_block_stop', index: 1 })
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      } else {
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        // 收尾语 vs 非收尾语：唯一区别就是这一句（`isClosedOut` 的判据）。
        const finalText = closeout ? '已完成：本阶段交付物已生成，过程脚本已归集。' : '我把脚本写到项目里了，还未收尾。'
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } })
        sse({ type: 'content_block_stop', index: 0 })
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      }
      sse({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

test('引擎真轮次：非收尾轮**不**归集（避免误搬用户文件）', async () => {
  const dir = mkProject()
  const api = await startScriptedApi({ closeout: false })
  const proc = spawn(process.execPath, [
    KERNEL_CLI, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions', '--add-dir', dir,
  ], {
    cwd: dir,
    env: {
      ...process.env, PONOS_MOCK_API: '', PONOS_BASE_URL: `http://127.0.0.1:${api.port}`,
      PONOS_AUTH_TOKEN: 'test-token', PONOS_MODEL: 'test-model', PONOS_CONFIG_DIR: dir, PONOS_HOME: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) { if (!line.trim()) continue; try { events.push(JSON.parse(line)) } catch { /* 脏行 */ } }
  })
  try {
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '随手跑一下。' } }) + '\n')
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000 && !events.some((e) => e.type === 'result')) await sleep(50)
    assert.ok(events.some((e) => e.type === 'result'))
    assert.ok(!existsSync(join(dir, '.ponos')), '非收尾轮不得建归集目录（模型没说"完成"就不该动文件）')
    assert.ok(existsSync(join(dir, 'tmp-probe.mjs')) && existsSync(join(dir, 'run.log')))
  } finally {
    try { proc.kill() } catch { /* 已退出 */ }
    await api.close()
  }
})
