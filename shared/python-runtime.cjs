// shared/python-runtime.cjs —— python 解释器定位的**唯一真源**（DIAG-01，2026-10-18）
//
// 【为什么单独抽出来】原来有两份实现，口径不同：
//   · **运行时**（`kernel/knowledge-import.mjs#resolvePython`）：三层优先级
//     `显式 pythonPath` → `PONOS_PYTHON` → **自带 bundled** → PATH
//   · **诊断**（`doctor/lib/probes.cjs#checkPythonRuntime`）：只看 `ctx.appPaths.python`（两条候选）
//
//   后果：诊断报"无 python 运行时 / error"，而实际会话里一切正常（resolvePython 找到了
//   bundled 或 PONOS_PYTHON）⇒ 用户被误导去装 python。
//
// ★ 这是**同一个坑的第二处**：同文件既有注释记录了第一处 ——
//   「生产事故：诊断探针曾直接 spawn 安装目录（Program Files）→ EPERM → kernel-launch 误报 exit=1，
//     而实际会话走 bootstrap 缓存始终正常。」
//   两处都是"诊断自己实现一套探测，与运行时漂移"。故这次不留第二份。
//
// 【纪律】任何"这条路径/这个二进制在哪"的判断，运行时与诊断必须调**同一个函数**。
//   新增候选时只改本文件的 `pythonCandidates()`。

const { existsSync } = require('node:fs')
const { join, dirname } = require('node:path')

/**
 * python 解释器的全部候选路径（按优先级）。
 *
 * 优先级与理由（沿用运行时既有决策，不要随意调整）：
 *   ① 显式 `pythonPath`（调用方指定）—— 最高优先，尊重显式意图
 *   ② `PONOS_PYTHON` 环境变量 —— 运维的显式覆盖，不能被本地约定压掉
 *   ③ **自带 bundled 运行时** —— 必须排在 PATH 之前：系统 python 通常没装这套解析依赖
 *      （pypdf / python-docx / openpyxl / xlrd / PIL / rapidocr），导入会全线报"模块不存在"；
 *      而 bundled 那个一定装齐
 *   ④ PATH 上的 `python` / `python3` —— 最后兜底
 *
 * @param {{ pythonPath?: string|null, appRoot?: string, kernelDir?: string }} [opts]
 * @returns {string[]} 候选路径（已按优先级排序；可能包含不存在项，供诊断逐个报告）
 */
function pythonCandidates(opts = {}) {
  const out = []
  const explicit = String(opts.pythonPath ?? '').trim()
  if (explicit) out.push(explicit)
  const env = String(process.env.PONOS_PYTHON || '').trim()
  if (env) out.push(env)

  // 自带解释器：dev = <repo>/runtime/python/…；release = resources/runtime/python/…
  // 传入 kernelDir / appRoot 时按其定位；否则按本文件位置推算（shared/ 的上一级即仓库根）
  const here = __dirname
  const roots = []
  if (opts.kernelDir) roots.push(opts.kernelDir)
  if (opts.appRoot) roots.push(join(opts.appRoot, 'kernel'))
  roots.push(join(here, '..', 'kernel'))
  for (const r of roots) {
    out.push(join(r, '..', 'runtime', 'python', 'python.exe'))
    out.push(join(r, '..', 'runtime', 'python', 'bin', 'python3'))
    out.push(join(dirname(r), 'resources', 'runtime', 'python', 'python.exe'))
  }

  // PATH 兜底
  out.push('python', 'python3')
  // 去重但保序
  return [...new Set(out.filter(Boolean))]
}

/**
 * 定位实际要用的 python 解释器（**运行时的权威决定**）。
 *
 * ★ 与 `pythonCandidates()` 的区别：本函数返回**第一个存在**的候选；
 *   PATH 上的裸命令（`python`）无法用 existsSync 判断，故作为最后兜底直接返回。
 *
 * @param {{ pythonPath?: string|null, appRoot?: string, kernelDir?: string }} [opts]
 * @returns {string}
 */
function resolvePython(opts = {}) {
  // ★★ 2026-10-18 DIAG-01（自查发现的行为退化，已修）：
  //   **显式 pythonPath 与 PONOS_PYTHON 不做存在性检查，直接返回**。
  //   理由：它们是**显式意图**（调用方/运维指定），即使当前不存在也应原样传给调用方 ——
  //   可能是稍后才创建、可能是网络路径、也可能调用方要自己报"你指定的路径不存在"这个更准确的错。
  //
  //   ★ 这不是理论问题：我第一版把它们也塞进"逐个 existsSync 探测"的循环里，
  //     直接把既有契约测试打红了（`resolvePython('D:/x/python.exe')` 期望原样返回，
  //     实际返回了 'python'）—— 一条真实的行为退化，被测试当场抓住。
  const explicit = String(opts.pythonPath ?? '').trim()
  if (explicit) return explicit
  const env = String(process.env.PONOS_PYTHON || '').trim()
  if (env) return env

  // 以下才是"探测"：自带 bundled → PATH 兜底
  for (const c of pythonCandidates(opts)) {
    if (!c.includes('/') && !c.includes(String.fromCharCode(92))) return c   // PATH 上的裸命令
    try { if (existsSync(c)) return c } catch { /* 权限/非法路径：继续下一个 */ }
  }
  return 'python'
}

/**
 * 诊断用：逐候选报告存在性（让"为什么找不到"可解释）。
 * @returns {{ path: string, exists: boolean, isPathCommand: boolean }[]}
 */
function probePythonCandidates(opts = {}) {
  return pythonCandidates(opts).map((c) => {
    const isPathCommand = !c.includes('/') && !c.includes('\\')
    if (isPathCommand) return { path: c, exists: false, isPathCommand: true }
    let exists = false
    try { exists = existsSync(c) } catch { exists = false }
    return { path: c, exists, isPathCommand: false }
  })
}

module.exports = { pythonCandidates, resolvePython, probePythonCandidates }
