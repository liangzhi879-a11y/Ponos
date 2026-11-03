// Ponos-turbo 审批放行档位（四档：manual / auto / loose / bypass）
// ---------------------------------------------------------------------------
// 设计：把"哪些操作需要用户批准"显式化成一条单调放宽的谱系。每一档恰好比上一档
// 多放行一类工具，因此判定就是一个谓词：
//     modeAllows(mode, class) === rank(mode) >= rank(ALLOW_FROM[class])
// 语义表（唯一真源，改动必须同步 docs/bridge-contract.md §2 与说明书 §5.10）：
//
//   工具类            manual  auto  loose(默认)  bypass
//   只读              allow   allow  allow        allow
//   普通 Bash         ask     allow  allow        allow
//   写文件            ask     ask    allow        allow
//   出网/浏览器       ask     ask    allow        allow
//   子 agent/技能/工作流 ask  ask    allow        allow
//   未识别(MCP 等)    ask     ask    allow        allow
//   应用智控(app_*)   ask     ask    ask          allow   ← 兜底保守档；read/write 精确区分由显式规则负责
//   高危 Bash         ask     ask    ask          allow
//   灾难命令(黑名单)  ask(硬) ask(硬) ask(硬)      ask(硬)   ← 见 blacklist.mjs，永不自动放行
//
// 兼容性核心（deriveApprovalMode）：不传档位时按旧 flag 推导——`skipPermissions`
// 无论真假都映射到 loose（= 今天的裸内核行为，非 Bash 工具一直是无条件 allow），
// 只有 `skipPermissions && autoApproveHighRisk`（headless 免批准）才到 bypass。
// **不能**把"未跳权限"映射成 manual：那会把写文件从 allow 变 ask，属于行为回归。
// 因此 manual/auto 只能由显式选择到达（--approval-mode / settings.json / GUI）。
// 纯函数；唯一外部依赖 = shared/egress-tools.mjs 的出网名单常量表（纯数据，无副作用）。

import { EGRESS_NET_TOOLS } from '../shared/egress-tools.mjs'
// ★ P2b（2026-10-15）：`Screen` 按 act 分类的判据取自**契约真源** —— 本文件不另写一份 act 名单
//   （本仓两次踩过"同一份名单抄两遍"：CHAT_MODE_DISALLOWED 漏 Screen、排除清单两侧 trim 不一致）。
//   `shared/screen-contract.cjs` 是 CJS，但 ESM 侧具名导入可用（同 kernel/engine.mjs 的先例）。
import { isInputAct } from '../shared/screen-contract.cjs'

export const APPROVAL_MODES = ['manual', 'auto', 'loose', 'bypass']
export const DEFAULT_APPROVAL_MODE = 'loose'
// 宽松序（越大越宽）；判定只依赖它
export const APPROVAL_RANK = { manual: 0, auto: 1, loose: 2, bypass: 3 }

// 工具类 → 从哪一档起自动放行
export const TOOL_CLASS_ALLOW_FROM = {
  read: 'manual',        // 只读：任何档位都自动
  exec: 'auto',          // 普通 Bash
  write: 'loose',        // 写文件
  net: 'loose',          // 出网 / 浏览器
  agent: 'loose',        // 子 agent / 技能 / 工作流
  unknown: 'loose',      // 未识别工具（MCP、动态工具）→ 与 agent 同级，保持现状
  appTool: 'bypass',      // 应用智控（app_*）：动态生成、无法静态分级 → 保守从严，默认档不放行
  highRiskBash: 'bypass', // 高危 Bash（highrisk.mjs）
}

