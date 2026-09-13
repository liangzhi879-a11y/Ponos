import { spawn, execSync } from 'child_process'
import { createInterface } from 'readline'
import { WebSocketServer } from 'ws'
import http, { createServer } from 'http'
import https from 'https'
import { fileURLToPath } from 'url'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, unlinkSync, appendFileSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, sep, dirname, resolve, basename } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'node:crypto'
import { extractMilestoneMarks, extractProseStages } from './milestones.mjs'
import { matchesHighRisk } from './highrisk.mjs'
import { approvalSpawnArgs, DEFAULT_APPROVAL_MODE, isValidApprovalMode, normalizeApprovalMode, resolveEffectiveApprovalMode } from './approval-mode.mjs'
import { parseAskUserPayload, extractAskUserBlocks } from './askuser.mjs'
import { buildAnchorApplied } from './health-anchor.mjs'
import { resolveKernelPaths } from '../electron/kernel-paths.cjs'
import { resolveYfwHome } from './yfw-home.cjs'
import { writeLogLine, readLogPolicyCached, enforceLogPolicy, normalizeLogPolicy, DEFAULT_LOG_POLICY } from './log-policy.cjs'
import { handleLogsRoute } from './logs-routes.mjs'
import { installBuiltinWorkflows } from './workflow-install.mjs'
// 技能安装/更新链（P2-2）：同为可测模块——bridge 顶层 listen，测试不能 import 本文件
import { copyWithRewrite, readSkillIndex, writeSkillIndex, installBuiltinSkills } from './skill-install.mjs'
// 工作流 HTTP 路由（独立模块——bridge 顶层 listen，测试不能 import 本文件）+ 常驻宿主会话
import { handleWorkflowRoute } from './workflow-routes.mjs'
import { mapKernelMessage } from './workflow-events.mjs'
import { createWorkflowHost, HOST_SID } from './workflow-host.mjs'
import { buildExperienceIndex, buildSedimentPrompt, ensurePersonalDir } from './experience.mjs'
export { ensurePersonalDir, buildExperienceIndex, buildSedimentPrompt } from './experience.mjs'
import { createTranscriptHandlers } from './transcript.mjs'
import { makeBrowserRouter } from './browser-routing.mjs'
import { kernelReadonlySync } from './kernel-readonly.mjs'
import { getAuthStatus, setupPassword, checkPassword, changePassword } from './auth.mjs'
import { MANAGED_KEYS, providerProfileEnv, buildIdentityPrompt, activeProviderModel, resolveProviderProfile } from './provider-profile.mjs'
import { probeProviderCapabilities, applyProbeResults, resolveWindowFromProbe, maybeAdoptWindowFromEvent } from './provider-probe.mjs'

const PORT = parseInt(process.env.YFW_BRIDGE_PORT || '51517', 10)
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

// YFWorking 身份提示词（2026-09-09 动态化）：模型名经 buildIdentityPrompt(model)
// 插值（见 server/provider-profile.mjs），不再硬编码 deepseek-v4-flash。

// ---------------------------------------------------------------------------
// YFWorking home directory — STRICTLY ISOLATED from Claude.
// All YFWorking state (skills, config, providers, sessions) lives here.
// We never read from ~/.claude/ even if it exists on the machine.
// 数据根经共享模块 yfw-home.cjs 解析：YFWORKING_HOME || CLAUDE_CONFIG_DIR ||
// ~/.yfworking（双版并行隔离开关；模块加载期解析，spawn 子进程经
// buildChildEnv 注入解析后的 home）。
// ---------------------------------------------------------------------------
const YFW_HOME = resolveYfwHome()
// 用户档案文件（2026-09-10 个人信息窗）：昵称/头像/简介
const PROFILE_PATH = join(YFW_HOME, 'userData', 'profile.json')
const YFW_SKILLS_DIR = join(YFW_HOME, 'skills')
const YFW_TOOLS_DIR = join(YFW_HOME, 'tools')
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

// 内置 CLI 工具模板候选（F1 对称方）：只覆盖「无安装器领地」的形态——
// dev（build/templates/tools）与 portable（<app>/runtime/tools）。installed 的
// resources/runtime/tools 由 installer.nsh 按用户勾选部署（.tools-pack.json
// marker），此处不纳入候选，避免绕过安装时的"否"选择静默播种。
const TOOLS_SAMPLE_ROOTS = [
  join(__dirname, '..', 'runtime', 'tools'),
  join(process.cwd(), 'runtime', 'tools'),
  join(__dirname, '..', 'build', 'templates', 'tools'),
  join(process.cwd(), 'build', 'templates', 'tools'),
]

// 技能安装/索引/指纹台账的实现已抽到 server/skill-install.mjs（2026-09-12 P2-2）：
// 与 workflow-install.mjs 同因——bridge.mjs 顶层会 listen(51517)（EADDRINUSE 自愈还会
// taskkill 用户进程），测试 import 它会真起桥，抽出去才能直接做单元回归。
// 导出：copyWithRewrite / readSkillIndex / writeSkillIndex / writeSkillIndexEntry /
//       installBuiltinSkills（含指纹台账 upsertSkill）。

// Python runtime：优先使用随应用捆绑的运行时（<app>/runtime/python/python.exe，
// 与 main.cjs 的 findPythonExe 同路径约定），保证打包版离线可用；开发环境回退 PATH。
// Python 解释器候选链：app 根 runtime → 上溯两级 → resources/runtime
// （electron-builder extraResources 落点 <app>/resources/runtime/python）。
// 2026-08-22：原实现只查 app 根 runtime，内核运行在 home bootstrap 缓存模式
// 下找不到安装目录 python，内核 OCR/Vision 静默不可用。
function findPythonExe() {
  const candidates = [
    join(__dirname, '..', 'runtime', 'python', 'python.exe'),
    join(__dirname, '..', '..', 'runtime', 'python', 'python.exe'),
    join(__dirname, '..', '..', 'resources', 'runtime', 'python', 'python.exe'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
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
  // 思考深度（Task 12）：'auto' = 内核默认（不注入 env）；非 auto 值经 buildChildEnv
  // 注入 CLAUDE_CODE_EFFORT_LEVEL。旧 config.json 缺此键 → loadConfig merge 默认 auto。
  effortLevel: 'auto',
  // 审批档位（2026-09-12 四档化）：全局持久化档位，manual|auto|loose|bypass 逐级放宽。
  // 默认 loose = 应用今天的真实行为（内核 spawn 一直硬编码 --dangerously-skip-permissions），
  // 存量 config.json 缺此键 → loadConfig 合并默认 loose → 升级零行为变化。
  // 会话级临时覆盖另存 sessionApprovalModes（仅内存），不写本文件。
  approvalMode: DEFAULT_APPROVAL_MODE,
  // 本地日志持久化策略（2026-09-12）：persist / level / maxFileBytes / maxFiles / maxAgeDays。
  // 缺此键 → loadConfig 合并默认档；写入一律经 sanitizeConfigPatch 钳制（手改 config.json
  // 填 {maxFileBytes:-1} 会拿回 5MB，而不是得到一个坏掉的轮转器）。
  logPolicy: { ...DEFAULT_LOG_POLICY },
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

// ---------------------------------------------------------------------------
// 审批档位（2026-09-12 四档化）：全局档位存 config.json；**会话级临时覆盖仅存内存**
// （状态栏徽标改的是"本会话"，会话进程退出即回落全局档——用户决策，不落盘）。
// 覆盖在 getOrCreateSession 时被读取一次（决定 spawn 参数），活跃期经 control_request
// 热切换；全局档位变化对"无覆盖"的活会话立即热生效（否则设置页会显得点了没反应）。
// ---------------------------------------------------------------------------
const sessionApprovalModes = new Map() // sid -> mode（仅内存，进程退出即消失）

function globalApprovalMode() {
  try { return normalizeApprovalMode(loadConfig().approvalMode) } catch { return DEFAULT_APPROVAL_MODE }
}

// 生效档位 = 会话覆盖 || 全局档位（_wfhost 工作流宿主不接受覆盖，恒用全局）
function effectiveApprovalMode(sid) {
  const override = sid && sid !== HOST_SID ? (sessionApprovalModes.get(sid) || null) : null
  return resolveEffectiveApprovalMode({ sessionOverride: override, configMode: globalApprovalMode() })
}

// 热切换：对活内核注入 approval_mode control_request（与 effort 同一控制通道）
function pushApprovalModeToKernel(sid, mode) {
  const s = sessions.get(sid)
  if (!s || !s.proc || s.proc.killed) return false
  try {
    s.proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: 'approval-mode-' + Date.now(),
      request: { subtype: 'approval_mode', payload: { value: mode } },
    }) + '\n')
    return true
  } catch (e) {
    console.warn('[bridge] approval-mode send failed:', e.message)
    return false
  }
}

function broadcastApprovalMode(sid, scope) {
  broadcastGui({
    type: 'approval-mode-changed',
    sessionId: sid,
    data: {
      mode: effectiveApprovalMode(sid),
      // override = **布尔**（是否存在会话级临时覆盖），供状态栏显示「临时」标记。
      // 不必再带覆盖值本身：覆盖存在时 mode 就是它（无覆盖时 mode === global）。
      override: sessionApprovalModes.has(sid),
      global: globalApprovalMode(),
      scope,
    },
  })
}

// 会话结束（内核进程退出/重建）：清掉仅内存的会话覆盖并广播回落，徽标可见地弹回全局档
function clearSessionApprovalMode(sid) {
  if (!sessionApprovalModes.has(sid)) return false
  sessionApprovalModes.delete(sid)
  broadcastApprovalMode(sid, 'cleared')
  return true
}

// 全局档位热生效：所有"无会话覆盖"的活会话（含工作流宿主）就地切档。
function applyGlobalApprovalMode(mode) {
  const m = normalizeApprovalMode(mode)
  for (const [sid, s] of sessions) {
    if (sessionApprovalModes.has(sid)) continue
    if (!s || !s.proc || s.proc.killed) continue
    if (pushApprovalModeToKernel(sid, m)) broadcastApprovalMode(sid, 'global')
  }
}

// ---------------------------------------------------------------------------
// 配置写入钳制：POST /config（GUI 设置页）与手改 config.json 的路径都要过这道闸——
// 非法值（如 approvalMode: 'yolo'）落盘后会让内核/桥的判定静默走别的分支。
// 只规范化"新增且易填错"的键，其余键原样透传（非破坏）。
// ---------------------------------------------------------------------------
function sanitizeConfigPatch(patch) {
  const out = { ...(patch || {}) }
  if ('approvalMode' in out && !isValidApprovalMode(out.approvalMode)) {
    console.warn(`[bridge] approvalMode 非法值 ${JSON.stringify(out.approvalMode)} → 钳制为 ${DEFAULT_APPROVAL_MODE}`)
    out.approvalMode = DEFAULT_APPROVAL_MODE
  }
  if ('logPolicy' in out) {
    const raw = out.logPolicy
    // 局部补丁语义：只发 { maxFiles: 5 } 时其余键应保持现值，而不是被默认档重置
    const merged = { ...(loadConfig().logPolicy || DEFAULT_LOG_POLICY), ...(raw && typeof raw === 'object' ? raw : {}) }
    out.logPolicy = normalizeLogPolicy(merged)
    if (JSON.stringify(raw) !== JSON.stringify(out.logPolicy)) {
      console.warn(`[bridge] logPolicy 已钳制：${JSON.stringify(raw)} → ${JSON.stringify(out.logPolicy)}`)
    }
  }
  return out
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
      // 本地画像上下文窗口钳制（同 buildChildEnv 规则，2026-09-09 容器适配）。
      // contextWindow=0/未设（2026-09-10：GUI 新建 provider 默认 0 = 自动探测）时
      // 不注入任何值——内核回落 内置模型表 → 画像默认（local 64K / cloud 200K），
      // 探测回填后下一 spawn 生效真实窗口。
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: resolveProviderProfile(provider) === 'local' && Number(provider.contextWindow) > 500_000
        ? ''
        : (Number(provider.contextWindow) > 0 ? String(provider.contextWindow) : ''),
      YFW_VISION_BASE_URL: visionProvider.apiBaseUrl || '',
      YFW_VISION_AUTH_TOKEN: visionProvider.authToken || '',
      YFW_VISION_MODEL: visionProvider.visionModel || '',
      YFW_AUTO_IMAGE_BRIDGE: cfg.autoImageBridge === false ? '0' : '1',
    }
    // provider 画像 env（2026-09-09 本地模型适配）：先剔除受管键旧值（防切回
    // 云端时本地残留 0.6/lean 经 settings.json"缺失键才兜底"泄漏），再并入画像值
    for (const k of MANAGED_KEYS) delete existing.env[k]
    Object.assign(existing.env, providerProfileEnv(provider))
    // 审批档位兜底：桥的 spawn 走 --approval-mode flag（优先级最高），此处落 settings.json
    // 是给"不带 flag 的 spawn 路径"（外部脚本 / 工作流宿主直连内核）用同一档位。
    // 仅当值合法才写——非法/缺失时保留原文件，让内核按 flag 派生（不会无谓改写用户 settings）。
    if (isValidApprovalMode(cfg.approvalMode)) existing.approvalMode = normalizeApprovalMode(cfg.approvalMode)
    safeWriteJsonWithBak(YFW_SETTINGS_PATH, JSON.stringify(existing, null, 2))
    console.log('[bridge] kernel settings synced ->', provider.id, '| model:', model)
  } catch (e) {
    console.warn('[bridge] syncKernelSettings failed:', e.message)
  }
}

function saveConfig(updates) {
  const current = loadConfig()
  const patch = sanitizeConfigPatch(updates)
  const next = { ...current, ...patch }
  safeWriteJsonWithBak(YFW_CONFIG_PATH, JSON.stringify(next, null, 2))
  // Keep the kernel's settings.json in sync so auth works without login.
  syncKernelSettings()
  // 全局档位热生效（无会话覆盖的活会话就地切档 + 广播）：否则设置页改档要等下一个
  // 会话才见效。会话临时覆盖优先，不会被全局切换抹掉。
  applyGlobalApprovalMode(next.approvalMode)
  return next
}

