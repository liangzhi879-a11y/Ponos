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
//     新提交自动重建；`marker.json` **最后写** ⇒ **单进程**下中断留下的半棵树不会被误认成可用缓存；
//   · **构建到私有目录、安装只做一步原子改名**（第 8 批加的，★ 见 installStaged 注释）：
//     只靠"marker 最后写"**不足以**应付**并发** —— 两个进程同时原地重建会互删半棵树，
//     而 marker 又可能落在被删过的那棵上 ⇒ **稳定假红**（实测：干净缓存 + 4 并发 check ⇒
//     2 个"红 0"、2 个"红 3"）。现在的做法是：构建全程在 `<目标>.tmp-<pid>-<rand>` 里完成（含 marker），
//     安装只做 `rename(tmp → 目标)`（同盘同父 ⇒ 原子）⇒ 读者只会看到"旧的完整 / 新的完整 / 没有"，
//     **看不到半棵**；"没有"的情形读者会自己重建，方向安全。
//   · **不可用不抛**：HEAD 读不到（空仓/非仓）→ `available:false` + `error`，由调用方**显式**报出来
//     （"读不到提交态"绝不能静默退化成"用工作树当真值还不说话"）。
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * 工作树是否与 HEAD **完全一致**（`git status --porcelain` 为空：无 staged / 无修改 / 无未跟踪文件）。
 * 用途（`contract-rules.mjs` 的 CT8）：一致时工作树侧契约面与提交态**必然相同** ⇒ 可跳过第二遍全量提取
 * （实测 ≈0.8 s；而 CI 与干净克隆走的正是这条路）。判据来自 git 本身，本模块不自己猜：
 * 出错（非仓/无 git）时返回 `false` ⇒ 调用方照常逐项比对（保守方向 = 宁可多跑一遍）。
 *
 * ★ 第 4 批（收口）：`status` 会被**索引标记**骗过 —— `git update-index --assume-unchanged` 或
 *   `--skip-worktree` 的文件改了内容也不出现在 `status` 里（审查实测：追加一个真端点后
 *   `worktreeClean=true` ⇒ 捷径跳过 ⇒ CT8 静默漏报）。故再加一条证据：索引里**每个条目都必须是普通
 *   `H`**（`git ls-files -v`；小写 = assume-unchanged，`S` = skip-worktree，其余 = unmerged/removed
 *   等异常态）—— 任一非 `H` 就按"不干净"处理。代价只是"多跑一遍全量提取"（≈0.8 s），
 *   换的是"绝不因索引标记而少报在途差异"（CT8 是只报不拦的黄灯，漏报等于丢信息）。
 */