// 注册表全量工具名（kernel/tools.mjs）分类；MultiEdit/NotebookEdit 为兼容外部工具名保留
// ★ E2 ①/Task 2 订正（假开关②）：`Vision` 与 `SkillSearch` 此前被归进 read ⇒ 任何档位都自动放行，
//   而它们**真的出网**：Vision 向 provider 发 POST（kernel/media-tools.mjs:340 `fetch(url, …)`）、
//   SkillSearch 抓技能市场/仓库（kernel/skill-search.mjs:50 `fetchText(...)`，node:http(s) 直连）。
//   归到 net ⇒ 与 WebFetch/WebSearch 同等受档位约束（manual/auto 档开始询问）。
// ProjectAtlas（P1.1）：只读索引查询（可能懒构建缓存，但不改用户文件）⇒ read 档，任何档位自动放行。
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ProjectAtlas', 'MemorySearch', 'KnowledgeSearch', 'OCR', 'TodoWrite',
  // 2026-10-26：工具按需加载的检索入口。**只读**（查内存里的 deferred 清单并返回 schema，
  // 不读盘、不上网、不起子进程）⇒ 归 read。必须显式登记：落 unknown 会走 `loose`（默认档）
  // = 默认放行，而它的执行体随后可能触发 MCP 工具的调用审批 —— 那一层有自己的把关，
  // 但检索动作本身不该被待审（否则每次加载工具都要用户点一次，deferred 就没法用了）。
  'ToolSearch'])
// ★★ 2026-10-18 AI-01 修复：`KnowledgeImport` / `KnowledgeDelete` 此前**两个集合都没有** ⇒
//   `classifyTool` 落到末尾的 `unknown`，而 `TOOL_CLASS_ALLOW_FROM.unknown` 的来源档是
//   `'loose'`（**默认档**）⇒ 默认配置下"知识库导入（写盘）"与"回收站清理（破坏性）"
//   不经任何审批就执行。而 `kernel/tools.mjs#CHAT_MODE_DISALLOWED` 早已把它们计入
//   写盘类（"写盘能力"/"写盘且带破坏性"），说明归属本就明确，只是没同步到这张表。
//   ⇒ 归入 `write`（允许档 loose 之外的档才放行：manual/auto 必问），与其破坏性相称。
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'SkillDraft', 'KnowledgeImport', 'KnowledgeDelete'])
// ★ 修复轮 R=1：出网名单**不在本文件写字面量** —— 唯一真源 `shared/egress-tools.mjs#EGRESS_NET_TOOLS`
//   （`EGRESS_WEB_TOOLS ⊆ EGRESS_NET_TOOLS`）。此前这里另有一份 `new Set([...])`，与
//   kernel/workflow-nodes.mjs 的 `EGRESS_TOOLS` 各写各的 ⇒ 新增出网工具时必然漂移（一份改、一份忘）。
const NET_TOOLS = new Set(EGRESS_NET_TOOLS)
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Skill', 'Workflow', 'Browser'])
// ★ Screen（P2 computeruse 像素层，2026-10-14 登记；★ 2026-10-15 P2b 改档：按 act 细分，见 classifyTool）：
//   **必须显式登记**，不能落进 unknown。为什么这是安全前提而不是文档工作：
//   `TOOL_CLASS_ALLOW_FROM.unknown` 的来源档是 `'loose'`（默认档），而 `Screen` 可能截取用户整个
//   屏幕（spec §2.2 E5 实测：一张窗口截图即把真实客户项目名与会话内容读入模型上下文）
//   ⇒ 不登记 = 默认档自动放行 = 静默扩大攻击面。
//   · 只读 act（displays/windows/capture）⇒ `read`（任何档位自动执行，同 OCR/Vision 这类只读感知）；
//   · 输入 act（move/clickAt/drag/scroll/keyCombo）⇒ `appTool`（允许档 bypass ⇒ **默认档逐次 ask**）。
//   ★ 分期注记（P2a 期在此写过"P2b 必须回来改成保守档"）：本行即那次改动的落点 ——
//     改的是"**按 act** 分类"，而不是把整个 Screen 收成保守类：后者会让每次 displays/windows/capture
//     都弹审批（它们不产生任何副作用），结果是审批疲劳 ⇒ 用户学会无脑点"允许"。
const SCREEN_TOOLS = new Set(['Screen'])

