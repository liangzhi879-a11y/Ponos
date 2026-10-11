// kernel/process-hygiene.mjs —— 过程文件归集的**执行层**（待办 860）
// ---------------------------------------------------------------------------
// 判据/目录约定/账本格式全在 `shared/process-artifacts.mjs`（纯函数，唯一真源）；
// 本文件只负责"按计划碰磁盘"，且把**安全**写在结构里：
//
//   ① **只移动，从不删除**。本模块里**一个删除类调用都没有**（单测 `process-hygiene.test.mjs`
//      直接扫本文件源码，出现任何删除 API 即红）：
//      "清理"= 从用户视野里挪走并留账，不是销毁。想真正腾空间，由用户自己删那个隐藏目录
//      （INDEX.md 明确写了"整目录可安全删除"）。
//   ② **git 状态读不到就不动**。`readTrackedPaths` 区分"不是 git 仓库"（正常，继续）与
//      "是仓库但读失败"（异常，**整批放弃**）。后者若照常执行，就可能把已入库文件搬走
//      ——一次误动就是用户 diff 里的一片红。
//   ③ **目标已存在即跳过**，绝不覆盖（归集与回退两侧同款判据）。
//   ④ 单文件失败（占用中/权限）只记该文件失败，不中断整批；账本里如实写 skipped。
//
// 触发方式（两条，互为兜底）：
//   · **自动**：`kernel/engine.mjs` 在轮次收尾且模型文本命中"收尾语"（已完成/以下是/请确认…）
//     时静默执行一次（不注入消息、不影响轮次结果，失败只打一行 stderr）；
//   · **手动**：`node kernel/cli.mjs --process <collect|restore|list> --add-dir <项目根> [--phase <名>]`
//     （由 `kernel/process-cli.mjs` 薄包装成 stdout JSON）。
//
// 边界（刻意不做，写在这里避免后来者以为是遗漏）：**不下钻子目录**。子目录里的
// `logs/app.log`、`data/*.bak` 完全可能是用户的真实数据，误伤代价远高于收益。用户若确实
// 想让某个子目录也归集，把文件挪到项目根一次即可（宁可少归类，不可误归类）。

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// execFile 的 Promise 版（2026-09-21 真异步改造）：`readTrackedPaths` 用它取代 execFileSync，
// 以免**同步阻塞内核事件循环**（详见该函数注释里的实测事故）。
const execFileAsync = promisify(execFile)
import { hideContainerSync } from '../shared/team-source.mjs'
import {
  PROCESS_LAYOUT, normalizePhaseName, processPhaseDir, processRoot, toPosixRel,
  planProcessCollection, planProcessRestore, mergeManifest, markRestored, renderProcessIndex,
} from '../shared/process-artifacts.mjs'

/** 系统隐藏属性每个进程只设一次（attrib 是子进程调用，不必每次归集都付）。 */
const hiddenDone = new Set()

function ensurePhaseDir(projectRoot, phase) {
  const container = join(String(projectRoot), PROCESS_LAYOUT.CONTAINER)
  const dir = processPhaseDir(projectRoot, phase)
  mkdirSync(dir, { recursive: true })
  // 自带的 `.gitignore`（内容 `*`）——让归集**不可能污染用户的 `git status`**。
  // 为什么不去改用户项目根的 .gitignore：那是用户的文件（可能已入库、可能有自己的规则），
  // 为一个临时目录去改它既越权又会在 diff 里留下噪音。放进目录内则完全自足：
  // git 读到本目录的 .gitignore 后，整棵 `.ponos/process/` 都不会出现在状态里，
  // 也不影响用户根 .gitignore 里任何既有规则。
  try {
    const ignore = join(processRoot(projectRoot), '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '# 过程文件归集目录（agent 一次性产物）：整目录不入版本控制\n*\n', 'utf8')
  } catch { /* 挡不住也无害：最坏结果是这些过程物出现在 git status 里（内容仍全在本目录） */ }
  if (!hiddenDone.has(container)) {
    hiddenDone.add(container)
    // Windows 上"点开头"不等于隐藏（资源管理器照常显示）——复用团队模式的既有实现。
    hideContainerSync(container)
  }
  return dir
}

/**
 * 扫描候选：**项目根一层**的文件名（不含目录；跳过符号链接与无法 stat 的项）。
 * 返回的文件名是"裸名"，深层判据交给纯函数（它还会再挡一次带分隔符的输入）。
 */
export function scanRootCandidates(projectRoot) {
  const root = String(projectRoot)
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const st = lstatSync(join(root, name))
      // 符号链接可能是"指向别处的真实文件"（归集它等于动别处的东西）⇒ 跳过。
      if (st.isSymbolicLink()) continue
      if (!st.isFile()) continue
      out.push(name)
    } catch { /* 权限/竞态：读不到就不当候选（宁可少归类） */ }
  }
  return out
}

