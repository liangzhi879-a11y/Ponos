#!/usr/bin/env node
// Ponos-turbo 内核入口（docs/bridge-contract.md §2 spawn 契约 + §3/§4 wire 语义）
// ---------------------------------------------------------------------------
// 净室重建的原创内核（代号 Ponos-turbo），由 bridge 经 node 运行时以 stream-json
// 模式 spawn（YFWORKING_KERNEL 逃生口候选 #1：<repo>/kernel/cli.mjs），也可直接
// node kernel/cli.mjs 运行/测试。
// 职责：
//   - 解析契约参数（--print --output-format stream-json --input-format
//     stream-json --verbose --dangerously-skip-permissions
//     --permission-prompt-tool stdio --disallowedTools AskUserQuestion
//     [--resume id] [--append-system-prompt-file f] [--model m] [--add-dir d] [--agent id]）
//   - spawn 时发出 system(init)（/test-provider 依赖，见 bridge.mjs verifyProvider）
//   - readline 逐行路由 stdin：user → engine.runTurn 轮次；control_request(cancel)
//     → engine.abort() 后 '已取消。' + result；control_response → 暂存待里程碑 4
//   - 轮次队列：turnActive 时后续 user 排队，result 后处理
//   - stdin 关闭 → exit 0（bridge 侧 kill 或 EOF 均优雅退出）

// 兼容垫片引导：必须是本文件**首个** import——旧名 → PONOS_* 主名的映射须在任何模块
// 顶层读取 env 之前完成（shared/legacy-env.mjs 是唯一映射实现）。
import './legacy-env-boot.mjs'
import { applyLegacyEnvAliases } from '../shared/legacy-env.mjs'
import { createInterface } from 'node:readline'
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createEngine } from './engine.mjs'
import { resolveConfigDir, sharedDirFor } from './config.mjs'
import { killActiveChildren, CHAT_MODE_DISALLOWED } from './tools.mjs'
import { createLogger } from './log.mjs'
import { createMcpRegistry, hookMcpExitCleanup } from './mcp-tools.mjs'
import { makeWire, wireLastWriteAt, setTurnActive, isTurnActive, isAwaitingUser, wireWriteStats } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { createHealth } from './health.mjs'
import { createCompactor, extractKeyInfo, buildSessionMemoryText } from './compact.mjs'
// loop 运行时（2026-09-14 Task 4 接线）：状态机/预算/无进展/持久化/指令族在 loop.mjs，
// 指令文本解析在 loop-commands.mjs（纯函数，零 IO）
import { createLoopController } from './loop.mjs'
import { parseLoopDirective } from './loop-commands.mjs'
import { contextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
import { resolveCompactSettings } from './compact.mjs'
import { extractConstraints } from './fidelity.mjs'
import { memoryRoot, captureMemoryCandidates, appendMemoryEntry, syncKnowledgeIndex } from './memory.mjs'
import { buildKnowledgeInjection, resolveInjectMode, resolveInjectBudget } from './knowledge-inject.mjs'
import { readDisabled, excludeDisabled } from './disabled.mjs'
import { createKnowledgeStore, resolveSessionKnowledgeScope, MAX_ASSOC_SPACES } from './knowledge.mjs'
import { createGraphStore } from './graph.mjs'
import { getProvider, setProvider, providerVersion, seedFromFile, visionFromEnv } from './provider.mjs'
import { discoverSkills, verifySkillVersions } from './skills.mjs'
import { createWorkflowEngine, discoverWorkflowsAll, matchAutoTrigger, validateWorkflow } from './workflow.mjs'
// 画布模型 ↔ YAML 序列化（UI Task 9）：workflow_command 的 save/save-raw 子命令用
// （workflow.mjs 兼容层未 re-export serializeWorkflow；直接取 DSL 实现，勿重复实现）。
import { serializeWorkflow, normalizeWorkflow, parseYaml, toModel } from './workflow-dsl.mjs'
// Task 6：工作流即工具——工作流按 expose 三态注册为具名工具（run_<slug>）注入工具池
import { buildWorkflowTools, listVisibleWorkflows, toolSourceSignature, createToolsViewCache } from './dyntools.mjs'
import { loadSettings } from './settings.mjs'
import { createHooks } from './hooks.mjs'
import { normalizeApprovalMode, deriveApprovalMode } from './approval-mode.mjs'
import { discoverAgentsMd, composeSystemPrompt } from './prompt.mjs'
import { runReadonly } from './readonly.mjs'
import { KERNEL_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'
// 应用智控：内核侧 Spec 读取（纯函数）与权限规则注入
import { loadSpec, resolveScopedApp } from './app-spec.mjs'
// K0 观测 + K1.2 缓存命中计数（默认关：关闭时只付一次布尔判断，见 kernel/perf.mjs）
import { perfCount } from './perf.mjs'
import { syncAppPermissionRules } from './app-permissions.mjs'
// 应用智控：应用即工具（绑定到本会话的应用命令 → app_* 具名工具，Task 4.x）
import { buildAppTools } from './app-tools.mjs'

const REQUIRED_FORMAT = 'stream-json'

function usage() {
  console.error(
    'Ponos-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--auto-approve-high-risk] [--approval-mode <manual|auto|loose|bypass>] [--permission-prompt-tool stdio] ' +
    '[--disallowedTools <list>] [--resume <id>] [--append-system-prompt-file <file>] ' +
    '[--model <m>] [--add-dir <dir>] [--allow-outside-dirs] [--agent <id>]'
  )
}

// 解析契约参数。未知 -- 参数容忍（真实内核接受更多参数，未知项忽略）。
export function parseArgs(argv) {
  const out = {
    print: false,
    outputFormat: null,
    inputFormat: null,
    verbose: false,
    skipPermissions: false,
    autoApproveHighRisk: false,
    approvalMode: null,
    permissionPromptTool: null,
    disallowedTools: [],
    resume: null,
    appendSystemPromptFile: null,
    model: null,
    agent: null,
    addDirs: [],
    skillsDirs: [],
    noDefaultSkills: false,
    allowOutsideDirs: false,
    agents: false,
    usage: false,
    audit: false,
    scope: null,
    sessionId: null,
    project: null,
    from: null,
    to: null,
    // 知识内核（S1）：单一聚合子命令 + 子参数（见 kernel/knowledge-cli.mjs）。仅在
    // args.knowledge 有值时被读取，对既有主链路零影响（这些 flag 名与既有 --model/
    // --scope/--to 等无冲突）。knowledge=null ⇒ 不作任何知识库 IO。
    knowledge: null,
    // 知识内核子命令的空间白名单（复数，数组形态；见 parseArgs 里 `--spaces` 的 why）
    spaces: null,
    // 会话知识范围（2026-09-15，待处理清单 P1「会话模式关联经验库之外的知识库」）：
    // 本会话**显式关联**的知识库 id 列表。与 `spaces` 分开命名是刻意的——`--spaces` 是
    // "知识子命令这一次检索的过滤条件"，本项是"这个会话的授权范围"（同时作用于注入层与
    // 工具层）。复用同名会让两种语义互相污染：一次检索的过滤条件不该变成会话的长期边界。
    // **必须显式登记**：本 CLI 对未知 `--` 参数静默忽略（见下方 default 分支），漏登记时
    // `--knowledge-spaces docs` 会被无声吞掉，表现为"关联了却没生效"（与 `--spaces`/`--confirm`
    // 同一病灶，本文件内已反复踩过）。
    knowledgeSpaces: null,
    // 应用页模式（2026-09-16，P2「应用页会话」）：本会话的**应用作用域**——非空 ⇒ 工具池里
    // 除默认工具外只含该应用的 app_* 工具（public 应用也不旁路），便于"在一个应用内专注干活"。
    // 与 binding.json 的关系：作用域**优先于**绑定（见 app-spec.isAppVisible/resolveScopedApp）。
    // **必须显式登记**：本 CLI 对未知 `--` 参数静默忽略，漏登记时 `--app-page app-a` 会被无声
    // 吞掉，表现为"开了应用页却仍是全量工具池"——与前两处（--spaces/--confirm/--knowledge-spaces）
    // 同一病灶，本文件已反复踩过。
    appPage: null,
    // 知识图谱局部图（批次 2）：以某文档为心、N 跳双向邻域
    around: null,
    hops: null,
    space: null,
    path: null,
    id: null,
    doc: null,
    related: false,
    query: null,
    keywords: [],
    topK: null,
    limit: null,
    mode: null,
    force: false,
    // 知识库删除管理（回收站）：见 parseArgs 里对应 case 的 why（漏登记即静默失效）
    trashId: null,
    confirm: null,
    // 覆盖前备份的原因（2026-09-14 批次 4，stash-doc 用；见 parseArgs 里的 why）
    reason: null,
    all: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--print': out.print = true; break
      case '--output-format': out.outputFormat = next(); break
      case '--input-format': out.inputFormat = next(); break
      case '--verbose': out.verbose = true; break
      case '--dangerously-skip-permissions': out.skipPermissions = true; break
      case '--auto-approve-high-risk': out.autoApproveHighRisk = true; break
      case '--approval-mode': out.approvalMode = next() ?? null; break
      case '--permission-prompt-tool': out.permissionPromptTool = next(); break
      case '--permission-rules-file': out.permissionRulesFile = next() ?? null; break
      case '--disallowedTools':
        out.disallowedTools.push(...String(next() ?? '').split(',').filter(Boolean)); break
      case '--resume': out.resume = next() ?? null; break
      case '--append-system-prompt-file': out.appendSystemPromptFile = next() ?? null; break
      case '--model': out.model = next() ?? null; break
      // Task 7：当前会话的 agent 身份——用于 bound 工作流可见性过滤（缺省 null →
      // 只有 public 工作流入池，bound 工作流对主会话不可见）
      case '--agent': out.agent = next() ?? null; break
      case '--add-dir': out.addDirs.push(next() ?? ''); break
      case '--skills-dir': out.skillsDirs.push(next() ?? ''); break
      // 会话模式（2026-09-12 chat 隔离）：'chat' = 纯联网会话（无技能/工作流/
      // 子 Agent/记忆/本地工具）。缺省/未知值 = 'task'（现状，零变化）；旧缓存
      // 内核不认本 flag（未知 -- 参数静默忽略）→ 退化为 bridge 侧禁工具清单。
      case '--session-mode': out.sessionMode = next() ?? null; break
      case '--no-default-skills': out.noDefaultSkills = true; break
      case '--allow-outside-dirs': out.allowOutsideDirs = true; break
      case '--agents': out.agents = true; break
      case '--usage': out.usage = true; break
      case '--audit': out.audit = true; break
      case '--scope': out.scope = next() ?? null; break
      case '--sessionId': out.sessionId = next() ?? null; break
      case '--project': out.project = next() ?? null; break
      case '--from': out.from = next() ?? null; break
      case '--to': out.to = next() ?? null; break
      // 知识内核子命令（S1）：`--knowledge <op>` + 子参数。op 取值白名单与分发在
      // kernel/knowledge-cli.mjs（此处不做校验——未知 op 由那边返回 code=1）。
      case '--knowledge': out.knowledge = next() ?? null; break
      case '--space': out.space = next() ?? null; break
      // 2026-09-14：`--spaces a,b`（复数形式，标签枚举/检索的空间白名单）。
      // **必须显式登记**：本 CLI 对未知 `--` 参数静默忽略，漏了它 `--spaces a,b` 会被无声吞掉，
      // 表现为"过滤没生效"（全库结果）——与漏登记 `--confirm` 同一类病灶。
      // 解析成**数组**（与 `--keywords` 同款），让消费侧拿到的形态唯一，不必再猜"逗号串还是数组"。
      case '--spaces': out.spaces = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      // 会话知识范围（2026-09-15）：与 `--spaces` 同款数组化（形态唯一，消费侧不必猜
      // "逗号串还是数组"）。空串/全空白 → `[]` = 没关联，交由 resolveSessionKnowledgeScope
      // 归一（那边把脏值一律当"未关联"，故这里不重复做校验分支）。
      case '--knowledge-spaces': out.knowledgeSpaces = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      // 应用页作用域（2026-09-16）：单值 id（**不是**逗号列表——作用域语义上只有一个应用，
      // 数组化只会让"多写一个 id"变成静默截断）。缺省 null = 现有行为（按 binding.json 判定）。
      case '--app-page': out.appPage = next() || null; break
      // 2026-09-14 批次 2（局部图）：`--around <docId>` 把图谱收敛到该文档的 N 跳邻域。
      // 与 `--space`/`--spaces` 同一纪律：**必须登记 + 必须转发**（转发见 knowledgeArgs），
      // 否则 `--around` 被静默吞掉、图谱照旧画全局图 —— 用户以为"局部图没生效"。
      case '--around': out.around = next() ?? null; break
      // `--hops`（局部图深度）。收成数字，非数字/缺省 → null（由消费侧回落 1）
      case '--hops': out.hops = (() => { const n = Number(next()); return Number.isFinite(n) ? n : null })(); break
      case '--path': out.path = next() ?? null; break
      case '--id': out.id = next() ?? null; break
      case '--query': out.query = next() ?? null; break
      case '--keywords': out.keywords = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      case '--topK': out.topK = Number(next()) || null; break
      case '--limit': out.limit = Number(next()) || null; break
      // S5 §7.3：`related --no-validate` —— 关掉读时校验（调试用）。必须在此显式登记：
      // 未知 `--` 参数是**静默忽略**的，漏了这个 case 时 `--no-validate` 会被无声吞掉、
      // 输出与正常路径一模一样，用户会以为"开关没作用"（而不是"参数没生效"）。
      case '--no-validate': out.noValidate = true; break
      // S5 Task 9：`related --doc <docId>`（GUI 条目卡片/Inspector 的批量口）与
      // `graph --related`（图谱关联图层）。两者同样**必须在此显式登记**：本 CLI 对未知
      // `--` 参数静默忽略，漏登记就会让"图层开了但没有任何边"看起来像数据问题。
      // 与 `--id` 分开命名（不合并成一个 flag）：blockId 与 docId 形状不同，
      // 混用会让"给了 docId 却按 blockId 查"变成静默空数组（最贵的假阴性）。
      case '--doc': out.doc = next() ?? null; break
      case '--related': out.related = true; break
      // S5.1：`graph --level entry`（图谱层级：文档/条目）。同上，未知 `--` 参数静默忽略，
      // 漏登记就会让"层级切换点了没反应"看起来像前端问题。
      // 值与 `--doc` 一样需要吃下一个 token：写成 `out.level = true` 会把 'entry' 丢给
      // positional 参数（进而被当成路径），是本 CLI 最容易写错的一处。
      case '--level': out.level = next() ?? null; break
      // S6：`append` 写通道的三个参数。与上文同一条纪律——**必须显式登记**，
      // 漏登记则 `--tag 应用智控` 会被静默丢弃（经验进了库却没有标签 → 永远成孤岛）。
      // `--text -` 表示从 stdin 读取（长文本/多行经验的常规用法，避免命令行长度与转义问题）。
      case '--tag': out.tag = next() ?? null; break
      case '--text': out.text = next() ?? null; break
      case '--theme': out.theme = next() ?? null; break
      case '--mode': out.mode = next() ?? null; break
      // ── 知识库文件导入（`--knowledge import`）的参数 ──────────────────────────
      // `--src` 是**可重复**的（多源：文件与目录可混给）—— 与其它 flag 的
      // "后值覆盖前值"语义不同，故单独做累加：首次存入，再次转为数组，之后追加。
      // 多源必须走这条可重复形式；单个来源可用 `--from`（见下方回退）。
      case '--src': {
        const v = next()
        if (v) {
          out.src = out.src === undefined || out.src === null
            ? v
            : Array.isArray(out.src) ? [...out.src, v] : [out.src, v]
        }
        break
      }
      case '--name': out.name = next() ?? null; break
      // 只预览"将处理/将跳过/将被拒"的清单，不落盘（布尔，无值）
      case '--dry-run': out.dryRun = true; break
      case '--max-ocr-pages': out.maxOcrPages = next() ?? null; break
      case '--max-files': out.maxFiles = next() ?? null; break
      case '--max-total-mb': out.maxTotalMb = next() ?? null; break
      // 流式进度（布尔）：把每个文件的处理进度以 NDJSON 逐行写到 stdout。
      // 为什么必须 opt-in：既有契约是"stdout 恰好一行 JSON"（路由侧 callJson 整段解析），
      // 无条件加行会破坏所有既有调用方。故只在显式要求时输出，
      // 此时 stdout = 若干 `{"type":"progress",…}` 行 + 末行结果（消费者按行解析）。
      case '--progress': out.progress = true; break
      // 三态：缺省 auto（配了视觉模型就用）；显式 `off` 关闭（省时间/费用）
      case '--vision-tables': out.visionTables = next() ?? null; break
      case '--max-vision-pages': out.maxVisionPages = next() ?? null; break
      // 显式强制重建索引（reindex 本身恒 force；本 flag 供其它 op 复用同一语义）
      case '--force': out.force = true; break
      // ── 知识库删除管理（回收站，2026-09-14）─────────────────────────────────
      // 同一条纪律：本 CLI 对未知 `--` 参数**静默忽略**，故这三个必须显式登记。
      // 漏登记的具体后果：`--confirm 研发资料` 被吞 → delete-space 恒报 confirm-mismatch
      // （看起来像"确认逻辑坏了"，实为参数没进内核）；`--all` 被吞 → purge 静默只删不净。
      // `--trash-id` 而非 `--id`：`--id` 已被 docId/blockId 占用，混用会让
      // "给了 trashId 却按 docId 查"变成静默空结果。
      case '--trash-id': out.trashId = next() ?? null; break
      case '--confirm': out.confirm = next() ?? null; break
      // 覆盖前备份的原因（2026-09-14 批次 4：stash-doc）。缺省会回落 'overwrite'，
      // 故漏登记的后果较轻（不报错、行为正确）—— 但仍然登记：它是"数据为何进回收站"的
      // 唯一凭据，静默丢失会让回收站条目显示成用户自己删的。
      case '--reason': out.reason = next() ?? null; break
      // 清空回收站（布尔，无值）：purge --all
      case '--all': out.all = true; break
      case '--help': case '-h': usage(); process.exit(0); break
      default:
        if (a && !a.startsWith('--')) out.positional = a
        // 未知 -- 参数：静默忽略（向后兼容）
    }
  }
  // 导入的单个来源可写作 `--from`（既有 flag，语义同为"从哪来"）。
  // 只在 import 且未给 --src 时回退 —— 不去改动 `--from` 自身的行为，
  // 避免影响其它 op 对 `--from` 的使用。
  if (out.knowledge === 'import' && !out.src) out.src = out.from || undefined
  return out
}

function readPromptFile(path) {
  if (!path || !existsSync(path)) return ''
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

// S6：读尽 stdin（`--text -` 用）。TTY 下**不阻塞**——交互式终端里误写 `--text -`
// 会看起来像挂死（用户不知道在等 Ctrl-D），故检测到 TTY 立即返回空串，
// 由 append 的"空正文"闸门给出明确报错，而不是静默等到 120s 超时。
// 编码按 utf8 解码（Node 的 setEncoding 处理跨 chunk 的多字节字符边界，
// 避免 Buffer.toString 在分块处把中文切成乱码）。
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
  })
}

