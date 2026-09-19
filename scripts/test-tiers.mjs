// scripts/test-tiers.mjs —— 测试分层口径的**单一真源**
// ---------------------------------------------------------------------------
// 被 `scripts/ci-preflight.mjs`（跑测试前）与 `scripts/check-doc-anchors.mjs`（文档口径门禁）共用。
// 抽出来的原因：两处都要回答"每一层有多少个测试文件"，若各写一份，改 glob 时极易只改一处，
// 于是"预检通过、门禁失败"（或反之）这种自相矛盾的状态就会出现，而且很难查。
//
// ⚠️ 本清单必须与 package.json 的 `test` / `test:unit` / `test:server` / `test:kernel` 保持一致。
// 新增一层测试目录时要同步**四处**（spec §7.1）：
//   ① 本文件的 TEST_GLOBS（并在这里的 TIER_SCRIPTS 补上"该层必须归属哪些脚本"）；
//   ② package.json 的 `test` 与 `test:unit`（以及对应分层脚本）里的 glob，并让 `test:ci` 链路带上它；
//   ③ docs/ci.md 的口径说明（本套口径的对外表述）；
//   ④ docs/_anchors.json（跑 `npm run anchors:write` 重新生成）。
// ①②的漏改已由 scripts/check-doc-anchors.mjs 的门禁 A/A′ 变成**硬失败**（2026-09-19 C4），
// ④的漏跑由门禁 A 的"TEST_GLOBS 有键而锚点无该键"方向覆盖。判据的两次收紧都留下了取证：
//   · A′ 由"glob 出现在**任一**脚本里"收紧为**逐脚本**校验 TIER_SCRIPTS 的归属；
//   · "CI 真的会跑它"按 package.json 的 `test:ci` **解析出的脚本名**判定（ciChainScripts），
//     且判据是 **token 精确匹配**：不写第二份 `CI_CHAIN_SCRIPTS` 常量（那是会漂移的真源，
//     实测会导致**误报**），也不用子串 `includes`（`test:unit:legacy` 会让它**漏报**）。
//   · 因为 CI 跑的是 test:ci（→ test:unit / test:server / test:kernel），**从不跑 `test`**。
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'

export const TEST_GLOBS = [
  'shared/**/*.test.mjs',
  'server/*.test.mjs',
  'electron/*.test.mjs',
  'kernel-tests/*.test.mjs',
  'src/**/*.test.ts',
  'kit/**/*.test.mjs',
]

/**
 * 层 → **必须**包含该层 glob 的 package.json 脚本。
 *
 * ★ 2026-09-19（Task 1 返工）：门禁 A′ 原先只做 `JSON.stringify(pkg.scripts).includes(glob)`，
 *   即"这个 glob 出现在**某个**测试脚本里就算过"，**不区分脚本**。实测：
 *   只从 `test:unit` 删掉 kit 层的 glob（`test` 仍保留）→ **EXIT=0**；
 *   而 CI 链路是 `test:ci → test:unit`（**从不跑 `test`**）→ kit 层在 CI 里静默不跑。
 *   "glob 出现在脚本里"与"CI 真的跑它"是两件事，所以映射必须逐脚本写清楚。
 *
 * 与 TEST_GLOBS **定义在同一处**（同一文件、紧邻），避免"层清单"与"脚本归属"两处真源再次漂移。
 * 新增一层测试时：在 TEST_GLOBS 加一行 + 在这里补它必须归属的脚本 + 改 package.json 对应脚本。
 */
export const TIER_SCRIPTS = {
  'shared/**/*.test.mjs': ['test', 'test:unit'],
  'server/*.test.mjs': ['test', 'test:server'],
  'electron/*.test.mjs': ['test', 'test:unit'],
  'kernel-tests/*.test.mjs': ['test', 'test:kernel'],
  'src/**/*.test.ts': ['test', 'test:unit'],
  'kit/**/*.test.mjs': ['test', 'test:unit'],
}

