#!/usr/bin/env node
/**
 * 架构图谱生成器 —— 扫描 yfworking 全部功能模块，抽取真实依赖边，
 * 产出自包含的交互式图谱 docs/architecture-graph.html
 *
 * 数据全部来自仓库真源（不做人工编造）：
 *   · 节点 = git 跟踪的源文件（排除测试/构建产物）+ 根级模块
 *   · 边   = 文件内真实出现的 import / export-from / require / 动态 import（解析到仓库内文件）
 *   · 职责 = 各文件头部注释的首段（原样摘录，仅去掉文件路径前缀）
 *   · 功能域 = 本脚本显式声明的归类表（未命中者进入「其他」并在报告中列出）
 *
 * 用法：node scripts/build-arch-graph.mjs [--out docs/architecture-graph.html]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIRS = ['src', 'electron', 'kernel', 'server', 'shared', 'bin', 'scripts', 'pet']
const ROOT_FILES = ['version.mjs', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js']
const CODE_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.py'])
// 图谱生成器自身与模板不属于「应用功能模块」，且其内的正则/文件名常量会造成自引用噪声，排除
const SELF_EXCLUDE = new Set(['scripts/build-arch-graph.mjs'])

// ── 分层：目录 → 架构层（与 docs/architecture.md §1 的五层对应）
const LAYERS = [
  { id: 'renderer', name: '① 表现层（React 渲染进程）', color: '#38bdf8', dirs: ['src'] },
  { id: 'host', name: '② 宿主层（Electron 主进程）', color: '#a78bfa', dirs: ['electron'] },
  { id: 'bridge', name: '③ 桥接层（server/）', color: '#4fd1c5', dirs: ['server'] },
  { id: 'kernel', name: '④ 内核层（Ponos-turbo）', color: '#f472b6', dirs: ['kernel'] },
  { id: 'shared', name: '共享层（跨层纯函数）', color: '#facc15', dirs: ['shared'] },
  { id: 'tooling', name: '工具链 / 启动器', color: '#94a3b8', dirs: ['bin', 'scripts', 'pet', 'root'] },
]

// ── 功能域归类表：显式声明（可评审），未命中 → 其他（并在报告中列出）
// 规则按声明顺序匹配：m = 文件名精确匹配（数组），p = 文件名正则
const DOMAINS = {
  kernel: [
    { id: 'k-app', name: '应用智控（应用即工具）', p: '^app-', desc: 'App Spec 校验/命名/权限与可见性，把绑定应用的命令注册为可直接调用的具名工具' },
    { id: 'k-mcp', name: 'MCP 客户端', p: '^mcp', desc: 'MCP 服务器接入：stdio spawn 与 Streamable HTTP 两条支线，含能力清单与工具暴露' },
    { id: 'k-knowledge', name: '知识库', p: '^knowledge|^tag-store', desc: '知识空间、导入、检索、注入与标签；含 CLI 与安装器' },
    { id: 'k-team', name: '团队与协作', p: '^team-|^file-collab', desc: '团队同步与文件协作：目录策略、占用/检出、冲突处置' },
    { id: 'k-workflow', name: '工作流引擎', p: '^workflow', desc: '工作流 DSL / DAG / 节点执行与授权清单' },
    { id: 'k-loop', name: '环路可靠性', p: '^loop|^guards|^gen-guards', desc: 'loop 状态机与循环守卫：主循环与子 lane 共用一份判定' },
    { id: 'k-engine', name: 'Agent 循环与模型调用', m: ['engine.mjs', 'engine-config.mjs', 'api.mjs', 'provider.mjs', 'context.mjs', 'compact.mjs', 'stream-runtime.mjs', 'request-face.mjs', 'perf.mjs', 'effort-policy.mjs', 'prompt.mjs'], desc: 'Agent 主循环、上下文压缩、流式运行时与思考策略' },
    { id: 'k-tools', name: '工具与权限', m: ['tools.mjs', 'permissions.mjs', 'highrisk.mjs', 'blacklist.mjs', 'readonly.mjs', 'approval-mode.mjs', 'dyntools.mjs'], desc: '工具注册表、权限判定、高危词表、灾难命令黑名单与动态工具注入' },
    { id: 'k-capability', name: '知识与能力', m: ['skills.mjs', 'agents.mjs', 'memory.mjs', 'memory-search.mjs', 'skill-search.mjs'], desc: '技能、子 Agent、经验记忆及其检索' },
    { id: 'k-persist', name: '持久化与观测', m: ['session.mjs', 'hooks.mjs', 'audit.mjs', 'stats.mjs', 'cost.mjs', 'health.mjs', 'fidelity.mjs', 'redact.mjs'], desc: 'transcript 权威源、哈希链审计、用量成本、上下文失真健康与日志脱敏' },
    { id: 'k-entry', name: '入口与协议', m: ['cli.mjs', 'protocol.mjs', 'legacy-env-boot.mjs', 'disabled.mjs'], desc: '内核入口、NDJSON 线协议、旧环境变量垫片与全局停用注册表' },
    { id: 'k-config', name: '配置', m: ['config.mjs', 'settings.mjs', 'config-scan.mjs', 'graph.mjs', 'log.mjs', 'tui.mjs'], desc: '配置读取与扫描、设置、图谱与日志、终端界面' },
  ],
  host: [
    { id: 'h-app', name: '应用智控（宿主侧）', p: '^app-', desc: '应用注册表、能力发现、登录态、Spec 生成/质检与各 driver 执行器' },
    { id: 'h-vault', name: '密码库 vault', p: '^vault', desc: 'safeStorage 加密的密钥管理，fail-closed，明文不出主进程' },
    { id: 'h-browser', name: '内置浏览器执行器', p: '^browser-', desc: '进程内 CDP 驱动的浏览器自动化执行器' },
    { id: 'h-kernel', name: '内核定位与进程监护', p: '^kernel-', desc: '内核 cli.mjs 路径解析与桥进程监护' },
    { id: 'h-diag', name: '诊断与日志', p: '^diag-|^log-', desc: '诊断监视与日志 tee' },
    { id: 'h-main', name: '主进程骨架', m: ['main.cjs', 'preload.cjs', 'ipc-helpers.cjs', 'window-state.cjs', 'dev-source-sync.cjs', 'bridge-header-inject.cjs', 'app-util.cjs'], desc: '窗口/托盘/单实例、IPC 面与令牌头注入、dev 源码同步' },
  ],
  bridge: [
    { id: 'b-core', name: '桥主体与会话', m: ['bridge.mjs', 'yfw-home.cjs', 'auth.mjs', 'bridge-token.mjs', 'bridge-token.cjs', 'egress-policy.mjs', 'egress-policy.cjs', 'approval-mode.mjs', 'highrisk.mjs', 'transcript.mjs'], desc: 'HTTP+WS 中枢、会话↔内核进程映射、三道闸与认证' },
    { id: 'b-workflow', name: '工作流 HTTP 面', p: '^workflow', desc: '工作流宿主、存储、事件与安装' },
    { id: 'b-knowledge', name: '知识库 HTTP 面', p: '^knowledge|^import-jobs', desc: '知识库路由、知识包安装与文件监听、批量导入任务' },
    { id: 'b-mcp', name: 'MCP 配置面', p: '^mcp-', desc: 'MCP 配置读写路由' },
    { id: 'b-team', name: '团队 HTTP 面', p: '^team-', desc: '团队协作路由' },
    { id: 'b-agent', name: 'Agent / 技能面', p: '^agents-routes|^skill-|^disabled-routes', desc: '子 Agent 列表、技能详情与安装、全局停用' },
    { id: 'b-exec', name: '执行器路由', p: '^app-routing|^browser-routing', desc: '内核 bridge_request → 执行器 WS → 回写内核 stdin 的挂起与配对' },
    { id: 'b-stream', name: '内核子命令转发', p: '^kernel-', desc: '只读聚合与流式转发（单飞/超时/限流）' },
    { id: 'b-office', name: 'Office 转换（Python）', p: '\\.py$', desc: 'docx/xls 转换、结构与写回，stdout 单行 JSON' },
    { id: 'b-support', name: '支撑能力', m: ['provider-profile.mjs', 'provider-probe.mjs', 'log-policy.cjs', 'backup-retention.mjs', 'experience.mjs', 'packager.mjs', 'askuser.mjs', 'milestones.mjs', 'loop-translate.mjs', 'health-anchor.mjs', 'logs-routes.mjs', 'readonly-cache.mjs'], desc: 'provider 画像与探测、日志策略、备份保留、经验库、打包与提问/里程碑提取' },
  ],
  renderer: [], // 由目录规则自动生成（src/components/<域>、src/lib、src/hooks…）
  shared: [
    { id: 's-common', name: '共享纯函数层（随包分发）', p: '.', desc: '跨层共用的纯函数与常量：原子写、归因、知识核心/查询/打包、团队加密与成员、文件模态、Sub-Agent 并发控制、Office 合并等' },
  ],
  tooling: [
    { id: 't-launcher', name: 'CLI 启动器', p: '^cli\\.(mjs|cjs)$', desc: '命令行入口：以 CLI 模式启动桥与内核' },
    { id: 't-build', name: '构建与打包脚本', p: '^build-|^vendor-|^gen-|^make-|^embed|^fixtures', desc: '内核 bundle、内嵌运行时/技能、安装包等构建脚本' },
    { id: 't-skill', name: '技能维护脚本', p: '^skill|^aggregate|^annotate|^scan-', desc: '技能树标注、触发器聚合与扫描脚本' },
    { id: 't-pet', name: '桌面宠物', p: '\\.py$', desc: 'Tkinter 桌宠（独立进程，作为 WS 客户端连桥）' },
    { id: 't-misc', name: '其他脚本与根级模块', p: '.', desc: '仓库辅助脚本与根级模块（version.mjs / vite.config.ts 等）' },
  ],
}

// ── src 目录 → 功能域（机械规则；名称与说明为显式声明）
const SRC_VIEW_DOMAIN = {
  'src-root': '应用根组件与入口',
  'src/lib': 'API 客户端与纯函数（UI 决策 / 格式化 / 守卫）',
  'src/hooks': '自定义 Hooks（WS 客户端、数据订阅、桥交互）',
  'src/stores': 'zustand 状态层',
  'src/i18n': '国际化',
  'src/types': '共享类型定义',
  'root': '根级模块（version / 构建配置）',
  'src/components/chat': '对话（消息流/输入/渲染）',
  'src/components/cockpit': '驾驶舱',
  'src/components/workflows': '工作流画布（@xyflow）',
  'src/components/browser': '内置浏览器',
  'src/components/files': '文件面板',
  'src/components/editor': '编辑器（CodeMirror 6）',
  'src/components/skills': '技能',
  'src/components/agents': '子 Agent',
  'src/components/diagnostic': '诊断',
  'src/components/apps': '应用智控',
  'src/components/mcp': 'MCP',
  'src/components/knowledge': '知识库',
  'src/components/team': '团队协作',
  'src/components/vault': '密码库',
  'src/components/history': '历史',
  'src/components/search': '搜索',
  'src/components/usage': '用量',
  'src/components/worktree': '工作树',
  'src/components/permissions': '审批与权限',
  'src/components/settings': '设置',
  'src/components/auth': '认证',
  'src/components/boot': '引导',
  'src/components/rail': '导航栏',
  'src/components/shortcuts': '快捷键',
  'src/components/command-palette': '命令面板',
  'src/components/layout': '布局骨架',
  'src/components/ui': '通用 UI 组件',
}

// ── 域归并表（P2-2：68+ → ~50，消除碎片化）
// 背景：renderer 侧的域 id 是**按目录机械生成**的（见 domainOf：`src/components/<目录名>` 一目录一域），
// 于是出现一批"只有 1–2 个模块"的细碎域（如 search、worktree、command-palette）——
// 它们不是独立的功能域，只是目录结构的副产物，在架构图上表现为大量孤立小点，淹没真正的骨架。
//
// 判定标准（两类保留、其余并入邻近域）：
//   · 保留：① 代表独立概念 且 ② 模块数 ≥3 的域（chat/knowledge/lib/stores/settings/ui/workflows/
//     apps/team/agents/mcp/skills/i18n）；或虽小但属**跨域共享技术层**（lib/stores）。
//   · 并入：只有 1–2 个模块、且语义上从属于某个更大功能面的目录（全部列于下表）。
//   注：① 后端 kernel/bridge/host/tooling 的域**不在此表**——那些是 DOMAINS 里**手工策展**
//   并带 name/desc 的语义域（如 b-mcp=MCP 配置面），合并它们等于销毁架构信息，不能为凑数而动。
//   ② 阈值取"≥3"是为了让一个域在图上至少能形成可辨识的簇；纯计数驱动的硬凑会伤人可读性。
//
// 合并后的"域数"须与 docs/architecture.md 中的声明一致（由 scripts/check-doc-anchors.mjs 门禁守住）。
const SRC_DOMAIN_MERGE = {
  // 会话面：搜索与会话历史本就是会话侧栏的功能，独立成域是机械产物
  'src/components/search': 'src/components/chat',
  'src/components/history': 'src/components/chat',
  // 设置与安全面（规格点名的"安全组"）：审批权限 / 密码库 / 快捷键 / 认证屏
  'src/components/permissions': 'src/components/settings',
  'src/components/vault': 'src/components/settings',
  'src/components/shortcuts': 'src/components/settings',
  'src/components/auth': 'src/components/settings',
  // 外壳与骨架：导航栏 / 引导屏 / 命令面板 / 错误边界 / 应用根，都不是独立功能面
  'src/components/rail': 'src/components/layout',
  'src/components/boot': 'src/components/layout',
  'src/components/command-palette': 'src/components/layout',
  'src/components/ErrorBoundary.tsx': 'src/components/layout',
  'src-root': 'src/components/layout',
  // 文件与编辑面：工作树是文件侧的 git 视图，编辑器属文件编辑面
  'src/components/worktree': 'src/components/files',
  'src/components/editor': 'src/components/files',
  // 观测面：用量是观测数据源，驾驶舱是观测仪表盘
  'src/components/usage': 'src/components/diagnostic',
  'src/components/cockpit': 'src/components/diagnostic',
  // 应用/工具面：内置浏览器由应用与工具驱动
  'src/components/browser': 'src/components/apps',
  // 共用基础设施：hooks 与 types 都是跨域共享层，不必各占一域
  'src/hooks': 'src/lib',
  'src/types': 'src/lib',
}

// ── 收集文件
function walk (absDir, cb) {
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, e.name)
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'release', '.git', 'coverage'].includes(e.name)) continue
      walk(abs, cb)
    } else cb(rel)
  }
}
function collectFiles () {
  const out = []
  for (const dir of SRC_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) continue
    walk(abs, rel => {
      if (SELF_EXCLUDE.has(rel)) return
      const ext = path.extname(rel)
      if (!CODE_EXT.has(ext)) return
      if (/\.(test|spec|e2e)\.[a-z]+$/.test(rel)) return // 测试不计入功能模块（报告中单列）
      if (/^test-/.test(path.basename(rel))) return       // server/test-*.mjs 之类的测试脚本
      out.push(rel)
    })
  }
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(f)
  return out.sort()
}

// ── 头部注释 → 职责文本（原样摘录，去路径前缀与任务号）
function extractPurpose (rel) {
  let txt = ''
  try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8').slice(0, 3000) } catch { return '' }
  const buf = []
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l) { if (buf.length) break; else continue }
    if (/^#!/.test(l)) continue
    if (/^['"]use strict['"];?$/.test(l)) continue
    const m = l.match(/^(?:\/\/|\/\*+|\*|#)\s?(.*)$/)
    if (m) {
      let s = m[1].replace(/\*\/\s*$/, '').trim()
      if (!s) { if (buf.length) break; else continue }
      buf.push(s)
      if (buf.length >= 2) break
      continue
    }
    break
  }
  let s = buf.join(' ')
  s = s.replace(/^(?:[\w./-]+\.(?:mjs|cjs|ts|tsx|js|py))\s*[—\-]{1,2}\s*/, '')
  s = s.replace(/\s*[（(]\s*(?:Task|spec|docs\/)[^）)]*[）)]\s*/g, ' ')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return s.slice(0, 150)
}