// P10-A：技能/工作流发现根解析——前端（bridge）负责下载/转化/安装/注册到技能根
// （~/.ponos/skills），内核只负责发现与使用。优先显式 --skills-dir；否则 addDirs
// （含 bridge 注入的技能根）之上叠加默认根 <configDir>/skills（CLI/benchmark 直跑
// 无 addDirs 技能时内核仍可用）。--no-default-skills / PONOS_NO_DEFAULT_SKILLS=1
// 禁用默认根（benchmark 横向对比需零外部污染）。结果去重（addDirs 已含默认根时不重复）。
export function resolveSkillRoots(args, configDir, env = process.env) {
  if (args.skillsDirs?.length) return [...new Set(args.skillsDirs.filter(Boolean))]
  const roots = new Set((args.addDirs || []).filter(Boolean))
  const noDefault = args.noDefaultSkills === true || env.PONOS_NO_DEFAULT_SKILLS === '1'
  if (!noDefault) {
    const def = join(configDir, 'skills')
    if (existsSync(def)) roots.add(def)
  }
  return [...roots]
}

function extractContent(msg) {
  const c = msg?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => b?.text ?? b?.content ?? '').join('\n')
  return ''
}

export async function main(argv) {
  const args = parseArgs(argv)
  // 会话模式（2026-09-12 chat 隔离）：'chat' = 纯联网会话，任务模式的资产（技能/
  // 工作流/子 Agent/记忆/项目指令）与本地工具全部关闭，系统提示走 chat 专用版本。
  // 缺省（含旧宿主不传 --session-mode）= task ⇒ 现行为零变化。
  const chatMode = args.sessionMode === 'chat'
  if (args.outputFormat !== REQUIRED_FORMAT || args.inputFormat !== REQUIRED_FORMAT) {
    console.error(`kernel: only ${REQUIRED_FORMAT} I/O format is supported`)
    return 2
  }
  // U1/AS1 只读子命令：--usage / --audit / --agents（stdout JSON，不进 loop）。
  // 聚合实现 kernel/readonly.mjs（kernel 自读 transcript）；bridge 只薄转发。
  if (args.agents || args.usage || args.audit) {
    const mode = args.agents ? 'agents' : args.usage ? 'usage' : 'audit'
    const configDir = resolveConfigDir(process.env, homedir)
    try {
      const { output, code } = runReadonly({ mode, args, configDir })
      console.log(JSON.stringify(output))
      return code
    } catch (e) {
      console.log(JSON.stringify({ error: e?.message || String(e) }))
      return 1
    }
  }

  // S1 知识内核子命令：--knowledge <op>（stdout JSON，不进 loop）。
  // 聚合实现 kernel/knowledge-cli.mjs；bridge 通过 kernel-readonly 薄转发（Task 11）。
  if (args.knowledge) {
    const configDir = resolveConfigDir(process.env, homedir)
    // 动态 import 而非顶层静态导入：知识内核（knowledge.mjs + shared 纯函数）只在
    // `--knowledge` 路径上加载，普通会话启动不为它付模块解析成本（既有 --usage/
    // --audit 走静态导入，是因为那个模块更轻且启动即用）。
    const { runKnowledgeCommand } = await import('./knowledge-cli.mjs')
    const knowledgeArgs = {
      space: args.space, path: args.path, id: args.id, query: args.query,
      keywords: args.keywords, topK: args.topK, limit: args.limit, mode: args.mode,
      force: args.force, noValidate: args.noValidate,
      // ⚠️ `doc` / `related` 必须在此显式登记——parseArgs 解析出的字段**不会自动**流到
      // 知识内核，漏一个就等于该 flag 从未存在（**静默失效**，最贵的一类假阴性）。
      // 实测踩过：`related --doc <docId>`（GUI 文档内条目批量口）与 `graph --related`
      // （图谱关联图层）都因漏转发而拿不到值 —— 前者退化成 "missing --id" 报错，
      // 后者被静默忽略（图层开着却没有边，看起来像数据问题而不是参数问题）。
      // 单测覆盖不到这里：它们直接调 runKnowledgeCommand，绕过了本层管道；
      // 回归由 kernel-tests/knowledge-cli-flags.test.mjs 以**真进程**钉住。
      doc: args.doc, related: args.related, level: args.level,
      // S6（同一条纪律）：append 的三个入参漏登记 → `--tag 应用智控` 被静默丢弃 →
      // 经验进了库却没有标签 → 永远无关联边。故 tag/text 的转发必须有真进程回归钉住。
      tag: args.tag, text: args.text, theme: args.theme,
      // 2026-09-14（对标 Obsidian 批次 1）：`index-tags` 的空间白名单。
      // ⚠️ 又一次踩到同一个坑（真进程实测才发现）：parseArgs 里登记了 `--spaces`、knowledge-cli
      // 里也读了 `args.spaces`，但**本转发层漏了这一个键** → `--spaces a,b` 被静默吞掉，
      // 表现为"过滤没生效"（返回全库标签），而不是报错。同 doc/related/tag/trashId 的教训，
      // 回归由 kernel-tests/knowledge-cli-flags.test.mjs 以真进程钉住。
      spaces: args.spaces,
      // 2026-09-14 批次 2：局部图的两个参数（登记见 parseArgs 的 `--around`/`--hops`）。
      // 与 `spaces` 同属"漏一个就静默失效"的高危键，回归由 knowledge-parity.test.mjs 真进程钉住。
      around: args.around,
      hops: args.hops,
      // 知识库文件导入（`--knowledge import`）。
      // 这里的键名必须与 `knowledge-cli.mjs` 的 import 分支读取的键**逐字一致**
      //（它读 `args.src` / `args.maxOcrPages` / `args.visionTables` / `args.maxVisionPages`
      // / `args.name` / `args.dryRun`）—— 同一类"漏登记即静默失效"的坑：
      // 转发块少一个键，CLI 表面照常工作，只是该参数**从未生效**（如 `--dry-run`
      // 静默变成真写入）。故 `knowledge-cli-import.test.mjs` 用真进程逐项钉住。
      src: args.src, name: args.name, dryRun: args.dryRun,
      maxOcrPages: args.maxOcrPages, visionTables: args.visionTables, maxVisionPages: args.maxVisionPages,
      maxFiles: args.maxFiles, maxTotalMb: args.maxTotalMb,
      // 覆盖前备份的原因（批次 4，stash-doc 用）
      reason: args.reason,
      // 知识库删除管理（回收站，2026-09-14）：同上——漏一个键该 flag 就"从未生效"。
      // `confirm` 尤其危险：被吞掉后 `delete-space --confirm X` 恒被拒，
      // 表面是"确认逻辑有问题"，实为转发层没接线。
      trashId: args.trashId, confirm: args.confirm, all: args.all,
    }
    // S6：`--text -` = 从 stdin 读取正文。
    // 为什么需要：经验正文常含多行、引号、`|`、反引号——写在命令行里要么被 shell 改写，
    // 要么受参数长度限制；stdin 是唯一能**逐字节**送达的通道（管道 / heredoc）。
    // 只在 append 这一条写路径上读：其余 op 保持"纯参数、无隐式阻塞读"语义，
    // 否则任何一次忘记重定向的调用都会挂住直至超时。
    const stdinText = args.knowledge === 'append' && args.text === '-' ? await readStdin() : null
    // 流式进度（`--progress`）：把 onEvent 接到 stdout 的 NDJSON。
    // 用 `process.stdout.write` 而非 console.log —— 前者不做额外格式化，
    // 保证每行都是**可直接 JSON.parse 的紧凑对象**（消费方是逐行解析的）。
    // 只在 import 分支接线：其它 op 无进度语义，接了也没人调。
    const onEvent = args.knowledge === 'import' && args.progress === true
      ? (evt) => { try { process.stdout.write(JSON.stringify(evt) + '\n') } catch { /* EPIPE：消费者提前退出不该影响导入 */ } }
      : null
    const { output, code } = await runKnowledgeCommand({
      op: args.knowledge, configDir, onEvent,
      args: stdinText === null ? knowledgeArgs : { ...knowledgeArgs, text: stdinText },
    })
    console.log(JSON.stringify(output))
    // S6：失败时**同时**写一行 stderr。为什么需要（不是画蛇添足）：
    // HTTP 侧经 `kernelReadonly` 调 CLI，而它在**非零退出时 reject 并丢弃 stdout**
    //（`server/kernel-readonly.mjs` runOnce：`if (code === 0) resolve(out)` 否则
    // `reject(new Error(err.trim() || 'exit N'))`）。于是 append 的校验理由只留在被丢弃的
    // stdout 里，路由只能回一个无信息量的 500 —— 调用方看不到"为什么被拒"。
    // stdout 的 JSON 契约保持不动（Bash/agent 侧仍读它 + 退出码）；stderr 只作补充通道。
    if (code !== 0 && output && typeof output === 'object' && output.error) {
      console.error(`[knowledge] ${output.error}${output.message ? ': ' + output.message : ''}`)
    }
    return code
  }

  const wire = makeWire()
  // 会话身份：--resume 恢复既有会话，否则新建（session_id 供 GUI 从 init 事件
  // 记录 conversation.sessionId，transcript 文件名 = 该 id，契约 §7/§8）
  const sessionId = args.resume || newSessionId()
  // S5-1 配置目录解析纯函数（PONOS_CONFIG_DIR > PONOS_HOME > ~/.ponos）
  const configDir = resolveConfigDir(process.env, homedir)
  // P10-A：技能/工作流发现根——前端（bridge）负责安装注册到技能根，内核只发现使用。
  // 显式 --skills-dir 优先；否则 addDirs（含 bridge 注入技能根）叠加默认根 <configDir>/skills，
  // CLI/benchmark 直跑无 addDirs 技能时内核仍可用（--no-default-skills 可禁用）。
  // chat 模式：技能根为空 ⇒ 不发现技能、不进提示词清单（Skill 工具亦被禁用）。
  const skillRoots = chatMode ? [] : resolveSkillRoots(args, configDir, process.env)
  // 平铺 <id>.md 只在"技能集合根"生效（2026-09-12 P2-1）：用户显式 --skills-dir 指定的根，
  // 以及内核自己的 <configDir>/skills；项目目录/addDirs 根必须用 <id>/SKILL.md 目录形式。
  // 实证病灶：cwd 根把仓库的 BUILD.md（无 frontmatter 的纯文档）当技能灌进提示词。
  // 同一白名单下传工具层（Skill 工具回执/SkillSearch 必须与提示词清单同口径）。
  const flatSkillRoots = new Set([...(args.skillsDirs || []), join(configDir, 'skills')].filter(Boolean))
  // S5-1 共享目录只读挂载：shared 存在时追加进 addDirs（tools withinBoundary 按
  // 白名单 dir 放行；共享技能/配置多人共用，个人 configDir 保持隔离）
  const sharedDir = sharedDirFor(configDir)
  if (!chatMode && existsSync(sharedDir)) args.addDirs.push(sharedDir)
  const store = createSessionStore({ configDir, cwd: args.addDirs[0] || '', sessionId })
  // P4-1：bridge 落盘的 providers.json → 注册表播种（未激活时生效；激活后固定）
  seedFromFile(join(configDir, 'providers.json'))
  // P4-3 分层 settings：user（configDir/settings.json）< project（cwd/.ponos/settings.json）< local。
  // settings.env 仅兜底（spawn env 快照仍权威）：缺失键才写入 process.env。
  const settings = loadSettings({ configDir, cwd: args.addDirs[0] || '', local: {} })
  for (const [k, v] of Object.entries(settings.merged.env || {})) {
    if (v !== undefined && process.env[k] === undefined) process.env[k] = String(v)
  }
  // 兼容垫片：settings.json 里可能仍是历史版本的旧名（Anthropic 兼容协议时代沿用），
  // 在此统一映射到 PONOS_* 主名，保证配置来源与进程 env 两条路径口径一致。
  applyLegacyEnvAliases()
  // 内核结构化日志（R5-1）：stderr JSON 行，级别过滤经 PONOS_LOG_LEVEL
  const log = createLogger({ level: process.env.PONOS_LOG_LEVEL || 'info', sid: sessionId })

  // 会话知识范围（2026-09-15，P1「会话模式关联经验库之外的知识库」，spec §3.2）。
  //
  // 组成 = 内置经验类空间 ∪ `--knowledge-spaces` 显式关联。**一处解析、两处消费**：
  //   ① 注入层（下方 buildKnowledgeInjection 的 spaces）；
  //   ② 工具层（createEngine opts.knowledgeSpaces → createToolRegistry）。
  // 双层同源是硬要求而非实现便利：注入（被动通道）与工具（主动通道）口径不一致时，模型会
  // 看到"注入里没有这条、检索却说自己没权限"的自相矛盾，比单纯少个能力更难排查。
  //
  // 放在 log 之后 / createEngine 之前：工具层白名单在引擎构造时就要值。纯目录发现、无 IO 写盘。
  const knowledgeScope = resolveSessionKnowledgeScope({ configDir, requested: args.knowledgeSpaces })
  if (knowledgeScope.missing.length) log.warn('knowledge scope: 关联的库不存在（已忽略）', { missing: knowledgeScope.missing })
  if (knowledgeScope.truncated) log.warn('knowledge scope: 关联数量超上限（已截断）', { max: MAX_ASSOC_SPACES, dropped: knowledgeScope.dropped })

  // 全局停用注册表（2026-09-15，P1「agent和skill页面及功能需要大改」D 条款）：<configDir>/disabled.json。
  // **一次读、多处用**（技能清单 + Skill 工具池）。读失败只 warn 不阻断：这个文件的作用是收窄
  // 能力，"读失败就崩"会让内核根本起不来，代价远大于"停用没生效"（见 kernel/disabled.mjs 头注）。
  // agent 侧的停用由 `resolveAgents` 内部自读（那边有多个调用点，靠传参迟早漏一个）。
  const disabledReg = readDisabled({ configDir })
  if (!disabledReg.ok) log.warn('disabled 注册表读取失败，本次按"未停用任何项"处理', { file: 'disabled.json' })
  if (disabledReg.skills.length) log.info('已停用技能', { skills: disabledReg.skills })

  // R2-1/R3-1：运行 marker（<configDir>/runs/<sid>.running，{pid,ts} JSON）。
  // 启动时存在 → 上次非优雅退出（崩溃）→ 发 crash_recovered 事件提示恢复；
  // 正常流程随后重写 marker 接管。SIGINT/TERM 优雅退出时删除。
  const runDir = join(configDir, 'runs')
  const marker = join(runDir, sessionId + '.running')
  try {
    if (existsSync(marker)) {
      const prev = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
      // E1 崩溃原因捕获（2026-09-09 事故修复）：旧日志只有 pid/ts，崩溃根因不可见。
      // 上次进程退出时把 uncaughtException 原文与退出码落进 marker(.err)，本次
      // resume 读回并写入结构化日志——下次崩溃当场可定位，不再靠猜。
      let lastErr = null
      const errFile = marker + '.err'
      try { if (existsSync(errFile)) { lastErr = readFileSync(errFile, 'utf-8').slice(0, 4000); rmSync(errFile, { force: true }) } } catch {}
      // 字段名用 prevTs 而非 ts：logger 的核心字段 ts 是本次日志时间，同名会被覆盖，
      // 上次崩溃时刻就丢了（两者都要留——排障要对比"上次何时崩、这次何时发现"）。
      log.warn('previous run crashed', { pid: prev.pid, prevTs: prev.ts, exitCode: prev.exitCode ?? null, err: lastErr })
      wire.system('crash_recovered', { sessionId })
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf-8')
    // 崩溃自描述：未捕获异常原文 + 退出码落盘（供下次 resume 读回日志）。
    // 优雅退出（shutdown）先删 marker 再 exit，exit 钩子里 marker 已不存在 → 不写。
    process.on('uncaughtException', (e) => {
      try {
        writeFileSync(marker + '.err', JSON.stringify({ message: String(e?.message || e), stack: String(e?.stack || '').slice(0, 4000), ts: new Date().toISOString() }), 'utf-8')
      } catch {}
    })
    // stdout/stderr 管道断裂兜底（2026-09-12 EPIPE 事故）：bridge 侧关闭管道后，
    // 流上的异步 'error' 事件无监听者会以未处理异常杀死进程（writeLine 的 try/catch
    // 只覆盖同步写异常）。EPIPE = 上游已离开、输出无意义 → 优雅退出（exit 钩子把
    // exitCode 写进 marker；bridge 的 close 事件广播 closed，GUI 收口解锁）。
    process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0) })
    process.stderr.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0) })
    // 进程级硬看门狗（2026-09-12 异步链失活事故）：请求层空闲看门狗随迭代创建/
    // 清理——请求异常终止（fetch 套接字消失、定时器清零、续体永不被调度）时，
    // 内核会"活着但永远空等"（inspector 实证：仅剩 stdio 三句柄、零定时器）。
    // 本看门狗独立于请求生命周期：wire 无输出超过阈值即硬退出（bridge 收 close
    // → 广播 closed → GUI 解锁），把不可观测的永久挂起变成可恢复的可见失败。
    // 默认 15 分钟（2026-09-12 调整）：必须严格大于"自适应首字节上限 600s"
    // （engine.mjs 大请求恒取 600s）加一个自愈周期——旧默认同为 600s，大请求健康
    // 慢 prefill 恰好在同一秒与看门狗撞车，谁先到看 tick 相位（见下）。600s→
    // 900s 的分离让"健康慢"与"真失活"不再共用一个数。
    // 不设下限钳制——env 显式值权威（测试用小值），与其它守卫 env 语义一致。
    const hardTimeoutMs = Math.max(1, Number(process.env.PONOS_KERNEL_HARD_TIMEOUT_MS) || 900_000)
    // 等待用户期间的展期窗口（2026-09-12）：审批/提问挂起时内核本来就零 wire 输出，
    // 等的是人。旧行为下用户思考超过 hardTimeoutMs 就被 exit(7) 杀掉，而且自杀前
    // **不写 result/error 帧**——桥只看到 close，用户的作答落空（GUI 甚至还在等弹窗回执）。
    // 展期而非"暂停判定"：GUI 永不回执时窗口也有界（超出审批上限后照杀）。
    const approvalGraceMs = Math.max(0, Number(process.env.PONOS_APPROVAL_TIMEOUT_MS) || 600_000)
    // 提问挂起用的是同一个 isAwaitingUser 标志（engine.waitForAnswer）：展期窗口取
    // 审批与提问两者的较大值，否则把 PONOS_ASK_USER_TIMEOUT_MS 调大于审批窗口时，
    // 提问等待会被看门狗在展期用尽后误杀。
    const askGraceMs = Math.max(0, Number(process.env.PONOS_ASK_USER_TIMEOUT_MS) || 0)
    const userGraceMs = Math.max(approvalGraceMs, askGraceMs)
    const hardTimer = setInterval(() => {
      const idle = Date.now() - wireLastWriteAt()
      const awaiting = isAwaitingUser()
      const limit = hardTimeoutMs + (awaiting ? userGraceMs : 0)
      if (isTurnActive() && idle > limit) {
        try {
          // 现场指纹（2026-09-12 异步链失活排查）：失活形态无 JS 栈可抓，句柄清单是
          // 唯一现场证据——"stdio-only + 零定时器"即失活签名；下次复发无需外部
          // inspector attach，marker.err 自带指纹。另记 wire 写失败计数：写失败=stdout
          // 实际已断，"静默时长"不再可信（那种情形该由桥侧 close 处理）。
          let fingerprint = {}
          try {
            const hs = (process._getActiveHandles() || []).map((h) => h?.constructor?.name || '?')
            fingerprint = { handles: hs.reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), {}), idleMs: idle, awaitingUser: awaiting, wireWrite: wireWriteStats() }
          } catch {}
          writeFileSync(marker + '.err', JSON.stringify({ message: `硬看门狗：wire 无输出 ${Math.round(idle / 1000)}s（>${Math.round(limit / 1000)}s${awaiting ? '，含等待用户展期' : ''}），疑似异步链失活`, stack: '(hard-watchdog, no JS stack)', fingerprint, ts: new Date().toISOString() }), 'utf-8')
        } catch {}
        process.exit(7)
      }
    }, Math.min(30_000, hardTimeoutMs))
    if (hardTimer.unref) hardTimer.unref()
    process.on('exit', (code) => {
      try {
        if (!existsSync(marker)) return
        const cur = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
        writeFileSync(marker, JSON.stringify({ ...cur, exitCode: code }), 'utf-8')
      } catch {}
    })
  } catch { /* marker 不可写不致命 */ }
  // 统一退出：杀活跃子进程 → 清 marker → 退出
  function shutdown(code) {
    try { killActiveChildren() } catch {}
    try { if (wfSchedulerStop) wfSchedulerStop() } catch {}
    try { if (wfHttpServer) wfHttpServer.close() } catch {}
    try { rmSync(marker, { force: true }) } catch {}
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  // 生产链路一次接齐：context（token 启发式）+ health（健康监控）+ compactor（两阶段压缩）。
  // compactor 装配 health → 压缩成功后 ponos_summary 走 health.recordCompaction 单通道
  // （代发 + 记录 lastSummary），不再由 compactor 直接 wire.summary（FIX R1，杜绝双发）。
  // compactor 的 signal 传 undefined——cancel 不中断进行中的压缩摘要调用为已知限制
  // （deferred minor，勿改）。
  // S3-1 权限规则文件：--permission-rules-file → JSON { permissions: { allow, deny, ask } }
  let permissionRules = {}
  if (args.permissionRulesFile) {
    if (!existsSync(args.permissionRulesFile)) log.warn('permission rules 文件不存在', new Error(args.permissionRulesFile))
    else {
      try { permissionRules = JSON.parse(readFileSync(args.permissionRulesFile, 'utf-8')).permissions || {} } catch (e) { log.warn('permission rules 解析失败', e) }
    }
  }
  // P4-5：model 热切换后可变（init/回执用最新值；未激活时 getProvider 现读 env）
  // P4-3：settings.merged.model 三级兜底（args > env > settings）
  let model = args.model || getProvider().model || settings.merged.model || ''
  const maxTokens = Math.max(1, Number(process.env.PONOS_MAX_OUTPUT_TOKENS || settings.merged.maxOutputTokens || 64000))
  const contextWindow = contextWindowFor(model)
  // L2-1：settings.compact 预算配置化——threshold/reserve ratio + 工具结果预算。
  // 仅当 settings 显式配置 maxToolResults 且 env 未设置时才兜底填 env（不覆盖 spawn env）。
  const compactCfg = resolveCompactSettings({ window: contextWindow, settings: settings.merged, env: process.env })
  const maxToolResults = Number(settings.merged.compact?.maxToolResults)
  if (Number.isFinite(maxToolResults) && maxToolResults > 0 && !process.env.PONOS_TOOL_RESULT_BUDGET_BYTES) {
    process.env.PONOS_TOOL_RESULT_BUDGET_BYTES = String(maxToolResults)
  }
  const context = {
    window: contextWindow,
    thresholdRatio: compactCfg.thresholdRatio,
    retainRatio: compactCfg.retainRatio,
    maxMessages: compactCfg.maxMessages,
    estimate: ({ system, messages }) => estimateRequest({ system, messages }),
    estimateMessage,
    estimateHistory,
  }
  // 失真轴锚点源（2026-09-12 spec §5.1）：重新锚定所需的权威事实必须**确定性拼接**，
  // 不做额外模型调用——首条真实 user 任务（目标真值）+ 会话工作记忆（任务清单/文件
  // 变更/最近决策）+ 记忆里的硬约束。读取失败一律静默（锚点缺失不影响健康主流程）。
  const anchorMemoryPath = join(configDir, 'memory', 'session', sessionId + '.md')
  const getAnchorSource = () => {
    let task = ''
    try {
      const first = store.deriveMessages().find((m) => m?.role === 'user' &&
        !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result')))
      if (typeof first?.content === 'string') task = first.content.slice(0, 1000)
    } catch { /* 静默 */ }
    let memoryText = ''
    try { memoryText = readFileSync(anchorMemoryPath, 'utf-8').slice(0, 4000) } catch { /* 无记忆文件 */ }
    return { task, memoryText, constraints: extractConstraints(memoryText) }
  }
  const health = createHealth({ wire, model, contextWindow, env: process.env, getAnchorSource })
  // P9-3：会话工作记忆文件路径（<configDir>/memory/session/<sessionId>.md）。
  // 轮末写入关键状态，压缩时 compactor 读文件注入摘要请求（可选能力，读失败静默降级）
  const sessionMemoryPath = join(configDir, 'memory', 'session', sessionId + '.md')
  const compactor = createCompactor({ session: store, context, model, maxTokens, wire, health, signal: undefined, env: process.env, sessionMemoryPath, onCompactionAudit: (a) => { try { health.recordCompactionAudit?.(a) } catch { /* 静默 */ } } })

  // P4-2 hooks：settings.hooks 规则装配（无规则 = count 0，run 恒 matched=false）
  const hooks = createHooks({ rules: settings.merged.hooks || [] })

  // workflow 引擎：与 skill 平权（同一发现/触发机制）。先创建实例（configDir 已知），
  // engine 创建后注入 registry/事件/模型/根目录（setDeps）。
  const wfEngine = createWorkflowEngine({ configDir })
  // 工作流发现根：技能根（与技能平权，同一发现机制）+ 独立工作流根 <configDir>/workflows
  // （与 bridge 侧 ~/.yfworking/workflows 安装目录对应；Task 8 把市场工作流装到这里）。
  // chat 模式：工作流根为空 ⇒ 无工作流发现，亦无 run_<slug> 动态工具（见下）。
  const workflowRoots = chatMode ? [] : [...skillRoots, join(configDir, 'workflows')]
  // 应用智控数据根：<configDir>/apps（与 electron/app-registry.cjs 的 roots 对应）。
  // chat 模式与工作流同处理：根为空 ⇒ 不注入应用规则。
  const appRoots = chatMode ? [] : [join(configDir, 'apps')]
  // 应用页作用域（2026-09-16）：本会话只接这一个应用的工具。两点刻意：
  //   · 它是**过滤器**，不改 appRoots——数据根仍指 <configDir>/apps，作用域只在可见性判定
  //     里收窄。若改根，binding.json/spec 的读取路径会一起变（权限规则注入与工具池会不同源）；
  //   · chat 模式恒 null（与 appRoots=[] 同源）：chat 会话不接应用工具，作用域无从谈起。
  const appPageId = chatMode ? null : (args.appPage || null)
  // 作用域里应用不存在（被删/改名/spec 缺失）必须出声：此时 isAppVisible 恒 false ⇒ 工具池里
  // 一个 app_* 都没有，用户侧只看到"模型说没有这个工具"，没有任何线索可查。
  if (appPageId && !loadSpec({ roots: appRoots, appId: appPageId })) {
    log.warn(`apps: --app-page ${appPageId} 未找到对应应用（spec 缺失或已删除）—— 本会话将没有任何应用工具`)
  }
  // I-2：public 工作流入池上限——settings.workflow.publicLimit（设置项不存在/非法 → 缺省 20，
  // 与 dyntools 内 LIMIT_DEFAULT 一致；不为此扩设置系统）。
  const wfPublicLimitN = Number(settings.merged.workflow?.publicLimit)
  const wfPublicLimit = Number.isFinite(wfPublicLimitN) && wfPublicLimitN > 0 ? Math.floor(wfPublicLimitN) : 20
  // P3 webhook 服务 / cron 调度器句柄（幂等启动，shutdown 清理）
  let wfHttpServer = null
  let wfSchedulerStop = null
  // workflow 命令执行中标志：stdin EOF 时等待其完成（真实 API llm 调用耗时秒级）
  let wfBusy = 0

  // AS2（2026-09-12）：技能 id 表有两个下游消费点，均在引擎启动后才求值——
  //   ① 子 lane 提示词补技能目录（engine 的 spawnSubAgent，lane 此前无清单只能猜 id）；
  //   ② agent 引用未知技能的诊断（engine 的 warnUnknownAgentRefs，此前 opts.skillIds
  //      恒缺省 ⇒ 该诊断永不触发，悬空技能引用静默通过）。
  // 故先声明同一数组引用、由下方发现循环就地填充（引用共享，无需重建引擎）。
  const skills = []
  const skillIds = []
  const engine = createEngine({
    opts: {
      model: args.model,
      configDir,
      addDirs: args.addDirs,
      skillsDirs: skillRoots,
      skillIds,
      // Skill 工具/SkillSearch 与提示词技能块同口径的平铺根白名单（P2-1）
      flatSkillRoots: [...flatSkillRoots],
      systemPrompt: '', // 占位，下面三层组装后覆盖
      verbose: args.verbose,
      skipPermissions: args.skipPermissions,
      autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true,
      // 审批档位优先级：显式 --approval-mode > 内核 settings.json > 旧 flag 派生。
      // 放在 settings 之上是刻意的——settings.json 里残留的 autoApproveHighRisk:true
      // 不得把用户选定的 manual/auto 档悄悄放宽（engine 侧缺省才回落派生）。
      approvalMode: normalizeApprovalMode(args.approvalMode || settings.merged.approvalMode
        || deriveApprovalMode({ skipPermissions: args.skipPermissions, autoApproveHighRisk: args.autoApproveHighRisk === true || settings.merged.autoApproveHighRisk === true })),
      disallowedTools: [
        ...args.disallowedTools,
        // chat 隔离（2026-09-12）：禁本地工具表由内核自行套用（宿主漏传也不泄能力）；
        // 宿主 bridge 另有一份同源拷贝，只为兼容不认 --session-mode 的旧缓存内核。
        ...(chatMode ? CHAT_MODE_DISALLOWED : []),
        ...(settings.merged.disallowedTools || []),
      ],
      permissionRules,
      hooks,
      // workflow 引擎实例：engine 内部 createToolRegistry 时注入（Workflow 工具）。
      // chat 模式传 null ⇒ 该工具根本不在注册表里（双保险：CHAT_MODE_DISALLOWED
      // 已含 Workflow，即便漏配此处也不会把工作流暴露给纯聊会话）。
      workflow: chatMode ? null : wfEngine,
      // MS1：MemorySearch 个人经验根（<configDir>/memory/personal，memoryRoot(configDir)）。
      // projectMemoryRoot 当前无项目记忆写入方，cli 不传 —— tools 侧 null → project scope 0 命中。
      memoryRoot: memoryRoot(configDir),
      // 会话知识范围（2026-09-15，P1）：工具层白名单（KnowledgeSearch / MemorySearch 据此收窄）。
      // 传**数组**（恒非空：至少含内置经验类空间）= 收窄；`null` 只留给嵌入/测试场景
      // （那类调用方没有"会话"概念，收窄会把它们的既有行为打断——见 createToolRegistry 的 why）。
      knowledgeSpaces: knowledgeScope.spaces,
      // 全局停用技能（2026-09-15，D 条款）：工具层按名调用时的拒绝判定 + "技能不存在"提示里
      // 可用清单的口径。与上面提示词技能清单**同源**（都来自 disabledReg.skills）。
      disabledSkills: disabledReg.skills,
      // P2-1③：主会话 context（estimate 闭包）透传——lane 压缩器阈值判定复用
      context,
    },
    wire,
    session: store,
    health,
    compactor,
  })
  // Task 6：动态工具注入——工作流按 expose 三态成为具名工具（run_<slug>），随磁盘增删即时
  // 生效（视图函数每次求值）。engine.mjs 的 createToolRegistry 调用点不转发 dynamicTools，
  // 故此处经 registry 的 setDynamicTools 挂钩注入（与构造参数等价，后设覆盖先设）；agentId
  // 取 --agent（主会话缺省 null → bound 工作流对主会话不可见，仅 public 入池）。
  // chat 模式跳过（2026-09-12 隔离）：实证病灶 = chat 会话的工具表里赫然出现 run_spec_dev，
  // 模型据此认为自己能跑工作流并答"Skill 工具在此不可用"，能力声明与实际工具集自相矛盾。
  if (!chatMode) {
    // K1.2 工具视图缓存（签名语义/残留风险见 kernel/dyntools.mjs 的 toolSourceSignature 头注）：
    //   · 缓存**只包工具表构造**（132ms/步 → 命中 ~0.4ms/步）；
    //   · 键 = 盘面签名（各根名字列表 + 已知工作流文件 + 应用 registry/binding/spec）；
    //   · 容量上限 ≤8 + LRU——教训：无上限会话级 Map 曾涨到 300MB+；
    //   · 签名不可判定（stat 异常）或构造抛错 ⇒ 不缓存，退化为原「每次求值」行为；
    //   · `PONOS_DYNTOOLS_CACHE=0` 一键回退。**必须惰性读**：cli.mjs 的 settings.env 注入
    //     发生在所有 ESM 模块求值之后，写成模块级常量必然读不到。
    const viewCache = createToolsViewCache({ max: 8 })   // 容量上限 + LRU（见 dyntools 头注）
    let viewSources = []                 // 上一轮发现实际读过的文件（签名的文件级输入）
    // P1-5 MCP 客户端：外部工具接入。**必须放在签名缓存之外合并**——MCP 服务器的就绪
    // 状态变化不改变盘面签名，若把它的工具混进缓存值，首次"尚未就绪返回空"会被缓存住、
    // 之后永久看不到 MCP 工具。故缓存只存「本进程工具」（工作流/应用智控），MCP 每次实时合并。
    // 未配置 ~/.yfworking/mcp.json 时 view() 恒返回 {} ⇒ 既有行为逐字不变。
    const mcpRegistry = createMcpRegistry({
      log: (level, msg) => { try { if (level === 'warn' || level === 'error') log.warn(msg); else log.info?.(msg) } catch { /* 日志失败不影响工具 */ } },
    })
    hookMcpExitCleanup(mcpRegistry)      // 内核退出时回收 MCP 子进程，避免孤儿
    // 就绪后把**真实接入状态**上报给桥，供 MCP 面板显示。
    // 为什么需要它：面板上的"连接测试"是面板自己发起的探测，只能证明"这台此刻连得上"，
    // 不能证明"内核已接入"——两者被混为一谈，用户就会觉得"添加成功了却找不到调用入口"。
    // **绝不 await 在启动路径上**：MCP 服务器不可达时要等数秒，绝不能拖慢内核启动或 init。
    mcpRegistry.ready()
      .then(() => { try { wire.system('mcp_status', mcpRegistry.snapshot()) } catch { /* 上报失败不影响内核 */ } })
      .catch(() => { /* 启动异常已在 registry 内部记日志 */ })
    // MCP 工具合并器：命名带 `mcp__` 前缀，不会与内置/工作流/应用工具重名；
    // 万一重名以本进程工具为准（不劫持既有工具），故 MCP 置于右侧作补充。
    // 就绪前 view() 返回 {} ⇒ 返回原对象引用（不产生多余对象，签名缓存语义不受影响）。
    // **agentId 必须用 args.agent**（与下面 buildWorkflowTools 同一个来源）——
    // 两处用不同来源就会出现"工作流按 agent 过滤、MCP 不按"的分裂，
    // 而那种 bug 只在"某 agent 该看不到某工具却看到了"时才暴露，极难发现。
    const withMcp = (v) => {
      const mcp = mcpRegistry.view({ agentId: args.agent || null })
      return Object.keys(mcp).length ? { ...v, ...mcp } : v
    }
    engine.tools.setDynamicTools(() => {
      // 应用智控：按「当前会话绑定的应用」注入 read/write 权限规则（安全双保险的主机制）。
      // 与工具注入同处一个视图函数（每次求值），故「进入控制台 → 绑定 → 规则生效」
      // 「离开 → 回收旧规则」都无需重启内核、无需跨进程消息。
      // 规则注入失败不得中断本轮 turn（与 dynamicTools 求值失败的容错策略一致）。
      // 详见 kernel/app-permissions.mjs。
      // **K1.2 硬约束：本段有副作用（改 rules.allow/ask），是"进/离控制台即生效"的主机制，
      // 故必须在缓存判定之前、每次求值都跑——绝不进缓存，也不受签名命中影响。**
      try {
        // 口径与工具池**同源**（resolveScopedApp）：作用域（--app-page）优先于 binding.json。
        // 两处若各写一份判定，就会出现「工具池给 A、规则按 B 注入」的分裂——症状是
        // read 被拒 / write 不弹窗，而两边代码各自看都对（见 app-spec.resolveScopedApp）。
        const { spec: scopedSpec } = resolveScopedApp({ roots: appRoots, sessionId, scopeAppId: appPageId })
        syncAppPermissionRules({ rules: permissionRules, spec: scopedSpec })
      } catch (err) {
        log.warn('apps: 权限规则注入失败（本轮继续）', err)
      }
      const sig = process.env.PONOS_DYNTOOLS_CACHE === '0'
        ? null
        : toolSourceSignature({ workflowRoots, workflowFiles: viewSources, appRoots })
      const hit = viewCache.get(sig)     // sig=null（关缓存/不可判定）时恒 null
      if (hit) {
        perfCount('dynHit')
        return withMcp(hit)              // P1-5：缓存只存本进程工具，MCP 每次实时合并
      }
      const wfTools = buildWorkflowTools({ roots: workflowRoots, engine: wfEngine, agentId: args.agent || null, publicLimit: wfPublicLimit })
      viewSources = wfTools.sourcePaths || []   // 展开前取（非枚举属性不进 `{...}`）
      const view = {
        ...wfTools,
        // 应用智控（Task 4.x）：绑定到本会话的应用命令 → app_* 工具。
        //   · 可见性/截断全在 app-tools.mjs（console 仅本会话绑定可见，public 恒可见，
        //     private 永不可见）——与上面注入的权限规则同一时点求值，故「进入/离开控制台」
        //     即时反映到工具池；
        //   · runner 走 engine.runApp：内核只发起 bridge_request(route=app)，
        //     真正的执行在 Electron 主进程（electron/app-ipc.cjs 的 app:run 逻辑），
        //     回执经 stdin app_response → engine.resolveApp；
        //   · 未绑定/未注入 runner 时不会静默成功（app-tools 侧对缺 runner 明确报错）；
        //   · scopeAppId = --app-page（应用页模式）：非空 ⇒ 只注册该应用的工具（public 不旁路）。
        //     **作用域是进程启动段冻结的**（bridge 侧变更即重 spawn，见 appPageChanged），
        //     故它不进 toolSourceSignature —— 同一进程内它恒为同一个值，缓存不会串味。
        ...buildAppTools({
          roots: appRoots,
          agentId: args.agent || null,
          sessionId,
          scopeAppId: appPageId,
          runner: (p) => engine.runApp(p),
        }),
      }
      viewCache.set(sig, view)           // 超上限由容器按 LRU 自行淘汰（只存本进程工具）
      return withMcp(view)               // P1-5：MCP 工具实时合并，不进缓存
    })
  }
  // J1：health Judge 注入位——包装 engine.judgeUntil 作健康判定（目标 = 当前会话
  // 健康状态判定：是否建议重置/继续/压缩后继续）。默认关（PONOS_LLM_JUDGE /
  // PONOS_LLM_JUDGE），开时仅红档 + 冷却 300s 触发；异常由 health 侧静默。
  try {
    health.runJudge = async () => {
      const j = await engine.judgeUntil({
        target: '判定当前会话健康状态：是否建议重置会话 / 继续当前会话 / 压缩上下文后继续',
        maxTokens: 512,
      })
      return { done: j?.done === true, reason: j?.reason || j?.raw || '' }
    }
  } catch { /* 注入失败不阻断启动（judge 可选能力） */ }
  // workflow 引擎依赖注入：registry（tool/document 节点）、事件（wire 转发）、
  // 模型（provider 热切换同源）、根目录（addDirs 技能/工作流同域）
  wfEngine.setDeps({
    configDir,
    registry: engine.tools,
    onEvent: (ev) => { try { wire.system('workflow', ev) } catch { /* 事件失败不阻断 */ } },
    getModel: () => getProvider().model || model || process.env.PONOS_MODEL || '',
    memoryRoot: memoryRoot(configDir),
    // M3：bound 可见性判定用（与 dyntools 工具池同源，同为 --agent）
    agentId: args.agent || null,
  })
  for (const dir of workflowRoots) wfEngine.addRoot(dir)
  // P4-4：技能发现内核化——每个技能根扫描（技能根目录命中 SKILL.md；项目目录为空集）。
  // P10-A：roots = skillRoots（显式 --skills-dir > addDirs 叠加默认 <configDir>/skills）
  const seenSkillIds = new Set()
  for (const dir of skillRoots) {
    // 全局停用过滤（2026-09-15，D 条款）：这一处同时决定**提示词技能清单**与 `skillIds`
    // （工具池可见性口径），故过滤在这里一次到位——两处各自过滤必然漂移出
    // "提示词里没了、工具还能按名调用"的半生效状态。
    for (const s of excludeDisabled(discoverSkills({ root: dir, allowFlat: flatSkillRoots.has(dir) }), disabledReg.skills)) {
      if (!seenSkillIds.has(s.id)) { seenSkillIds.add(s.id); skills.push(s); skillIds.push(s.id) }
    }
  }
  // SV1 技能版本守卫：<configDir>/skills.lock.json 存在时校验当前技能表 id/version。
  // outdated 非空 → wire.warning(level:'skill_version')，不阻断启动（lock 当前无写入
  // 者，文件不存在即零激活——天然零回归）。
  try {
    const lockPath = join(configDir, 'skills.lock.json')
    if (existsSync(lockPath)) {
      const { outdated } = verifySkillVersions({ lockPath, skills })
      if (outdated.length) wire.warning?.({ level: 'skill_version', outdated })
    }
  } catch { /* 版本校验失败不阻断启动 */ }
  // workflow 与 skill 平权：同一技能根发现（workflow.yml / .yml），
  // 共享 triggers 触发词；发现结果入【可用工作流】独立区块（严格输出定位）
  const workflows = discoverWorkflowsAll({ roots: workflowRoots })
  // I-3：提示词【可用工作流】清单改用与工具池同一可见性口径（private / bound 未命中 /
  // 超限 public / legacy 不注入名字与描述）。注意 workflows（未过滤）仍供 auto_trigger
  // 与 init 计数使用 —— 可见性与自动触发是两件事，本处只收窄注入面。
  const visibleWorkflows = listVisibleWorkflows({ roots: workflowRoots, agentId: args.agent || null, publicLimit: wfPublicLimit })
  // L3-2：记忆注入（与 GUI 经验面板同一数据源；settings.memory.inject=false 逃生阀）。
  // S3 双策略（D1 灰度，缺省 legacy = 既有行为）：
  //   legacy  —— graph.search 按当前任务上下文关键词从神经图谱抽调经验全文 + buildMemoryIndex
  //              给全量索引指针（模型按需 Read）。**逐字节等于改动前**（灰度开关可信的前提）。
  //   unified —— kernel/knowledge-inject.mjs：一次 store.load() 喂两层，索引层沿用同一
  //              buildMemoryIndex（零格式变化），抽调层换成块级结果（粒度自适应，D3）。
  // 任务关键词 = cwd/addDirs 目录名 + 显式任务标签（settings.memory.taskTag / env
  // PONOS_MEMORY_KEYWORDS，逗号分隔可追加）。PONOS_MEMORY_INJECT=index-only 时仅索引（旧行为）。
  const memoryRootDir = memoryRoot(configDir)
  let memoryBlock = ''
  const injectOpts = {
    mode: resolveInjectMode({ settings: settings.merged }),
    budget: resolveInjectBudget({ settings: settings.merged }),
  }
  // 图谱句柄提到注入段之外：轮末沉淀（下方 finally）要用它同步图谱索引。原来它声明在
  // `if (!chatMode)` 块内，而沉淀段在该块之外 —— 跨块引用会抛 `graph is not defined`，
  // 又被沉淀段的 catch 静默吞掉，导致**启发式捕获从未落盘**（实测报告见 S3 报告"自审发现"）。
  let graphStore = null
  // 知识索引句柄（S3 §5 写入闭环）：**惰性**创建——legacy 注入不碰它，只在
  // ① unified 注入要检索、② 轮末沉淀要增量更新 时才 load 一次，避免给"从不沉淀"的
  // 会话白付一次全库加载。`tried` 标记保证 load 抛错后不再反复重试。
  let knowledgeIndex = null
  let knowledgeIndexTried = false
  const ensureKnowledgeIndex = () => {
    if (knowledgeIndexTried) return knowledgeIndex
    knowledgeIndexTried = true
    try {
      const s = createKnowledgeStore({ configDir })
      s.load({})
      knowledgeIndex = s
    } catch { knowledgeIndex = null /* 索引不可用不影响会话（工具侧另有降级） */ }
    return knowledgeIndex
  }
  // chat 模式不注入记忆（2026-09-12 隔离）：个人经验/神经图谱是本地任务资产，对
  // "联网问答"无益，还会引导模型承诺本地动作；顺带跳过图谱加载（省一次磁盘扫描）。
  if (!chatMode) {
    // 神经图谱：图谱存储（markdown 权威，图谱派生索引；缺失/版本旧/markdown 更新自动重建）
    graphStore = createGraphStore({ root: join(configDir, 'memory', 'graph') })
    try { await graphStore.load({ memoryRoot: memoryRootDir }) } catch { /* 图谱故障不影响主流程 */ }
    const injectMode = process.env.PONOS_MEMORY_INJECT || 'both'
    if (settings.merged.memory?.inject !== false) {
      const kw = [
        ...(args.addDirs || []).map((d) => basename(d)).filter(Boolean),
        ...(settings.merged.memory?.taskTag || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(process.env.PONOS_MEMORY_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
      ]
      const inj = buildKnowledgeInjection({
        configDir, memoryRootDir,
        query: kw.join(' '), keywords: kw,
        totalBudget: injectOpts.budget,
        mode: injectOpts.mode,
        // 会话知识范围（2026-09-15，P1 spec §3.3）：**本轮的核心修复**——此前这里没传 spaces，
        // 于是 unified 注入事实上对**全部空间**打分，用户的储备库（source=user/pack）会被无条件
        // 带进每次请求的上下文。这既是上下文成本，也是"agent 越过会话意图去翻用户私人库"的越界。
        // legacy 不受影响：那条路注入的是 buildMemoryIndex（个人经验目录行），与 spaces 无关，
        // 输出逐字节不变 ⇒ 缺省模式下升级零突变。
        spaces: knowledgeScope.spaces,
        // 超上限被忽略的库随注入上报（G2 观测）：stats.spacesDropped 是"点了关联却没生效"的
        // 唯一事后证据——只写 log.warn 的话，用户看不到、GUI 也无从显示。
        spacesDropped: knowledgeScope.dropped,
        // unified 复用同一个 store 实例给后面的轮末沉淀（一次 load 两处用）；
        // legacy 传 null：不建索引（零回归 + 不为死路径付加载成本）。
        knowledgeIndex: injectOpts.mode === 'unified' ? ensureKnowledgeIndex() : null,
        // index-only = 只要索引指针（既有逃生阀），unified 下同样跳过抽调层——
        // 不跳过的话该开关在 unified 下会静默失效（用户设了却仍在抽调）。
        recall: injectMode !== 'index-only',
      })
      // 顺序与改动前一致：先抽调层（legacy 的 graph.search / unified 的块级），再索引层。
      if (injectMode !== 'index-only' && injectOpts.mode === 'legacy') {
        memoryBlock += graphStore.search({ query: kw.join(' '), keywords: kw })
      }
      memoryBlock += inj.recallSection
      memoryBlock += inj.indexSection
    }
  }
  // 提示词组装：内核基础行为规范 + 可用子 Agent 区块（内置 ∪ 用户级）+ AGENTS.md
  // 项目指令 + 技能区块 + 记忆索引 + GUI append 文件（最高优先级，后者覆盖前者）。cwd = addDirs[0]。
  engine.setSystemPrompt(composeSystemPrompt({
    toolNames: engine.tools.toolNames,
    // chat 隔离（2026-09-12）：子 Agent / 项目指令 / cwd 全部不进 chat 提示词
    // （composeSystemPrompt 的 mode='chat' 分支另有兜底，即便此处漏传也不会注入）。
    subagents: chatMode ? [] : engine.agents,
    agents: chatMode ? [] : discoverAgentsMd({ cwd: args.addDirs[0] || '', addDirs: args.addDirs }),
    append: readPromptFile(args.appendSystemPromptFile),
    cwd: chatMode ? '' : (args.addDirs[0] || ''),
    skills,
    workflows: visibleWorkflows,
    memory: memoryBlock,
    // 会话知识范围的人话清单（2026-09-15，P1 spec §3.5）：让模型**看得见**自己能检索什么、
    // 还有什么库需要用户先关联。只给名字不给 id 清单的动机：模型要做的是"转告用户去点哪儿"，
    // 不是拼 id；同时 id 进提示词会把内部命名暴露成模型的"可猜参数"，反而诱导它硬写 spaces。
    knowledgeScope: {
      names: knowledgeScope.spaces.map((id) => knowledgeScope.labels[id] || id),
      unassociated: knowledgeScope.unassociated.map((id) => knowledgeScope.labels[id] || id),
    },
    mode: chatMode ? 'chat' : 'task',
    // 本地弱模型精简纪律段（2026-09-09 适配）：桥按 provider 画像注入
    // PONOS_PROMPT_TIER=lean；未设=full（云端现状，零变化）。chat 用专用提示，与此无关。
    tier: process.env.PONOS_PROMPT_TIER === 'lean' ? 'lean' : 'full',
  }))
  // system(init)：spawn 即发。bridge /test-provider 判定 CLI 加载成功并读取
  // model/tools；GUI 从 session_id 绑定会话（usePonosCLI.ts handleMessage）。
  // name 字段标识 agent 身份（诊断用，GUI 不依赖）；version 为 ponos-turbo dev 版本线
  // （version.mjs 单一数据源，与 GUI 发布版本相互独立）。
  log.info('kernel start', { model, resume: Boolean(args.resume), cwd: args.addDirs[0] || '' })
  // R4-1 并发会话上限策略内核化：capacity 由内核决定（env 兜底），bridge 只执行
  // 拒绝（单进程内核无法感知其他会话，执行必须在会话管理方）
  const capacity = Math.max(1, Number(process.env.PONOS_MAX_CONCURRENT_SESSIONS || 10))
  // init 概览扩展（P4-4，只增字段）：provider 注册表激活态 / 视觉透传 / 技能数 / hooks 规则数
  const prov = getProvider()
  const vision = visionFromEnv()
  wire.system('init', {
    model, tools: engine.tools.toolNames, session_id: sessionId, name: 'Ponos', version: KERNEL_VERSION, capacity,
    schemaVersion: SCHEMA_VERSION,
    // 会话知识范围回显（2026-09-15，P1）：关联关系从 GUI 到内核要跨 4 跳
    // （会话字段 → WS payload → 桥 argv → 本 CLI 解析），任一跳漏登记都是**静默失效**。
    // 让内核把它回显出来，"关联到底生效没有"就能在 init 帧上直接判定，而不是靠猜。
    knowledge_spaces: knowledgeScope.spaces,
    buildId: buildId(),
    provider: prov ? { model: prov.model, version: providerVersion() } : null,
    vision: vision ? { model: vision.model } : null,
    skills: skills.length,
    workflows: workflows.length,
    // 会话模式回显（2026-09-12 chat 隔离）：宿主/GUI 据此确认内核真的进了隔离分支
    // （chat 时 skills/workflows 必为 0、tools 不含本地工具，见 kernel-tests/chat-mode.test.mjs）
    session_mode: chatMode ? 'chat' : 'task',
    settings: { hooks: hooks.count },
    // 生效审批档位回显（2026-09-12 四档化）：桥据此校准状态栏徽标；也是"跑的是旧内核
    // （不认 --approval-mode）"的检测点——旧内核不会带这个字段。
    approval_mode: engine.getApprovalMode(),
  })
  // --resume：从 transcript 恢复（load 为 async 流式；同文件即 GUI 读取的权威源）。
  // 历史由 session.deriveMessages() 派生，engine 无需 seedHistory（seedHistory 已随
  // Task 5 迁移移除）。
  if (args.resume) {
    await store.load()
  }
  // hooks.sessionStart：spawn 就绪后 fire-and-forget（不阻塞 init 事件）
  if (hooks.count) {
    try { await hooks.run('sessionStart', { sessionId, cwd: args.addDirs[0] || '' }) } catch {}
  }

  const state = { turnActive: false, queue: [], cancelling: false }
  // loop 运行时（2026-09-14 抽模块）：状态机/预算/无进展/验证/持久化/指令族集中在
  // kernel/loop.mjs（Task 3），cli 只负责：登记 start、轮末驱动 onTurnEnd、投递下一轮
  // 载荷、--until 判定（judgeUntil 调用点在 cli，控制器不持有 until 目标）。
  const loop = createLoopController({
    wire, engine, store, configDir, sessionId, cwd: args.addDirs[0] || '', env: process.env,
  })
  // --until 目标由 cli 持有（judgeUntil 调用点在 cli）；控制器只管轮次/预算/验证
  let loopUntil = ''
  const loopStateUntil = () => loopUntil
  // everyMs 间隔的延迟投递定时器句柄。必须可取消：否则 --every 期间用户 stop/pause
  // 后，定时器到点仍投递下一轮载荷 → handleUser 见 !loop.isActive() 会**重启 loop**
  // （"停止后又跑一轮"）；resume 补投递与残留定时器并存还会双投递连跑两轮。
  let loopNextTimer = null
  const clearLoopNextTimer = () => { if (loopNextTimer) { clearTimeout(loopNextTimer); loopNextTimer = null } }
  // --resume：恢复未终结 loop（崩溃/中断断点续跑）；无文件/已终结/损坏 → 静默按新会话
  if (args.resume) {
    try {
      // load() 只还原控制面状态，**不会自行推进**（onTurnEnd 仅在轮末被调用）——必须补投递
      // 下一轮，否则恢复成 running 却静默停住，"断点续跑"形同虚设。
      // 仅 running 自动续跑；paused / awaiting_approval 需用户 /loop resume|approve。
      if (loop.load()) {
        loopUntil = String(loop.status().until || '') // --until 停止条件随落盘状态恢复
        if (loop.status().status === 'running') {
          // 推迟到本轮同步初始化（signal/rl 接线）完成之后再启动引擎轮，避免启动期竞态
          setImmediate(() => {
            try {
              if (loop.status().status !== 'running') return
              const p = loop.nextPayload(loopStateUntil())
              state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
              if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
            } catch (e) { log.error('loop resume deliver failed', e) }
          })
        }
      }
    } catch { /* 加载失败按新会话处理 */ }
  }

  // workflow 自动触发：普通用户消息命中 auto_trigger 工作流的触发词 →
  // 后台 run（wfBusy 防 EOF 提前退出），完成后结果经 engine.queueNext 注入
  // 当前轮（工具边界）或下一轮，模型综合后继续；wire 回发 auto_triggered 事件。
  function maybeAutoTriggerWorkflow(content) {
    const hit = matchAutoTrigger(workflows, content)
    if (!hit) return
    const summarize = (o) => {
      try { return JSON.stringify(o?.end?.output ?? o).slice(0, 400) } catch { return String(o) }
    }
    wfBusy++
    void wfEngine.run({ id: hit.id, inputs: { user_message: content } }).then((r) => {
      wfBusy--
      const line = r.ok
        ? `【自动触发工作流 ${hit.id} 完成】状态：${r.status}（${r.steps} 步，${r.runId}）。输出：${summarize(r.outputs)}`
        : `【自动触发工作流 ${hit.id} 失败】${r.error}`
      try { engine.queueNext(line) } catch { /* 注入失败不阻断 */ }
      try { wire.system('workflow_result', { subtype: 'auto_triggered', workflow: hit.id, ok: r.ok, status: r.status, steps: r.steps, runId: r.runId, error: r.error }) } catch { /* ignore */ }
    }).catch((err) => {
      wfBusy--
      log.error('auto-trigger workflow failed', err)
    })
  }

  // loop 指令族执行（stdin 的 loop_command 与 TUI 斜杠文本共用同一路由）。
  // 任何异常都折叠为 { ok:false, text } 回执——指令失败绝不中断主 loop（health 风格）。
  function handleLoopOp(op, opArgs = []) {
    try {
      switch (op) {
        case 'status': {
          const st = loop.status()
          try { wire.loop('status', { ...st }) } catch { /* 事件失败不阻断回执 */ }
          return { ok: true, text: loop.formatStatus() }
        }
        case 'pause': clearLoopNextTimer(); loop.pause(); return { ok: true, text: '已请求暂停（当前轮跑完生效）' }
        case 'resume': case 'approve': {
          const wasActive = loop.isActive()
          clearLoopNextTimer() // 先取消残留的延迟投递，避免与下面的补投递双投递连跑两轮
          loop.resume()
          // 恢复后需重新投递下一轮：暂停/挂起都发生在"轮已结束"的边界，控制器不会自行
          // 推进（其 onTurnEnd 只在轮末被调用），故此处补投递，否则恢复后静默停住。
          if (wasActive) {
            const p = loop.nextPayload(loopUntil)
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
            if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
          }
          return { ok: true, text: '已恢复' }
        }
        case 'stop': clearLoopNextTimer(); loop.stop('cancelled'); return { ok: true, text: '已停止 loop' }
        case 'budget': {
          const patch = {}
          for (let i = 0; i < opArgs.length; i++) {
            const a = opArgs[i]
            if (a === '--max-cost') patch.maxCostUsd = Number(opArgs[++i]) || 0
            else if (a === '--max-steps') patch.maxSteps = Number(opArgs[++i]) || 0
            else if (a === '--max-wall') patch.maxWallMs = Number(opArgs[++i]) || 0
          }
          if (Object.keys(patch).length) loop.setBudget(patch)
          const b = loop.status().budget
          return { ok: true, text: `预算：成本上限 ${b.maxCostUsd || '不限'} USD，步数上限 ${b.maxSteps || '不限'}，墙钟上限 ${b.maxWallMs ? Math.round(b.maxWallMs / 1000) + 's' : '不限'}` }
        }
        case 'inject': loop.inject(opArgs.join(' ')); return { ok: true, text: '已注入补充信息' }
        case 'rollback': {
          const r = loop.rollback()
          return { ok: r.ok !== false, text: r.ok ? '已登记回滚点（需 /loop approve 确认执行）' : String(r.error) }
        }
        case 'replay': return { ok: true, text: loop.replay(Number(opArgs[opArgs.indexOf('--last') + 1]) || 10) }
        case 'memory': return { ok: true, text: loop.memory() }
        default: return { ok: false, text: `未知 loop 指令：${op}` }
      }
    } catch (e) { return { ok: false, text: `指令执行失败：${e?.message || String(e)}` } }
  }

  async function handleUser(msg) {
    const content = extractContent(msg)
    // 进程内斜杠文本（TUI 直发）：/loop 指令族经同一路由（GUI 路径由 bridge 转译为
    // loop_command）。放在 setTurnActive 之前——指令回执即刻完成，不武装硬看门狗。
    // 零回归锁②：非 /loop 文本 parseLoopDirective 返回 null → 直通原路径逐字不变。
    const directive = parseLoopDirective(content)
    if (directive && directive.kind === 'op') {
      wire.system('loop_result', { op: directive.op, ...handleLoopOp(directive.op, directive.args) })
      return
    }
    setTurnActive(true) // 硬看门狗武装（result 事件经 writeLine 自动解除）
    const priority = msg?.priority
    const uuid = msg?.uuid
    // loop 初始化：首个带 loop 字段的消息进入时登记（内部推进消息 loop 已 active，跳过）
    const loopMsg = msg?.loop
    if (loopMsg && !loop.isActive()) {
      loopUntil = String(loopMsg.until || '')
      loop.start({
        count: loopMsg.count ?? null,
        until: loopUntil,
        everyMs: Number(loopMsg.everyMs) || 0,
        fresh: loopMsg.fresh === true,
        goal: String(loopMsg.goal || ''),
        doneWhen: Array.isArray(loopMsg.doneWhen) ? loopMsg.doneWhen : [],
        maxCostUsd: Number(loopMsg.maxCostUsd) || 0,
        maxSteps: Number(loopMsg.maxSteps) || 0,
        maxWallMs: Number(loopMsg.maxWallMs) || 0,
        prompt: content,
      })
    }
    // P8 排队插话（priority:'next'）：当前轮活跃时吸收进 engine 待注入队列，
    // 工具边界注入当前轮（模型尽快看到补充信息）；立即回发 command_lifecycle
    // started 解除前端气泡悬浮。纯文本阶段轮次结束仍未注入 → finally 兜底作为
    // 新轮处理（前端方案 A 语义）。turnActive=false（轮次间隙到达）时作为新轮
    // 直接执行，同样先发 started 确认——否则前端气泡悬浮 30s 兜底落位。
    if (priority === 'next') {
      if (state.turnActive) {
        engine.queueNext(content, uuid) // 内部含 command_lifecycle started
        return
      }
      if (uuid) wire.commandLifecycle(uuid, 'started')
      // fallthrough：作为新轮执行
    }
    // 紧急插话（priority:'now'）：吸收确认后中断当前轮，消息作为新轮立即执行。
    // 流程与前端 pendingInterject 对齐：被打断轮 result 到达 → GUI 建插话轮
    // 占位 → 本消息作为新轮输出归属到插话轮。
    if (state.turnActive && priority === 'now') {
      if (uuid) wire.commandLifecycle(uuid, 'started')
      state.cancelling = true
      engine.abort()
      state.queue = [] // 丢弃排队消息（紧急插话优先）
      state.queue.push({ ...msg, priority: undefined, uuid: undefined })
      return
    }
    state.turnActive = true
    // workflow 自动触发（普通新消息；插话/loop 消息不触发，避免批处理重复执行）
    try { maybeAutoTriggerWorkflow(content) } catch { /* 触发失败不影响主流程 */ }
    // 本轮 outcome（engine.runTurn 返回值）：loop 轮末决策的数据来源——无进展指纹
    // 靠 outcome.toolDigest、成本/步数靠 outcome.usage/toolDigest。取消/异常轮保持 null
    // （控制器对 null outcome 静默降级：不累计、不误记无进展）。
    let turnOutcome = null
    // 早退路径（hook 拦截 / 竞态取消）统一落在外层 try 内，确保 finally 复位
    // turnActive——否则后续消息会永远排队不处理。
    try {
      // hooks.userPromptSubmit：可拦截。stop → 直接 assistant + result，不进轮次
      try {
        const intercept = await hooks.run('userPromptSubmit', { prompt: content })
        if (intercept.stop) {
          wire.assistant(intercept.message || '已由 hook 拦截。')
          wire.result()
          return
        }
      } catch { /* 钩子失败不拦截输入 */ }
      // 竞态防护：hook await 期间 cancel 到达 → engine.runTurn 起始会重置 abort
      // 标志（abort 只影响进行中的轮次），未开始就 abort 会被吞掉。在此兑现取消。
      if (state.cancelling) {
        wire.assistant('已取消。')
        wire.result()
        // 与 abort 路径一致的会话语义：user 入日志 + assistant 落盘
        store.appendUser(content)
        store.appendAssistant([{ type: 'text', text: '已取消。' }])
        return
      }
      // engine 全权负责本轮：user 入 session、中间/最终 assistant 落盘、
      // result 事件（含 duration_ms）——cli 不再重复 emit/append。
      // 返回值（usage/model/text/durationMs/toolDigest）供 loop 轮末决策使用。
      turnOutcome = await engine.runTurn({ content, msg })
    } catch (err) {
      if (err?.name === 'AbortError' || state.cancelling) {
        log.info('turn cancelled')
        wire.assistant('已取消。')
        wire.result()
        store.appendAssistant([{ type: 'text', text: '已取消。' }])
      } else {
        log.error('turn failed', err)
        wire.assistant('处理出错：' + (err?.message || String(err)))
        wire.result()
      }
    } finally {
      // L3-1 轮末捕获：命中纠错/偏好模式 → 落盘记忆（默认开，settings.memory.capture=false 关闭）。
      // skipMemoryCapture：插话统一不捕获——工具边界注入路径（engine 内 appendUser）
      // 本就不经 cli 捕获，兜底成新轮的插话带标记跳过，两条路径行为一致。
      try {
        // chat 守卫是**行为等价**补丁：原来 `graph` 跨块引用必然抛错（见 injectOpts 处的注释），
        // 于是 chat 下这条路径碰巧也不写盘。修好作用域后必须显式守卫，否则 chat 会话会开始
        // 往本地 memory/personal 写文件——那破了 S1 的"纯聊不落本地资产"隔离语义。
        if (!chatMode && settings.merged.memory?.capture !== false && content.trim() && !msg?.skipMemoryCapture) {
          for (const c of captureMemoryCandidates({ userText: content, tag: settings.merged.memory?.taskTag || null, markers: settings.merged.memory?.markers || null })) {
            appendMemoryEntry({
              root: memoryRootDir, theme: c.theme, tag: c.tag, summary: c.summary, full: c.full,
              graphStore: graphStore, knowledgeIndex: ensureKnowledgeIndex(),
            })
          }
        }
      } catch { /* 记忆捕获失败不影响主流程 */ }
      // P9-3：轮末写会话工作记忆（todo/文件变更/最近决策）——压缩时作为摘要事实来源
      try {
        if (sessionMemoryPath) {
          const key = extractKeyInfo(store.deriveMessages())
          if (key.todos.length || key.files.length || key.decisions.length) {
            mkdirSync(join(configDir, 'memory', 'session'), { recursive: true })
            writeFileSync(sessionMemoryPath, buildSessionMemoryText(key), 'utf-8')
            // 会话工作记忆不走 appendMemoryEntry（整文件覆盖写，非 append 语义），故这里
            // 单独同步索引：否则"跨会话检索历史工作记忆"要等到下次启动重建才生效（S3 §5）。
            syncKnowledgeIndex(ensureKnowledgeIndex(), `session-memory/${basename(sessionMemoryPath)}`)
          }
        }
      } catch { /* 工作记忆写失败不影响主流程 */ }
      state.turnActive = false
      state.cancelling = false
      // loop 推进（轮次已完成）：控制器统一决策（暂停/预算/无进展/验证/次数）→
      // next 时把下一轮载荷 unshift 入队（插话消息排在 loop 之后公平执行；cancel /
      // 预算 / 验证达成 / 次数耗尽由控制器自行收尾并发 end 帧，此处不再判次数）。
      // 决策异常不阻断：按"不推进"处理（loop 停摆优于主轮次崩溃）。
      if (loop.isActive()) {
        let decision = { action: 'wait', delayMs: 0, rationale: '' }
        try {
          decision = await loop.onTurnEnd({ outcome: turnOutcome })
        } catch (e) {
          log.error('loop onTurnEnd failed', e)
        }
        // 既有 --until 判定行为保留（语义不变，判定在 cli 侧）：仅在实际要继续下一轮时
        // 判定，命中 → until_hit 收尾；判定异常 → judge_error 收尾（不无限重试烧钱）。
        // judged/reason/error 三个既有 iter 字段照旧发出（零回归锁③）。
        if (decision.action === 'next' && loopUntil) {
          let j = null
          try { j = await engine.judgeUntil({ target: loopUntil }) } catch { j = { done: false, error: true } }
          wire.loop('iter', { index: loop.status().index, total: loop.status().count, judged: j?.done === true, reason: j?.reason || '', error: !!j?.error })
          if (j?.done) { loop.stop('until_hit'); decision = { action: 'stop', delayMs: 0, rationale: 'until_hit' } }
          else if (j?.error) { loop.stop('judge_error'); decision = { action: 'stop', delayMs: 0, rationale: 'judge_error' } }
        }
        if (decision.action === 'next') {
          // fresh：第 1 轮完成后设窗口起点，第 2 轮请求面只含本轮之后内容
          const deliver = () => {
            if (loop.status().fresh && loop.status().index === 1) engine.setFreshWindow()
            const p = loop.nextPayload(loopStateUntil())
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
          }
          if (decision.delayMs > 0) {
            // everyMs 间隔：延迟投递且此时本函数已返回（finally 收尾完毕），
            // 故延迟分支需自行启动下一轮（未在跑轮时）。
            // 到点必须复核 loop 仍处于 running：期间可能已 stop（cancelled）/暂停
            // （paused）/预算超限/验证达成/无进展挂起 —— 直接投递会经 handleUser 的
            // !isActive() 分支把已终结的 loop 重新 start（停止后又跑一轮）。
            loopNextTimer = setTimeout(() => {
              loopNextTimer = null
              if (loop.status().status !== 'running') return
              deliver()
              if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
            }, decision.delayMs)
          } else {
            deliver() // 立即投递：由本 finally 尾部的队列消费启动下一轮
          }
        }
      }
      // 插话残余兜底：next 消息在纯文本阶段未被工具边界吸收 → 作为新轮处理。
      // skipMemoryCapture 标记：插话不参与记忆捕获（与工具边界注入路径一致，
      // 见 finally 捕获处注释）
      if (engine.pendingNextCount() > 0) {
        for (const inj of engine.drainNextPending()) {
          state.queue.push({ message: { role: 'user', content: inj.content }, skipMemoryCapture: true })
        }
      }
      const nextMsg = state.queue.shift()
      if (nextMsg) void handleUser(nextMsg)
    }
  }

  // /wf 命令执行：list/run/verify → 工作流引擎，结果 wire.system('workflow_result') 回发
  async function handleWorkflowCommand(msg) {
    const subtype = msg?.subtype
    try {
      if (subtype === 'list') {
        const wfs = discoverWorkflowsAll({ roots: workflowRoots })
        // 回执补 legacy/expose/dslVersion（M7）：宿主/GUI 需要「需升级」「暴露态」标记；
        // requestId 全子命令齐备（M6）——宿主 send() 严格按 msg.requestId 配对，缺一个即超时。
        wire.system('workflow_result', {
          subtype: 'list', requestId: msg?.requestId,
          workflows: wfs.map((w) => ({
            id: w.id, nodes: w.nodes, triggers: w.triggers, description: w.description,
            legacy: w.legacy === true, expose: w.expose || {}, dslVersion: w.dslVersion,
            version: w.version || '', schedule: w.schedule || '', autoTrigger: w.autoTrigger === true,
          })),
        })
      } else if (subtype === 'run') {
        // runId/grant/cwd 必须转发：宿主用 runId 作为 grant 键与 stop/confirm 的目标；
        // 不转发时引擎自生 runId，宿主拿到的 id 与真实运行错位 → stop 打空、审计无法关联。
        const r = await wfEngine.run({
          id: msg?.payload?.workflow || msg?.payload?.id || '',
          inputs: msg?.payload?.inputs || {},
          runId: msg?.payload?.runId || undefined,
          grant: msg?.payload?.grant || null,
          cwd: msg?.payload?.cwd || '',
        })
        // 回执补 code/errors（审查 I-3）：宿主只看 ok/error 时无法把"旧 DSL 需迁移"与其他
        // 失败区分开；LEGACY_DSL 另附可操作提示（Task 8 迁移前的唯一自带工作流正走此路径）。
        const legacy = r.code === 'LEGACY_DSL'
        const error = legacy && r.error ? `${r.error}（该工作流为旧 DSL 格式（无 edges），请先迁移）` : r.error
        wire.system('workflow_result', { subtype: 'run', requestId: msg?.requestId, ok: r.ok, status: r.status, steps: r.steps, outputs: r.outputs, finalOutput: r.finalOutput, error, ...(r.code ? { code: r.code } : {}), errors: r.errors, node: r.node, runId: r.runId, auditPath: r.auditPath, ...(r.unresolved ? { unresolved: r.unresolved } : {}) })
      } else if (subtype === 'verify') {
        const r = wfEngine.verify(msg?.payload?.auditPath || msg?.payload?.path || '')
        wire.system('workflow_result', { subtype: 'verify', requestId: msg?.requestId, ok: r.ok, lines: r.lines, tampered: r.tampered, error: r.error })
      } else if (subtype === 'webhook') {
        // 启动 webhook 服务（幂等）：POST /wf/run/<id>（JSON body=inputs），GET /wf/list
        const port = Number(process.env.PONOS_WF_WEBHOOK_PORT || 51312)
        if (!wfHttpServer) {
          wfHttpServer = wfEngine.createWebhookServer()
          wfHttpServer.listen(port, () => {
            wire.system('workflow_result', { subtype: 'webhook', ok: true, port, url: `http://localhost:${port}/wf/run/<id>` })
          })
          wfHttpServer.on('error', (err) => wire.system('workflow_result', { subtype: 'webhook', ok: false, error: err?.message || String(err) }))
        } else {
          wire.system('workflow_result', { subtype: 'webhook', ok: true, port, url: `http://localhost:${port}/wf/run/<id>`, note: 'already running' })
        }
      } else if (subtype === 'scheduler') {
        // 启动 cron 调度器（幂等）：扫描 workflows 带 schedule 字段，到点自动 run
        if (!wfSchedulerStop) {
          wfSchedulerStop = wfEngine.startScheduler({ onRun: (id, res) => wire.system('workflow_result', { subtype: 'scheduled_run', workflow: id, ok: res.ok, status: res.status, runId: res.runId, auditPath: res.auditPath }) })
          wire.system('workflow_result', { subtype: 'scheduler', requestId: msg?.requestId, ok: true, note: 'started (60s tick)' })
        } else {
          wire.system('workflow_result', { subtype: 'scheduler', requestId: msg?.requestId, ok: true, note: 'already running' })
        }
      } else if (subtype === 'migrate') {
        // 旧格式一键迁移 + 备份（M7，spec §2.7）：迁移是**唯一的内核写用户工作流目录**动作，
        // 只在显式收到本子命令时发生（理由与写盘两步见 workflow-engine.migrate 注释）。
        // payload.id 缺省 = 全部 legacy 工作流；回执三段 migrated/skipped/errors。
        const info = wfEngine.migrate({ id: String(msg?.payload?.id || msg?.payload?.workflow || '').trim() || null })
        wire.system('workflow_result', { subtype: 'migrate', requestId: msg?.requestId, ...info })
      } else if (subtype === 'load') {
        // 取工作流原文 + 校验结果（只读，不落盘）
        const id = msg?.payload?.id || ''
        const wf = wfEngine.load(id)
        if (!wf) wire.system('workflow_result', { subtype: 'load', requestId: msg?.requestId, result: { ok: false, error: `工作流不存在: ${id}` } })
        else wire.system('workflow_result', {
          subtype: 'load', requestId: msg?.requestId,
          // model：画布模型（toModel 收拢 config）——GUI 打开工作流直接落画布，
          // 不必在前端重做 DSL 解析（UI Task 13「选中项经 /workflows/:id 取 model」）。
          result: { ok: true, id: wf.id || id, model: toModel(wf), yml: wf.path ? readFileSync(wf.path, 'utf-8') : '', validation: validateWorkflow(wf) },
        })
      } else if (subtype === 'validate') {
        const wf = wfEngine.load(msg?.payload?.id || '')
        const v = wf ? validateWorkflow(wf) : { ok: false, errors: [{ code: 'NOT_FOUND', message: '工作流不存在' }], warnings: [] }
        wire.system('workflow_result', { subtype: 'validate', requestId: msg?.requestId, result: v })
      } else if (subtype === 'stop') {
        wire.system('workflow_result', { subtype: 'stop', requestId: msg?.requestId, result: wfEngine.stop(msg?.payload?.runId || '') })
      } else if (subtype === 'save' || subtype === 'save-raw') {
        // 画布保存（UI Task 9/12）：序列化 → 解析归一 → 校验 → 回传 yml 文本。
        // **不写用户工作流目录**（单一写者）：落盘由 bridge 侧存储层完成——内核并发多会话，
        // 多写者会让版本快照与备份互相覆盖；写盘动作只保留 migrate（显式迁移）。
        //   save      ：payload.model（画布模型）→ serializeWorkflow → yml
        //   save-raw  ：payload.yaml 原文回传（保留用户排版/注释），缺 yaml 时回退 model
        // 两种载荷都容忍：宿主 save() 统一发 save-raw，带 model 时以 model 序列化。
        const saveId = String(msg?.payload?.id || '').trim()
        const raw = typeof msg?.payload?.yaml === 'string' ? msg.payload.yaml : ''
        const yml = raw.trim() ? raw : serializeWorkflow(msg?.payload?.model || {})
        const validation = validateWorkflow(normalizeWorkflow(parseYaml(yml)))
        if (!validation.ok) {
          wire.system('workflow_result', {
            subtype, requestId: msg?.requestId,
            result: { ok: false, id: saveId, error: '校验失败', errors: validation.errors, warnings: validation.warnings },
          })
        } else {
          wire.system('workflow_result', { subtype, requestId: msg?.requestId, result: { ok: true, id: saveId, yml, validation } })
        }
      } else {
        // 必须带 requestId：宿主按 requestId 严格配对；无 requestId 的错误只能靠启发式
        // 兜底（曾导致"无关错误误杀在途 run"，Task 11 审查 I-1/N-3），根治办法是错误回执
        // 也带上请求标识。
        wire.system('workflow_result', { subtype: 'error', requestId: msg?.requestId, error: `未知 /wf 子命令: ${subtype}` })
      }
    } catch (err) {
      wire.system('workflow_result', { subtype: 'error', requestId: msg?.requestId, error: err?.message || String(err) })
    }
  }

  function handleControlRequest(req) {
    const subtype = req?.request?.subtype
    if (subtype === 'cancel') {
      state.cancelling = true
      // loop 立即终止：清 active（后续轮次不再推进），结束事件发出
      clearLoopNextTimer() // 同 /loop stop：取消挂起的延迟投递，防停止后再跑一轮
      if (loop.isActive()) {
        loop.stop('cancelled') // 控制器发 end(reason:'cancelled') 并清零 active
      }
      // 停止按钮全杀语义（engine.hardStop）：kill 工具子进程（Bash/OCR）+ 中止
      // 全部后台子 agent + 中断当前 API 流。与打断插入（now，engine.abort()，
      // 保持审批/浏览器挂起让模型理解新指令后继续）区分。
      engine.hardStop()
      // 取消语义含丢弃排队输入（用户后续消息不再执行）
      state.queue = []
      // P8 修复：一并丢弃尚未注入当前轮的排队插话（pendingNext）——否则轮末
      // finally 会把残余插话 drain 成新轮执行，取消"取消不干净"。drain 返回值
      // 即丢弃；空转 cancel（turnActive=false）时 pendingNext 必为空，无副作用。
      engine.drainNextPending()
      // 无活跃轮次时的空转 cancel：直接完成（契约 §8，bridge 依赖 result
      // 复位 _cancelPending；mock 同语义）
      if (!state.turnActive) {
        wire.assistant('已取消。')
        wire.result()
        state.cancelling = false
      }
      return
    }
    // 浏览器桥响应（bridge 回写，browser-routing.mjs）：解除 engine 浏览器挂起
    if (subtype === 'browser_response') {
      engine.resolveBrowser(req?.request?.requestId, req?.request)
      return
    }
    // 应用桥响应（bridge 回写，server/app-routing.mjs，Task 4.x）：解除应用命令挂起。
    // 与 browser_response 同构，只是 subtype 与回执形状不同（app:run 回执）。
    if (subtype === 'app_response') {
      engine.resolveApp(req?.request?.requestId, req?.request)
      return
    }
    // P4-5 热切换：空闲切换 / busy 拒绝 / 校验失败拒绝；成功落审计 meta 条目
    if (subtype === 'switch_provider') {
      const payload = req?.request?.payload || {}
      if (state.turnActive) {
        wire.system('provider_switch_rejected', { reason: 'busy' })
        return
      }
      try {
        const { provider, version } = setProvider(payload)
        model = provider.model
        // 上下文窗口：bridge 显式下发 contextWindow（setProvider 已持久化）则尊重之，
        // 自定义窗口在热切换时不丢失；未下发（0）才按模型表/画像默认重算。
        // 切换后窗口重定向（2026-09-10 小窗口模型切换适配）：立即上行事件供
        // TUI/GUI 提示；压缩阈值与每轮请求的预算钳制（engine preStep）都现读
        // context.window——云端大窗口切本地小窗口后，下一轮请求即按新窗口规划，
        // covered 超单块容量时走分块摘要（compact.mjs 阶段②b）。
        context.window = provider.contextWindow > 0 ? provider.contextWindow : contextWindowFor(provider.model)
        wire.system('context_window_retargeted', { model: provider.model, window: context.window })
        // 顺带同步思考深度档位（bridge 下发 payload.effortLevel；空值不动）
        if (payload.effortLevel) {
          const r = engine.setReasoningEffort(payload.effortLevel)
          store.appendMeta('reasoning_effort', { value: r.value, effort: r.effort, source: 'provider_switch' })
        }
        store.appendMeta('provider_switched', { provider: { baseUrl: provider.baseUrl, model: provider.model }, version })
        wire.system('provider_switched', { model: provider.model, baseUrl: provider.baseUrl, version })
      } catch (err) {
        wire.system('provider_switch_rejected', { reason: err?.message || String(err) })
      }
      return
    }
    // 思考深度热切换：校验失败拒绝 / 生效于下一轮 API 请求；成功落审计 meta 条目
    if (subtype === 'reasoning_effort') {
      const value = req?.request?.payload?.value
      if (value == null || String(value).trim() === '') {
        wire.system('reasoning_effort_rejected', { reason: '缺少 value（off|low|medium|high|max|auto）' })
        return
      }
      const r = engine.setReasoningEffort(String(value).trim())
      store.appendMeta('reasoning_effort', { value: r.value, effort: r.effort })
      wire.system('reasoning_effort_updated', { value: r.value, effort: r.effort })
      return
    }
    // 审批档位热切换（2026-09-12）：四档 manual|auto|loose|bypass，下一轮工具调用生效。
    // 非法值不静默放宽——回落默认档（loose）并上行 rejected 事件，桥/GUI 可提示用户。
    if (subtype === 'approval_mode') {
      const raw = req?.request?.payload?.value
      const mode = engine.setApprovalMode(raw)
      const valid = normalizeApprovalMode(raw) === String(raw ?? '').trim().toLowerCase()
      store.appendMeta('approval_mode', { value: mode, source: valid ? 'user' : 'fallback' })
      if (valid) wire.system('approval_mode_updated', { value: mode })
      else wire.system('approval_mode_rejected', { reason: `非法档位 ${JSON.stringify(raw)}，已回落默认档`, value: mode })
      return
    }
    // 其余 control_request（interrupt 等）骨架阶段忽略
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let parsed = null
    try { parsed = JSON.parse(t) } catch { return }
    if (parsed.type === 'loop_command') {
      // loop 指令族（bridge 按 /loop 文本转译 / 宿主按钮直发）：status/pause/resume/
      // stop/budget/approve/inject/rollback/replay/memory。逐条即时回执（含 requestId），
      // 与 /wf 的 workflow_result 同构；异常一律折叠成 ok:false 文本，不阻断主 loop。
      const { op, args: opArgs = [], requestId } = parsed
      wire.system('loop_result', { requestId, op, ...handleLoopOp(op, Array.isArray(opArgs) ? opArgs : []) })
      return
    }
    if (parsed.type === 'user') {
      // P8 插话消息（priority:'next'/'now'）在轮次活跃时必须进 handleUser——其
      // priority 分支负责 queueNext 吸收（工具边界注入当前轮）或 now 打断；普通
      // 消息才直接排队。修复：此前 turnActive 一律 queue.push 绕过了 handleUser，
      // 使 next 的注入路径与 now 的打断路径在 cli 进程从未生效（dead code），
      // 插话实际退化为"排队等新轮"（方案 A 兜底语义），command_lifecycle 也因此
      // 滞后到轮末才发出（前端气泡 30s 兜底落位）。
      if (state.turnActive && parsed.priority !== 'next' && parsed.priority !== 'now') {
        // 提问挂起中的作答必须注入当前轮唤醒等待（engine.isAwaitingAnswer）：桥的作答
        // 通道（bridge.mjs 的 answer 分支）写的是**无 priority** 的 user 消息，若照常
        // 排队，内核会一直挂到提问超时——用户答了却像没答（2026-09-12 实测形态）。
        if (engine.isAwaitingAnswer?.()) {
          if (parsed.uuid) wire.commandLifecycle(parsed.uuid, 'started')
          engine.queueNext(extractContent(parsed), parsed.uuid)
          return
        }
        state.queue.push(parsed)
      } else {
        void handleUser(parsed)
      }
    } else if (parsed.type === 'control_request') {
      handleControlRequest(parsed)
    } else if (parsed.type === 'anchor_applied') {
      // 上下文失真：用户在 GUI 点了「重新锚定」并已发送锚点 → 把这些证据标记为
      // 已解决（失真档立即回绿 + 进入观察期）。静默降级：上报失败不得影响轮次。
      try { health.markFidelityResolved(Array.isArray(parsed.issueIds) ? parsed.issueIds : []) } catch { /* 静默 */ }
    } else if (parsed.type === 'control_response') {
      // 权限审批回执：解除对应 tool_use 的挂起（engine 继续执行工具）
      const inner = parsed.response?.response
      if (inner?.toolUseID) engine.resolveApproval(inner.toolUseID, inner)
    } else if (parsed.type === 'workflow_command') {
      // /wf 命令（TUI/协议层）：list/run/verify/approve/reject → 调工作流引擎，结果 wire 回发
      wfBusy++
      handleWorkflowCommand(parsed).finally(() => { wfBusy-- })
    } else if (parsed.type === 'workflow_confirm') {
      // 人工审批回传（TUI /wf approve|reject / 协议层）：解除 confirm 节点挂起
      const { runId, node, action, comment } = parsed.payload || {}
      const r = wfEngine.resolveConfirm(runId, node, { action: action || 'approved', comment: comment || '' })
      wire.system('workflow_result', { subtype: 'confirm', ok: r.ok, error: r.error })
    }
  })
  rl.on('close', () => {
    // stdin EOF：若仍有活跃轮次 / 排队消息 / 进行中 loop / workflow 命令，延迟到完成后退出
    // （管道测试与 bridge 优雅退出两全；30s 兜底防挂起）
    if (state.turnActive || state.queue.length || loop.isActive() || wfBusy > 0) {
      const timer = setInterval(() => {
        if (!state.turnActive && !state.queue.length && !loop.isActive() && wfBusy <= 0) {
          clearInterval(timer)
          shutdown(0)
        }
      }, 50)
      setTimeout(() => { clearInterval(timer); shutdown(0) }, 30000)
    } else {
      shutdown(0)
    }
  })
  return 0
}

// 直接执行（import 时跳过，测试可复用 parseArgs/main）。main 为 async，
// Promise 落地 exitCode；load 失败（流式读错误）时以 1 退出并报错，避免悬空。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
    .catch((err) => { console.error('kernel:', err); process.exitCode = 1 })
}
