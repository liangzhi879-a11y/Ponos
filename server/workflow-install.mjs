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
// 技能根 legacy 副本清理（Task 8 review C-1）：
//   旧版 bridge 把内置工作流装到技能根（<YFW_HOME>/skills），而内核把技能根排在
//   <configDir>/workflows **之前**（kernel/cli.mjs: workflowRoots = [...skillRoots, ...]），
//   故技能根里的 legacy 同名副本会永久遮蔽新装 v2 → 内置工作流恒返回 LEGACY_DSL。
//   对每个内置 id：若 legacyRoots 里存在 <legacyRoot>/<id>/workflow.yml，则备份为
//   <legacyRoot>/<id>/workflow.v<旧版>.legacy.bak.yml 后**删除**（删除是必要的：它会被优先发现）。
//
// 返回 { installed, updated, contentUpdated, skipped, legacyRemoved }：均为工作流 id 数组。
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
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

export function installBuiltinWorkflows({ srcRoot, dstRoot, legacyRoots = [] }) {
  const out = { installed: [], updated: [], contentUpdated: [], skipped: [], legacyRemoved: [] }
  if (!srcRoot || !dstRoot || !existsSync(srcRoot)) return out
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
