#!/usr/bin/env node
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
const TEST_FILES = ["sympy/physics/units/tests/test_quantities.py"]
const FAIL_TO_PASS = ["sympy/physics/units/tests/test_quantities.py::test_issue_24211"]
const PASS_TO_PASS = ["sympy/physics/units/tests/test_quantities.py::test_str_repr", "sympy/physics/units/tests/test_quantities.py::test_eq", "sympy/physics/units/tests/test_quantities.py::test_convert_to", "sympy/physics/units/tests/test_quantities.py::test_Quantity_definition", "sympy/physics/units/tests/test_quantities.py::test_abbrev", "sympy/physics/units/tests/test_quantities.py::test_print", "sympy/physics/units/tests/test_quantities.py::test_Quantity_eq", "sympy/physics/units/tests/test_quantities.py::test_add_sub", "sympy/physics/units/tests/test_quantities.py::test_quantity_abs", "sympy/physics/units/tests/test_quantities.py::test_check_unit_consistency"]
const INSTANCE = "sympy__sympy-24213"

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
    log.push(`FAIL_TO_PASS ✗ ${test}`)
  } else {
    log.push(`FAIL_TO_PASS ✓ ${test}`)
  }
}

// 3. PASS_TO_PASS 抽查：不回归（失败仅警告，主判据是 FAIL_TO_PASS）
for (const test of PASS_TO_PASS) {
  const r = sh('python', ['-m', 'pytest', test, '-q', '--no-header', '-p', 'no:cacheprovider'])
  if (r.status !== 0) {
    log.push(`PASS_TO_PASS 回归 ⚠ ${test}`)
  }
}

const out = log.join('\n').slice(-4000)
console.log(out)
process.exit(pass ? 0 : 1)