// ---------------------------------------------------------------------------
// Kernel self-bootstrap (D3)：把安装/源码内核同步到 <home>/runtime/ponos-kernel/，供
// install 候选缺失时兜底（findYFWorking ③）与诊断检查——缓存自身必须完整可运
// 行：源若是目录级多文件内核（repo/kernel/ 平铺源码，cli.mjs 相对 import 同目录
// 兄弟文件与 ../version.mjs），整目录内容同步，并把逃逸到上一级的依赖镜像到
// <home>/runtime/ 对应位置（缓存 cli.mjs 的 '../' = runtime/）；源若是自足单文
// 件 bundle（kernel-dist/cli.mjs），目录即单文件，同步效果等价单文件拷贝。变更
// 判定 = 逐文件尺寸差异 + 目标残留清理（旧 vendor/ 等源已无条目即删），无差异
// 不重写。运行时 = node（D1）——node 自身不随拷（由调用方 process.execPath /
// resolveNode() 定位）；新内核 Grep/Glob 原生 node 递归（kernel/tools.mjs），
// 无 ripgrep/vendor 依赖（F3）。
// ---------------------------------------------------------------------------
function syncDirToMirror(srcDir, destDir) {
  // 把 srcDir 内容镜像到 destDir：新增/尺寸变化重拷；源已不存在的残留条目删除。
  // 返回是否发生任何写入。
  let changed = false
  mkdirSync(destDir, { recursive: true })
  const srcNames = new Set()
  for (const name of readdirSync(srcDir)) {
    srcNames.add(name)
    const srcFile = join(srcDir, name)
    const destFile = join(destDir, name)
    const srcStat = statSync(srcFile)
    let destStat = null
    try { destStat = statSync(destFile) } catch { }
    if (srcStat.isDirectory()) {
      if (destStat && !destStat.isDirectory()) { rmSync(destFile, { recursive: true, force: true }); changed = true }
      if (syncDirToMirror(srcFile, destFile)) changed = true
    } else {
      if (!destStat || destStat.isDirectory() || destStat.size !== srcStat.size) {
        if (destStat && destStat.isDirectory()) rmSync(destFile, { recursive: true, force: true })
        copyFileSync(srcFile, destFile)
        changed = true
      }
    }
  }
  for (const name of readdirSync(destDir)) {
    if (!srcNames.has(name)) {
      rmSync(join(destDir, name), { recursive: true, force: true })
      changed = true
    }
  }
  return changed
}

