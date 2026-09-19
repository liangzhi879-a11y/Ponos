// kit/lib/head-tree.mjs —— 提交态（HEAD）物化：契约规则的**唯一真值来源**（DevKit P1 第 3 批）
//
// ★ 为什么需要它（第 2 批审查的结论）：
//   第 2 批把台账 `channels` 按 committed 落盘，但**规则侧仍读工作树** ⇒ 主树上他人在途改动
//   与台账产生差异，只能靠 `drift-baseline.json` 加"红灯基线"吸收。审查实测出两个真漏洞：
//     ① 基线按**真实端点键**认领 ⇒ `ANY /app-info` 这类键的 CT1 差异在**任意方向**被永久降级
//        （把该端点写进台账而代码根本没有 → 仍 EXIT=0）；
//     ② 计数型 subject（`routes 多登记 1 条`）⇒ 能认领**任意同类**单条多登记。
//   ⇒ 修法不是"更好地用基线"，而是让**门禁与工作树脏不脏无关**：两侧都取 committed。
//
// ★ 机制选择（"等价的提交态读取"）：把 HEAD 物化成一份**临时干净检出**，规则在它上面跑。
//   为什么不是逐个 `git show HEAD:<file>`：契约提取里有两类事实**不是文件文本** ——
//     ① `extractTools` 的运行时出口 `(await import('kernel/tools.mjs')).createToolRegistry({cwd}).toolSchemas()`
//        （模型真正看到的那份 schema，靠执行才能拿到）；
//     ② 提取器的**文件集**本身（`git ls-files` 是索引：他人 `git add` 过的新文件也在里面）。
//   物化一份 HEAD 检出后，`readTracked` / `trackedFiles` / 动态 import 三者在同一棵**提交态树**上
//   自洽，无需给每个提取器各加一套"提交态读取"接口（改动面最小、语义唯一）。
//
// ★ 三条纪律：
//   · **只写系统临时目录**：check 对仓库**只读**（不碰工作树、不碰 `.git/`；`GIT_INDEX_FILE` 指到临时目录）；
//   · **缓存按 (仓路径, sha) 键控**：同 sha 直接命中（否则每跑一次门禁就写一份 35MB 检出），
//     新提交自动重建；`marker.json` **最后写** ⇒ 中断留下的半棵树不会被误认成可用缓存；
//   · **不可用不抛**：HEAD 读不到（空仓/非仓）→ `available:false` + `error`，由调用方**显式**报出来
//     （"读不到提交态"绝不能静默退化成"用工作树当真值还不说话"）。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** 默认缓存根（系统临时目录；`YFW_KIT_HEAD_CACHE` 可覆盖 —— 测试与排查用） */
const DEFAULT_CACHE_ROOT = () => process.env.YFW_KIT_HEAD_CACHE || join(tmpdir(), 'yfw-kit-head')
/** 物化树的完成标记（**最后写**：它的存在即"这棵树是完整的"） */
export const MARKER_FILE = 'marker.json'
/** 默认引用（提交态） */
export const HEAD_REF = 'HEAD'

/** 跑 git（同步、可注入 —— 测试用真 git，注入只为把错误路径也覆盖到） */
function git(args, { root, env = undefined, encoding = 'utf8', exec = execFileSync } = {}) {
  // ★ stderr **一律接管**：失败时（空仓的 `rev-parse HEAD`、非 git 目录…）git 的报错由本模块
  //   折进 `available:false.error` 交给调用方**显式**报出，不让它顺手泼到用户终端上
  //   （否则 `check --json` 的 stdout 旁边会多出几行 git 噪声，连 JSON 都解析不了）。
  return exec('git', args, {
    cwd: root, env: env ? { ...process.env, ...env } : undefined,
    encoding, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe',
  })
}

/** HEAD 的 sha（缓存键的来源） */
export function headSha({ root, ref = HEAD_REF, exec = execFileSync } = {}) {
  return String(git(['rev-parse', ref], { root, exec })).trim()
}

