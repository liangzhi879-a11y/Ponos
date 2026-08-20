// T006 验收：health.test.mjs（或同目录测试）覆盖 failures 因子，且全部测试通过
// 用法：node verify.mjs <workspace>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ws = process.argv[2]

// ── 1. 断言测试文件存在 failures 专项用例 ───────────────────────────────────
// 要求：出现非 0 的 failures 输入（failures: 1 / 3 / 4 等），且存在对增量/封顶的断言
const testFiles = ['server/health.test.mjs']
let covered = false
let testSrc = ''
for (const f of testFiles) {
  const p = join(ws, f)
  try { testSrc = readFileSync(p, 'utf8') } catch { continue }
  const hasNonZeroFailures = /failures\s*:\s*[1-9]/.test(testSrc)
  const hasAssertion = /Math\.min\(3,\s*failures\)/.test(testSrc) ||
    /failures[^\n]*\+10|封顶|超上限|\+30|每次失败/.test(testSrc)
  if (hasNonZeroFailures && hasAssertion) {
    covered = true
    break
  }
}
if (!covered) {
  console.error('VERIFY_FAIL: 未找到 failures 因子的专项断言（检查 server/health.test.mjs）')
  process.exit(1)
}

// ── 2. 运行全部 health 测试确认通过（含既有，无回归）────────────────────────
try {
  execFileSync(process.execPath, ['--test', join(ws, 'server', 'health.test.mjs')], { cwd: ws, stdio: 'pipe', timeout: 60000 })
} catch (e) {
  const out = e.stdout?.toString?.() || ''
  console.error('VERIFY_FAIL: health.test.mjs 运行失败')
  console.error(out.split('\n').slice(-15).join('\n'))
  process.exit(1)
}

console.log('VERIFY_PASS')
process.exit(0)
