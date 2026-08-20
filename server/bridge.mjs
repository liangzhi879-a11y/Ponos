import { spawn, execSync } from 'child_process'
import { createInterface } from 'readline'
import { WebSocketServer } from 'ws'
import http, { createServer } from 'http'
import https from 'https'
import { fileURLToPath } from 'url'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, unlinkSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, sep, dirname, resolve, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { extractMilestoneMarks, extractProseStages } from './milestones.mjs'
import { matchesHighRisk } from './highrisk.mjs'
import { parseAskUserPayload, extractAskUserBlocks } from './askuser.mjs'
import { buildExperienceIndex, buildSedimentPrompt, ensurePersonalDir } from './experience.mjs'
export { ensurePersonalDir, buildExperienceIndex, buildSedimentPrompt } from './experience.mjs'
import * as doubao from './doubao.mjs'
import { createTranscriptHandlers, aggregateStats, costUsd, sanitizePathSegment, transcriptBaseDir } from './transcript.mjs'
import { makeBrowserRouter } from './browser-routing.mjs'

const PORT = parseInt(process.env.YFW_BRIDGE_PORT || '51309', 10)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 读取并 JSON.parse 请求体（各 POST 路由共用）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
  })
}

// ---------------------------------------------------------------------------
// YFWorking identity — injected into every session so the agent never
// presents itself as Claude.
// ---------------------------------------------------------------------------
// 互动问答格式规范（独立常量：新会话随身份提示词注入；resume 会话单独注入，
// 确保模型始终知晓唯一提问方式，不会回退到已被禁用的 AskUserQuestion 工具）
const YFW_ASKUSER_FORMAT = `## 互动问答（提问卡片 —— 唯一允许的提问方式，最高优先级）
当你需要用户做出选择、澄清歧义、收集信息或确认方向时，【必须】在回复正文中输出下面的 HTML 注释格式的交互式提问卡片。

【强制规则（违反即算错误）】：
- AskUserQuestion 工具已被禁用，禁止调用它，也禁止假装调用。
- 禁止用纯文本提问代替卡片（例如"请问你想选哪个？"这类文字询问一律不允许，必须输出卡片）。
- 卡片必须完整：以 <!--ASK_USER 开头、--> 结尾，中间是描述 questions 与 context 的对象。
- 字符串值若包含逗号、冒号、括号，请用双引号包裹；键可带引号也可不带（解析器两者都支持）。
- 若需推荐某项，在其 label 末尾加 "(Recommended)"。

格式示例（照此结构输出）：
<!--ASK_USER
{
  "questions": [{
    "id": "q1",
    "header": "2-5字标签",
    "question": "完整的问题描述",
    "options": [
      {"label": "选项名 (Recommended)", "description": "简洁说明"},
      {"label": "选项名", "description": "简洁说明"}
    ],
    "multiSelect": false
  }],
  "context": "一句话概括当前任务背景，帮助用户理解决策的上下文"
}
-->

规则：
- 每次最多 4 个问题，问题数少优于多。仅在对任务推进关键时才提问。
- 每个问题的选项不超过 4 个，"Other" 选项会自动添加，允许用户自定义输入。
- 用户回复后你会收到文本格式的答案和补充说明，整合后继续任务。`

// 任务里程碑进度协议：独立常量，新会话与 resume 会话都必须注入（resume 分支
// 不重复注入完整身份提示词，只追加互动格式 + 里程碑协议）。
const YFW_MILESTONE_PROTOCOL = `【任务里程碑进度协议】
- 执行多步骤/多阶段任务时：开始实施前，【必须】先内部拟定任务目标与阶段/里程碑清单，
  并在回复正文输出一行结构化标记声明总里程碑数及各里程碑名称：
  <!--MILESTONES 3 需求分析|方案设计|编码实现-->
- 每完成一个里程碑，立即输出该里程碑的达成标记：
  <!--MILESTONE-OK 1/3 需求分析-->
- 开始执行某个里程碑时，先输出开始标记：<!--MILESTONE-START i/N 名称-->
- 实施阶段（已批准计划后）按里程碑逐项推进：输出 <!--MILESTONE-START i/N 名称--> 表示开始，
  完成后输出 <!--MILESTONE-OK i/N 名称-->；同一时刻只执行一个里程碑（至少一个处于进行中）。
- 散文式阶段叙述（如"阶段 1/4"）不能代替上面的结构化标记，必须按上述格式输出。
- 简单任务（闲聊、单步问答）无需声明里程碑。
- spec/plan 任务：以用户主导的计划步骤作为里程碑。
- 当通过 Agent/subagent 工具派发子任务时，必须在子任务指令中明确指示子代理遵循本里程碑协议
  （子任务开始时输出 <!--MILESTONES-->，每完成一步输出 <!--MILESTONE-OK-->）；
  子代理的标记同样计入总进度，不得省略。
- 以上标记仅用于进度展示，不要向用户解释标记本身，不要在对话中展示里程碑清单。`

const YFW_SYSTEM_PROMPT = `你是 YFWorking（远方工作台），一款自主研发的桌面应用内置 AI 助手。你的底层框架基于 YFWorking Agent SDK，模型由用户配置的第三方 API 提供（当前为 deepseek-v4-flash）。

【身份回答模板】当用户询问"你是谁"或类似问题时，严格使用以下回答：
"我是 YFWorking（远方工作台），基于 YFWorking Agent SDK 构建的 AI 助手，当前由 deepseek-v4-flash 模型驱动。我可以帮你处理编程、企业咨询材料、系统诊断等各类任务。"

【禁止】你的代码框架借鉴了业界成熟的 Agent 架构设计，但这不意味你就是那个产品。禁止声称自己是任何其他 AI 产品（包括但不限于 Claude、ChatGPT、Copilot、Gemini），禁止使用任何其他公司的品牌名称来描述你的身份。

你好！我是 **YFWorking**（远方工作台），是你桌面应用中的内置 AI 助手，专注于企业咨询项目服务和应用开发。

我可以协助你完成以下类型的工作：
- **企业咨询**：核心表格处理、材料整理、报告撰写、审计核对、申报打包等
- **系统诊断**：磁盘分析、性能监控、进程管理、事件日志检查、网络诊断等
- **开发辅助**：代码编写、文件管理、项目规划等


## 文件操作审批铁律（最高优先级）
- 移动（移动/重命名）任何文件：必须先向用户说明源路径与目标路径，获得用户明确同意后方可执行。
- 删除任何文件：必须先向用户确认将被删除的完整路径与用途，获得用户明确同意后方可执行。
- 未经用户明确审批，禁止执行任何移动或删除文件的操作（包括临时文件、缓存与备份文件）。

${YFW_ASKUSER_FORMAT}

${YFW_MILESTONE_PROTOCOL}

使用简体中文与用户交流，回答直接、专业、简洁。`;

// ---------------------------------------------------------------------------
// YFWorking home directory — STRICTLY ISOLATED from Claude.
// All YFWorking state (skills, config, providers, sessions) lives here.
// We never read from ~/.claude/ even if it exists on the machine.
// ---------------------------------------------------------------------------
const YFW_HOME = process.env.YFW_HOME ? resolve(process.env.YFW_HOME) : join(homedir(), '.yfworking')
const YFW_SKILLS_DIR = join(YFW_HOME, 'skills')
const YFW_CONFIG_PATH = join(YFW_HOME, 'config.json')

function ensureYfwHome() {
  if (!existsSync(YFW_HOME)) mkdirSync(YFW_HOME, { recursive: true })
  if (!existsSync(YFW_SKILLS_DIR)) mkdirSync(YFW_SKILLS_DIR, { recursive: true })
}

// 会话正常退出会删除各自的 --append-system-prompt-file；异常退出（进程强杀/
// 崩溃/直接关窗）会遗留孤儿文件，长此以往 %TEMP% 堆积数百个。服务器重启意味着
// 内存会话全部作废，残留的 yfw-prompt-* 均为孤儿。内核在 spawn 时已读入文件
// 内容，此后文件不再被引用，因此清扫不会影响任何运行中会话；保守起见仍只清
// 24h 前的文件（跨日长会话的提示词文件即使仍被引用也无害）。
function sweepOrphanPromptFiles() {
  try {
    const t = tmpdir()
    const cutoff = Date.now() - 24 * 3600 * 1000
    let n = 0
    for (const name of readdirSync(t)) {
      if (!name.startsWith('yfw-prompt-')) continue
      try {
        if (statSync(join(t, name)).mtimeMs < cutoff) { rmSync(join(t, name), { force: true }); n++ }
      } catch {}
    }
    if (n > 0) console.log('[bridge] swept orphan prompt files:', n)
  } catch {}
}

function findSkillRoot() {
  ensureYfwHome()
  return YFW_SKILLS_DIR
}

// 内置示例技能目录候选（dev 源码 / vite 构建产物 / 打包后目录，多形态兼容）
const SAMPLE_SKILL_ROOTS = [
  join(process.cwd(), 'public', 'sample-skills'),
  join(process.cwd(), 'dist', 'sample-skills'),
  join(process.cwd(), 'sample-skills'),
  join(__dirname, '..', 'public', 'sample-skills'),
  join(__dirname, '..', 'dist', 'sample-skills'),
]

function readSkillIndex(idxPath) {
  if (!existsSync(idxPath)) return []
  try {
    const idx = JSON.parse(readFileSync(idxPath, 'utf-8'))
    return Array.isArray(idx) ? idx : []
  } catch {
    return []
  }
}

function writeSkillIndex(idxPath, index) {
  writeFileSync(idxPath, JSON.stringify(index, null, 2), 'utf-8')
}

// Recursively copy a skill directory, rewriting {{YFW_SKILLS}} placeholders to
// the real skill root so the bundled package stays portable across machines.
// Shared by single-skill install and first-run bulk auto-install.
const SKILL_TEXT_RE = /\.(md|py|json|txt|yaml|yml|js|mjs|cjs|ts|html|css|sh|bat|cmd|csv)$/i
function copyWithRewrite(srcDir, destDir, placeholder, yfwRootAbs) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true })
      copyWithRewrite(src, dest, placeholder, yfwRootAbs)
    } else {
      const raw = readFileSync(src)
      if (SKILL_TEXT_RE.test(entry.name)) writeFileSync(dest, raw.toString('utf-8').split(placeholder).join(yfwRootAbs), 'utf-8')
      else writeFileSync(dest, raw)
    }
  }
}

// Python runtime：优先使用随应用捆绑的运行时（<app>/runtime/python/python.exe，
// 与 main.cjs 的 findPythonExe 同路径约定），保证打包版离线可用；开发环境回退 PATH。
function findPythonExe() {
  const bundled = join(__dirname, '..', 'runtime', 'python', 'python.exe')
  if (existsSync(bundled)) return bundled
  return 'python'
}

// Default providers shipped with YFWorking — used on first run.
const DEFAULT_PROVIDERS = [
  // Model names follow official docs (verified 2026-08):
  //   DeepSeek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
  //     deepseek-chat / deepseek-reasoner 已于 2026/07/24 弃用，
  //     分别对应 deepseek-v4-flash 的非思考/思考模式。
  //     当前模型: deepseek-v4-flash (1M, 思考模式可切换), deepseek-v4-pro (1M, 旗舰)
  //   MiniMax:  https://platform.minimaxi.com/docs/token-plan/claude-code
  //     MiniMax-M3[1m] (1M 上下文, anthropic 兼容端点)
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiBaseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    primaryModel: 'deepseek-v4-pro',
    subagentModel: 'deepseek-v4-flash',
    effortLevel: 'max',
    contextWindow: 1000000,
    authToken: '',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    apiBaseUrl: 'https://api.minimaxi.com/anthropic',
    models: ['MiniMax-M3[1m]'],
    primaryModel: 'MiniMax-M3[1m]',
    subagentModel: 'MiniMax-M3[1m]',
    effortLevel: 'max',
    contextWindow: 1000000,
    authToken: '',
  },
]

const DEFAULT_CONFIG = {
  activeProvider: 'deepseek',
  skillRoot: YFW_SKILLS_DIR,
  autoCapture: true,
  autoImageBridge: true,
  visionProviderId: '',
  providers: DEFAULT_PROVIDERS,
}

// Migrate deprecated model names to current ones.
// DeepSeek (renamed 2026/07/24): deepseek-chat -> deepseek-v4-flash, deepseek-reasoner -> deepseek-v4-pro
// MiniMax: MiniMax-M1 / MiniMax-Text-01 -> MiniMax-M3[1m]
// Also fix common baseUrl mistakes (e.g. /anthropic/v1 -> /anthropic).
function migrateProvider(p) {
  if (!p) return p
  let changed = false
  let models = (p.models || []).slice()
  let primaryModel = p.primaryModel || ''
  let subagentModel = p.subagentModel || ''
  let apiBaseUrl = p.apiBaseUrl || ''

  const migrateModel = (m) => {
    if (m === 'deepseek-chat') { changed = true; return 'deepseek-v4-flash' }
    if (m === 'deepseek-reasoner') { changed = true; return 'deepseek-v4-pro' }
    if (m === 'MiniMax-M1' || m === 'MiniMax-Text-01') { changed = true; return 'MiniMax-M3[1m]' }
    // Also normalise bare MiniMax-M3 to the 1M variant per official docs.
    if (m === 'MiniMax-M3') { changed = true; return 'MiniMax-M3[1m]' }
    return m
  }
  models = models.map(migrateModel)
  // Dedup models array (multiple legacy names may collapse to one).
  const seen = new Set()
  models = models.filter(m => { if (seen.has(m)) { changed = true; return false } seen.add(m); return true })
  primaryModel = migrateModel(primaryModel)
  subagentModel = migrateModel(subagentModel)

  if (apiBaseUrl.endsWith('/anthropic/v1')) {
    apiBaseUrl = apiBaseUrl.replace(/\/anthropic\/v1$/, '/anthropic')
    changed = true
  }

  if (!changed) return p
  return { ...p, models, primaryModel, subagentModel, apiBaseUrl }
}

