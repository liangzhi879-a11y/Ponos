#!/usr/bin/env node
// kit/gui.mjs —— DevKit GUI 的唯一入口（**零依赖、不建 server、不监听端口**）
//
// 设计要点（每条都对应一个"看起来更省事但会出事"的做法）：
//   · **产物是静态 HTML**：默认写仓库根的 `kit-report.html`（`.gitignore` 已忽略 —— 生成物不入仓），
//     `file://` 双击即可打开。★ 刻意**不**起 HTTP server：一个只为看报告而起的端口会带来
//     "谁在占用端口 / 关了没 / 要不要鉴权"一整类与报告无关的问题，而报告本身不需要任何动态能力。
//   · **取数只走公开 JSON 出口**：`kit/cli.mjs check --json` 与 `view --json`（狗粮自己的契约）。
//     GUI 不直接读源码算契约 —— 那会造出第二个真相；页面与门禁不一致时，读者无法分辨谁对。
//   · **退出码语义**：本命令是**报告**工具 ⇒ 成功生成就 `exit 0`，即使门禁是红的（红 0 与否由
//     `kit:check` 判定，不在这里重复判）。但必须在输出里**显式**写出「门禁结论：红 N ⇒ EXIT=1」，
//     否则脚本调用方会把"gui 退出 0"读成"仓库是绿的"（这是最危险的一种误读）。
//   · **只读**：除写自己那份 HTML（以及 `--open` 让系统打开它）之外不写任何文件、不动 git。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_GUIDE, renderAgentGuideText } from './lib/agent-guide.mjs'
import { buildGuiData, collectGitInfo } from './lib/gui-data.mjs'
import { renderGuiHtml } from './lib/gui-html.mjs'

// 与 kit/cli.mjs 同源：允许测试/多仓场景覆盖根目录（默认 = 本文件上一级）
const ROOT = process.env.YFW_KIT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `用法：node kit/gui.mjs [选项]

  （无选项）              生成 kit-report.html（仓库根）并打印一行结果
  --out <path>            指定输出路径（默认 kit-report.html）
  --json                  把 buildGuiData 的结果打到 stdout（不写 HTML）
  --agent                 打印 agent 套件规范纯文本（单一真源 kit/lib/agent-guide.mjs）
  --open                  生成后用系统默认程序打开（失败只警告，不影响退出码）

退出码：生成/输出成功 → 0（**即使门禁是红的**：本命令是报告工具，红 0 由 npm run kit:check 判定）
        参数错误或取数失败（JSON 出口解析不了）→ 2
★ 本命令不建 server、不监听端口、不写 git；页面是自包含单文件，file:// 双击可用。`

/** 取数失败的统一出口（exit 2）：诊断信息必须**能定位**，所以带上退出码与输出前 200 字符 */
function die(message) {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { out: 'kit-report.html', json: false, agent: false, open: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) return { error: '--out 需要一个路径参数' }
      opts.out = v
      i++
    } else if (a === '--json') opts.json = true
    else if (a === '--agent') opts.agent = true
    else if (a === '--open') opts.open = true
    else if (a === '--help' || a === '-h') opts.help = true
    else return { error: `未知参数：${a}` }
  }
  return opts
}

/**
 * 跑 `kit/cli.mjs <sub> --json` 并解析 stdout。
 *
 * ★ 关键（P0 的实测坑）：`check` 有红灯时**退出码为 1，但仍打印完整 JSON**。
 *   把非零退出码当失败会让"仓库当前是红的"变成"GUI 生成不出来"——而那时恰恰最需要看报告。
 *   所以这里捕获异常后**解析 `e.stdout`**，并把真实退出码一路带到页面顶部的结论条。
 */
function runKitJson(sub) {
  let stdout = ''
  let status = 0
  try {
    stdout = String(execFileSync(process.execPath, ['kit/cli.mjs', sub, '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }))
    status = 0
  } catch (e) {
    stdout = e && e.stdout ? String(e.stdout) : ''
    status = typeof e?.status === 'number' ? e.status : 1
    if (!stdout.trim()) {
      const err = e && e.stderr ? String(e.stderr) : (e && e.message ? e.message : String(e))
      die(`取数失败：node kit/cli.mjs ${sub} --json 没有任何输出（exit=${status}）。\n  stderr：${err.split('\n')[0].slice(0, 200)}`)
    }
  }
  try {
    return { json: JSON.parse(stdout), exitCode: status }
  } catch {
    // 解析不了就**别猜**：把输出前 200 字符摊出来（否则"JSON.parse 失败"这句话等于没说）
    die(`取数失败：node kit/cli.mjs ${sub} --json 的输出不是合法 JSON（exit=${status}）。\n  输出前 200 字符：${stdout.slice(0, 200)}`)
  }
}

/** 用系统默认程序打开（失败只警告：打不开报告不该被当成命令失败） */
function openInShell(file) {
  const warn = (e) => console.error(`警告：无法自动打开 ${file}（${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 120)}）—— 文件已生成，手动打开即可`)
  try {
    if (process.platform === 'win32') {
      // `start` 是 cmd 内建命令；第一个引号参数会被当成窗口标题，故必须给一个空标题 `""`
      execFileSync('cmd', ['/c', 'start', '', file], { stdio: 'ignore' })
    } else if (process.platform === 'darwin') {
      execFileSync('open', [file], { stdio: 'ignore' })
    } else {
      execFileSync('xdg-open', [file], { stdio: 'ignore' })
    }
  } catch (e) {
    warn(e)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.error(`${opts.error}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  // --agent 只读规范，连门禁都不跑：agent 常常在开工**前**就要这份清单，
  // 那时跑 check 既慢（2.5s+）又多余（它的结论由"开工前 step 2"单独拿）
  if (opts.agent) {
    console.log(renderAgentGuideText(AGENT_GUIDE))
    return 0
  }

  const check = runKitJson('check')
  const view = runKitJson('view')
  const data = buildGuiData({
    root: ROOT,
    // 把**真实退出码**并进 checkJson：buildGuiData 优先用它（黄灯不拦时 ok:true 与 EXIT=0 必须一致）
    checkJson: { ...check.json, exitCode: check.exitCode },
    viewJson: view.json,
    gitInfo: collectGitInfo({ root: ROOT }),
  })

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
    return 0
  }

  const html = renderGuiHtml(data)
  const outPath = isAbsolute(opts.out) ? opts.out : resolve(ROOT, opts.out)
  try {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, html, 'utf8')
  } catch (e) {
    die(`写 HTML 失败（${outPath}）：${String(e && e.message ? e.message : e).slice(0, 200)}`)
  }
  const red = data.gate.summary.red
  const yellow = data.gate.summary.yellow
  // 口径：按**字节**算（`html.length` 是码元数，中文页面上两者差 20%+，报出去的"KB"要能对上 ls -l）
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  console.log(`已生成 ${outPath}（${kb} KB，红灯 ${red} / 黄灯 ${yellow}）`)
  // ★ 这行不能省：GUI 自己恒 exit 0，不写出真实门禁结论的话，脚本调用方会把"GUI 成功"
  //   读成"仓库是绿的"（`check` 的结论另有 `npm run kit:check` 的退出码负责）
  console.log(`门禁结论：红 ${red} ⇒ EXIT=${red === 0 ? 0 : 1}（数据源：node kit/cli.mjs check --json，其退出码 ${check.exitCode}）`)
  if (opts.open) openInShell(outPath)
  return 0
}

process.exit(main())
