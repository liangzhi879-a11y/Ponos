#!/usr/bin/env node
// SWE-bench 任务导入：从 data/swebench-verified.json 筛选实例 → tasks/SWE###-<instance>/
// ---------------------------------------------------------------------------
// 每个任务生成：
//   task.json   —— 平台元数据（base=外部仓库 commit、repo 指向 vendors/swebench-repos/、
//                   swebench 标记、patchBefore=test.patch）
//   prompt.md   —— 喂给 agent 的问题描述（problem_statement + 环境/验收说明）
//   verify.mjs  —— 验收：应用 test.patch → 跑 FAIL_TO_PASS（修复后应通过）+
//                   PASS_TO_PASS 抽查（不回归）
//   test.patch  —— 官方测试补丁（FAIL_TO_PASS 测试的载体，agent 修复后应通过）
//
// 用法：
//   node benchmark/scripts/swebench-import.mjs --list               # 列出候选
//   node benchmark/scripts/swebench-import.mjs --limit 6            # 默认 sympy 轻量子集
//   node benchmark/scripts/swebench-import.mjs --repo sympy --limit 6
//   node benchmark/scripts/swebench-import.mjs --ids sympy__sympy-19495,sympy__sympy-18763
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const dataFile = join(root, 'data', 'swebench-verified.json')
const tasksDir = join(root, 'tasks')
const reposDir = join(root, 'vendors', 'swebench-repos')

const argv = process.argv.slice(2)
function argVal(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}

const instances = JSON.parse(readFileSync(dataFile, 'utf8'))

// —— 轻量子集筛选：纯 Python、依赖极少、单一测试文件、FAIL_TO_PASS 少 ——
// 首批覆盖 sympy（首选）+ requests + flask + pytest + pylint，全为 pip 可装的
// 纯 Python 项目，Windows 环境可复现 SWE-bench 官方 FAIL_TO_PASS 语义。
const LIGHT_REPOS = ['sympy/sympy', 'psf/requests', 'pallets/flask', 'pytest-dev/pytest', 'pylint-dev/pylint']

/** 计算任务难度评分（低 = 简单）：测试数 + 补丁行数 + 依赖量 */
function difficulty(inst) {
  const testLines = (inst.test_patch || '').split('\n').filter((l) => l.startsWith('+')).length
  return (inst.FAIL_TO_PASS || []).length * 2 + Math.min(Math.floor(testLines / 20), 5)
}

function pickCandidates(repoFilter) {
  const cands = instances
    .filter((i) => LIGHT_REPOS.includes(i.repo))
    .filter((i) => (i.FAIL_TO_PASS || []).length <= 3)
    .filter((i) => !repoFilter || i.repo === repoFilter)
  return cands.sort((a, b) => difficulty(a) - difficulty(b))
}

function listCandidates() {
  for (const repo of LIGHT_REPOS) {
    const cands = pickCandidates(repo)
    console.log(`\n## ${repo}（${cands.length} 候选）`)
    for (const c of cands.slice(0, 8)) {
      console.log(`  ${c.instance_id}  diff=${c.difficulty || '?'}  ftp=${(c.FAIL_TO_PASS || []).length}  base=${c.base_commit.slice(0, 8)}`)
    }
  }
}

