// shared/platform-capabilities.test.mjs —— 平台能力层的单测
//
// 为什么测这些（判据可失败，不是恒真）：
//   · 能力层的全部价值在于"**同一份判据**喂给 Win 版与容器版"——若取值漂了，
//     表现为"某个平台上报可用、实际调不通"，而这正是本模块要消灭的静默半死形态；
//   · 故这里逐项钉住**两个目标形态**（Windows 桌面 / Linux headless 容器）的取值，
//     以及未知平台的 fail-closed 行为。
//
// 纪律：platform 一律**显式传入**（能力层是可注入纯函数），测试不依赖宿主操作系统。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { platformCapabilities, supports, describeDisabled, FAMILY_OF } from '../shared/platform-capabilities.mjs'

// ── 形态 1：Windows 桌面（当前唯一发行形态）────────────────────────────────
test('Windows 桌面：shell / 杀树 / python / 路径语义 / 内嵌运行时', () => {
  const c = platformCapabilities({ platform: 'win32', headless: false })
  assert.equal(c.family, 'windows')
  assert.equal(c.headless, false)
  assert.equal(c.shell.kind, 'windows-shell', 'win32 走 cmd 风格参数（git-bash 的存在性由调用方探测）')
  assert.deepEqual(c.shell.cmdArgs, ['/d', '/s', '/c'], '逐字对齐 kernel/tools.mjs:76 的既有参数')
  assert.equal(c.process.killTree, 'taskkill', '逐字对齐 kernel/exec-base.mjs:61')
  assert.equal(c.python.bin, 'python', '逐字对齐 kernel/knowledge-import.mjs 既有取值')
  assert.equal(c.python.embedded, 'windows-amd64', '内嵌 Python 只有 Windows amd64（build-embedded-python.mjs:14）')
  assert.equal(c.path.caseInsensitive, true)
  assert.equal(c.path.listSeparator, ';')
  assert.equal(c.path.execSuffixRequired, true)
  assert.equal(c.archive.tar, 'bsdtar')
})

test('Windows 桌面：桌面能力可用，且 UIA/应用智控为真', () => {
  const c = platformCapabilities({ platform: 'win32', headless: false })
  assert.equal(c.desktop.available, true)
  assert.equal(c.desktop.uia, true, 'Windows 有 UIA（electron/app-uia-exec.cjs#uiaSupport）')
  assert.equal(c.desktop.sapiAsr, true, 'Windows 有 SAPI（electron/asr-sapi.cjs#asrSupport）')
  assert.equal(c.desktop.appControl, true, '应用智控依赖 UIA ⇒ 随 UIA 走')
  assert.equal(c.desktop.nativeDialog, true)
  assert.equal(c.desktop.tray, true)
  assert.deepEqual(c.unsupported, [], 'Windows 桌面是"能力完整"形态 ⇒ 降级清单必须为空')
})

// ── 形态 2：Linux headless 容器（Docker 版目标形态）────────────────────────
test('Linux headless：桌面能力全不可用，且逐项进入降级清单', () => {
  const c = platformCapabilities({ platform: 'linux', headless: true })
  assert.equal(c.family, 'posix')
  assert.equal(c.headless, true)
  assert.equal(c.desktop.available, false, '无 Electron 主进程 ⇒ 桌面能力整体不可用')
  for (const k of ['uia', 'sapiAsr', 'nativeDialog', 'tray', 'notification', 'browserExecutor', 'windowControls', 'appControl']) {
    assert.equal(c.desktop[k], false, `容器内 ${k} 必须为 false`)
    assert.ok(c.unsupported.includes(`desktop.${k}`), `${k} 必须出现在降级清单里（否则就是"看着在、点了没用"）`)
  }
})

test('Linux：shell / python / 路径语义 / 内嵌运行时按 posix 取值', () => {
  const c = platformCapabilities({ platform: 'linux', headless: true })
  assert.equal(c.shell.kind, 'sh')
  assert.deepEqual(c.shell.cmdArgs, ['-c'], '逐字对齐 kernel/tools.mjs:77 的既有取值')
  assert.equal(c.python.bin, 'python3', '逐字对齐 kernel/knowledge-import.mjs 既有取值')
  assert.equal(c.python.embedded, null, '内嵌 Python 无 Linux 构建 ⇒ 必须为 null 而不是"假装有"')
  assert.ok(c.unsupported.includes('python.embedded'), '缺内嵌 Python 必须显式进降级清单')
  assert.equal(c.path.caseInsensitive, false)
  assert.equal(c.path.listSeparator, ':')
  assert.equal(c.path.execSuffixRequired, false)
  assert.equal(c.archive.tar, 'tar')
})

test('Linux：杀树能力如实标注为 none（与既有 posix 行为逐字等价，不擅自"顺手修好"）', () => {
  const c = platformCapabilities({ platform: 'linux' })
  assert.equal(c.process.killTree, 'none', '既有 posix 分支没有杀树实现（kernel/exec-base.mjs 直接跳过）')
  assert.ok(c.unsupported.includes('process.killTree'), '能力缺失必须可见')
})

// ── 形态 3：未知平台 fail-closed ───────────────────────────────────────────
test('未知平台：不兜底成 posix，明确 family=unknown 并判能力不可用', () => {
  const c = platformCapabilities({ platform: 'plan9' })
  assert.equal(c.family, 'unknown', '不认识就是 unknown，不猜')
  assert.equal(c.shell.kind, 'unknown')
  assert.equal(c.shell.cmdArgs, null, '未知平台不得给出可执行的 shell 参数')
  assert.ok(c.unsupported.includes('platform.recognized'))
  assert.equal(FAMILY_OF.plan9, undefined)
})

// ── headless 缺省推导 ──────────────────────────────────────────────────────
test('headless 缺省按 PONOS_HEADLESS=1 判定，显式传参优先', () => {
  assert.equal(platformCapabilities({ platform: 'linux', env: {} }).headless, false)
  assert.equal(platformCapabilities({ platform: 'linux', env: { PONOS_HEADLESS: '1' } }).headless, true)
  assert.equal(
    platformCapabilities({ platform: 'linux', headless: false, env: { PONOS_HEADLESS: '1' } }).headless,
    false, '显式入参必须压过 env（否则测试无法钉住形态）',
  )
})

// ── supports()：fail-closed ────────────────────────────────────────────────
test('supports()：已知能力如实回答；未知路径一律 false（拼错 = 不支持）', () => {
  const win = platformCapabilities({ platform: 'win32', headless: false })
  const lin = platformCapabilities({ platform: 'linux', headless: true })
  assert.equal(supports(win, 'desktop.uia'), true)
  assert.equal(supports(lin, 'desktop.uia'), false)
  assert.equal(supports(win, 'desktop.uiaa'), false, '拼错不得为真')
  assert.equal(supports(win, 'nope.uia'), false)
  assert.equal(supports(win, ''), false)
  assert.equal(supports(win, 'shell'), false, '非布尔组不得当能力回答')
  assert.equal(supports(null, 'desktop.uia'), false)
})

// ── describeDisabled：降级说明可读 ─────────────────────────────────────────
test('describeDisabled：有能力缺失时点名清单，无缺失时明说能力完整', () => {
  assert.match(describeDisabled(platformCapabilities({ platform: 'linux', headless: true })), /本环境不支持：.*desktop\.uia/)
  assert.equal(describeDisabled(platformCapabilities({ platform: 'win32', headless: false })), '本环境能力完整')
})