/** HEAD 的已入库文件清单（POSIX 分隔）—— **不是** `git ls-files`（那是索引，含他人 `git add` 的新文件） */
export function headFiles({ root, ref = HEAD_REF, exec = execFileSync } = {}) {
  const out = git(['ls-tree', '-r', '-z', '--name-only', ref], { root, exec })
  return String(out).split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
}

/**
 * 缓存目录：`<cacheRoot>/<仓路径 hash>/<sha 前 12>`。
 * 键里带 sha ⇒ 不同提交不共用目录（并发/中断都不会踩到别人的树），带仓 hash ⇒ 主树与克隆不互扰。
 */
export function headTreeDir({ root, sha, cacheRoot = DEFAULT_CACHE_ROOT() } = {}) {
  const key = createHash('sha1').update(resolve(String(root))).digest('hex').slice(0, 12)
  return join(cacheRoot, key, String(sha).slice(0, 12))
}

/** marker 是否证明"这棵树是 sha 对应的完整检出" */
function usable(markerPath, treeDir, sha, files) {
  try {
    const m = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (m.sha !== sha || m.files !== files) return false
    return existsSync(join(treeDir, files.length ? String(m.first) : '.'))
  } catch { return false }
}

/** 清掉同一仓的**其它** sha 目录（best-effort：失败不影响正确性，只影响磁盘） */
function pruneSiblings(dir, cacheRoot) {
  try {
    const [repoKey] = dir.slice(cacheRoot.length + 1).split(/[\\/]/)
    const parent = join(cacheRoot, repoKey)
    for (const name of readdirSync(parent)) {
      const p = join(parent, name)
      if (resolve(p) === resolve(dir)) continue
      try { rmSync(p, { recursive: true, force: true }) } catch { /* 别人的进程在用就算了 */ }
    }
  } catch { /* 目录不存在/不可读都不是错误 */ }
}

/**
 * 把 `ref`（默认 HEAD）物化成一份临时干净检出。
 * @param {{root:string, ref?:string, cacheRoot?:string, exec?:Function}} p
 * @returns {{available:boolean, dir:string|null, files:string[], sha:string|null, cached:boolean, error:string|null}}
 *   `available:false` 时 `dir:null`、`files:[]` —— 调用方必须**显式**处理（不许静默拿工作树顶替）。
 */
export function materializeHead({ root, ref = HEAD_REF, cacheRoot = DEFAULT_CACHE_ROOT(), exec = execFileSync } = {}) {
  if (!root) throw new Error('materializeHead: 缺少 root')
  try {
    const sha = headSha({ root, ref, exec })
    const files = headFiles({ root, ref, exec })
    if (!sha) throw new Error(`${ref} 解析为空（仓里可能还没有提交）`)
    const dir = headTreeDir({ root, sha, cacheRoot })
    const tree = join(dir, 'tree')
    const marker = join(dir, MARKER_FILE)
    if (usable(marker, tree, sha, files.length)) return { available: true, dir: tree, files, sha, cached: true, error: null }

    // 重建：先清旧（中断留下的半棵树），再 read-tree 到**临时索引**、checkout-index 到 tree/
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(tree, { recursive: true })
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    git(['read-tree', ref], { root, env, exec })
    // ★ 检出时**关掉 eol 转换**（`core.autocrlf=false` / `core.eol=lf`）：物化树要的是 blob 的**原始字节**
    //   —— 提交态真值必须与 `git show HEAD:<file>` 逐字节一致（否则 Windows 上多一层 CRLF 转换，
    //   "同一份提交在两台机器上跑出不同结论"就成了新的不可复现源，而这正是本模块要消灭的东西）。
    git(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false',
      'checkout-index', '-a', '-f', '--prefix', tree + sep], { root, env, exec })
    // ★ marker **最后**写：它存在 ⟺ 上面两步都跑完了
    writeFileSync(marker, `${JSON.stringify({ sha, ref, files: files.length, first: files[0] || '.', at: new Date().toISOString() }, null, 2)}\n`)
    pruneSiblings(dir, cacheRoot)
    return { available: true, dir: tree, files, sha, cached: false, error: null }
  } catch (e) {
    return { available: false, dir: null, files: [], sha: null, cached: false, error: String(e && e.message ? e.message : e) }
  }
}
