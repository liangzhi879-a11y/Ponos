// S6 Batch B 便携布局核对：断言 release/YFWorking/ 结构完整（对齐 electron-builder extraResources 语义）
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
// exe 图标非默认（体积启发：注入品牌图标后 exe > 原始 electron.exe 少量）
const exe = join(R, 'electron', 'electron.exe')
if (existsSync(exe)) console.log('electron.exe', (statSync(exe).size / 1024 / 1024).toFixed(1), 'MB')
if (fail) { console.error(`便携布局核对失败：${fail} 项缺失`); process.exit(1) }
console.log('便携布局核对通过')