function mirrorKernelParentDeps(srcDir, destBase) {
  // 多文件源码内核把 import 逃逸到 kernel/ 上一级（当前仅 ../version.mjs）。
  // 缓存 cli.mjs 位于 <home>/runtime/ponos-kernel/，其 '../' 解析到 <home>/runtime/，
  // 故把源上一级被引用文件镜像到 destBase 同相对位置，缓存才完整可运行。
  // 自足 bundle 无 '../' 依赖，此步为空操作。目前内核闭包仅一级 '../'；若将来
  // 出现更深层级逃逸需扩展镜像深度。
  let changed = false
  const relDeps = new Set()
  for (const name of readdirSync(srcDir)) {
    if (!/\.(mjs|cjs|js)$/.test(name)) continue
    let text
    try { text = readFileSync(join(srcDir, name), 'utf8') } catch { continue }
    const re = /(?:from\s+|import\s*\()\s*['"](\.\.\/[^'"]+)['"]/g
    let m
    while ((m = re.exec(text))) relDeps.add(m[1])
  }
  for (const rel of relDeps) {
    const srcFile = resolve(srcDir, rel)
    if (!existsSync(srcFile)) continue
    const destFile = join(destBase, rel.replace(/^\.\.\//, ''))
    let same = false
    try { same = statSync(destFile).size === statSync(srcFile).size } catch { }
    if (!same) {
      mkdirSync(dirname(destFile), { recursive: true })
      copyFileSync(srcFile, destFile)
      changed = true
    }
  }
  return changed
}

function bootstrapKernelToUserDir(kernel) {
  // 拷贝目标随 YFWORKING_HOME（T2 home 解析）；源/目标清单无差异时不重写。
  try {
    const destBase = join(YFW_HOME, 'runtime')
    const destKernelDir = join(destBase, 'ponos-kernel')
    const destCli = join(destKernelDir, 'cli.mjs')
    const dirChanged = syncDirToMirror(dirname(kernel), destKernelDir)
    const parentChanged = mirrorKernelParentDeps(dirname(kernel), destBase)
    if (!dirChanged && !parentChanged) return { kernel: destCli, bootstrapped: false, cached: true }
    console.log('[bridge] kernel bootstrapped to', destCli)
    return { kernel: destCli, bootstrapped: true }
  } catch (e) {
    console.warn('[bridge] kernel bootstrap failed, falling back to original paths:', e.message)
    return { kernel, bootstrapped: false }
  }
}

function findYFWorking() {
  // NOTE: 必须 spawn 本库 ponos 内核（kernel/ 源码或 kernel-dist bundle，node
  // 直跑）——NOT npm-global yfworking.cmd（那是 GUI launcher：会起 bridge+vite+
  // browser、杀掉内核会话），也 NOT PATH 上的 stock Claude Code（会绕过一切 YFW
  // 隔离修复）。运行时 = node（D1）：`"<node>" "<kernel>"`（spawn shell:true，
  // 命令 + args 直接拼接）。node 定位 = process.execPath——bridge 恒由 node 拉起
  //（dev：node server/bridge.mjs；packaged：main.cjs startBridge resolveNode()）。
  const node = process.execPath
  // 1) 显式内核覆盖（D8 唯一逃生口）：YFWORKING_KERNEL = kernel cli.mjs 路径，
  //    运行时固定 node。值无效即抛错，绝不静默回退。
  if (process.env.YFWORKING_KERNEL) {
    const kernel = process.env.YFWORKING_KERNEL
    if (!existsSync(kernel)) {
      throw new Error(`[bridge] kernel not found: YFWORKING_KERNEL=${kernel} — file does not exist`)
    }
    return `"${node}" "${kernel}"`
  }
  // 2) kernel-paths 统一解析（与诊断探针共享 electron/kernel-paths.cjs，单一事实
  //    来源）：install 命中 <app>/kernel/cli.mjs（源码）或 kernel-dist/cli.mjs
  //    （bundle）→ 直接组装。home bootstrap 缓存（<home>/runtime/ponos-kernel，路径随
  //    YFWORKING_HOME）随启动同步（D3），install 缺失时作兜底（3）。
  const rp = resolveKernelPaths({ appDir: join(__dirname, '..') })
  if (rp.install.kernel) {
    // 缓存同步失败不阻断：install 候选仍可直接 spawn（node 读 cli.mjs 无 EPERM）
    try { bootstrapKernelToUserDir(rp.install.kernel); bootState.kernelBootstrapped = true } catch { }
    return `"${node}" "${rp.install.kernel}"`
  }
  // 3) 罕见兜底：安装/源码路径消失但 home 缓存仍在（升级/卸载残留）→ 直接用缓存
  if (rp.kernel) return `"${node}" "${rp.kernel}"`
  // 4) Last resort（PATH 上的 claude 命令兜底）已删：全部落空 → 抛清晰错误，
  //    严禁静默回退 claude
  throw new Error('[bridge] kernel not found — set YFWORKING_KERNEL, or ensure <repo>/kernel/cli.mjs or <repo>/kernel-dist/cli.mjs exists (node scripts/build-kernel.mjs)')
}
const YFWORKING = findYFWorking()
console.log('[bridge] YFWorking CLI:', YFWORKING)
// Ensure kernel settings.json exists with credentials on boot.
try { syncKernelSettings() } catch (e) { console.warn('[bridge] initial kernel settings sync failed:', e.message) }
console.log('[bridge] YFWorking home:', YFW_HOME)

const sessions = new Map()
const wsClients = new Set()

// GUI 广播（2026-09-11 供应商实时更新）：探测回填后广播 provider_updated，
// 设置窗口实时刷新；无 GUI 连接时静默。
function broadcastGui(msg) {
  const s = JSON.stringify(msg)
  for (const c of wsClients) { try { c.send(s) } catch { /* 单个连接失败不影响其余 */ } }
}

// ---------------------------------------------------------------------------
// 工作流模块（/workflows，UI Task 12）：宿主会话懒单例 + 存储根。
// 宿主 = 普通内核会话（sid = _wfhost，mode=task），承载 load/save/validate/run/stop/confirm；
// 内核回执按 requestId 配对（见 workflow-host.mjs），workflow 事件经 onEvent → GUI 广播。
// 懒创建：不打开工作流面板就零开销（不 spawn 宿主内核）。
// ---------------------------------------------------------------------------
const WF_ROOT = join(YFW_HOME, 'workflows')          // 用户工作流根（与 workflow-install 目标一致）
const WF_RUNS = join(YFW_HOME, 'workflow-runs')      // 运行审计 jsonl 根
let _wfHost = null
function workflowHost() {
  if (!_wfHost) {
    _wfHost = createWorkflowHost({
      sessions,
      getOrCreateSession,
      yfwHome: YFW_HOME,
      model: activeProviderModel(loadConfig()),
      onEvent: (ev) => broadcastGui({ type: 'workflow_event', sessionId: HOST_SID, event: ev }),
    })
  }
  return _wfHost
}

// 启动预热状态（2026-09-11 真实 boot 进度）：各模块真实完成后置位——main 轮询
// /boot-status 转发给 BootScreen 渲染真实步骤，全部就绪才交棒进入主界面。
const bootState = {
  kernelBootstrapped: false,  // 内核自举缓存同步完成（findYFWorking 路径）
  samplesInstalled: false,    // 内置示例技能安装完成
  workflowsInstalled: false,  // 内置工作流（spec-dev）安装完成
  probeDone: false,           // 活跃供应商实测探测完成（含欠费检测）
}

// 登录 token 占位表：token -> expiry（24h）。重启即清空 → 每次启动都要口令；
// /api/auth/status 不做 token 免密判定，token 仅作为未来服务端会话换用的占位。
const authTokens = new Map() // token -> expiry（重启清空）
function issueToken() { const t = randomBytes(24).toString('hex'); authTokens.set(t, Date.now() + 86_400_000); return t }

// 桥进程实例 id（2026-09-12 桥树杀事故的无感愈合）：随进程启动生成、进程存续期
// 恒定——GUI 用它区分"重连到同一桥"（瞬时闪断，无需动作）与"换了个新桥"
// （旧会话已随旧桥消亡，需静默自动续接）。
const BRIDGE_INSTANCE_ID = randomBytes(12).toString('hex')

// 诊断埋点：供主进程 diag-monitor 查询（只读内存统计，跨会话累计，仅统计最近 7 天）
const diagInfo = { firstTokenOk: 0, firstTokenTotal: 0, kernelCrashCount: 0, lastApiSuccessAt: null }

// 内核 stderr 落盘：崩溃时 bridge 只把 stderr 转发 GUI，不写任何本地日志 → 跨机器
// 故障（如 10s 后 exit 1）完全看不到错误原文，只能盲猜。现在：
// ① console.error 进 bridge 所在进程日志（app.log / 诊断报告 log tail 可见）；
// ② 追加到 <home>/logs/kernel-stderr.log（**路径不变**：diag-monitor 的 kernel-stderr
//    检查项仍读同一文件，最新内容仍在主文件）。
// 2026-09-12 起统一走 log-policy（原 512KB/256KB 私有截断删除）：轮转份数/保留天数/
// 关闭开关由用户在设置页控制，与其他三类日志同口径。
const KERNEL_STDERR_LOG = join(YFW_HOME, 'logs', 'kernel-stderr.log')
// 启动一次性把策略落到该文件（裁剪存量超大文件 + 年龄清理 + 超限轮转）。主进程负责
// app.log / renderer-console.log（initLogTee 里同样调用），两边各管自己写的文件，
// 互不重复删除对方的历史。失败不阻断启动。
try { enforceLogPolicy(KERNEL_STDERR_LOG, readLogPolicyCached({ home: YFW_HOME })) } catch { /* ignore */ }
function logKernelStderr(sid, line) {
  try {
    const entry = `[${new Date().toISOString()}] [sid ${String(sid || '?').slice(0, 8)}] ${line}`
    // 按 error 级写：内核 stderr 是崩溃原文，任何等级门槛下都**不得**被丢弃
    // （等级只用来过滤 app.log 的常规啰嗦行；诊断证据永远保留）
    writeLogLine(KERNEL_STDERR_LOG, entry, readLogPolicyCached({ home: YFW_HOME }), 'error')
  } catch { /* 日志失败绝不影响会话 */ }
}

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
// 内核 provider 环境签名（2026-09-10 模型热切换修复）：spawn 时冻结内核收到的
// provider 环境（baseUrl/model/auth），后续 send 携带的新配置与冻结签名不一致 →
// 收割旧内核、以 --resume + 新配置重启（同一聊天内切换模型真正生效，历史经
// --resume 无缝保留）。此前 getOrCreateSession 无条件复用活内核，前端发的
// model 字段永远到不了内核——切换模型必须换对话才生效的根因。
export function providerEnvSig(env = process.env) {
  return JSON.stringify({
    baseUrl: env.ANTHROPIC_BASE_URL || '',
    model: env.ANTHROPIC_MODEL || '',
    auth: env.ANTHROPIC_AUTH_TOKEN || '',
  })
}

function buildChildEnv() {
  const cfg = loadConfig()
  const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider) || cfg.providers?.[0]
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: YFW_HOME,
    YFWORKING_HOME: YFW_HOME,
  }
  // 内核 OCR/Vision 工具经 YFWORKING_PYTHON 使用 bundled python：
  // 安装器只把 skills/agents/memory/tools 同步到用户目录，python（数百 MB）
  // 留在安装目录；bootstrap 缓存内核相对路径向上找不到它（2026-08-22 修复）。
  // 显式注入绝对路径后，缓存/安装两种内核布局下 OCR/Vision 均可用。
  const pythonExe = findPythonExe()
  if (pythonExe !== 'python') env.YFWORKING_PYTHON = pythonExe
  // 开启内核原生定时任务（Kairos Cron：CronCreate/CronDelete/CronList 工具）
  // 与 /loop 循环执行 skill。release 内核 bundle 已编译全部代码，仅需此开关。
  // 用户环境变量可显式覆盖（如设为 false 关闭）。
  env.CLAUDE_CODE_AGENT_TRIGGERS =
    process.env.CLAUDE_CODE_AGENT_TRIGGERS === 'false' ? 'false' : 'true'
  // 思考深度（Task 12）：新会话 spawn 兜底 env 注入。'auto'（默认）不注入——
  // 内核自身默认即 auto，语义等价且干净；运行中会话的即时切换走 WS reasoning_effort
  //（本文件 effort case），这里只负责每个新 spawn 的初始档位。
  const effort = cfg.effortLevel || 'auto'
  if (effort !== 'auto') env.CLAUDE_CODE_EFFORT_LEVEL = effort
  // 内核日志等级（2026-09-12 日志策略）：仅在非 info 时注入 CLAUDE_CODE_LOG_LEVEL
  //（info = 内核默认，语义等价且干净）。刻意**不**进入 providerEnvSig：改等级只影响
  // 新 spawn 的日志啰嗦度，不该像换模型那样触发收割重建内核。debug 会把内核 stderr
  // 逐行推给 GUI（很吵），设置页文案已提醒。
  const logLevel = normalizeLogPolicy(cfg.logPolicy).level
  if (logLevel !== 'info') env.CLAUDE_CODE_LOG_LEVEL = logLevel
  // Inject the active provider's API config as ANTHROPIC_* env vars so the
  // Claude Code kernel actually calls the user-configured endpoint/model
  // with the user's token. Without these the CLI falls back to its built-in
  // anthropic.com defaults and the saved config is ignored at runtime.
  if (provider && provider.apiBaseUrl && provider.authToken) {
    env.ANTHROPIC_BASE_URL = provider.apiBaseUrl
    env.ANTHROPIC_AUTH_TOKEN = provider.authToken
    // 模型改名适配（2026-09-11）：spawn 时对配置模型名做清单校验——提供方升级
    // 改名后（如 deepseek-chat → deepseek-v4-flash），已配置的旧模型名不在探测
    // 清单内 → 自动落到当前服务端首项，会话不再因旧名 404。清单来自探测回填的
    // provider.models（启动自动探测/定时复探保持新鲜）。
    const servedModels = (Array.isArray(provider.models) ? provider.models : []).map(String).filter(Boolean)
    let model = provider.primaryModel || servedModels[0] || ''
    if (model && servedModels.length && !servedModels.includes(model)) {
      console.warn(`[bridge] provider ${provider.id} primaryModel ${model} 不在服务端清单（已下线/改名）→ 自动适配 ${servedModels[0]}`)
      model = servedModels[0]
    }
    let sub = provider.subagentModel || model
    if (sub && servedModels.length && !servedModels.includes(sub)) {
      sub = servedModels[0]
    }
    if (model) {
      env.ANTHROPIC_MODEL = model
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = sub || model
    }
    // provider 思考模式（2026-09-10）：thinkingEnabled → 内核请求注入
    // thinking:enabled+budget（MiniMax 等不认 reasoning_effort 的云端经此才有
    // thinking_delta 流，否则思考在流内完全不可见）
    if (provider.thinkingEnabled) {
      env.CLAUDE_CODE_THINKING_ENABLED = '1'
      env.CLAUDE_CODE_THINKING_BUDGET = String(provider.thinkingBudget || 4096)
    }
    if (provider.contextWindow) {
      // 本地画像上下文窗口钳制（2026-09-09 容器适配）：GUI 添加 provider 的默认
      // contextWindow=1000000 对本地 vLLM 模型几乎必然虚高（真实窗口=服务端
      // max_model_len，如 Qwen3.8-27B 的 180k）——内核按虚高窗口规划永不主动压缩，
      // 上下文滚到真实窗口附近后请求挂起/撞线。>500k 的虚高值不注入，内核回退
      // 模型表/默认 200k 窗口规划（正确触发压缩）；显式设 ≤500k 的真实值仍生效。
      const isLocal = resolveProviderProfile(provider) === 'local'
      if (isLocal && Number(provider.contextWindow) > 500_000) {
        console.warn(`[bridge] provider ${provider.id} contextWindow ${provider.contextWindow} looks inflated for a local model — not injecting (kernel falls back to model table default)`)
      } else {
        env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(provider.contextWindow)
      }
    }
    // provider 画像 env（2026-09-09 本地模型适配）：温度/提示词分级/输出预算等按
    // 画像注入（云端产出空映射=现状，内核默认 64000 预算与 0 温度不变；本地吃默认
    // 表或显式字段）。用户进程 env 已有同键时不覆盖（providerProfileEnv 语义）。
    for (const [k, v] of Object.entries(providerProfileEnv(provider, { env }))) {
      env[k] ??= v
    }
    console.log('[bridge] active provider:', provider.id, '| model:', model, '| baseUrl:', provider.apiBaseUrl)
  } else if (provider) {
    console.warn('[bridge] provider', provider.id, 'missing apiBaseUrl or authToken — using CLI defaults')
  }
  // 内核 Grep/Glob 为原生 node 递归实现（本库 ponos 内核，kernel/tools.mjs），
  // 无 ripgrep/vendor 依赖（F3）→ CLAUDE_CODE_USE_NATIVE_FILE_SEARCH 注入不再
  // 必要（旧 claude-code 内核 vendor rg 语义不适用；内核忽略未知 env）。
  // 工具结果字节预算（2026-09-12 起改由 provider.toolResultBudgetBytes 经
  // providerProfileEnv 注入 CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES；旧布尔开关
  // CLAUDE_CODE_TOOL_RESULT_BUDGET=true 对内核是 no-op——compact.mjs 将布尔形态
  // 视为未显式（Number('true')=NaN），已移除，勿回退）。
  return env
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

// 宿主技能清单拼装（appendSkillList/formatSkillEntry/listInstalledSkills/skillDirFingerprint
// 及缓存全局）已随 S5 ②-03 / D1 停用删除：技能清单唯一来源 = 内核 composeSystemPrompt
// 【可用技能】块（技能根经 getOrCreateSession 下方 --add-dir 注入发现）。原注入段格式
// 回归由 server/prompt-skills.test.mjs 与 scripts/verify-skill-listing.mjs 承担；
// parseTriggers/parseParent/parseSubskillsOrDeps 仍被下方 /skills HTTP 路由消费故保留。

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

// chat 模式禁用的本地工具集（Task 11 Conversation.mode）：纯聊会话只保留
// WebFetch/WebSearch 等联网只读工具，禁一切本地执行/读写/Agent/技能/浏览器。
// GUI 经 buildSendPayload 透传 conversation.mode，WS 'send' 分支收敛 'chat'|'task'。
// 2026-09-12 会话模式隔离：权威表已迁到内核（kernel/tools.mjs CHAT_MODE_DISALLOWED），
// 内核按 --session-mode chat 自行套用。本拷贝只为"跑的是旧缓存内核（不认新 flag）"
// 的兼容兜底；两份一致性由 kernel-tests/chat-mode.test.mjs 的源码比对守住。
export const CHAT_DISALLOWED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'TodoWrite', 'OCR', 'Vision', 'Skill', 'SkillSearch', 'Workflow', 'Browser', 'MemorySearch']

// 浏览器白名单写入（2026-09-10）：内核 Browser 工具白名单审批通过后，把域名
// 追加进 {YFW_HOME}/browser-whitelist.json 的 allow 数组。执行器（browser-common.cjs
// whitelistConfigPath）按 mtime 热重载，写入即时生效无需重启。导出供测试。
export function addBrowserWhitelist(host) {
  const h = String(host || '').trim().toLowerCase()
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return false
  const p = join(YFW_HOME, 'browser-whitelist.json')
  let cfg = { allow: [] }
  try { cfg = JSON.parse(readFileSync(p, 'utf-8')) } catch { /* 文件不存在/损坏 → 重建 */ }
  const allow = Array.isArray(cfg.allow) ? cfg.allow.map(String) : []
  if (allow.some((x) => x.toLowerCase() === h)) return true // 已存在，幂等
  allow.push(h)
  try {
    mkdirSync(YFW_HOME, { recursive: true })
    writeFileSync(p, JSON.stringify({ allow }, null, 2), 'utf-8')
    console.log(`[bridge] browser whitelist added: ${h}`)
    return true
  } catch (e) {
    console.warn('[bridge] browser whitelist write failed:', e?.message || e)
    return false
  }
}

function getOrCreateSession(sid, cwd, resumeId, systemPrompt, model, compactCount, mode = 'task') {
  if (sessions.has(sid)) {
    const s = sessions.get(sid)
    if (s.proc && !s.proc.killed) {
      // 模型/端点热切换（2026-09-10）：当前 provider 环境签名与 spawn 冻结签名
      // 不一致 → 收割旧内核、新 spawn 以 --resume 新配置续跑。用户切模型后发
      // 消息即为"用新模型继续"的明确意图；旧内核在跑轮次也一并终止（transcript
      // 已落盘，--resume 无缝续）。先清运行 marker 防误报"previous run crashed"，
      // _reaped 抑制 closed 广播（前端状态无缝过渡）。
      if (s._spawnEnvSig && s._spawnEnvSig !== providerEnvSig(buildChildEnv())) {
        console.log(`[bridge] provider/model changed — reaping kernel sid ${sid.slice(0, 8)} to respawn with new env`)
        if (resumeId) { try { rmSync(join(YFW_HOME, 'runs', resumeId + '.running'), { force: true }) } catch {} }
        s._reaped = true
        try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000, stdio: 'ignore' }) } catch { try { s.proc.kill() } catch {} }
        sessions.delete(sid)
      } else {
        return s
      }
    } else {
      sessions.delete(sid)
    }
  }
  // 系统提示词临时文件：会话进程退出后删除，避免在 %TEMP% 长期堆积
  let promptFile = null
  const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
  // 审批档位（2026-09-12 四档化）：原先是硬编码的 --dangerously-skip-permissions
  //（等价默认档 loose）。现按"会话覆盖 || 全局档位"决定：显式 --approval-mode 在 cli
  // 三级优先级里最高（flag > settings.json > 旧 flag 派生），loose/bypass 仍附带旧 skip
  // flag，好让不认识新 flag 的旧缓存内核优雅停在 loose 而非掉进"ask 退化 deny"。
  // 注意：--permission-prompt-tool stdio 必须保留，否则非交互 print 模式下 ask 直接
  // 变 deny（弹窗根本没有机会出现）。
  args.push(...approvalSpawnArgs(effectiveApprovalMode(sid)))
  // 权限审批走内核 can_use_tool control_request/control_response 协议：
  // 没有 --permission-prompt-tool stdio 时，非交互 print 模式下 ask 决策会直接
  // 退化为自动 deny（实证发现，spec §4.2），高风险命令将无法被用户批准。
  args.push('--permission-prompt-tool', 'stdio')
  // GUI 不渲染 AskUserQuestion 工具交互 —— 强制模型使用 <!--ASK_USER--> 注释输出提问卡片
  args.push('--disallowedTools', 'AskUserQuestion')
  // chat 模式（纯聊受限会话）：追加禁本地工具清单——与 AskUserQuestion 分别 push，
  // 由内核注册表过滤使 Bash/Read/Write 等不可调用（保留 WebFetch/WebSearch）。
  // chat 模式（2026-09-12 隔离）：--session-mode chat 是权威开关——内核据此不发现
  // 技能/工作流、不注入子 Agent/记忆/项目指令，系统提示换成联网助理专用版，并自行
  // 套用禁工具表。下面那条 --disallowedTools 是兼容兜底（旧缓存内核不认新 flag），
  // 二者并存无副作用：禁工具取并集。
  if (mode === 'chat') {
    args.push('--session-mode', 'chat')
    args.push('--disallowedTools', CHAT_DISALLOWED.join(','))
  }
  if (resumeId) {
    // Resume: restore the original session. 不重复注入身份提示词（避免冲突），
    // 但必须追加互动格式规范，否则模型看不到 ASK_USER 唯一提问方式，会回退调用
    // 已被禁用的 AskUserQuestion 工具。
    args.push('--resume', resumeId)
    // P8 双路去重（S5 ②-03 / D1）：技能清单不再经宿主注入——唯一来源 = 内核
    // 【可用技能】块（经下方 --add-dir 技能根发现）；此处仅追加互动格式 + 里程碑
    // 协议（+经验注入段），new/resume 两条路径同构。
    let resumePrompt = YFW_ASKUSER_FORMAT + YFW_MILESTONE_PROTOCOL
    // chat 模式（2026-09-12 隔离）：里程碑协议是任务进度语义（GUI 按它画进度条），
    // 纯聊问答没有里程碑可言 ⇒ 只保留提问卡片格式（chat 里卡片仍要能用）。
    if (mode === 'chat') resumePrompt = YFW_ASKUSER_FORMAT
    const injectCfg = experienceInjectConfig()
    // 沉积引导同样注入 resume 会话（任务模式）：原实现只进新会话，而应用默认
    // "恢复最新会话"、日常调试几乎全在 resume 会话里 → 内核收不到沉积指令，
    // 个人经验库在迁移后零新增（2026-08-15 后实测无写入）。resume 一并携带后
    // 恢复的会话也能正常沉淀经验。chat 模式除外（2026-09-09 截断事故修复）：
    // Write/Edit 在 chat 被禁，沉积指令与工具集冲突令弱模型（实测 Qwen3.8-27B）
    // 思考后提前 end_turn（注入时 225 tokens 截断 / 移除后 3923 chars 完整）。
    if (injectCfg.enabled && mode === 'task') {
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
    // P8 双路去重（S5 ②-03 / D1）：同 resume 分支，技能清单不再经宿主拼装，由内核
    // 技能块经 --add-dir 技能根统一提供；此处仅身份/互动/里程碑 + 经验注入。
    let effectivePrompt = systemPrompt
      ? `${systemPrompt}\n\n${YFW_ASKUSER_FORMAT}\n\n${YFW_MILESTONE_PROTOCOL}`
      // 身份提示词动态插值当前模型名（2026-09-09）：model 参数来自 GUI WS send
      //（activeProv.primaryModel）；缺失时回退 config 活跃 provider
      : buildIdentityPrompt(model || activeProviderModel(loadConfig()), {
          askuserFormat: YFW_ASKUSER_FORMAT,
          milestoneProtocol: YFW_MILESTONE_PROTOCOL,
        })
    // chat 模式（2026-09-12 隔离）：身份提示词与里程碑协议都不注入——身份由内核
    // chat 专用提示词提供（buildIdentityPrompt 的能力清单是"编程/系统诊断/企业咨询"，
    // chat 全做不到，留着即能力虚报）；里程碑协议是任务进度语义（GUI 按它画进度条），
    // 纯聊问答不适用。提问卡片格式保留（chat 里提问卡片仍要能用）。
    if (mode === 'chat') {
      effectivePrompt = systemPrompt ? `${systemPrompt}\n\n${YFW_ASKUSER_FORMAT}` : YFW_ASKUSER_FORMAT
    }
    const injectCfg = experienceInjectConfig()
    // 经验沉积段仅任务模式注入（2026-09-09 截断事故修复）：沉积指令要求模型
    // 用 Write/Edit 写经验文件，chat 模式这些工具全部被禁（CHAT_DISALLOWED）——
    // 指令与工具集冲突令弱模型（实测 Qwen3.8-27B）思考后提前 end_turn 截断。
    // 纯聊会话本就不应沉淀经验，chat 跳过语义无损。
    if (injectCfg.enabled && mode === 'task') {
      effectivePrompt += buildSedimentPrompt()      // 沉积引导仅新会话注入
      effectivePrompt += buildExperienceIndex(injectCfg.maxBytes)
    }
    // 写入临时文件传入（--append-system-prompt-file）：提示词/经验文本可能很长，
    // 命令行直接传会超 cmd.exe 8191 字符限制导致 spawn 失败；文件方式还保留换行，格式示例更清晰。
    const newSessionPromptFile = join(tmpdir(), 'yfw-prompt-' + sid.replace(/[^\w-]/g, '_') + '.txt')
    promptFile = newSessionPromptFile
    try { writeFileSync(promptFile, effectivePrompt, 'utf-8') } catch {}
    args.push('--append-system-prompt-file', q(promptFile))
  }
  if (model) args.push('--model', q(model))
  // chat 模式不把业务 cwd 注入内核（纯聊会话工作根 = YFW_HOME，见下方 spawn cwd）
  if (cwd && mode !== 'chat') args.push('--add-dir', q(cwd))
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
      // chat 模式：内核工作根 = YFW_HOME（不落到业务目录，transcript 自成一格）
      cwd: mode === 'chat' ? YFW_HOME : (cwd || process.cwd()),
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
    clearFirstBytePending(session) // 内核有任何输出即解除"等待首字节"提示
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
    // 审批收口（2026-09-12）：内核把工具执行结果回吐为 user/tool_result 帧——这是
    // "该审批已不再挂起"的**协议层真信号**。此前全代码只有 approval-response 里一处
    // delete（且只删本次回执的那个 id）：用户点了审批但内核已超时、工具从未执行、
    // 或审批帧发给 0 个客户端（WS 空窗）等情形全部残留，残留项又让回收器无条件豁免
    // 该会话 ⇒ 内核泄漏（pid 6736 静默 53min / pid 21196 静默 13min 即此形态）。
    // 【2026-09-12 修正】旧判据要求 `{type:'user',message:{content:[{type:'tool_result'}]}}`
    // ——内核**从不产出**这个形状（真实帧见 kernel/protocol.mjs 的 wire.toolResult：
    // 顶层 `{type:'tool_result', tool_use_id, content, is_error}`），故这段此前是**死代码**：
    // 用户点了审批但内核已超时、工具从未执行等情形全部残留，残留项又让回收器无条件豁免
    // 该会话（内核泄漏 pid 6736/21196 的同源机制）。
    if (parsed && parsed.type === 'tool_result' && parsed.tool_use_id && session._pendingApprovals?.size) {
      if (session._pendingApprovals.delete(parsed.tool_use_id)) {
        clearSessionAwaiting(session)
        // 内核已回吐该工具结果 = 这条审批在内核侧已经结束（放行后执行完 / 超时放弃）。
        // 必须显式通知 GUI 收起弹窗：否则用户面对一个"点了没反应"的过期弹窗
        // ——内核早已放弃等待，回执只会静默 no-op（resolveApproval 查不到 waiter）。
        send({ type: 'approval-expired', sessionId: sid, data: { toolUseId: parsed.tool_use_id, reason: 'tool-result' } })
        console.log(`[bridge] approval closed by tool_result sid=${sid.slice(0, 8)} toolUseId=${parsed.tool_use_id}`)
      }
    }
    // 轮次收尾即清空等待态：result 到达说明内核不再挂起任何提问/审批（挂起时它不会
    // 发 result）。不清则 _awaitingSince 把上一个等待期的豁免无限延续到轮后。
    if (parsed && parsed.type === 'result') {
      if (session._pendingQuestions) session._pendingQuestions = null
      if (session._pendingApprovals?.size) session._pendingApprovals.clear()
      session._awaitingSince = 0
      session._askBuf = '' // 轮次结束：提问标记的跨帧累积缓冲随之清空（防止跨轮拼接出假标记）
    }
    // 轮内每一步都可能静默（服务端缓冲的思考/prefill 阶段）——任何输出帧到达即
    // 重新武装首字节等待提示，让等待条覆盖发消息后第一步之外的后续步骤；
    // result 收尾（_turnActive=false）不重武装（2026-09-09 反馈覆盖缺口修复）。
    if (session._turnActive) armFirstBytePending(session, sid)
    // 内核启动回显比对（2026-09-12 档位化）：system/init 会带上真正生效的 approval_mode。
    // 与桥期望的档位不一致 = 跑的是不认识 --approval-mode 的旧缓存内核（旧内核忽略未知
    // flag，靠 --dangerously-skip-permissions 停在 loose）。此时如实广播降级告警，别让
    // 用户以为自己选的 manual 生效了。回显缺失（更老的内核）不告警——无从判断。
    if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
      const echoed = parsed.approval_mode
      const expected = effectiveApprovalMode(sid)
      if (echoed && normalizeApprovalMode(echoed) !== expected) {
        console.warn(`[bridge] kernel approval_mode mismatch: expected ${expected}, kernel reports ${echoed} (old cached kernel? run scripts/build-kernel.mjs)`)
        send({
          type: 'approval-mode-degraded', sessionId: sid,
          // message 是给用户看的**技术细节**（悬停展开），标题由 GUI 按 level 本地化
          data: {
            expected, actual: normalizeApprovalMode(echoed),
            message: `内核回显 approval_mode=${echoed}，期望 ${expected}。可能运行的是旧缓存内核（打包前请跑 scripts/build-kernel.mjs）。`,
          },
        })
      }
    }
    // 内核 400 窗口学习回流（2026-09-09）：真实窗口 < 配置值 → 只下调持久回填
    // config（此前学习仅进程内存、重启即丢）。云端同样受益——真实窗口只可能更小。
    if (parsed && parsed.type === 'system' && parsed.subtype === 'context_window_adopted') {
      const learned = Number(parsed.window)
      if (Number.isFinite(learned) && learned > 0) {
        const cfg = loadConfig()
        const prov = (cfg.providers || []).find(p => p.id === cfg.activeProvider)
        if (prov) {
          const adopted = maybeAdoptWindowFromEvent(prov, learned)
          if (adopted !== null) {
            console.warn(`[bridge] adopting real context window ${adopted} for provider ${prov.id} (was ${prov.contextWindow})`)
            saveConfig({ providers: (cfg.providers || []).map(p => (p.id === prov.id ? { ...p, contextWindow: adopted } : p)) })
          }
        }
      }
    }
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
            // 卡片提取与剥离：原始 <!--ASK_USER...--> 标记绝不转发给前端（避免气泡里
            // 出现原始 HTML）。
            // 【2026-09-13 跨帧切片修复】提取必须走**累积缓冲**，不能只看单帧：内核的
            // wire 契约是增量文本帧（engine.mjs `textBuf += chunk.text` 后
            // `wire.assistant([{text: chunk.text}])`），provider 的切片边界一旦落在标记
            // 内部，单帧里就永远没有完整标记 ⇒ 不登记、不转发，而内核那边**确实在等**
            // （engine 的 textBuf 是累积的，它的 asksUser 能命中）——用户界面零提示、
            // 内核空转 600s。实证：04:02:35Z 内核 "ASK_USER 等待作答复超时"，而渲染层
            // 前 620s 内一个 question 帧都没有（问题卡从未出现在界面上）；本仓 mock 的
            // streamText 按 1/3 等分切片，必然切碎标记，即该形态的最小复现
            // （server/stall-watchdog.test.mjs 用例②）。
            // 复位点只取**轮次/消息**边界（result 帧、新 send）：工具轮与文本轮同属一步，
            // engine 的 asksUser 在工具执行后仍看整步 textBuf，按 tool_use 复位反而会
            // 漏掉"边问边做"的提问。
            session._askBuf = (session._askBuf + block.text).slice(-ASK_BUF_MAX)
            const extracted = extractAskUserBlocks(session._askBuf)
            if (extracted.blocks.length > 0) {
              // 消费式：提取后即清空，防止同一标记在后续帧里被重复登记/重复弹卡
              session._askBuf = ''
              // 展示剥离只在"整块落在本帧内"时可行；跨帧切片的残片由渲染层
              // truncatePartialAskUser 截断兜底（此前正是它独自在扛）
              const perFrame = extractAskUserBlocks(block.text)
              if (perFrame.blocks.length > 0) block.text = perFrame.clean.trim() || '(Asking...)'
              for (const b of extracted.blocks) {
                const qdata = parseAskUserPayload(b.payloadText)
                if (qdata) {
                  session._pendingQuestions = qdata
                  noteSessionAwaiting(session)
                  send({ type: 'question', sessionId: sid, data: qdata })
                  logForwarded('question', sid, ` qs=${qdata.questions?.length ?? '?'} parsed=1`)
                } else {
                  // 解析失败：带 raw 载荷让前端尝试容错解析；仍无法解析时由
                  // 前端渲染层用内联只读卡兜底，用户至少能看到问题内容直接回复。
                  // 必须同样登记 _pendingQuestions：2026-09-12 实证 raw 分支漏登记 ⇒
                  // 提问期间内核不被等待豁免保护 ⇒ 04:43:51 被当空闲回收，用户
                  // 04:46:47 的作答落空。日志带长度 + 首尾片段：截断（长度异常/尾部
                  // 半截 JSON）与校验不过（完整 JSON 但字段不合规）此前都只表现为
                  // 同一行"parse failed"，无法判因。
                  session._pendingQuestions = { raw: b.payloadText }
                  noteSessionAwaiting(session)
                  console.warn(`[bridge] ASK_USER payload parse failed (len=${b.payloadText.length}) sid=${sid.slice(0, 8)} head=${JSON.stringify(b.payloadText.slice(0, 120))} tail=${JSON.stringify(b.payloadText.slice(-48))}`)
                  send({ type: 'question', sessionId: sid, data: { raw: b.payloadText } })
                  logForwarded('question', sid, ' parsed=0(raw)')
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
        // hard = 内核判定的灾难级硬黑名单（四档都要问、且不参与拒绝降级计数）；
        // mode = 内核发起本次询问时生效的档位。二者供弹窗显示"为什么问 / 是不是硬黑名单"，
        // 旧内核不传 → undefined，GUI 按普通审批渲染（向后兼容）。
        const hard = req.hard === true
        session._pendingApprovals.set(toolUseId, {
          requestId: parsed.request_id,
          command,
          reason: req.decision_reason || '',
          toolName: req.tool_name || '',
          hard,
          at: Date.now(),
        })
        noteSessionAwaiting(session)
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
            hard,
            mode: req.mode || effectiveApprovalMode(sid),
          },
        })
        logForwarded('approval', sid, ` toolUseId=${toolUseId} hard=${hard}`)
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
    // 分类规则抽到 workflow-events.mjs（UI Task 14b / Task 12 审查 I-3，单测可覆盖）：
    //   · workflow_event → 广播 GUI（宿主会话的事件由 host.onEvent 抛同一形状，此处覆盖
    //     其他会话，如 auto_trigger 命中在普通会话里跑）；
    //   · workflow_result → 宿主会话（_wfhost）按 requestId 配对回执，结清在途命令
    //     （load/save/validate/run/stop）；其余会话无在途命令，无需投递。
    if (parsed) {
      const wfMsg = mapKernelMessage(parsed)
      if (wfMsg.kind === 'workflow_event') {
        broadcastGui({ type: 'workflow_event', sessionId: sid, event: wfMsg.payload })
      } else if (wfMsg.kind === 'workflow_result' && sid === HOST_SID && _wfHost) {
        _wfHost.onKernelMessage(wfMsg.payload)
      }
    }

    if (parsed) {
      // 压缩帧转发留痕（2026-09-13）：现场出现"内核确有压缩落地（stderr 有
      // [compact] action=summarized）但渲染器一条 system/compaction 都没收到"的未解差异
      // （当日 3/3 付费压缩）。本行给出事实依据：桥到底收没收到帧、广播集合里有几个客户端。
      // 只认 compaction 子型（每会话每轮至多两行），不构成日志噪声。
      if (parsed.type === 'system' && parsed.subtype === 'compaction') {
        // 时间戳供失速看门狗做**有界**豁免（摘要 480–600s 静默 > 失速阈值 420s，见下方
        // warnStalledKernels）：只记时间、不记布尔态，故不需要在任何终态路径清理。
        session._lastCompactFrameAt = Date.now()
        console.log(`[bridge] compaction frame state=${parsed.state} sid=${sid} ok=${parsed.ok ?? '-'} covered=${parsed.covered ?? '-'} coveredTokens=${parsed.coveredTokens ?? '-'} clients=${wsClients.size}`)
      }
      send({ type: 'event', data: parsed, sessionId: sid })
    } else {
      send({ type: 'raw', data: t, sessionId: sid })
    }
  })
  if (proc.stderr) createInterface({ input: proc.stderr }).on('line', (l) => {
    // 内核 stderr 落盘 + 本地日志：崩溃诊断的唯一原文来源（GUI 只记事件名不记内容）
    console.error(`[bridge][kernel-stderr] ${l}`)
    logKernelStderr(sid, l)
    send({ type: 'stderr', data: l, sessionId: sid })
  })
  proc.on('error', (e) => { if (promptFile) { try { rmSync(promptFile, { force: true }) } catch {} }; send({ type: 'error', data: { message: e.message }, sessionId: sid }); sessions.delete(sid); clearSessionApprovalMode(sid) })
  proc.on('close', (code) => {
    // 会话结束 → 清理临时系统提示词文件，避免 %TEMP% 堆积
    if (promptFile) { try { rmSync(promptFile, { force: true }) } catch {} }
    sessions.delete(sid)
    // 会话级临时审批档位随会话消亡（仅内存）：清掉覆盖并广播，徽标可见地弹回全局档。
    // 内核进程已退出，无需注入。_reaped（切模型重建）也算一次会话结束 → 同样回落全局。
    clearSessionApprovalMode(sid)
    // 工作流宿主内核退出：立即结清在途命令。缺这一步，宿主一死，GUI 的创建/保存/运行会
    // 静默挂到超时（默认 120s、run 更长达 30min）——用户侧只看到"点了没有任何反应"，
    // 2026-09-12 实测缺陷（cwd 不存在 → spawn ENOENT 秒退）就是这么被掩盖的。
    if (sid === HOST_SID) { try { _wfHost?.onKernelExit(sid) } catch { /* 结清失败不阻断退出流程 */ } }
    // 空闲回收触发的退出不广播 closed：前端保留该会话的任务卡等 UI 状态，
    // 下次发消息会以 --resume 无缝重启内核（广播 closed 会让渲染层清空任务卡）。
    if (!session._reaped) send({ type: 'closed', data: {}, sessionId: sid })
    // 诊断埋点：非零退出码且非主动取消 → 计为内核异常退出（崩溃）。
    // 主动取消（cancel）会 kill 内核但 _cancelPending 置位，不计入崩溃。
    if (code !== 0 && code !== null && !session._cancelPending) {
      diagInfo.kernelCrashCount++
      // 附上 spawn 至今耗时：跨机器"spawn 后 N 秒退出"是关键的时序线索
      const el = Math.round(Date.now() - spawnT0)
      console.error(`[bridge] kernel exited abnormal code=${code} (sid ${sid.slice(0, 8)}) after ${el}ms`)
    }
  })
  // _awaitingSince = 首次登记"有未决等待（提问/审批）"的时刻（0 = 当前无等待）。回收器
  // 据此给等待豁免设时限：豁免无条件 ⇒ 内核挂死或 GUI 永不回执时永远收不掉（T9）。
  const session = { proc, cwd: mode === 'chat' ? YFW_HOME : (cwd || process.cwd()), mode, _pendingQuestions: null, _proseProgress: { total: 0, lastIndex: 0, structuredUsed: false }, _pendingApprovals: new Map(), firstTokenAt: null, _lastOutAt: 0, _turnActive: false, _stallWarnedAt: 0, _reaped: false, _cancelPending: false, _cancelAt: 0, _cancelTimer: null, _turnStartAt: 0, _fbpTimer: null, _fbpFirstTimer: null, _awaitingSince: 0, _lastCompactFrameAt: 0, _askBuf: '', _spawnEnvSig: providerEnvSig(buildChildEnv()) }
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