function migrateModelNames(providers) {
  if (!Array.isArray(providers)) return providers
  return providers.map(migrateProvider)
}

// ---------------------------------------------------------------------------
// Atomic config write with .bak shadow
// ---------------------------------------------------------------------------
// Before overwriting config.json / settings.json we copy the previous file to
// `<filename>.bak`. If the write is interrupted (process kill, disk full, etc.)
// the previous-good state is still on disk as `.bak`.
// We also stamp `.bak.YYYYMMDDHHMMSS` periodically so older overrides survive
// in case the rolling `.bak` was itself corrupted by a partial write.
function safeWriteJsonWithBak(targetPath, content) {
  if (existsSync(targetPath)) {
    try {
      // 1. Update the rolling .bak (single slot, fast).
      copyFileSync(targetPath, targetPath + '.bak')
      // 2. Stamp a dated snapshot once per day so we keep a recent history
      //    (capped to last 7 days; older stamped backups auto-pruned).
      const stamp = formatStamp(new Date())
      const stamped = `${targetPath}.bak.${stamp}`
      try {
        copyFileSync(targetPath, stamped)
        pruneStampedBackups(targetPath, 7)
      } catch { /* stamping is best-effort */ }
    } catch (e) {
      console.warn('[bridge] failed to snapshot', targetPath, 'before write:', e.message)
    }
  }
  writeFileSync(targetPath, content, 'utf-8')
}

