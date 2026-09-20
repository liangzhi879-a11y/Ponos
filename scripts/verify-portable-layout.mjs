// S6 Batch B 便携布局核对：断言 release/YFWorking/ 结构完整（对齐 electron-builder extraResources 语义）
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// ★ DevKit 边界（CT12）：真源 + 唯一匹配实现（不在这里另写一份路径清单）
import { loadDevkit, devkitLeaks, resolveChannel } from '../kit/lib/devkit-rules.mjs'

const ROOT = process.cwd()
const R = join(ROOT, 'release', 'YFWorking')

// shared/ 必列：桥在模块求值期静态 import ../shared/*.mjs，缺了它是启动即失败
// 而非运行期降级（2026-09-14 便携包漏拷 shared/ ⇒ bridge ERR_MODULE_NOT_FOUND）。
const requiredDir = ['dist', 'electron', 'server', 'public', 'pet', 'pet/assets',
  'runtime/python', 'runtime/skills', 'runtime/agents', 'runtime/memory', 'runtime/tools',
  'kernel', 'shared', 'node_modules/electron']
const requiredFile = ['node.exe', 'YFWorking.vbs', 'YFWorking-debug.bat',
  'electron/electron.exe', 'electron/main.cjs', 'kernel/cli.mjs',
  'runtime/python/python.exe', 'public/icon.ico', 'public/icon.png', 'public/logo.png',
  // ★ agent 自动注入入口：工具开工自动读**仓根**同名文件；Ponos 内核也自动发现它
  //   （`kernel/prompt.mjs#discoverAgentsMd`：从 cwd 逐级向上 + `--add-dir` 的根）。
  //   ★ 用户口径（2026-09-20）：**人工测试跑的就是 release 里的便携版（调试版）** ⇒ 入口没进便携版，
  //   调试版里的 agent 就**不受规范约束**（静默失效）。它此前不在任何同步清单里 ⇒ 从不进便携版。
  'AGENTS.md']
let fail = 0
for (const d of requiredDir) if (!existsSync(join(R, d))) { console.error('MISSING DIR:', d); fail++ }
for (const f of requiredFile) if (!existsSync(join(R, f))) { console.error('MISSING FILE:', f); fail++ }
// 模板三组非空
for (const g of ['agents', 'memory', 'tools']) {
  const dir = join(R, 'runtime', g)
  if (!existsSync(dir) || readdirSync(dir).length === 0) { console.error('EMPTY templates:', g); fail++ }
}
// 快捷方式已建
const desktop = process.env.S6_TEST_DESKTOP || join(process.env.USERPROFILE || '', 'Desktop')
const lnk = join(desktop, 'YFWorking.lnk')
if (!existsSync(lnk)) { console.warn('WARN: 桌面快捷方式未找到（若在测试环境/重定向桌面可忽略）：', lnk) }
else console.log('OK 桌面快捷方式:', lnk)

// ── ★ DevKit 边界（CT12）：便携版里**不得出现开发门禁** ──────────────────────
// 用户口径（2026-09-20）：『确保正式打包不会带 devkit，也就是发行给用户的版本不带 kit 及相关配置』。
// 真源 = `kit/manifest/devkit.json`；匹配实现 = `kit/lib/devkit-rules.mjs`（只此一份，不在此另抄路径）。
//
// ★ 为什么这条落在"布局校验"而不是打包脚本里：`scripts/package-portable.cjs` 是 CJS（引不了 ESM 规则模块），
//   而本脚本就是**扫产物**的地方 —— 且 `build:portable` 已链上本脚本 ⇒ **打包即校验**，
//   不依赖谁记得手动跑一遍（"没人跑"是这类缺口得以长期存在的原因）。
//
// ★ 调试渠道例外：按真源 `devChannelAllow[]` 放行 `AGENTS.md`（CT11 要求人工测试环境里必须有这个
//   agent 入口）与 `kit-stamp.json`（盖章凭据）。⇒ 本渠道能且只能有这**两项**，`kit/` 本体与门禁文档必须缺席。
const devkit = loadDevkit()
if (!devkit.ok) {
  console.error('DevKit 真源读不到（kit/manifest/devkit.json）：', devkit.error)
  fail++
} else {
  const rels = []
  const scan = (rel, depth) => {
    if (depth > 2) return // devkit 命中都是"仓根相对"语义 ⇒ 最深到 `docs/xxx.md` 就够；顺手跳过 node_modules 控时
    for (const e of readdirSync(rel ? join(R, rel) : R, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      rels.push(r)
      if (e.isDirectory()) scan(r, depth + 1)
    }
  }
  scan('', 0)
  // ★ 渠道**由产物证据推导**，不许调用方自证（早先这里硬编码 `allowDevChannel: true` —— 那等于
  //   "这个脚本永远自称调试渠道"，与产物是不是调试版无关）。
  //   实测意义：把这个目录压成**正式**便携包、或发布前**清理凭据**（删 `.yfw-dev-source.json`）之后，
  //   渠道自动变 `release` ⇒ `AGENTS.md` 会被拦 ⇒ 本脚本红。这正是"发行版不带 devkit"的实际保障。
  const ch = resolveChannel({ target: R, files: rels }, devkit.devkit)
  const leaks = devkitLeaks(rels, devkit.devkit, { channel: ch.channel })
  if (leaks.length) {
    console.error(`DEVKIT LEAK: 便携版里有 ${leaks.length} 个开发门禁文件（发行物不该含 kit/ 及相关配置）`)
    console.error(`  渠道：${ch.channel} —— ${ch.evidence}`)
    for (const l of leaks.slice(0, 10)) console.error('  -', l.rel, '（命中', l.path, '）')
    if (leaks.length > 10) console.error(`  … 另有 ${leaks.length - 10} 个`)
    fail++
  } else {
    console.log(`OK DevKit 边界：扫描 ${rels.length} 项，无泄漏（渠道 ${ch.channel} —— ${ch.evidence}）`)
  }
}

// exe 图标非默认（体积启发：注入品牌图标后 exe > 原始 electron.exe 少量）
const exe = join(R, 'electron', 'electron.exe')
if (existsSync(exe)) console.log('electron.exe', (statSync(exe).size / 1024 / 1024).toFixed(1), 'MB')
if (fail) { console.error(`便携布局核对失败：${fail} 项缺失`); process.exit(1) }
console.log('便携布局核对通过')