// 提问标记跨帧累积缓冲上限（2026-09-13）：正常标记 1–2KB（含 JSON 载荷），8KB 足够
// 容纳"当前帧之前尚未闭合的残片"；超限丢最旧的，保证单会话内存有界。
const ASK_BUF_MAX = 8192

// 转发留痕（2026-09-13）：提问/审批帧此前是**静默**广播，"发给了 0 个客户端"与"发失败"
// 都无迹可查。实证代价：9 次提问里有 5 次的帧只在 WS 重连的 hello 重放时才到达渲染器
// （最久一次内核 10:46:19 提问、帧 10:53:13 才到，7 分钟内 UI 既无卡片也无任何解释），
// 期间内核在等、用户在等、日志里一个字都没有。与压缩帧同款记法（clients 计数），
// 让"帧到底发出去没有"在下一次事故里一眼可判；0 客户端时明确告警——那种帧只能靠
// 下一次 hello 重放兜底（见 pending replay）。
function logForwarded(kind, sid, extra = '') {
  const n = wsClients.size
  const tail = `sid=${String(sid).slice(0, 8)} clients=${n}${extra}`
  if (n === 0) console.warn(`[bridge] ${kind} forwarded ${tail} — 无客户端，只能靠下次 hello 重放`)
  else console.log(`[bridge] ${kind} forwarded ${tail}`)
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
  if (req.method === 'OPTIONS') {
    // 预检响应头补全（Task 6b/D11-D13）：认证小窗对 /api/auth/setup|login 的
    // application/json POST 依赖浏览器预检通过——只回 origin 会让 file:///
    // （打包）与 localhost:5173（vite dev）的 renderer 预检失败、真实 POST 不发。
    // 白名单式：方法/头枚举固定值，不引入任意来源反射。
    // 2026-09-12（人工测试缺陷）：补 PUT/PATCH/DELETE——工作流模块的保存
    // （PUT /workflows/:id）、信任清单（PUT /workflows/bindings）、删除（DELETE
    // /workflows/:id）都是带 application/json 的**非简单请求**，预检未声明该方法，
    // 浏览器即拦下、真实请求永不发出：用户侧表现为「信任清单写入失败：Failed to
    // fetch」与整片 fetch 报错。curl 与直调路由的单测都不发预检，故此前 52 项
    // 自动化全绿也照不出来；auth-preflight.test.mjs 已把该方法白名单锁成契约。
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    reply(204, {}); return
  }
  const url = new URL(req.url, 'http://localhost:' + PORT)
  try {
    // 工作流路由链最前：仅 /workflows* 前缀进入（无关请求不必构造宿主单例/读配置），
    // 命中即 return；路由函数未匹配返回 false → 继续走下方既有路由（不吞其他端点）。
    // 置于既有 try 内：宿主构造（loadConfig）等意外抛错走统一 400 回执，不打穿 handler。
    if (url.pathname === '/workflows' || url.pathname.startsWith('/workflows/')) {
      if (await handleWorkflowRoute({ url, req, reply, readJsonBody, host: workflowHost(), root: WF_ROOT, runsRoot: WF_RUNS })) return
    }
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
    // --- 运行日志（2026-09-12 本地持久化策略）：设置页的日志面板 ---
    // 逻辑抽在 server/logs-routes.mjs（可单测：不必起桥，避免测试误杀正在运行的应用）
    const logsRes = handleLogsRoute({
      method: req.method, pathname: url.pathname, searchParams: url.searchParams,
      home: YFW_HOME, policy: readLogPolicyCached({ home: YFW_HOME }),
    })
    if (logsRes) {
      return reply(logsRes.status, { 'Content-Type': 'application/json' }, JSON.stringify(logsRes.body))
    }
    // 启动预热状态（2026-09-11 真实 boot 进度）：main 轮询本端点转发给 BootScreen——
    // 各模块真实完成后置位，渲染层按真实步骤渲染、全部就绪才交棒
    if (url.pathname === '/boot-status') {
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, ...bootState }))
    }

    // 登录屏口令端点（GUI 专用）：本地 scrypt 口令（server/auth.mjs），token 仅占位
    if (url.pathname === '/api/auth/status') {
      const st = await getAuthStatus()
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify(st))
    }
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
      const { password } = await readJsonBody(req).catch(() => ({}))
      try { await setupPassword(password); return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true })) }
      catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e?.message || String(e) })) }
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { password } = await readJsonBody(req).catch(() => ({}))
      try {
        const r = await checkPassword(password)
        if (r.ok) return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, token: issueToken() }))
        const code = r.lockedForMs != null ? 423 : 401
        return reply(code, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: r.reason, lockedForMs: r.lockedForMs ?? null }))
      } catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e?.message || String(e) })) }
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const { token } = await readJsonBody(req).catch(() => ({}))
      if (token) authTokens.delete(token)
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
    }
    // 修改密码（2026-09-10 个人信息窗）：验证旧密 → 新盐新哈希；未初始化时直接设置。
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
      const { oldPassword, newPassword } = await readJsonBody(req).catch(() => ({}))
      try {
        const r = await changePassword(oldPassword, newPassword)
        if (!r.ok) {
          const code = r.lockedForMs != null ? 423 : 401
          return reply(code, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: r.reason, lockedForMs: r.lockedForMs ?? null }))
        }
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, wasUninitialized: r.wasUninitialized === true }))
      } catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e?.message || String(e) })) }
    }
    // 用户档案（2026-09-10 个人信息窗）：昵称/头像(dataURL)/简介，落盘
    // <YFW_HOME>/userData/profile.json；头像上限 400KB 防单文件膨胀。
    if (url.pathname === '/api/profile' && req.method === 'GET') {
      try {
        return reply(200, { 'Content-Type': 'application/json' }, readFileSync(PROFILE_PATH, 'utf-8'))
      } catch { return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ nickname: '', avatar: '', bio: '' })) }
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}))
      const nickname = String(body.nickname ?? '').slice(0, 64)
      const bio = String(body.bio ?? '').slice(0, 500)
      const avatar = String(body.avatar ?? '')
      if (avatar.length > 400_000) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'avatar too large' }))
      try {
        mkdirSync(dirname(PROFILE_PATH), { recursive: true })
        writeFileSync(PROFILE_PATH, JSON.stringify({ nickname, avatar, bio }, null, 2), 'utf-8')
        return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
      } catch (e) { return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: String(e?.message || e) })) }
    }

    // 上下文失真：用户「重新锚定」后上报（GUI → 内核 stdin control 消息）
    // 内核把对应证据标记 resolved → 失真档立即回绿 + 进入观察期。前端上报只是
    // "用户已处理"的信号，不是真值来源（判定永远在内核）；失败不阻塞前端本地回绿。
    if (url.pathname === '/session/anchor-applied' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}))
      const built = buildAnchorApplied(body?.sessionId, body?.issueIds)
      if (!built) return reply(400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: 'sessionId required' }))
      writeControlRequest(built.sessionId, built.message)
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }))
    }

    // U1 只读子命令薄转发：query → kernel 只读子命令 → 透传 stdout JSON（schema A.1/A.2）
    if (url.pathname === '/api/usage' || url.pathname === '/api/audit') {
      const sub = url.pathname === '/api/usage' ? '--usage' : '--audit'
      const flags = []
      for (const k of ['scope', 'sessionId', 'project', 'from', 'to']) {
        const v = url.searchParams.get(k)
        if (v) flags.push(`--${k}`, v)
      }
      try {
        const out = kernelReadonlySync([sub, ...flags], { env: buildChildEnv(), cwd: process.cwd() })
        return reply(200, { 'Content-Type': 'application/json' }, out)
      } catch (e) {
        return reply(502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e?.message || String(e) }))
      }
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
            // 欠费/计费异常检测（2026-09-11）：402 或响应体含余额不足语义 → billing
            // 标记（连测时即检验，不等到正式调用才发现）
            const billing = result.status === 402 || /insufficient balance|余额不足|not enough balance/i.test(result.body)
              ? 'insufficient_balance'
              : undefined
            const ok = billing ? false : (result.status === 200 || result.status === 400 || result.status === 401 || result.status === 403 || result.status === 404 || result.status === 429)
            let detail = ''
            try { detail = JSON.parse(result.body)?.error?.message || result.body.slice(0, 200) } catch { detail = result.body.slice(0, 200) }
            return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
              ok,
              reachable: true,
              httpStatus: result.status,
              endpoint: target,
              detail,
              billing,
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

    // API 能力探测 + 自动回填（2026-09-09）：provider 保存/激活后由 GUI 异步触发。
    // 探测 /v1/models 元数据 + 1-token TTFT + ~8k tokens 预填充基准 → 只填空位
    // 回填 contextWindow/firstByteMs/maxOutputTokens（用户手配值优先）；24h 缓存
    // 跳过元数据与基准（重复探测不烧 GPU）。
    if (url.pathname === '/probe-provider' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const r = await runProbeFor(body.providerId || null)
      if (r.error) return reply(404, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: r.error }))
      return reply(200, { 'Content-Type': 'application/json' }, JSON.stringify({
        ok: r.probe.ok, updates: r.updates, notes: r.notes, skipped: r.skipped,
        ttftMs: r.probe.ttftMs ?? null, latencyMs: r.probe.latencyMs ?? null,
        prefillTokPerSec: r.probe.prefillTokPerSec ?? null, fromCache: !!r.probe.fromCache,
      }))
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
          // contextWindow 不再默认 1000000（2026-09-09）：虚高默认是本地模型
          // 永不压缩的根因之一。新 provider 交由能力探测回填真实窗口（/probe-provider），
          // 探测前由 buildChildEnv 的 local 虚高钳制 + 内核模型表/默认 200k 兜底。
          ...(body.contextWindow ? { contextWindow: Number(body.contextWindow) } : {}),
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
//
// 【2026-09-13 判据收窄】旧判据只看 pong：一个 tick 没回 pong 就 terminate。取证（app.log*
// 全量 26 次 heartbeat timeout 与 25 次渲染器 [WS] closed 对齐）显示：其中 21 次踢的是
// **渲染器已经不认、桥却仍持有的僵尸 socket**（20 次渲染器侧断链桥侧连 close 事件都没收到，
// 即半开连接）——那是正确回收；但另有 5 次踢的是**活客户端**（渲染器 0–1.4s 前还在正常收帧），
// 因为 pong 是 Blink 在主线程上回的，渲染器一忙（长会话流式渲染/大消息）就排不上队，
// 被误判为死；随后就是用户可见的 1006 + 2s 重连 + resync（界面跳变）。
// 现改为两级证据：pong 超期 **且**（发送缓冲堆积 **或** 超硬上限）才回收：
//   · bufferedAmount 堆积 = 对端真的不读了（半开/已死）——比 pong 更可靠的死证；
//   · 硬上限兜底"忙到长时间不回 pong"的渲染器（真卡死就该断开，由 GUI 自愈重连+resync）。
// 日志同时给出身份与证据（role / noPongFor / buffered），断链可直接归因——此前无任何身份信息。
const _hbEnv = Number(process.env.YFW_WS_HEARTBEAT_MS)
const HEARTBEAT_MS = _hbEnv > 0 ? _hbEnv : 30000
const _pongGraceEnv = Number(process.env.YFW_WS_PONG_GRACE_MS)
const PONG_GRACE_MS = _pongGraceEnv > 0 ? _pongGraceEnv : 3 * HEARTBEAT_MS
const _pongHardEnv = Number(process.env.YFW_WS_PONG_HARD_MS)
const PONG_HARD_MS = _pongHardEnv > 0 ? _pongHardEnv : 5 * 60 * 1000
const heartbeatTimer = setInterval(() => {
  const now = Date.now()
  for (const c of wsClients) {
    if (c.isAlive !== false) {
      c._yfwPongWarned = false // 上一 tick 的 pong 已回 ⇒ 一切正常
    } else {
      const since = now - (c._yfwLastPongAt || c._yfwConnectedAt || now)
      if (since >= PONG_GRACE_MS) {
        const buffered = c.bufferedAmount || 0
        const role = c._yfwRole || 'unknown'
        if (buffered > WS_OVERLOAD_CLEAR_BYTES || since >= PONG_HARD_MS) {
          console.warn(`[bridge] heartbeat timeout — dropping stale client role=${role} noPongFor=${Math.round(since / 1000)}s buffered=${(buffered / 1048576).toFixed(2)}MB clients=${wsClients.size}`)
          wsClients.delete(c)
          try { c.terminate() } catch {}
          continue
        }
        // 半开但仍在读 ⇒ 多半是渲染器主线程忙（pong 排队），不是死：保留。只留一次痕。
        if (!c._yfwPongWarned) {
          c._yfwPongWarned = true
          console.warn(`[bridge] WS client pong overdue ${Math.round(since / 1000)}s but socket healthy (role=${role} buffered=${(buffered / 1048576).toFixed(2)}MB) — keeping`)
        }
      }
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
// 轮次活跃豁免的时限（2026-09-12 死锁修复）：`_turnActive` 只由 result 帧解除，而挂死
// 内核永不发 result ⇒ 无条件豁免 = 回收器永不动手（pid 6736 静默 53min、pid 21196 静默
// 13min 全靠用户手杀）。健康内核的硬看门狗不会让它静默超过默认 600s（T10 抬到 900s），
// 留足余量后仍无输出的"活跃轮次"只能是挂死。设 0 = 关闭该判定（回到旧的无条件豁免）。
const _turnReapEnv = process.env.YFW_KERNEL_TURN_REAP_MS
const KERNEL_TURN_REAP_MS = _turnReapEnv === '0' ? 0 : (Number(_turnReapEnv) > 0 ? Number(_turnReapEnv) : 20 * 60 * 1000)
// 未决等待（提问/审批）豁免的上限：等的是人不该被回收，但 GUI 永不回执时豁免必须失效，
// 否则同样是泄漏（审批帧发给了 0 个客户端 = 永远不会有人答复）。设 0 = 无限豁免。
const _waitEnv = process.env.YFW_KERNEL_WAIT_EXEMPT_MS
const KERNEL_WAIT_EXEMPT_MS = _waitEnv === '0' ? 0 : (Number(_waitEnv) > 0 ? Number(_waitEnv) : 30 * 60 * 1000)
// 等待态登记/结清：_awaitingSince = 本等待期的起点，供上面的时限判定。结清是"提问已答/
// 已忽略、审批已回执或工具已回吐结果、轮次已 result"——任何一处漏清都会把豁免无限延续。
function noteSessionAwaiting(session) {
  if (!session) return
  if (!session._awaitingSince) session._awaitingSince = Date.now()
}
function clearSessionAwaiting(session) {
  if (!session) return
  if (session._pendingQuestions) return
  if (session._pendingApprovals && session._pendingApprovals.size > 0) return
  session._awaitingSince = 0
}
function reapKernel(sid, s, message) {
  console.log(`[bridge] ${message}`)
  s._reaped = true
  try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000, stdio: 'ignore' }) } catch { try { s.proc.kill() } catch {} }
  sessions.delete(sid)
}
function reapIdleKernels() {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (!s || !s.proc || s.proc.killed) continue
    // 工作流宿主（_wfhost）是**常驻会话**：它从不发 assistant/result（_turnActive 恒 false），
    // "空闲"正是它的常态——按通用阈值回收会把"下次用工作流"变成一次冷启动，而冷启动窗口
    // （内核首行输出前 _lastOutAt===0）还会被下面的判定**立即回收**，在途的创建/保存/运行
    // 命令随之被 onKernelExit 判失败（2026-09-12 实测：首个 /workflows/verify 偶发
    // 「工作流宿主会话已退出，命令未完成」，第二次请求即正常）。故宿主不参与空闲回收。
    if (sid === HOST_SID) continue
    // 从未产出过任何 stdout 的会话（刚 spawn、内核尚未启动完）不得判定为空闲：
    // 旧写法 `s._lastOutAt > 0 && ...` 在 _lastOutAt===0 时短路为 false，直接落进回收分支，
    // 刚起来的会话会被秒杀（与上面的宿主冷启动竞态同源，一并按"启动中"豁免）。
    // 注意此判定必须排在所有"按静默时长"的判定之前：now-0 是天文数字，会秒判超时。
    // 但"轮次已开始却一行输出都没有"不能无限豁免（spawn 后崩在启动路径/事件循环未起 =
    // 用户面对一个永不响应的会话）：改用 _turnStartAt（发消息时刻）计时，超轮次上限即回收。
    if (!s._lastOutAt) {
      if (s._turnActive && s._turnStartAt > 0 && KERNEL_TURN_REAP_MS > 0 && now - s._turnStartAt >= KERNEL_TURN_REAP_MS) {
        reapKernel(sid, s, `stuck turn reaped: sid ${sid.slice(0, 8)} (turn active, no output ever, ${Math.round((now - s._turnStartAt) / 60000)}m)`)
      }
      continue
    }
    const idleMs = now - s._lastOutAt
    const awaiting = !!(s._pendingQuestions || (s._pendingApprovals && s._pendingApprovals.size > 0))
    if (awaiting) {
      const waitedMs = now - (s._awaitingSince || s._lastOutAt)
      if (KERNEL_WAIT_EXEMPT_MS === 0 || waitedMs < KERNEL_WAIT_EXEMPT_MS) continue
      reapKernel(sid, s, `waiting kernel reaped: sid ${sid.slice(0, 8)} (no answer in ${Math.round(waitedMs / 60000)}m, 等待豁免超上限)`)
      continue
    }
    if (s._turnActive) {
      if (KERNEL_TURN_REAP_MS === 0 || idleMs < KERNEL_TURN_REAP_MS) continue
      reapKernel(sid, s, `stuck turn reaped: sid ${sid.slice(0, 8)} (turn active but silent ${Math.round(idleMs / 60000)}m, 疑异步链失活)`)
      continue
    }
    if (idleMs < KERNEL_IDLE_REAP_MS) continue
    reapKernel(sid, s, `idle kernel reaped: sid ${sid.slice(0, 8)} (idle ${Math.round(idleMs / 60000)}m)`)
  }
}
// 扫描周期（默认 60s）：阈值都可用 env 缩小，周期同样需要能缩小——否则任何回收测试都要
// 真等一分钟。YFW_KERNEL_REAP_TICK_MS 主要给测试与短化复现用。
const _reapTickEnv = Number(process.env.YFW_KERNEL_REAP_TICK_MS)
if (KERNEL_IDLE_REAP_MS > 0) setInterval(reapIdleKernels, _reapTickEnv > 0 ? _reapTickEnv : 60000).unref?.()

