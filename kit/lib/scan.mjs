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

/** 列出 git **已跟踪** 文件（POSIX 分隔）。exec 可注入以便单测。 */
export function trackedFiles({ root, gitBin = 'git', exec = execFileSync } = {}) {
  if (!root) throw new Error('trackedFiles: 缺少 root')
  const out = exec(gitBin, ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
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
