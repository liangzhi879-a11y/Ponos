// src/lib/appQuality.ts —— 应用质检的**纯逻辑**（指纹 / 何时自动跑 / 提示词）
//
// 为什么单独成文件且零依赖：本模块要被 `node --test` 直接 import（见 appQuality.test.ts），
// 而 `.tsx` 无法被 node --test 加载、`chatStore` 那侧又有 `@/` 运行期别名——所以三条纪律：
//   ① 零 import（连类型都不引 `@/types`，避免 types → lib 的环）；
//   ② 纯函数（同样的输入恒得同样的输出，无时间/无随机/无 IO）；
//   ③ 不含任何业务内容（提示词里只有"怎么查 bug"，没有"查什么业务"）。
//
// 三件事：
//   · specFingerprint：Spec 的稳定指纹。用途是"**修过了才重跑**"——spec 被 AI 修复或手改后
//     指纹变化 ⇒ 自动重跑质检；指纹相同 ⇒ 不重跑（否则用户每次进应用页都被重复跑一轮）。
//   · shouldAutoQuality：要不要**自动**跑这一轮（并发/无 spec/已跑过同一指纹 都判否）。
//   · buildQualityPrompt：把"已给事实"注入质检提示词（模型据此定位 bug，而不是重复探测）。

/**
 * 稳定序列化 + FNV-1a 十六进制。
 *
 * 稳定性来源：对象键**排序**、数组**保序**（命令表的顺序有语义，不能当无序集合）。
 * ★ `undefined` 值的键会被 JSON.stringify 丢弃 ⇒ `{a: undefined}` 与 `{}` 指纹相同。
 *   这是刻意的：读回来的 JSON 里 `undefined` 本就不存在（写盘即丢），若把它算成"不同"
 *   就会每次读盘都判"spec 变了"→ 白跑一轮质检。
 * @param spec 任意 Spec（对象/数组/原始值/undefined 都不会抛）
 * @returns 8 位十六进制字符串（同一份逻辑内容恒得同一个值）
 */
export function specFingerprint(spec: unknown): string {
  let text = ''
  try {
    // ★ JSON.stringify(undefined) 返回的是 **undefined 而不是字符串**（`null` 才回 "null"）——
    //   直接喂给 fnv1aHex 会 TypeError。`没有 spec` 是合法输入，指纹写 'undefined' 即可。
    const s = JSON.stringify(stableValue(spec))
    text = typeof s === 'string' ? s : 'undefined'
  } catch {
    // 循环引用等极端输入：退回 String()，仍然不抛（指纹只需"同内容同值"，不要求可逆）
    text = String(spec)
  }
  return fnv1aHex(text)
}