// ---------------------------------------------------------------------------
// 内核失速看门狗：轮次活跃（assistant 已开启、result 未到）但内核 stdout 长期
// 静默 = 疑似挂起（本机实测：360 主动防御 + VBS 双钩子层失速时，powershell/
// 文件 I/O 会阻塞分钟级，工具调用挂在半途，前端表现为"交互没反应"）。
// 只告警不自动杀（杀进程会丢会话工作）；日志 + kernel-stall 事件供前端提示，
// 用户可手动取消/重启会话（--resume 无缝续聊）。
// YFW_KERNEL_STALL_MS 覆盖阈值（毫秒），设 0 关闭。
// ---------------------------------------------------------------------------
const _stallEnv = process.env.YFW_KERNEL_STALL_MS
// 失速告警阈值：10min → 420s（2026-09-09 三次校准）——90s 会在每次健康思考步
// （实测 35-260s，服务端缓冲不流式）误报失速。420s 略低于内核首字节硬上限
// 480s：健康思考+prefill 只触发温和的等待条，真挂起在 watchdog abort 前 1 分钟
// 升级为失速告警（分级衔接：first_byte_pending 5s → stall 420s → abort 480s）。
const KERNEL_STALL_WARN_MS = _stallEnv === '0' ? 0 : (Number(_stallEnv) > 0 ? Number(_stallEnv) : 420 * 1000)
// 首字节等待提示：轮次活跃后静默 firstMs 即发 first_byte_pending，此后每 intervalMs
// 重发（带累计静默时长），内核任何输出即清除（2026-09-09：prefill 阶段 UI 零反馈）。
const FIRST_BYTE_PENDING_MS = Number(process.env.YFW_FIRST_BYTE_PENDING_MS) > 0 ? Number(process.env.YFW_FIRST_BYTE_PENDING_MS) : 5000
const FIRST_BYTE_PENDING_INTERVAL_MS = 30 * 1000
// 压缩豁免上限（15min > 摘要最长 600s + 余量）；YFW_KERNEL_COMPACT_EXEMPT_MS 覆盖，0=关闭豁免。
const _compactExemptEnv = Number(process.env.YFW_KERNEL_COMPACT_EXEMPT_MS)
const KERNEL_COMPACT_EXEMPT_MS = Number.isFinite(_compactExemptEnv) && _compactExemptEnv >= 0 ? _compactExemptEnv : 900 * 1000
function warnStalledKernels() {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    if (!s || !s.proc || s.proc.killed) continue
    if (!s._turnActive) continue
    // 等待用户（提问/审批）是内核的**正常阻塞态**，不是失速：waitForAnswer/resolveApproval
    // 期间内核刻意零 stdout，静默是设计。不豁免则告警恰好落在用户犹豫的窗口里，文案还是
    // 「疑似 AV/驱动卡死，建议取消/重启」——2026-09-13 取证：14 次失速告警中 9 次可证为等人
    // （4 次审批挂起 207–463s、5 次提问等待），用户据此以为内核已死，这正是"不清楚内核是否
    // 正常运转"的来源。病理等待（GUI 永不回执）不由本函数兜底：回收器的
    // KERNEL_WAIT_EXEMPT_MS（默认 30min）会收掉，故豁免不会变成无界。
    if (s._pendingQuestions) continue
    if (s._pendingApprovals && s._pendingApprovals.size > 0) continue
    // 压缩在途同理：摘要是一次 480–600s 级完整请求，期间内核**故意**静默，而失速阈值
    // 420s < 600s ⇒ 任何一次真摘要都必然误报。用"最后一条压缩帧时刻"做**有界**豁免
    // （15min 上限）：done 帧即使丢失，豁免也会自行过期，不需要在终态路径清理。
    if (s._lastCompactFrameAt > 0 && now - s._lastCompactFrameAt < KERNEL_COMPACT_EXEMPT_MS) continue
    if (s._lastOutAt <= 0 || now - s._lastOutAt < KERNEL_STALL_WARN_MS) continue
    if (s._stallWarnedAt > 0 && now - s._stallWarnedAt < KERNEL_STALL_WARN_MS) continue
    s._stallWarnedAt = now
    const silentMin = Math.round((now - s._lastOutAt) / 60000)
    console.log(`[bridge] kernel stall warning: sid ${sid.slice(0, 8)} turn active but silent ${silentMin}m — possible AV/driver stall, consider cancel/restart`)
    try { send({ type: 'kernel-stall', data: { sessionId: sid, silentMs: now - s._lastOutAt }, sessionId: sid }) } catch {}
  }
}
// 扫描周期：阈值可用 env 缩小，周期也必须能缩小，否则任何失速判定测试都要真等一分钟
// （与 YFW_KERNEL_REAP_TICK_MS 同款约定；既有 60s 为默认值不变）。
const _stallTickEnv = Number(process.env.YFW_KERNEL_STALL_TICK_MS)
if (KERNEL_STALL_WARN_MS > 0) setInterval(warnStalledKernels, _stallTickEnv > 0 ? _stallTickEnv : 60000).unref?.()

