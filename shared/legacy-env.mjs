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
