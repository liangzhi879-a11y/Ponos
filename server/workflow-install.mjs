// server/workflow-install.mjs —— 内置工作流安装（独立模块）
//
// 为什么独立成模块（2026-09-11 Task 8）：bridge.mjs 顶层会 httpServer.listen(51517) 并带
// EADDRINUSE 自愈（会 taskkill 用户正在运行的应用）。测试若 import bridge.mjs 会真的起桥、
// 抢占/杀掉用户进程。安装逻辑抽到本模块后，测试只 import 本文件（无副作用）。
//
// 安装语义（按 version 比对 + 内容指纹兜底，不再"存在即跳过"——旧版内置工作流在用户机上
// 永远升不了级）：
//   目标不存在              → 安装（installed）
//   目标版本 != 源版本      → 先备份成 <dstDir>/workflow.v<旧版>.bak.yml 再覆盖（updated）
//   版本相同但正文不同(*)   → 同样备份后覆盖（contentUpdated）
//   目标版本与正文都相同    → 跳过（skipped）
//   (*) 正文指纹忽略行尾空白：老用户机上残留的旧格式副本版本号常与新版相同（spec-dev 曾
//       长期为 1.0.0），仅比版本会漏升级。
//
// 用户删除记账（2026-09-17 修复 —— 删除后重启复活）：
//   病灶：上面「目标不存在 → 安装」使**删除内置工作流形同虚设**——面板里删掉、重启又被装回来，
//   用户侧表现为"删了还在，agent 照样能用"。删除动作本身没有留下任何痕迹，安装器无从知道
//   "这个 id 是用户主动删的"还是"从没装过"。
//   修法：删除时把 id 记进 `<dstRoot>/.builtin-deleted.json`（tombstone），安装器见到
//   **目标不存在 + 有记账** 即跳过（计入 skippedByUser）。三条约束是刻意的：
//     · 只在目标不存在时生效 —— 用户删后又自建同名工作流时走原版本比对，绝不误伤用户文件；
//     · 只在 id 确为内置时写入（markBuiltinDeleted 校验 <srcRoot>/<id>/workflow.yml 存在）；
//     · 记账文件以 `.` 开头 —— listWorkflowMetas 跳过 `.`/`_` 前缀，内核 discoverWorkflows
//       也只认目录与 .yml/.yaml，故它不会被当成工作流本体。
//   恢复：clearDeletedBuiltins({ dstRoot }) 清空（或删除该文件），下次安装即重新落地。
//
// 技能根 legacy 副本清理（Task 8 review C-1）：
//   旧版 bridge 把内置工作流装到技能根（<YFW_HOME>/skills），而内核把技能根排在
//   <configDir>/workflows **之前**（kernel/cli.mjs: workflowRoots = [...skillRoots, ...]），
//   故技能根里的 legacy 同名副本会永久遮蔽新装 v2 → 内置工作流恒返回 LEGACY_DSL。
//   对每个内置 id：若 legacyRoots 里存在 <legacyRoot>/<id>/workflow.yml，则备份为
//   <legacyRoot>/<id>/workflow.v<旧版>.legacy.bak.yml 后**删除**（删除是必要的：它会被优先发现）。
//
// 返回 { installed, updated, contentUpdated, skipped, skippedByUser, legacyRemoved }：均为工作流 id 数组。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// version 抓取：取 workflow.yml 顶层 `version:` 行（不完整解析 YAML——安装器只需版本号，
// 且要能读旧格式文件，故不能依赖 DSL v2 解析器）。
function readVersion(file) {
  try {
    return (readFileSync(file, 'utf-8').match(/^version:\s*(\S+)/m) || [])[1] || ''
  } catch { return '' }
}

// 正文指纹：忽略行尾空白（兼容 CRLF）后逐行拼接。读不到返回 null（视为不同 → 触发覆盖）。
function bodyFingerprint(file) {
  try {
    return readFileSync(file, 'utf-8').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).join('\n')
  } catch { return null }
}

/** 用户删除记账文件（`.` 前缀：既不进工作流列表，也不被内核发现逻辑当作本体）。 */
const deletedFile = (dstRoot) => join(dstRoot, '.builtin-deleted.json')

/** 读取「用户主动删除的内置工作流」清单。读不到/损坏 → 空表（等价于从未删除过）。 */
export function readDeletedBuiltins({ dstRoot } = {}) {
  if (!dstRoot) return []
  try {
    const v = JSON.parse(readFileSync(deletedFile(dstRoot), 'utf-8'))
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []
  } catch { return [] }
}