// 首字节等待提示（2026-09-09 事故修复）：轮次活跃、内核静默 FIRST_BYTE_PENDING_MS
// 后发 first_byte_pending（携带静默时长），此后每 30s 重发；内核任何输出即清除。
// UI 据此渲染"等待首字节 Xs"，替代 prefill 阶段零反馈；超 90s 由失速告警分级接管。
function armFirstBytePending(session, sid) {
  clearFirstBytePending(session)
  session._turnStartAt = Date.now()
  // 计时器只操作它自己武装的那个 session 对象（2026-09-12 修复）：旧写法在 fire 里取
  // `sessions.get(sid)`，同名会话被回收重建后拿到的是**新对象**——守卫判假时清掉的是新
  // 会话的计时器（把当前轮的心跳永久关掉），而自己这个僵尸 interval 永不解除、每 30s
  // 继续空转，新会话又被自己的 arm 武装一次 ⇒ 重复帧/心跳中断交替出现。
  const own = session
  const stillCurrent = () => sessions.get(sid) === own && own.proc && !own.proc.killed && own._turnActive && !!own._turnStartAt
  const first = setTimeout(() => {
    const fire = () => {
      if (!stillCurrent()) { clearFirstBytePending(own); return }
      try { send({ type: 'event', data: { type: 'system', subtype: 'first_byte_pending', silentMs: Date.now() - own._turnStartAt }, sessionId: sid }) } catch {}
    }
    fire()
    own._fbpTimer = setInterval(fire, FIRST_BYTE_PENDING_INTERVAL_MS)
    if (own._fbpTimer?.unref) own._fbpTimer.unref()
  }, FIRST_BYTE_PENDING_MS)
  if (first.unref) first.unref()
  session._fbpFirstTimer = first
}
function clearFirstBytePending(session) {
  if (!session) return
  if (session._fbpFirstTimer) { clearTimeout(session._fbpFirstTimer); session._fbpFirstTimer = null }
  if (session._fbpTimer) { clearInterval(session._fbpTimer); session._fbpTimer = null }
  session._turnStartAt = 0
}
sweepOrphanPromptFiles()
// 测试场景通过 YFW_BRIDGE_NO_LISTEN 跳过顶层 listen，
// 由测试自行 httpServer.listen(0) 起随机端口；正式运行保持原有行为。
// 端口冲突自愈（2026-09-09 孤儿桥修复）：51517 被遗留 yfworking 孤儿进程占用时
// EADDRINUSE 会让新桥启动失败（渲染器连上孤儿旧桥 = "重启后无法唤醒"）。识别占用者：
// 本应用残留（命令行含 yfworking/bridge.mjs）→ 强杀后重试绑定；外来进程 → 报错退出。
function findPidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { timeout: 5000 }).toString()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`))
      if (m) return Number(m[1])
    }
  } catch { /* netstat 不可用则放弃识别 */ }
  return null
}
function isYfworkingProcess(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { timeout: 8000 },
    ).toString()
    return /yfworking|bridge\.mjs/i.test(out)
  } catch { return false }
}
if (!process.env.YFW_BRIDGE_NO_LISTEN) {
  let reclaimAttempts = 0
  const listenWithReclaim = () => {
    httpServer.once('error', (err) => {
      if (err.code !== 'EADDRINUSE' || reclaimAttempts >= 3) {
        console.error('[bridge] listen failed:', err.code || err.message)
        process.exit(1)
      }
      const pid = findPidOnPort(PORT)
      console.warn(`[bridge] port ${PORT} held by pid ${pid} (EADDRINUSE)`)
      if (pid && pid !== process.pid && isYfworkingProcess(pid)) {
        try { execSync(`taskkill -F -T -PID ${pid}`, { timeout: 5000, stdio: 'ignore' }) } catch {}
        console.warn('[bridge] killed orphan bridge pid', pid, '- reclaiming port')
      } else {
        console.error('[bridge] port occupied by foreign process - exiting')
        process.exit(1)
      }
      reclaimAttempts++
      setTimeout(listenWithReclaim, 800)
    })
    httpServer.listen(PORT, () => {
      console.log('[bridge] http+ws://localhost:' + PORT)
      autoInstallSamples()
      bootState.samplesInstalled = true // 预热就绪信号（同步函数，返回即完成/尽力）
      autoInstallBuiltinWorkflows()
      autoProbeActiveProvider()
      autoInstallTools()
    })
  }
  listenWithReclaim()
}
export { httpServer }
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
  // 身份与 pong 台账（2026-09-13）：断链归因缺的正是"哪个客户端、多久没回 pong、
  // 发送缓冲是否堆积"。role 默认 gui（执行器在 executor:hello 处改写）；首包类型另记一笔
  // ——pet/浏览器等非 GUI 客户端此前在日志里完全不可分辨。
  ws._yfwRole = 'gui'
  ws._yfwConnectedAt = Date.now()
  ws._yfwLastPongAt = Date.now()
  ws._yfwFirstMsgType = ''
  ws._yfwPongWarned = false
  ws.on('pong', () => { ws.isAlive = true; ws._yfwLastPongAt = Date.now() })
  // 桥身份握手（2026-09-12 桥树杀事故的无感愈合）：GUI 首包即收 bridge_hello。
  // 前端对比身份 id——换桥重连时旧会话已随旧桥消亡，据此静默自动续接
  // （--resume 无缝）；同一桥瞬时闪断则 id 不变，不做多余动作。
  try { ws.send(JSON.stringify({ type: 'bridge_hello', id: BRIDGE_INSTANCE_ID })) } catch {}
  console.log('[bridge] GUI connected')
  // 未决等待重放（2026-09-12）：审批/提问帧此前只在产生的那一刻广播一次——若那一刻恰好
  // 没有 GUI 连接（WS 空窗）或连接刚被心跳判死，帧就永久丢失，内核在等一个没人看得见的
  // 答复（实测 17891979 的审批帧发给了 0 个客户端，此后 13 分钟无人回收）。新客户端接入
  // 即重放当前未决项；另补一帧 first_byte_pending，让"内核静默中"这类纯周期信号不必
  // 再等下一个 30s tick（重连后 UI 立刻有话说）。
  try {
    const sendToThis = (msg) => { try { ws.send(JSON.stringify(msg)) } catch {} }
    for (const [sid, s] of sessions) {
      if (!s || !s.proc || s.proc.killed) continue
      if (s._pendingQuestions) sendToThis({ type: 'question', sessionId: sid, data: s._pendingQuestions })
      if (s._pendingApprovals && s._pendingApprovals.size > 0) {
        // 超过内核审批窗口（PONOS_APPROVAL_TIMEOUT_MS，默认 600s，全仓无覆盖点）
        // 的未决审批**不得重放**：内核侧早已放弃等待，回执会被静默丢弃（resolveApproval
        // 查不到 waiter），用户点下去只会"没反应"——这正是"审批时消息已过期"的实证形态。
        // 直接清掉并解除等待豁免（否则残留项继续豁免回收器 → 内核泄漏）。
        const staleMs = Number(process.env.YFW_APPROVAL_STALE_MS) > 0 ? Number(process.env.YFW_APPROVAL_STALE_MS) : 630_000
        for (const [toolUseId, p] of [...s._pendingApprovals]) {
          const age = Date.now() - (p.at || Date.now())
          if (age > staleMs) {
            s._pendingApprovals.delete(toolUseId)
            clearSessionAwaiting(s)
            console.log(`[bridge] dropped stale approval on replay sid=${sid.slice(0, 8)} age=${Math.round(age / 1000)}s toolUseId=${toolUseId}`)
            continue
          }
          sendToThis({
            type: 'approval',
            sessionId: sid,
            data: {
              toolUseId,
              command: p.command,
              requestId: p.requestId,
              reason: p.reason,
              toolName: p.toolName,
              highRisk: matchesHighRisk(p.command),
              hard: p.hard,
              mode: effectiveApprovalMode(sid),
              replayed: true,
              // 年龄透传：重放时 UI 可显示"该审批等待 N 分钟"，
              // 而不是把一条老弹窗当新请求（用户据此判断是否已被模型绕过）
              ageMs: age,
            },
          })
        }
      }
      if (s._turnActive && s._lastOutAt > 0 && Date.now() - s._lastOutAt >= FIRST_BYTE_PENDING_MS) {
        sendToThis({ type: 'event', data: { type: 'system', subtype: 'first_byte_pending', silentMs: Date.now() - (s._turnStartAt || s._lastOutAt) }, sessionId: sid })
      }
    }
  } catch (e) { console.warn('[bridge] pending replay failed:', e.message) }
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (!ws._yfwFirstMsgType) {
        ws._yfwFirstMsgType = String(msg.type || '')
        console.log(`[bridge] WS client first message type=${ws._yfwFirstMsgType} role=${ws._yfwRole}`)
      }
      if (msg.type === 'executor:hello') {
        // 主进程执行器客户端（Electron 主进程 WS）首条消息注册。执行器不是
        // GUI 广播目标：从 wsClients 摘除（不接收 GUI 事件、不参与心跳）。
        wsClients.delete(ws)
        browserRouter.removeGuiClient(ws)
        browserRouter.registerExecutor(ws)
        ws._yfwRole = 'executor'
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
        // Conversation.mode 收敛：'chat' 走受限 spawn（禁本地工具 + cwd=YFW_HOME），
        // 其余（task/undefined 旧会话）维持现状全工具
        const mode = msg.mode === 'chat' ? 'chat' : 'task'
        const session = getOrCreateSession(sid, msg.cwd, msg.resumeId, msg.systemPrompt, msg.model, msg.compactCount, mode)
        if (!session) return // spawn failed — error already sent via WebSocket
        session.proc.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: msg.prompt },
          ...(msg.priority ? { priority: msg.priority } : {}),
          ...(msg.uuid ? { uuid: msg.uuid } : {}),
        }) + '\n')
        session._turnActive = true
        session._askBuf = '' // 新用户消息：上一条消息残留的标记残片不得与本次文本拼接
        armFirstBytePending(session, sid)
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
          // 取消即作废未决等待：内核收到 cancel 会 abort 当前轮，挂起的提问/审批不会再有
          // 答复，残留只会让回收器继续豁免该会话（T9.1）。GUI 侧由 cancelled 帧同步清空。
          s._pendingQuestions = null
          if (s._pendingApprovals?.size) s._pendingApprovals.clear()
          s._awaitingSince = 0
          s._cancelTimer = setTimeout(() => {
            // 未确认即强杀（2026-09-12 尸体事故修复）：旧判据 `_lastOutAt > _cancelAt`
            // 只杀"仍在产出"的内核——失活尸体（零输出、事件循环无任务排程）永远
            // 不会被强杀，用户点停止面对的就是一个永不响应的进程。新判据：
            // cancel 注入 6s 后仍未确认（result 未到 → _cancelPending 未清、进程
            // 未退）即判尸体，taskkill 强杀。健康内核 abort 传导秒级应答，
            // 6s 无应答者必为尸体（硬看门狗 10 分钟兜底之前人工即可回收）。
            if (sessions.get(sid) === s && s._cancelPending) {
              console.warn('[bridge] cancel fallback: kernel not acknowledged cancel in 6s, hard kill')
              try { execSync(`taskkill -F -T -PID ${s.proc.pid}`, { timeout: 5000 }) } catch { try { s.proc.kill() } catch {} }
              sessions.delete(sid)
            }
            s._cancelPending = false
            s._cancelTimer = null
          }, 6000)
          s._cancelTimer.unref?.()
        }
        send({ type: 'cancelled', data: { sessionId: sid } })
      } else if (msg.type === 'effort') {
        // 思考深度热切换（Task 12）：GUI 改 effort → 对运行中内核会话注入
        // reasoning_effort control_request。会话不存在/进程已死/level 为空 → 幂等忽略
        //（新会话由 buildChildEnv 的 CLAUDE_CODE_EFFORT_LEVEL env 注入兜底）。
        // 注意：bridge 无 lastSessionId——目标会话由前端解析（conversationId || 前端
        // lastSessionId || 'default'）后随消息带给本 case，这里只信任 msg.sessionId。
        const sid = msg.sessionId || 'default'
        const s = sessions.get(sid)
        const level = String(msg.level ?? 'auto').trim()
        console.log('[bridge] effort sid:', sid.slice(0, 8), '| level:', level)
        if (s && s.proc && !s.proc.killed && level) {
          try {
            s.proc.stdin.write(JSON.stringify({
              type: 'control_request',
              request_id: 'effort-' + Date.now(),
              request: { subtype: 'reasoning_effort', payload: { value: level } },
            }) + '\n')
          } catch (e) {
            console.warn('[bridge] effort send failed:', e.message)
          }
        }
      } else if (msg.type === 'approval-mode') {
        // 审批档位切换（2026-09-12 四档化）：状态栏徽标 = 本会话临时覆盖（仅内存），
        // 设置页改的是全局持久化档位（走 POST /config）。两种语义共用本 case：
        //   mode = 'manual'|'auto'|'loose'|'bypass' → 写会话覆盖；mode = null/'' → 清除覆盖。
        const sid = msg.sessionId || 'default'
        const raw = msg.mode === null || msg.mode === undefined || msg.mode === '' ? null : String(msg.mode)
        if (sid === HOST_SID) {
          // 工作流宿主不接受会话覆盖（GUI 不渲染它的状态栏，覆盖了没人能撤销）
          send({ type: 'approval-mode-rejected', sessionId: sid, data: { reason: '工作流宿主会话不支持临时覆盖', mode: effectiveApprovalMode(sid) } })
        } else if (raw !== null && !isValidApprovalMode(raw)) {
          console.warn(`[bridge] approval-mode 非法值 ${JSON.stringify(raw)} sid=${sid.slice(0, 8)}`)
          send({ type: 'approval-mode-rejected', sessionId: sid, data: { reason: `非法档位 ${JSON.stringify(raw)}`, mode: effectiveApprovalMode(sid) } })
        } else {
          if (raw === null) sessionApprovalModes.delete(sid)
          else sessionApprovalModes.set(sid, normalizeApprovalMode(raw))
          const mode = effectiveApprovalMode(sid)
          console.log(`[bridge] approval-mode sid: ${sid.slice(0, 8)} | ${raw === null ? 'clear(→global)' : raw} → ${mode}`)
          // 活会话就地热切换（无进程则下次 spawn 时按 effectiveApprovalMode 参数生效）
          pushApprovalModeToKernel(sid, mode)
          broadcastApprovalMode(sid, raw === null ? 'cleared' : 'session')
        }
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
        if (session) { session._pendingQuestions = null; clearSessionAwaiting(session) }
        send({ type: 'question-resolved', sessionId: sid })
      }
      else if (msg.type === 'question-dismiss') {
        // 用户跳过/关闭了提问卡片：CLI 保持等待（由新消息解除阻塞），
        // 但向嘉嘉等监听者广播”提问已处理”，撤销待回答提示
        const sid = msg.sessionId || 'default'
        const session = sessions.get(sid)
        if (session) { session._pendingQuestions = null; clearSessionAwaiting(session) }
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
        let resolvedPending = false
        if (session && session.proc && !session.proc.killed && toolUseId) {
          const pending = session._pendingApprovals?.get(toolUseId)
          if (pending && pending.requestId) {
            resolvedPending = true
            // 白名单审批写入（2026-09-10）：内核 Browser 工具被域名白名单拦截时发起
            // toolUseId='whitelist:<domain>' 审批——批准即写入 browser-whitelist.json
            // 的 allow 数组（执行器 mtime 热重载，即时生效无需重启），内核随后提示
            // 模型重试同一操作。
            if (approved && String(toolUseId).startsWith('whitelist:')) {
              addBrowserWhitelist(String(toolUseId).slice('whitelist:'.length))
            }
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
            clearSessionAwaiting(session)
            console.log(`[bridge] approval-response sid=${sid.slice(0, 8)} toolUseId=${toolUseId} approved=${approved}`)
          } else {
            console.warn(`[bridge] approval-response: no pending approval for toolUseId=${toolUseId}（内核已超时放弃或已收口 ⇒ 本条回执不生效）`)
          }
        }
        // 回执必须带**真实** approved：渲染侧此前只能硬编码 true（approval-resolved 无该
        // 字段），导致"[permission] resolved: … approved"日志既不能当批准证据、也无法区分
        // 过期 no-op。stale=true 明确告诉 UI"这条没能生效"（内核已放弃等待）。
        send({ type: 'approval-resolved', sessionId: sid, data: { toolUseId, approved, ...(resolvedPending ? {} : { stale: true }) } })
      }
      else if (msg.type === 'browser_control') {
        // GUI 暂停/继续执行器 → 转发 executor（bridge 仅路由，不解释语义）
        browserRouter.onGuiControl(msg.sessionId, msg.command)
      }
      else if (msg.type === 'ping') {
        // 应用层心跳：GUI 定期 ping 探测 WS 是否半开——TCP 假死时浏览器 send
        // 静默失败且不触发 error/close，仅靠传输层 ping 无法感知失联。收到即回
        // pong；超时未收到任何消息的判死与自愈重连由 GUI 侧负责（bridge 不判超时）。
        try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })) } catch {}
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
// 供应商能力探测 + 实测回填 + 实时广播（2026-09-11）：/probe-provider 路由与启动
// 自动探测共用。服务端实测值覆盖预置（contextWindow/models），保存后广播
// provider_updated 让设置窗口实时刷新；运行中的内核会话由既有 env 签名收割机制
// 在下次发送时自然接管新配置。
async function runProbeFor(providerId = null) {
  const cfg = loadConfig()
  const provider = (cfg.providers || []).find(p => p.id === (providerId || cfg.activeProvider)) || (cfg.providers || [])[0]
  if (!provider) return { error: 'provider not found' }
  const model = provider.primaryModel || (provider.models && provider.models[0]) || ''
  const cache = provider.probeResult
  // toolsSupported !== undefined：旧版缓存（2026-09-12 前写入）没有工具能力结论 →
  // 视为不新鲜，复探一次（一次性成本，换来"探测结论完整"的一致语义；否则升级后
  // 最长 24h 内探测不报工具能力）
  const cacheFresh = !!(cache && cache.at && (Date.now() - cache.at < 24 * 3600 * 1000) && cache.baseUrl === provider.apiBaseUrl && cache.model === model && cache.toolsSupported !== undefined)
  let probe
  if (cacheFresh) {
    probe = {
      ok: true, fromCache: true, ttftMs: null, latencyMs: null,
      modelsMeta: cache.maxModelLen ? [{ id: model, maxModelLen: cache.maxModelLen }] : null,
      prefillTokPerSec: cache.prefillTokPerSec ?? null,
      toolsSupported: cache.toolsSupported ?? null,
    }
  } else {
    probe = await probeProviderCapabilities({ apiBaseUrl: provider.apiBaseUrl, authToken: provider.authToken, model })
  }
  const { updates, notes, skipped } = applyProbeResults(provider, probe, { profile: resolveProviderProfile(provider) })
  const learnedWindow = resolveWindowFromProbe(provider, probe)
  const nextProvider = {
    ...provider,
    ...updates,
    probeResult: { at: Date.now(), baseUrl: provider.apiBaseUrl, model, maxModelLen: learnedWindow, prefillTokPerSec: probe.prefillTokPerSec ?? null, toolsSupported: probe.toolsSupported ?? null },
  }
  saveConfig({ providers: (cfg.providers || []).map(p => (p.id === provider.id ? nextProvider : p)) })
  // 工具能力为 false 时无条件落一条 warn（诊断日志可查；GUI 侧经 notes/设置页可见）
  if (probe.toolsSupported === false) {
    console.warn('[bridge] provider 未开启工具调用（带 tools 的请求被服务端拒绝）:', provider.id, '→ 需以 --enable-auto-tool-choice --tool-call-parser 启动模型服务')
  }
  // 广播条件含 notes：工具能力警示可能不伴随任何 updates（配置无需变更），
  // 但结论必须让设置页刷新时可见（旧实现只按 updates 判定会吞掉纯提示型结论）
  if (Object.keys(updates).length || notes.length) {
    console.log('[bridge] probe auto-tuned provider', provider.id, JSON.stringify(updates))
    broadcastGui({ type: 'provider_updated', data: { providerId: provider.id, updates, notes } })
  }
  return { probe, updates, notes, skipped }
}

// 启动自动探测（2026-09-11 实时更新）：应用启动即用实测值校正活跃供应商配置
// （模型清单/上下文窗口/预算），无需用户操作也保持配置新鲜。异步静默，失败不阻断。
// 每 12 小时复探一次：提供方改名/升级窗口等变化在长时运行中也能自动跟随。
function autoProbeActiveProvider() {
  const probeOnce = () => {
    runProbeFor(null)
      .catch((e) => console.warn('[bridge] auto-probe failed:', e?.message || e))
      .finally(() => { bootState.probeDone = true }) // 预热就绪信号（含欠费检测完成）
  }
  setTimeout(probeOnce, 8000) // 稍等启动稳定（网络/认证就绪）
  setInterval(probeOnce, 12 * 3600 * 1000).unref?.()
}

// 内置工作流自动安装（2026-09-11 spec-dev；Task 8 改为按 version 覆盖升级）：
// <appRoot>/workflows/<id>/workflow.yml → <YFW_HOME>/workflows/<id>/workflow.yml
// （内核工作流发现根 <configDir>/workflows，configDir === YFW_HOME，见 kernel/cli.mjs
//   workflowRoots = [...skillRoots, join(configDir, 'workflows')]）。
// 实现抽到 server/workflow-install.mjs：它可被测试直接 import，而 bridge.mjs 顶层会
// listen(51517)（EADDRINUSE 自愈还会 taskkill 用户进程），测试 import 它会真起桥。
// 语义：目标不存在→安装；版本不同（或版本同但正文异）→备份 workflow.v<旧版>.bak.yml 后覆盖；
//       完全相同→跳过；技能根里的 legacy 同名副本（旧版安装位置）备份为 *.legacy.bak.yml 后删除，
//       否则它会被内核优先发现、永久遮蔽新版（review C-1）。
function autoInstallBuiltinWorkflows() {
  try {
    const r = installBuiltinWorkflows({
      srcRoot: join(__dirname, '..', 'workflows'),
      dstRoot: join(YFW_HOME, 'workflows'),
      legacyRoots: [findSkillRoot()], // 旧版安装器把内置工作流装进技能根 → 需清理
    })
    if (r.installed.length || r.updated.length || r.contentUpdated.length || r.legacyRemoved.length) {
      console.log('[bridge] builtin workflows:', JSON.stringify(r))
    }
  } catch (e) {
    console.warn('[bridge] autoInstallBuiltinWorkflows failed:', e?.message || e)
  } finally {
    bootState.workflowsInstalled = true // 预热就绪信号（失败也已尽力，不阻塞 boot）
  }
}

// 内置技能播种与更新（P2-2）。装/更新/跳过的决策全在 server/skill-install.mjs
// （可测模块），这里只负责：解析源根与目标根、把统计打成日志、置 boot 就绪信号。
function autoInstallSamples() {
  try {
    const skillRoot = findSkillRoot()
    const candidates = [...SAMPLE_SKILL_ROOTS]
    const src = candidates.find(p => existsSync(p))
    if (!src) { console.log('[bridge] auto-install: sample-skills source not found'); return }
    const r = installBuiltinSkills({
      srcRoot: src,
      dstRoot: skillRoot,
      manifestPath: join(skillRoot, '.auto-installed.json'), // 指纹台账（取代"装过即短路"的开关）
    })
    for (const id of r.installed) console.log(id === '_common' ? '[bridge] auto-installed shared lib: _common' : `[bridge] auto-installed: ${id}`)
    for (const id of r.updated) console.log(id === '_common' ? '[bridge] auto-updated shared lib: _common' : `[bridge] auto-updated: ${id}`)
    for (const id of r.kept) console.log('[bridge] auto-install kept (user-modified):', id)
    for (const f of r.failed) console.log('[bridge] auto-install failed:', f.id, '-', f.error)
    console.log(`[bridge] auto-install scan: ${r.installed.length} installed, ${r.updated.length} updated${r.updated.length ? ' (' + r.updated.join(', ') + ')' : ''}, ${r.unchanged} unchanged, ${r.kept.length} kept, ${r.failed.length} failed`)
  } catch (e) {
    console.log('[bridge] auto-install error:', e.message)
  }
}

// ---------------------------------------------------------------------------
// First-run tools seeding（F1 对称方）：把内置 CLI 工具模板（yfw-helper 等）
// 铺到 ~/.yfworking/tools，使文档声明的 `~/.yfworking/tools/<name>/` 调用路径
// 在 portable/dev 首启即存在。幂等：仅补缺省（缺失文件才拷贝，绝不覆盖用户
// 已有工具文件），成功后写 .tools-pack.json marker（与 installer.nsh 同名，
// 安装形态已部署时直接跳过）。源仅限无安装器领地的形态——TOOLS_SAMPLE_ROOTS
// 不含 resources/runtime/tools，installed 由 installer.nsh 按勾选部署。
// ---------------------------------------------------------------------------
function autoInstallTools() {
  try {
    const src = TOOLS_SAMPLE_ROOTS.find(p => existsSync(p))
    if (!src) { console.log('[bridge] tools auto-install: source not found'); return }
    const marker = join(YFW_TOOLS_DIR, '.tools-pack.json')
    if (existsSync(marker)) return
    if (!existsSync(YFW_TOOLS_DIR)) mkdirSync(YFW_TOOLS_DIR, { recursive: true })
    let copied = 0
    const copyMissing = (from, to) => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const s = join(from, entry.name)
        const d = join(to, entry.name)
        if (entry.isDirectory()) {
          if (!existsSync(d)) mkdirSync(d, { recursive: true })
          copyMissing(s, d)
        } else if (!existsSync(d)) {
          writeFileSync(d, readFileSync(s))
          copied += 1
        }
      }
    }
    copyMissing(src, YFW_TOOLS_DIR)
    writeFileSync(marker, JSON.stringify({
      installedBy: 'bridge-autoinstall', installedAt: new Date().toISOString(),
      source: src.replace(/\\/g, '/'), copied,
    }, null, 2), 'utf-8')
    console.log(`[bridge] tools auto-install complete from ${src} (${copied} files)`)
  } catch (e) {
    console.log('[bridge] tools auto-install error:', e.message)
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

// 父进程探活（2026-09-09 孤儿桥自愈）：electron 被强杀时不触发 before-quit，
// 桥成为孤儿继续占用 51517——新实例的桥绑定失败、渲染器连上孤儿旧桥（旧内核
// 代码、旧会话态），表现为"重启后无法唤醒"。桥每 5s 探活父 PID（main.cjs spawn
// 时经 YFW_BRIDGE_PARENT_PID 注入）；父进程消失 → 杀内核会话并退出，端口立即释放。
if (process.platform === 'win32' && process.env.YFW_BRIDGE_PARENT_PID) {
  const parentPid = Number(process.env.YFW_BRIDGE_PARENT_PID)
  if (Number.isFinite(parentPid) && parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch (e) {
        if (e && e.code === 'ESRCH') {
          console.log(`[bridge] parent pid ${parentPid} gone — shutting down orphan bridge`)
          killAllSessions()
          process.exit(0)
        }
      }
    }, 5000).unref?.()
  }
}

// 兜底：任何未捕获异常/未处理的 Promise 拒绝都不应让整个后端进程退出——
// 记录日志后继续服务，由前端自动重连与主进程重启策略共同保证可用性。
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaughtException:', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] unhandledRejection:', reason)
})
