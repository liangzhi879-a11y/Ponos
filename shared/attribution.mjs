// shared/attribution.mjs —— S2-D4 **归属字段（authorId / workspaceId）的唯一实现**。
//
// 依据（spec 2026-09-14-team-collaboration-design）：
//   §6.2 D4  会话 / 记忆 / 工作流三处补 `authorId` 与 `workspaceId`；**L1 阶段作者恒为本人、
//            工作区恒为 `personal` 也要写**——后补 = 全量数据迁移。
//   §5.9     会话、知识条目、经验、工作流均需带归属工作区；个人工作区用固定值 `personal`。
//            （知识条目已由既有 `spaceId` 承载归属：`docId = spaceId/relPath` + `.space.json`。）
//
// 为什么单独一个模块：三处写入点分属 `kernel/`（ESM）与 `server/`（ESM），若各写一份解析逻辑，
// 默认值/覆盖规则必然漂移，而漂移的后果是"某些数据落盘时缺归属"——**且事后无法区分**是"没写"
// 还是"写了默认值"，正是 §6.2 D4 要避免的"后补 = 全量数据迁移"。`shared/` 是既有跨层位置
// （`kernel/memory.mjs` 已 import `../shared/knowledge-core.mjs`），故放这里，一处实现、四处引用。

/** 个人工作区固定值（§5.9 字面：`会话、知识条目、经验、工作流均需带归属工作区；个人工作区用固定值 personal`）。 */
export const DEFAULT_WORKSPACE_ID = 'personal'

/**
 * L1「作者恒为本人」的取值。
 *
 * 为什么是常量而不是"每台机器生成一个 id"：spec 明说 L1 作者**恒为本人**，真实成员体系属 S3/S4；
 * 本轮若自造 per-install 身份，就凭空多出一个**无消费方**的标识体系（P7 不造平行体系），
 * 且"本人"与"本机"在多机合并时本就需要产品口径（谁认领哪些数据），不是本轮能定的。
 */
export const LOCAL_AUTHOR_ID = 'local'

/**
 * 归属解析。默认即 L1 常量，允许环境变量覆盖——这不是为了 L1 需要，而是为了让**测试能证明
 * 字段真的落进了文件**：若取值恒等于默认值，"写了默认值"与"根本没写"在断言上无法区分；
 * 用非默认值写入再读回，才真的验证了贯通。S3/S4 接线真实成员时也可直接复用同一入口。
 */
export function attributionOf({ env = (typeof process !== 'undefined' ? process.env : {}) } = {}) {
  const authorId = pickNonEmpty(env.YFW_AUTHOR_ID, LOCAL_AUTHOR_ID)
  const workspaceId = pickNonEmpty(env.YFW_WORKSPACE_ID, DEFAULT_WORKSPACE_ID)
  return { authorId, workspaceId }
}

function pickNonEmpty(raw, fallback) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v || fallback
}

/**
 * 给记录附加归属字段（浅合并）。
 *
 * **不覆盖已有的非空值**：调用点可能在多层被调用（例如工作流在"创建"与"保存"两条路径上都会写），
 * 若每次都强行改写，就存在"把调用方显式指定的归属冲掉"的风险；保持幂等也让本函数可安全重复调用。
 * `null`/`undefined`/空串视为"未设置"，会被填上默认值。
 */
export function withAttribution(record = {}, { env } = {}) {
  const { authorId, workspaceId } = attributionOf({ env })
  return {
    ...record,
    authorId: pickNonEmpty(record.authorId, authorId),
    workspaceId: pickNonEmpty(record.workspaceId, workspaceId),
  }
}

/**
 * 判断一份已落盘的数据是否带齐归属（供读取侧与排障使用）。
 * 旧数据（D4 之前写入）会返回 `false` —— 这是**预期**的（spec 未要求回填既有数据），
 * 读侧据此把缺失归属的记录归入 `unknown` 桶而不是静默丢弃。
 */
export function hasAttribution(record = {}) {
  return Boolean(pickNonEmpty(record.authorId, '') && pickNonEmpty(record.workspaceId, ''))
}
