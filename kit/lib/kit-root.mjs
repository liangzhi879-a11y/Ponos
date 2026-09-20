// kit/lib/kit-root.mjs —— 门禁的「根目录」解析（DevKit · 让**调试版**里也能跑门禁）
//
// 为什么需要它（用户口径 2026-09-20：「开发是在调试版上运行的」）：
//   调试版（`release/YFWorking`，便携版）里要能跑 `node kit/cli.mjs check`。但门禁的**真值**是 git 提交态
//   （`scan.mjs#trackedFiles` = `git ls-files`；契约侧还要 `materializeHead` 物化 HEAD），
//   而便携版**不是 git 仓** ⇒ 只有 kit 代码还不够，"根目录指向哪"必须一起解决：
//     · 便携版在**仓库内部**（开发机上的常态，本仓 `release/` 被 gitignore）⇒ 在它里面跑 `git ls-files`
//       会向上找到仓库，但**列出的域是"该子目录下已入库文件" = 0 条** ⇒ 所有规则全红（假红，零信息量）；
//     · 便携版被**拷到仓库外** ⇒ `execFileSync('git', …)` 直接抛错 ⇒ CLI 崩。
//   ⇒ 判据必须是「**根是 git 仓的顶层**」（`rev-parse --show-toplevel` 等于自身）—— 只看"在不在某个仓里"
//     会把便携版误判成可用（它确实"在仓里"，但真值域是空的）。
//
// 解析顺序（**默认从严**，认不出来就明确失败，不静默拿一个读不到真值的根去跑）：
//   ① `YFW_KIT_ROOT` 显式指定（测试 / 多仓场景；最高优先 ⇒ 既有行为完全不变）；
//   ② 自身上一级目录**是 git 仓顶层** ⇒ 就地跑（在仓库里的常态，行为不变）；
//   ③ 自身带 dev-source marker（`.yfw-dev-source.json`，★ 与 CT12 判「调试渠道」用的是**同一份证据**，
//      marker 名从真源 `kit/manifest/devkit.json#channelEvidence` 取，不在这里另写一份）
//      且其 `sourceRoot` 是 git 仓顶层 ⇒ **指回源仓**：调试版里跑门禁 = 拿**源仓的提交态**真值
//      （与"在仓库里跑"逐字一致，因为便携版代码本来就是源仓的副本）；
//   ④ 都不成立 ⇒ `ok: false` + 一句能照着做的诊断。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDevkit } from './devkit-rules.mjs'

/** 该目录是不是**某个 git 仓的顶层**。不是（含 git 不可用）⇒ `null`。 */
export function gitTopLevel(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/** Windows 上大小写不敏感、分隔符混用 ⇒ 比较前先归一（否则"明明是同一个目录"却判不等）。 */
export function samePath(a, b) {
  const norm = (p) => resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 默认自身位置：`kit/lib/kit-root.mjs` 的上两级 = 仓/便携版根。 */
export function defaultHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

/** 从**真源**取 dev-source marker 的文件名（不在这里另写一份 —— 那是"同一件事两份清单"的老坑）。 */
export function devSourceMarkerName() {
  const dk = loadDevkit()
  if (!dk.ok) return null
  const markers = dk.devkit?.channelEvidence?.debug?.markers || []
  return markers.length ? String(markers[0]) : null
}

/**
 * 解析门禁根目录。
 * @returns {{root: string, source: 'env'|'repo'|'dev-source', ok: boolean, why: string}}
 *   `source` 供调用方决定是否提示（调试版指回源仓时值得说一句）。
 */
export function resolveKitRoot({ here = defaultHere(), env = process.env } = {}) {
  const explicit = env.YFW_KIT_ROOT
  if (explicit) {
    return { root: resolve(explicit), source: 'env', ok: true, why: 'YFW_KIT_ROOT 显式指定' }
  }
  const top = gitTopLevel(here)
  if (top && samePath(top, here)) {
    return { root: here, source: 'repo', ok: true, why: '自身就是 git 仓顶层' }
  }

  // ③ 调试版：自身不是 git 顶层 —— 看 dev-source marker 里记的源仓
  const markerName = devSourceMarkerName()
  const markerPath = markerName ? join(here, markerName) : null
  if (markerPath && existsSync(markerPath)) {
    let sourceRoot = null
    try { sourceRoot = JSON.parse(readFileSync(markerPath, 'utf8'))?.sourceRoot || null } catch { sourceRoot = null }
    if (sourceRoot && existsSync(sourceRoot) && samePath(gitTopLevel(sourceRoot) || '', sourceRoot)) {
      return {
        root: resolve(sourceRoot), source: 'dev-source', ok: true,
        why: `调试版（${markerName}）⇒ 门禁真值取自源仓`,
      }
    }
    return {
      root: here, source: 'dev-source', ok: false,
      why: `便携版带了 ${markerName}，但里面的 sourceRoot 不是可用的 git 仓顶层`
        + `（读到 ${sourceRoot ? `"${sourceRoot}"` : '空'}）⇒ 取不到提交态真值`,
    }
  }

  return {
    root: here, source: 'none', ok: false,
    why: '这里的门禁真值来自 git 提交态（`git ls-files` + HEAD），而当前根目录**不是 git 仓的顶层**'
      + '（便携版/解压出来的副本就属于这种情况）',
  }
}

/** 失败时的可照做诊断（CLI 与 GUI 共用一份措辞，免得两处越走越远）。 */
export function rootFailureHint(info) {
  return [
    `kit: 无法确定可用的门禁根 —— ${info.why}`,
    `  当前判定根：${info.root}`,
    '  怎么办（任选其一）：',
    '    · 在仓库里跑：cd <仓库根> && node kit/cli.mjs check',
    '    · 或指到仓库：YFW_KIT_ROOT=<仓库根> node kit/cli.mjs check',
    '    · 调试版应带 .yfw-dev-source.json（其 sourceRoot 指向源仓）—— 缺了就取不到真值',
  ].join('\n')
}
