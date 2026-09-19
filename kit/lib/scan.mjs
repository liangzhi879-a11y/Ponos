// kit/lib/scan.mjs —— DevKit 的扫描基座（唯一入口）
//
// 设计不变量 I2：**扫描域 = git ls-files（已入库），不是磁盘遍历**。
// 为什么必须这样：`scratch/`（.gitignore:21 忽略）里有 claude-code 参考源码副本与 ponos-repo，
// 磁盘遍历会把**别人的代码**当成本仓源码 —— 实测那些副本里 `diff` / `@tanstack/react-virtual`
// 有大量 import，会直接翻转"未用依赖"的判定结论。
// 先例：scripts/check-doc-anchors.mjs 的 repoHas() 同样用 `git ls-files` 判定路径存在性，
// 理由是**门禁必须可复现**（本地因 gitignored 的 release/ 恰好存在而"绿"，干净克隆必然变红）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 参与依赖/版本判定的源码域（与 spec §6.2 一致；改成这里就必须同步改 spec 的数字） */
export const DOMAINS = ['src', 'electron', 'server', 'shared', 'kernel', 'scripts', 'build', 'pet', 'public', 'workflows']

/**
 * 根级配置文件：依赖通过这些文件被消费。
 * 没有这一类证据，`@tailwindcss/typography`、`@vitejs/plugin-react`、`tailwindcss`、`postcss`、
 * `autoprefixer`、`typescript`、`vite` 共 7 个会被**误判为未用**（实测）。
 */
export const CONFIG_FILES = [
  'vite.config.ts',
  'tailwind.config.ts',
  'postcss.config.js',
  'tsconfig.json',
  'tsconfig.node.json',
  'index.html',
  'electron-builder.yml',
  '.github/workflows/ci.yml',
]

const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/

/**
 * 列出文件（POSIX 分隔）。exec 可注入以便单测。
 *
 * `includeUntracked: true` ⇒ 域 = **索引 ∪ 未忽略的未跟踪文件**
 * （`git ls-files --cached --others --exclude-standard`）。**只给 `CT8`（工作树 ∖ HEAD 的在途差异）用**：
 * plan §6 D7 要求"磁盘有、索引无"的路由模块报黄灯提示，而默认口径（`git ls-files` = 索引）看不见它们
 * —— 审查实测：未 `git add` 的 `server/zzz-wip-routes.mjs` 对 CT8 **完全不可见**，报告还打印
 * "工作树契约面与 HEAD 一致"（`git status` 明明有 `??`），`git add` 之后立刻报出。
 *
 * ★ 这**不是**磁盘遍历（D4 明令禁止 `readdirSync`）：域仍由 git 给出（谁被忽略由 `.gitignore` 决定），
 *   `release/`、`kernel-dist/`、`node_modules` 这类镜像/产物目录**不在**结果里
 *   （它们被忽略，且里面那些 `*-routes.mjs` 是**副本**，卷进来就是"把副本当真相"）。
 *   契约**真值侧**（CT0–CT7/CT9 与 `kit:sync`）照旧用默认口径 —— 不变量 I2（扫描域 = 已入库文件）不变。
 */
export function trackedFiles({ root, gitBin = 'git', exec = execFileSync, includeUntracked = false } = {}) {
  if (!root) throw new Error('trackedFiles: 缺少 root')
  const args = includeUntracked
    ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    : ['ls-files', '-z']
  const out = exec(gitBin, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return String(out).split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
}

/** 顶层目录名即域 */
export function domainOf(file) { return String(file).split('/')[0] }

/** 测试文件判定（与 scripts/test-tiers.mjs 的 glob 口径一致） */
export function isTestFile(file) { return /\.test\.(mjs|cjs|js|jsx|ts|tsx)$/.test(String(file)) }

/** 域内的代码文件；默认排除测试文件（测试里的 import 不算生产消费证据） */
export function codeFiles(files, { includeTests = false } = {}) {
  return files.filter((f) => CODE_EXT.test(f) && (includeTests || !isTestFile(f)))
}

/** 按域过滤 */
export function inDomains(files, domains = DOMAINS) {
  const set = new Set(domains)
  return files.filter((f) => set.has(domainOf(f)))
}

/** 读取某个已跟踪文件（读不到返回 null，由调用方决定怎么报，不抛） */
export function readTracked({ root, file }) {
  try { return readFileSync(join(root, file), 'utf8') } catch { return null }
}

/**
 * 剥掉注释，返回源码的**代码视图**（`//` 行注释，以及斜杠星号 到 星号斜杠 的块注释；JSX 的注释块同属块注释）。
 *
 * 为什么需要它（实测）：`scripts/verify-knowledge-import-gui.mjs` 这类**源码级静态走查**在注释里
 * 也会看见关键字——审查在 `KnowledgeImportReport.tsx` / 对话框的**注释**里写
 * `import('@/lib/knowledgeApi')`（说明性文字）时脚本就**假红**了。注释不是代码，
 * 断言必须只看代码（本仓既有约定，先例：`server/transcript.test.mjs` 的源码守卫）。
 *
 * 判据（不许放宽的地方）：本函数**只改变"扫哪段文本"**，不改变任何断言的真值条件——
 * 真代码里的**值**导入（静态或动态 `import(…)`）照旧命中，`import type` 照旧放行。
 * 剥注释后仍留在代码视图里的 import 一定是真代码，故"值导入即红"一字未动。
 *
 * `//` / 斜杠星号 会不会被误剥：字符串字面量（`'…'`、`"…"`、`` `…` ``，含转义）内的内容**整体原样保留**，
 * 故 `'https://example.com'` 与"字符串里写着斜杠星号"这类内容都不会被误剥。
 * 块注释用空格占位并**保留其中的换行**（行首判据如 `^[ \t]*key:` 依赖换行，缺了会跨行误匹配）。
 *
 * 已知边界（如实写下，不假装能判）：① 不认正则字面量 —— `/[//]/` 这类写法里的 `//` 会被当行注释，
 * 其后同行内容丢失；② 不认 JSX 文本节点里的 `'`/`"` —— `<p>It's fine</p>` 的撇号会被当字符串起始，
 * 直到下一个同类引号为止的内容被当作字符串保留（即**该段内的注释不会被剥**，方向偏保守：宁可漏剥，不误剥）。
 * 两者对本次用途（组件 `.tsx` / 钩子 / 路由 `.mjs` 的 import 与 i18n key 扫描）实测无影响。
 */
export function stripComments(code) {
  const s = String(code)
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const d = s[i + 1]
    if (c === '/' && d === '/') { // 行注释：丢到行尾（换行本身由下一轮原样输出）
      i += 2
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') { // 块注释：保留其中的换行，末尾用空格占位避免两侧 token 粘连
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] === '\n') out += '\n'
        i++
      }
      i = Math.min(i + 2, s.length)
      out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') { // 字符串字面量：整体原样拷贝（含转义），其中的 // 与 /* 不算注释
      const start = i
      i++
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue }
        if (s[i] === c) { i++; break }
        i++
      }
      out += s.slice(start, Math.min(i, s.length))
      continue
    }
    out += c
    i++
  }
  return out
}
