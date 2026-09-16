'use strict'
// server/egress-policy.cjs —— S2-D3 **数据出网闸**的唯一实现（CJS 双用，与 D2 的 bridge-token 同构）。
//
// 【"出网"的确切语义】= **过团队源**（分享到团队知识空间/团队工作流库/文件 CAS，供他人可见），
// **不是**"访问 LLM provider"。后者是用户显式操作 + 热·凭据范畴，不在本闸门内（见 plan §6 边界 2）。
//
// 依据（spec 2026-09-14-team-collaboration-design）：
//   §4 P2  出网闸为**白名单式**：数据实体默认 `local-only`，**显式标记才可外发**。黑名单式屏蔽必漏。
//   §4 P1  热状态（运行中会话/审批/浏览器/工具执行/**凭据**）纯本地、**永不**参与同步。
//   §5.1   冷·敏感（transcript 全文/绝对路径/命令）默认不同步；显式分享时**必须过 kernel/redact.mjs**。
//   §6.2 D3 白名单式闸门落在 bridge 请求入口（与 D2 同层——所有读写的唯一仲裁点）；实体带 syncPolicy。
//   §10 S2-3 默认配置下，transcript/config 等敏感数据**无任何出网路径**。
//
// 【为什么单机版（L1）只交付"判定内核 + 唯一判定面"】团队源与同步链路属 S3（§7 边界）。此处若造一条
// 同步路由，等于实现 S3 的东西（越线）。本模块把"什么数据允许过团队源"固化成**唯一判定入口**，
// 供 S3 导入即用；单机版的默认档（local-only）下，一切实体都出不去——这正是 §10 S2-3 的字面要求。

/**
 * 实体分层（照 §5.1 的四类）。
 * 新增实体必须归入其中一档；**未知实体一律拒绝**（白名单式，P2）。
 */
const EGRESS_TIERS = Object.freeze({
  hot: 'hot',                     // 热·永不：运行中状态与凭据
  sensitive: 'sensitive',         // 冷·敏感：默认不同步，显式分享须过脱敏
  content: 'cold-content',        // 冷·内容：双向
  telemetry: 'cold-telemetry',    // 冷·遥测：单向上行
})

/** 实体 → 档位。`config` 含明文 provider token，故与 `credential` 同属热·永不（§10 S2-3 点名）。 */
const EGRESS_ENTITIES = Object.freeze({
  // 热·永不（§5.1 表尾「热 … ❌ 永不」+ P1）
  config: EGRESS_TIERS.hot,
  credential: EGRESS_TIERS.hot,
  conversation: EGRESS_TIERS.hot,
  approval: EGRESS_TIERS.hot,
  browser: EGRESS_TIERS.hot,
  'tool-exec': EGRESS_TIERS.hot,
  // 冷·敏感（§5.1「❌ 默认不同步；显式分享时必须过 kernel/redact.mjs」）
  transcript: EGRESS_TIERS.sensitive,
  'abs-path': EGRESS_TIERS.sensitive,
  command: EGRESS_TIERS.sensitive,
  // 冷·内容（「✅ 双向」）
  knowledge: EGRESS_TIERS.content,
  experience: EGRESS_TIERS.content,
  'workflow-def': EGRESS_TIERS.content,
  'file-version': EGRESS_TIERS.content,
  tag: EGRESS_TIERS.content,
  // 冷·遥测（「⬆️ 单向上行」）
  usage: EGRESS_TIERS.telemetry,
  'session-meta': EGRESS_TIERS.telemetry,
  audit: EGRESS_TIERS.telemetry,
})

/** 数据实体的 syncPolicy 取值；**默认 `local-only`**（P2）。 */
const SYNC_POLICY = Object.freeze({
  LOCAL_ONLY: 'local-only',
  SYNC_OK: 'sync-ok',
})

/** 整档开关；默认本地封闭档 —— 该档下**任何**实体都出不去（§10 S2-3）。 */
const EGRESS_MODE = Object.freeze({
  LOCAL_ONLY: 'local-only',
  SYNC_ENABLED: 'sync-enabled',
})

/**
 * 拒绝原因（稳定枚举）。测试断言与排障都依赖它，**改动即破坏契约**，勿随手重命名。
 */