/**
 * 记账：用户删除了某个内置工作流。**仅在 id 确为内置时**写入（非内置 id 返回 false，
 * 不污染记账文件）。返回是否新写入（已记过 → false）。
 */
export function markBuiltinDeleted({ srcRoot, dstRoot, id } = {}) {
  if (!srcRoot || !dstRoot || !id) return false
  if (!existsSync(join(srcRoot, id, 'workflow.yml'))) return false
  const cur = readDeletedBuiltins({ dstRoot })
  if (cur.includes(id)) return false
  try {
    mkdirSync(dstRoot, { recursive: true })
    writeFileSync(deletedFile(dstRoot), JSON.stringify([...cur, id].sort(), null, 2), 'utf-8')
    return true
  } catch { return false }
}

/**
 * 清除删除记账（恢复内置工作流：下次安装即重新落地）。
 * ids 缺省/空 = 全部清除。返回是否真的改了盘。
 */
export function clearDeletedBuiltins({ dstRoot, ids = null } = {}) {
  if (!dstRoot) return false
  const cur = readDeletedBuiltins({ dstRoot })
  if (!cur.length) return false
  const want = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : []
  const next = want.length ? cur.filter((x) => !want.includes(x)) : []
  try {
    writeFileSync(deletedFile(dstRoot), JSON.stringify(next, null, 2), 'utf-8')
    return true
  } catch { return false }
}

export function installBuiltinWorkflows({ srcRoot, dstRoot, legacyRoots = [] }) {
  const out = { installed: [], updated: [], contentUpdated: [], skipped: [], skippedByUser: [], legacyRemoved: [] }
  if (!srcRoot || !dstRoot || !existsSync(srcRoot)) return out
  const deleted = readDeletedBuiltins({ dstRoot })
  let dirs = []
  try { dirs = readdirSync(srcRoot, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const srcFile = join(srcRoot, d.name, 'workflow.yml')
    if (!existsSync(srcFile)) continue
    const dstDir = join(dstRoot, d.name)
    const dstFile = join(dstDir, 'workflow.yml')
    const srcVer = readVersion(srcFile)

    // C-1：先清掉技能根里会遮蔽新版的 legacy 同名副本（备份后删除）
    for (const lr of Array.isArray(legacyRoots) ? legacyRoots : []) {
      if (!lr) continue
      const legacyFile = join(lr, d.name, 'workflow.yml')
      if (!existsSync(legacyFile)) continue
      const lv = readVersion(legacyFile) || '0'
      try { copyFileSync(legacyFile, join(lr, d.name, `workflow.v${lv}.legacy.bak.yml`)) } catch { /* 备份失败仍继续删除 */ }
      try {
        rmSync(legacyFile, { force: true })
        out.legacyRemoved.push(d.name)
      } catch (e) {
        console.warn('[bridge] legacy builtin workflow remove failed:', d.name, '-', e?.message || e)
      }
    }

    const dstVer = existsSync(dstFile) ? readVersion(dstFile) : null
    // 用户删除记账：**只在目标不存在时**跳过（2026-09-17）。目标存在时仍走下面的版本/指纹
    // 比对——否则用户删掉后自建的同名工作流会被一次"重启"静默接管。
    // 放在 legacy 清理之后是刻意的：用户已删除的工作流在技能根残留的旧副本同样要清掉，
    // 否则内核仍会优先发现它（删除就没删干净）。
    if (dstVer === null && deleted.includes(d.name)) {
      out.skippedByUser.push(d.name)
      continue
    }
    try {
      if (dstVer === null) {
        mkdirSync(dstDir, { recursive: true })
        copyFileSync(srcFile, dstFile)
        out.installed.push(d.name)
      } else if (dstVer !== srcVer) {
        // 覆盖前备份（版本号进文件名，便于回滚/排查）；备份失败不阻断升级
        try { copyFileSync(dstFile, join(dstDir, `workflow.v${dstVer || '0'}.bak.yml`)) } catch { /* 备份失败仍继续覆盖 */ }
        copyFileSync(srcFile, dstFile)
        out.updated.push(d.name)
      } else if (bodyFingerprint(srcFile) !== bodyFingerprint(dstFile)) {
        // 版本号相同但正文不同（老用户机上的旧格式副本即属此类）→ 仍要覆盖
        try { copyFileSync(dstFile, join(dstDir, `workflow.v${dstVer || '0'}.bak.yml`)) } catch { /* 同上 */ }
        copyFileSync(srcFile, dstFile)
        out.contentUpdated.push(d.name)
      } else {
        out.skipped.push(d.name)
      }
    } catch (e) {
      console.warn('[bridge] builtin workflow install failed:', d.name, '-', e?.message || e)
    }
  }
  return out
}
