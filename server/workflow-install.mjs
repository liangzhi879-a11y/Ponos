// server/workflow-install.mjs —— 内置工作流安装（独立模块）
//
// 为什么独立成模块（2026-09-11 Task 8）：bridge.mjs 顶层会 httpServer.listen(51517) 并带
// EADDRINUSE 自愈（会 taskkill 用户正在运行的应用）。测试若 import bridge.mjs 会真的起桥、
// 抢占/杀掉用户进程。安装逻辑抽到本模块后，测试只 import 本文件（无副作用）。
//
// 安装语义（按 version 比对，不再"存在即跳过"——旧版内置工作流在用户机上永远升不了级）：
//   目标不存在            → 安装（installed）
//   目标版本 != 源版本    → 先把旧文件备份成 <dstDir>/workflow.v<旧版>.bak.yml 再覆盖（updated）
//   目标版本 == 源版本    → 跳过（skipped）
// 返回 { installed, updated, skipped }：三者均为工作流 id 数组。
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// version 抓取：取 workflow.yml 顶层 `version:` 行（不完整解析 YAML——安装器只需版本号，
// 且要能读旧格式文件，故不能依赖 DSL v2 解析器）。
function readVersion(file) {
  try {
    return (readFileSync(file, 'utf-8').match(/^version:\s*(\S+)/m) || [])[1] || ''
  } catch { return '' }
}

export function installBuiltinWorkflows({ srcRoot, dstRoot }) {
  const out = { installed: [], updated: [], skipped: [] }
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
    const dstVer = existsSync(dstFile) ? readVersion(dstFile) : null
    try {
      if (dstVer === null) {
        mkdirSync(dstDir, { recursive: true })
        copyFileSync(srcFile, dstFile)
        out.installed.push(d.name)
      } else if (dstVer !== srcVer) {
        // 覆盖前备份（版本号进文件名，便于回滚/排查）；备份失败不阻断升级
        const bak = join(dstDir, `workflow.v${dstVer || '0'}.bak.yml`)
        try { copyFileSync(dstFile, bak) } catch { /* 备份失败仍继续覆盖 */ }
        copyFileSync(srcFile, dstFile)
        out.updated.push(d.name)
      } else {
        out.skipped.push(d.name)
      }
    } catch (e) {
      console.warn('[bridge] builtin workflow install failed:', d.name, '-', e?.message || e)
    }
  }
  return out
}