/**
 * 从 `test:ci` 的脚本体里解析出**实际会被串行执行**的 npm 脚本名。
 *
 * ★ 为什么不能另写一份 `CI_CHAIN_SCRIPTS = [...]` 常量（Task 1 二轮返工删除）：
 *   那是"第二份真源"，漂移的后果是**误报**（消息与事实相反）。实测：
 *   新增一层专用脚本 `test:kit`（glob 放进它），并在 `test:ci` 里**确实**追加
 *   `npm run test:kit` → 常量里没有 `test:kit`，旧口径仍报"只挂在 CI 不跑的脚本上"，
 *   门禁 EXIT=1 而事实是它已经被 CI 跑到。真源是 `package.json` 的 `test:ci`，
 *   就地从它解析，恒不失配。
 *
 * ★ 判据必须是 **token 精确匹配**（不能用 `body.includes(name)`）：
 *   实测把 `test:ci` 里的 `npm run test:unit` 改成 `npm run test:unit:legacy`
 *   （`test:unit` 脚本仍在，但 CI 不再跑它）时，子串判据 **EXIT=0** ——
 *   shared/electron/src/kit 四层在 CI 里静默不跑而门禁全绿。
 *
 * 做法：按 `&&` / `||` 切分脚本体，逐段取 token，脚本名必须是该段的
 * `npm [run] <name>` 形式（`<name>` 整体匹配，故 `test:unit:legacy` ≠ `test:unit`）。
 */
export function parseCiChain(body) {
  const out = []
  for (const seg of String(body || '').split(/\s*(?:&&|\|\|)\s*/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || tokens[0] !== 'npm') continue
    const name = tokens[1] === 'run' ? tokens[2] : tokens[1]
    if (!name || name.startsWith('-')) continue
    out.push(name)
  }
  return out
}

/** `test:ci` 实际串联的脚本名（真源 = package.json，不另存常量） */
export function ciChainScripts(scripts) {
  return parseCiChain((scripts || {})['test:ci'])
}

/** 把本文件用到的 glob 子集转成正则：支持双星号跨目录（写作 星号星号斜杠）与单星号（不跨目录） */
export function globToRe(glob) {
  return new RegExp('^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // 转义正则特殊字符（* 与 ? 留到后面单独处理）
    .replace(/\*\*\//g, '\u0000')           // 双星号斜杠先占位，避免被下一条的单星号规则吃掉
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?') +
    '$')
}

/** 列出 git 已跟踪文件（可注入 git 可执行文件路径以便测试） */
function listTracked(root, gitBin = 'git') {
  try {
    return execFileSync(gitBin, ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'))
  } catch {
    return []   // 非 git 环境（例如导出的源码包）——退化为 0，由调用方决定如何提示
  }
}

/**
 * 各层测试文件数 —— 只统计 **git 已跟踪** 的文件。
 *
 * 不用 glob 扫工作树的原因：工作树里可能有别人**尚未提交**的在途文件（本仓库同时跑多个任务），
 * 把它们算进来，锚点就记录了"只存在于本机"的数量，CI 在干净克隆上必然对不上而变红。
 * 已跟踪 = CI 上一定存在，口径才稳定。（新加测试文件 `git add` 后即被计入，
 * 不影响本门禁的真正职责：发现"整层消失 / glob 写错"。）
 */
export function trackedTestCounts(root, gitBin = 'git') {
  const tracked = listTracked(root, gitBin)
  const out = {}
  for (const g of TEST_GLOBS) {
    const re = globToRe(g)
    out[g] = tracked.filter((f) => re.test(f)).length
  }
  return out
}

/**
 * 各层测试文件数 —— 扫**工作树**（含未跟踪）。
 * 用途只有一个：检查"每条 glob 是否至少匹配到一个文件"。
 * 这里刻意用工作树而非 git：万一某层的文件全是新加的（还没 add），
 * 也要立刻发现 glob 失效，而不是等到提交之后。
 */
export function worktreeTestCounts(root) {
  const out = {}
  for (const g of TEST_GLOBS) {
    try { out[g] = globSync(g, { cwd: root }).length } catch { out[g] = -1 }
  }
  return out
}