const EGRESS_REASON = Object.freeze({
  ALLOWED: 'allowed',
  MODE_LOCAL_ONLY: 'mode-local-only',                   // 整档封闭
  UNKNOWN_ENTITY: 'unknown-entity',                     // 白名单外
  HOT_NEVER_SYNCS: 'hot-never-syncs',                   // 热·永不（显式标记也无效）
  POLICY_LOCAL_ONLY: 'policy-local-only',               // 实体未显式标记
  SENSITIVE_REQUIRES_REDACT: 'sensitive-requires-redact', // 敏感类缺脱敏证据
})

/**
 * 出网判定（**唯一入口**）。
 *
 * 判定顺序即优先级，逐条都有据：
 *   1. 整档封闭 ⇒ 拒（§10 S2-3「默认配置下…无任何出网路径」——最高优先，压过任何实体标记）
 *   2. 未知实体   ⇒ 拒（P2 白名单）
 *   3. 热·永不    ⇒ 拒（P1「永不」——**显式标记也不能推翻**，这是与"未标记"不同的失败原因）
 *   4. 未显式标记 ⇒ 拒（P2「显式标记才可外发」）
 *   5. 冷·敏感    ⇒ 需 `redacted === true`（§5.1「必须过 kernel/redact.mjs」）
 *   6. 其余        ⇒ 放行
 *
 * `redacted` 是**调用方**在真的调过 `kernel/redact.mjs`（`redactText`/`redactEntry`）之后置位的证据位；
 * 本模块不代替脱敏执行——把"是否允许出网"与"如何脱敏"揉在一起会让两者都无法单独验证。
 *
 * 返回的 `audit` **只含实体/档位/结论/原因**，不含任何数据正文（避免审计本身成为泄露通道）。
 */
function authorizeEgress(entity, { policy = SYNC_POLICY.LOCAL_ONLY, redacted = false, mode = EGRESS_MODE.LOCAL_ONLY, now = Date.now() } = {}) {
  const tier = EGRESS_ENTITIES[entity] || null
  const deny = (reason) => ({
    allowed: false,
    reason,
    audit: { at: now, entity, tier, policy, allowed: false, reason },
  })

  if (mode !== EGRESS_MODE.SYNC_ENABLED) return deny(EGRESS_REASON.MODE_LOCAL_ONLY)
  if (!tier) return deny(EGRESS_REASON.UNKNOWN_ENTITY)
  if (tier === EGRESS_TIERS.hot) return deny(EGRESS_REASON.HOT_NEVER_SYNCS)
  if (policy !== SYNC_POLICY.SYNC_OK) return deny(EGRESS_REASON.POLICY_LOCAL_ONLY)
  if (tier === EGRESS_TIERS.sensitive && redacted !== true) return deny(EGRESS_REASON.SENSITIVE_REQUIRES_REDACT)

  return {
    allowed: true,
    reason: EGRESS_REASON.ALLOWED,
    audit: { at: now, entity, tier, policy, allowed: true, reason: EGRESS_REASON.ALLOWED },
  }
}

/**
 * 全部实体的当前出网结论（供 bridge 的 `/egress/policy` 只读面与排障）。
 *
 * `policies` 为调用方给出的"已显式标记"集合（单机版为空 ⇒ 全部 local-only）；
 * `redactedEntities` 同理。默认档或未标记时，结果里每个实体都应是 `allowed:false`。
 */
function listEgressPolicy({ mode = EGRESS_MODE.LOCAL_ONLY, policies = {}, redactedEntities = [] } = {}) {
  const redactedSet = new Set(redactedEntities)
  const entities = Object.keys(EGRESS_ENTITIES).map((entity) => {
    const policy = policies[entity] === SYNC_POLICY.SYNC_OK ? SYNC_POLICY.SYNC_OK : SYNC_POLICY.LOCAL_ONLY
    const r = authorizeEgress(entity, { policy, redacted: redactedSet.has(entity), mode })
    return { entity, tier: EGRESS_ENTITIES[entity], policy, allowed: r.allowed, reason: r.reason }
  })
  return {
    mode,
    // 「无任何出网路径」的可直接断言项：默认档下必须为空数组
    allowedEntities: entities.filter((e) => e.allowed).map((e) => e.entity),
    entities,
  }
}

module.exports = {
  EGRESS_TIERS,
  EGRESS_ENTITIES,
  SYNC_POLICY,
  EGRESS_MODE,
  EGRESS_REASON,
  authorizeEgress,
  listEgressPolicy,
}
