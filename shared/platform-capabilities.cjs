'use strict'
// shared/platform-capabilities.cjs —— **平台能力层的唯一真源**（多平台共存的前置件）。
//
// ★★ 为什么要有这个模块（实测病灶，不是设计洁癖）：
//   全仓有 **26 处** 散落的 `process.platform === 'win32'` 与一批平台工具硬编码
//   （`powershell` / `taskkill` / `netstat` / `wmic` / `cmd.exe` / `python` vs `python3`）。
//   在"只有 Windows 一种发行形态"时，散落尚可忍；一旦要**与容器版（Linux）共存平行迭代**，
//   散落就变成最危险的那种形态：**两处改、漏一处** ⇒ 新增能力只在 Win 版接线，容器版**静默半死**
//   （功能看着在、点了没用），而不是明确报错。这正是本仓反复栽过的"同一判据两份实现"。
//
// ★★ 定位：本模块只回答"**这台机器/这个运行环境有哪些能力**"，**不**做业务判定。
//   调用方（kernel / server / electron）按 `caps` 分支，而**不再各自写 `process.platform === ...`**。
//
// ★★ 设计要点（四条，改代码前先读）：
//   ① **纯函数 + 可注入 platform**：`platformCapabilities({ platform })` 的 platform 可显式传入，
//      单测无需真的换操作系统。**先例是现成的**：`electron/app-uia-exec.cjs#uiaSupport(platform)`
//      与 `electron/asr-sapi.cjs#asrSupport(platform)` 早已是这个形态（测试可显式传平台），
//      本模块把该形态**推广成全仓统一入口**，而不是另起一套。
//   ② **零依赖**：只用内建；不 import 任何 npm 包，也不 import 其它 shared 模块（保持叶子地位，
//      避免给 kernel 的最小闭包增加新的逃逸依赖）。
//   ③ **fail-closed / 不猜**：平台字符串不认识时**不**假定"大致像 posix"，而是明确返回
//      `family: 'unknown'` + 保守能力（宁可判"能力不可用"，也不给一个用不了的能力）。
//   ④ **headless 是独立维度，不是平台**：容器（无 GUI）与桌面是同平台的两种形态；
//      把它塞进 platform 会让"Linux 桌面版"这种未来形态无法表达。故由 `headless` 显式传入
//      （缺省按 `process.env.PONOS_HEADLESS === '1'` 判定）。
//
// ★★ 现状声明（**如实**，勿高估）：本模块是**新增的能力真源**，尚**未**把 26 处既有分支
//   全部迁过来（迁移是一批批做的，见 docs/2026-10-09-多平台（Win+Docker）版本管理方案.md §3）。
//   在迁移完成前，两侧判定**必须逐字等价**——否则会出现"能力层说可用、旧分支说不可用"的双真源，
//   那比不迁更糟。故本模块的取值**逐项对齐既有分支**，并在每项注明其对应的现有位置。

/** 平台字符串 → 平台族。**未知平台不兜底成 posix**（fail-closed，见模块头 ④/③）。 */
const FAMILY_OF = {
  win32: 'windows',
  linux: 'posix',
  darwin: 'posix',
  freebsd: 'posix',
  openbsd: 'posix',
  sunos: 'posix',
  aix: 'posix',
}

/**
 * 平台能力全量清单（**单一真源**）。
 *
 * @param {{platform?: string, headless?: boolean, env?: Record<string, string|undefined>}} [opts]
 *   platform 缺省 `process.platform`；headless 缺省按 `PONOS_HEADLESS === '1'`；
 *   env 仅用于 headless 判定与（未来的）能力覆盖口，缺省 `process.env`。
 * @returns {{
 *   platform: string, family: 'windows'|'posix'|'unknown', headless: boolean,
 *   shell: {kind: string, cmdArgs: string[]|null},
 *   process: {killTree: string},
 *   python: {bin: string, embedded: string|null},
 *   path: {caseInsensitive: boolean, listSeparator: string, execSuffixRequired: boolean},
 *   archive: {tar: string},
 *   desktop: {available: boolean, uia: boolean, sapiAsr: boolean, nativeDialog: boolean,
 *             tray: boolean, notification: boolean, browserExecutor: boolean,
 *             windowControls: boolean, appControl: boolean},
 *   unsupported: string[]
 * }}
 */