/**
 * 读取 git 已跟踪的相对路径集合。
 *
 * 三态返回（**调用方必须区分**）：
 *   · `{ isRepo: false, ok: true }`  —— 不是 git 仓库：没有"已跟踪"概念，正常继续；
 *   · `{ isRepo: true,  ok: true }`  —— 正常拿到清单；
 *   · `{ isRepo: true,  ok: false }` —— 是仓库却读失败（dubious ownership / 索引损坏 / git 缺失）：
 *     **整批放弃**。这一支是"宁可少清理"的核心：读不到跟踪态时，我们无法排除任何文件
 *     已被入库，照常搬走就可能毁掉用户的 diff。
 */
export async function readTrackedPaths(projectRoot) {
  const root = String(projectRoot)
  // ★ 必须真异步（2026-09-21 失速事故，真异步版）：execFileSync/execSync 都会**同步阻塞
  // 整个事件循环**；而 git 在索引锁争用、磁盘近满、或被安全软件拦查时可能长时间不返回
  // —— 一卡就把内核所有 timer 一起冻住（实测事故：924s 静默期内连 30s 硬看门狗与 100s
  // 心跳都没跑过，进程零 TCP、CPU delta=0，直到事件循环解冻才触发退出）。
  // 这里**刻意不用缓存/预热**换非阻塞：本函数是"文件能不能搬"的安全闸门，拿到过期清单
  // 就可能把已被 git 跟踪的文件搬走、毁掉用户的 diff。宁可 await，也不拿陈旧数据做判断。
  // 失败/超时的走向与旧版逐字一致：抛错走下面 catch ⇒ "不是仓库"或"读失败 ⇒ 整批放弃"。
  const gitOpts = { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  let top
  try {
    top = String((await execFileAsync('git', ['rev-parse', '--show-toplevel'], gitOpts)).stdout).trim()
  } catch {
    return { isRepo: false, ok: true, tracked: new Set(), reason: 'not-a-repo' }
  }
  if (!top) return { isRepo: false, ok: true, tracked: new Set(), reason: 'not-a-repo' }
  try {
    const { stdout } = await execFileAsync('git', ['-C', top, 'ls-files', '-z'], { ...gitOpts, maxBuffer: 64 * 1024 * 1024 })
    const out = String(stdout)
    const tracked = new Set()
    for (const p of out.split('\0')) {
      if (!p) continue
      // 账本/判据里的路径一律相对**项目根**（不是 git 顶层）：项目根可能是仓库的子目录。
      const rel = toPosixRel(p)
      tracked.add(rel)
      // 同时登记"顶层相对路径"，供项目根就是顶层时直接命中（两种形态都放进集合，
      // 避免在这里做含混的路径前缀运算——多做一次比较的成本可以忽略）。
      tracked.add(rel.split('/').slice(1).join('/'))
    }
    tracked.delete('')
    return { isRepo: true, ok: true, tracked, reason: 'ok' }
  } catch (e) {
    return { isRepo: true, ok: false, tracked: new Set(), reason: `git-ls-files-failed:${e?.message || String(e)}` }
  }
}

/** 单文件元信息（大小 + 内容哈希）：回退时可比对"移回的确实是同一份内容"。 */
function probeFile(projectRoot, name) {
  try {
    const abs = join(String(projectRoot), name)
    const st = statSync(abs)
    return { bytes: st.size, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') }
  } catch {
    return { bytes: null, sha256: null } // 读不到就如实记 null，不编造
  }
}

/** 读账本（不存在/损坏 → null；损坏时**不**修复、**不**覆盖，由调用方决定）。 */
export function readProcessManifest(projectRoot, phase) {
  const file = join(processPhaseDir(projectRoot, phase), PROCESS_LAYOUT.MANIFEST)
  if (!existsSync(file)) return null
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** 列出所有已归集阶段（含每个阶段的条目数与最近更新时间），供 `--process list`。 */
export function listProcessPhases(projectRoot) {
  const root = processRoot(projectRoot)
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  const out = []
  for (const phase of names) {
    try { if (!lstatSync(join(root, phase)).isDirectory()) continue } catch { continue }
    const m = readProcessManifest(projectRoot, phase)
    out.push({
      phase,
      entries: Array.isArray(m?.entries) ? m.entries.length : 0,
      collected: Array.isArray(m?.entries) ? m.entries.filter((e) => e.status === 'collected').length : 0,
      updatedAt: m?.updatedAt || null,
    })
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

/** 写账本 + 索引（同一次归集里一起写，两者不可能漂移）。 */
function writeManifestAndIndex(projectRoot, phase, manifest) {
  const dir = ensurePhaseDir(projectRoot, phase)
  writeFileSync(join(dir, PROCESS_LAYOUT.MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(dir, PROCESS_LAYOUT.INDEX), renderProcessIndex(manifest), 'utf8')
  return dir
}

/**
 * 归集：把项目根一层的过程物移入 `<项目根>/.ponos/process/<阶段>/`。
 *
 * 返回值恒为**结构化结果**（绝不抛错给调用方去猜）：auto 路径在引擎轮尾调用它，
 * 归集失败绝不能影响那一轮的结果。
 * 2026-09-21 起为 **async**（真异步改造）：内部 git 读取不再同步阻塞事件循环，
 * 调用方必须 await；返回的仍是上面那个结构化结果，语义与失败走向均未变。
 * @param {{ projectRoot?: any, phase?: any, source?: string, now?: any }} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, phase:string, dir:string, collected:object[], skipped:object[], manifest?:any}>}
 */
export async function collectProcessArtifacts({ projectRoot, phase, source = 'unspecified', now = new Date().toISOString() } = {}) {
  const ph = normalizePhaseName(phase)
  const base = { ok: false, phase: ph, dir: '', collected: [], skipped: [] }
  if (!projectRoot || !existsSync(String(projectRoot))) return { ...base, reason: 'project-root-missing' }
  // ★ await 而非缓存：git 跟踪态是"能不能搬"的安全闸门（见 readTrackedPaths 注释）；
  // 读不到时仍走下面的 !git.ok 支 ⇒ 整批放弃（宁可少清理），绝不拿旧清单冒险搬运。
  const git = await readTrackedPaths(projectRoot)
  const candidates = scanRootCandidates(projectRoot)
  if (!git.ok) {
    return {
      ...base,
      reason: git.reason,
      skipped: candidates.map((p) => ({ path: p, reason: 'tracked-unknown', note: 'git 跟踪态读不到 ⇒ 整批放弃（宁可少清理）' })),
    }
  }
  const dir = processPhaseDir(projectRoot, ph)
  let existingTargets = []
  try { existingTargets = readdirSync(dir) } catch { /* 目录还不存在：没有同名冲突 */ }
  const plan = planProcessCollection({
    files: candidates, tracked: git.tracked, existingTargets, phase: ph, at: now, source,
    probe: (name) => probeFile(projectRoot, name),
  })
  const collected = []
  const skipped = [...plan.skipped]
  for (const mv of plan.collected) {
    try {
      ensurePhaseDir(projectRoot, ph)
      // 只 rename（同盘原子）；不 fallback 成"复制+删除"——那会在中途失败时留下两份，
      // 与"只移动、可回退"的口径不符。跨盘失败就如实记 skipped，用户可手动处理。
      renameSync(join(String(projectRoot), mv.from), join(String(projectRoot), mv.to))
      collected.push(mv)
    } catch (e) {
      skipped.push({ path: mv.from, reason: 'move-failed', note: String(e?.message || e) })
    }
  }
  if (!collected.length) {
    // 没有可归集的文件时**不建目录、不写账本**：空目录 + 空账本本身就是一种垃圾。
    return { ...base, ok: true, reason: 'nothing-to-collect', dir, collected, skipped }
  }
  const prev = readProcessManifest(projectRoot, ph)
  const manifest = mergeManifest(prev, { phase: ph, projectRoot, collected, skipped, at: now, source })
  writeManifestAndIndex(projectRoot, ph, manifest)
  return { ...base, ok: true, reason: 'collected', dir, collected, skipped, manifest }
}

/**
 * 回退：按账本把归集物移回原路径。
 * **原处已有文件 ⇒ 跳过不覆盖**；已回退过的条目跳过（幂等）。
 * @param {{ projectRoot?: any, phase?: any, now?: any }} [opts]
 */
export function restoreProcessArtifacts({ projectRoot, phase, now = new Date().toISOString() } = {}) {
  const ph = normalizePhaseName(phase)
  const base = { ok: false, phase: ph, restored: [], skipped: [] }
  if (!projectRoot || !existsSync(String(projectRoot))) return { ...base, reason: 'project-root-missing' }
  const manifest = readProcessManifest(projectRoot, ph)
  if (!manifest) return { ...base, reason: 'manifest-missing' }
  const exists = (rel) => existsSync(join(String(projectRoot), String(rel)))
  const plan = planProcessRestore({ manifest, exists })
  const restored = []
  const skipped = [...plan.skipped]
  for (const mv of plan.restored) {
    try {
      renameSync(join(String(projectRoot), mv.to), join(String(projectRoot), mv.from))
      restored.push(mv)
    } catch (e) {
      skipped.push({ from: mv.from, reason: 'move-failed', note: String(e?.message || e) })
    }
  }
  const next = markRestored(manifest, restored, now)
  writeManifestAndIndex(projectRoot, ph, next)
  return { ...base, ok: true, reason: restored.length ? 'restored' : 'nothing-to-restore', restored, skipped }
}