export function isValidApprovalMode(v) {
  return APPROVAL_MODES.includes(String(v ?? '').trim().toLowerCase())
}

// 非法/缺失 → 默认档（永不抛：档位来自 config/flag/stdin，任何脏值都不该让内核崩）
export function normalizeApprovalMode(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return APPROVAL_MODES.includes(s) ? s : DEFAULT_APPROVAL_MODE
}

/**
 * 工具名（+ 入参）→ 工具类。**唯一真源**，改动须同步 `docs/bridge-contract.md` §2 的档位表。
 *
 * @param {any} toolName
 * @param {any} [input] 工具入参。**只有 Screen 需要它**（P2b 按 act 细分）；其它分类纯按名字。
 *   传不进来时的取向是**保守**（见下方 Screen 分支），故缺参不会静默放宽权限。
 */
export function classifyTool(toolName, input) {
  const name = String(toolName || '')
  if (name === 'Bash') return 'exec'
  // 应用智控：工具名由用户目标动态生成，静态表无法判定 read/write → 一律归入保守类（默认档 ask）。
  // 精确的 read 放行 / write 询问由内核按 Spec 的 kind 注入显式规则完成；显式规则优先级高于档位表，
  // 因此 write 在任何档位（含 bypass）都会被询问。
  if (/^app_/.test(name)) return 'appTool'
  if (SCREEN_TOOLS.has(name)) {
    // ★ P2b（2026-10-15）：**按 act 分类**。
    //   · 只读 act（displays/windows/capture）保持 `read`：它们不产生任何副作用，收成保守类会让
    //     每次观测都弹审批（审批疲劳 ⇒ 用户学会无脑点"允许"，反而降低整体安全性）。
    //   · 输入 act ⇒ `appTool`：其允许档是 `bypass` ⇒ **默认档（loose）逐次 ask**，
    //     与 spec §3.3 的"逐次确认"语义一致（不用 `write`：它的允许档是 loose = 默认档直接放行；
    //     不用 `exec`：manual 档会把只读也一并收严，语义不符）。
    //   ★ 判据来自契约真源 `isInputAct` —— 不在此另写一份 act 名单。
    //   ★ **缺 input / 缺 action 时按"输入"处理**（fail in the conservative direction）：
    //     调用方忘了传 input 时若判成只读，就等于给输入 act 开了一条静默放行的口子
    //     （方向是 fail-open，正是最不能出错的地方）。
    const act = String(input?.action ?? '').trim()
    return (isInputAct(act) || !act) ? 'appTool' : 'read'
  }
  // ★ Vault（密码库，2026-10 登记）：`get` 返回**明文密码/令牌**，`set` 写加密库 ⇒ 不能落 unknown
  //   （`unknown` 的来源档是 `loose` = 默认档，那等于默认配置下静默读走用户全部凭据）。
  //   档位选择同 Screen 输入 act 的先例：借 `appTool` 的允许档 `bypass` 表达"**默认档逐次 ask**"。
  //   不用 `write`：它的允许档就是 `loose`（默认档直接放行）；也不用 `read`：那是任何档位自动放行。
  //   ⇒ 这是"按最保守读"的工具，别改回 write。
  if (name === 'Vault') return 'appTool'
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (NET_TOOLS.has(name)) return 'net'
  if (AGENT_TOOLS.has(name)) return 'agent'
  return 'unknown'
}

export function modeAllows(mode, toolClass) {
  const from = TOOL_CLASS_ALLOW_FROM[toolClass] || 'loose'
  return APPROVAL_RANK[normalizeApprovalMode(mode)] >= APPROVAL_RANK[from]
}

// 旧 flag → 档位（内核不带 --approval-mode 时的兜底；见文件头"兼容性核心"）
/**
 * @param {{ skipPermissions?: any, autoApproveHighRisk?: any }} [opts]
 */
export function deriveApprovalMode({ skipPermissions, autoApproveHighRisk } = {}) {
  if (skipPermissions && autoApproveHighRisk) return 'bypass'
  return DEFAULT_APPROVAL_MODE
}