function platformCapabilities(opts = {}) {
  const platform = String(opts.platform || process.platform)
  const env = opts.env || process.env
  const family = FAMILY_OF[platform] || 'unknown'
  const win = family === 'windows'
  const posix = family === 'posix'
  const headless = opts.headless !== undefined
    ? opts.headless === true
    : env.PONOS_HEADLESS === '1'

  // ── shell：命令解释器 ────────────────────────────────────────────────────
  // 对应现有分支：`kernel/tools.mjs:74-77`（isWin → git-bash 优先，回退 cmd.exe）与 `:196-199`（同款）。
  // posix 侧既有行为就是 `sh -c`（`kernel/tools.mjs:77/199`），此处照抄不改口径。
  // ★ `kind` 只描述**族**：Windows 上具体用 git-bash 还是 cmd.exe 由调用方按**存在性**决定
  //   （既有逻辑要 `existsSync(bash)` 探测），能力层**不**替它做存在性判定（那是环境探测，不是平台能力）。
  const shell = win
    ? { kind: 'windows-shell', cmdArgs: ['/d', '/s', '/c'] }
    : posix
      ? { kind: 'sh', cmdArgs: ['-c'] }
      : { kind: 'unknown', cmdArgs: null }

  // ── process.killTree：杀整棵进程树 ───────────────────────────────────────
  // 对应现有分支：`kernel/exec-base.mjs:61`（win → `taskkill /F /T /PID`）、`kernel/tools.mjs:111`、
  // `server/bridge.mjs:2379`（同款 taskkill）。
  // ★ 既有 posix 行为是**没有**杀树实现（`exec-base.mjs` 里 `process.platform !== 'win32'` 直接跳过）
  //   ⇒ 本模块如实标注为 `'none'`，**不**擅自改成进程组。改语义是另一件事（见方案文档 §4-M4），
  //   在迁移期"能力层与旧分支逐字等价"优先于"顺手修好"。
  const killTree = win ? 'taskkill' : 'none'

  // ── python：解释器名与内嵌运行时 ─────────────────────────────────────────
  // 对应现有分支：`kernel/knowledge-import.mjs`（`win32 ? 'python' : 'python3'`）、
  // `kernel/media-tools.mjs`（`win32 ? ['python'…]`）。
  // 内嵌运行时：`scripts/build-embedded-python.mjs:14,53-58` 硬编码 Windows embed zip +
  // `powershell Expand-Archive` ⇒ **只有 windows-amd64**（实测 `runtime/python/python.exe`）。
  const pythonBin = win ? 'python' : 'python3'
  const embeddedPython = win ? 'windows-amd64' : null

  // ── path：路径语义 ───────────────────────────────────────────────────────
  // 对应现有分支：`server/files-routes.mjs:73`（win → toLowerCase 比较）、
  // `electron/app-explore.cjs:40`（`caseInsensitive ?? win32`）、
  // `server/bridge.mjs:309`（PATH 分隔符 `win32 ? ';' : ':'`）、
  // `electron/app-profiler.cjs:270`（win 要求 .exe/.cmd/.bat/.com 后缀）。
  const path = {
    caseInsensitive: win,
    listSeparator: win ? ';' : ':',
    execSuffixRequired: win,
  }

  // ── archive.tar：系统 tar ────────────────────────────────────────────────
  // 对应现有分支：`server/packager.mjs:15`（`SYSTEM_TAR = win32 ? …`）。
  const tar = win ? 'bsdtar' : 'tar'

  // ── desktop：桌面（Electron）能力 ────────────────────────────────────────
  // ★ 判据是"**有没有 Electron 主进程**"，不是"什么操作系统"：容器（headless）里全部不可用。
  //   故 `desktop.available` 由 `!headless` 决定；底下各项再叠加**平台专属**条件。
  //   UIA/SAPI 的现有能力判定在 `electron/app-uia-exec.cjs:107#uiaSupport`、
  //   `electron/asr-sapi.cjs:65#asrSupport` —— 那两处按 platform 判，本模块与其口径一致（仅 windows）。
  const desktopAvailable = !headless
  const desktop = {
    available: desktopAvailable,
    // 应用智控（Windows UIA）——posix 无等价物
    uia: desktopAvailable && win,
    // 语音识别（Windows SAPI）——posix 无等价物
    sapiAsr: desktopAvailable && win,
    // 原生文件/目录对话框：Electron 独占（`electron/main.cjs:1663,2138-2175`）
    nativeDialog: desktopAvailable,
    // 托盘 / 桌面通知 / 单实例恢复窗（`electron/main.cjs:1274-1278,2536`）
    tray: desktopAvailable,
    notification: desktopAvailable,
    // 内置浏览器执行器（`electron/browser-executor.cjs`）
    browserExecutor: desktopAvailable,
    // 窗口控制（frameless 拖动/边缘 resize）：桌面专属；**Web 版由浏览器原生提供**，
    // 故容器版不是"缺功能"而是"不需要"（渲染层空实现即可，见方案文档 §3.2）
    windowControls: desktopAvailable,
    // 应用智控整体（依赖 UIA）
    appControl: desktopAvailable && win,
  }

  // ── unsupported：**降级清单**（显式列出本环境不可用的能力）────────────────
  // ★ 这是"能力降级矩阵"的**代码真源**：产品侧文档、GUI 灰置、诊断输出都应从这里派生，
  //   而不是各写一份中文说明（那必然漂移）。命名用 `域.能力` 便于 grep 与门禁编号。
  const unsupported = []
  if (!desktop.available) {
    unsupported.push(
      'desktop.uia', 'desktop.sapiAsr', 'desktop.nativeDialog', 'desktop.tray',
      'desktop.notification', 'desktop.browserExecutor', 'desktop.windowControls',
      'desktop.appControl',
    )
  } else {
    if (!desktop.uia) unsupported.push('desktop.uia', 'desktop.appControl')
    if (!desktop.sapiAsr) unsupported.push('desktop.sapiAsr')
  }
  if (!embeddedPython) unsupported.push('python.embedded')
  if (killTree === 'none') unsupported.push('process.killTree')
  if (family === 'unknown') unsupported.push('platform.recognized')

  return {
    platform,
    family,
    headless,
    shell,
    process: { killTree },
    python: { bin: pythonBin, embedded: embeddedPython },
    path,
    archive: { tar },
    desktop,
    unsupported,
  }
}

/** 是否支持某能力（`'desktop.uia'` 这类点号路径）。未知路径**返回 false**（fail-closed）。 */
function supports(caps, capabilityId) {
  const id = String(capabilityId || '')
  if (!id) return false
  const [group, name] = id.split('.')
  const g = caps && caps[group]
  if (g === undefined || g === null) return false
  if (/\./.test(id.slice(group.length + 1))) return false // 只认两段
  if (typeof g === 'object') {
    if (!(name in g)) return false
    return g[name] === true
  }
  return false
}

/** 降级说明（供诊断/GUI/日志用）：把 unsupported 渲染成人读的一行。 */
function describeDisabled(caps) {
  const list = Array.isArray(caps && caps.unsupported) ? caps.unsupported : []
  return list.length ? `本环境不支持：${list.join('、')}` : '本环境能力完整'
}

module.exports = { platformCapabilities, supports, describeDisabled, FAMILY_OF }