export function worktreeClean({ root, exec = execFileSync } = {}) {
  try {
    if (String(git(['status', '--porcelain'], { root, exec })).trim() !== '') return false
    for (const line of String(git(['ls-files', '-v'], { root, exec })).split('\n')) {
      if (line && line[0] !== 'H') return false
    }
    return true
  } catch { return false }
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

/** 清掉同一仓的**其它** sha 目录（best-effort：失败不影响正确性，只影响磁盘）
 *
 * ★ 并发修复（第 8 批）：这里以前把同仓目录下**所有**其它目录都删掉，于是
 *   ① 删掉别人**正在用**的树（Windows 上直接 EBUSY/EPERM，POSIX 上按路径读不到）；
 *   ② 删掉别人**正在构建**的临时目录 ⇒ 对方 `rename` 时 ENOENT，构建白跑一轮。
 * 现在只清"**确实陈旧**"的：是个**装好的**树（有 marker）**且** mtime 早于 `STALE_MS`；
 * 临时目录（名字含 `.tmp-`/`.old-`）**一律不碰** —— 它们的主人会自己收尾。
 * 代价：同仓多个 sha 的缓存会多留一阵（占磁盘），换来"并发下不误删"。 */
const STALE_MS = 60 * 60 * 1000
function pruneSiblings(dir, cacheRoot) {
  try {
    const [repoKey] = dir.slice(cacheRoot.length + 1).split(/[\\/]/)
    const parent = join(cacheRoot, repoKey)
    const now = Date.now()
    for (const name of readdirSync(parent)) {
      // 别人正在构建/回收的临时件：碰它就是害人（它的主人的 rename 会失败）
      if (name.includes('.tmp-') || name.includes('.old-')) continue
      const p = join(parent, name)
      if (resolve(p) === resolve(dir)) continue
      try {
        if (now - statSync(p).mtimeMs < STALE_MS) continue   // 新鲜 ⇒ 可能有人正在用它
        if (!existsSync(join(p, MARKER_FILE))) continue      // 没有 marker ⇒ 不是装好的树，别乱删
        rmSync(p, { recursive: true, force: true })
      } catch { /* 别人的进程在用就算了 */ }
    }
  } catch { /* 目录不存在/不可读都不是错误 */ }
}

/**
 * 把构建好的 `staging` **原子**安装到 `dir`；返回 `true` 表示"复查发现别人已装好 ⇒ 用了现成的"。
 *
 * ★ 为什么必须原子安装（并发修复的核心）——重构前是"在最终目录里原地 `rmSync` + 重建"，
 *   两个进程同时跑会有两个方向的破坏：
 *     ① A 读到"不可用" → B 也读到"不可用" → B 的 `rmSync(dir)` 把 A 正在写的树删掉；
 *     A 的 `checkout-index` 继续写（或写进被 B 重建出来的目录）⇒ **半棵树**；
 *     ② 更糟：A 随后**写上 marker** ⇒ 之后的 `usable()` 看到"marker 在 + 首文件在"就判完整
 *     ⇒ **稳定假红**（实测：干净缓存 + 4 并发 `check` ⇒ 2 个"红 0 / EXIT=0"、2 个"红 3 / EXIT=1"）。
 *   现在构建全程在**私有** staging 里完成（marker 仍是最后写的），安装只做一步
 *   `rename(staging → dir)`：同盘同父的目录改名是**原子**的 ⇒ 读者只会看到
 *   "旧的完整树 / 新的完整树 / 没有"，**永远不会看到半棵**；看到"没有"时会自己重建，方向安全。
 */
function installStaged({ staging, dir, tree, marker, sha, fileCount }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    // 别人可能在这段时间里装好了（甚至已把我的 staging 当垃圾清掉）⇒ 优先用现成的
    if (usable(marker, tree, sha, fileCount)) {
      rmSync(staging, { recursive: true, force: true })
      return true
    }
    if (!existsSync(dir)) {
      try { renameSync(staging, dir); return false } catch { continue }   // 被别人抢先 ⇒ 下一轮会命中 usable
    }
    // dir 存在但不可用：中断残留、或旧版本留下的半棵树。
    // 把它**改名**移走（原子）而不是 rmSync —— 删除中途被别人读到就是"半棵"，改名后读到的是"没有"。
    const old = `${dir}.old-${process.pid}-${randomBytes(4).toString('hex')}`
    try { renameSync(dir, old) } catch { continue }
    try { rmSync(old, { recursive: true, force: true }) } catch { /* 收尾失败只影响磁盘 */ }
  }
  rmSync(staging, { recursive: true, force: true })
  throw new Error('HEAD 物化：并发安装连续被抢占（重试 5 次仍失败）')
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

    // 重建：全程在**私有 staging** 里做（read-tree 到临时索引、checkout-index 到 staging/tree/、
    // marker 最后写），构建完成后再整体**原子安装**（`installStaged`）。
    // ★ 绝不在最终目录里原地 `rmSync` + 重建：并发下会互删半棵树并留下"稳定假红"（见 installStaged 注释）。
    //   staging 名里带 pid + 随机数 ⇒ 两个并发进程各建各的、互不干扰；
    //   与目标同父同盘 ⇒ 最后那步 `rename` 才是原子的（跨盘 rename 会退化成复制 + 删除，失去原子性）。
    mkdirSync(cacheRoot, { recursive: true })
    const staging = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    rmSync(staging, { recursive: true, force: true })   // 极端情况：pid + 随机数撞上上次崩溃的残留
    mkdirSync(join(staging, 'tree'), { recursive: true })
    const env = { GIT_INDEX_FILE: join(staging, 'index') }
    git(['read-tree', ref], { root, env, exec })
    // ★ 检出时**关掉 eol 转换**（`core.autocrlf=false` / `core.eol=lf`）：物化树要的是 blob 的**原始字节**
    //   —— 提交态真值必须与 `git show HEAD:<file>` 逐字节一致（否则 Windows 上多一层 CRLF 转换，
    //   "同一份提交在两台机器上跑出不同结论"就成了新的不可复现源，而这正是本模块要消灭的东西）。
    git(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false',
      'checkout-index', '-a', '-f', '--prefix', join(staging, 'tree') + sep], { root, env, exec })
    // ★ marker **最后**写（单进程下的完整性凭据）；并发下靠的是**安装那一步的原子性**
    writeFileSync(join(staging, MARKER_FILE), `${JSON.stringify({ sha, ref, files: files.length, first: files[0] || '.', at: new Date().toISOString() }, null, 2)}\n`)
    const reused = installStaged({ staging, dir, tree, marker, sha, fileCount: files.length })
    pruneSiblings(dir, cacheRoot)
    return { available: true, dir: tree, files, sha, cached: reused, error: null }
  } catch (e) {
    return { available: false, dir: null, files: [], sha: null, cached: false, error: String(e && e.message ? e.message : e) }
  }
}
