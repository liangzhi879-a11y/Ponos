// 旧名兼容垫片：历史版本使用的外部命名环境变量 → 本项目自有 PONOS_* 主名。
//
// 设计（单点实现）：
//   · 本模块是**唯一**的旧名→主名映射表与实现，不要在别处硬编码旧名。
//   · `applyLegacyEnvAliases()` 在 env 进入进程的两个入口各调用一次：
//       ① `kernel/legacy-env-boot.mjs`（内核 CLI 的首个 import，早于任何模块顶层读取）；
//       ② `loadSettings()` 合并 settings.json 的 env 之后（覆盖配置来源的旧键）。
//   · 语义：**主名优先，旧名只兜底**（主名已设置时绝不覆盖）；不做删除，旧名原样留在 env 中。
//
// 边界：`ANTHROPIC_VERSION` 与 HTTP 头 `anthropic-version` 属 wire 协议契约（值为 2023-06-01），
// 不属本表；协议名 "Anthropic Messages API" 亦为既有技术名，不改。

/** 主名 → 兼容旧名（按优先级排列，首个命中的生效）。 */
export const LEGACY_ENV_ALIASES = Object.freeze({
  // ── 数据根与配置目录 ──
  PONOS_CONFIG_DIR: ['CLAUDE_CONFIG_DIR'],
  // ── 模型与端点（Anthropic 兼容协议时代沿用名）──
  PONOS_BASE_URL: ['ANTHROPIC_BASE_URL'],
  PONOS_AUTH_TOKEN: ['ANTHROPIC_AUTH_TOKEN'],
  PONOS_API_KEY: ['ANTHROPIC_API_KEY'],
  PONOS_MODEL: ['ANTHROPIC_MODEL'],
  PONOS_AUTH_SCHEME: ['ANTHROPIC_AUTH_SCHEME'],
  PONOS_DEFAULT_SONNET_MODEL: ['ANTHROPIC_DEFAULT_SONNET_MODEL'],
  PONOS_DEFAULT_OPUS_MODEL: ['ANTHROPIC_DEFAULT_OPUS_MODEL'],
  PONOS_DEFAULT_HAIKU_MODEL: ['ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  // ── 单轮产出与预算 ──
  PONOS_MAX_OUTPUT_TOKENS: ['CLAUDE_CODE_MAX_OUTPUT_TOKENS'],
  PONOS_THINKING_ENABLED: ['CLAUDE_CODE_THINKING_ENABLED'],
  PONOS_THINKING_BUDGET: ['CLAUDE_CODE_THINKING_BUDGET'],
  PONOS_REASONING_EFFORT: ['CLAUDE_CODE_EFFORT_LEVEL'],
  // ── 上下文与压缩 ──
  PONOS_AUTO_COMPACT_WINDOW: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
  PONOS_COMPACT_RESERVE: ['CLAUDE_CODE_COMPACT_RESERVE'],
  PONOS_COMPACTION_RETRIES: ['CLAUDE_CODE_COMPACTION_RETRIES'],
  PONOS_COMPACT_MAX_MESSAGES: ['CLAUDE_CODE_COMPACT_MAX_MESSAGES'],
  PONOS_TOKEN_DENSITY_CODE: ['CLAUDE_CODE_TOKEN_DENSITY_CODE'],
  PONOS_TOKEN_DENSITY_TEXT: ['CLAUDE_CODE_TOKEN_DENSITY_TEXT'],
  PONOS_TOKEN_DENSITY_CJK: ['CLAUDE_CODE_TOKEN_DENSITY_CJK'],
  // ── 工具结果预算（旧名含布尔形态，一并兜底）──
  PONOS_TOOL_RESULT_BUDGET_BYTES: ['CLAUDE_CODE_TOOL_RESULT_BUDGET_BYTES', 'CLAUDE_CODE_TOOL_RESULT_BUDGET'],
  PONOS_TOOL_RESULT_BATCH_BUDGET: ['CLAUDE_CODE_TOOL_RESULT_BATCH_BUDGET'],
  PONOS_TOOL_RESULT_KEEP_RECENT: ['CLAUDE_CODE_TOOL_RESULT_KEEP_RECENT'],
  PONOS_TOOL_RESULT_CLEAR_RATIO: ['CLAUDE_CODE_TOOL_RESULT_CLEAR_RATIO'],
  PONOS_TOOL_TIMEOUT_MS: ['CLAUDE_CODE_TOOL_TIMEOUT_MS'],
  // ── 传输与重试 ──
  PONOS_CONNECT_TIMEOUT_MS: ['CLAUDE_CODE_CONNECT_TIMEOUT_MS'],
  PONOS_STREAM_IDLE_TIMEOUT_MS: ['CLAUDE_CODE_STREAM_IDLE_TIMEOUT_MS'],
  PONOS_STREAM_RECONNECTS: ['CLAUDE_CODE_STREAM_RECONNECTS'],
  PONOS_API_RETRIES: ['CLAUDE_CODE_API_RETRIES'],
  // ── 观测与判定 ──
  PONOS_LOG_LEVEL: ['CLAUDE_CODE_LOG_LEVEL'],
  PONOS_LLM_JUDGE: ['CLAUDE_CODE_LLM_JUDGE'],
  PONOS_AGENT_TRIGGERS: ['CLAUDE_CODE_AGENT_TRIGGERS'],
})

/**
 * 把 env 中的旧名映射到主名（主名优先，不覆盖已有值）。
 * @param {Record<string,string|undefined>} env 目标环境对象，默认 process.env
 * @returns {string[]} 实际生效的映射（形如 `旧名→主名`），便于日志与测试断言
 */
export function applyLegacyEnvAliases(env = process.env) {
  const applied = []
  for (const [canonical, legacyNames] of Object.entries(LEGACY_ENV_ALIASES)) {
    if (env[canonical] !== undefined && env[canonical] !== '') continue
    for (const legacy of legacyNames) {
      const value = env[legacy]
      if (value === undefined || value === '') continue
      env[canonical] = value
      applied.push(`${legacy}→${canonical}`)
      break
    }
  }
  return applied
}

/** 主名 → 该主名对应的兼容旧名列表（无旧名时返回空数组）。 */
export function legacyNamesOf(canonical) {
  return LEGACY_ENV_ALIASES[canonical] || []
}

/**
 * ★ 凭据类主名（"能拿去出网调模型"的那几个 env）：端点 / 凭据 / 模型 / 协议 / 视觉端点。
 *
 * 为什么这份清单放在**本模块**（而不是各消费方各写一份）：本模块是"env 名与它的历史别名"的
 * **唯一**知识源 —— `LEGACY_ENV_ALIASES` 在这里，`credentialEnvKeys()` 的派生也必须在同一处，
 * 否则"清理集合"与"内核认得的名字"会各说一套（2026-09-26 审查实测的病根就是这个：
 * `server/bridge.mjs` 只清了主名，而内核经 `legacy-env-boot.mjs` 把 `ANTHROPIC_*` 映射回主名，
 * 于是**未放行档下凭据照样发出去**）。
 *
 * ★ 为什么含视觉/协议类：内核 `kernel/provider.mjs` 的 `visionEnv()` 同时认
 * `PONOS_VISION_*` 与 `YFW_VISION_*`（以 `PONOS_` 为主、`YFW_` 为兼容回退），
 * 而写盘侧（`syncKernelSettings`）用的是 `YFW_VISION_*`、注入侧（`buildChildEnv`）用 `PONOS_VISION_*`
 * ⇒ **两条命名都要清**（否则漏掉的那条会以明文形态留在 settings.json 里 —— 2026-09-26 复审即实测到
 * `PONOS_VISION_AUTH_TOKEN` 在真数据根上残留）；`PONOS_API_FORMAT` /
 * `PONOS_MODEL_OPENAI|ANTHROPIC` 决定"往哪个端点用哪个模型发"，同属"能拿去出网"的一类。
 */
const CREDENTIAL_CANONICAL = Object.freeze([
  // 模型服务主链路
  'PONOS_BASE_URL', 'PONOS_AUTH_TOKEN', 'PONOS_API_KEY', 'PONOS_AUTH_SCHEME',
  'PONOS_MODEL', 'PONOS_DEFAULT_SONNET_MODEL', 'PONOS_DEFAULT_OPUS_MODEL', 'PONOS_DEFAULT_HAIKU_MODEL',
  'PONOS_API_FORMAT', 'PONOS_MODEL_OPENAI', 'PONOS_MODEL_ANTHROPIC',
])

/** 视觉端点（独立 provider）：内核两种前缀都认，两种都要能收口。无旧名（不在 LEGACY_ENV_ALIASES 里）。 */
const CREDENTIAL_VISION_BASE = Object.freeze(['BASE_URL', 'AUTH_TOKEN', 'MODEL', 'API_FORMAT'])

/**
 * 凭据名集合（**唯一派生入口**）：主名 ∪ 各主名的 `legacyNamesOf(...)` 旧名 ∪ 视觉双前缀名。
 * 消费方（`server/bridge.mjs#buildChildEnv` / `syncKernelSettings`）**只能**用它，
 * **不得**另抄一份名单（同一判据两份实现 = 本仓明令禁止，且上一轮就是这个病根）。
 * @returns {string[]} 去重后的凭据类 env 名（含 `ANTHROPIC_*`, `CLAUDE_*` 等历史名）
 */
export function credentialEnvKeys() {
  const out = new Set()
  for (const canonical of CREDENTIAL_CANONICAL) {
    out.add(canonical)
    for (const legacy of legacyNamesOf(canonical)) out.add(legacy)
  }
  for (const suffix of CREDENTIAL_VISION_BASE) {
    out.add(`PONOS_VISION_${suffix}`)
    out.add(`YFW_VISION_${suffix}`)
  }
  return [...out]
}

/**
 * 「秘密」子集（**唯一派生入口**）：值本身就是凭据的键（以 `AUTH_TOKEN` / `API_KEY` 结尾）。
 *
 * ★ 为什么不能直接用 `credentialEnvKeys()` 去清 settings.json：
 *   它还含 `BASE_URL` / `MODEL` / `API_FORMAT` / `AUTH_SCHEME` —— 那些是**配置**不是秘密；
 *   清空它们等于毁掉用户的模型名与端点。**秘密才清，配置照写**。
 *
 * ★ 为什么必须有这个函数（2026-09-26 复审在真机上实测出的洞）：
 *   `shared/vault-credential.cjs` 此前**手写**了一份 6 键名单，**漏了 `PONOS_VISION_AUTH_TOKEN`**
 *   —— 而 `kernel/media-tools.mjs` 读的**正是**这个键（`syncKernelSettings` 写的却是
 *   `YFW_VISION_AUTH_TOKEN`，内核侧无读者）⇒ 该 vision 明文在真数据根上
 *   **既不会被迁移清掉、也不会被同步钉成空串**。⇒ 秘密键名**只能**从这里派生，**不得再手抄**
 *   （同一判据两份实现 = 本仓明令禁止，这一轮又是它出的问题）。
 *
 * @returns {string[]} 秘密类 env 名（主名 ∪ 旧名 ∪ 视觉双前缀中，以 AUTH_TOKEN/API_KEY 结尾者）
 */
const SECRET_SUFFIXES = Object.freeze(['AUTH_TOKEN', 'API_KEY'])
export function secretCredentialEnvKeys() {
  return credentialEnvKeys().filter((k) => SECRET_SUFFIXES.some((s) => k.endsWith(s)))
}
