#!/usr/bin/env node
// Ponos-turbo 内核入口（docs/bridge-contract.md §2 spawn 契约 + §3/§4 wire 语义）
// ---------------------------------------------------------------------------
// 净室重建的原创内核（代号 Ponos-turbo），由 bridge 经 node 运行时以 stream-json
// 模式 spawn（PONOS_KERNEL 逃生口候选 #1：<repo>/kernel/cli.mjs），也可直接
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
import { applyLegacyEnvAliases, credentialEnvKeys } from '../shared/legacy-env.mjs'
import { createInterface } from 'node:readline'
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createEngine } from './engine.mjs'
// ★ 2026-10-18 SESS-08：后台子代理任务的快照与恢复（详见该模块顶部注释：
//   为什么不在 engine 热路径上落盘 —— 会引入 Windows 句柄时序回归）
import * as subagentResume from './subagent-resume.mjs'
import { shouldAutoWake, buildWakeText, WAKE_MERGE_WINDOW_MS } from './auto-wake.mjs'
import { AUTO_WAKE_MAX, ACTIVITY_HB_MS, ACTIVITY_BUSY_MAX_MS } from './engine-config.mjs'
import { activityHeartbeat, heartbeatToleranceMs, judgeHardWatchdog } from './heartbeat.mjs'
import { resolveConfigDir, sharedDirFor, providerCapabilityAllowed, readActiveProvider, readConfigObject } from './config.mjs'
import { resolveParams, explicitParams, pickModel, atlasBudgetBytes } from './param-surface.mjs'
import { killActiveChildren, CHAT_MODE_DISALLOWED } from './tools.mjs'
import { createLogger } from './log.mjs'
import { createMcpRegistry, hookMcpExitCleanup } from './mcp-tools.mjs'
import { makeWire, wireLastWriteAt, wireHeartbeatAt, setTurnActive, isTurnActive, isAwaitingUser, wireWriteStats } from './protocol.mjs'
import { createSessionStore, newSessionId } from './session.mjs'
import { createHealth } from './health.mjs'
import { createCompactor, extractKeyInfo, buildSessionMemoryText } from './compact.mjs'
// loop 运行时（2026-09-14 Task 4 接线）：状态机/预算/无进展/持久化/指令族在 loop.mjs，
// 指令文本解析在 loop-commands.mjs（纯函数，零 IO）
import { createLoopController } from './loop.mjs'
import { resolveModelPrices, parseModelPricesEnv } from './model-prices.mjs'
import { buildTurnLedgerRow } from './turn-ledger.mjs'
// T3.2（2026-10-20）：治理策略注册表 —— A/B 的分组键（turn.activeStrategies）
import { resolveActiveStrategies } from './token-strategies.mjs'
import { parseLoopDirective } from './loop-commands.mjs'
import { contextWindowFor, resolveContextWindowFor, estimateRequest, estimateMessage, estimateHistory } from './context.mjs'
import { resolveCompactSettings } from './compact.mjs'
import { configureDiskWriter, diskWrite, getDiskTelemetry } from './disk-write.mjs'

// ── 活性心跳登记（2026-09-21 长任务可靠性 P2）─────────────────────────────────
// ★ 刻意放**模块级**：发送点（engine 就绪后的 activityTimer）与消费点（进程级硬看门狗的
// setInterval）不在同一个嵌套块内，放块内就变成"同一份状态两处声明"（实测形态：消费点读
// 到 ReferenceError，被兜底 catch 吞掉 ⇒ 心跳静默不生效——观测面静默失效是最坏的失败形态）。
// 这里只存**心跳载荷**（在飞数/相位）；"最近一次心跳时刻"的单一真源是 protocol 的
// `wireHeartbeatAt()`（它与 `wireLastWriteAt()` 并排维护，才不会漂移成两份时间）。
const hbState = { inflight: 0, phase: '' }
const HB_TOLERANCE_MS = heartbeatToleranceMs(ACTIVITY_HB_MS)
import { extractConstraints } from './fidelity.mjs'
import { memoryRoot, captureMemoryCandidates, appendMemoryEntry, syncKnowledgeIndex, listMemoryThemes, ensureMemoryRoot, SEDIMENT_MARKER } from './memory.mjs'
// T1.4（2026-10-20）：附录段详略（过程纪律 + 沉淀指引）；缺省全文，PONOS_PROMPT_APPENDIX=compact 切换
import { buildPromptAppendix } from './prompt-appendix.mjs'
import { buildKnowledgeInjection, resolveInjectMode, resolveInjectBudget, resolveRecallChars, getInjectStats, resetInjectStats, recordChannel } from './knowledge-inject.mjs'
// P1.1：Atlas 主会话/子代理注入（settings 解析与区块构建的唯一真源在 atlas/inject.mjs）
import { resolveAtlasSettings, buildAtlasBlock } from './atlas/inject.mjs'
// S1+/O4：注入总账的纯函数（CHANNELS/BY_SOURCE/summarizeInjection/ledgerTotals/nextTurnSeq）
import { summarizeInjection } from './inject-ledger.mjs'
import { readDisabled, excludeDisabled } from './disabled.mjs'
import { createKnowledgeStore, resolveSessionKnowledgeScope, discoverSpaces, MAX_ASSOC_SPACES, resolveRelateMode } from './knowledge.mjs'
// S4.5④-3：EL1 线索层的渲染与接线判据（shouldInjectEl1 做 A18 前置 + A20 互斥 + 逃生阀）
import { buildRecommendSection, shouldInjectEl1, HYDRATE_EL1_MAX_BYTES } from './knowledge-recommend.mjs'
import { searchKnowledgeItems } from './knowledge-search.mjs'
import { createGraphStore } from './graph.mjs'
import { getProvider, setProvider, providerVersion, seedFromFile, visionFromEnv } from './provider.mjs'
import { discoverSkills, verifySkillVersions } from './skills.mjs'
// 技能声明的工作目录（P3，2026-09-21）：`SKILL.md` frontmatter 的 extra_dirs → 会话边界
// 的**显式追加**（校验规则/上限/为什么不是"放开边界"见 kernel/skill-dirs.mjs 头注）。
import { resolveSkillExtraDirs } from './skill-dirs.mjs'
import { createWorkflowEngine, discoverWorkflowsAll, matchAutoTrigger, validateWorkflow } from './workflow.mjs'
// 画布模型 ↔ YAML 序列化（UI Task 9）：workflow_command 的 save/save-raw 子命令用
// （workflow.mjs 兼容层未 re-export serializeWorkflow；直接取 DSL 实现，勿重复实现）。
import { serializeWorkflow, normalizeWorkflow, parseYaml, toModel } from './workflow-dsl.mjs'
// Task 6：工作流即工具——工作流按 expose 三态注册为具名工具（run_<slug>）注入工具池
import { buildWorkflowTools, listVisibleWorkflows, toolSourceSignature, createToolsViewCache } from './dyntools.mjs'
import { loadSettings, CUSTOMER_ID_ENV } from './settings.mjs'
import { createHooks } from './hooks.mjs'
import { normalizeApprovalMode, deriveApprovalMode } from './approval-mode.mjs'
// 循环模式选择态归一（2026-10-06 三层升级）：--loop-mode 解析与 control_request 共用同一口径
import { normalizeLoopMode, parseCustomLoopMode } from './loop-modes.mjs'
import { discoverAgentsMd, composeSystemPrompt, getPromptSegmentMeters, resolveSkillCatalogBudget } from './prompt.mjs'
// 过程文件归集约定（待办 860）：目录常量 + 提示词规则段 + 账本/回退计划的**唯一真源**。
// 这里只引提示词文案（启动即用）；归集的磁盘执行走 kernel/process-hygiene.mjs，
// 在轮次收尾时按需动态 import（普通会话不为它付模块解析成本）。
import { runReadonly } from './readonly.mjs'
import { KERNEL_VERSION, SCHEMA_VERSION, buildId } from '../version.mjs'
// 应用智控：内核侧 Spec 读取（纯函数）与权限规则注入
import { loadSpec, resolveScopedApp } from './app-spec.mjs'
// K0 观测 + K1.2 缓存命中计数（默认关：关闭时只付一次布尔判断，见 kernel/perf.mjs）
import { perfCount } from './perf.mjs'
import { syncAppPermissionRules } from './app-permissions.mjs'
// 【S3 内容协同】会话知识范围纳入**团队知识空间**（§5.9：检索范围默认跨全部空间、**不受模式影响**）。
// `safeTeamSpaceSpecs` 异常时返回 `[]`、未加入团队时也返回 `[]` ⇒ 与改造前逐字一致（零回归）。
import { safeTeamSpaceSpecs } from './team-sync.mjs'
// 应用智控：应用即工具（绑定到本会话的应用命令 → app_* 具名工具，Task 4.x）
import { buildAppTools } from './app-tools.mjs'

const REQUIRED_FORMAT = 'stream-json'

/**
 * workflow 引擎 `run()` 的**实际**返回（callee 缺口投影）：其 JSDoc 未登记返回 ⇒ tsc 推断出多成员
 * union，且每个成员的 `ok` 都是**宽 boolean**（非字面量）⇒ `if (r.ok)` **不可判别**（S2.1 纪律 5/1）。
 * 只投影本文件真正消费的键；`outputs`/`finalOutput`/`node` 是 workflow 自由结构的载荷（原样透传
 * 进 wire 帧，本文件不读其内部），故用 `unknown` 而非 `any`——`any` 会顺带关掉下游检查。
 * 正式补全在 kernel/workflow-engine.mjs 的任务（S2.1 逐文件棘轮后续批次）。
 * @typedef {{
 *   ok: boolean, error?: string, code?: string, status?: string, steps?: number, runId?: string,
 *   outputs?: unknown, finalOutput?: unknown, node?: unknown, auditPath?: string,
 *   errors?: unknown[], unresolved?: unknown[],
 * }} WfRunView
 */

