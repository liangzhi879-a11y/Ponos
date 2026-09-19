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
// ── 2026-09-19（P1 · pendingFix 修绿）：断言已按现行结构重写，并**顺势加强** ─────────
// 原脚本有 7 项失败，全部是"行为已实现、位置/写法已变"（不是被测代码有 bug）：
//   ① i18n key 数（当时写 ≥25，实测 22）：key 随明细渲染抽到了子组件
//      `src/components/knowledge/KnowledgeImportReport.tsx`（2026-09-14 抽出）；
//   ② `import { importDocuments } from '@/hooks/useKnowledge'` 的**恰好一项**正则过刚
//      （现在同一语句里还有 `importDocumentsTracked`，用于可追踪的批量导入）；
//   ③④ hook 里 `r.data.*` → `data.*`（参数改名，逻辑仍在）：钉变量名的正则属"实现细节腐烂"；
//   ⑤⑥⑦ 三档明细 / 失败原因 / 源文件名：渲染抽到子组件后，断言的目标文件过时。
// 修法 = **只改脚本**，且每条不变量都保留；并按下述三点加强（不是"最小改写"）：
//   · i18n 与"JSX 硬编码中文"检查**同时覆盖对话框与报告子组件**（原来只扫对话框）；
//   · 「组件不得直连 knowledgeApi」同样约束子组件 —— 且收紧为"从 knowledgeApi 只许
//     import type"，比原来那条"别出现 importKnowledge 字样"的正则强（后人写
//     `import { listDocIds } …` 也会红）；
//   · hook 的两条改成**在 `invalidateAfterImport` 函数体内**断言语义（dryRun 早退分支 +
//     用回执 spaceId），而不是全文搜一个变量名；并补上同函数内另外几类键的失效。
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
  // 明细渲染（三档计数 / 失败原因 / 源文件名）2026-09-14 抽到本子组件；
  // 它与对话框同属"导入这条链路"，故 i18n、硬编码中文、直连 knowledgeApi 三条不变量都一并覆盖它。
  report: 'src/components/knowledge/KnowledgeImportReport.tsx',
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

/**
 * 切出 `function <name>(…) { … }` 的函数体（花括号配对）。
 * 为什么需要它：hook 里 `invalidateKnowledge('search:')` 这类调用在别处也有（删/还原路径），
 * 全文搜到的"有这一行"证明不了"**导入**之后会失效它"。只有把函数体切出来断言，判据才落在
 * 导入这条语义上。同理它也把"钉变量名"换成"钉这个函数里确实有 dryRun 早退分支"。
 */
function bodyOf(code, name) {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(code)
  if (!m) return null
  const open = code.indexOf('{', m.index)
  if (open < 0) return null
  let depth = 0
  for (let p = open; p < code.length; p++) {
    const c = code[p]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return code.slice(open + 1, p) }
  }
  return null
}

/**
 * 取出某文件里 `from '<mod>'` 的那些 import 语句的**说明符原文**列表。
 * 用途：「组件不得直连 knowledgeApi」这条不变量要按"导入了什么"判，而不是按关键字出现与否判。
 */
