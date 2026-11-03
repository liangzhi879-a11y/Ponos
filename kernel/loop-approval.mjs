// kernel/loop-approval.mjs —— 循环任务的**放行白名单**（ENG-04，2026-10-18）
//
// 【要解决什么】
//   循环任务（`--loop`）是**无人值守的自动化**：一轮跑几十个工具调用，而审批是**逐次**挂起等人应答。
//   默认档 `loose` 下 `appTool`（`app_*` 应用智控）与 `highRiskBash` 的来源档都是 `bypass`
//   ⇒ **每一次都要 ask** ⇒ 自动化任务卡在第一个 app_* 或高危命令上，"近乎不可用"。
//
// 【为什么不直接调成 bypass】（本仓 AI-02/AI-03 的教训）
//   `bypass` 会连**灾难命令黑名单**一起放宽（`curl|sh`、格式化磁盘…）；
//   而 AI-02 刚把"高危判定"提到 allow 之前，正是防止"宽 allow 顺手放行高危形式"。
//   ⇒ 全局放宽是**倒退**，不能用来换可用性。
//
// 【本模块的取舍】
//   · 只对**白名单内**的工具自动放行；白名单外仍按档位逐次审批；
//   · 白名单来自循环任务的**显式声明**（`--loop-allow` / 工作流声明的工具集），**默认空 = 不放行**；
//   · **灾难命令（`hard`）永不因白名单放行** —— 这是安全底线，单列在 API 里显式传入；
//   · 与 engine 既有 `askOncePerRun` 同一姿态：调用方只把 `decision` 从 ask 降成 allow，
//     **不 return**，以免跳过 `hooks.preToolUse`（engine.mjs 那段注释已写明这个坑）。
//
// ★ 为什么不是"减少询问次数"而是"白名单"：减少次数只少弹几个窗，**第一次仍会卡住**；
//   循环任务无人看着，第一次卡住 = 任务卡死。必须让声明过的工具直接从 allow 走。

/**
 * 归一化白名单。
 *
 * 容错取向（全部按"更严"或"等价"处理，绝不因脏输入放大权限）：
 *   · 接受数组或逗号串（`'Bash, Write'`）；
 *   · 去空白、丢弃空条目、按**小写**去重（`'bash'` 与 `'BASH'` 视为同一条）；
 *   · `null` / `undefined` / 非字符串非数组 ⇒ 空数组（**默认不放行**）。
 *
 * @param {string|string[]|null|undefined} v
 * @returns {string[]} 归一化后的条目（保留原始大小写用于展示，去重按小写判定）
 */
export function normalizeLoopAllowlist(v) {
  const raw = Array.isArray(v)
    ? v
    : (typeof v === 'string' ? String(v).split(',') : [])
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * 工具名是否命中白名单。
 *
 * 支持两种写法：
 *   · 精确名（`Read`）—— 不区分大小写
 *   · 前缀通配（`app_*`、`mcp__fs__*`）—— 末尾 `*` 表示前缀
 *
 * ★ 通配只允许出现在**末尾**（`*` 或 `prefix*`）。
 *   中间的 `*`（如 `a*b`）按字面量处理 —— 本项目不需要 glob，支持它只会增加误匹配面。
 *
 * @param {string[]} allowlist 归一化后的白名单
 * @param {string} toolName
 * @returns {boolean}
 */
export function loopAllowlistMatches(allowlist, toolName) {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (!name) return false
  for (const raw of Array.isArray(allowlist) ? allowlist : []) {
    const pat = String(raw ?? '').trim().toLowerCase()
    if (!pat) continue
    if (pat.endsWith('*')) {
      const prefix = pat.slice(0, -1)
      // 空前缀（裸 `*`）等于放行一切 —— 拒绝这种写法（那与 bypass 无异，且极易误写）
      if (!prefix) continue
      // ★ `*` 不能退化成"匹配前缀本身"：`app_*` 不该命中工具名 `app`
      if (name.length > prefix.length && name.startsWith(prefix)) return true
      continue
    }
    if (name === pat) return true
  }
  return false
}

/**
 * 循环任务是否可对该工具**自动放行**（把 ask 降级为 allow）。
 *
 * @param {object} [o] 全字段可选（缺省按"空白名单/空工具名"处理，下方有防御）
 *   —— JSDoc 必须标 optional：实现给了 `= {}` 默认值，标成必填 tsc 会报 TS2739（ENG-03 同款坑）
 * @param {string[]} [o.allowlist] 归一化后的白名单（空 ⇒ 一律不放行）
 * @param {string} [o.toolName]
 * @param {boolean} [o.hard] 是否为**灾难命令**（`decideToolPermission` 的 `perm.hard`）。
 *   ★ 这是安全底线：`hard` 为真时**无条件返回 false**，即使工具名在白名单里。
 *     灾难命令必须逐次询问 —— 否则一个"自动化可用性"开关就把 AI-02/AI-03 建的安全闸门整片关掉。
 * @returns {boolean}
 */
export function canLoopAutoApprove({ allowlist, toolName, hard } = {}) {
  // 底线先判：灾难命令永不自动放行（顺序不能反 —— 反过来会让下面任何分支"顺手"放行它）
  if (hard === true) return false
  const al = Array.isArray(allowlist) ? allowlist : []
  if (al.length === 0) return false
  return loopAllowlistMatches(al, toolName)
}
