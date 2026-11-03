// **F4 两侧语义对账**：`Node isExcluded` ↔ `PowerShell Test-Excluded`（用户 2026-10-14 拍板）。
// ---------------------------------------------------------------------------
// 排除清单是**同一套规则的两处实现**：
//   · Node 侧 `kernel/screen-exclusions.mjs` 的 `isExcluded`（可执行规格）
//   · PS 侧 `electron/screen.ps1` 的 `Test-Excluded`（**生产路径上真正生效的那份**）
// 没有这条测试，改一侧忘另一侧会**静默漂移** —— 表现为"某个本该被排除的窗口被截进模型
// 上下文"，且**没有任何报错**（spec §3.5 S4 的机制会悄悄失效）。
//
// 运行：node --test kernel-tests/screen-exclusion-parity.test.mjs
//   （PS 侧用例需 Windows + PowerShell；非 Windows 会 skip 而不算通过）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isExcluded, DEFAULT_EXCLUSIONS } from '../kernel/screen-exclusions.mjs'
import { screenSkipReason } from './screen-env.mjs'


const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PS1 = join(ROOT, 'electron', 'screen.ps1')
const isWin = process.platform === 'win32'

// ★ 必须与 electron/screen.ps1 里 `if ($SelfTest)` 的缺省 $fixtures **同一组用例**。
//   两侧各写一份 fixture 是有意的：任何一侧的用例被删/改，长度或逐例比对就会失败。
//   改这里必须同步改 .ps1，反之亦然。
// ★ fixture 与清单都**注入**给 PS 侧（2026-10-14 修正）：原设计把 fixture 硬编码在
//   screen.ps1 里，导致"想对账一组新用例"必须改 .ps1 ⇒ 元字符这类只在自定义清单下才
//   暴露的分叉永远测不到。现在两侧各传一份：清单走 PONOS_SCREEN_EXCLUDED、
//   用例走 PONOS_SCREEN_SELFTEST_FIXTURES，PS 只负责**判定**并回吐结果。
function runSelfTest(exclusions, fixtures) {
  const raw = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', PS1, '-Act', 'displays', '-SelfTest',
  ], {
    encoding: 'utf8',
    timeout: 40_000,
    env: {
      ...process.env,
      PONOS_SCREEN_EXCLUDED: Buffer.from(JSON.stringify(exclusions), 'utf8').toString('base64'),
      PONOS_SCREEN_SELFTEST_FIXTURES: Buffer.from(JSON.stringify(fixtures), 'utf8').toString('base64'),
    },
  })
  const parsed = JSON.parse(String(raw).trim().split('\n').filter(Boolean).pop())
  assert.equal(parsed.ok, true, `SelfTest 必须成功：${JSON.stringify(parsed).slice(0, 300)}`)
  return parsed
}

const FIXTURES = [
  { process: 'KeePass', title: 'x' },
  { process: 'KeePassXC.exe', title: 'x' },
  { process: 'notepad.exe', title: 'x' },
  { process: '', title: '密码 - 记事本' },
  { process: '', title: 'Password Vault' },
  { process: '', title: 'Ponos' },
  { process: '', title: '' },
  { process: 'WEIXIN', title: '微信' },
  { process: 'vault', title: '随便' },
]

test('★ F4 两侧语义对账：Node isExcluded 与 PS Test-Excluded 逐例判定必须一致', { skip: !isWin && '仅 Windows' }, (t) => {
  if (screenSkipReason()) return t.skip(screenSkipReason())
  // 排除清单是**同一套规则的两处实现**：Node 侧 isExcluded（可执行规格）与 PS 侧 Test-Excluded
  //（生产路径上真正生效的那份）。没有这条测试，将来改一侧忘另一侧会**静默漂移** ——
  // 表现为"某个本该被排除的窗口被截进模型上下文"，且没有任何报错。
  const parsed = runSelfTest(DEFAULT_EXCLUSIONS, FIXTURES)
  const psRows = parsed.data.fixtures
  assert.equal(psRows.length, FIXTURES.length,
    'PS 侧 fixture 数与 Node 侧不一致 —— 两侧用例集已漂移（改一侧必须改另一侧）')

  for (let i = 0; i < FIXTURES.length; i++) {
    const f = FIXTURES[i]
    const nodeVerdict = isExcluded(f, DEFAULT_EXCLUSIONS)
    assert.equal(psRows[i].process, f.process, `第 ${i} 例 process 未对齐`)
    assert.equal(psRows[i].title, f.title, `第 ${i} 例 title 未对齐`)
    assert.equal(psRows[i].excluded, nodeVerdict,
      `第 ${i} 例判定不一致：process=${JSON.stringify(f.process)} title=${JSON.stringify(f.title)}`
      + ` —— Node=${nodeVerdict} PS=${psRows[i].excluded}（两侧规则已漂移）`)
  }
})