function importSpecifiers(code, mod) {
  const out = []
  for (const m of code.matchAll(/import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (m[2] === mod) out.push((m[1] || '').trim())
  }
  return out
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
//
// 扫描范围 = 对话框 **+** 明细报告子组件（2026-09-19 加强：原来只扫对话框，于是
// `KnowledgeImportReport.tsx` 里新加的 key / 硬编码中文**完全不受门禁约束** —— 那正是抽组件留下的盲区）。
// 两份源码合看：key 在哪个文件用不重要，重要的**用到的每个 key 都必须花两份 locale 里都存在**。
const I18N_SOURCES = [['dialog', src.dialog], ['report', src.report]]
const usedKeys = [...new Set(I18N_SOURCES.flatMap(([, code]) =>
  [...code.matchAll(/t\('(knowledge\.[A-Za-z0-9_]+)'/g)].map(m => m[1])))].sort()
// key 计数只是"防止整块 i18n 被删空"的护栏（真正的实质断言是下面逐 key 的两份存在性）。
// 下限取**两个文件的并集实测值**（2026-09-19 实测 35），不沿用抽组件前的 25 那个经验值 ——
// 那个数既拦不住"删空"（22 也远大于它的一半）又已与现状不符。合并两份后新增 key 不会红，
// 删到并集以下才会：这正是"护栏"该有的松紧。
const KEY_FLOOR = 35
check(usedKeys.length >= KEY_FLOOR,
  `对话框 + 报告组件用到 ${usedKeys.length} 个 i18n key（护栏下限 ${KEY_FLOOR} = 两文件并集实测值）`)
for (const k of usedKeys) {
  const leaf = k.replace('knowledge.', '')
  // 行首空白用 [ \t]*（不用 \s*：后者会跨行匹配到上一行的结尾，把"上一行有同名 key"也当命中）
  const has = (code) => new RegExp(`^[ \\t]*${leaf}:\\s*['"\`]`, 'm').test(code)
  check(has(src.zh), `zh-CN 有 ${k}`)
  check(has(src.en), `en-US 有 ${k}`)
}
// JSX 文本节点里的中文 = 英文界面下漏出中文（i18n 只在 {t(...)} 里生效）。
// 两个渲染文件各自断言，失败信息里带上**是哪个文件**（否则抽组件后不知道该去哪改）。
for (const [name, code] of I18N_SOURCES) {
  const cjkText = [...code.matchAll(/>\s*([\u4e00-\u9fa5][^<>{}]*?)\s*</g)].map(m => m[1])
  check(cjkText.length === 0, `${name} 的 JSX 无硬编码中文${cjkText.length ? ` → ${cjkText.join(' / ')}` : ''}`)
}
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
// 写路径唯一入口：从 hook 里 import `importDocuments`（原断言要求**恰好**是那一项，过刚：
// 2026-09-14 加了 `importDocumentsTracked`（可追踪的批量导入，同一份失效逻辑），
// 语义没变 ⇒ 改为"名单里必须含 importDocuments，且**每个**具名导入都必须是 hook 真导出的"。
const hookImports = importSpecifiers(src.dialog, '@/hooks/useKnowledge')
const namedFromHook = hookImports.flatMap(s => s.replace(/^\{|\}$/g, '').split(','))
  .map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean)
check(hookImports.some(s => /\{/.test(s)) && namedFromHook.includes('importDocuments'),
  '对话框走 useKnowledge.importDocuments（写路径唯一入口）')
const hookExports = [...src.hook.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])
const notExported = namedFromHook.filter(n => !hookExports.includes(n))
check(notExported.length === 0,
  `对话框从 useKnowledge 导入的每个名字都真的被 hook 导出（未导出：${notExported.join('、') || '无'}）`)
// ★ 2026-09-19 加强：原断言只查对话框，且只查"别出现 importKnowledge 字样"。
// 现在改为**两个渲染文件**都查，判据是"从 knowledgeApi 只许 import type"——
// 组件直连数据层（值导入）在这条下立刻红，比关键字匹配严得多；类型导入不受影响
// （KnowledgeImportEntry / KnowledgeImportReport / KnowledgeSpace 都是类型）。
for (const [name, code] of I18N_SOURCES) {
  const specs = importSpecifiers(code, '@/lib/knowledgeApi')
  // 花括号名单（`import { type A, type B } from …`）要拆开逐项判；`import type {…}` 整体是类型导入也放行。
  const items = specs.flatMap(s => (/^type\s*\{/.test(s) ? [] : s.replace(/^\{|\}$/g, '').split(',')))
    .map(s => s.trim()).filter(Boolean)
  const offenders = items.filter(s => !/^type\s/.test(s))
  check(items.length === 0 || offenders.length === 0,
    `${name} 不直接调 knowledgeApi（只许 import type）${offenders.length ? ` → ${offenders.join(' / ')}` : ''}`)
}
check(/export async function importDocuments/.test(src.hook), 'useKnowledge 导出 importDocuments')
check(/export async function importDocumentsTracked/.test(src.hook), 'useKnowledge 导出 importDocumentsTracked（可追踪的批量导入）')
// 失效逻辑已挪到**模块级函数** `invalidateAfterImport(data)`（同步/异步两条路径共用，2026-09-14）：
// 故下列断言全部落在该函数体内 —— 别处同名调用（删/还原路径的 invalidateAfterDelete）不算数。
const afterImportBody = bodyOf(src.hook, 'invalidateAfterImport')
check(!!afterImportBody, 'useKnowledge 有模块级 invalidateAfterImport（导入失效的单一入口）')
const body = afterImportBody || ''
for (const [label, re] of [
  ['spaces（新空间/计数）', /invalidateKnowledge\(knowledgeKeys\.spaces\)/],
  ['tree（新文件必须立刻出现在树里）', /invalidateKnowledge\(`tree:\$\{space\}\|`\)/],
  ['search（刚导入就能搜到）', /invalidateKnowledge\('search:'\)/],
  ['graph（图谱多了一批节点）', /invalidateKnowledge\('graph:'\)/],
  ['stats（索引统计）', /invalidateKnowledge\(knowledgeKeys\.stats\)/],
  ['indexTags（导入会一次带进大量标签）', /invalidateKnowledge\('indexTags:'\)/],
  ['mentions / brokenLinks（整批引用关系变了）', /invalidateKnowledge\('mentions:'\)[\s\S]{0,200}?invalidateKnowledge\('brokenLinks:'\)/],
]) {
  check(re.test(body), `invalidateAfterImport 失效 ${label}`)
}
// 预览（dryRun）与"全跳过且非新建"必须**早退**：预览一个字节都没写，失效只会让这个高频动作
// 白触发一轮 tree/search 重取。原断言钉 `r.data.dryRun || !changed`（变量名），现钉语义：
// 函数体里存在一个"data.dryRun 参与判断的 return 早退"，且它排在所有失效调用之前。
const early = /if\s*\(([^)]*data\.dryRun[^)]*)\)\s*return/.exec(body)
check(!!early && body.indexOf(early[0]) < body.indexOf('invalidateKnowledge('),
  'dryRun / 全跳过时不失效缓存（预览是高频动作，不该触发重取）')
check(!!early && /!changed|counts\.converted/.test(early[1]),
  `早退条件里含"内容未变"判据（实测：${early ? early[1].trim() : '无早退分支'}）`)
// 目标空间 id **取后端回执**而不是入参：新建空间时前端只知道 `name`，最终 id 是内核定的。
// 原断言钉 `const space = r.data.spaceId`；现钉"函数体里 space 取自 data.spaceId（回执）"。
check(/const\s+space\s*=\s*data\.spaceId/.test(body),
  `失效用后端回执的 spaceId（新建时前端只知道 name，id 是内核定的）`)
// 宿主侧的兜底刷新（空间列表/统计）
check(/onImported=\{refreshAll\}/.test(src.panel), 'Panel 传 onImported={refreshAll}（空间列表/统计跟着变）')

// ── 7. 三档明细 / 只读空间 / 403 / dryRun ──────────────────────────────────
// 2026-09-19：明细渲染抽到了 `KnowledgeImportReport.tsx`，故这里改用**对话框 + 报告组件两文件合看**
// 的 `importUi` —— 判据是"这条 UI 事实存在于导入界面（不论落在哪个文件）"，
// 而不是"它必须住在对话框里"（钉文件位置正是这 7 项失败里 3 项的根因）。
// 若将来又拆成第三个子组件，只要仍在 `src/components/knowledge/` 下就不会假红；
// 真正该红的（整块明细被删、只报总数不列明细）照样红。
const detailFiles = [...I18N_SOURCES, ['sidebar', src.sidebar], ['panel', src.panel]]
const importUi = detailFiles.map(([, code]) => code).join('\n')
check(/report\.counts\.converted/.test(importUi) && /report\.counts\.skipped/.test(importUi) && /report\.counts\.failed/.test(importUi),
  '结果明细展示三档：成功 / 跳过 / 失败（P1-2 要能显示"跳过"，不是只有成功失败）')
check(/report\.failed/.test(importUi) && /e\.message \?\? e\.error/.test(importUi), '失败项带文件名 + 原因（P1-3：每一条都要能对上账）')
check(/e\.source/.test(importUi), '明细里带源文件名（source）')
check(/dryRun/.test(src.dialog) && /run\(true\)/.test(src.dialog) && /importPreview/.test(src.dialog), '提供 dryRun 预览入口（P2-2 对齐）')
check(/res\.status === 403/.test(src.dialog) && /importReadonlyHint/.test(src.dialog), '403（只读空间）有明确提示 + 处置建议（P3-1）')
check(/text-danger[\s\S]{0,200}?error/.test(src.dialog), '错误以 text-danger 显式渲染（不静默失败）')
check(/writable !== false/.test(src.dialog), '已有空间下拉排除只读空间（pack-* 在 GUI 层就选不到）')
check(/disabled=\{!writableSpaces\.length\}/.test(src.dialog), '一个可写空间都没有时禁用"导入到已有空间"（而不是让用户点了吃 403）')
check(/setSpace\(res\.data\.spaceId\)/.test(src.dialog), '导入成功后切到目标空间（否则树停在上一个空间，用户以为失败）')
// 明细清单的配色必须用**主题里真有的** token：`text-error`（失败）/ `text-warning`（告警）。
// 这是抽组件时修掉的一类静默失败（原先写 `text-danger`/`text-warn`，主题无此 token ⇒ 类名不生效、
// 告警渲染成普通灰）—— 未定义类名不报错，只能靠对照主题定义发现。新增一条防它复发。
const themeTokens = read('tailwind.config.ts')
check(/['"]?error['"]?\s*:/.test(themeTokens) && /['"]?warning['"]?\s*:/.test(themeTokens),
  '主题定义了 error / warning 色 token（明细配色断言的前提）')
// 判据只看**代码**、不看注释：报告组件头注释里正引用着旧类名（说明这桩缺陷怎么修的），
// 那种引用是文档、不是缺陷。朴素剥离器（正则去掉 // 与块注释）对本文件足够 ——
// 它没有 "https://…" 这类会被误剥的字符串字面量。
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
check(/tone="text-error"/.test(stripComments(src.report)) && !/text-(danger|warn)\b/.test(stripComments(src.report)),
  '报告组件的告警配色只用主题真有的 token（失败清单 text-error；不再出现 text-danger/text-warn）')

// 设备降级：浏览器 dev 下没有窗口对话框 API → 按钮禁用 + 文案说明，不能点了没反应
check(/importNoDesktop/.test(src.dialog) && /disabled=\{!desktop/.test(src.dialog), '非桌面端：按钮禁用 + 明确文案')

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