// ── 依赖抽取（字符类容忍换行以覆盖多行 import，但排除引号/分号以免跨语句）
const IMPORT_RES = [
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s+(?:type\s+)?[\w*{}$,\s]+?\s+from\s+['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+([\w.]+)\s+import\b/gm, // python
]
function stripComments (txt, ext) {
  if (ext === '.py') {
    return txt.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ').replace(/(^|\n)[ \t]*#[^\n]*/g, '$1')
  }
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')            // 块注释
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')    // 行注释（避开 http:// 与字符串内的 //）
}
function extractSpecifiers (rel) {
  let txt = ''
  try { txt = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'), path.extname(rel)) } catch { return [] }
  const found = new Set()
  for (const re of IMPORT_RES) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(txt))) found.add(m[1])
  }
  return [...found]
}
function tryExt (base, fileSet) {
  const cands = [base, base + '.ts', base + '.tsx', base + '.mjs', base + '.cjs', base + '.js', base + '.py',
    base + '/index.ts', base + '/index.tsx', base + '/index.mjs', base + '/index.cjs', base + '/index.js']
  for (const c of cands) if (fileSet.has(c)) return c
  return null
}
function resolveSpec (fromRel, spec, fileSet) {
  if (!spec) return null
  if (spec.startsWith('@/')) return tryExt('src/' + spec.slice(2), fileSet)
  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    return tryExt(base, fileSet)
  }
  if (/^\w[\w.]*$/.test(spec) && fromRel.endsWith('.py')) {
    return tryExt(path.posix.join(path.posix.dirname(fromRel), spec.replace(/\./g, '/')), fileSet)
  }
  return null
}