/** 一个实例生成一个任务目录 */
function importInstance(inst, seq) {
  const id = `SWE${String(seq).padStart(3, '0')}`
  const short = inst.instance_id.replace(/[^\w-]/g, '_')
  const dir = join(tasksDir, `${id}-${short}`)
  mkdirSync(dir, { recursive: true })
  const repoName = inst.repo.split('/')[1]
  const repoPath = join(reposDir, repoName)

  // 1. task.json：base 为外部仓库 commit，repo 指向 vendors 下的克隆
  const taskJson = {
    id,
    title: `SWE-bench: ${inst.repo} — ${inst.problem_statement.split('\n')[0].slice(0, 80)}`,
    type: 'swebench',
    difficulty: difficulty(inst),
    base: inst.base_commit,
    repo: repoPath,
    patchBefore: 'test.patch',
    swebench: {
      instance: inst.instance_id,
      repo: inst.repo,
      baseCommit: inst.base_commit,
      failToPass: inst.FAIL_TO_PASS,
      passToPassCount: (inst.PASS_TO_PASS || []).length,
    },
  }

  writeFileSync(join(dir, 'task.json'), JSON.stringify(taskJson, null, 2))

  // 2. test.patch：官方测试补丁（验收时应用）
  writeFileSync(join(dir, 'test.patch'), inst.test_patch)

  // 3. prompt.md：问题描述 + 任务约束（不自爆测试补丁，避免 agent 直接改测试）
  const prompt = `请修复以下问题（来自真实开源项目 ${inst.repo} 的 issue）。

## 问题描述

${inst.problem_statement.trim()}

## 要求

- 只修改源代码，修复问题描述中的 bug。
- 不要修改测试文件；测试由评测系统独立运行。
- 修复后如果方便，可以运行相关测试验证（例如 \`python -m pytest <测试文件>\`）。
- 项目为 Python 项目，源码在仓库根目录，可直接 \`python -c "import <包名>"\` 验证。
- 完成后用一句话总结你的修改。
`
  writeFileSync(join(dir, 'prompt.md'), prompt)

  // 4. verify.mjs：应用 test.patch → 跑 FAIL_TO_PASS + PASS_TO_PASS 抽查
  const verify = buildVerify(inst)
  writeFileSync(join(dir, 'verify.mjs'), verify)

  // 5. gold.patch：官方修复补丁（参考/排障用，不参与验收）
  writeFileSync(join(dir, 'gold.patch'), inst.patch)

  return { id, dir, taskJson }
}