/** 递归稳定化：对象键排序，数组保序，其余原样 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = stableValue(src[k])
    return out
  }
  return value
}

/** FNV-1a（32 位）→ 8 位十六进制。用 Math.imul 保证 32 位乘法不丢高位 */
function fnv1aHex(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 落盘在**注册表**（registry.json 的 app.quality）里的质检标记。
 * ★ 刻意不放 spec.json：writeSpec 每次写盘前都会先备份（spec.bak.<ts>.json），
 *   把"质检标记"这类高频小写入塞进去会把备份列表淹没。
 */
export interface AppQualityMark {
  /** 这一轮质检针对的 Spec 指纹（与 specFingerprint 同源）——相等即"这一版已查过" */
  fingerprint: string
  /** 这轮质检的完成时间（毫秒时间戳） */
  checkedAt: number
  /** 结论是否有问题（true = 没查出问题） */
  clean: boolean
  /** 查出的问题条数（clean=true 时为 0） */
  findings: number
}

/**
 * 要不要自动跑一轮质检。
 *
 * 四个否决分支（任一命中即不跑，理由都写在代码里）：
 *   · autoQuality 关闭 → 用户关掉了自动质检，永不自动跑；
 *   · isStreaming → **绝不并发**：会话正在流式输出时再插一轮质检，会把上下文/工具调用搅在一起；
 *   · !spec → 没有 Spec 就没有可查的对象（新建应用、spec 被删）；
 *   · quality?.fingerprint === fingerprint → 这一版已经查过（"不要每次进入都重跑"的判据）。
 * 四条都不命中才 true —— 也就是"开着自动质检 + 空闲 + 有 spec + spec 变了"。
 */
export function shouldAutoQuality({
  autoQuality,
  quality,
  fingerprint,
  spec,
  isStreaming,
}: {
  autoQuality?: boolean
  quality?: AppQualityMark | null
  fingerprint: string
  spec: unknown
  isStreaming?: boolean
}): boolean {
  if (!autoQuality) return false
  if (isStreaming) return false
  if (!spec) return false
  if (quality?.fingerprint === fingerprint) return false
  return true
}

/** 自检结论（对应 app:check 的返回；字段缺省时提示词写"（无）"，绝不抛） */
export interface QualityCheck {
  status?: string
  issues?: string[]
  /** 问题数；缺省时用 issues.length 兜底 */
  findings?: number
}

/** 确定性试跑报告（对应 app:verify 的返回；字段缺省时提示词写"（无）"，绝不抛） */
export interface QualityVerifyReport {
  tried?: string[]
  failures?: { action?: string; error?: string }[]
  notRun?: string[]
  skipped?: string[]
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const NONE = '（无）'

/**
 * 质检提示词。结构固定为四段：
 *   ① 角色与目标；② **已给事实，不要重复探测**（自检结论 / 试跑报告 / Spec 摘要）；
 *   ③ 行动规则（含硬约束：只复跑 read、write 一律不执行、不得删除命令、不得修改 expose）；
 *   ④ 修复许可 + 结构化输出契约（末尾一个 ```json 代码块）。
 *
 * 对 undefined / 空值**健壮**：任一字段缺失都写 `（无）`，不抛、不产出 `undefined` 字样。
 * 本函数不含任何业务内容——具体查什么由 Spec 摘要与试跑报告带进来。
 */
export function buildQualityPrompt(input: {
  appName?: string
  check?: QualityCheck | null
  verifyReport?: QualityVerifyReport | null
  specSummary?: string | null
} = {}): string {
  const appName = textOf(input?.appName) || '（未命名应用）'

  // ---- ②-1 自检结论 ----
  const status = textOf(input?.check?.status) || NONE
  const issues = (Array.isArray(input?.check?.issues) ? input!.check!.issues : [])
    .map((s) => textOf(s))
    .filter(Boolean)
  const findings = Number.isFinite(input?.check?.findings as number)
    ? Number(input!.check!.findings)
    : issues.length
  const issueLines = issues.length ? issues.map((s, i) => `   ${i + 1}. ${s}`).join('\n') : `   ${NONE}`

  // ---- ②-2 确定性试跑报告 ----
  const tried = (Array.isArray(input?.verifyReport?.tried) ? input!.verifyReport!.tried : []).map((s) => textOf(s)).filter(Boolean)
  const failures = (Array.isArray(input?.verifyReport?.failures) ? input!.verifyReport!.failures : [])
    .filter((f) => f && (textOf(f.action) || textOf(f.error)))
    .map((f) => ({ action: textOf(f?.action) || '（未命名命令）', error: textOf(f?.error) || '（无错误信息）' }))
  const notRun = (Array.isArray(input?.verifyReport?.notRun) ? input!.verifyReport!.notRun : []).map((s) => textOf(s)).filter(Boolean)
  const skipped = (Array.isArray(input?.verifyReport?.skipped) ? input!.verifyReport!.skipped : []).map((s) => textOf(s)).filter(Boolean)
  const passCount = Math.max(0, tried.length - failures.length)
  const failLines = failures.length
    ? failures.map((f) => `   - ${f.action}｜${f.error}`).join('\n')
    : `   ${NONE}`

  // ---- ②-3 Spec 摘要 ----
  const specSummary = textOf(input?.specSummary) || NONE

  return [
    `你是应用「${appName}」的质检员。`,
    '目标：**找出并定位**这个已生成的应用（控制工具）里的 bug，并给出**最小修复方案**（不做无关重构、不扩大改动面）。',
    '',
    '【已给事实，不要重复探测】',
    `1) 自检结论：${status}；问题 ${findings} 条：`,
    issueLines,
    `2) 确定性试跑报告（真实执行结果）：通过 ${passCount} 条，失败 ${failures.length} 条：`,
    failLines,
    `   未试跑（write 命令 / 需要必填参数）：${notRun.concat(skipped).join('、') || NONE}`,
    '3) Spec 摘要：',
    specSummary,
    '',
    '【行动规则】',
    '- **逐条真实复跑失败的 read 命令**（用你手上的 app_* 工具），不要凭报错猜——报错文本可能来自上一版 spec。',
    '- **write 命令一律不执行**：它们会在真实系统里产生真实改动。',
    '- 每条失败给出一行结论：「action｜现象｜根因（选择器失效 / 参数契约错 / 需登录 / 通道选错 / driver 错 / 素材不足）｜最小修复建议」。',
    '- 额外检查：冗余命令、params 与真实必填项是否一致、明显缺失的能力。',
    '- **不得删除命令**、**不得修改 expose**（删命令会让用户已有的调用失效；改 expose 会改变工具的可见范围）。',
    '',
    '【修复许可】',
    '- 允许用文件工具**直接修改该应用的 spec.json**（路径见上下文给出的应用目录）。',
    '- 改动前**必须先 Read**（不要在没看原文的情况下重写整个文件）；改完**必须再复跑失败命令复验**，把复验结果写进结论。',
    '- 修不了（例如需要用户登录、需要新素材）就如实说明并给出下一步，**不要编造已修复**。',
    '',
    '【输出】',
    '最后用一个 ```json 代码块输出结构化结论（除此之外不要在该代码块里放任何解释文字）：',
    '```json',
    '{"findings":[{"action":"","symptom":"","rootCause":"","fix":""}],"clean":true}',
    '```',
    'clean = findings 为空时为 true；findings 每条必须能对应到具体 action（无法定位到 action 的观察不要写进 findings）。',
  ].join('\n')
}