test('★ 自定义清单（含正则元字符）也必须两侧一致 —— 元字符是真实分叉点', {
  skip: !isWin && '仅 Windows',
}, (t) => {
  if (screenSkipReason()) return t.skip(screenSkipReason())
  // 缺省清单里的模式都是中文词 + `*`，**覆盖不到正则元字符** ⇒ 只对账缺省清单时，
  // Node 侧漏转义 `?` 这类缺陷永远不会被跨语言测试发现（2026-10-14 实测：
  // Node 的 /^?x$/ 抛 SyntaxError，而 PS 的 [regex]::Escape 把 `?` 当字面量）。
  // 另含首尾空白用例 —— Node 侧 Trim 而 PS 侧原来不 Trim，也是静默分叉。
  const custom = {
    processes: [],
    // ★ Minor-3（2026-10-14 终审修复）：清单条目带**前后空白**的模式也必须两侧一致 ——
    //   Node 侧 patternToRegExp 对 pattern 做了 trim()，PS 侧原来不 trim ⇒ 分叉方向是
    //   **PS 侧漏排**（本该被排除的窗口被截进模型上下文），正是 spec §3.5 S4 最不能出的错。
    //   ★ 关键词必须与其它模式**不重叠**（实测教训：起初用 ' *密码* '，而清单里已有 '*密码*'
    //   ⇒ 未 trim 的 PS 侧虽然漏了带空白那条，却被 '*密码*' 兜住，**变异测试照样全绿** ——
    //   那是"用例看着更全、其实测不到"的假通过。故这里用 '机要'（清单里只此一处）。
    titlePatterns: ['?x', 'a?b', 'a.b', 'a+b', 'a$b', 'a{b', 'a(b', 'a|b', '*密码*', ' *机要* '],
  }
  const cases = [
    { process: '', title: '?x' }, { process: '', title: 'x' },
    { process: '', title: 'a?b' }, { process: '', title: 'ab' },
    { process: '', title: 'a.b' }, { process: '', title: 'axb' },
    { process: '', title: 'a+b' }, { process: '', title: 'a$b' },
    { process: '', title: 'a{b' }, { process: '', title: 'a(b' },
    { process: '', title: 'a|b' }, { process: '', title: 'zzz' },
    { process: '', title: ' 密码' }, { process: '', title: '密码 ' },
    // 带空白的**模式**（' *机要* '）对应的三条样本：命中 / 不该命中 / 标题两侧带空白仍命中
    { process: '', title: '机要文件' }, { process: '', title: '公开文件' }, { process: '', title: ' 我的机要档案 ' },
  ]
  const parsed = runSelfTest(custom, cases)
  const psRows = parsed.data.fixtures
  assert.equal(psRows.length, cases.length, 'PS 侧 fixture 数与注入不一致 —— 注入未生效')
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const nodeVerdict = isExcluded(c, custom)
    assert.equal(psRows[i].excluded, nodeVerdict,
      `第 ${i} 例不一致：title=${JSON.stringify(c.title)} —— Node=${nodeVerdict} PS=${psRows[i].excluded}`)
  }
  // 用例集必须有区分度（防退化成全 true / 全 false 的空断言）
  const vs = cases.map((c) => isExcluded(c, custom))
  assert.ok(vs.includes(true) && vs.includes(false), '用例集必须同时含"命中"与"未命中"样本')
})

test('★ 对账用例集本身有区分度（不是全 true / 全 false 的空断言）', () => {
  const verdicts = FIXTURES.map((f) => isExcluded(f, DEFAULT_EXCLUSIONS))
  assert.ok(verdicts.includes(true), '用例集必须含"应被排除"的样本')
  assert.ok(verdicts.includes(false), '用例集必须含"不应被排除"的样本')
  assert.ok(FIXTURES.length >= 8, '用例集太薄：覆盖不到大小写 / .exe 后缀 / 通配标题 / 空值')
})
