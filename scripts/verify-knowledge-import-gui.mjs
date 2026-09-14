// scripts/verify-knowledge-import-gui.mjs —— T6 文件知识库导入 GUI 链路静态走查（2026-09-14）
//
// 验收方式（tasks.md T6）= **构建通过 + 静态走查**。本仓库没有 DOM 测试环境，无法真机点对话框，
// 所以这里把"机器能判"的硬约束全部钉死，剩下的（视觉/交互手感）属人工走查，见报告。
//
// 钉的是一类**静默失败**：通道名/窗口名/字段名在其中一处拼错时，tsc 全绿、构建全绿、
// 界面照常渲染，只是点了没反应或参数被忽略（本项目高发）。这些错误只有"逐字比对三处字符串"
// 才能发现，所以宁可写得啰嗦，也不做模糊匹配。
//
// 覆盖：
//   1. IPC：main.cjs handler ↔ preload.cjs invoke ↔ 渲染层 window 名/方法名，三处逐字一致
//   2. API ↔ 路由：路径、动词、请求体字段、超时窗口（前端必须比后端宽）
//   3. i18n：导入用到的 key 在 zh-CN 与 en-US **两份**都在；JSX 里无硬编码中文
//   4. 入口可达：KnowledgeImportDialog ← KnowledgeSidebar ← KnowledgePanel（不是死代码）
//   5. 数据层纪律：组件只走 useKnowledge.importDocuments，导入后必须失效 tree/search 等缓存
//   6. 三档明细 / 只读空间排除 / 403 明确报错 / dryRun 预览入口
//
// 失败即退出码 1。**不要为了让本脚本通过而放宽这里的断言**：放宽 = 把静默失败放回生产。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

let failed = 0
const check = (cond, label) => {
  if (cond) console.log('ok: ' + label)
  else { console.error('FAIL: ' + label); failed++ }
}

// ── 1. 文件都在（缺文件时后续断言会刷屏，先给一条清晰的） ─────────────────────
const FILES = {
  main: 'electron/main.cjs',
  preload: 'electron/preload.cjs',
  dialog: 'src/components/knowledge/KnowledgeImportDialog.tsx',
  sidebar: 'src/components/knowledge/KnowledgeSidebar.tsx',
  panel: 'src/components/knowledge/KnowledgePanel.tsx',
  hook: 'src/hooks/useKnowledge.ts',
  api: 'src/lib/knowledgeApi.ts',
  route: 'server/knowledge-routes.mjs',
  zh: 'src/i18n/translations/zh-CN.ts',
  en: 'src/i18n/translations/en-US.ts',
}
for (const [k, rel] of Object.entries(FILES)) {
  check(existsSync(join(ROOT, rel)), `文件存在：${rel}（${k}）`)
}
const src = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]))

/**
 * 取 `exposeInMainWorld('<win>', { … })` 的对象字面量正文（花括号配对）。
 * 为什么不直接全文搜方法名：preload 里有五个 expose 块，**放错块里**是本项目真发生过的
 * 事故（app-api 注释里写着：插到隔壁 yfworkingWindow 就"点了没反应且不报错"）。
 * 只有把块切出来再看，才能证明"这个 API 确实挂在渲染层读的那个窗口名下"。
 */
function exposeBlock(code, win) {
  const head = `exposeInMainWorld('${win}'`
  const i = code.indexOf(head)
  if (i < 0) return null
  const open = code.indexOf('{', code.indexOf(',', i))
  if (open < 0) return null
  let depth = 0
  for (let p = open; p < code.length; p++) {
    const c = code[p]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return code.slice(open + 1, p) }
  }
  return null
}

// ── 2. IPC：三个通道逐字比对 ─────────────────────────────────────────────────
//
// 通道名写错是**最贵**的一类 bug：Electron 的 invoke 没有编译期校验，
// preload 发了 'dialog:pick-knowledge-file'（少个 s）而 main 挂的是 files → renderer 永远 pending 或 reject。
const CHANNELS = {
  'dialog:pick-knowledge-files': 'pickKnowledgeFiles',
  'dialog:pick-knowledge-folder': 'pickKnowledgeFolder',
}
const fileBlock = exposeBlock(src.preload, 'yfworkingFile')
check(!!fileBlock, "preload 暴露了 window.yfworkingFile（exposeInMainWorld 块可解析）")