function usage() {
  console.error(
    'Ponos-turbo kernel: --print --output-format stream-json --input-format stream-json ' +
    '[--verbose] [--dangerously-skip-permissions] [--auto-approve-high-risk] [--approval-mode <manual|auto|loose|bypass>] [--loop-allow <工具名,...>] [--permission-prompt-tool stdio] ' +
    '[--loop-mode <auto|react|plan|reflect|subagent>] [--router-model <m>] ' +
    '[--disallowedTools <list>] [--resume <id>] [--append-system-prompt-file <file>] ' +
    '[--model <m>] [--add-dir <dir>] [--allow-outside-dirs] [--agent <id>] ' +
    // 过程文件归集（待办 860）：`--process <collect|restore|list>` + `--phase <阶段名>`。
    // 写进 usage 是刻意的：这三个 op 是"用户回退 agent 过程文件"的唯一命令行入口，
    // 藏起来等于没有（用户只能去翻源码）。
    '[--process <collect|restore|list>] [--phase <name>]'
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
    // ★ 2026-10-18 ENG-04：循环任务放行白名单（逗号分隔工具名，支持 app_* 前缀通配）。
    //   缺省 null = 不放行（维持原行为）；灾难命令永不因白名单放行。
    loopAllowlist: null,
    // 三层升级（2026-10-06）：循环模式选择态（auto|react|plan|reflect，缺省 auto）与
    // 决策 LLM（路由模型，缺省当前激活模型）。两者都是**内核态**，不进 providerEnvSig。
    loopMode: null,
    routerModel: null,
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
    // 演化 P0：观测报告只读子命令（`--evolution-report [--window 30d]`），实现 kernel/readonly.mjs
    evolutionReport: false,
    // 演化 P1：三源归因视图（只读；`--window 30d` 生效），实现 kernel/readonly.mjs#runEvolutionAttribution
    evolutionAttribution: false,
    evolutionMetrics: false,
    params: false,
    mcpDraft: '',
    flowCandidates: false,
    evolutionFlow: false,
    window: null,
    scope: null,
    sessionId: null,
    project: null,
    from: null,
    to: null,
    // 过程文件归集（待办 860）：`--process <collect|restore|list>` + `--phase <阶段名>`。
    // 与 `--knowledge` 同款"单一聚合子命令"（见 kernel/process-cli.mjs）：三个 op 的差别
    // 只是"调哪个方法"，聚合后 cli.mjs 只多一个短路分支。
    process: null,
    phase: null,
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
      case '--loop-allow': out.loopAllowlist = next() ?? null; break
      // 三层升级（2026-10-06）：循环模式选择态 + 路由模型（bridge spawn 时下发）
      case '--loop-mode': out.loopMode = next() ?? null; break
      case '--router-model': out.routerModel = next() ?? null; break
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
      case '--evolution-report': out.evolutionReport = true; break
      // 演化 P1（D9）：候选只读镜像（投影+挖掘，stdout，不写盘）。**必须显式登记**——本 CLI
      // 对未知 `--` 参数静默忽略，漏了它会被无声吞掉（表现成"命令跑了但没输出"）。
      case '--evolution-candidates': out.evolutionCandidates = true; break
      // 演化 P1：三源归因视图（journal / 渲染层日志 / 转录 × 错误指纹）。同族纪律：必须显式登记。
      case '--evolution-attribution': out.evolutionAttribution = true; break
      case '--evolution-metrics': out.evolutionMetrics = true; break
      case '--params': out.params = true; break
      case '--mcp-draft': out.mcpDraft = String(argv[i + 1] || ''); i += 1; break
      case '--flow-candidates': out.flowCandidates = true; break
      case '--evolution-flow': out.evolutionFlow = true; break
      case '--window': out.window = next() ?? null; break
      // 过程文件归集（待办 860）：与 `--knowledge` 同一条纪律——**必须显式登记**，
      // 漏登记时 `--process restore` 会被静默吞掉（表现成"命令跑了但什么都没发生"）。
      case '--process': out.process = next() ?? null; break
      // 阶段名（归集/回退的目录与账本键）。缺省 = `session-<会话前 8 位>`。
      case '--phase': out.phase = next() ?? null; break
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

/**
 * 读取 `--append-system-prompt-file` 指定的提示词文件。
 *
 * ★★ 2026-10-18 ENG-09 修复：原来"读不到就返回空串"是**静默降级** ——
 *   模型会在丢失宿主身份与协议段的情况下继续跑（表现为"回答风格突变 / 不按协议出卡片"），
 *   而日志里一个字都没有。写侧（server/bridge.mjs）同一个问题：写失败被 `catch {}` 吞掉，
 *   仍照常把 `--append-system-prompt-file` 加进 argv ⇒ 内核读一个不存在的文件。
 *
 *   修法（**不阻断启动**，但绝不静默）：
 *   · 返回 `{ text, error }`：`error` 非空时调用方必须**留痕**（见下方 refreshSystemPrompt
 *     之前的 reporting 段），并把它带进报告；
 *   · 文件不存在但**没传**路径时不算错误（未使用该 flag 是合法形态）；
 *     传了路径却不存在/读失败，才算错误（那意味着桥侧写失败）。
 *
 * @param {string|undefined} path
 * @returns {{ text: string, error: string }}
 */
function readPromptFile(path) {
  if (!path) return { text: '', error: '' }
  if (!existsSync(path)) return { text: '', error: `prompt-file-missing: ${path}` }
  try {
    return { text: readFileSync(path, 'utf-8'), error: '' }
  } catch (e) {
    return { text: '', error: `prompt-file-unreadable: ${path} (${e && e.message ? e.message : String(e)})` }
  }
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
  // ★ 格式门禁**必须在子命令短路之后**（2026-10-21 修）。它原本就在这一行，
  //   结果把下面三类一次性子命令一起拦死：`--knowledge` / `--process` /
  //   `--usage|--audit|--agents`。判据：这些子命令是「跑一次、stdout 一行 JSON」，
  //   **从不读 stdin 流** ⇒ 要求 stream-json I/O 对它们毫无意义；而门禁先跑，
  //   它们就**永远**到不了自己的分支。
  //   为什么一直没被发现：桥侧（server/kernel-readonly.mjs:41）调用时**总是**带
  //   `--output-format stream-json --input-format stream-json`，测试夹具（
  //   kernel-tests/cli-subcommands.test.mjs、knowledge-parity.test.mjs）也照抄了这个
  //   形状 ⇒ 只有"人/agent 直接敲 CLI"这一条路会撞到。
  //   撞到的正是内核自己注入的沉淀指令：`kernel/memory.mjs#sedimentCommand` 生成的是
  //   `node "<cli>" --knowledge append --theme … --text …`（裸调用）⇒ 一条**死指令**：
  //   照着敲必报 `only stream-json I/O format is supported`。
  //   故门禁下移到 loop 入口（`const wire = makeWire()` 之前），只守它该守的那条路。
    // P5c（2026-10-27）：OPP-15 候选 → MCP 规格草稿（**写盘**，故不并进只读分支）。
  // 只写 `<home>/evolution/drafts/mcp-<fp>/spec.json`，绝不碰 mcp.json —— 装不装由人决定。
  if (args.mcpDraft) {
    const configDir0 = resolveConfigDir(process.env, homedir)
    try {
      const { buildMcpSpecDraft, writeMcpSpecDraft } = await import('./mcp-spec-draft.mjs')
      const built = buildMcpSpecDraft({ candidate: { subject: String(args.mcpDraft) } })
      const out = built.ok ? writeMcpSpecDraft({ home: configDir0, draft: built }) : built
      console.log(JSON.stringify(out))
      return out.ok ? 0 : 1
    } catch (e) {
      console.log(JSON.stringify({ ok: false, reason: e?.message || String(e) }))
      return 1
    }
  }

// 只读子命令（stdout JSON，不进 loop）。
  // 聚合实现 kernel/readonly.mjs（kernel 自读 transcript）；bridge 只薄转发。
  // 演化 P0/P1：--evolution-report / --evolution-candidates / --evolution-attribution [--window 30d] 同族短路
  // （观测报告、候选镜像、错误指纹归因；镜像 --audit 的"stdout JSON 不进 loop"）。多 flag 同传非契约用法，按登记顺序取先。
  if (args.agents || args.usage || args.audit || args.evolutionReport || args.evolutionCandidates || args.evolutionAttribution || args.evolutionMetrics || args.evolutionFlow || args.flowCandidates || args.params) {
    const mode = args.agents ? 'agents' : args.usage ? 'usage' : args.audit ? 'audit' : args.evolutionReport ? 'evolution-report' : args.evolutionAttribution ? 'evolution-attribution' : args.evolutionMetrics ? 'evolution-metrics' : (args.evolutionFlow || args.flowCandidates) ? 'evolution-flow' : args.params ? 'params' : 'evolution-candidates'
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

  // 过程文件归集子命令：--process <op>（stdout JSON，不进 loop；待办 860）。
  // 与 `--knowledge` 同款短路 + 同款"永不抛异常给调用方"契约（异常折成 code=1 + error）。
  // 项目根取 `--add-dir` 的首项（与引擎的 cwd 同一口径：工具的相对路径都相对它解析）。
  if (args.process) {
    const projectRoot = args.addDirs[0] || process.cwd()
    try {
      const { runProcessCommand } = await import('./process-cli.mjs')
      const { output, code } = await runProcessCommand({
        op: args.process,
        projectRoot,
        // `--phase` 必须经此显式转发：parseArgs 解析出的字段**不会自动**流到子命令，
        // 漏一个键就等于该 flag 从未存在（本文件反复踩过的静默失效）。
        phase: args.phase,
        sessionId: args.resume || null,
      })
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
      // 索引存储升级（2026-09-29）：`migrate-index --to sqlite` 的目标后端。
      // `--to` 早就在 parseArgs 里登记（会话范围语义 `--from/--to`），但**没有**转发给知识内核
      // —— 与 `--spaces`/`--doc`/`--related` 同一类"漏登记即静默失效"的坑：漏转发时
      // migrate-index 收到的 `to` 是 undefined ⇒ 报 bad-target（看得见），而若将来有别的 op
      // 读它，漏转发的表现就会是"参数传了没生效"（看不见）。故在此显式转发。
      // 注：`--to` 的**登记**已在 parseArgs（既有 case），本行只补转发。
      to: args.to,
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

  // 格式门禁（见 main 开头的说明：必须在所有一次性子命令短路**之后**）。
  // 到这里只剩长驻 loop（readline 逐行读 stream-json 输入帧），此时缺标志是**真错**：
  // 宿主应经 bridge spawn，而 bridge 恒带这两个标志。
  if (args.outputFormat !== REQUIRED_FORMAT || args.inputFormat !== REQUIRED_FORMAT) {
    console.error(`kernel: only ${REQUIRED_FORMAT} I/O format is supported`)
    return 2
  }

  const wire = makeWire()
  // 慢盘豁免的**事前声明**接线（2026-09-23 会话健康快照 批 3）：内核在同步落盘写**之前**声明
  // "我要等盘"，经 wire 发 `system/disk_wait` 给桥 ⇒ 桥开一个有界豁免窗口，避免"正在等磁盘"
  // 的会话被 20 分钟轮次回收线误杀。★ 只能事前声明：同步写期间主线程停摆，心跳发不出来。
  // 声明条件与窗口由纯函数 judgeDiskWait 决定（P95 ≥ 阈值才声明 ⇒ 正常盘零额外帧）。
  configureDiskWriter({ onDeclare: (d) => wire.diskWait(d) })
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
  // 演化P0·P-a：guard_turn 已记录到的 turnIndex（防同轮重记；跨轮持久，main 作用域）
  let lastGuardTurnRecorded = 0
  // T0.3：轮级账本已记录到的 turnIndex（防同轮重记；跨轮持久，main 作用域）
  let lastTurnLedgerRecorded = 0
  // T3.2：本轮生效的治理策略（A/B 分组键；环境变量是静态的 ⇒ 懒算一次即可）
  let activeStrategiesCache = null
  // T0.1（计量补全）：**工具面真实字节**的读数缓存（跨轮持久，main 作用域）。
  //   why：`inject_snapshot.segments` 里 `toolSchema` 段此前取 `getPromptSegmentMeters().toolSchemaBytes`
  //   —— 那是 system 文本里「可用工具：…」**那一行**的字节（实测 ≈237 B），而真正随请求发出去的
  //   tools[] schema 面（实测 ≈31 KB）**完全不进账**（少记 99%）⇒ "省了多少"无基线。
  //   why 量在 cli 而不是 engine：engine 每轮发的是 `tools.toolSchemas()`（engine.mjs:1265/2631），
  //   cli 持有**同一个** registry（engine.tools）⇒ 在这里量口径与真实请求一致，且不必碰
  //   engine 的热路径（那里改动风险高）。
  //   why 缓存：名字集合不变时 schema 视为不变（工具描述/结构是进程内静态的）；动态工具
  //   （工作流即工具）增删会改名字集合 ⇒ 缓存随之失效。省掉每轮 JSON.stringify(~31 KB)。
  let lastToolFace = { key: null, bytes: 0, count: 0 }
  // P4-1：bridge 落盘的 providers.json → 注册表播种（未激活时生效；激活后固定）
  // ★ 2026-09-27（遗留 C-⑥ 接线）：**未放行 provider 时不播种**。
  //   病根（EGRESS_BOUNDARY 原登记为"尚未接线"的那条）：`seedFromFile` 把 providers.json 里的
  //   `apiBaseUrl`/`authToken` 灌进内核注册表 —— 那是**磁盘上的一份凭据**，绕过了"未放行 ⇒
  //   不注入凭据"的 env 级收口（桥会剔除 spawn env、清空 settings.json#env 兜底，但管不到这个文件）。
  //   它今天发不出去**只因为** `kernel/api.mjs#detectProtocol` 是纯 env 判据（`PONOS_BASE_URL`），
  //   而那条契约被 `api-protocol.test.mjs` 锁着、明确不得读 registry ⇒ 一旦有人把它改成
  //   "读注册表兜底"（合理的改动方向），未放行的内核**立刻**能带着这份凭据出网 —— 是洞不是设计。
  //   ⇒ 修在**播种这一步**：拿不到 provider 放行就不播种，凭据根本不进内核（比"等协议检测收紧"可靠）。
  //   ★ 存量零变化（已实测三态）：`network` 键缺失 ⇒ `capabilitiesOf` 走 legacy 兜底
  //   `['provider','web','browser','shell']` ⇒ 照旧播种；新装默认清单含 provider ⇒ 照旧；
  //   只有用户**显式**把 provider 排除在放行表外（或放行表读不懂 ⇒ 按最严 `[]`）时才跳过。
  if (providerCapabilityAllowed(configDir)) {
    // ★ 2026-10-02（真机实测事故）播种前加**陈旧比对**（机理与事故全文见 provider.mjs#seedFromFile 头注）：
    //   本文件写入端已移除、磁盘上的最后一份会永久冻结；照播则每次内核启动都用数周前的
    //   端点/凭据覆盖用户当下的选择（registry 激活后 env 失效）。不一致 ⇒ 不播种 + 出声。
    const seedResult = seedFromFile(join(configDir, 'providers.json'), {
      expectActiveProvider: readActiveProvider(configDir),
    })
    if (seedResult.reason === 'stale') {
      console.warn(`[kernel] providers.json 陈旧：activeProvider=${seedResult.fileActiveProvider}`
        + ` ≠ config.json 的 ${seedResult.currentActiveProvider} ⇒ 跳过注册表播种`
        + '（防陈旧端点/凭据覆盖本次会话的 provider 选择）')
    }
  } else {
    // 出声（不许静默）：否则"模型突然没有 provider"在线上无从归因
    console.warn('[kernel] 未放行 provider 能力（config.json#network.capabilities）：'
      + '跳过 providers.json 播种 —— 内核不持有该凭据（要启用请在 config.json 里显式放行 provider）')
  }
  // P4-3 分层 settings：customer（PONOS_CUSTOMER_ID）< user（configDir/settings.json）
  // < project（cwd/.ponos/settings.json）< local。
  // settings.env 仅兜底（spawn env 快照仍权威）：缺失键才写入 process.env。
  // ★★ 2026-09-26（E2 Task 4 审查挖出的**闸绕道**，fail-open，已修）：
  //   这里的兜底必须**剔除凭据键**。否则：`buildChildEnv` 在"未放行档"下把凭据从 spawn env 里
  //   `delete` 掉了（Task 2 的出网闸），但内核**又从这里把同一份凭据从 settings 的 env 兜底补回**
  //   `process.env` ⇒ "未放行 ⇒ 内核拿不到模型配置"**当场失效**（闸被自己的兜底绕过）。
  //   ★ 洞**不只**在新增的 customer 层：`<cwd>/.ponos/settings.json`（**既有** project 层，
  //   自 2026-09 的 P4-3 起）与 user/local 层**同形状** —— `settings.env` 是用户可写文件里的任意
  //   键值对，把 `PONOS_API_KEY` 写进去即可复活出网能力。
  //   ⇒ 修在**兜底处**（而不是逐层打补丁）：一次覆盖所有层，且与 Task 3 的口径一致
  //   —— **凭据只经 spawn env（由 bridge 从密码库解密后注入）或进程原有 env**，
  //   绝不由"磁盘上的配置文件"回流。
  // ★ 剔除集合 = `credentialEnvKeys()`，**与出网闸 `PROVIDER_CREDENTIAL_ENV_KEYS` 同一真源、
  //   同一集合**（`server/bridge.mjs:548` 就是 `credentialEnvKeys()`）。这是本修复的**结构性关键**：
  //   只要"闸删掉的键"与"兜底不收的键"是同一个集合，就**不可能**再出现"闸删 A、兜底把 A 补回"的
  //   绕道；两处各写一份名单则必然会漂移（本仓已多次栽在这上面）。
  //   注意它比"秘密子集"更宽：含 `PONOS_BASE_URL`/`PONOS_MODEL`/`PONOS_API_FORMAT` 与视觉双前缀
  //   —— 这是**故意**的：闸的语义是"未放行 ⇒ 内核拿不到模型配置"，只剔令牌而不剔端点，
  //   等于留着半边绕道（有端点、没令牌虽发不出去，但"配置回流"本身就不是配置该走的路径）。
  //   ⚠️ 后果如实登记：不经 bridge 裸跑内核（`node kernel/cli.mjs`）时，**配置文件里的端点/模型/
  //     令牌都不再生效**，需由外部环境变量提供 —— 这与 Task 3 已确立的"settings.json 不再存明文"
  //     口径一致（令牌那条路在 Task 3 就已经断了）。
  //   非凭据键（如 `PONOS_LOG_LEVEL`、用户自定义键）的兜底**保持不变**。
  const settings = loadSettings({ configDir, cwd: args.addDirs[0] || '', local: {} })
  // P1.1：Atlas 开关/预算（env > settings.atlas > 默认）。settings 里可不写 atlas 子键
  // （不进 SETTINGS_DEFAULTS，避免被 diffFromDefault 误报成配置漂移）。
  const atlasSettings = resolveAtlasSettings({ settings: settings.merged })
  // 主会话区块缓存：注入只读 meta 快照（不构建/不校验）；这里再按 buildId + 预算
  // 缓存渲染结果，避免每轮重算 L1 文本（注入账仍按每次实际发送累计，那是真实请求面）。
  // 根口径与引擎一致：GUI 传 `--add-dir <项目>`；裸跑内核（无该参数）用 cwd。
  let atlasMainCache = { key: '', text: '' }
  const atlasRoot = args.addDirs[0] || process.cwd()
  // 显式 L1 预算（一次读出，主块/lane 共用；未设置 ⇒ undefined）
  const l1ExplicitKb = () => {
    const v = explicitParams(readConfigObject(configDir))['context.injectBudgetKb']
    return typeof v === 'number' ? v : undefined
  }
  const atlasMainBlock = () => {
    if (chatMode || !atlasSettings.enabled) return ''
    // P4：L1 参数面 `context.injectBudgetKb`（**仅用户显式设置时**覆盖；未设置=沿用既有预算链）。
    // 为什么用显式值而不是默认值：默认值是我们的建议值，拿它去覆盖 settings/env 的预算
    // 会让"没改配置的人"行为也变 —— 参数面第一条纪律是"没人改 = 与今天逐字一致"。
    const atlasBudget = atlasBudgetBytes({ explicitKb: l1ExplicitKb(), fallbackBytes: atlasSettings.injectMaxBytes })
    const built = buildAtlasBlock({
      root: atlasRoot,
      settings: settings.merged,
      configDir,
      budget: atlasBudget,
    })
    if (!built.text) return ''
    const key = `${built.atlas?.meta?.buildId || ''}:${atlasBudget}`
    if (key !== atlasMainCache.key) atlasMainCache = { key, text: built.text }
    return atlasMainCache.text
  }
  // 子代理 lane：独立预算（默认 2048）。同样按代缓存（spawn 可能很频繁）。
  let atlasLaneCache = { key: '', text: '' }
  const atlasLaneBlock = () => {
    if (chatMode || !atlasSettings.enabled) return ''
    const built = buildAtlasBlock({
      root: atlasRoot,
      settings: settings.merged,
      configDir,
      // lane 也用同一份显式参数（判定见 param-surface#atlasBudgetBytes：半额、不超主预算）
      budget: atlasBudgetBytes({ explicitKb: l1ExplicitKb(), fallbackBytes: atlasSettings.injectMaxBytes, lane: true, laneFallbackBytes: atlasSettings.laneInjectMaxBytes }),
      lane: true,
    })
    if (!built.text) return ''
    const key = `${built.atlas?.meta?.buildId || ''}:${atlasSettings.laneInjectMaxBytes}`
    if (key !== atlasLaneCache.key) atlasLaneCache = { key, text: built.text }
    return atlasLaneCache.text
  }
  const gatedEnvKeys = new Set(credentialEnvKeys())
  for (const [k, v] of Object.entries(settings.merged.env || {})) {
    if (gatedEnvKeys.has(k)) {
      // 不写、也不清：进程 env 里若**本来就有**（bridge 注入 / 用户外部设置）则保持原样；
      // 若本来没有，就保持没有（fail-closed）。★ 尤其**不得**用配置文件的值去补回或覆盖。
      continue
    }
    if (v !== undefined && process.env[k] === undefined) process.env[k] = String(v)
  }
  // 兼容垫片：settings.json 里可能仍是历史版本的旧名（Anthropic 兼容协议时代沿用），
  // 在此统一映射到 PONOS_* 主名，保证配置来源与进程 env 两条路径口径一致。
  applyLegacyEnvAliases()
  // 内核结构化日志（R5-1）：stderr JSON 行，级别过滤经 PONOS_LOG_LEVEL
  const log = createLogger({ level: process.env.PONOS_LOG_LEVEL || 'info', sid: sessionId })

  // 【E2 Task 4 一客一策分层】生效清单（可观测性）。
  // 挂在这个**既有**日志面上（内核 stderr JSON 行，桥/诊断报告已在采集），不新增路由 ⇒
  // 不动契约快照、不碰 scopeCount 已用满的范围登记 —— 这是本任务选的"最小侵入"落法。
  // 逐项给出"生效值 + 来源层"（`layer` ∈ user/customer/project/local），值**已脱敏**
  // （`settingsProvenance` 对 `env` 与密钥类键打码；详见其注释）。
  // ★ **只在客户层参与时出声**：未设 `PONOS_CUSTOMER_ID` 的存量机器一行日志都不多 ——
  //   "存量零变化"在日志面同样成立（有测试钉住未设 env 时 customerLayer==='unset'）。
  if (settings.customerLayer === 'active') {
    log.info(`[settings] 客户层生效（${CUSTOMER_ID_ENV}=${settings.customerId}）`, { provenance: settings.provenance })
  } else if (settings.notice) {
    // 非法 id：必须出声（可能有人在试探路径穿越），且客户层已被跳过。
    log.warn(`[settings] ${settings.notice}`)
  }

  // 会话知识范围（2026-09-15，P1「会话模式关联经验库之外的知识库」，spec §3.2）。
  //
  // 组成 = 内置经验类空间 ∪ `--knowledge-spaces` 显式关联。**一处解析、两处消费**：
  //   ① 注入层（下方 buildKnowledgeInjection 的 spaces）；
  //   ② 工具层（createEngine opts.knowledgeSpaces → createToolRegistry）。
  // 双层同源是硬要求而非实现便利：注入（被动通道）与工具（主动通道）口径不一致时，模型会
  // 看到"注入里没有这条、检索却说自己没权限"的自相矛盾，比单纯少个能力更难排查。
  //
  // 放在 log 之后 / createEngine 之前：工具层白名单在引擎构造时就要值。纯目录发现、无 IO 写盘。
  // ★ `configDir` 的登记在 **callee**（kernel/knowledge.mjs#resolveSessionKnowledgeScope 的 @param）——
  //   这里**不能**用调用点断言：knowledge-scope-plumbing.test.mjs 以正则钉住**本行的字面调用形态**
  //   （callee 名后紧跟 `({ configDir, requested: …`），加断言即红；而纪律禁止改测试迁就类型
  //   ⇒ 只能走"登记 callee 的 JSDoc"这条根治路（F2 的 R1 改法②：选项对象参数 ⇒ 用 `@param`）。本行逐字未改。
  const knowledgeScope = resolveSessionKnowledgeScope({ configDir, requested: args.knowledgeSpaces, extraSpaceSpecs: safeTeamSpaceSpecs(configDir) })
  if (knowledgeScope.missing.length) log.warn('knowledge scope: 关联的库不存在（已忽略）', { missing: knowledgeScope.missing })
  if (knowledgeScope.truncated) log.warn('knowledge scope: 关联数量超上限（已截断）', { max: MAX_ASSOC_SPACES, dropped: knowledgeScope.dropped })

  // 知识空间**只读**放行（P3，2026-09-20）：把范围内空间的实际根算好交给工具层。
  //
  // why 在 cli 算、而不是让 tools 自己读配置：`kernel/tools.mjs` 的纪律是"不知道配置根"
  // （它连 configDir 都没有，只有派生出的 memoryRoot）——路径一律由上层解析，工具层只做边界判定。
  //
  // 为什么必须按**范围**过滤而不是把整棵知识根交出去（安全要点）：只读白名单一旦含
  // `<配置根>/knowledge/spaces`，就等于**所有**空间的文件都可 Read（含本会话未关联的库），
  // 而"关联到当前会话"正是用户表达授权的唯一动作——绕过它会让授权的语义在文件层失效。
  // 故这里逐空间取 root（`{ id, root }`：id 供工具回执判断"这个空间能否 Read"）。
  // 范围为空数组（本会话没有任何可检索库）时给空数组：工具层据此 fail-closed（一个都不放行）。
  const knowledgeReadDirs = knowledgeScope.spaces.length
    // ★ 同上：`configDir` 的登记在 callee（kernel/knowledge.mjs#discoverSpaces 的 @param）。
    //   knowledge-read-boundary.test.mjs 以**逐字正则**钉住本行调用形态 ⇒ 不能加调用点断言。
    ? discoverSpaces({ configDir, extraSpaceSpecs: safeTeamSpaceSpecs(configDir) })
        .filter((s) => s.root && knowledgeScope.spaces.includes(s.id))
        .map((s) => ({ id: s.id, root: s.root }))
    : []
  log.info('knowledge read scope', { spaces: knowledgeReadDirs.map((s) => s.id) })

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

  /**
   * pid 是否仍存活（SESS-06，2026-10-18）。
   *
   * ★ 语义细节（错了会把"活着"判成"死了"）：
   *   `process.kill(pid, 0)` 只做存在性探测、不发信号。
   *   · 正常 → 返回 true（进程存在）
   *   · 抛 **ESRCH** → 进程确实不存在（唯一可判定"已死"的情形）
   *   · 抛 **EPERM** → 进程**存在**但当前用户无权限（必须当作存活！）
   *   漏掉 EPERM 会把别的用户的进程误判成已死，进而误清 marker、误报"崩溃恢复"。
   *
   * ★ 已知局限（诚实记录）：pid 可能被系统复用 —— 旧 marker 的 pid 恰好被新进程占用时，
   *   只能判为"存活"。此时我们**偏向保守**（不报崩溃），代价是偶尔少报一次崩溃恢复。
   *   彻底解决需记录进程启动时间（Windows 可用 CreationTime），成本高于收益，本次不做。
   */
  function isPidAlive(pid) {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) return false
    try {
      process.kill(n, 0)
      return true
    } catch (e) {
      // ESRCH = 进程不存在（**唯一**可判死的信号）
      // EPERM = 进程存在但当前用户无权限 ⇒ **必须当作存活**（否则会误清 marker、误报崩溃）
      return e?.code !== 'ESRCH'   // EPERM / 其它错误一律按存活处理（保守）
    }
  }

  /**
   * 清扫 runDir 下的**孤儿 marker**（SESS-06，2026-10-18）。
   *
   * 为什么需要：marker 按 sessionId 命名，启动只清自己那一个。其它 session 的孤儿 marker
   * （对应进程早已不存在）会永远留在 runs/ 里，越积越多且再也无人读 ——
   * 用户看到一堆 `.running` 会以为"还在跑"。
   *
   * 安全边界：**只删 `.running` 及其伴生的 `.err`**，不动目录里其它任何东西。
   * @returns {number} 清掉的 marker 数
   */
  function sweepStaleMarkers(dir) {
    let removed = 0
    let names = []
    try { names = readdirSync(dir) } catch { return 0 }
    for (const name of names) {
      if (!name.endsWith('.running')) continue
      const fp = join(dir, name)
      let prev = {}
      try { prev = JSON.parse(readFileSync(fp, 'utf-8') || '{}') } catch { /* 坏文件也按孤儿清 */ }
      if (isPidAlive(prev.pid)) continue
      try {
        rmSync(fp, { force: true })
        rmSync(fp + '.err', { force: true })   // 伴生的崩溃快照一并清（marker 都清了，它没人读）
        removed += 1
      } catch { /* 并发删除/权限问题：忽略，不影响启动 */ }
    }
    return removed
  }

  // 启动即清扫：把自己之外那些"进程已不存在"的 marker 收掉
  const swept = sweepStaleMarkers(runDir)
  if (swept > 0) log.info('swept stale run markers', { count: swept, dir: runDir })

  try {
    if (existsSync(marker)) {
      const prev = JSON.parse(readFileSync(marker, 'utf-8') || '{}')
      // ★★ 2026-10-18 SESS-06 修复：**先校验 pid 是否仍存活**，再决定说什么。
      //   原来只判断"文件存在"就无条件当作"上次崩溃" —— 而：
      //     · 进程被带外杀死（任务管理器/SIGKILL/断电）时 marker 自然残留，那是**正常可解释的**；
      //     · 并行开第二个实例（同 sessionId）时"上次崩溃"更是**假信号**。
      //   假信号比没信号更害：它会把排障引到完全错误的方向。
      const prevAlive = isPidAlive(prev.pid)
      if (prevAlive) {
        // 存活 ⇒ 明确说是"可能有另一个实例在跑"，且**不发** crash_recovered
        log.warn('previous run marker is still alive (another instance may be running)', {
          pid: prev.pid, prevTs: prev.ts,
        })
      } else {
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
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf-8')
    // 崩溃自描述：未捕获异常原文 + 退出码落盘（供下次 resume 读回日志）。
    // 优雅退出（shutdown）先删 marker 再 exit，exit 钩子里 marker 已不存在 → 不写。
    process.on('uncaughtException', (e) => {
      try {
        writeFileSync(marker + '.err', JSON.stringify({ message: String(e?.message || e), stack: String(e?.stack || '').slice(0, 4000), ts: new Date().toISOString() }), 'utf-8')
      } catch {}
      // ★★ 2026-10-18 ENG-10 修复：**记录后必须退出（fail-fast）**。
      //
      // 原来只写 .err、**不退出**。而 .err 的全部价值在于"下次 resume 读回它"——
      // 进程不退出，就永远走不到那条路，崩溃自描述形同虚设。
      // 更糟的是它的"进程级硬看门狗"只处理「**无输出**超过阈值」：
      // 若进程还在偶发输出（半死状态），看门狗也不会触发 ⇒ 表现为"活着但行为异常"，
      // 比直接崩更难排查（用户看到的是"卡住/答非所问"，而不是"崩了"）。
      //
      // Node 官方明确：uncaughtException 之后进程状态**不可信**（可能有半完成的 I/O、
      // 被破坏的全局状态）。继续跑等于在未知状态上提供服务。
      // 退出码 70（EX_SOFTWARE）：让 bridge 的 close 事件与上层重启策略能区分
      // "软件错误崩溃" 与 "EPIPE 优雅退出(0)"。
      process.exit(70)
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
    // 事件循环漂移探针（2026-09-21 失速事故）：旧指纹（`Socket:N + 零 CPU + 零 wire`）
    // 只能说明"线程没在干活"，分不出两种成因，而两者处置方向相反：
    //   ① **同步阻塞**：某处 execSync/execFileSync（git 索引、taskkill 杀树…）把整个
    //      事件循环冻住 ⇒ **所有 timer 一起停摆**（实测 2026-09-21：924s 静默期内该进程
    //      连 30s 的硬看门狗、100s 的心跳都没跑过；外部实测零 TCP、CPU delta=0）。
    //      修法＝给同步调用加超时/改异步。
    //   ② **续体彻底丢失**：timer 还在正常跑，只是请求的续体永不被调度（2026-09-12 形态）。
    //      修法＝请求级绝对超时（与 timer 无关的兜底）。
    // 采样定时器的漂移（实际触发 − 应触发）正是"事件循环被别人占用多久"的直接度量：
    //   · loopDriftMaxMs ≈ idleMs ⇒ ①（整段静默期循环都没在跑）—— 本次事故即此形态；
    //   · loopDriftMaxMs 远小于 idleMs ⇒ ②（循环活着，只是请求无进展）。
    // 阈值 50ms：Windows 定时器固有抖动 0–15ms（与 server/bridge.mjs 的 K0.2 探针同口径）。
    const LOOP_PROBE_MS = 100
    const LOOP_BLOCK_MIN_MS = 50
    let loopProbeAt = Date.now() + LOOP_PROBE_MS
    let loopDriftMaxMs = 0
    setInterval(() => {
      const nowMs = Date.now()
      const drift = nowMs - loopProbeAt
      // 基准每 tick 重置：一次长阻塞后不重置的话，后续每次都相对旧基准算出虚高漂移
      loopProbeAt = nowMs + LOOP_PROBE_MS
      if (drift > LOOP_BLOCK_MIN_MS && drift > loopDriftMaxMs) loopDriftMaxMs = drift
    }, LOOP_PROBE_MS).unref?.()
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
      // 判据从"有没有输出"升级为"有没有在飞的工作"：长前台工具（Bash timeout_ms 可到
      // 30min、OCR、子代理）执行期间内核按设计零输出，旧判据必然在 900s 处把工具连内核
      // 一起杀掉（刚放宽到 1800s 的工具 deadline 形同虚设）。心跳过期则自报不可信，
      // 一律回落按静默判死——"修误杀"不得变成"放过真死"。
      const hbVerdict = judgeHardWatchdog({
        turnActive: isTurnActive(), idleMs: idle, limitMs: limit,
        // 心跳时刻取自 protocol（单一真源：与 lastWireWriteAt 并排维护，不会漂移成两份时间）
        heartbeat: { at: wireHeartbeatAt(), inflight: hbState.inflight },
        now: Date.now(), toleranceMs: HB_TOLERANCE_MS,
      })
      if (hbVerdict.trip) {
        try {
          // 现场指纹（2026-09-12 异步链失活排查）：失活形态无 JS 栈可抓，句柄清单是
          // 唯一现场证据——"stdio-only + 零定时器"即失活签名；下次复发无需外部
          // inspector attach，marker.err 自带指纹。另记 wire 写失败计数：写失败=stdout
          // 实际已断，"静默时长"不再可信（那种情形该由桥侧 close 处理）。
          let fingerprint = {}
          try {
            // R5 Node 私有 API：`process._getActiveHandles` 无公开类型（@types/node 未收录）⇒ 定向补类型视图，
            // 不用 ts-expect-error/ts-ignore 抑制（本仓纪律：不许抑制；这两个词不带 `@` 是刻意的——带上
            // 就是抑制指令的语法形态，红线扫描会把本条"解释为什么不用"的注释误判成"用了"）。
            // **不改运行逻辑**：仍是同一对象、同一方法的同一调用（断言只给 process 加一层"含该私有方法"的
            // 类型视图；圆括号不进 AST ⇒ 本行 AST 与改前逐节点一致）。收口条件：@types/node 收录该私有方法。
            const hs = ((/** @type {typeof process & { _getActiveHandles: () => Array<{ constructor?: { name?: string } }> }} */ (process))._getActiveHandles() || []).map((h) => h?.constructor?.name || '?')
            // loopDriftMaxMs / loopProbeLagMs（2026-09-21）：把"静默的成因"直接写进现场，
            // 旧指纹分不出同步阻塞与续体丢失（见上方探针注释的两支判据）——
            //   · loopDriftMaxMs ≈ idleMs ⇒ 事件循环被同步调用冻住（①）；
            //   · 远小于 idleMs ⇒ 续体丢失（②）。
            // loopProbeLagMs＝"距上次探针 tick 多久"，作解冻瞬间的即时佐证：此刻它若也
            // 约等于 idleMs，说明连 100ms 的探针自己都刚被冻醒，① 基本可定。
            // heartbeat（2026-09-21 P2）：自杀瞬间的**心跳现场**——ageMs 与 idleMs 同量级说明
            // 连心跳都发不出（事件循环冻住/进程真死）；ageMs 很小而 inflight>0 说明内核一直
            // 自报"在忙"，那是另一种成因（在飞计数泄漏），修法完全不同（该查工具续体）。
            fingerprint = { handles: hs.reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), {}), idleMs: idle, awaitingUser: awaiting, loopDriftMaxMs, loopProbeLagMs: Date.now() - loopProbeAt, wireWrite: wireWriteStats(), heartbeat: { ageMs: wireHeartbeatAt() > 0 ? Date.now() - wireHeartbeatAt() : -1, inflight: hbState.inflight, phase: hbState.phase, toleranceMs: HB_TOLERANCE_MS } }
          } catch {}
          writeFileSync(marker + '.err', JSON.stringify({ message: `硬看门狗：wire 无输出 ${Math.round(idle / 1000)}s（>${Math.round(limit / 1000)}s${awaiting ? '，含等待用户展期' : ''}），疑似异步链失活`, stack: '(hard-watchdog, no JS stack)', fingerprint, ts: new Date().toISOString() }), 'utf-8')
        } catch {}
        // 自杀前写可见收尾（2026-09-21 失速事故修复）：旧行为直接 exit(7)，**自杀前不写
        // 任何 result 帧** —— 桥只看到 close、GUI 静默解锁，任务无声中断，用户体感就是
        // "跑到一半停住、也没有任何理由"。本文件在审批展期那段注释里已经记过同一缺陷
        // （"用户思考超过 hardTimeoutMs 就被 exit(7) 杀掉…桥只见 close、作答落空"），
        // 这里补上同一处方。
        // 帧序：先 assistant 文本（承载"为什么停、接下来怎么办"），再 result 关闭轮次 ——
        // writeLine 见 type==='result' 自动 setTurnActive(false)，桥据此清轮次与未决等待、
        // 转发 GUI 解锁。subtype 保持默认 success，让 GUI 走通既有收尾分支；语义靠
        // is_error 标记传达（改 subtype 有 GUI 认不出、反而不解锁的风险）。
        try {
          const secs = Math.round(idle / 1000)
          // ★ 刻意用 writeFileSync(1, …) 同步写 fd 1，**不用** wire/writeLine：后者是
          // `stream.write()` 异步写，而 `process.exit()` 会丢弃管道中尚未 flush 的 stdout
          // 数据 —— 这两帧恰是"用户唯一能看到的收尾"，丢了就等于什么都没修（原设计用
          // writeFileSync 落 marker.err 正是同一理由：自杀路径上只有同步 IO 可信）。
          // 帧形状与 protocol.mjs 的 writeLine 逐字一致（那里也是 JSON.stringify + '\n'，
          // 无额外字段注入），故桥侧的既有解析不变。
          const frames = [
            {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: `【内核已自动中止：上游 ${secs} 秒无任何输出（超过 ${Math.round(limit / 1000)} 秒上限）。\n`
                    + '常见原因是模型服务端排队或网络挂起，通常不是任务本身出错。\n'
                    + '可发送「继续」重试本任务；若反复出现，建议换用其他 provider，或新开会话以缩短上下文后重试。】',
                }],
              },
            },
            {
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0 },
              is_error: true,
              reason: 'hard-watchdog-no-output',
            },
          ]
          for (const f of frames) writeFileSync(1, JSON.stringify(f) + '\n')
        } catch { /* stdout 可能已断：写失败不得阻止退出（那种情形由桥侧 close 收口） */ }
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
  // P4（2026-10-27）：L1 参数面 `model.preferred` 进来了 ⇒ 四级兜底
  //   --model > preferred > provider.model > settings.model（顺序的唯一实现在 param-surface#pickModel）
  //   为什么 preferred 排在 provider.model 之前：否则"改首选模型"这条提案永远不生效；
  //   为什么排在 --model 之后：命令行显式指定不能被悄悄盖掉。
  const paramVals = resolveParams(readConfigObject(configDir))
  const preferredModel = typeof paramVals['model.preferred'] === 'string' ? paramVals['model.preferred'] : null
  let model = pickModel({
    arg: typeof args.model === 'string' ? args.model : null,
    preferred: preferredModel,
    providerModel: getProvider().model,
    settingsModel: settings.merged.model,
  })
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
    // ★ 2026-10-26 档位机制：以下 6 项此前有 4 项**没进 context**（summarize 只能走 env
    //   兜底）⇒ settings 里配了也不生效。现全部由 resolveCompactSettings 统一展开，
    //   单一真源 = COMPACT_PROFILES。
    maxRetainRatio: compactCfg.maxRetainRatio,
    keepTargetRatio: compactCfg.keepTargetRatio,
    escalateTokenFloor: compactCfg.escalateTokenFloor,
    minSummaryIntervalCalls: compactCfg.minSummaryIntervalCalls,
    maxMessages: compactCfg.maxMessages,
    // ★ 2026-10-26：`estimate` 必须透传 tools —— 请求体真实构成是 system + tools + messages，
    //   只传前两者会让 110 个 MCP 工具（≈100K token）在估算里"不存在"（压缩结构性失明的根因，
    //   见 context.mjs#toolsTokens 的长注释）。调用方（engine/compactor）负责传同一份 schemas。
    estimate: ({ system, messages, tools }) => estimateRequest({ system, messages, tools }),
    estimateMessage,
    estimateHistory,
  }
  // 2026-10-26 档位回执：**启动时发一次**（不每步发，防事件洪泛），让 GUI 与日志都能看见
  // "本次会话实际用哪一档、展开了什么参数"。source='fallback' 时带 requested ⇒
  // "档位名填错、实际回落默认"不再静默（否则用户以为开了 long-task，实际仍是 balanced）。
  try {
    wire?.system?.('compact_profile', {
      profile: compactCfg.profile,
      source: compactCfg.profileSource,
      ...(compactCfg.profileRequested ? { requested: compactCfg.profileRequested } : {}),
      window: contextWindow,
      maxMessages: compactCfg.maxMessages,
      keepTargetRatio: compactCfg.keepTargetRatio,
      retainRatio: compactCfg.retainRatio,
      maxRetainRatio: compactCfg.maxRetainRatio,
      escalateTokenFloor: compactCfg.escalateTokenFloor,
      minSummaryIntervalCalls: compactCfg.minSummaryIntervalCalls,
    })
  } catch { /* 事件失败不影响主流程 */ }
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
  // ★ 前置括号断言桥接（callee 缺口）：`wire` / `getAnchorSource` 是 callee 运行时实际接收项，其 JSDoc 未登记
  //   ⇒ TS2353。正式补全在 kernel/health.mjs 的棘轮批次（本仓暂无对应任务锚点）。
  const health = createHealth(/** @type {Parameters<typeof createHealth>[0] & { wire?: typeof wire, getAnchorSource?: () => unknown }} */ ({ wire, model, contextWindow, env: process.env, getAnchorSource }))
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
  // （与 bridge 侧 ~/.ponos/workflows 安装目录对应；Task 8 把市场工作流装到这里）。
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
  // ★ 断言桥接（callee 缺口）：`appId` 是 callee 运行时实际接收项，其 JSDoc 只登记了 `roots`（TS2353）。
  //   正式补全在 kernel/app-spec.mjs 的棘轮批次（本仓暂无对应任务锚点）。
  if (appPageId && !loadSpec(/** @type {Parameters<typeof loadSpec>[0] & { appId?: string | null }} */ ({ roots: appRoots, appId: appPageId }))) {
    log.warn(`apps: --app-page ${appPageId} 未找到对应应用（spec 缺失或已删除）—— 本会话将没有任何应用工具`)
  }
  // I-2：public 工作流入池上限——settings.workflow.publicLimit（设置项不存在/非法 → 缺省 20，
  // 与 dyntools 内 LIMIT_DEFAULT 一致；不为此扩设置系统）。
  const wfPublicLimitN = Number(settings.merged.workflow?.publicLimit)
  const wfPublicLimit = Number.isFinite(wfPublicLimitN) && wfPublicLimitN > 0 ? Math.floor(wfPublicLimitN) : 20
  // 技能清单字节天花板——settings.skill.catalogBudgetBytes（Task 2 收尾轮，2026-09-26）。
  // 与上面 publicLimit 同模式（"设置缺失/非法 → 走缺省"），但**缺省是"不设限"（null）而不是某个数字**：
  // 预算会改变【可用技能】清单的渲染形态（触发词 → 描述 → 仅列 id），给默认数字 = 替所有存量用户
  // 静默改提示词（且大技能库会被降级），所以只由显式配置开启，未配置者逐字节等同改动前。
  // why 必须在这里读并传下去：上一轮只加了 composeSystemPrompt 的**可选**参数、没有调用方
  // ⇒ 天花板默认永不生效（"机制建了没用"）。设置解析在 resolveSkillCatalogBudget（prompt.mjs 的纯函数）。
  const skillCatalogBudget = resolveSkillCatalogBudget({ settings: settings.merged })
  const skillCatalogRaw = settings.merged.skill?.catalogBudgetBytes
  if (skillCatalogBudget === null && skillCatalogRaw !== undefined && skillCatalogRaw !== null) {
    // 配了值却不生效（0/负数/非数字）必须出声：否则用户以为"已开启天花板"，实际是静默无效。
    // 显式 null 不算"配错"（它就是"不设限"的写法，与缺省同义）⇒ 不告警，免得噪声反过来淹没真问题。
    log.warn(`skill.catalogBudgetBytes=${JSON.stringify(skillCatalogRaw)} 不是正数 —— 技能清单天花板**未启用**（缺省不设限）`)
  }
  // 技能清单**超预算**的告警只报一次（终审修复轮）：越限是"配置 + 技能库"的静态属性，逐轮重复
  // 只会淹没真问题；缺省不设限（budget=null）**一律不告警**（不设限就没有"超限"这回事）。
  let skillCatalogOverWarned = false
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
  // ── 后台任务完成 → 静默唤醒空闲内核（2026-09-21 长任务可靠性 P0）──────────────────
  // 症状：agent 派后台子代理/后台程序后结束轮次，任务完成只有 UI 通知（taskNotification
  //   帧只更新任务卡片），没有任何机制唤醒主 agent ⇒ 用户必须手打一条消息才续得上。
  // 做法：合并窗口内累积完成事件 → 一次性注入一条系统插话 → **显式拉起** handleUser。
  // ★ 不能只调 engine.queueNext()：它的消息由 handleUser 的 finally 兜底消费（见本文件
  //   轮末 drainNextPending → state.queue.shift → handleUser）；轮次已结束时不会再跑
  //   finally ⇒ 消息会永远躺在 pendingNext 里，表现为"注入了但没人处理"。
  // ★ 静默：systemInjection:true 与轮末兜底的入队字段完全一致（展示层静默、不产生用户
  //   气泡）—— 用户拍板 D6「完全静默」；可观测性留在会话记录与任务卡片。
  // ★ state / handleUser 都在本函数作用域内（state 在下方声明）；本回调只会在子任务收口
  //   时异步触发，届时两者均已初始化，故此处前置声明是安全的。
  const wakeBuf = []
  let wakeTimer = null
  let wakeUsed = 0
  function onBackgroundFinished(info) {
    try {
      if (!info || typeof info.taskId !== 'string') return
      if (!shouldAutoWake({ turnActive: state.turnActive, queueLen: state.queue.length, wakeUsed, max: AUTO_WAKE_MAX })) return
      wakeBuf.push(info)
      if (wakeTimer) return
      wakeTimer = setTimeout(() => {
        wakeTimer = null
        const items = wakeBuf.splice(0)
        if (!items.length) return
        // 窗口内状态可能已变（用户刚发言 / 轮次又活了）→ 二次判定，避免插话干扰
        if (!shouldAutoWake({ turnActive: state.turnActive, queueLen: state.queue.length, wakeUsed, max: AUTO_WAKE_MAX })) return
        wakeUsed++
        state.queue.push({ message: { role: 'user', content: buildWakeText(items) }, skipMemoryCapture: true, systemInjection: true })
        const nextMsg = state.queue.shift()
        if (nextMsg) void handleUser(nextMsg)
      }, WAKE_MERGE_WINDOW_MS)
      if (wakeTimer.unref) wakeTimer.unref()
    } catch { /* 唤醒失败绝不影响主流程与子任务收口 */ }
  }
  const engine = createEngine({
    opts: {
      model: args.model,
      configDir,
      addDirs: args.addDirs,
      // 过程文件归集（待办 860）：阶段名取会话 id（引擎侧取前 8 位）。
      // chat 模式**关掉**：chat 会话没有任何本地工具（CHAT_MODE_DISALLOWED），
      // 归集要动磁盘、要读 git，与"纯聊不碰本地资产"的隔离承诺相悖。
      sessionId,
      processHygiene: chatMode ? false : undefined,
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
      // ★ 2026-10-18 ENG-04：循环任务放行白名单（`--loop-allow Bash,app_*`）。
      //   白名单内工具在循环运行期把 ask 降级为 allow（白名单外照旧逐次审批，
      //   灾难命令 perm.hard **永不**因白名单放行）。缺省 null = 不放行。
      loopAllowlist: args.loopAllowlist,
      // 循环模式（2026-10-06 三层升级）：显式 --loop-mode > 引擎内归一（env PONOS_LOOP_MODE > auto）。
      // 非法值不静默改档——这里打一行诊断（init 回显的 loop_mode 才是桥校准徽标的真值）。
      // 编排扩展（2026-10-07）：另接受 custom:<workflowId> 委派态——形态校验在此，工作流
      // 存在性/可编排性留给轮首解析（零状态纪律，D23）。
      loopMode: (() => {
        if (!args.loopMode) return undefined
        const sel = normalizeLoopMode(args.loopMode) || parseCustomLoopMode(args.loopMode)
        if (!sel) console.error(`[cli] 忽略非法 --loop-mode ${JSON.stringify(args.loopMode)}（合法：auto|react|plan|reflect|subagent 或 custom:<workflowId>）`)
        return sel || undefined
      })(),
      routerModel: args.routerModel || undefined,
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
      // 2026-09-21（长任务可靠性 P0）：后台任务完成回调（本文件上方定义）——
      // 子任务收口时静默唤醒空闲内核，解决"任务跑完没人接续、需人工发指令"。
      onBackgroundFinished,
      // P1.1：子代理 lane 的项目地图（独立预算，≤atlas.laneInjectMaxBytes）。
      // 函数形式：每次 spawn 求值（内部按 buildId 缓存）；chat 模式恒返回空串。
      atlasLanePrompt: atlasLaneBlock,
    },
    wire,
    session: store,
    health,
    compactor,
  })
  // ── 活性心跳发送（2026-09-21 长任务可靠性 P2）──────────────────────────────
  // 周期自报"在飞工作"，把"在忙"从"已死"里分离出来（判定纯函数 kernel/heartbeat.mjs）：
  //   · 本进程的硬看门狗据 hbState 区分"长前台工具在跑"与"真失活"——否则刚放宽到 1800s 的
  //     工具 deadline 会被 900s 的看门狗先砍掉（工具跑一半、连内核一起没了）；
  //   · 桥侧据 `system/activity` 帧把"在飞工作"与"纯静默"分开（server/kernel-heartbeat.mjs）。
  // 只在轮次活跃时发（心跳只对活跃轮次有意义，也避免空闲会话白刷帧）；unref 不阻止进程退出。
  if (ACTIVITY_HB_MS > 0) {
    let hbSendErrLogged = false
    const activityTimer = setInterval(() => {
      try {
        if (!isTurnActive()) return
        const nowMs = Date.now()
        const verdict = activityHeartbeat({
          snapshot: engine.activitySnapshot(),
          now: nowMs,
          lastRealOutputAt: wireLastWriteAt(),
          lastHeartbeatAt: wireHeartbeatAt(),
          periodMs: ACTIVITY_HB_MS,
          busyMaxMs: ACTIVITY_BUSY_MAX_MS,
          awaitingUser: isAwaitingUser(),
        })
        if (!verdict.emit) return
        hbState.inflight = verdict.inflight.total
        hbState.phase = verdict.frame.phase
        wire.activity(verdict.frame)
      } catch (e) {
        // 观测面**不得静默失效**（否则"看不见"就成了"看不见它坏了"）：首次失败打一行 stderr
        // 留痕，后续不再刷（守线：心跳失败绝不影响轮次）。
        if (!hbSendErrLogged) { hbSendErrLogged = true; try { console.error(`kernel: activity heartbeat failed: ${e?.message || String(e)}`) } catch {} }
      }
    }, Math.max(250, ACTIVITY_HB_MS))
    if (activityTimer.unref) activityTimer.unref()
  }
  // 知识空间只读边界注入（P3）：与下面 setDynamicTools 同一处境——engine.mjs 的
  // createToolRegistry 调用点逐项硬列参数、不转发本项，故在拿到 engine.tools 后注入
  // （与构造参数 knowledgeReadDirs 等价，后设覆盖先设）。必须在第一轮工具调用之前完成，
  // 而轮次只由 stdin 消息触发，故此处（createEngine 紧邻处）是安全的注入点。
  // chat 模式照常注入：chat 的 Read 被 CHAT_DISALLOWED 禁掉，这条边界在那里不产生能力。
  engine.tools.setKnowledgeReadDirs(knowledgeReadDirs)
  // P1.1：Atlas 的开关/根/配置根同款热注入（engine 的 createToolRegistry 调用点不转发新项）。
  // 工具只在被调用时才 ensureAtlas —— 未使用 Atlas 的会话零构建成本。
  engine.tools.setAtlasOptions({
    enabled: atlasSettings.enabled,
    root: atlasRoot,
    configDir,
  })

  // ★★ 2026-10-18 SESS-08：**后台子代理任务的落盘与恢复**。
  //
  // 【为什么放在 CLI 而不是 engine】（这一步返工过，务必先读）
  //   第一版把登记直接写进 `engine.mjs` 的派发/终态热路径（同步 appendFileSync）。
  //   结果 `kernel-tests/subagent.test.mjs` 的「主 cancel」用例在 Windows 上**稳定 EPERM**：
  //   多出的磁盘 IO 改变了「cleanup 删临时目录」与「子代理收尾」的相对时序 ⇒ 句柄未即时释放。
  //   改成 `setImmediate` 也仍回归（调度本身已进事件循环，多一轮宏任务）。
  //   还原 engine 后该用例 20/20 ⇒ **热路径上不要加任何 IO 或额外调度**。
  //   ⇒ 现在 engine 只导出纯读快照（`snapshotActiveSubAgents` / `runningSubAgentCount` /
  //     `laneMaxConcurrent`），全部落盘与恢复动作都在 CLI 侧（`kernel/subagent-resume.mjs`）。
  //
  // 位置理由：引擎已建好、第一轮工具调用尚未开始 —— 恢复要能用到完整工具表。
  // ★ chat 模式跳过：chat 是"问一句答一句"的只读语境，不该在后台自行拉起会写盘的子任务。
  if (!chatMode) {
    // ① 周期快照：崩溃/强杀时也能留下索引（60s 一次，unref 不阻止进程退出）
    const snapTimer = setInterval(() => {
      try {
        const active = engine.snapshotActiveSubAgents?.() || []
        if (active.length > 0) subagentResume.snapshotActiveSubAgents(configDir, active)
      } catch { /* 快照失败绝不影响主流程 */ }
    }, 60_000)
    if (typeof snapTimer.unref === 'function') snapTimer.unref()

    // ② 退出前快照（正常退出 / SIGINT / SIGTERM / 未捕获异常）
    const flushSnapshot = () => {
      try {
        const active = engine.snapshotActiveSubAgents?.() || []
        if (active.length > 0) subagentResume.snapshotActiveSubAgents(configDir, active)
      } catch { /* 忽略 */ }
    }
    process.once('exit', flushSnapshot)
    for (const sig of ['SIGINT', 'SIGTERM']) {
      try { process.once(sig, flushSnapshot) } catch { /* 平台不支持则忽略 */ }
    }

    // ③ 启动时恢复（fire-and-forget，绝不拖慢启动）
    void subagentResume.resumeOrphanedSubAgents({
      dataHome: configDir,
      spawnSubAgent: engine.spawnSubAgent,
      runningCount: () => (engine.runningSubAgentCount?.() || 0),
      maxConcurrent: engine.laneMaxConcurrent,
      log: (msg, meta) => log.info(msg, meta),
    }).catch((e) => log.warn('subagent auto-resume failed', { err: String(e && e.message).slice(0, 300) }))
  }
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
    // 未配置 ~/.ponos/mcp.json 时 view() 恒返回 {} ⇒ 既有行为逐字不变。
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
      // ★ `engine` 的登记在 callee（kernel/dyntools.mjs#buildWorkflowTools 的 @param）：
      //   dyntools-cache.test.mjs 的结构护栏按**本行的字面量**（callee 名 + 第一个键）定位，
      //   并断言它**晚于**缓存命中判定 ⇒ 加调用点断言会让那个 indexOf 找到 -1（红），
      //   而纪律禁止改测试迁就类型 ⇒ 只能走 callee 登记。本行逐字未改。
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
        // ★ 断言桥接（callee 缺口，TS2345）：callee 的 JSDoc 把 `publicLimit` 登记为**必填**
        //   （`@param {number} p.publicLimit` 无方括号），而它自己的注释明写"cli 调用本函数时并不传
        //   publicLimit、内部回退 MAX_COMMANDS_PER_APP"（app-tools.mjs:104-108）⇒ 该口径把**正确调用**
        //   判成错的。故只放宽**形参签名视图**（publicLimit 转可选）：传入项一字未加、运行逻辑不变。
        //   ★ 为什么不是"在实参里补 publicLimit: undefined"：那会**多传一个键**（运行面改动）；
        //     为什么不是实参断言：断言目标仍需 publicLimit（`{}` 缺必填键 ⇒ TS2352），降不了级。
        //   正式补全在 kernel/app-tools.mjs 的棘轮批次（本仓暂无对应任务锚点）。
        ...(/** @type {(p: Omit<Parameters<typeof buildAppTools>[0], 'publicLimit'> & { publicLimit?: number }) => ReturnType<typeof buildAppTools>} */ (buildAppTools))({
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
    // ★ 断言桥接（callee 缺口）：`root` 是 callee 运行时实际接收项，其 JSDoc 只登记了 `allowFlat`（TS2353）。
    //   正式补全在 kernel/skills.mjs 的棘轮批次（本仓暂无对应任务锚点）。
    for (const s of excludeDisabled(discoverSkills(/** @type {Parameters<typeof discoverSkills>[0] & { root?: string }} */ ({ root: dir, allowFlat: flatSkillRoots.has(dir) })), disabledReg.skills)) {
      if (!seenSkillIds.has(s.id)) { seenSkillIds.add(s.id); skills.push(s); skillIds.push(s.id) }
    }
  }
  // 技能声明的工作目录（P3，2026-09-21）：技能在 `SKILL.md` 里用 `extra_dirs:` 声明自己
  // 需要读写的外部目录（企微/OneDrive 资料源、外部工作区、经验库…），内核**校验后**把它们
  // 显式加入本会话的文件边界。
  //
  // 为什么在这一跳接线（而不是让 bridge 拼 --add-dir）：
  //   ① 技能发现、停用过滤（disabledReg）、边界构造**都在内核**——同一份数据源才能保证
  //      "已停用的技能不贡献目录"（停用语义贯通到文件边界）；
  //   ② 放在 bridge 就等于只有 GUI 会话享此能力，CLI 直跑/benchmark 又得各写一份。
  //
  // 为什么注入点在这里而不是 createEngine 的 opts：技能发现循环晚于 createEngine，与
  // `setKnowledgeReadDirs` 完全同因（engine.mjs 的 createToolRegistry 调用点逐项硬列参数、
  // 不转发新项）。轮次只由 stdin 消息触发 ⇒ 启动段注入一定早于首轮工具调用。
  //
  // 注入前先算 rejected：**声明了但没生效**必须出声（否则用户按 SKILL.md 写了个盘根/不存在的
  // 目录，只会看到"还是被拒"，无从归因）。
  const skillExtraDirs = chatMode ? { dirs: [], rejected: [] } : resolveSkillExtraDirs({ skills })
  if (skillExtraDirs.dirs.length) {
    log.info('skill extra dirs', { granted: skillExtraDirs.dirs.map((d) => `${d.skill} → ${d.dir}`) })
  }
  if (skillExtraDirs.rejected.length) {
    // 出声（warn）：声明了却没生效，用户只能靠这行知道"为什么还是被拒"
    log.warn('skill extra dirs 未生效', { rejected: skillExtraDirs.rejected.map((r) => `${r.skill}: ${r.value}（${r.reason}）`) })
  }
  // chat 模式不注入（chatMode 下 skillRoots 为空 ⇒ dirs 恒空，此处显式写死只为把语义说清：
  // 纯聊会话不因技能声明而获得任何本地文件能力）
  if (!chatMode) engine.tools.setSkillExtraDirs(skillExtraDirs)
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
  // workflow 与 skill 在**发现机制**上平权：同一技能根发现（workflow.yml / .yml），
  // 共享 triggers 触发词；发现结果入【可用工作流】独立区块（严格输出定位）。
  // ✅ 触发通道已平权（2026-09-26，S1.4）：workflow 走 `matchAutoTrigger(workflows, …)`（默认
  // requireFlag=true），skill 走同一匹配器的 `requireFlag:false`（技能对象没有 autoTrigger 字段），
  // 接线在下面 maybeAutoTriggerWorkflow / maybeAutoTriggerSkill。此前"数据平权、消费者不平权"
  // 的缺口（skills 的 triggers 只进提示词清单、零引擎侧触发）见
  // docs/系统性重构基础/C3-报告10-技能渠道失效.md（改造已完成，该文档为背景材料）。
  const workflows = discoverWorkflowsAll({ roots: workflowRoots })
  // I-3：提示词【可用工作流】清单改用与工具池同一可见性口径（private / bound 未命中 /
  // 超限 public / legacy 不注入名字与描述）。注意 workflows（未过滤）仍供 auto_trigger
  // 与 init 计数使用 —— 可见性与自动触发是两件事，本处只收窄注入面。
  // 抽成函数**不缓存**（2026-09-17）：清单须随盘面变化重算，见 refreshSystemPrompt 的 why。
  const currentVisibleWorkflows = () =>
    listVisibleWorkflows({ roots: workflowRoots, agentId: args.agent || null, publicLimit: wfPublicLimit })
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
  // EL1 线索段（S4.5④-3）：与 memoryBlock 同款——启动时算一次、并入 append，
  // 不每轮重算（检索不便宜，且与"删除工作流"无关；理由同下方 refreshSystemPrompt 的 why）。
  let el1Block = ''
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
      // ★ 断言桥接（callee 缺口）：`configDir` 是 callee 运行时实际接收项，其 JSDoc 未登记（TS2353）。
      //   正式补全在 kernel/knowledge.mjs 的棘轮批次（本仓暂无对应任务锚点）。
      const s = createKnowledgeStore(/** @type {Parameters<typeof createKnowledgeStore>[0] & { configDir?: string }} */ ({ configDir }))
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
      // ★ T1.3（2026-10-20）：legacy 的 `graph.search` 此前**在预算之外**——它用默认 maxChars
      //   （2,048 **字符**，中文 ≈6 KB），而索引层已按 totalBudget 切分 ⇒ 实际注入量随图谱内容
      //   抖动且无上限（"省了 4 KB"被这 6 KB 悄悄吃掉）。现在把**剩余预算**给它：
      //   预算 - 抽调层已用 - 索引层已用，且至少保留 0（≤0 ⇒ 跳过抽调，不硬塞）。
      if (injectMode !== 'index-only' && injectOpts.mode === 'legacy') {
        const used = Buffer.byteLength(inj.recallSection || '', 'utf8') + Buffer.byteLength(inj.indexSection || '', 'utf8')
        // 上限口径收在 resolveRecallChars（纯函数，三条口径可单测）：剩余 ≤0 ⇒ 返回 0 ⇒ **跳过**。
        // ★ 必须跳过而不是传 0：memory-rank 把 maxChars=0 当"未设置"回落到 2048（会给得更多）。
        const maxChars = resolveRecallChars({ totalBytes: injectOpts.budget, usedBytes: used })
        if (maxChars > 0) {
          memoryBlock += graphStore.search({ query: kw.join(' '), keywords: kw, maxChars })
        }
      }
      memoryBlock += inj.recallSection
      memoryBlock += inj.indexSection

      // ── S4.5④-3：EL1 线索层接线 ──────────────────────────────────────────────
      // 判据三件套（A18 前置 relateMode==='on'、A20 互斥 strategy!=='unified'、D6 逃生阀）
      // 全在 shouldInjectEl1 里，此处只喂参数——不在此重抄一遍（同一口径两处定义必漂移）。
      try {
        const strategy = injectOpts.mode
        const relateMode = resolveRelateMode(configDir)
        const el1Enabled = process.env.PONOS_MEMORY_EL1 !== '0'
        if (shouldInjectEl1({ strategy, relateMode, enabled: el1Enabled })) {
          // 观察期（A18/A19）：`PONOS_MEMORY_EL1_OBSERVE` **默认 1** —— 即"只登记推荐集合、
          // 不产生可注入文本"。这是 A18 的落地方式：先拿到"会推荐什么"的真实数据
          // （采纳率无从伪造），确认无退化后再置 0 转正。默认开 = 最保守。
          const observe = process.env.PONOS_MEMORY_EL1_OBSERVE !== '0'
          // ★ 断言桥接（callee 缺口）：`configDir` / `query` 是 callee 运行时实际接收项，其 JSDoc 未登记（TS2353）。
          //   正式补全在 kernel/knowledge-search.mjs 的棘轮批次（本仓暂无对应任务锚点）。
          const r = searchKnowledgeItems(/** @type {Parameters<typeof searchKnowledgeItems>[0] & { configDir?: string, query?: string }} */ ({
            configDir, query: kw.join(' '), keywords: kw,
            spaces: knowledgeScope.spaces, topK: 8, mode: 'snippet',
          }))
          const items = (r.ok ? r.items : []).map((it) => ({
            blockId: it.blockId, space: it.spaceId,
            title: it.heading || it.docId, snippet: it.snippet,
            // 一跳锚点（R4）本轮留空：逐条展开是 N 次额外检索，成本与收益待观察期数据说话；
            // R4 的渲染契约已由 kernel-tests/knowledge-recommend.test.mjs 逐条钉住，
            // 接线只差"把 related 填进来"这一步（不预造数据）。
            related: [],
          }))
          const rec = buildRecommendSection(items, {
            budgetBytes: HYDRATE_EL1_MAX_BYTES, dryRun: observe,
            readableSpaces: knowledgeScope.spaces ? new Set(knowledgeScope.spaces) : null,
          })
          if (!observe) el1Block = rec.text
          // 登记分名（S-1③）：`offered` / `offeredDryRun` 是两种语义，混用会污染采纳率口径；
          // 观察期 adopted 记 **null** 而非 0 —— 0 会被算成"推荐了但没被采纳"。
          //
          // ★ 为什么走 stderr 而不是 store.appendMeta（实测教训）：转录是**协议面** ——
          //   server/kernel-bridge.test.mjs「协议闭环」逐条核验转录序列（meta + user + assistant），
          //   启动时同步写入一条 meta 会**必然**把它变成 4 条 ⇒ 稳定红。
          //   观察期数据没有转录读方（面板读的是 server/experience.mjs 写的 themes.json），
          //   写转录是"为写而写"却要付协议面代价 ⇒ 改用一行结构化日志，信息量不减、零协议影响。
          //   （Task 2 的 inject_snapshot 保留在转录里：S1+ spec 明确要求"每轮一条"落 store。）
          process.stderr.write(`[el1] ${JSON.stringify({
            observe, offered: rec.offered, bytes: rec.bytes, dropped: rec.dropped,
            adopted: null, strategy, relateMode,
          })}\n`)
        }
      } catch { /* EL1 故障绝不阻塞主流程（与既有注入段同款） */ }
    }
  }
  // 提示词组装：内核基础行为规范 + 可用子 Agent 区块（内置 ∪ 用户级）+ AGENTS.md
  // 项目指令 + 技能区块 + 记忆索引 + GUI append 文件（最高优先级，后者覆盖前者）。cwd = addDirs[0]。
  //
  // 抽成 refreshSystemPrompt() 并**每轮重算工作流清单**（2026-09-17 修复）：
  //   此前这里只在会话启动时组装一次，且 engine 每次请求都读同一份快照
  //   （engine.mjs: getSystem: () => systemPrompt），于是**会话活着期间删除的工作流，
  //   提示词里的【可用工作流】清单纹丝不动**。后果不只是"显示旧数据"——agent 会照着
  //   旧清单声称"我可以调用 run_xxx"，而 run_<slug> 工具**已经随盘面签名失效而从工具池
  //   消失了**（kernel/dyntools.mjs 的盘面签名含工作流根条目名列表），真调必然失败。
  //   用户侧看到的就是"工作流已删除，agent 仍能获取到（但一跑就无输出）"。
  //   工具池与清单本应同一口径：工具池每次求值、删了立刻没；清单却冻在启动瞬间。
  //   重算成本极低（一次 readdir + 读 yml 头部），且 setSystemPrompt 只换一个变量，
  //   故每轮入口调用一次即可，无需失效广播（也就没有"漏广播"这类新失效面）。
  //   注意 memory / knowledgeScope / skills 仍沿用启动时值：它们与"删除工作流"无关，
  //   且 memoryBlock 一次图谱检索不便宜，不该每轮重算（保持零行为变化）。
  // 经验沉淀指引的注入前计算（细节理由见下方 append 字段处注释）：
  // base 即"除掉沉淀指引之外的 append 内容"，它的存在让标记去重可判。
  // ★★ 2026-10-18 ENG-09：提示词文件读失败必须**出声**（见 readPromptFile 的注释）。
  //   仍是"不阻断启动"：缺这段提示词时模型照常能跑，只是能力/身份段缺失 —— 那种状态
  //   必须能被诊断看到，否则就是"回答风格突变但查不出原因"。
  const promptFileRead = readPromptFile(args.appendSystemPromptFile)
  if (promptFileRead.error) {
    // stderr：桥会把内核 stderr 收进日志（log-tee / diag），这是既有可见信道
    console.error(`[kernel] 系统提示词读取失败，将**缺少**宿主身份/协议段继续运行：${promptFileRead.error}`)
  }
  const appendBase0 = promptFileRead.text + el1Block
  // T1.4（2026-10-20）：两段长规则（过程纪律 1,169 B + 沉淀指引 ≈1,757 B）的详略由
  // `PONOS_PROMPT_APPENDIX=compact` 切换；**缺省仍是全文**（它们是行为规则，不是参考资料，
  // 压缩会让"过程文件又散落回用户项目"——合规代价比省 2.9 KB 贵）。回退=去掉这个环境变量。
  const appendix = buildPromptAppendix({
    mode: process.env.PONOS_PROMPT_APPENDIX || '',
    themes: chatMode ? [] : listMemoryThemes(ensureMemoryRoot(configDir)),
    skipHygiene: chatMode,
    skipSediment: chatMode,
  })
  const appendBase = appendBase0 + (appendix.hygiene ? '\n\n' + appendix.hygiene : '')
  const sedimentSuffix = (!chatMode && !appendBase.includes(SEDIMENT_MARKER) && appendix.sediment)
    ? '\n\n' + appendix.sediment
    : ''
  const refreshSystemPrompt = () => engine.setSystemPrompt(composeSystemPrompt({
    // ★ 2026-10-26：名单必须取**实际投递的工具面**，不能用 `engine.tools.toolNames`（全量）。
    //   `toolSchemas()` 现在会按窗口预算裁掉动态工具（B 层），而 `toolNames` 是 getter、
    //   永远返回注册表全量 —— 两者在"被裁过"时不再相等。若这里沿用全量，system 提示会写下
    //   `可用工具：…135 个…`，而 tools[] 面只投递 52 个 ⇒ 模型被提示词误导去调一个
    //   schema 不存在的工具（弱模型尤其容易照着名单硬调），且那行本身也是纯浪费的 token。
    //   取 toolSchemas 还有个附带好处：名单与 schema 天然同源，不会再长出第二口径。
    toolNames: engine.toolSchemas().map((t) => t.name),
    // ★ 2026-10-26（deferred tools）：按需加载的工具**只投名字**（schema 由 ToolSearch 取回）。
    //   不投这份名单 ⇒ 模型不知道有它们（等于删掉）；投 schema ⇒ 前缀被撑满。
    //   chat 模式下 MCP 工具全被 disallowed 过滤 ⇒ 这里自然是空数组，不会泄漏能力暗示。
    deferredToolNames: engine.deferredToolNames(),
    // chat 隔离（2026-09-12）：子 Agent / 项目指令 / cwd 全部不进 chat 提示词
    // （composeSystemPrompt 的 mode='chat' 分支另有兜底，即便此处漏传也不会注入）。
    subagents: chatMode ? [] : engine.agents,
    agents: chatMode ? [] : discoverAgentsMd({ cwd: args.addDirs[0] || '', addDirs: args.addDirs }),
    // 过程文件纪律（待办 860）：**必须进提示词**——否则 agent 不会遵守，散落的临时脚本
    // 照旧堆在用户项目里。文案真源在 shared/process-artifacts.mjs（与目录常量挨着，
    // 改目录名时提示词不可能漏改；单测钉住"提示词里的目录 = 常量"）。
    // 走 `append` 通道（composeSystemPrompt 的最高优先级层）：本层是"内核补充规则"的既有
    // 追加位（el1Block 也走这里），无需改动 kernel/prompt.mjs 的基座分层。
    // chat 模式**不注入**：chat 会话没有任何本地工具（见 CHAT_MODE_DISALLOWED），
    // 教它"把过程脚本放哪"是纯噪声，还会诱导它承诺做不到的本地动作。
    // 经验沉淀指引（P2 待办 714「固化到 agentloop 中，单独跑 ponos 内核也能保证运行」）：
    // 文本真源在 kernel/memory.mjs#buildSedimentInstruction，**宿主与内核共用同一份**（同一标记）。
    // 这里解决"独立运行也要有"这条：内核自己会在需要时注入，不再依赖宿主送进来。
    //
    // 三条注入纪律：
    //  · chat 模式不注入：chat 会话没有本地工具（CHAT_MODE_DISALLOWED 含 Bash），
    //    教它跑 append 命令是纯噪声，还会诱导它承诺做不到的本地动作（与上面 processHygiene 同口径）。
    //  · **标记去重**：app 的 task 模式会经 --append-system-prompt-file 把同一份文本送进来
    //    （server/experience.mjs#buildSedimentPrompt），若这里无条件再拼一次，同一段话会出现两遍
    //    —— 既费上下文，也会让模型以为要沉淀两次。故先看已有 append 文本里有没有那个标记。
    //  · 注入前**顺手建好经验目录**：`--knowledge append` 在"根目录原本不存在"时被入口防呆短路，
    //    独立跑内核时若从不建目录，指引里的命令会永远失败（又变成一条死指令）。
    append: appendBase + sedimentSuffix,
    cwd: chatMode ? '' : (args.addDirs[0] || ''),
    skills,
    workflows: chatMode ? [] : currentVisibleWorkflows(),
    memory: memoryBlock,
    // P1.1：项目地图（L0+L1，≤atlas.injectMaxBytes）。chat 分支在 composeSystemPrompt
    // 里提前 return，这里再挡一次（chat 不构建索引）。
    atlas: atlasMainBlock(),
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
    // 技能清单天花板（Task 2 收尾轮）：**唯一的传入口**。缺省 null ⇒ renderSkillCatalog
    // 一律走 triggers 档（存量零变化）。见本文件 wfPublicLimit 旁的 skillCatalogBudget。
    skillCatalogBudgetBytes: skillCatalogBudget,
  }))
  refreshSystemPrompt()
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
    // 技能声明的工作目录回显（P3，2026-09-21）：与 knowledge_spaces 同一理由——授权是跨
    // 4 跳才能生效的（SKILL.md → 内核发现 → 校验 → 工具边界），任一跳漏接都是**静默失效**。
    // 回显出来，「本会话额外授权了哪些目录、哪些声明没生效」在 init 帧上就能判定，
    // 而不是等撞了边界才反查（字段只增不改：老 GUI 忽略即可）。
    extra_dirs: skillExtraDirs.dirs.map((d) => ({ skill: d.skill, dir: d.dir })),
    extra_dirs_rejected: skillExtraDirs.rejected.map((r) => ({ skill: r.skill, value: r.value, reason: r.reason })),
    // 会话模式回显（2026-09-12 chat 隔离）：宿主/GUI 据此确认内核真的进了隔离分支
    // （chat 时 skills/workflows 必为 0、tools 不含本地工具，见 kernel-tests/chat-mode.test.mjs）
    session_mode: chatMode ? 'chat' : 'task',
    settings: { hooks: hooks.count },
    // 生效审批档位回显（2026-09-12 四档化）：桥据此校准状态栏徽标；也是"跑的是旧内核
    // （不认 --approval-mode）"的检测点——旧内核不会带这个字段。
    approval_mode: engine.getApprovalMode(),
    // 循环模式回显（2026-10-06 三层升级）：桥/GUI 据此校准选择器与徽标；也是"跑的是旧内核
    // （不认 --loop-mode）"的检测点——旧内核不会带这两个字段。selected=选择态（auto|模式），
    // effective=当前实际生效模式（auto 时徽标显示它；路由每轮可改）。
    loop_mode: engine.getLoopMode().selected,
    loop_mode_effective: engine.getLoopMode().effective,
    router_model: engine.getRouterModel(),
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
  // 载荷、--until 目标的携带（判定已由控制器执行，P1-5）。
  // ★ 断言桥接（callee 缺口）：`wire` / `engine` 是 callee 运行时实际接收项（它俩在 callee 形参里
  //   **无默认值** ⇒ 整体缺席于推断类型，传它必 TS2353）。正式补全在 kernel/loop.mjs 的棘轮批次。
  const loop = createLoopController(/** @type {Parameters<typeof createLoopController>[0] & { wire?: typeof wire, engine?: typeof engine }} */ ({
    // 单价三级解析（P1-2）：① provider 显式配置 > ② 内置价表 > ③ 估算兜底。失败静默
    //（resolveModelPrices/parseModelPricesEnv 是纯函数、不抛），解析结果随状态落盘
    // priceSource 供 UI 标注「价格来源」。
    // 第 ① 层的生产来源：bridge 把设置页里激活 provider 的 modelPrices 序列化进
    // PONOS_MODEL_PRICES（未配置则不注入 ⇒ 逐字退回改动前行为）。
    prices: resolveModelPrices(
      (typeof model === 'string' && model) || '',
      parseModelPricesEnv(process.env),
      process.env,
    ),
    wire, engine, store, configDir, sessionId, cwd: args.addDirs[0] || '', env: process.env,
  }))
  // --until 目标：控制器已持有 state.until 并自行判定（P1-5）；此变量仅供 nextPayload 携带
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
  // 返回命中的工作流（未命中 = null）：调用点据此判"本轮已由工作流认领"，从而不回退到技能触发
  //（优先级 workflow > 技能，见下面 maybeAutoTriggerSkill）。
  function maybeAutoTriggerWorkflow(content) {
    const hit = matchAutoTrigger(workflows, content)
    if (!hit) return null
    const summarize = (o) => {
      try { return JSON.stringify(o?.end?.output ?? o).slice(0, 400) } catch { return String(o) }
    }
    wfBusy++
    // ★ 断言桥接（callee 缺口）：`id` 是 callee 运行时实际接收项（形参里**无默认值** ⇒ 整体缺席于
    //   推断类型，TS2353）；返回面用 `@param` 把回调形参标成 WfRunView（同上，union 的 ok 是宽
    //   boolean ⇒ 不可判别；JSDoc 不进 AST ⇒ 回调体一字未动，运行语义零变化）。
    //   正式补全在 kernel/workflow-engine.mjs 的任务。
    void wfEngine.run(/** @type {Parameters<typeof wfEngine.run>[0] & { id?: string }} */ ({ id: hit.id, inputs: { user_message: content } })).then(/** @param {WfRunView} r */ (r) => {
      wfBusy--
      const line = r.ok
        ? `【自动触发工作流 ${hit.id} 完成】状态：${r.status}（${r.steps} 步，${r.runId}）。输出：${summarize(r.outputs)}`
        : `【自动触发工作流 ${hit.id} 失败】${r.error}`
      try { engine.queueNext(line, undefined, { system: true }) } catch { /* 注入失败不阻断 */ }
      try { wire.system('workflow_result', { subtype: 'auto_triggered', workflow: hit.id, ok: r.ok, status: r.status, steps: r.steps, runId: r.runId, error: r.error }) } catch { /* ignore */ }
    }).catch((err) => {
      wfBusy--
      log.error('auto-trigger workflow failed', err)
    })
    return hit
  }

  // 技能自动触达（S1.4）：与 workflow **同一触发口径**（子串匹配、触发词 >= 2 字），
  // 差别只在谓词——技能对象没有 autoTrigger 字段，故用 requireFlag:false 放宽
  //（显式 autoTrigger:false 的技能仍被跳过；工作流的默认语义一字未动，见 workflow-dsl.mjs）。
  //
  // ★ 输入必须是上面这份**已过滤 disabled** 的 skills（:1124 的 excludeDisabled 循环）：
  //   它与提示词技能清单、skillIds 工具池可见性同源。若改用未过滤的发现结果，就会出现
  //   "提示词清单里没有、却被自动触发"的停用失效（半生效状态）。
  // 只在没有 workflow 命中时调用（调用点保证），避免同一消息注入两段互相打架。
  // 注入**只给一句提示**（不给技能全文）：技能正文由模型按需经 Skill 工具加载，
  // 引擎侧越权灌全文会与"技能清单天花板"的口径打架（正文大小不可控）。
  function maybeAutoTriggerSkill(content) {
    const hit = matchAutoTrigger(skills, content, { requireFlag: false })
    if (!hit) return null
    const line = `用户消息命中了技能「${hit.id}」的触发词，请优先按该技能执行；如需其完整指引请加载它。`
    // 必须带 system:true —— 这是"非用户发言注入"的统一出口，否则它会以用户气泡出现在
    // GUI 历史里（kernel-tests/system-inject-mark.test.mjs 的源码面守卫会红；
    // 同文件先例：自动触发工作流结果注入）。
    try { engine.queueNext(line, undefined, { system: true }) } catch { /* 注入失败不阻断 */ }
    // 演化P0·P-c（规格 §4.2）：命中埋点落转录（投影派生技能触发面）+ 注入台账
    // （渠道 = guard，引擎发起的单行提示）。不改既有 queueNext 行为；写失败不阻断。
    try { store.appendMeta('skill_trigger_hit', { id: hit.id }) } catch { /* 埋点失败不阻断 */ }
    try { recordChannel('guard', { calls: 1, hits: 1, injectedBytes: Buffer.byteLength(line, 'utf8') }) } catch { /* 渠道统计失败不阻断 */ }
    // 不另发 wire 事件（本任务只做通道本身）：GUI 侧没有消费者，发一个无人读的事件
    // 只是给协议面添噪声。（原注"命中埋点/渠道统计属本轮不判"已由演化 P0 交付，见上两行。）
    return hit
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
          // 待审批动作真正执行（P1-3：回滚此前只登记、从不执行）；非 rollback 时是空操作
          const rb = loop.applyPendingRollback()
          loop.resume()
          // 恢复后需重新投递下一轮：暂停/挂起都发生在"轮已结束"的边界，控制器不会自行
          // 推进（其 onTurnEnd 只在轮末被调用），故此处补投递，否则恢复后静默停住。
          if (wasActive) {
            const p = loop.nextPayload(loopUntil)
            state.queue.unshift({ message: p.message, loop: p.loop, skipMemoryCapture: true })
            if (!state.turnActive) { const n = state.queue.shift(); if (n) void handleUser(n) }
          }
          // 宽幅审查缺陷 M-4：工作树本来干净时 git stash 退出码同为 0 但并未创建 stash，
          // 故只有在确实创建了 stash（rb.stashMsg 非空）时才提示去 pop，否则如实说"无未提交改动"。
          if (rb.applied) return { ok: true, text: rb.stashMsg
            ? `已回滚至 ${rb.ref}；回滚前的改动已存入 stash「${rb.stashMsg}」，可用 git stash pop 找回，随后已恢复循环`
            : `已回滚至 ${rb.ref}（工作树本无未提交改动，无需 stash），随后已恢复循环` }
          if (rb.ok === false) return { ok: false, text: rb.error }
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
    // 2026-09-21（长任务可靠性 P0）：用户真发言 → 重置自动唤醒预算。
    // systemInjection 的系统插话（含本文件的自动唤醒注入）不重置，防"唤醒→派任务→再唤醒"自我续命。
    if (msg?.systemInjection !== true) wakeUsed = 0
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
    } else if (loopMsg) {
      // 内部推进消息（loop 已 active）：本轮即将开始执行 → 「等下次触发」窗口到此结束，
      // nextRunAt 清零。否则磁盘上会留着已到点的 nextRunAt，bridge 主管读 state+meta 时
      // 看到「running + 已到点」会与内核双投递、连跑两轮（spec §4.3）。异常静默，不阻断轮次。
      try { loop.markTurnStart() } catch { /* 静默降级 */ }
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
    // 每轮重算提示词（2026-09-17 修复）：工作流可在会话存活期间被删除/导入（面板或 API），
    // 提示词里的【可用工作流】清单必须跟着工具池走 —— 否则 agent 会声称能调用已被删除的
    // 工作流（工具已消失），真调即失败。**只在此处（普通用户轮入口）刷新**：循环轮/子 Agent
    // 轮不刷，避免在自动重试等路径上引入额外盘面 IO 与行为变化。
    // 失败不阻断本轮（提示词刷新是尽力而为，旧快照仍可用）。
    if (!chatMode) {
      try { refreshSystemPrompt() } catch { /* 刷新失败沿用旧提示词 */ }
    }
    // workflow / 技能自动触发（普通新消息；插话/loop 消息不触发，避免批处理重复执行）。
    // 优先级 workflow > 技能（S1.4）——同一消息只认领一段：先问 workflow 是否命中，
    // 命中即只跑它；未命中才回退到技能自动触达（两个都注入会让模型收到两套互相打架的指令）。
    // 判命中与真触发用**同一份** workflows 快照：若改用可见性收窄的 currentVisibleWorkflows()，
    // 隐藏（private/bound 未命中）的 auto_trigger 工作流会"已经触发、却判为未命中"→ 双注入。
    try {
      if (!maybeAutoTriggerWorkflow(content)) maybeAutoTriggerSkill(content)
    } catch { /* 触发失败不影响主流程 */ }
    // 本轮 outcome（engine.runTurn 返回值）：loop 轮末决策的数据来源——无进展指纹
    // 靠 outcome.toolDigest、成本/步数靠 outcome.usage/toolDigest。取消/异常轮保持 null
    // （控制器对 null outcome 静默降级：不累计、不误记无进展）。
    let turnOutcome = null
    // 早退路径（hook 拦截 / 竞态取消）统一落在外层 try 内，确保 finally 复位
    // turnActive——否则后续消息会永远排队不处理。
    try {
      // hooks.userPromptSubmit：可拦截。stop → 直接 assistant + result，不进轮次
      try {
        // ★ 投影桥接（callee 缺口）：`hooks.run` 返回 `runHook 结果 | { matched: false }`，后者**整体
        //   没有** deny/stop/message ⇒ 直接读 `.stop` 就是 TS2339（与 truthiness 收窄无关——是"该键在
        //   某个 union 成员上不存在"）。投影成"三者皆可选"后读法不变。正式补全在 kernel/hooks.mjs 的棘轮批次。
        const intercept = /** @type {{ matched?: boolean, deny?: boolean, stop?: boolean, message?: string }} */ (await hooks.run('userPromptSubmit', { prompt: content }))
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
            // disk-site: session-memory —— 轮末一次的工作记忆覆盖写。
            // 失败语义**守恒**：本点原本即 best-effort（下面外层 catch "工作记忆写失败不影响
            // 主流程"）⇒ 包装后同样不抛。★ 只包住 mkdir + writeFileSync 这两个**落盘**动作：
            // 紧随其后的 syncKnowledgeIndex 是**索引同步**（内存索引 + 其自身 IO 策略），不是
            // 本次落盘本身，包进来会把索引的耗时/失败算进"落盘失败"，污染判据与自愈决策。
            const w = diskWrite(getDiskTelemetry(), 'session-memory', () => {
              mkdirSync(join(configDir, 'memory', 'session'), { recursive: true })
              writeFileSync(sessionMemoryPath, buildSessionMemoryText(key), 'utf-8')
            })
            // 会话工作记忆不走 appendMemoryEntry（整文件覆盖写，非 append 语义），故这里
            // 单独同步索引：否则"跨会话检索历史工作记忆"要等到下次启动重建才生效（S3 §5）。
            // ★ 失败即跳过索引同步——与包装前控制流逐字一致：原先 writeFileSync 抛错 ⇒ 直接跳到
            //   外层 catch（不执行下面这行）；包装把失败吞成 !w.ok 后，若仍无条件同步，就变成
            //   "对未更新的文件做索引同步"（未命中还会 load({}) 全量重载索引 ⇒ 退化磁盘上反加延迟）。
            if (w.ok) syncKnowledgeIndex(ensureKnowledgeIndex(), `session-memory/${basename(sessionMemoryPath)}`)
          }
        }
      } catch { /* 工作记忆写失败不影响主流程 */ }
      // S1+/O4：每轮一条 inject_snapshot（★ 不在 if (loop.isActive()) 内 ⇒ 非 loop 会话也有账）
      try {
        // 读数取两遍形态：`meters` 保持"对象 | undefined"（供下面那个**新字段**读，不引入 `{}` 联合）。
        // ★ `|| {}` 兜底会把类型放宽成 `T | {}` ⇒ 下面几处属性访问报 TS2339（"Property 不存在于 {}"）。
        //   这里用**变量级 @type 注解**（R1 改法①，纯类型面）把两个读数**收敛回真实形状**：
        //   `{}` 是全可选形状的子类型，故兜底分支依然合法（不是靠断言掩盖"可能为 {}"这一事实）。
        /** @type {{ channels?: Record<string, { calls?: number, hits?: number, injectedBytes?: number }>, bySource?: Record<string, number> }} */
        const stats = getInjectStats?.() || {}
        const meters = getPromptSegmentMeters?.()
        /** @type {{ systemPromptBytes?: number, toolSchemaBytes?: number, skillBytes?: number, injectedBytes?: number, skillCatalogBytes?: number }} */
        const segs = meters || {}
        const __injBytes = Number(stats.channels?.derived?.injectedBytes || 0)
        // S1.4 验收项「技能清单字节数进台账」（终审修复轮）：**本轮的目录段字节**（同一份
        // getPromptSegmentMeters 读数，与下面 segments 同源）送进总账的**顶层字段**。
        // ★ 为什么不塞进 segments：目录段是 `skill` 段的子集，塞进分段会让 totalBytes 重复计数，
        //   破坏 A13 的"字节和 = 实测注入量"（详见 kernel/inject-ledger.mjs#summarizeInjection 的注释）。
        const __catBytes = Number(meters?.skillCatalogBytes || 0)
        // T0.1：工具面真实字节（唯一求值点）。engine 每轮用 `tools.toolSchemas()` 发请求
        // （engine.mjs:1265/2631），这里量**同一个** registry ⇒ 口径与真实请求一致。
        // 名字集合签名做缓存（工具 schema 是进程内静态的；动态工具增删会改名字集合）。
        // 量不到（registry 异常）⇒ 沿用上次读数，不改既有控制流、不抛错。
        // ★ 2026-10-26：key 里并入**窗口** —— toolSchemas 现在会按窗口裁剪工具面
        //   （见 tools.mjs#toolSchemas），热切换模型改了窗口就必须重新计量，
        //   否则台账会一直显示旧窗口下的字节数（"省了多少"再次失去基线）。
        const __faceWindow = Number(context?.window) || contextWindow
        const __faceKey = `${__faceWindow}|${(engine.tools?.toolNames || []).join(',')}`
        if (__faceKey !== lastToolFace.key) {
          try {
            // 与真实请求同源：engine 每轮用 engine.mjs#toolSchemasNow() 求值（同一 window 口径）
            const schemas = engine.tools.toolSchemas({ window: __faceWindow })
            lastToolFace = { key: __faceKey, bytes: Buffer.byteLength(JSON.stringify(schemas), 'utf8'), count: schemas.length }
          } catch { /* 量不到就沿用上次读数（inject_snapshot 本身不得因计量失败而缺失） */ }
        }
        const __toolFaceBytes = Number(lastToolFace.bytes || 0)
        // ★ 那 ≈237 B 的「可用工具：…」行（system 文本内的名单行）不是 tools[] 面的一部分：
        //   它的旧口径就是 toolSchema 段。改成顶层观测字段（不进 segments，否则两个不同东西
        //   混进一个数），段名 toolSchema 保持不动、只修口径。
        const __toolListLineBytes = Number(segs.toolSchemaBytes || 0)
        // 越限可见（终审修复轮）：`ids` 终档是"宁超预算也不丢技能"的刻意取舍 ⇒ 必须有出口出声，
        // 否则"预算设了 200、实际装了 700"是静默的（事后只能靠读台账发现）。缺省不设限 ⇒ 不告警。
        if (skillCatalogBudget !== null && __catBytes > skillCatalogBudget && !skillCatalogOverWarned) {
          skillCatalogOverWarned = true
          log.warn(`技能清单超预算：本轮【可用技能】段 ${__catBytes} B > 生效预算 ${skillCatalogBudget} B ——`
            + ' ids 终档已是最简形态，"保留全部 id"优先于预算（不截断、不漏技能）。'
            + ' 要消掉本告警：上调 settings.skill.catalogBudgetBytes，或精简技能/触发词/描述。'
            + '（本进程只报一次）')
        }
        store.appendMeta('inject_snapshot', summarizeInjection({
          // ★ seq 不要传 —— appendMeta 内部已自管 nextSeq++；...extra 排在本条 entry.seq
          // 之后，传参会**覆盖**真实的写入顺序号（实测：会引发依赖 seq 的下游读取错位）
          segments: [{ id: 'systemPrompt', bytes: segs.systemPromptBytes || 0 },
                     { id: 'toolSchema', bytes: __toolFaceBytes },
                     { id: 'skill', bytes: segs.skillBytes || 0 },
                     { id: 'injected', bytes: (segs.injectedBytes || 0) + __injBytes }],
          skillCatalogBytes: __catBytes,
          toolListLineBytes: __toolListLineBytes,
          toolSchemaCount: Number(lastToolFace.count || 0),
          channels: stats.channels,
          bySource: stats.bySource,
          promptTier: process.env.PONOS_PROMPT_TIER === 'lean' ? 'lean' : 'full',
          sessionMode: chatMode ? 'chat' : 'task',
          kb: 'on',
        }))
        // ★ resetInjectStats 是进程级累计；逐轮读会拿到累计值 ⇒ 轮末读数后立即清零
        resetInjectStats?.()
      } catch { /* 账记失败绝不阻塞主流程 */ }
      // 演化P0·P-a（规格 §4.2）：轮末 guard 真值一条（与 inject_snapshot 同点同守卫）。
      // .guard 无 turnIndex/level（engine collectGuardState 是单一真源），此处按可溯源量派生：
      // turnIndex = 已完成轮数（getTurnStats 尾元素即本轮）；level = 自愈梯最高档名（ladder.highest）。
      // 防呆：取不到 → 跳过不报错；lastGuardTurnRecorded 防同轮重记（时序晚则下一轮补记，携真实 turnIndex）。
      try {
        const statsList = engine.getTurnStats?.() || []
        const turnIndex = statsList.length
        const cur = turnIndex > 0 ? statsList[turnIndex - 1] : null
        if (cur?.guard && turnIndex > lastGuardTurnRecorded) {
          const g = cur.guard
          store.appendMeta('guard_turn', {
            turnIndex,
            level: g.ladder?.highest || null,
            stallHeals: Number(g.stallHeals || 0),
            errorStreak: Number(g.errorStreak || 0),
            repeatStreak: Number(g.repeatStreak || 0),
            iterCapHit: g.iterCapHit === true,
            loopStopReason: g.loopStopReason || null,
          })
          lastGuardTurnRecorded = turnIndex
        }
      } catch { /* 取不到就跳过（规格防呆） */ }
      // T0.3（2026-10-20）轮级账本：与 guard_turn / inject_snapshot **同点同守卫**落一条
      // `meta kind='turn'`。为什么必须有：C_success 的分母是"成功任务数"，而成功性此前只在
      // 引擎内存的 `turnStats` 里（进程一退就没了）⇒ 分母不可从盘上算。
      // 纪律（三条）：
      //  · **只记统计与引用，不记正文**（沿用演化环隐私口径：数字 + id，不复制文本）；
      //  · 失败轮**同样落盘**且带 `ok:false` —— 只记成功轮会让失败次数永远为 0；
      //  · 失败不阻断主流程（与本体 inject_snapshot 同款 try/catch）。
      try {
        const statsList = engine.getTurnStats?.() || []
        const turnIndex = statsList.length
        const cur = turnIndex > 0 ? statsList[turnIndex - 1] : null
        if (cur && turnIndex > lastTurnLedgerRecorded) {
          // 行构造收口成纯函数（kernel/turn-ledger.mjs#buildTurnLedgerRow）：
          // 失败轮的 ok:false 分支因此可被单测**确定地**钉住（端到端造错误轮需要错误注入开关）。
          store.appendMeta('turn', buildTurnLedgerRow(cur, {
            turnIndex,
            toolDigest: turnOutcome?.toolDigest || [],
            priceOf: (m) => resolveModelPrices(String(m || ''), parseModelPricesEnv(process.env), process.env),
            // T3.2：本会话生效的治理策略（A/B 分组键；静态属性，启动时算一次）
            activeStrategies: activeStrategiesCache ??= resolveActiveStrategies({ env: process.env }).active,
          }))
          lastTurnLedgerRecorded = turnIndex
        }
      } catch { /* 账记失败绝不阻塞主流程（与上面 inject_snapshot 同一纪律） */ }
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
        // --until 判定已移入控制器（P1-5：终止逻辑单点收口，与 --goal 判词同源）：
        // 控制器在 nextDecision() 内判定并自行收尾（命中 --until / 判词异常两种原因，
        // 取值见 kernel/loop.mjs 的 END_REASONS），cli 只需照 decision 投递下一轮。
        // judged/reason/error 三个既有 iter 字段仍由控制器照原形状发出（零回归锁③）。
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
          // systemInjection 随条目带过去：engine.runTurn 据此给轮起点 user 条目打系统提示
          // 标记——否则系统来源插话（自动触发工作流结果）经这条兜底路径变回用户可见消息。
          state.queue.push({ message: { role: 'user', content: inj.content }, skipMemoryCapture: true, systemInjection: inj.system === true })
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
        // ★ 断言桥接（callee 缺口）：`id`/`runId` 是 callee 运行时实际接收项（无默认值的绑定整体
        //   缺席于推断类型，TS2353）；返回面投影为 WfRunView（union 的 ok 是宽 boolean ⇒ 不可判别）。
        //   正式补全在 kernel/workflow-engine.mjs 的任务。
        const r = /** @type {WfRunView} */ (await wfEngine.run(/** @type {Parameters<typeof wfEngine.run>[0] & { id?: string, runId?: string }} */ ({
          id: msg?.payload?.workflow || msg?.payload?.id || '',
          inputs: msg?.payload?.inputs || {},
          runId: msg?.payload?.runId || undefined,
          grant: msg?.payload?.grant || null,
          cwd: msg?.payload?.cwd || '',
        })))
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
        //
        // ★★ 2026-10-18 SEC-03 修复：`listen(port)` 不传 host 时 Node 绑 **0.0.0.0**
        //   （同网段任意主机可连）。这里显式收敛到回环，与桥的 LOOPBACK_HOST 同口径。
        //   鉴权与体量上限在 createWebhookServer 内（令牌闸 fail-closed），两处必须同时成立：
        //   只改绑定地址仍有"本机其它进程可触发"，只改鉴权仍有"局域网可达的攻击面"。
        const port = Number(process.env.PONOS_WF_WEBHOOK_PORT || 51312)
        const WEBHOOK_HOST = '127.0.0.1'
        if (!wfHttpServer) {
          wfHttpServer = wfEngine.createWebhookServer()
          wfHttpServer.listen(port, WEBHOOK_HOST, () => {
            const auth = process.env.PONOS_WF_WEBHOOK_TOKEN ? 'token' : 'denied(no PONOS_WF_WEBHOOK_TOKEN)'
            wire.system('workflow_result', { subtype: 'webhook', ok: true, port, host: WEBHOOK_HOST, auth, url: `http://${WEBHOOK_HOST}:${port}/wf/run/<id>` })
          })
          wfHttpServer.on('error', (err) => wire.system('workflow_result', { subtype: 'webhook', ok: false, error: err?.message || String(err) }))
        } else {
          const auth = process.env.PONOS_WF_WEBHOOK_TOKEN ? 'token' : 'denied(no PONOS_WF_WEBHOOK_TOKEN)'
          wire.system('workflow_result', { subtype: 'webhook', ok: true, port, host: WEBHOOK_HOST, auth, url: `http://${WEBHOOK_HOST}:${port}/wf/run/<id>`, note: 'already running' })
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
    // 像素层回执（P2a）：与 browser_response 同构，只是 subtype 不同。
    // 缺这一段 ⇒ engine.resolveScreen 永不被调用 ⇒ Screen 工具挂起到超时，
    // 而执行器其实正常返回了（表现为"每次都超时"，最难查的一类假失败）。
    if (subtype === 'screen_response') {
      engine.resolveScreen(req?.request?.requestId, req?.request)
    }
    // 应用桥响应（bridge 回写，server/app-routing.mjs，Task 4.x）：解除应用命令挂起。
    // 与 browser_response 同构，只是 subtype 与回执形状不同（app:run 回执）。
    if (subtype === 'app_response') {
      engine.resolveApp(req?.request?.requestId, req?.request)
      return
    }
    // 密码库回执（bridge 回写，server/vault-routing.mjs，2026-10-22）：解除 Vault 工具挂起。
    // 缺这一段 ⇒ engine.resolveVault 永不被调用 ⇒ Vault 工具每次挂到超时（同 screen_response
    // 注释里那类"执行器正常返回、模型却看到超时"的假失败）。必须 return，避免落入后续分支。
    if (subtype === 'vault_response') {
      engine.resolveVault(req?.request?.requestId, req?.request)
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
        // ★ 2026-10-26：与启动路径走**同一套优先级**（原实现是 `provider.contextWindow > 0
        //   ? 配置 : 表`，与启动的"表优先"口径相反 ⇒ 同一 provider 在两条路径上可能得到
        //   不同窗口）。探测值（source==='probe'）最高，手配值仍斗不过已知模型表。
        context.window = resolveContextWindowFor({
          model: provider.model,
          configured: provider.contextWindow,
          source: provider.contextWindowSource,
          env: process.env,
        })
        wire.system('context_window_retargeted', { model: provider.model, window: context.window })
        // ★★ 2026-10-26：窗口变了，**档位可能跨档**（1M → long-task，32K → small-window）。
        //   必须重新走 `resolveCompactSettings`（与启动路径**同一真源**），否则：
        //   ① GUI 仍显示旧档 ——"事件出声"反而会骗人；
        //   ② 条数门/保留比例仍按旧窗口算 ——切到本地小模型后压缩节奏全错。
        //   ★ 刻意用整函数重算而不是就地改几个字段：启动路径与热切换**口径分叉**正是本次
        //     要修的接缝类型（原来启动读表、热切换读配置，两条路各写各的）。
        try {
          const nextCfg = resolveCompactSettings({ window: context.window, settings: settings?.merged || {}, env: process.env })
          context.thresholdRatio = nextCfg.thresholdRatio
          context.retainRatio = nextCfg.retainRatio
          context.maxRetainRatio = nextCfg.maxRetainRatio
          context.keepTargetRatio = nextCfg.keepTargetRatio
          context.maxMessages = nextCfg.maxMessages
          context.escalateTokenFloor = nextCfg.escalateTokenFloor
          context.minSummaryIntervalCalls = nextCfg.minSummaryIntervalCalls
          wire.system('compact_profile', {
            profile: nextCfg.profile,
            source: nextCfg.profileSource,
            ...(nextCfg.profileRequested ? { requested: nextCfg.profileRequested } : {}),
            window: context.window,
            maxMessages: nextCfg.maxMessages,
            keepTargetRatio: nextCfg.keepTargetRatio,
            retainRatio: nextCfg.retainRatio,
            maxRetainRatio: nextCfg.maxRetainRatio,
            escalateTokenFloor: nextCfg.escalateTokenFloor,
            minSummaryIntervalCalls: nextCfg.minSummaryIntervalCalls,
            reason: 'provider_switch',
          })
        } catch { /* 档位重解析失败不影响切换主流程（保留旧参数） */ }
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
    // 循环模式热切换（2026-10-06 三层升级）：auto|react|plan|reflect，**下一轮轮首**生效
    // （钉住模式立即改 effective；auto 交还路由判定）。非法值**不改档**（与 approval_mode
    // 的静默回落不同——档位没生效必须可见），rejected 事件带回当前档位供 GUI 回滚选择器。
    if (subtype === 'loop_mode') {
      const raw = req?.request?.payload?.value
      const r = engine.setLoopMode(String(raw ?? '').trim())
      store.appendMeta('loop_mode', { value: r.value, selected: r.selected, effective: r.effective, source: r.ok ? 'user' : 'rejected' })
      if (r.ok) wire.system('loop_mode_updated', { value: r.value, selected: r.selected, effective: r.effective })
      else wire.system('loop_mode_rejected', { reason: `非法循环模式 ${JSON.stringify(raw)}（合法：auto|react|plan|reflect|subagent 或 custom:<workflowId>）`, value: r.value, selected: r.selected, effective: r.effective })
      return
    }
    // 路由模型热切换（2026-10-06 三层升级）：空串 = 回落当前激活模型；下一轮轮首生效
    if (subtype === 'router_model') {
      const r = engine.setRouterModel(String(req?.request?.payload?.value ?? '').trim())
      store.appendMeta('router_model', { value: r.value })
      wire.system('router_model_updated', { value: r.value, effective: r.effective })
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
      if (inner?.toolUseID) {
        engine.resolveApproval(inner.toolUseID, inner)
        // 演化P0·P-b（规格 §4.2）：审批决策落转录（投影按 toolUseId join 工具名）。
        // 边界（规格字面 vs 实况，见 brief D1）：只有 allow/deny 流经本分支——timeout 在
        // engine 就地 resolve（engine.mjs:1850-1857）、cancel 走 rejectAllWaiters
        // （engine.mjs:2811-2815），不经此写点；引擎侧不新增写点（写点唯一在 cli 侧）。
        try { store.appendMeta('approval_decision', { toolUseId: inner.toolUseID, behavior: inner.behavior }) } catch { /* 埋点失败不阻断 */ }
      }
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
    // stdin EOF：若仍有活跃轮次 / 排队消息 / 进行中 loop / workflow 命令 / **后台子任务**，
    // 延迟到完成后退出（管道测试与 bridge 优雅退出两全；30s 兜底防挂起）
    // 2026-09-21（长任务可靠性 P0）：纳入后台子任务 —— 否则 EOF 会把仍在跑的后台任务
    // 一起清掉，"任务完成 → 自动唤醒内核"的链路永远等不到（spec §4.4b-1）。
    const subBusy = () => (engine.pendingSubAgentsRunningCount?.() ?? 0) > 0
    // 2026-09-21（P1 Task 7）：存活的后台 Bash 同理 —— 退出会把它一起杀掉。
    const bgBusy = () => (engine.pendingBackgroundBashCount?.() ?? 0) > 0
    if (state.turnActive || state.queue.length || loop.isActive() || wfBusy > 0 || subBusy() || bgBusy()) {
      const timer = setInterval(() => {
        if (!state.turnActive && !state.queue.length && !loop.isActive() && wfBusy <= 0 && !subBusy() && !bgBusy()) {
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
// ★ 2026-11-01：入口判定加 realpath 兜底。`import.meta.url` 是**解析 symlink/junction 之后**的
//   真实路径，而 `process.argv[1]` 是调用方给的那条路径 ⇒ 只要安装/部署路径里有一层链接
//   （便携版被软链、目录 junction、某些备份/同步工具重建的目录），两者不等 ⇒ `isMain` 为假 ⇒
//   **内核静默什么都不做、退出码还是 0**（本机排查 bun 退场时实测撞到：release/installer 就是
//   junction）。补一条 realpath 比较：路径指向同一个文件即认为是入口；仍不等就不是主模块。
const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  if (import.meta.url === pathToFileURL(entry).href) return true
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
})()
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
    .catch((err) => { console.error('kernel:', err); process.exitCode = 1 })
}