function formatStamp(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// Try to read a JSON file, falling back to .bak (rolling) then to the newest
// `.bak.<stamp>` if the primary and .bak are both corrupted. Returns the parsed
// JSON or null when no recoverable copy exists. Never throws.
function tryReadJsonWithRecovery(filePath) {
  const candidates = [filePath, filePath + '.bak']
  // Add stamped backups, newest first.
  try {
    const dir = dirname(filePath)
    const base = basename(filePath)
    const stampPrefix = `${base}.bak.`
    const stamped = readdirSync(dir)
      .filter((n) => n.startsWith(stampPrefix))
      .map((n) => ({ name: n, full: join(dir, n), mtime: (() => { try { return statSync(join(dir, n)).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const s of stamped) candidates.push(s.full)
  } catch { /* best-effort */ }

  let lastErr = ''
  for (const cand of candidates) {
    if (!existsSync(cand)) continue
    try {
      const raw = readFileSync(cand, 'utf-8')
      const parsed = JSON.parse(raw)
      if (cand !== filePath) {
        console.warn('[bridge] primary', basename(filePath), 'unreadable (' + lastErr + ') — recovered from', basename(cand))
      }
      return { data: parsed, recoveredFrom: cand !== filePath ? cand : null }
    } catch (e) {
      lastErr = e.message
    }
  }
  return null
}

function pruneStampedBackups(targetPath, keepDays) {
  try {
    const dir = dirname(targetPath)
    const base = basename(targetPath)
    const stampPrefix = `${base}.bak.`
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(stampPrefix)) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch { /* race with concurrent write — ignore */ }
    }
  } catch { /* best-effort */ }
}

function loadConfig() {
  ensureYfwHome()
  if (!existsSync(YFW_CONFIG_PATH)) {
    safeWriteJsonWithBak(YFW_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }
  const recovered = tryReadJsonWithRecovery(YFW_CONFIG_PATH)
  if (!recovered) {
    // Both primary and every .bak are unreadable — fall back to defaults and
    // log loudly so the user knows to check disk / restore from external backup.
    console.error('[bridge] config.json + all .bak are unreadable — using DEFAULT_CONFIG')
    safeWriteJsonWithBak(YFW_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }
  if (recovered.recoveredFrom) {
    // Recovered — restore the good copy to config.json so the app state is
    // back to normal immediately, and let safeWriteJsonWithBak shadow it.
    try { copyFileSync(recovered.recoveredFrom, YFW_CONFIG_PATH) } catch {}
  }
  try {
    const cfg = recovered.data
    const providers = migrateModelNames(cfg.providers && cfg.providers.length ? cfg.providers : DEFAULT_PROVIDERS)
    const merged = {
      ...DEFAULT_CONFIG,
      ...cfg,
      providers,
    }
    // Persist migrated config so the frontend /config endpoint sees the
    // corrected values immediately and we skip re-migrating on every read.
    try { safeWriteJsonWithBak(YFW_CONFIG_PATH, JSON.stringify(merged, null, 2)) } catch {}
    return merged
  } catch {
    return DEFAULT_CONFIG
  }
}

// Bypass the kernel's interactive login (claude login / OAuth) by writing
// the active provider's credentials into ~/.yfworking/settings.json. The
// Claude Code kernel reads env vars from settings.json at startup, so the
// app works with plain API keys — no browser-based authentication needed.
const YFW_SETTINGS_PATH = join(YFW_HOME, 'settings.json')

function syncKernelSettings() {
  try {
    const cfg = loadConfig()
    const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider) || cfg.providers?.[0]
    if (!provider) return
    const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
    const sub = provider.subagentModel || model
    // Vision model source: default to the active provider; allow an explicit
    // visionProviderId to point at any other configured provider.
    const visionProvider = (cfg.providers || []).find(p => p.id === cfg.visionProviderId) || provider
    const existing = {}
    if (existsSync(YFW_SETTINGS_PATH)) {
      const recovered = tryReadJsonWithRecovery(YFW_SETTINGS_PATH)
      if (recovered) {
        Object.assign(existing, recovered.data)
        if (recovered.recoveredFrom) {
          try { copyFileSync(recovered.recoveredFrom, YFW_SETTINGS_PATH) } catch {}
        }
      }
    }
    existing.env = {
      ...(existing.env || {}),
      ANTHROPIC_BASE_URL: provider.apiBaseUrl || '',
      ANTHROPIC_AUTH_TOKEN: provider.authToken || '',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: sub,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(provider.contextWindow || 1000000),
      YFW_VISION_BASE_URL: visionProvider.apiBaseUrl || '',
      YFW_VISION_AUTH_TOKEN: visionProvider.authToken || '',
      YFW_VISION_MODEL: visionProvider.visionModel || '',
      YFW_AUTO_IMAGE_BRIDGE: cfg.autoImageBridge === false ? '0' : '1',
    }
    safeWriteJsonWithBak(YFW_SETTINGS_PATH, JSON.stringify(existing, null, 2))
    console.log('[bridge] kernel settings synced ->', provider.id, '| model:', model)
  } catch (e) {
    console.warn('[bridge] syncKernelSettings failed:', e.message)
  }
}

function saveConfig(updates) {
  const current = loadConfig()
  const next = { ...current, ...updates }
  safeWriteJsonWithBak(YFW_CONFIG_PATH, JSON.stringify(next, null, 2))
  // Keep the kernel's settings.json in sync so auth works without login.
  syncKernelSettings()
  return next
}

// ---------------------------------------------------------------------------
// Kernel self-bootstrap: when the packaged app lives under Program Files
// (or any ACL-restricted dir), spawning bun to execute the kernel fails with
// EPERM (Windows denies higher-privilege file access under those roots).
// We copy the kernel + bun runtime into the user home (~/.yfworking/runtime/)
// once and run from there, which is always writable/executable.
// ---------------------------------------------------------------------------
function bootstrapKernelToUserDir(kernel, bun) {
  // 总是 bootstrap 到 ~/.yfworking/runtime/（不再仅限 Program Files）：
  // 1) 用户级安装路径 AppData\Local\Programs\ 也有 ACL/AV 风险
  // 2) ~100MB 一次性复制，仅在大小变化时重做
  // 3) 用户家目录永远是可写可执行，spawn 不会受阻
  try {
    const destBase = join(YFW_HOME, 'runtime')
    const destKernel = join(destBase, 'kernel', 'cli.mjs')
    const destBun = join(destBase, 'bun', 'bun.exe')
    const kernelSize = existsSync(destKernel) ? statSync(destKernel).size : -1
    const bunSize = (bun && existsSync(destBun)) ? statSync(destBun).size : -1
    const needCopyKernel = kernelSize !== statSync(kernel).size
    const needCopyBun = bun && bunSize !== statSync(bun).size
    if (!needCopyKernel && !needCopyBun) {
      return { kernel: destKernel, bun: destBun, bootstrapped: false, cached: true }
    }
    mkdirSync(join(destBase, 'kernel'), { recursive: true })
    if (bun) mkdirSync(join(destBase, 'bun'), { recursive: true })
    if (needCopyKernel) copyFileSync(kernel, destKernel)
    if (needCopyBun) copyFileSync(bun, destBun)
    console.log('[bridge] kernel bootstrapped to', destBase, '(kernel:', needCopyKernel, 'bun:', needCopyBun, ')')
    return { kernel: destKernel, bun: destBun, bootstrapped: true }
  } catch (e) {
    console.warn('[bridge] kernel bootstrap failed, falling back to original paths:', e.message)
    return { kernel, bun, bootstrapped: false }
  }
}

function findYFWorking() {
  // NOTE: We MUST spawn the real YFWorking kernel — the bun-bundled ESM CLI
  // built from yfw-kernel/claude-code — NOT the npm-global yfworking.cmd
  // (that is the YFWorking GUI launcher: it starts bridge+vite+browser and
  // would kill a kernel session) and NOT stock Claude Code from PATH (that
  // would bypass every YFW isolation fix). The kernel is started via a bun
  // runtime: `"<bun>" "<kernel>"` (spawn uses shell:true and simply
  // concatenates command + args).
  if (process.env.YFWORKING_PATH) return process.env.YFWORKING_PATH
  // 1) Explicit kernel override: YFWORKING_KERNEL = path to cli.mjs,
  //    YFWORKING_BUN (optional) = path to bun runtime.
  if (process.env.YFWORKING_KERNEL) {
    const kernel = process.env.YFWORKING_KERNEL
    const bun = process.env.YFWORKING_BUN || join(homedir(), '.bun', 'bin', 'bun.exe')
    return `"${bun}" "${kernel}"`
  }
  // 2) Well-known kernel locations. The packaged app ships the kernel at
  //    <app>/kernel/cli.mjs and the bun runtime at <app>/runtime/bun/; the
  //    dev build resolves the kernel inside this repo's yfw-kernel workspace.
  const candidates = [
    {
      kernel: join(__dirname, '..', 'kernel', 'cli.mjs'),
      bun: join(__dirname, '..', 'runtime', 'bun', 'bun.exe'),
    },
    {
      kernel: join(__dirname, '..', '..', 'kernel', 'cli.mjs'),
      bun: join(__dirname, '..', '..', 'runtime', 'bun', 'bun.exe'),
    },
    {
      kernel: join(__dirname, '..', 'yfw-kernel', 'claude-code', 'dist', 'cli.mjs'),
      bun: join(homedir(), '.bun', 'bin', 'bun.exe'),
    },
  ]
  for (const { kernel, bun } of candidates) {
    if (!existsSync(kernel)) continue
    if (existsSync(bun)) {
      const b = bootstrapKernelToUserDir(kernel, bun)
      return `"${b.bun}" "${b.kernel}"`
    }
    try {
      execSync('bun --version 2>nul', { timeout: 5000, stdio: 'ignore' })
      return `bun "${kernel}"`
    } catch { }
  }
  // 3) Last resort — a real Claude Code kernel on PATH (dev convenience only;
  //    never reached once the YFW kernel is built or shipped).
  try { return execSync('where claude.cmd 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0].trim() } catch { }
  try { return execSync('where claude 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0].trim() } catch { }
  try { return execSync('where claude-code 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0].trim() } catch { }
  return 'claude.cmd'
}
const YFWORKING = findYFWorking()
console.log('[bridge] YFWorking CLI:', YFWORKING)
// Ensure kernel settings.json exists with credentials on boot.
try { syncKernelSettings() } catch (e) { console.warn('[bridge] initial kernel settings sync failed:', e.message) }
console.log('[bridge] YFWorking home:', YFW_HOME)

const sessions = new Map()
const wsClients = new Set()

// 诊断埋点：供主进程 diag-monitor 查询（只读内存统计，跨会话累计，仅统计最近 7 天）
const diagInfo = { firstTokenOk: 0, firstTokenTotal: 0, kernelCrashCount: 0, lastApiSuccessAt: null }

// ---------------------------------------------------------------------------
// 内置浏览器自动化路由（bridge 侧接线）：内核 bridge_request(browser) → 主进程
// 执行器 WS 客户端；executor 响应 → 回写内核 stdin（control_request/browser_response）；
// GUI browser_control → executor；browser:event → GUI 广播。路由逻辑封装在
// browser-routing.mjs（可单测），此处仅提供 writeControlRequest 并初始化。
// ---------------------------------------------------------------------------
function writeControlRequest(sessionId, msg) {
  const s = sessions.get(sessionId)
  if (s && s.proc && !s.proc.killed) {
    try {
      s.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (e) {
      console.warn('[bridge] writeControlRequest failed:', e.message)
    }
  }
}
const browserRouter = makeBrowserRouter({ writeKernel: writeControlRequest })

// Windows cmd.exe requires shell-wrapped arguments: values containing spaces
// must be enclosed in double quotes (Node does not escape args when shell is
// enabled). Double quotes inside values are dropped to avoid breaking the line.
const q = (s) => '"' + String(s).replace(/"/g, '') + '"'

// Build the isolated environment for spawned CLI processes.
// CLAUDE_CONFIG_DIR redirects Claude Code's config dir to ~/.yfworking so
// the agent's sessions, memory, and skills never collide with ~/.claude.
function buildChildEnv() {
  const cfg = loadConfig()
  const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider) || cfg.providers?.[0]
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: YFW_HOME,
    YFWORKING_HOME: YFW_HOME,
  }
  // 开启内核原生定时任务（Kairos Cron：CronCreate/CronDelete/CronList 工具）
  // 与 /loop 循环执行 skill。release 内核 bundle 已编译全部代码，仅需此开关。
  // 用户环境变量可显式覆盖（如设为 false 关闭）。
  env.CLAUDE_CODE_AGENT_TRIGGERS =
    process.env.CLAUDE_CODE_AGENT_TRIGGERS === 'false' ? 'false' : 'true'
  // Inject the active provider's API config as ANTHROPIC_* env vars so the
  // Claude Code kernel actually calls the user-configured endpoint/model
  // with the user's token. Without these the CLI falls back to its built-in
  // anthropic.com defaults and the saved config is ignored at runtime.
  if (provider && provider.apiBaseUrl && provider.authToken) {
    env.ANTHROPIC_BASE_URL = provider.apiBaseUrl
    env.ANTHROPIC_AUTH_TOKEN = provider.authToken
    const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
    if (model) {
      env.ANTHROPIC_MODEL = model
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.subagentModel || model
    }
    if (provider.contextWindow) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(provider.contextWindow)
    }
    // Raise the kernel's max output token ceiling (default 32k). 64k is within
    // the native limit of current sonnet/opus models; older models with lower
    // caps are safely clamped by the kernel. Explicit user env still wins.
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '64000'
    console.log('[bridge] active provider:', provider.id, '| model:', model, '| baseUrl:', provider.apiBaseUrl)
  } else if (provider) {
    console.warn('[bridge] provider', provider.id, 'missing apiBaseUrl or authToken — using CLI defaults')
  }
  // OpenAI 兼容协议（provider.protocol === 'openai'）：注入 OPENAI_* env（双协议前置项）
  if (provider && provider.protocol === 'openai' && provider.apiBaseUrl && provider.authToken) {
    env.OPENAI_BASE_URL = provider.apiBaseUrl
    env.OPENAI_API_KEY = provider.authToken
    const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
    if (model) env.OPENAI_MODEL = model
    if (provider.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(provider.contextWindow)
    console.log('[bridge] openai-compatible provider:', provider.id, '| model:', model, '| baseUrl:', provider.apiBaseUrl)
  }
  // 内核枚举 $YFW_HOME/agents/*.md 依赖 ripgrep（vendor/ripgrep/*/rg.exe）。
  // 早期发布包未携带该二进制导致静默失败（ENOENT→空列表）——当时强制走原生
  // Node 文件搜索兜底。现在发布包与 dev 构建均已随带 rg.exe，原生搜索反而
  // 无条件递归整棵 cwd 树（不跳过 node_modules/.git）拖慢启动与搜索；
  // 改为：rg 可用时走 ripgrep 快速路径，仅当 rg 缺失时才强制原生兜底。
  // 用户环境变量可显式覆盖（设为 false 关闭）。
  if (!ripgrepAvailable() && process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH !== 'false') {
    env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = 'true'
  }
  // 内核工具结果预算（opt-in：显式 true 才开启，20KB 保守截断；未设置 = 现状。
  // 批次 3 A/B 验收通过后再改为默认开启。）
  if (process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET === 'true') {
    env.CLAUDE_CODE_TOOL_RESULT_BUDGET = 'true'
    if (!process.env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES) {
      env.CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES = '20000'
    }
  }
  return env
}

/** 检测内核候选路径下是否随带 ripgrep 二进制（release/dev 任一命中即可用）。 */
function ripgrepAvailable() {
  const bases = [
    join(__dirname, '..', 'kernel'),                                  // release: <app>/kernel
    join(__dirname, '..', '..', 'kernel'),                            // 备选部署布局
    join(__dirname, '..', 'yfw-kernel', 'claude-code', 'dist'),       // dev 源码构建
  ]
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const base of bases) {
    try {
      const rgDir = join(base, 'vendor', 'ripgrep')
      if (!existsSync(rgDir)) continue
      if (readdirSync(rgDir).some(d => existsSync(join(rgDir, d, exe)))) return true
    } catch { /* continue */ }
  }
  return false
}

// 多行 "- " 列表解析（triggers 与 subskills 共用）：/^key:\n(- item\n)*/m
// 行清洗：去 "- " 前缀、去首尾空白、去引号（" / '）、过滤空行；无该字段或失败 → []
export function parseTriggers(yaml) {
  const m = yaml.match(/^triggers:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (!m) return []
  return m[1]
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// 单行字段解析（parent 用）：值去引号/空白；无该字段或失败 → ''
export function parseParent(yaml) {
  // 修正版：用 [ \t]* 而非 \s*，避免空 "parent:" 独占一行时吞换行误读下一行字段
  const m = yaml.match(/^parent:[ \t]*["']?(.+?)["']?[ \t]*$/m)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}

// 剥离 description 内嵌版本更新日志（v1.0.0初始版本：…。、v1.1.0新增：…。）
// 以句号或串尾为界；不匹配不完整版本号（如 v1.0）
const VERSION_HISTORY_RE = /\bv\d+\.\d+\.\d+[^。]*(?:。|$)/g
export function stripVersionHistory(text) {
  return text.replace(VERSION_HISTORY_RE, '').trim()
}

// subskills 多行列表解析：与 parseTriggers 同构，仅键名不同
export function parseSubskills(yaml) {
  const m = yaml.match(/^subskills:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (!m) return []
  return m[1]
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// subskills 回退 dependencies：旧套件技能（yfwdoc-suite 等）用 dependencies 声明子技能，
// 前端折叠面板只认 subskills——未声明时把 dependencies 当作子技能列表补齐，保证折叠层级一致
export function parseSubskillsOrDeps(yaml) {
  const sub = parseSubskills(yaml)
  if (sub.length) return sub
  const m = yaml.match(/^dependencies:\s*\n((?:\s*-\s*.+\n?)+)/m)
  if (!m) return []
  return m[1]
    .split('\n')
    .map(line => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// 单技能清单条目（spec 5.2）：
// 有 parent → 不生成条目（返回 null，调用方过滤）
// 父技能（有 subskills）→ "- {name}：{触发词段截 80}（子：名1、名2…）"
// 独立技能 → "- {name}：{triggers 或 desc 剥版本，截 80}"
// 触发词与剥版本后描述均空 → "- {name}"
const TRIGGER_CHAR_LIMIT = 80
export function formatSkillEntry({ name, description, triggers, subskills, hasParent }) {
  if (hasParent) return null
  let triggerPart = ''
  if (triggers.length) {
    triggerPart = triggers.join('、')
  } else {
    const stripped = stripVersionHistory(description)
    if (stripped) triggerPart = stripped
  }
  if (triggerPart.length > TRIGGER_CHAR_LIMIT) {
    triggerPart = triggerPart.slice(0, TRIGGER_CHAR_LIMIT - 1) + '…'
  }
  let line = '- ' + name
  if (triggerPart) line += '：' + triggerPart
  if (subskills.length) line += '（子：' + subskills.join('、') + '）'
  return line
}

// 扫描已安装技能（~/.yfworking/skills 下各 SKILL.md 的 frontmatter），供模型识别并自主调用
export function listInstalledSkills() {
  const dir = findSkillRoot()
  const skills = []
  try {
    for (const it of readdirSync(dir, { withFileTypes: true })) {
      if (it.name.startsWith('_')) continue
      if (!it.isDirectory() && !it.name.endsWith('.md')) continue
      const entry = it.isDirectory() ? join(dir, it.name, 'SKILL.md') : join(dir, it.name)
      if (!existsSync(entry)) continue
      let name = it.name
      let desc = ''
      let triggers = []
      let parent = ''
      let subskills = []
      try {
        const md = readFileSync(entry, 'utf-8')
        const yaml = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (yaml) {
          const nm = yaml[1].match(/name:\s*["']?(.+?)["']?\s*$/m)
          const dm = yaml[1].match(/description:\s*["']?(.+?)["']?\s*$/m)
          if (nm) name = nm[1].trim()
          if (dm) desc = dm[1].trim()
          triggers = parseTriggers(yaml[1])
          parent = parseParent(yaml[1])
          subskills = parseSubskillsOrDeps(yaml[1])
        }
      } catch {}
      skills.push({ name, description: desc, triggers, parent, subskills })
    }
  } catch {}
  return skills
}

// 技能清单缓存：每次 spawn 会话都全量扫描 ~60 个 SKILL.md 并重新拼装清单段落，
// 白白消耗 CPU 与 token。以目录指纹（技能名 + SKILL.md 的 size/mtime）为键做内存
// 缓存——技能目录不变则复用上次拼装好的段落，技能增删改时指纹变化自动重建。
let skillListCache = ''
let skillListCacheKey = ''

function skillDirFingerprint(dir) {
  try {
    const parts = []
    for (const it of readdirSync(dir, { withFileTypes: true })) {
      if (it.name.startsWith('_')) continue
      const entry = it.isDirectory() ? join(dir, it.name, 'SKILL.md') : join(dir, it.name)
      if (!existsSync(entry)) continue
      const st = statSync(entry)
      parts.push(it.name + ':' + st.size + ':' + Math.round(st.mtimeMs))
    }
    return parts.sort().join('|')
  } catch { return '' }
}

// 把已安装技能清单附加到系统提示词，确保模型知晓可用技能并优先调用 Skill 工具。
// compact=true 时注入精简清单（技能名 + 至多前 6 个触发词 + 父技能标注），用于 resume
// 会话：模型本就知晓已装技能，仅需可定位，避免每次恢复重复注入全量描述白耗 token。
export function appendSkillList(basePrompt, compact = false) {
  if (compact) return basePrompt + buildCompactSkillSection()
  const dir = findSkillRoot()
  const fp = skillDirFingerprint(dir)
  if (skillListCache && fp === skillListCacheKey) return basePrompt + skillListCache
  const skills = listInstalledSkills()
  if (!skills.length) return basePrompt
  const section = '\n\n【已安装技能清单】当用户任务与以下任一技能匹配时，必须调用 Skill 工具执行（skill 参数填技能名），不得跳过、自行模拟或改用其它方式：\n' +
    skills
      .map(s => formatSkillEntry({ name: s.name, description: s.description, triggers: s.triggers, subskills: s.subskills, hasParent: !!s.parent }))
      .filter(Boolean)
      .join('\n')
  skillListCache = section
  skillListCacheKey = fp
  return basePrompt + section
}

// 精简技能清单（resume 专用）：只保留技能名（唯一调用标识）+ 至多前 6 个触发词 +
// 父技能标注，不再附完整描述与子技能列表。拼装很轻，无需走指纹缓存。
function buildCompactSkillSection() {
  const skills = listInstalledSkills()
  if (!skills.length) return ''
  const lines = skills
    .map(s => {
      const triggers = Array.isArray(s.triggers) ? s.triggers.slice(0, 6).join('/') : ''
      const parent = s.parent ? `（父:${s.parent}）` : ''
      return `- ${s.name}${parent}${triggers ? `：${triggers}` : ''}`
    })
    .filter(Boolean)
  return '\n\n【已安装技能清单（精简）】技能名即唯一调用标识，任务匹配时直接用 Skill 工具调用对应技能：\n' + lines.join('\n')
}

// 经验注入开关/上限：存 ~/.yfworking/config.json（GUI 设置页经 fetchBridgeConfig/saveBridgeConfig 读写）
function experienceInjectConfig() {
  try {
    const cfg = JSON.parse(readFileSync(join(YFW_HOME, 'config.json'), 'utf-8'))
    return {
      enabled: cfg.experienceInjectEnabled !== false,
      maxBytes: Number(cfg.experienceInjectMaxBytes) > 0 ? Number(cfg.experienceInjectMaxBytes) : 4096,
    }
  } catch {
    return { enabled: true, maxBytes: 4096 }
  }
}

function getOrCreateSession(sid, cwd, resumeId, systemPrompt, model, compactCount) {
  if (sessions.has(sid)) {
    const s = sessions.get(sid)
    if (s.proc && !s.proc.killed) return s
    sessions.delete(sid)
  }
  // 系统提示词临时文件：会话进程退出后删除，避免在 %TEMP% 长期堆积
  let promptFile = null
  const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  // 权限审批走内核 can_use_tool control_request/control_response 协议：
  // 没有 --permission-prompt-tool stdio 时，非交互 print 模式下 ask 决策会直接
  // 退化为自动 deny（实证发现，spec §4.2），高风险命令将无法被用户批准。
  args.push('--permission-prompt-tool', 'stdio')
  // GUI 不渲染 AskUserQuestion 工具交互 —— 强制模型使用 <!--ASK_USER--> 注释输出提问卡片
  args.push('--disallowedTools', 'AskUserQuestion')
  if (resumeId) {
    // Resume: restore the original session. 不重复注入身份提示词（避免冲突），
    // 但必须追加互动格式规范 + 技能清单，否则模型看不到 ASK_USER 唯一提问方式，
    // 会回退调用已被禁用的 AskUserQuestion 工具。
    args.push('--resume', resumeId)
    // 精简技能清单默认开启；CLAUDE_CODE_FULL_SKILL_LIST=1 回退全量（不打折保险）
    const resumeCompact = process.env.CLAUDE_CODE_FULL_SKILL_LIST !== '1'
    let resumePrompt = appendSkillList(YFW_ASKUSER_FORMAT + YFW_MILESTONE_PROTOCOL, resumeCompact)
    const injectCfg = experienceInjectConfig()
    if (injectCfg.enabled) {
      // 沉积引导同样注入 resume 会话：原实现只进新会话，而应用默认"恢复最新
      // 会话"、日常调试几乎全在 resume 会话里 → 内核收不到沉积指令，个人经验库
      // 在迁移后零新增（2026-08-15 后实测无写入）。resume 一并携带后恢复的
      // 会话也能正常沉淀经验。
      resumePrompt += buildSedimentPrompt()
      resumePrompt += buildExperienceIndex(injectCfg.maxBytes)
    }
    const resumePromptFile = join(tmpdir(), 'yfw-prompt-' + sid.replace(/[^\w-]/g, '_') + '.resume.txt')
    promptFile = resumePromptFile
    try { writeFileSync(resumePromptFile, resumePrompt, 'utf-8') } catch {}
    args.push('--append-system-prompt-file', q(resumePromptFile))
  } else {
    // New session: inject the YFWorking identity / agent-specific system prompt.
    // Windows cmd.exe cannot carry multi-line args, so collapse newlines to
    // spaces and drop double quotes before quoting the value for the shell.
    // 自定义 agent systemPrompt 会整体替换默认提示词，必须追加互动问答格式 +
    // 里程碑协议，否则专家 agent 会话收不到 ASK_USER 卡片规范（会回退调用已被
    // 禁用的 AskUserQuestion 工具）与进度协议。
    ensurePersonalDir()
    let effectivePrompt = systemPrompt
      ? appendSkillList(`${systemPrompt}\n\n${YFW_ASKUSER_FORMAT}\n\n${YFW_MILESTONE_PROTOCOL}`)
      : appendSkillList(YFW_SYSTEM_PROMPT)
    const injectCfg = experienceInjectConfig()
    if (injectCfg.enabled) {
      effectivePrompt += buildSedimentPrompt()      // 沉积引导仅新会话注入
      effectivePrompt += buildExperienceIndex(injectCfg.maxBytes)
    }
    // 写入临时文件传入（--append-system-prompt-file）：技能清单可能很长，
    // 命令行直接传会超 cmd.exe 8191 字符限制导致 spawn 失败；文件方式还保留换行，格式示例更清晰。
    const newSessionPromptFile = join(tmpdir(), 'yfw-prompt-' + sid.replace(/[^\w-]/g, '_') + '.txt')
    promptFile = newSessionPromptFile
    try { writeFileSync(promptFile, effectivePrompt, 'utf-8') } catch {}
    args.push('--append-system-prompt-file', q(promptFile))
  }
  if (model) args.push('--model', q(model))
  if (cwd) args.push('--add-dir', q(cwd))
  const skillRoot = findSkillRoot()
  if (existsSync(skillRoot)) args.push('--add-dir', q(skillRoot))
  console.log('[bridge] skill root:', skillRoot)
  console.log('[bridge] spawn:', sid.slice(0, 8), resumeId ? '(resume ' + resumeId.slice(0,8) + ')' : '(new)', cwd || process.cwd())
  let proc
  const spawnT0 = Date.now()
  try {
    // DEP0190：Node 对 shell:true + args 抛弃用警告（参数"仅拼接不转义"）。
    // 此处 args 均已 q() 加引号转义，把整条命令拼进 command 字符串传给
    // cmd.exe 与原来的 spawn 拼接行为完全等价（子进程 argv 实测一致），
    // 且不再触发该弃用警告。
    proc = spawn([YFWORKING, ...args].join(' '), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...buildChildEnv(),
        // 注入该会话的历史压缩次数：内核 seedHealthFromEnv() 在模块加载时恢复
        // compactCount（进程内变量在空闲回收后清零是"压缩次数时有时无"的根因），
        // 恢复后首轮强制发射 yfw_health 覆盖 GUI 旧快照。
        ...(Number.isFinite(Number(compactCount)) && Number(compactCount) > 0
          ? { YFW_HEALTH_COMPACT_COUNT: String(Number(compactCount)) }
          : {}),
      },
      cwd: cwd || process.cwd(),
      shell: true,
    })
  } catch (e) {
    send({ type: 'error', data: { message: 'Failed to spawn CLI: ' + e.message }, sessionId: sid })
    return null
  }
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    session._lastOutAt = Date.now()
    session._stallWarnedAt = 0
    // 首 token 计时探针：首个非空 stdout 行到达时记录距 spawn 的耗时。
    if (!session.firstTokenAt) {
      session.firstTokenAt = Date.now()
      diagInfo.firstTokenTotal++
      diagInfo.firstTokenOk++
      console.log(`[bridge] first-token ${session.firstTokenAt - spawnT0}ms (sid ${sid.slice(0, 8)})`)
    }
    let parsed = null
    try { parsed = JSON.parse(t) } catch (_) {}
    if (parsed && parsed.usage && parsed.type === 'result') {
      const u = parsed.usage
      diagInfo.lastApiSuccessAt = Date.now()
      console.log(`[bridge] usage in=${u.input_tokens ?? '-'} out=${u.output_tokens ?? '-'} (sid ${sid.slice(0, 8)})`)
    }
    // 优雅停止确认：cancel 后内核完成被中断的轮次（result 到达）→ 停止生效，
    // 内核进程保持存活、会话保留（getOrCreateSession 直接复用，可无缝续聊）。
    if (session._cancelPending && parsed && parsed.type === 'result') {
      session._cancelPending = false
      session._cancelAt = 0
      console.log(`[bridge] cancel effective (graceful, session retained) sid ${sid.slice(0, 8)}`)
    }
    // 轮次活跃跟踪（供内核空闲回收判定）：assistant 开启轮次，result 结束轮次。
    if (parsed && parsed.type === 'assistant') session._turnActive = true
    else if (parsed && parsed.type === 'result') session._turnActive = false
    // Intercept assistant text/thinking containing milestone marks and
    // <!--ASK_USER...--> blocks (text only — thinking is model reasoning).
    if (parsed && parsed.type === 'assistant') {
      const msgContent = parsed.message?.content
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          // deepseek 等推理模型常把里程碑标记写在 thinking 块内——text 与 thinking
          // 都提取里程碑；提问卡片（ASK_USER）只从可见 text 提取。
          const isText = block.type === 'text' && typeof block.text === 'string'
          const isThink = block.type === 'thinking' && typeof block.thinking === 'string'
          if (!isText && !isThink) continue
          const field = isText ? 'text' : 'thinking'
          const mk = extractMilestoneMarks(block[field])
          const structuredUsed = !!(mk.milestones || mk.starts.length || mk.oks.length)
          if (mk.milestones) {
            send({ type: 'milestones', sessionId: sid, data: mk.milestones })
          }
          for (const st of mk.starts) {
            send({ type: 'milestone-start', sessionId: sid, data: st })
          }
          for (const ok of mk.oks) {
            send({ type: 'milestone-ok', sessionId: sid, data: ok })
          }
          if (structuredUsed && session._proseProgress) {
            session._proseProgress.structuredUsed = true
          }
          if (mk.stripped !== block[field]) {
            block[field] = mk.stripped || (isText ? '(…)' : '')   // 防止全标记文本变成空块
          }
          // 散文兜底：未使用结构化标记的会话，从"阶段 X/Y / 步骤 X/Y"叙述驱动进度，
          // 即使 agent 不输出标记也能看到真实进度。
          if (!structuredUsed && session._proseProgress && !session._proseProgress.structuredUsed) {
            const stages = extractProseStages(block[field])
            if (stages) {
              const pp = session._proseProgress
              // total 只增不减：后到的较小 total（如"步骤 1/3"之后的"阶段 2/2"）
              // 不能覆盖已声明的更大规划，否则比例会被压缩到"到头"。
              if (stages.total > pp.total) {
                pp.total = stages.total
                send({ type: 'milestones', sessionId: sid, data: { total: stages.total, names: [] } })
              }
              // 规划列举检测：单条消息内出现完整 1..total 连续序列
              // （如"步骤 1/3、2/3、3/3"）是任务开始时的计划叙述而非进度报告，
              // 只记录 total，不推进 current（否则会一步显示到头）。
              const isPlanListing = stages.total > 0 &&
                stages.stages.length >= stages.total &&
                stages.stages.every((s, i) => s.index === i + 1)
              if (!isPlanListing) {
                for (const s of stages.stages) {
                  if (s.index > pp.lastIndex) {
                    pp.lastIndex = s.index
                    send({ type: 'milestone-ok', sessionId: sid, data: { index: s.index, total: pp.total, name: '' } })
                  }
                }
              }
            }
          }
          if (isText) {
            // 卡片提取与剥离一体化：无论解析是否成功，原始 <!--ASK_USER...--> 标记
            // 一律从文本剥离，绝不转发给前端（避免气泡里出现原始 HTML）。
            const extracted = extractAskUserBlocks(block.text)
            if (extracted.blocks.length > 0) {
              block.text = extracted.clean.trim() || '(Asking...)'
              for (const b of extracted.blocks) {
                const qdata = parseAskUserPayload(b.payloadText)
                if (qdata) {
                  session._pendingQuestions = qdata
                  send({ type: 'question', sessionId: sid, data: qdata })
                } else {
                  // 解析失败：带 raw 载荷让前端尝试容错解析；仍无法解析时由
                  // 前端渲染层用内联只读卡兜底，用户至少能看到问题内容直接回复。
                  console.warn('[bridge] ASK_USER payload parse failed, forwarding raw:', b.payloadText.slice(0, 160))
                  send({ type: 'question', sessionId: sid, data: { raw: b.payloadText } })
                }
              }
            }
          }
        }
      }
    }
    // 内核挂起的权限请求（can_use_tool control_request）：转发 approval 事件驱动
    // 前端审批弹窗。每个权限请求内核都会挂起等待 control_response——必须逐一响应，
    // 否则对应工具永远阻塞。以 control_request 为唯一弹窗触发源（而非 assistant
    // tool_use 预判）：它携带 request_id，且保证"内核强制 ask 的每一条命令必有弹窗"。
    // 放宽判定：任何带 tool 信息的 control_request 都转发（不同内核版本 subtype 名
    // 可能有差异，如 request_use_tool/approval_request），tool_use_id 缺失时用
    // request_id 合成唯一键，保证审批结果能回填解除挂起。
    if (parsed && parsed.type === 'control_request' && parsed.request) {
      const req = parsed.request
      const isToolReq = req.subtype === 'can_use_tool' || !!req.tool_use_id || !!req.tool_name || !!req.input
      if (isToolReq) {
        const toolUseId = req.tool_use_id || ('req-' + (parsed.request_id || 'unknown'))
        const command = typeof req.input?.command === 'string' ? req.input.command : ''
        session._pendingApprovals.set(toolUseId, {
          requestId: parsed.request_id,
          command,
          reason: req.decision_reason || '',
          toolName: req.tool_name || '',
        })
        send({
          type: 'approval',
          sessionId: sid,
          data: {
            toolUseId,
            command,
            requestId: parsed.request_id,
            reason: req.decision_reason || '',
            toolName: req.tool_name || '',
            highRisk: matchesHighRisk(command),
          },
        })
      }
    }
    // 内置浏览器自动化：内核 bridge_request(route=browser) → 主进程执行器。
    // bridge 只路由不解析（快照脱敏/精简由执行器侧 browser-common 完成）。
    // return 短路：不落入下方普通 event 转发，避免载荷（可能含目标 URL/参数）
    // 泄漏给 GUI。
    if (parsed && parsed.type === 'bridge_request' && parsed.route === 'browser') {
      browserRouter.onKernelBridgeRequest(sid, parsed)
      return
    }
    if (parsed) {
      send({ type: 'event', data: parsed, sessionId: sid })
    } else {
      send({ type: 'raw', data: t, sessionId: sid })
    }
  })
  if (proc.stderr) createInterface({ input: proc.stderr }).on('line', (l) => { send({ type: 'stderr', data: l, sessionId: sid }) })
  proc.on('error', (e) => { if (promptFile) { try { rmSync(promptFile, { force: true }) } catch {} }; send({ type: 'error', data: { message: e.message }, sessionId: sid }); sessions.delete(sid) })
  proc.on('close', (code) => {
    // 会话结束 → 清理临时系统提示词文件，避免 %TEMP% 堆积
    if (promptFile) { try { rmSync(promptFile, { force: true }) } catch {} }
    sessions.delete(sid)
    // 空闲回收触发的退出不广播 closed：前端保留该会话的任务卡等 UI 状态，
    // 下次发消息会以 --resume 无缝重启内核（广播 closed 会让渲染层清空任务卡）。
    if (!session._reaped) send({ type: 'closed', data: {}, sessionId: sid })
    // 诊断埋点：非零退出码且非主动取消 → 计为内核异常退出（崩溃）。
    // 主动取消（cancel）会 kill 内核但 _cancelPending 置位，不计入崩溃。
    if (code !== 0 && code !== null && !session._cancelPending) {
      diagInfo.kernelCrashCount++
      console.error(`[bridge] kernel exited abnormal code=${code} (sid ${sid.slice(0, 8)})`)
    }
  })
  const session = { proc, cwd: cwd || process.cwd(), _pendingQuestions: null, _proseProgress: { total: 0, lastIndex: 0, structuredUsed: false }, _pendingApprovals: new Map(), firstTokenAt: null, _lastOutAt: 0, _turnActive: false, _stallWarnedAt: 0, _reaped: false, _cancelPending: false, _cancelAt: 0, _cancelTimer: null }
  sessions.set(sid, session)
  return session
}

// ---------------------------------------------------------------------------
// WS 背压控制：客户端（渲染层/桌面宠物）处理不过来时，内核事件在 socket 发送
// 缓冲中无界堆积（ws 库不设上限）——bridge 内存随之膨胀，客户端永远追不上积压，
// 形成正反馈螺旋（子 agent 活跃期事件量最大，与整机卡死触发时机吻合）。
// 策略：缓冲超上限（8MB）标记过载，过载期间丢弃低优先级事件（进度/里程碑/raw/
// stderr 类），关键事件（assistant/result/审批/提问/错误/关闭）永不丢；
// 缓冲降到下限（2MB）以下自动恢复全量，滞回防止抖动。
// ---------------------------------------------------------------------------
const WS_OVERLOAD_BYTES = 8 * 1024 * 1024
const WS_OVERLOAD_CLEAR_BYTES = 2 * 1024 * 1024

function isLowPriorityMessage(msg) {
  if (msg.type === 'milestones' || msg.type === 'milestone-start' ||
      msg.type === 'milestone-ok' || msg.type === 'question-resolved' ||
      msg.type === 'raw' || msg.type === 'stderr') return true
  if (msg.type === 'event' && msg.data && msg.data.type === 'system') {
    // 任务进度为累计型高频事件：最终态由 task_notification 送达，中间帧可丢
    return msg.data.subtype === 'task_progress'
  }
  return false
}

function send(msg) {
  const payload = JSON.stringify(msg)
  for (const c of wsClients) {
    if (c.readyState !== 1) continue
    if (c._yfwOverloaded && isLowPriorityMessage(msg)) continue
    try {
      c.send(payload)
    } catch (e) {
      // 发送时 socket 已损坏（close 竞态）——回收该客户端，避免异常冒泡击穿进程
      console.warn('[bridge] send failed, dropping client:', e.message)
      wsClients.delete(c)
      try { c.terminate() } catch {}
      continue
    }
    const buffered = c.bufferedAmount
    if (buffered > WS_OVERLOAD_BYTES) {
      if (!c._yfwOverloaded) {
        console.warn(`[bridge] WS client overloaded (${(buffered / 1048576).toFixed(1)}MB buffered) — shedding low-priority events until drained`)
      }
      c._yfwOverloaded = true
    } else if (c._yfwOverloaded && buffered < WS_OVERLOAD_CLEAR_BYTES) {
      c._yfwOverloaded = false
      console.log('[bridge] WS client drained — full event stream resumed')
    }
  }
}

// 本地桥接服务只应答本机可信来源：
//  - 无 Origin（Electron 主进程 / Node 客户端）
//  - file:// 页面（打包版生产加载方式，fetch 时 Origin 为 null）
//  - localhost / 127.0.0.1 / ::1 任意端口（Vite dev server）
// 恶意网页（https://evil.com 等）拿不到 CORS 响应头，无法读取 /raw-file
// 等敏感端点，同时 GET 请求会直接被 403 拒绝。
function isAllowedOrigin(origin) {
  if (!origin) return true
  if (origin === 'null') return true
  try {
    const u = new URL(origin)
    if (u.protocol === 'file:') return true
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
  } catch { return false }
}

const httpServer = createServer(async (req, res) => {
  let sent = false
  const reply = (code, headers, body) => { if (!sent) { sent = true; res.writeHead(code, headers); res.end(body) } }
  // 白名单之外的外部来源一律 403（含预检请求），绝不回放 '*'
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    reply(403, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Forbidden origin' }))
    return
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  if (req.method === 'OPTIONS') { reply(204, {}); return }
  const url = new URL(req.url, 'http://localhost:' + PORT)
  try {
    if (url.pathname === '/drives') {
      const drives = []
      for (let c = 65; c <= 90; c++) {
        const dr = String.fromCharCode(c) + ':' + sep
        if (existsSync(dr)) drives.push({ name: dr.replace(/\\/g, '/'), path: dr.replace(/\\/g, '/'), type: 'drive' })
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ drives }))
    }
    if (url.pathname === '/list-dir') {
      const dir = resolve((url.searchParams.get('path') || '.').replace(/\//g, sep))
      // 异步读取 + 条目上限：原实现 readdirSync + 逐文件 statSync 全同步跑在
      // HTTP handler 里——大目录（尤其机械盘上的项目树）会阻塞整个 bridge
      // 事件循环数秒到数十秒，期间所有会话转发与 WS 心跳停摆（整机卡死诱因之一）。
      const MAX_LIST_ENTRIES = 2000
      const items = await readdir(dir, { withFileTypes: true })
      const dirNames = []
      const fileNames = []
      for (const x of items) {
        if (x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('$')) dirNames.push(x.name)
        else if (x.isFile()) fileNames.push(x.name)
      }
      dirNames.sort((a, b) => a.localeCompare(b))
      fileNames.sort((a, b) => a.localeCompare(b))
      const dirs = dirNames.slice(0, MAX_LIST_ENTRIES).map(name => ({ name, path: join(dir, name).replace(/\\/g, '/'), type: 'directory' }))
      const files = (await Promise.all(fileNames.slice(0, MAX_LIST_ENTRIES).map(async name => {
        try { return { name, path: join(dir, name).replace(/\\/g, '/'), type: 'file', size: (await stat(join(dir, name))).size } }
        catch { return null }
      }))).filter(Boolean)
      const entries = [...dirs, ...files]
      const truncated = dirNames.length + fileNames.length > entries.length
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ path: dir.replace(/\\/g, '/'), parent: dirname(dir).replace(/\\/g, '/'), entries, truncated }))
    }
    if (url.pathname === '/read-file') {
      const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
      const st = statSync(fp)
      if (st.isDirectory() || st.size > 524288) throw new Error('Invalid or too large')
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ path: fp.replace(/\\/g, '/'), content: readFileSync(fp, 'utf-8'), size: st.size }))
    }
    if (url.pathname === '/raw-file') {
      const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
      const st = statSync(fp)
      const mimes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8' }
      return reply(200, { 'Content-Type': mimes[fp.split('.').pop()] || 'application/octet-stream', 'Content-Length': st.size }, readFileSync(fp))
    }
    if (url.pathname === '/write-file' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const fp = resolve((body.path || '').replace(/\//g, sep))
      if (!body.path) throw new Error('path required')
      const content = String(body.content ?? '')
      if (Buffer.byteLength(content, 'utf-8') > 2097152) throw new Error('Content too large')
      writeFileSync(fp, content, 'utf-8')
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, path: fp.replace(/\\/g, '/') }))
    }
    if (url.pathname === '/convert-office') {
      const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
      const st = statSync(fp)
      if (st.isDirectory() || st.size > 10485760) {
        return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Invalid or too large' }))
      }
      const ext = fp.split('.').pop().toLowerCase()
      const scriptMap = { docx: 'convert_docx.py', xlsx: 'convert_xls.py', xls: 'convert_xls.py' }
      const scriptName = scriptMap[ext]
      if (!scriptName) {
        return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Unsupported format' }))
      }
      const scriptPath = join(__dirname, scriptName)
      try {
        const { stdout } = await new Promise((resolve, reject) => {
          const proc = spawn(findPythonExe(), [scriptPath, fp], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
          let out = ''
          let err = ''
          proc.stdout.on('data', d => { out += d })
          proc.stderr.on('data', d => { err += d })
          proc.on('close', code => {
            if (code === 0) { resolve({ stdout: out }) } else { reject(new Error(err || 'exit ' + code)) }
          })
          proc.on('error', reject)
        })
        const result = JSON.parse(stdout.trim())
        if (result.ok) {
          return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ html: result.html }))
        }
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: result.error || 'Conversion failed' }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message || 'Conversion error' }))
      }
    }
    // 运行 office 处理 python 脚本（转换/结构读取/写回共用）：stdout 必须是单行 JSON
    const runOfficeScript = (scriptName, args) => new Promise((resolve, reject) => {
      const scriptPath = join(__dirname, scriptName)
      const proc = spawn(findPythonExe(), [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
      let out = ''
      let err = ''
      proc.stdout.on('data', d => { out += d })
      proc.stderr.on('data', d => { err += d })
      proc.on('close', code => {
        if (code === 0) {
          try { resolve(JSON.parse(out.trim())) } catch { reject(new Error('Invalid script output')) }
        } else {
          reject(new Error((err || '').trim() || 'exit ' + code))
        }
      })
      proc.on('error', reject)
    })
    // 校验本地 office 文件：非目录、≤10MB（与 /convert-office 同款约束）
    const validOfficeFile = (fp) => {
      const st = statSync(fp)
      if (st.isDirectory() || st.size > 10485760) throw new Error('Invalid or too large')
    }
    // Excel 结构读取（值 + 公式标记），供应用内网格编辑
    if (url.pathname === '/read-sheet') {
      const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
      validOfficeFile(fp)
      try {
        const result = await runOfficeScript('sheet_edit.py', ['read', fp])
        if (!result.ok) throw new Error(result.error || 'read failed')
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, sheets: result.sheets }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message || 'Read error' }))
      }
    }
    // Excel 单元格写回：{ path, sheet, updates:[{row,col,value}] }（公式格跳过）
    if (url.pathname === '/write-sheet' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const fp = resolve((body.path || '').replace(/\//g, sep))
      if (!body.path) throw new Error('path required')
      validOfficeFile(fp)
      const tmp = join(tmpdir(), 'yfw-sheet-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
      writeFileSync(tmp, JSON.stringify(body))
      try {
        const result = await runOfficeScript('sheet_edit.py', ['write', tmp])
        if (!result.ok) throw new Error(result.error || 'write failed')
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message || 'Write error' }))
      } finally {
        try { unlinkSync(tmp) } catch { /* ignore */ }
      }
    }
    // Word 块结构读取（标题/段落/表格），供应用内文档编辑
    if (url.pathname === '/read-docx') {
      const fp = resolve((url.searchParams.get('path') || '').replace(/\//g, sep))
      validOfficeFile(fp)
      try {
        const result = await runOfficeScript('docx_edit.py', ['read', fp])
        if (!result.ok) throw new Error(result.error || 'read failed')
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, blocks: result.blocks }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message || 'Read error' }))
      }
    }
    // Word 块结构写回：{ path, blocks }
    if (url.pathname === '/write-docx' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const fp = resolve((body.path || '').replace(/\//g, sep))
      if (!body.path) throw new Error('path required')
      validOfficeFile(fp)
      const tmp = join(tmpdir(), 'yfw-docx-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
      writeFileSync(tmp, JSON.stringify(body))
      try {
        const result = await runOfficeScript('docx_edit.py', ['write', tmp])
        if (!result.ok) throw new Error(result.error || 'write failed')
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message || 'Write error' }))
      } finally {
        try { unlinkSync(tmp) } catch { /* ignore */ }
      }
    }
    if (url.pathname === '/health') {
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ status: 'ok', pid: process.pid }))
    }

    // 诊断信息端点：diag-monitor 定期轮询（只读内存统计，见 diagInfo 定义）
    if (url.pathname === '/diag/info') {
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, data: diagInfo }))
    }

    // 内核 transcript 读取端点（实现见 transcript.mjs；GUI 会话系统改造第一步）
    const transcriptApi = createTranscriptHandlers()
    if (url.pathname === '/transcript/list') {
      const cwd = url.searchParams.get('cwd') || ''
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, sessions: transcriptApi.listSessions(cwd) }))
    }
    if (url.pathname === '/transcript/load') {
      const cwd = url.searchParams.get('cwd') || ''
      const sessionId = url.searchParams.get('sessionId') || ''
      const tailFirst = url.searchParams.get('tailFirst') !== '0' // 默认 1
      const r = transcriptApi.loadTranscript(cwd, sessionId, tailFirst)
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify(r))
    }
    if (url.pathname === '/transcript/search') {
      const query = url.searchParams.get('query') || ''
      const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, results: transcriptApi.searchTranscripts(query, limit) }))
    }
    // --- /transcript/stats：token 统计聚合（项目/模型/日期），GUI 成本面板数据源 ---
    if (url.pathname === '/transcript/stats') {
      const project = url.searchParams.get('project') || ''
      const base = transcriptBaseDir()
      const stats = project ? aggregateStats(join(base, sanitizePathSegment(project))) : aggregateStats(base)
      // 成本换算：单价表来自 provider 配置
      const cfg = loadConfig()
      const provider = (cfg.providers || []).find((p) => p.id === cfg.activeProvider) || cfg.providers?.[0]
      const priceTable = provider?.pricing || {}
      const withCost = (bucket) => {
        const out = {}
        for (const [k, v] of Object.entries(bucket)) {
          out[k] = { ...v, cost_usd: Number(costUsd({ model: k, input_tokens: v.input_tokens, output_tokens: v.output_tokens }, priceTable).toFixed(4)) }
        }
        return out
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
        ok: true,
        totals: { ...stats.totals, cost_usd: Number(
          Object.entries(stats.byModel).reduce((s, [, v]) => s + costUsd(v, priceTable), 0)
        ).toFixed(4) },
        byModel: withCost(stats.byModel),
        byProject: stats.byProject,
        byDate: stats.byDate,
      }))
    }

    // 豆包图片生成端点（会话/历史/限速见 doubao.mjs；下载去水印走 watermark_remove.py）
    if (url.pathname.startsWith('/yfw/doubao/')) {
      if (url.pathname === '/yfw/doubao/status') {
        const s = doubao.readSessionMeta()
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ loggedIn: doubao.isLoggedIn(), exportedAt: s?.exportedAt || null }))
      }
      if (url.pathname === '/yfw/doubao/history' && req.method === 'GET') {
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ items: doubao.listHistory() }))
      }
      if (url.pathname === '/yfw/doubao/history' && req.method === 'POST') {
        const b = await readJsonBody(req)
        if (!b.id || !b.prompt) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'id and prompt required' }))
        doubao.addHistory({ id: b.id, prompt: b.prompt, imageUrl: b.imageUrl || '', path: b.path || '', createdAt: b.createdAt || Date.now() })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
      if (url.pathname.startsWith('/yfw/doubao/history/') && req.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.split('/').pop())
        doubao.removeHistory(id)
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
      if (url.pathname === '/yfw/doubao/download' && req.method === 'POST') {
        if (doubao.rateLimitHit()) return reply(429, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 429, message: 'rate limited' }))
        const b = await readJsonBody(req)
        if (!b.url) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 400, message: 'url required' }))
        const { nanoid } = await import('nanoid')
        const id = nanoid(12)
        const dir = doubao.imagesDir()
        mkdirSync(dir, { recursive: true })
        const tmpRaw = join(dir, `${id}.raw`)
        try {
          const r = await fetch(b.url, { signal: AbortSignal.timeout(30000) })
          if (!r.ok) throw new Error(`upstream ${r.status}`)
          writeFileSync(tmpRaw, Buffer.from(await r.arrayBuffer()))
        } catch (e) {
          return reply(502, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 502, message: 'download failed: ' + (e?.message || e) }))
        }
        const outPng = join(dir, `${id}.png`)
        const mode = b.mode === 'crop' ? 'crop' : 'auto'
        const proc = spawn(findPythonExe(), [join(__dirname, 'watermark_remove.py'), tmpRaw, '--mode', mode, '--output', outPng], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
        let so = '', se = ''
        proc.stdout.on('data', d => { so += d })
        proc.stderr.on('data', d => { se += d })
        const code = await new Promise(res => {
          proc.on('error', err => { try { rmSync(tmpRaw, { force: true }) } catch {}; res(127) })
          proc.on('close', res)
        })
        try { rmSync(tmpRaw, { force: true }) } catch {}
        if (code !== 0) {
          return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 500, message: 'watermark remove failed: ' + se.slice(0, 200) }))
        }
        let meta
        try { meta = JSON.parse(so.trim().split(/\r?\n/).pop()) } catch { meta = null }
        if (!meta || !meta.ok) {
          return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ code: 500, message: 'watermark remove bad output' }))
        }
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, id, mode: meta.mode, url: `/yfw/doubao/images/${id}`, path: outPng }))
      }
      if (url.pathname.startsWith('/yfw/doubao/images/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/').pop())
        const fp = join(doubao.imagesDir(), `${id}.png`)
        if (!existsSync(fp)) return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'not found' }))
        return reply(200, { 'Content-Type': 'image/png' }, readFileSync(fp))
      }
      return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'unknown doubao endpoint' }))
    }

    // Test provider connectivity before saving. Body: { apiBaseUrl, authToken, model? }
    // Probes the provider's /v1/messages endpoint with a minimal request and
    // reports whether the API accepted the credentials. We do NOT save the
    // config here — the caller only saves after a successful test.
    if (url.pathname === '/test-provider' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const baseUrl = (body.apiBaseUrl || '').replace(/\/$/, '')
      const token = body.authToken || ''
      const model = body.model || (body.models && body.models[0]) || 'test'
      if (!baseUrl || !token) {
        return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Missing apiBaseUrl or authToken' }))
      }
      // Anthropic-compatible providers accept /v1/messages; some use /messages.
      // Try /v1/messages first, then /messages.
      const candidates = [
        baseUrl + '/v1/messages',
        baseUrl + '/messages',
      ]
      let lastErr = ''
      for (const target of candidates) {
        try {
          const payload = JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          })
          const u = new URL(target)
          const result = await new Promise((resolve) => {
            const lib = u.protocol === 'https:' ? https : http
            const r = lib.request(u, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': token,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload),
              },
              timeout: 15000,
            }, (resp) => {
              let buf = ''
              resp.on('data', (d) => { buf += d })
              resp.on('end', () => {
                resolve({ status: resp.statusCode, body: buf })
              })
            })
            r.on('error', (e) => resolve({ status: 0, body: e.message }))
            r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }) })
            r.write(payload)
            r.end()
          })
          // 200 = fully working; 400/401/403/404/429 all mean we reached the
          // API and it responded — credentials/format issue, not connectivity.
          // 0 = network failure (couldn't reach host).
          if (result.status > 0) {
            const ok = result.status === 200 || result.status === 400 || result.status === 401 || result.status === 403 || result.status === 404 || result.status === 429
            let detail = ''
            try { detail = JSON.parse(result.body)?.error?.message || result.body.slice(0, 200) } catch { detail = result.body.slice(0, 200) }
            return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
              ok,
              reachable: true,
              httpStatus: result.status,
              endpoint: target,
              detail,
              authValid: result.status !== 401 && result.status !== 403,
            }))
          }
          lastErr = result.body || 'no response'
        } catch (e) {
          lastErr = e.message
        }
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, reachable: false, error: lastErr }))
    }

    // Spawn a one-shot CLI process with the CURRENT active provider's env vars,
    // wait for the `system/init` stream event (proof CLI loaded new model/auth),
    // kill the process, and report success. Used by the UI to verify a provider
    // switch actually took — without forcing the user to start a new chat.
    if (url.pathname === '/verify-provider' && req.method === 'POST') {
      const TIMEOUT_MS = 5000
      const t0 = Date.now()
      let proc = null
      let resolved = false
      const finish = (payload) => {
        if (resolved) return
        resolved = true
        // Always try to kill the spawned process — it's a one-shot probe
        try { if (proc && !proc.killed) execSync(`taskkill -F -T -PID ${proc.pid}`, { timeout: 3000 }) } catch {}
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ latencyMs: Date.now() - t0, ...payload }))
      }
      try {
        // Ensure kernel settings.json reflects the active provider before spawning
        try { syncKernelSettings() } catch (e) { /* non-fatal */ }
        const env = buildChildEnv()
        const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  // GUI 不渲染 AskUserQuestion 工具交互 —— 强制模型使用 <!--ASK_USER--> 注释输出提问卡片
  args.push('--disallowedTools', 'AskUserQuestion')
        // Add cwd + skill root so the CLI doesn't refuse to start
        const skillRoot = findSkillRoot()
        if (existsSync(skillRoot)) args.push('--add-dir', skillRoot)
        proc = spawn([YFWORKING, ...args].join(' '), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          cwd: process.cwd(),
          shell: true,
        })
        // The CLI buffers stream-json output until it receives a first user
        // message; send a minimal ping to trigger the system/init event that
        // proves the new provider (model + auth) loaded.
        if (proc.stdin) proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'ping' } }) + '\n')
        let stderrBuf = ''
        if (proc.stderr) createInterface({ input: proc.stderr }).on('line', (l) => { stderrBuf += l + '\n' })
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
        rl.on('line', (line) => {
          const t = line.trim()
          if (!t || resolved) return
          try {
            const ev = JSON.parse(t)
            // system/init event proves the CLI loaded the new model + auth
            if (ev.type === 'system' && ev.subtype === 'init') {
              return finish({ ok: true, model: ev.model || env.ANTHROPIC_MODEL || '', tools: ev.tools || [] })
            }
            // API errors arrive as assistant errors or result is_error=true
            if (ev.type === 'result' && ev.is_error) {
              return finish({ ok: false, error: ev.result || 'CLI reported error', stderr: stderrBuf.slice(-500) })
            }
          } catch { /* ignore non-JSON lines */ }
        })
        proc.on('error', (e) => finish({ ok: false, error: e.message }))
        const timeout = setTimeout(() => finish({ ok: false, error: `Verification timed out after ${TIMEOUT_MS}ms — CLI did not emit system/init`, stderr: stderrBuf.slice(-500) }), TIMEOUT_MS)
        proc.on('close', () => {
          clearTimeout(timeout)
          if (!resolved) finish({ ok: false, error: 'CLI process exited before init', stderr: stderrBuf.slice(-500) })
        })
      } catch (e) {
        finish({ ok: false, error: e.message })
      }
      return // response already sent in finish()
    }

    // --- YFWorking config & providers (persisted in ~/.yfworking/) ---
    if (url.pathname === '/config') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const saved = saveConfig(body)
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, config: saved }))
      }
      const cfg = loadConfig()
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify(cfg))
    }
    if (url.pathname === '/providers') {
      const cfg = loadConfig()
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const newProvider = {
          id: (body.name || 'custom').toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-' + Date.now().toString(36),
          name: body.name || 'Custom Provider',
          apiBaseUrl: body.apiBaseUrl || '',
          models: body.models || [],
          primaryModel: body.primaryModel || (body.models && body.models[0]) || '',
          subagentModel: body.subagentModel || (body.models && body.models[0]) || '',
          effortLevel: body.effortLevel || 'high',
          contextWindow: body.contextWindow || 1000000,
          authToken: body.authToken || '',
        }
        const providers = [...(cfg.providers || []), newProvider]
        saveConfig({ providers })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, provider: newProvider }))
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, providers: cfg.providers || [] }))
    }
    if (url.pathname.startsWith('/providers/')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const providerId = parts[1]
      const cfg = loadConfig()
      const providers = cfg.providers || []
      if (req.method === 'PUT') {
        const body = await readJsonBody(req)
        const idx = providers.findIndex(p => p.id === providerId)
        if (idx < 0) return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Provider not found' }))
        providers[idx] = { ...providers[idx], ...body, id: providerId }
        saveConfig({ providers })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
      if (req.method === 'DELETE') {
        const next = providers.filter(p => p.id !== providerId)
        const nextActive = cfg.activeProvider === providerId
          ? (next[0]?.id || 'deepseek')
          : cfg.activeProvider
        saveConfig({ providers: next, activeProvider: nextActive })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      }
    }

    if (url.pathname === '/skills') {
      // Always scan the live skill directory — never trust a stale _skill_index.json
      // (it used to report deleted skills after uninstall).
      const dir = findSkillRoot()
      try {
        const items = readdirSync(dir, { withFileTypes: true })
        const skills = []
        // Parse YAML frontmatter (--- name/description/version/triggers/parent/subskills ---) if present.
        const frontmatterOf = (md) => {
          const meta = { name: '', description: '', version: '', triggers: [], parent: '', subskills: [] }
          const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
          if (!m) return meta
          const grab = (key) => {
            const k = m[1].match(new RegExp('^' + key + ':\\s*["\']?(.+?)["\']?\\s*$', 'm'))
            return k ? k[1].trim() : ''
          }
          meta.name = grab('name')
          meta.description = grab('description')
          meta.version = grab('version')
          meta.triggers = parseTriggers(m[1])
          meta.parent = parseParent(m[1])
          meta.subskills = parseSubskillsOrDeps(m[1])
          return meta
        }
        for (const it of items) {
          if (it.name.startsWith('_')) continue
          if (it.isDirectory()) {
            // Directory-based skill: <skillId>/SKILL.md (also accept lowercase / CLAUDE.md / AGENTS.md)
            const entryFile = ['SKILL.md', 'skill.md', 'CLAUDE.md', 'AGENTS.md'].find(f => existsSync(join(dir, it.name, f)))
            if (!entryFile) continue
            const content = readFileSync(join(dir, it.name, entryFile), 'utf-8')
            const meta = frontmatterOf(content)
            skills.push({
              id: it.name, name: meta.name || it.name,
              description: (meta.description || '').slice(0, 300),
              version: meta.version, triggers: meta.triggers,
              parent: meta.parent, subskills: meta.subskills,
              lines: content.split('\n').length,
              size_kb: Math.round(content.length / 1024),
            })
          } else if (it.isFile() && it.name.endsWith('.md')) {
            // Legacy flat format: <id>.md
            const id = it.name.slice(0, -3)
            const content = readFileSync(join(dir, it.name), 'utf-8')
            const meta = frontmatterOf(content)
            const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
            skills.push({
              id, name: meta.name || id,
              description: (meta.description || firstLine || id).slice(0, 300),
              version: meta.version, triggers: meta.triggers,
              parent: meta.parent, subskills: meta.subskills,
              lines: content.split('\n').length,
              size_kb: Math.round(content.length / 1024),
            })
          }
        }
        if (skills.length)
          return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ skills, dir: dir.replace(/\\/g, '/'), source: 'scan' }))
      } catch {}
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ skills: [], dir: dir.replace(/\\/g, '/'), source: 'none' }))
    }
        if (url.pathname === '/uninstall-skill' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const skillId = (body.skillId || '').toString().trim()
        if (!skillId) throw new Error('skillId required')
        const skillRoot = findSkillRoot()
        const target = join(skillRoot, skillId)
        if (!existsSync(target)) {
          return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'Skill not found', skillId }))
        }
        rmSync(target, { recursive: true, force: true })
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, skillId }))
      } catch (e) {
        return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e.message }))
      }
    }
    if (url.pathname === '/sample-skills') {
      const skillRoot = findSkillRoot()
      const candidates = [...SAMPLE_SKILL_ROOTS]
      const src = candidates.find(p => existsSync(p))
      const skills = []
      if (src) {
        for (const it of readdirSync(src, { withFileTypes: true })) {
          if (!it.isDirectory()) continue
          const mdPath = join(src, it.name, 'SKILL.md')
          if (!existsSync(mdPath)) continue
          const md = readFileSync(mdPath, 'utf-8')
          const yamlMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
          const meta = { name: it.name, description: '', version: '' }
          if (yamlMatch) {
            const grab = (key) => {
              const k = yamlMatch[1].match(new RegExp("^" + key + ":\\s*[\"']?(.+?)[\"']?\\s*$", "m"))
              return k ? k[1].trim() : ''
            }
            meta.name = grab('name') || it.name
            meta.description = grab('description')
            meta.version = grab('version')
          }
          skills.push({ id: it.name, name: meta.name, description: meta.description, version: meta.version, installed: existsSync(join(skillRoot, it.name)) })
        }
      }
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ skills, dir: src ? src.replace(/\\/g, '/') : '' }))
    }
    if (url.pathname === '/worktrees') {
      const out = execSync('git worktree list --porcelain', { cwd: url.searchParams.get('path') || '.', encoding: 'utf-8', timeout: 10000 })
      const w = []; let c = null
      for (const l of out.split('\n')) {
        if (l.startsWith('worktree ')) { if (c) w.push(c); c = { path: l.slice(9).replace(/\\/g, '/'), branch: '(detached)' } }
        else if (l.startsWith('branch ') && c) c.branch = l.slice(21)
      }
      if (c) w.push(c)
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ worktrees: w }))
    }
    if (url.pathname === '/branches') {
      const out = execSync('git branch -a --format="%(refname:short)"', { cwd: url.searchParams.get('path') || '.', encoding: 'utf-8', timeout: 10000 })
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ branches: out.trim().split('\n').filter(Boolean).map(b => b.trim()) }))
    }
    function detectSkillFormat(dir) {
      const skillMdPath = join(dir, 'SKILL.md')
      if (existsSync(skillMdPath)) {
        return { format: 'yfworking', entryFile: 'SKILL.md', content: readFileSync(skillMdPath, 'utf-8') }
      }
      const claudePath = join(dir, 'CLAUDE.md')
      if (existsSync(claudePath)) return { format: 'claude', entryFile: 'CLAUDE.md', content: readFileSync(claudePath, 'utf-8') }
      const skillLowerPath = join(dir, 'skill.md')
      if (existsSync(skillLowerPath)) return { format: 'claude', entryFile: 'skill.md', content: readFileSync(skillLowerPath, 'utf-8') }
      const codexPath = join(dir, 'AGENTS.md')
      if (existsSync(codexPath)) return { format: 'codex', entryFile: 'AGENTS.md', content: readFileSync(codexPath, 'utf-8') }
      const codexLowerPath = join(dir, 'codex.md')
      if (existsSync(codexLowerPath)) return { format: 'codex', entryFile: 'codex.md', content: readFileSync(codexLowerPath, 'utf-8') }
      const pluginPath = join(dir, 'plugin.json')
      if (existsSync(pluginPath)) return { format: 'openclaw', entryFile: 'plugin.json', content: readFileSync(pluginPath, 'utf-8') }
      const manifestPath = join(dir, 'manifest.json')
      if (existsSync(manifestPath)) return { format: 'openclaw', entryFile: 'manifest.json', content: readFileSync(manifestPath, 'utf-8') }
      return null
    }

    function convertToYFWorking(dir, detected) {
      const { format, entryFile, content } = detected
      let skillName = basename(dir)
      let skillDesc = ''
      let skillVersion = '1.0.0'
      let bodyContent = content
      if (format === 'claude' || format === 'codex') {
        const titleMatch = content.match(/^#\s+(.+)$/m)
        if (titleMatch) skillName = titleMatch[1].trim()
        const lines = content.split('\n')
        const titleIdx = lines.findIndex(l => l.match(/^#\s+/))
        if (titleIdx >= 0 && titleIdx + 1 < lines.length) {
          for (let i = titleIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim()
            if (line && !line.startsWith('#') && !line.startsWith('---')) {
              skillDesc = line
              break
            }
          }
        }
        const verMatch = content.match(/version[:\s]+["']?(\d+\.\d+\.\d+)["']?/i)
        if (verMatch) skillVersion = verMatch[1]
      } else if (format === 'openclaw') {
        try {
          const manifest = JSON.parse(content)
          skillName = manifest.name || skillName
          skillDesc = manifest.description || ''
          skillVersion = manifest.version || '1.0.0'
          bodyContent = content
        } catch {}
      }
      const skillMd = `---
name: "${skillName}"
description: "${skillDesc.replace(/"/g, '\\"')}"
version: "${skillVersion}"
dependencies: []
---

<!-- Converted from ${format} format (${entryFile}) -->

${bodyContent}
`
      writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf-8')
      return { name: skillName, description: skillDesc, version: skillVersion, converted: true, originalFormat: format }
    }
    if (url.pathname === '/install-skill' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const sourcePath = resolve((body.path || '').replace(/\//g, sep))
        let actualPath = sourcePath
        if (body.isExample) {
          const exampleName = body.path.split('/').pop() || body.path
          const possiblePaths = SAMPLE_SKILL_ROOTS.map(r => join(r, exampleName))
          for (const p of possiblePaths) {
            if (existsSync(p)) { actualPath = p; break }
          }
        }
        const sourcePathResolved = actualPath
        const st = statSync(sourcePathResolved)
        if (!st.isDirectory()) throw new Error('Path must be a directory containing a skill definition file')
        const detected = detectSkillFormat(sourcePathResolved)
        if (!detected) throw new Error('No recognized skill file found. Expected SKILL.md, CLAUDE.md, AGENTS.md, plugin.json, or manifest.json')
        let converted = false
        let originalFormat = 'yfworking'
        if (detected.format !== 'yfworking') {
          const result = convertToYFWorking(sourcePathResolved, detected)
          converted = true
          originalFormat = result.originalFormat || detected.format
        }
        const skillMdPath = join(sourcePathResolved, 'SKILL.md')
        if (!existsSync(skillMdPath)) throw new Error('Failed to create or find SKILL.md')
        const md = readFileSync(skillMdPath, 'utf-8')
        const yamlMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let skillMeta = { name: '', description: '', version: '0.0.0', dependencies: [] }
        if (yamlMatch) {
          const yaml = yamlMatch[1]
          const nameMatch = yaml.match(/name:\s*["']?(.+?)["']?\s*$/)
          const descMatch = yaml.match(/description:\s*["']?(.+?)["']?\s*$/)
          const verMatch = yaml.match(/version:\s*["']?(.+?)["']?\s*$/)
          const depsMatch = yaml.match(/dependencies:\s*\[(.*?)\]/)
          if (nameMatch) skillMeta.name = nameMatch[1].trim()
          if (descMatch) skillMeta.description = descMatch[1].trim()
          if (verMatch) skillMeta.version = verMatch[1].trim()
          if (depsMatch) skillMeta.dependencies = depsMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean)
        }
        const skillId = skillMeta.name || basename(sourcePathResolved)
        const skillRoot = findSkillRoot()
        const skillDir = join(skillRoot, skillId)
        if (existsSync(skillDir)) {
          return reply(409, { 'Content-Type': 'application/json' }, JSON.stringify({
            ok: false, error: 'Skill already installed. Uninstall first or use update.',
            skillId,
          }))
        }
        mkdirSync(skillDir, { recursive: true })
        // Copy skill files, rewriting {{YFW_SKILLS}} to the real skill root so the
        // bundled package stays portable across machines/usernames.
        copyWithRewrite(sourcePathResolved, skillDir, '{{YFW_SKILLS}}', skillRoot.replace(/\\/g, '/'))
        // Built-in package ships a sibling _common/ shared lib — copy it once.
        if (body.isExample) {
          const srcCommon = join(dirname(sourcePathResolved), '_common')
          const destCommon = join(skillRoot, '_common')
          if (existsSync(srcCommon) && !existsSync(destCommon)) {
            mkdirSync(destCommon, { recursive: true })
            copyWithRewrite(srcCommon, destCommon, '{{YFW_SKILLS}}', skillRoot.replace(/\\/g, '/'))
            console.log('[bridge] shared lib installed ->', destCommon)
          }
        }
        const expPath = join(skillDir, 'experience.json')
        if (!existsSync(expPath)) {
          writeFileSync(expPath, JSON.stringify({
            skill_name: skillId,
            version: skillMeta.version,
            experiences: [],
            execution_reference: { auto_apply_rules: [], common_pitfalls: [], best_practices: [] },
          }, null, 2), 'utf-8')
        }
        let hasDeps = false
        const reqPath = join(skillDir, '_scripts', 'requirements.txt')
        if (existsSync(reqPath)) {
          const reqContent = readFileSync(reqPath, 'utf-8')
          hasDeps = reqContent.split('\n').filter(l => l.trim() && !l.startsWith('#')).length > 0
        }
        const idxPath = join(skillRoot, '_skill_index.json')
        let index = readSkillIndex(idxPath)
        const existing = index.findIndex(s => s.id === skillId)
        const entry = {
          id: skillId,
          name: skillId,
          description: skillMeta.description || skillId,
          version: skillMeta.version || '0.0.0',
          triggers: [],
          lines: md.split('\n').length,
          size_kb: Math.round(md.length / 1024),
          installed_at: new Date().toISOString(),
          installed_from: 'file',
          source_path: sourcePathResolved.replace(/\\/g, '/'),
          dependencies: skillMeta.dependencies || [],
          scripts_dir: existsSync(join(skillDir, '_scripts')) ? '_scripts' : null,
          templates_dir: existsSync(join(skillDir, '_templates')) ? '_templates' : null,
          has_experience: existsSync(join(skillDir, 'experience.json')),
          enabled: true,
        }
        if (existing >= 0) index[existing] = entry
        else index.push(entry)
        writeSkillIndex(idxPath, index)
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
          ok: true, skillId, version: skillMeta.version, hasDeps,
          format: originalFormat, converted,
        }))
      } catch (e) {
        return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e.message }))
      }
    }
  } catch (e) {
    return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message }))
  }
  reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Not found' }))
})