// ── 域归属
const TABLE_OF_DIR = { src: 'renderer', electron: 'host', server: 'bridge', kernel: 'kernel', shared: 'shared', bin: 'tooling', scripts: 'tooling', pet: 'tooling' }
function domainOf (rel) {
  // renderer 侧的域是按目录机械生成的，故统一经 mergeSrcDomain 收敛细碎域（见 SRC_DOMAIN_MERGE）。
  // 不在此处对后端 kernel/bridge/host/tooling 的域做任何合并——那些是手工策展的语义域。
  const raw = domainOfRaw(rel)
  return SRC_DOMAIN_MERGE[raw] || raw
}

function domainOfRaw (rel) {
  const seg = rel.split('/')
  const top = seg[0]
  const file = seg[seg.length - 1]
  if (seg.length === 1) return 'root'
  if (top === 'src') {
    if (seg.length === 2 && /\.(tsx?)$/.test(file)) return 'src-root'
    if (seg.length >= 3 && seg[1] === 'components') return `src/components/${seg[2]}`
    if (seg.length >= 2) return seg.slice(0, 2).join('/')
    return 'src'
  }
  const tableKey = TABLE_OF_DIR[top]
  const table = tableKey ? DOMAINS[tableKey] : null
  if (Array.isArray(table)) {
    for (const d of table) {
      if (d.m && d.m.includes(file)) return d.id
      if (d.p && new RegExp(d.p).test(file)) return d.id
    }
  }
  return `${top}-other`
}