for (const [ch, method] of Object.entries(CHANNELS)) {
  check(src.main.includes(`ipcMain.handle('${ch}'`), `main.cjs 注册 handler：${ch}`)
  check(
    !!fileBlock && new RegExp(`${method}\\s*:\\s*\\(\\s*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${ch}'\\)`).test(fileBlock),
    `preload 的 yfworkingFile.${method} → invoke('${ch}')（块内、逐字一致）`,
  )
  // 渲染层：window 名 + 方法名都要与 preload 一致
  check(new RegExp(`picker(?:\\.|\\?\\.)${method}\\b`).test(src.dialog), `渲染层调用 picker.${method}（名称与 preload 一致）`)
}
// 渲染层读的窗口名必须就是 preload 暴露的那个（as 断言也救不了写错的名字，只能靠这条）
const winNames = [...src.dialog.matchAll(/window\.(yfworking[A-Za-z]*)/g)].map(m => m[1])
check(winNames.length > 0, `渲染层从 window.<name> 取文件对话框 API（实际：${[...new Set(winNames)].join(', ') || '无'}）`)
check(winNames.every(n => n === 'yfworkingFile'), '渲染层取的窗口名 = preload 的 exposeInMainWorld 名（yfworkingFile）')
// 渲染层不得再自己造一份 as 断言类型：断言会把"名字写错"从 tsc 里藏起来
check(!/as unknown as \{ yfworkingFile/.test(src.dialog), '渲染层不 cast window（用 src/types 的全局声明，让 tsc 兜名字）')

// 多选文件 + 选目录两种能力都得在 main 侧真的实现（少一种 = 文件夹导入不可用，而"整批入库"正是主场景）
check(/dialog:pick-knowledge-files'[\s\S]{0,400}?multiSelections/.test(src.main), 'main.cjs：选文件支持多选（multiSelections）')
check(/dialog:pick-knowledge-folder'[\s\S]{0,400}?openDirectory/.test(src.main), 'main.cjs：选目录用 openDirectory')
check(/dialog:pick-knowledge-files'[\s\S]{0,1200}?result\.filePaths/.test(src.main), 'main.cjs：选文件返回 filePaths（不是 File 对象）')

// ── 3. API ↔ 路由（T4）逐字段对齐 ───────────────────────────────────────────
check(/export function importKnowledge/.test(src.api), 'knowledgeApi.ts 导出 importKnowledge')
check(/call<KnowledgeImportReport>\('\/knowledge\/import'/.test(src.api), "api 路径 = '/knowledge/import'")
check(/importKnowledge[\s\S]{0,400}?method:\s*'POST'/.test(src.api), 'api 动词 = POST')
check(/isPost && p === '\/knowledge\/import'/.test(src.route), '路由注册：POST /knowledge/import（server/knowledge-routes.mjs）')

// 请求体字段：接口里声明的每个字段，路由的 handleImport 都必须读它
// （字段名写错不会报错：路由当"没传"，于是落到默认空间/按非预览真写盘——最坏的一类静默降级）
const payloadFields = ['from', 'spaceId', 'name', 'dryRun', 'maxOcrPages']
const importPayload = /export interface KnowledgeImportPayload \{([\s\S]*?)\n\}/.exec(src.api)
check(!!importPayload, 'api 声明了 KnowledgeImportPayload（请求体形状有类型可查）')
for (const f of payloadFields) {
  check(!!importPayload && new RegExp(`\\b${f}\\??:`).test(importPayload[1]), `payload 字段存在：${f}`)
  // 路由侧：body.<field>（spaceId 允许 body.space 别名，路由注释里写明了两者都收）
  const read = f === 'spaceId' ? /body\.spaceId\b/.test(src.route) : new RegExp(`body\\.${f}\\b`).test(src.route)
  check(read, `路由读取请求体字段：body.${f}`)
}
check(/args\.push\('--src', f\)/.test(src.route), '路由把每个 source 摊成 `--src`（多源 = 多条）——改成 --from 会与内核既有 flag 撞名')
check(/body\.dryRun/.test(src.route) && /parseDryRun/.test(src.route), 'dryRun 走 parseDryRun（拼错的值宁可 400，不能当假值真写盘）')

// 超时窗口：前端必须**比后端宽**，否则用户只看到前端的"请求超时"，
// 拿不到服务端那句有意义的错误（含"已写入几篇"的上下文）。
const num = (code, name) => {
  const m = new RegExp(`const ${name} = ([^\\n]+)`).exec(code)
  if (!m) return null
  const js = m[1].replace(/\s|\/\*[\s\S]*?\*\//g, '')
  try { return Function(`return (${js})`)() } catch { return null }
}
const feTimeout = num(src.api, 'IMPORT_TIMEOUT_MS')
const beTimeout = num(src.route, 'IMPORT_TIMEOUT_MS')
check(typeof feTimeout === 'number' && feTimeout >= 5 * 60 * 1000, `前端导入超时 ≥ 5 分钟（实际 ${feTimeout}，含 OCR 的批次按分钟计）`)
check(typeof beTimeout === 'number' && typeof feTimeout === 'number' && feTimeout > beTimeout,
  `前端超时（${feTimeout}）> 服务端超时（${beTimeout}）：让服务端先给出有信息量的错误`)
check(/opts:\s*\{ timeoutMs: IMPORT_TIMEOUT_MS/.test(src.api), 'importKnowledge 真的用上了该超时（不是写在常量里没人用）')

// ── 4. i18n 两份对齐 + 无硬编码中文 ─────────────────────────────────────────
const usedKeys = [...new Set([...src.dialog.matchAll(/t\('(knowledge\.[A-Za-z]+)'/g)].map(m => m[1]))]
check(usedKeys.length >= 25, `对话框用到 ${usedKeys.length} 个 i18n key`)
for (const k of usedKeys) {
  const leaf = k.replace('knowledge.', '')
  const has = (code) => new RegExp(`\\n\\s*${leaf}:\\s*['"\`]`).test(code)
  check(has(src.zh), `zh-CN 有 ${k}`)
  check(has(src.en), `en-US 有 ${k}`)
}
// JSX 文本节点里的中文 = 英文界面下漏出中文（i18n 只在 {t(...)} 里生效）
const cjkText = [...src.dialog.matchAll(/>\s*([\u4e00-\u9fa5][^<>{}]*?)\s*</g)].map(m => m[1])
check(cjkText.length === 0, `对话框 JSX 无硬编码中文${cjkText.length ? ` → ${cjkText.join(' / ')}` : ''}`)
// main.cjs 的原生对话框标题：仓库既有风格不统一（知识包/技能包那两个是英文，另有 4 处中文），
// 故这里**只**对本次新增的两个知识导入对话框断言"与相邻的技能包/知识包 IPC 同风格"（英文），
// 不全文断言——那会把别人既有的中文标题也算成失败（改它属于越界）。
const kdStart = src.main.indexOf("ipcMain.handle('dialog:pick-knowledge-files'")
const kdEnd = src.main.indexOf("ipcMain.handle('dialog:open-skill-package'")
check(kdStart > 0 && kdEnd > kdStart, '两个知识导入对话框 handler 段可切出（files…open-skill-package 之间）')
const kdSection = kdStart > 0 && kdEnd > kdStart ? src.main.slice(kdStart, kdEnd) : ''
check(kdSection.includes("dialog:pick-knowledge-folder'"), '切出的段包含选目录 handler（两个都在）')
check(kdSection.length > 0 && !/title:\s*'[^']*[\u4e00-\u9fa5]/.test(kdSection), '知识导入对话框 title 无中文（与相邻 open-knowledge-pack 同风格）')

// ── 5. 入口可达（不是死代码） ───────────────────────────────────────────────
check(/import \{ KnowledgeImportDialog \} from '\.\/KnowledgeImportDialog'/.test(src.sidebar), 'Sidebar 引入 KnowledgeImportDialog')
check(/<KnowledgeImportDialog\b/.test(src.sidebar), 'Sidebar 渲染 <KnowledgeImportDialog />（入口真的挂上去了）')
check(/<KnowledgeSidebar\b/.test(src.panel), 'Panel 渲染 <KnowledgeSidebar />（从工作台可达）')
// 导入入口不依赖"已选中空间"：没空间的人（第一次用）正是主要用户
check(/KnowledgeImportDialog[\s\S]*?spaces=\{spaces\}/.test(src.sidebar), 'Sidebar 把 spaces 下发给对话框（新建/选已有都靠它）')

// ── 6. 数据层纪律 + 导入后刷新 ──────────────────────────────────────────────
check(/import \{ importDocuments \} from '@\/hooks\/useKnowledge'/.test(src.dialog), '对话框走 useKnowledge.importDocuments（写路径唯一入口）')
check(!/import \{[\s\S]{0,200}?importKnowledge[\s\S]{0,200}?\} from '@\/lib\/knowledgeApi'/.test(src.dialog),
  '对话框不直接调 knowledgeApi.importKnowledge（否则绕开缓存失效）')
check(/export async function importDocuments/.test(src.hook), 'useKnowledge 导出 importDocuments')
for (const [label, re] of [
  ['spaces（新空间/计数）', /invalidateKnowledge\(knowledgeKeys\.spaces\)/],
  ['tree（新文件必须立刻出现在树里）', /invalidateKnowledge\(`tree:\$\{space\}\|`\)/],
  ['search（刚导入就能搜到）', /invalidateKnowledge\('search:'\)/],
  ['graph（图谱多了一批节点）', /invalidateKnowledge\('graph:'\)/],
  ['stats（索引统计）', /invalidateKnowledge\(knowledgeKeys\.stats\)/],
]) {
  check(re.test(src.hook), `importDocuments 失效 ${label}`)
}
check(/r\.data\.dryRun \|\| !changed[\s\S]{0,80}?return r/.test(src.hook), 'dryRun / 全跳过时不失效缓存（预览是高频动作，不该触发重取）')
check(/const space = r\.data\.spaceId/.test(src.hook), '失效用后端回执的 spaceId（新建时前端只知道 name，id 是内核定的）')
// 宿主侧的兜底刷新（空间列表/统计）
check(/onImported=\{refreshAll\}/.test(src.panel), 'Panel 传 onImported={refreshAll}（空间列表/统计跟着变）')

// ── 7. 三档明细 / 只读空间 / 403 / dryRun ──────────────────────────────────
check(/report\.counts\.converted/.test(src.dialog) && /report\.counts\.skipped/.test(src.dialog) && /report\.counts\.failed/.test(src.dialog),
  '结果明细展示三档：成功 / 跳过 / 失败（P1-2 要能显示"跳过"，不是只有成功失败）')
check(/report\.failed/.test(src.dialog) && /e\.message \?\? e\.error/.test(src.dialog), '失败项带文件名 + 原因（P1-3：每一条都要能对上账）')
check(/e\.source/.test(src.dialog), '明细里带源文件名（source）')
check(/dryRun/.test(src.dialog) && /run\(true\)/.test(src.dialog) && /importPreview/.test(src.dialog), '提供 dryRun 预览入口（P2-2 对齐）')
check(/res\.status === 403/.test(src.dialog) && /importReadonlyHint/.test(src.dialog), '403（只读空间）有明确提示 + 处置建议（P3-1）')
check(/text-danger[\s\S]{0,200}?error/.test(src.dialog), '错误以 text-danger 显式渲染（不静默失败）')
check(/writable !== false/.test(src.dialog), '已有空间下拉排除只读空间（pack-* 在 GUI 层就选不到）')
check(/disabled=\{!writableSpaces\.length\}/.test(src.dialog), '一个可写空间都没有时禁用"导入到已有空间"（而不是让用户点了吃 403）')
check(/setSpace\(res\.data\.spaceId\)/.test(src.dialog), '导入成功后切到目标空间（否则树停在上一个空间，用户以为失败）')

// 设备降级：浏览器 dev 下没有窗口对话框 API → 按钮禁用 + 文案说明，不能点了没反应
check(/importNoDesktop/.test(src.dialog) && /disabled=\{!desktop/.test(src.dialog), '非桌面端：按钮禁用 + 明确文案')

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