const wss = new WebSocketServer({ server: httpServer })
// Heartbeat：定期 ping，客户端（浏览器/ws 库自动回复 pong）未应答即判定死亡并回收，
// 防止长时间空闲连接被系统/安全软件清理后，服务端仍持有僵尸客户端。
const HEARTBEAT_MS = 30000
const heartbeatTimer = setInterval(() => {
  for (const c of wsClients) {
    if (c.isAlive === false) {
      console.log('[bridge] heartbeat timeout — dropping stale client')
      wsClients.delete(c)
      try { c.terminate() } catch {}
      continue
    }
    c.isAlive = false
    try { c.ping() } catch {}
  }
}, HEARTBEAT_MS)
heartbeatTimer.unref?.()

// ---------------------------------------------------------------------------
// 内核空闲回收：每个会话对应一个 bun 内核进程（1M 上下文模型单进程可达数 GB），
// 会话切换累积的多个常驻内核会吃满物理内存 → 页面文件打盘放大一切卡顿
// （整机卡死放大器之一）。仅在"轮次已结束（result 已到）、无待答提问、
// 无待批审批"且空闲超阈值时回收；回收后前端再发消息会以 --resume 原会话 ID
// 重新 spawn，无缝续聊（代价仅是首次 token 稍慢）。
// YFW_KERNEL_IDLE_MS 覆盖阈值（毫秒），设 0 完全关闭回收。
// ---------------------------------------------------------------------------
const _idleEnv = process.env.YFW_KERNEL_IDLE_MS
const KERNEL_IDLE_REAP_MS = _idleEnv === '0' ? 0 : (Number(_idleEnv) > 0 ? Number(_idleEnv) : 10 * 60 * 1000)
function reapIdleKernels() {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (!s || !s.proc || s.proc.killed) continue
    if (s._turnActive) continue
    if (s._pendingQuestions) continue
    if (s._pendingApprovals && s._pendingApprovals.size > 0) continue
    if (s._lastOutAt > 0 && now - s._lastOutAt < KERNEL_IDLE_REAP_MS) continue
    console.log(`[bridge] idle kernel reaped: sid ${sid.slice(0, 8)} (idle ${s._lastOutAt ? Math.round((now - s._lastOutAt) / 60000) : 0}m)`)
    s._reaped = true
    try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000, stdio: 'ignore' }) } catch { try { s.proc.kill() } catch {} }
    sessions.delete(sid)
  }
}
if (KERNEL_IDLE_REAP_MS > 0) setInterval(reapIdleKernels, 60000).unref?.()