function main () {
  const files = collectFiles()
  const fileSet = new Set(files)
  let trackedSet = new Set()
  let head = 'unknown'; let dirty = 0; let testsExcluded = 0
  try {
    trackedSet = new Set(execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean))
    head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
    testsExcluded = [...trackedSet].filter(f => /\.(test|spec)\.[a-z]+$/.test(f)).length
  } catch {}

  const nodes = files.map(rel => {
    const seg = rel.split('/')
    let loc = 0
    try { loc = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length } catch {}
    return {
      id: rel,
      label: seg[seg.length - 1],
      dir: seg.slice(0, -1).join('/'),
      layer: (LAYERS.find(l => l.dirs.includes(seg[0])) || { id: 'tooling' }).id,
      domain: domainOf(rel),
      tracked: trackedSet.has(rel),
      loc,
      purpose: extractPurpose(rel),
      deg: 0,
    }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))

  // 边 A：静态依赖（import / require / export-from / 动态 import）
  const edgeSet = new Map()
  for (const rel of files) {
    for (const spec of extractSpecifiers(rel)) {
      const target = resolveSpec(rel, spec, fileSet)
      if (!target || target === rel) continue
      edgeSet.set(rel + '\u0000' + target, 1)
    }
  }

  // 边 B：按路径引用（字符串字面量指向仓库内文件）—— 覆盖 spawn / 按路径加载这类非 import 关系
  const PATH_RE = /['"`]([^'"`\n]*?\.(?:mjs|cjs|ts|tsx|js|py))['"`]/g
  // basename → 路径索引（仅唯一名可安全回退解析，如 bridge.mjs 里按文件名 spawn 的 Python 脚本）
  const byBase = new Map()
  for (const f of files) {
    const b = path.posix.basename(f)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(f)
  }
  const refSet = new Map()
  for (const rel of files) {
    let txt = ''
    try { txt = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'), path.extname(rel)) } catch { continue }
    PATH_RE.lastIndex = 0
    let m
    while ((m = PATH_RE.exec(txt))) {
      const lit = m[1]
      if (/[*?<>]/.test(lit)) continue            // 通配/占位/比较表达式，跳过
      if (/^[a-z]+:\/\//.test(lit)) continue      // URL
      const cands = []
      if (lit.startsWith('.')) cands.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), lit)))
      cands.push(lit.replace(/^\.?\//, ''))       // 相对仓库根
      const base = path.posix.basename(lit)
      const candsOfBase = byBase.get(base) || []
      if (candsOfBase.length === 1) cands.push(candsOfBase[0])
      else if (candsOfBase.length > 1) {
        // 同名多份（如 cli.mjs 存在 kernel/ 与 bin/ 两处）：仅当文件里出现该候选的目录名字面量时才认定
        const dirHits = candsOfBase.filter(c => {
          const dir = path.posix.dirname(c).split('/').pop()
          return new RegExp(`['"\`]${dir}['"\`/\\\\\\\\]|['"\`][^'"\`]*[/\\\\\\\\]${dir}[^'"\`]*['"\`]`).test(txt)
        })
        if (dirHits.length === 1) cands.push(dirHits[0])
      }
      let target = null
      for (const c of cands) { target = fileSet.has(c) ? c : null; if (target) break }
      if (!target || target === rel) continue
      const k = rel + '\u0000' + target
      if (edgeSet.has(k) || refSet.has(k)) continue
      refSet.set(k, 1)
    }
  }
  for (const k of refSet.keys()) edgeSet.set(k, 1)
  const edges = [...edgeSet.keys()].map(k => {
    const [from, to] = k.split('\u0000')
    return { from, to, weight: 1, ref: refSet.has(k) ? 1 : 0 }
  })
  for (const e of edges) { byId.get(e.from).deg++; byId.get(e.to).deg++ }

  // 域聚合
  const domainMap = new Map()
  const nameOf = new Map(); const descOf = new Map()
  for (const key of ['kernel', 'host', 'bridge', 'renderer', 'shared', 'tooling']) {
    for (const d of (DOMAINS[key] || [])) { nameOf.set(d.id, d.name); descOf.set(d.id, d.desc || '') }
  }
  for (const [k, v] of Object.entries(SRC_VIEW_DOMAIN)) { nameOf.set(k, v); if (!descOf.has(k)) descOf.set(k, '') }
  for (const n of nodes) {
    if (!domainMap.has(n.domain)) domainMap.set(n.domain, [])
    domainMap.get(n.domain).push(n.id)
  }
  const domains = [...domainMap.entries()].map(([id, dfs]) => {
    const layer = byId.get(dfs[0]).layer
    return {
      id, layer, files: dfs, count: dfs.length,
      name: nameOf.get(id) || id.replace(/^src\/components\//, '').replace(/^src\//, 'src · ').replace(/-other$/, ' · 其他'),
      loc: dfs.reduce((s, f) => s + byId.get(f).loc, 0),
      desc: descOf.get(id) || '',
      layerName: (LAYERS.find(l => l.id === layer) || {}).name || layer,
    }
  }).sort((a, b) => b.count - a.count)

  const domEdges = new Map()
  for (const e of edges) {
    const a = byId.get(e.from).domain; const b = byId.get(e.to).domain
    if (a === b) continue
    domEdges.set(a + '\u0000' + b, 1)
  }
  const domainEdges = [...domEdges.keys()].map(k => { const [from, to] = k.split('\u0000'); return { from, to, weight: 1 } })

  const unmatched = nodes.filter(n => n.domain.endsWith('-other') && !nameOf.has(n.domain)).map(n => n.id)
  const untracked = nodes.filter(n => !n.tracked).map(n => n.id)
  const coverage = SRC_DIRS.map(dir => {
    const tracked = nodes.filter(n => n.tracked && n.id.startsWith(dir + '/')).length
    const isTest = f => /\.(test|spec|e2e)\.[a-z]+$/.test(f) || /^test-/.test(path.basename(f))
    const trackedGit = [...trackedSet].filter(f => f.startsWith(dir + '/') && CODE_EXT.has(path.extname(f)) && !isTest(f) && !SELF_EXCLUDE.has(f)).length
    return { dir, trackedGit, collected: tracked, ok: trackedGit === tracked }
  })

  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch {}

  const data = {
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    baseline: { head, dirty, version },
    stats: {
      files: nodes.length,
      edges: edges.length,
      domains: domains.length,
      loc: nodes.reduce((s, n) => s + n.loc, 0),
      testsExcluded,
      orphans: nodes.filter(n => n.deg === 0).length,
      refEdges: edges.filter(e => e.ref).length,
      untracked: untracked.length,
    },
    layers: LAYERS.map(l => ({ id: l.id, name: l.name, color: l.color, count: nodes.filter(n => n.layer === l.id).length })),
    coverage, unmatched, untracked,
    domains, domainEdges, nodes, edges,
  }

  const outIdx = process.argv.indexOf('--out')
  const outPath = path.join(ROOT, outIdx > 0 ? process.argv[outIdx + 1] : 'docs/architecture-graph.html')
  const tpl = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'arch-graph.template.html'), 'utf8')
  fs.writeFileSync(outPath, tpl.replace('/*__ARCH_DATA__*/null', JSON.stringify(data)))

  console.log(`✅ 图谱已生成：${path.relative(ROOT, outPath)}（${(fs.statSync(outPath).size / 1024).toFixed(0)}KB）`)
  console.log(`   模块 ${data.stats.files} · 依赖边 ${data.stats.edges}（其中按路径引用 ${data.stats.refEdges}） · 功能域 ${data.stats.domains} · 代码行 ${data.stats.loc.toLocaleString()}`)
  console.log(`   分层：` + data.layers.map(l => `${l.id}=${l.count}`).join('  '))
  console.log(`   未归类 ${unmatched.length} · 孤立 ${data.stats.orphans} · 未跟踪文件 ${untracked.length}${untracked.length ? '（' + untracked.join(', ') + '）' : ''}`)
  console.log('   逐目录覆盖核对（与 git ls-files 比对）：')
  for (const c of coverage) console.log(`     ${c.ok ? '✅' : '❌'} ${c.dir.padEnd(9)} git ${String(c.trackedGit).padStart(4)} / 已收录 ${String(c.collected).padStart(4)}`)
}

// 仅在**直接执行**时跑主流程。被 import 时只暴露纯函数，供测试断言域的归并与分配规则
// （否则 `import` 会立刻全仓扫描并覆写 docs/architecture-graph.html —— 测试无法接受）。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()

// 供 kernel-tests/arch-graph-domains.test.mjs 断言：域的分配与归并是纯函数，可直接单测。
export { domainOf, SRC_DOMAIN_MERGE, SRC_VIEW_DOMAIN, DOMAINS }
