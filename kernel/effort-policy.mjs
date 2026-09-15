// 思考策略（K3.1 / Task 12）——**唯一**决定「本步要不要思考」的地方
// ---------------------------------------------------------------------------
// 为什么只有 on/off、没有四档阶梯：
//   Task 11 实测（docs/superpowers/specs/2026-09-13-perf-systematic-optimization-design.md §6）
//   在本 provider（deepseek-v4-flash）上 `budget_tokens` 与 `reasoning_effort` **都不控
//   思考量**——1024 vs 4096 区间重叠、轮 1 甚至反超；`reasoning_effort` 两轮方向相反；
//   `adaptive` 被端点接受但无优势。唯一有量级效应的旋钮是 **thinking 的开与关**
//   （关掉后中位墙钟 3.1× / 1.5×，16/16 全对）。四套参考实现（claude-code / codex /
//   deepseek-harness / pi）也全部是「配置维度 + 阶段边界」，**零运行时启发式**——同设置内
//   跑次间方差 10.7×，任何逐步微调都会被噪声吞掉。
//
// 启用范围（用户 2026-09-13 决策）：**只对摘要/压缩步** off，常规步一律不干预。
//   这一档有直接先例（claude-code 的压缩步直接 thinking:{type:'disabled'}）：该步产出是
//   结构化摘要，不需要探索性推理，质量风险几乎为零。回退 = PONOS_EFFORT_POLICY=off。
//
// **未实现的两条运行时启发式（刻意留白，不是遗漏）**：原计划里的「上一步 tool_result 为
//   is_error → 升档」「紧跟压缩后的第一步 → 升档」，在「只对摘要步 off」这个范围下
//   **永远不可能触发**（常规步本就不干预）⇒ 写了就是死代码。若将来把范围扩大到常规步，
//   必须与「用户 effortLevel:'off' 时策略不得开」这条一起实现，并有实测数据背书。

// 合法值只此两个。'graded' = 按阶段分档（当前只降摘要步）；'off' = 策略完全不干预。
export const EFFORT_POLICIES = ['graded', 'off']
export const DEFAULT_EFFORT_POLICY = 'graded'

// 解析层放**一处**：合法值、别名、未知值降级全写死在这里，调用点不做 if。
// 范式：claude-code `utils/effort.ts:136-167` 的三层链 + codex `reasoning_effort.rs` 的
// 「别名 → 线协议值」降级表。
export function resolveEffortPolicy(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return DEFAULT_EFFORT_POLICY
  if (EFFORT_POLICIES.includes(v)) return v
  // 常见别名/误写归一到唯一语义，而不是静默生效成一个别的意思
  if (v === 'on' || v === 'true' || v === '1' || v === 'enabled') return 'graded'
  if (v === '0' || v === 'false' || v === 'disabled' || v === 'none') return 'off'
  return DEFAULT_EFFORT_POLICY // 未知值 → 默认，绝不抛（静默降级是内核契约）
}

// **必须惰性读 env**：cli.mjs 的 settings.env 注入发生在所有 ESM 模块求值之后，
// 写成模块级常量必然拿不到（同一个坑见 engine-adaptive-firstbyte.test.mjs 头部注释）。
export function effortPolicyFromEnv(env = process.env) {
  return resolveEffortPolicy(env.PONOS_EFFORT_POLICY)
}

// 判据（纯函数）。返回 'off' = 本步关思考；'on' = **不干预**。
// 'on' 的语义是「不干预」而非「强制开思考」——用户档位与 provider 思考开关照旧生效，
// 这正是「只降不升」：策略永远不能把用户关掉的思考打开，也不会把没配的思考打开。
export function pickStepThinking({ kind, policy = effortPolicyFromEnv() } = {}) {
  if (resolveEffortPolicy(policy) === 'off') return 'on' // 回退开关：策略不干预
  if (kind === 'summary') return 'off'                   // 当前唯一启用点（摘要/压缩步）
  return 'on'                                            // 常规步 / 保真审计步：维持现状
}