// ---------------------------------------------------------------------------
// 内核失速看门狗：轮次活跃（assistant 已开启、result 未到）但内核 stdout 长期
// 静默 = 疑似挂起（本机实测：360 主动防御 + VBS 双钩子层失速时，powershell/
// 文件 I/O 会阻塞分钟级，工具调用挂在半途，前端表现为"交互没反应"）。
// 只告警不自动杀（杀进程会丢会话工作）；日志 + kernel-stall 事件供前端提示，
// 用户可手动取消/重启会话（--resume 无缝续聊）。
// YFW_KERNEL_STALL_MS 覆盖阈值（毫秒），设 0 关闭。
// ---------------------------------------------------------------------------
const _stallEnv = process.env.YFW_KERNEL_STALL_MS
const KERNEL_STALL_WARN_MS = _stallEnv === '0' ? 0 : (Number(_stallEnv) > 0 ? Number(_stallEnv) : 10 * 60 * 1000)
function warnStalledKernels() {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (!s || !s.proc || s.proc.killed) continue
    if (!s._turnActive) continue
    if (s._lastOutAt <= 0 || now - s._lastOutAt < KERNEL_STALL_WARN_MS) continue
    if (s._stallWarnedAt > 0 && now - s._stallWarnedAt < KERNEL_STALL_WARN_MS) continue
    s._stallWarnedAt = now
    const silentMin = Math.round((now - s._lastOutAt) / 60000)
    console.log(`[bridge] kernel stall warning: sid ${sid.slice(0, 8)} turn active but silent ${silentMin}m — possible AV/driver stall, consider cancel/restart`)
    try { send({ type: 'kernel-stall', data: { sessionId: sid, silentMs: now - s._lastOutAt }, sessionId: sid }) } catch {}
  }
}
if (KERNEL_STALL_WARN_MS > 0) setInterval(warnStalledKernels, 60000).unref?.()
sweepOrphanPromptFiles()
// 测试场景（doubao.test.mjs）通过 YFW_BRIDGE_NO_LISTEN 跳过顶层 listen，
// 由测试自行 httpServer.listen(0) 起随机端口；正式运行保持原有行为。
if (!process.env.YFW_BRIDGE_NO_LISTEN) {
  httpServer.listen(PORT, () => { console.log('[bridge] http+ws://localhost:' + PORT); autoInstallSamples() })
}
export { httpServer, sessions }
wss.on('connection', (ws, req) => {
  // WebSocket 同样校验 Origin：浏览器发起的 WS 带 Origin 头，外部网页不得连接
  const wsOrigin = req.headers.origin
  if (wsOrigin && !isAllowedOrigin(wsOrigin)) {
    console.warn('[bridge] WS connection rejected, origin:', wsOrigin)
    try { ws.close(1008, 'Forbidden origin') } catch {}
    return
  }
  wsClients.add(ws)
  browserRouter.addGuiClient(ws)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  console.log('[bridge] GUI connected')
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'executor:hello') {
        // 主进程执行器客户端（Electron 主进程 WS）首条消息注册。执行器不是
        // GUI 广播目标：从 wsClients 摘除（不接收 GUI 事件、不参与心跳）。
        wsClients.delete(ws)
        browserRouter.removeGuiClient(ws)
        browserRouter.registerExecutor(ws)
        console.log('[bridge] executor connected (browser automation)')
      } else if (msg.type === 'browser:exec:response') {
        // 执行器完成 → 回写内核 stdin（control_request/browser_response）
        browserRouter.onExecutorResponse(msg.requestId, msg)
      } else if (msg.type === 'browser:event') {
        // 执行器事件（状态/进度等）→ 广播给所有 GUI 客户端
        browserRouter.broadcast(msg.sessionId, msg.event)
      } else if (msg.type === 'send') {
        const sid = msg.sessionId || 'default'
        console.log('[bridge] send sid:', sid.slice(0, 8))
        const session = getOrCreateSession(sid, msg.cwd, msg.resumeId, msg.systemPrompt, msg.model, msg.compactCount)
        if (!session) return // spawn failed — error already sent via WebSocket
        session.proc.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: msg.prompt },
          ...(msg.priority ? { priority: msg.priority } : {}),
          ...(msg.uuid ? { uuid: msg.uuid } : {}),
        }) + '\n')
        session._turnActive = true
        send({ type: 'ack', data: { requestId: msg.requestId, sessionId: sid } })
      } else if (msg.type === 'cancel') {
        const sid = msg.sessionId || 'default'
        const s = sessions.get(sid)
        console.log('[bridge] cancel sid:', sid.slice(0, 8))
        if (s && s.proc && !s.proc.killed && !s._cancelPending) {
          // 优雅停止：向内核 stdin 注入 control_request(cancel)。内核按"全停"
          // 语义处理（bridgeMessaging case 'cancel' → onCancel）：
          // ① abort 主查询（reason='cancel'，ShellCommand 会真正 kill bash 而非
          //    转后台——修复 GUI 停止后 bash/subagent 杀不掉的断链）；
          // ② killAllRunningAgentTasks 逐个 abort 运行中的子 agent
          //    （异步 subagent 的独立 AbortController 不会被 interrupt 级联）。
          // 内核进程保持存活，会话保留在 sessions 中，下一条消息直接复用续聊。
          // 仅当超时后内核仍在持续输出（取消未生效）才回退 taskkill 强杀。
          s._cancelPending = true
          s._cancelAt = Date.now()
          try {
            s.proc.stdin.write(JSON.stringify({
              type: 'control_request',
              request_id: `cancel-${s._cancelAt}`,
              request: { subtype: 'cancel' },
            }) + '\n')
          } catch (e) {
            console.warn('[bridge] cancel interrupt write failed, hard kill:', e.message)
            s._cancelPending = false
            try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000 }) } catch { try { s.proc.kill() } catch {} }
            sessions.delete(sid)
          }
          s._cancelTimer = setTimeout(() => {
            if (sessions.get(sid) === s && s._cancelPending && s._lastOutAt > s._cancelAt) {
              console.warn('[bridge] cancel fallback: kernel still producing after interrupt, hard kill')
              try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000 }) } catch { try { s.proc.kill() } catch {} }
              sessions.delete(sid)
            }
            s._cancelPending = false
            s._cancelTimer = null
          }, 6000)
          s._cancelTimer.unref?.()
        }
        send({ type: 'cancelled', data: { sessionId: sid } })
      } else if (msg.type === 'pet:show-main') {
        // 桌面宠物双击 → 通知所有客户端（主进程监听后打开/聚焦主窗口）
        send({ type: 'pet:show-main', data: {} })
      }
      else if (msg.type === 'pet:quit-app') {
        // 桌面宠物右键「直接退出程序」→ 通知所有客户端（主进程监听后退出整个应用）
        send({ type: 'pet:quit-app', data: {} })
      }
      else if (msg.type === 'answer') {
        const sid = msg.sessionId || 'default'
        const session = sessions.get(sid)
        if (session && session.proc && !session.proc.killed) {
          const answers = (msg.data && msg.data.answers) || []
          const notes = (msg.data && msg.data.notes) || ''
          let response = `用户回答：\n`
          for (const a of answers) {
            response += `- 问题 "${a.question}": 选择了 "${a.selected}"`
            if (a.customText) response += ` (自定义: ${a.customText})`
            response += `\n`
          }
          if (notes) response += `\n补充说明: ${notes}`
          response += `\n\n请继续推进任务。`
          session.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: response } }) + '\n')
          session._turnActive = true
          console.log('[bridge] answer injected for session:', sid.slice(0, 8))
        }
        // 提问已被回答——广播撤销外部监听者（如桌面宠物嘉嘉）的提问提示
        if (session) session._pendingQuestions = null
        send({ type: 'question-resolved', sessionId: sid })
      }
      else if (msg.type === 'question-dismiss') {
        // 用户跳过/关闭了提问卡片：CLI 保持等待（由新消息解除阻塞），
        // 但向嘉嘉等监听者广播”提问已处理”，撤销待回答提示
        const sid = msg.sessionId || 'default'
        const session = sessions.get(sid)
        if (session) session._pendingQuestions = null
        send({ type: 'question-resolved', sessionId: sid })
      }
      else if (msg.type === 'approval-response') {
        // 用户对权限弹窗的批准/拒绝：按实证协议（spec §4.2）向内核 stdin 注入
        // control_response，解除 can_use_tool 挂起。request_id 回填自内核
        // control_request，toolUseID 回填 tool_use_id。
        const sid = msg.sessionId || 'default'
        const session = sessions.get(sid)
        const toolUseId = msg.toolUseId
        const approved = !!msg.approved
        if (session && session.proc && !session.proc.killed && toolUseId) {
          const pending = session._pendingApprovals?.get(toolUseId)
          if (pending && pending.requestId) {
            const response = {
              type: 'control_response',
              response: {
                request_id: pending.requestId,
                subtype: 'success',
                response: approved
                  ? { behavior: 'allow', updatedInput: {}, toolUseID: toolUseId, decisionClassification: 'user_temporary' }
                  : { behavior: 'deny', message: '用户拒绝了该高风险操作（User denied the high-risk operation）', toolUseID: toolUseId },
              },
            }
            session.proc.stdin.write(JSON.stringify(response) + '\n')
            session._pendingApprovals.delete(toolUseId)
            console.log(`[bridge] approval-response sid=${sid.slice(0, 8)} toolUseId=${toolUseId} approved=${approved}`)
          } else {
            console.warn(`[bridge] approval-response: no pending approval for toolUseId=${toolUseId}`)
          }
        }
        send({ type: 'approval-resolved', sessionId: sid, data: { toolUseId } })
      }
      else if (msg.type === 'browser_control') {
        // GUI 暂停/继续执行器 → 转发 executor（bridge 仅路由，不解释语义）
        browserRouter.onGuiControl(msg.sessionId, msg.command)
      }
    } catch (e) { console.error('[bridge] msg error:', e.message) }
  })
  ws.on('close', () => {
    wsClients.delete(ws)
    browserRouter.removeGuiClient(ws)
    browserRouter.unregisterExecutor(ws)
    console.log('[bridge] GUI disconnected')
  })
})