function buildVerify(inst) {
  // SWE-bench 官方 FAIL_TO_PASS 只含测试函数名（无文件路径），测试文件从
  // test.patch 的 diff 头解析；组合为 pytest 节点 ID（file::test）
  const patchFiles = [...(inst.test_patch.matchAll(/^diff --git a\/(\S+) b\//gm) || [])].map((m) => m[1])
  const testFiles = [...new Set(patchFiles.filter((f) => /test|tests/i.test(f)))]
  if (!testFiles.length && patchFiles.length) testFiles.push(patchFiles[0])
  const ftp = (inst.FAIL_TO_PASS || []).map((t) => {
    // 若已含 :: 直接用；否则取第一个测试文件拼节点 ID
    if (t.includes('::')) return JSON.stringify(t)
    return JSON.stringify(`${testFiles[0] || ''}::${t}`)
  })
  // PASS_TO_PASS 全量跑太重（有的 500+），抽查同测试文件下前 N 个
  const ptp = (inst.PASS_TO_PASS || []).slice(0, 10).map((t) => {
    if (t.includes('::')) return JSON.stringify(t)
    return JSON.stringify(`${testFiles[0] || ''}::${t}`)
  })
  const testFilesJson = JSON.stringify(testFiles)
  const repo = inst.repo
  return `#!/usr/bin/env node
// SWE-bench 验收：应用 test.patch → 跑 FAIL_TO_PASS（修复后应通过）→ PASS_TO_PASS 抽查
// ---------------------------------------------------------------------------
// 与平台内建任务不同：SWE-bench 的测试补丁在 agent 完成后才应用（避免 agent
// 直接改测试作弊），FAIL_TO_PASS 从失败变通过 = 修复有效；PASS_TO_PASS 抽查
// 确认无回归。测试在外部仓库 worktree 上运行（python -m pytest）。
// ---------------------------------------------------------------------------
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ws = process.argv[2]
const dir = fileURLToPath(new URL('.', import.meta.url))
const TEST_FILES = ${testFilesJson}
const FAIL_TO_PASS = [${ftp.join(', ')}]
const PASS_TO_PASS = [${ptp.join(', ')}]
const INSTANCE = ${JSON.stringify(inst.instance_id)}

const log = []
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, cwd: ws, ...opts })
  if (r.stdout) log.push(r.stdout.trim())
  if (r.stderr) log.push(r.stderr.trim())
  return r
}

// 1. 应用官方测试补丁（幂等：可应用则应用；已应用/冲突则跳过并提示）
//    git apply --check 返回 0 = 可应用（patch 尚未打上）；非 0 = 已应用或冲突
const testPatch = join(dir, 'test.patch')
const check = sh('git', ['apply', '--check', testPatch])
if (check.status === 0) {
  const r = sh('git', ['apply', testPatch])
  if (r.status !== 0) {
    console.error('test.patch 应用失败：' + r.stderr)
    process.exit(2)
  }
} else {
  log.push('test.patch 已存在（跳过应用）')
}

// 2. 跑 FAIL_TO_PASS：全部通过 = 修复有效
let pass = true
for (const test of FAIL_TO_PASS) {
  const r = sh('python', ['-m', 'pytest', test, '-q', '--no-header', '-p', 'no:cacheprovider'])
  if (r.status !== 0) {
    pass = false
    log.push(\`FAIL_TO_PASS ✗ \${test}\`)
  } else {
    log.push(\`FAIL_TO_PASS ✓ \${test}\`)
  }
}

// 3. PASS_TO_PASS 抽查：不回归（失败仅警告，主判据是 FAIL_TO_PASS）
for (const test of PASS_TO_PASS) {
  const r = sh('python', ['-m', 'pytest', test, '-q', '--no-header', '-p', 'no:cacheprovider'])
  if (r.status !== 0) {
    log.push(\`PASS_TO_PASS 回归 ⚠ \${test}\`)
  }
}

const out = log.join('\\n').slice(-4000)
console.log(out)
process.exit(pass ? 0 : 1)
`
}

// —— 主流程 ——
if (argv.includes('--list')) {
  listCandidates()
  process.exit(0)
}

const ids = argVal('--ids')?.split(',').map((s) => s.trim()).filter(Boolean)
const repoFilter = argVal('--repo') || null
const limit = argVal('--limit') ? Number(argVal('--limit')) : 6

// 默认只选已克隆到 vendors/swebench-repos/ 的仓库（避免生成依赖缺失仓库的任务）
const clonedRepos = new Set()
if (existsSync(reposDir)) {
  for (const dirName of readdirSync(reposDir)) {
    for (const light of LIGHT_REPOS) {
      if (light.split('/')[1] === dirName) clonedRepos.add(light)
    }
  }
}

let selected = []
if (ids) {
  selected = ids.map((id) => instances.find((i) => i.instance_id === id)).filter(Boolean)
} else {
  const cands = repoFilter ? pickCandidates(repoFilter) : pickCandidates(null).filter((i) => clonedRepos.has(i.repo))
  selected = cands.slice(0, limit)
}

if (!selected.length) {
  console.error('没有选中的实例（--list 查看候选，或指定 --repo/--ids）')
  process.exit(1)
}

// 起始序号：从现有任务推断（SWE### 最大 +1），幂等导入
let seq = 1
if (existsSync(tasksDir)) {
  for (const name of readdirSync(tasksDir)) {
    const m = name.match(/^SWE(\d{3})/)
    if (m) seq = Math.max(seq, Number(m[1]) + 1)
  }
}

const results = []
for (const inst of selected) {
  // 幂等：同 instance 已导入则跳过
  const short = inst.instance_id.replace(/[^\w-]/g, '_')
  let exists = false
  if (existsSync(tasksDir)) {
    for (const name of readdirSync(tasksDir)) {
      if (name.includes(short)) { exists = true; break }
    }
  }
  if (exists) {
    console.log(`跳过（已导入） ${inst.instance_id}`)
    continue
  }
  const r = importInstance(inst, seq)
  seq++
  results.push(r)
  console.log(`导入 ${r.id}  ${inst.instance_id}  →  tasks/${r.id}-${short}/`)
}

console.log('\\n完成：' + results.length + ' 个 SWE-bench 任务已生成')
console.log('外部仓库需已克隆到 vendors/swebench-repos/（见 scripts/swebench-clone.sh）')
console.log('跑评测：node benchmark/run.mjs --tasks ' + results.map((r) => r.id).join(','))
