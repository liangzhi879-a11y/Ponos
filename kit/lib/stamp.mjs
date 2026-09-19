// kit/lib/stamp.mjs —— 给 dev 渠道盖章（spec §8 · 欠账 A1/A4）
//
// 调试版**保留不动**（D4）：它是开发基座 + 用户测试通道，docs/待处理清单.md 的每轮循环协议
// 第 8 条就写着"同步到调试版，给用户人工调试"。本模块只做一件事：让"用户正在测的这版
// 对应哪个 commit、含哪些产物、是否 dirty、距版本锚点差多少提交"永远可回答 —— 现在无法回答。
// 平台只加"身份"，不改调试版的任何工作方式（不改构建、不改启动、不改目录布局）。
//
// 产物落在 release/（.gitignore 覆盖）→ local-only，**不进 CI 门禁**（干净克隆没有 release/，
// 所以本模块的任何断言都不得依赖 release/ 存在）。
//
// ★ 与计划草图的三处**有意**偏差（草图是草图；行为契约以 kit/lib/stamp.test.mjs 为准）：
//   1. 草图里 `readFileSync ? require('node:fs').readdirSync(...) : []` 两处都错：`readFileSync`
//      是函数、恒为真（三元永远走前一支），且 ESM 下**没有 `require`**（一执行就 ReferenceError）。
//      这里直接 `import { readdirSync }`。
//   2. 草图只在 `write && info.commit` 时落盘 ⇒ 非 git 根下 `stamp` 会"退出码 0 但什么都没写"，
//      正是 kit/cli.mjs 自己警告过的最坏形态（调用方以为盖过了）。这里 `write` 为真就写，
//      commit 读不到就写 null：章的诚实性靠**字段可空**表达，不靠静默跳过。
//   3. 草图在"无 tag"时把 `ahead` 回退成 `rev-list --count HEAD`（= 全部提交数），
//      那是个**假锚点**（真仓会报出 4 位数，看的人会以为"落后很多"）。这里无 tag ⇒
//      `ahead: null` + `tag: null`：宁可说"没有锚点"，也不拿别的数字冒充。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'
import { readVersions } from './ledger.mjs'

/** 构建脚本实际写出的两处产物根（`npm run build` → dist/；`npm run build:kernel` → kernel-dist/） */
export const DEFAULT_ARTIFACTS = ['dist', 'kernel-dist']
/** 章的位置：release/ 被 .gitignore 覆盖 ⇒ local-only（不进 CI 门禁） */
export const STAMP_REL = 'release/YFWorking/kit-stamp.json'

/**
 * 跑一条 git 只读查询；失败（不在仓里 / 无 tag / 无 git）→ null。
 * `stdio` 里 stderr 走 ignore：`git describe` 在无 tag 时会把 `fatal: No names found`
 * 打到 stderr，那是**预期分支**而不是错误，不该污染 check/stamp 的输出。
 */
function git({ root, args }) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

/**
 * 收集 `rel`（文件或目录）下的文件列表；不存在 → `null`（由调用方记入 missing）。
 *
 * 路径一律以 `/` 拼接成**仓库相对、正斜杠**的形式：章是给人看/给脚本按 `/` 切分的 JSON，
 * 在 Windows 上写成 `dist\index.js` 会让下游按 `/` 找文件时找不到（同一份章两个平台读法不一致）。
 * 只收普通文件：符号链接不进清单（否则哈希的是链接目标，删掉链接目标后章照样"有效"）。
 */
function collectFiles({ root, rel }) {
  const abs = join(root, rel)
  if (!existsSync(abs)) return null
  if (statSync(abs).isFile()) return [rel]
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const r = `${d}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk(rel)
  return out.sort()   // 稳定顺序：两次盖章的 diff 只反映真实变化，而不是文件系统返回顺序
}

/**
 * 给 dev 渠道盖章。字段契约见 spec §8 / kit-stamp.test.mjs。
 * `write: false` 是干跑（一个字节都不写）；`now` 与 `artifactRoots` 可注入（否则不可测）。
 */
export function stampChannel({ root, now = new Date(), write = true, artifactRoots = DEFAULT_ARTIFACTS } = {}) {
  if (!root) throw new TypeError('stampChannel 需要 root：章的落点与 git 事实都必须挂在调用方指定的树上')

  // 版本字段**只**来自台账（单一真源）：盖章不再采集一份，否则"章里的版本"与"台账里的版本"
  // 就成了两份数据 —— 改一处漏一处，而章的用途正是事后追责。
  const versions = readVersions({ root })
  const versionOf = (id) => {
    const v = versions?.lines?.find((l) => l.id === id)?.value
    return v === undefined ? null : v
  }

  const status = git({ root, args: ['status', '--porcelain'] })
  const dirtyLines = status ? status.split('\n').filter(Boolean) : []
  const tag = git({ root, args: ['describe', '--tags', '--abbrev=0'] }) || null
  const aheadRaw = tag === null ? null : git({ root, args: ['rev-list', '--count', `${tag}..HEAD`] })
  const ahead = aheadRaw === null || aheadRaw === '' ? null : Number(aheadRaw)

  const artifacts = []
  const missing = []
  for (const rel of artifactRoots) {
    const files = collectFiles({ root, rel })
    if (files === null) { missing.push(rel); continue }
    for (const f of files) {
      const buf = readFileSync(join(root, f))
      artifacts.push({ path: f, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length })
    }
  }

  const info = {
    channel: 'dev',
    appVersion: versionOf('APP_VERSION'),
    kernelVersion: versionOf('KERNEL_VERSION'),
    guiVersion: versionOf('GUI_VERSION'),
    commit: git({ root, args: ['rev-parse', '--short', 'HEAD'] }),
    commitSubject: git({ root, args: ['log', '-1', '--pretty=%s'] }),
    // 已跟踪改动 vs 未跟踪文件分开计：合并成一个数就答不出"我改的东西进没进版本库"。
    // 注意 git 事实整体不可得时（commit === null）这里的 0/0 表示**未知**，不是"干净"——
    // 判据看 commit，不看 dirty。
    dirty: {
      tracked: dirtyLines.filter((l) => !l.startsWith('??')).length,
      untracked: dirtyLines.filter((l) => l.startsWith('??')).length,
    },
    tag,
    ahead,
    builtAt: now.toISOString(),
    artifacts,
    missing,
    stampFile: join(root, STAMP_REL),
  }

  // 原子写（shared/atomic-write.mjs）：半截的 kit-stamp.json 比没有章更危险 ——
  // 它长得像一份有效身份，却缺后半段字段。
  if (write) writeFileAtomicSync(info.stampFile, JSON.stringify(info, null, 2) + '\n')
  return info
}