// ---------------------------------------------------------------------------
// First-run auto-install: bundle all built-in sample skills into ~/.yfworking
// so the app is usable immediately without any manual installation step.
// Idempotent: already-installed skills are skipped; a marker file is written
// only when EVERY sample skill installs cleanly (partial failure retries on
// next launch).
// ---------------------------------------------------------------------------
function autoInstallSamples() {
  try {
    const skillRoot = findSkillRoot()
    const marker = join(skillRoot, '.auto-installed.json')
    if (existsSync(marker)) return
    const candidates = [...SAMPLE_SKILL_ROOTS]
    const src = candidates.find(p => existsSync(p))
    if (!src) { console.log('[bridge] auto-install: sample-skills source not found'); return }
    const dirs = readdirSync(src, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(src, d.name, 'SKILL.md')))
    let okCount = 0
    let failCount = 0
    for (const d of dirs) {
      const target = join(skillRoot, d.name)
      if (existsSync(target)) { okCount += 1; continue }
      try {
        mkdirSync(target, { recursive: true })
        copyWithRewrite(join(src, d.name), target, '{{YFW_SKILLS}}', skillRoot.replace(/\\/g, '/'))
        const md = readFileSync(join(target, 'SKILL.md'), 'utf-8')
        const yamlMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        let ver = ''
        let desc = ''
        if (yamlMatch) {
          const grab = (k) => {
            const m = yamlMatch[1].match(new RegExp('^' + k + ':\\s*["\']?(.+?)["\']?\\s*$', 'm'))
            return m ? m[1].trim() : ''
          }
          ver = grab('version')
          desc = grab('description')
        }
        const idxPath = join(skillRoot, '_skill_index.json')
        let index = readSkillIndex(idxPath)
        const entry = {
          id: d.name, name: d.name, description: desc || d.name,
          version: ver || '0.0.0', triggers: [],
          lines: md.split('\n').length, size_kb: Math.round(md.length / 1024),
          installed_at: new Date().toISOString(), installed_from: 'builtin',
          source_path: join(src, d.name).replace(/\\/g, '/'),
          dependencies: [], enabled: true,
        }
        const existing = index.findIndex(s => s.id === d.name)
        if (existing >= 0) index[existing] = entry
        else index.push(entry)
        writeSkillIndex(idxPath, index)
        okCount += 1
        console.log('[bridge] auto-installed:', d.name)
      } catch (e) {
        failCount += 1
        console.log('[bridge] auto-install failed:', d.name, '-', e.message)
      }
    }
    const srcCommon = join(src, '_common')
    const destCommon = join(skillRoot, '_common')
    if (existsSync(srcCommon) && !existsSync(destCommon)) {
      try {
        mkdirSync(destCommon, { recursive: true })
        copyWithRewrite(srcCommon, destCommon, '{{YFW_SKILLS}}', skillRoot.replace(/\\/g, '/'))
        console.log('[bridge] auto-installed shared lib: _common')
      } catch (e) {
        failCount += 1
        console.log('[bridge] auto-install _common failed:', e.message)
      }
    }
    if (failCount === 0) {
      writeFileSync(marker, JSON.stringify({ installedAt: new Date().toISOString(), count: okCount }, null, 2), 'utf-8')
      console.log('[bridge] auto-install complete: ' + okCount + ' skills')
    } else {
      console.log('[bridge] auto-install incomplete: ' + okCount + ' ok, ' + failCount + ' failed - marker not written, retry next launch')
    }
  } catch (e) {
    console.log('[bridge] auto-install error:', e.message)
  }
}

// 内核强绑定：bridge 退出前必须终止所有内核 CLI 会话进程。
// Windows 下 s.proc.kill() 不可靠，统一用 taskkill 进程树强杀，
// 确保没有任何 CLI 内核/子进程残留。
function killAllSessions() {
  for (const [, s] of sessions) {
    if (s && s.proc && !s.proc.killed) {
      try {
        execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 3000, stdio: 'ignore' })
      } catch {
        try { s.proc.kill() } catch {}
      }
    }
  }
}
process.on('SIGINT', () => { killAllSessions(); process.exit(0) })
process.on('SIGTERM', () => { killAllSessions(); process.exit(0) })

// 兜底：任何未捕获异常/未处理的 Promise 拒绝都不应让整个后端进程退出——
// 记录日志后继续服务，由前端自动重连与主进程重启策略共同保证可用性。
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaughtException:', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] unhandledRejection:', reason)
})
