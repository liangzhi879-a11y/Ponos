// src/lib/knowledgeDeleteUi.ts —— 知识库删除管理的**纯逻辑**（2026-09-14）
//
// 为什么单独成模块（与 visionUi.ts 同一套理由）：这些函数要能被 `node --test` 直接跑到。
// 放进 .tsx 组件里就等于放弃单测 —— 而这里恰恰全是"判错了会出丑/出事"的分支：
// 权限镜像判错会出现"按钮画出来了、点了报 403"；错误码映射漏一项会让用户只看到
// `protected-space` 这种没法照做的提示；确认名比对判错会让"删库"变成一次手滑即可完成。
//
// ⚠️ 权限判定的**权威在内核**（kernel/knowledge.mjs 的 deleteGate）。本模块只是"要不要把
// 按钮画出来"的乐观预判，**不能**当作安全边界 —— 内核那条会再拒一次，两处判据必须同源
// 于 `source` 字段。刻意不看 `writable`：内置经验空间的 writable 是 true（记忆需要能写），
// 照它放行会让界面直接给出"删除个人经验库"的入口。

/** 空间来源 → 可删能力。判据只有 `source` 一个维度（与内核 deleteGate 逐条对齐）。 */
export interface DeletableSpaceLike {
  source?: string | null
}

/**
 * 能否删除**整个库**。
 *
 * 规则（与内核一致，且是用户明确要求的）：
 *   - `user`（用户自建）→ 可删整库
 *   - `experience` / `memory` / `skill_exp`（内置经验库、会话记忆等）→ **不可删整库**，
 *     但可删其中条目（见 canDeleteDoc）
 *   - `pack`（知识包，只读来源）→ 连条目都不可删
 *
 * 为什么用**白名单**（只认 `source === 'user'`）而不是黑名单（排除内置那几种）：
 * 将来新增一种来源（比如同步来的空间）时，白名单默认"删不了"（安全的那一侧），
 * 黑名单则默认"能删"——删库是不可逆量级最大的操作，默认值必须落在保守侧。
 * 用户自建空间的目录就是 `knowledge/spaces/<id>`，这也是内核唯一敢真删的形态。
 */
export function canDeleteSpace(space: DeletableSpaceLike | null | undefined): boolean {
  return String(space?.source ?? '') === 'user'
}

/**
 * 能否删除**单个条目**：除只读知识包外包都行。
 *
 * 注意与 canDeleteSpace 的**不对称是有意的**：内置经验库/会话记忆不允许删整库
 * （那是用户明确要求），但它们里面的条目必须能删 —— 记错的一条经验需要能清掉，
 * 否则用户只能去文件系统里删，风险更大。
 */
export function canDeleteDoc(space: DeletableSpaceLike | null | undefined): boolean {
  return String(space?.source ?? '') !== 'pack'
}

/**
 * 内核错误码 → 提示文案键（i18n 的 `knowledge.deleteErr.*`）。
 *
 * 为什么要有这张表而不是直接把 `error` 码显示给用户：码是给程序判的
 * （`confirm-mismatch` / `protected-space`），直接显示等于让用户读英文标识符。
 * 反过来，把码丢掉只显示后端的 message 也不行 —— message 是中文长句、不能随语言切换。
 *
 * 未登记的码走 `unknown`（并把码本体拼进提示里）：新码出现时界面仍能说清"哪里不对"，
 * 而不是给一片空白 —— 空白会被当成"这个按钮坏了"。
 */
export const DELETE_ERROR_KEY: Record<string, string> = {
  // 权限类（用户改「选择」即可解决）
  'readonly-space': 'readonlySpace',
  'protected-space': 'protectedSpace',
  // 参数类
  'bad-path': 'badPath',
  'bad-space': 'badSpace',
  'missing-space': 'missingSpace',
  'bad-trash-id': 'badTrashId',
  'bad-record': 'badRecord',
  'confirm-mismatch': 'confirmMismatch',
  // 目标不存在 / 内容已不在
  'unknown-space': 'unknownSpace',
  'not-found': 'notFound',
  'unknown-trash-id': 'unknownTrashId',
  'payload-missing': 'payloadMissing',
  // 冲突
  'space-exists': 'spaceExists',
  'name-exhausted': 'nameExhausted',
  // 服务端环境
  'bad-root': 'badRoot',
  // 传输层（前端 call() 造出来的码，不是内核给的）
  HTTP_ERROR: 'network',
}

/** 取错误码对应的 i18n 键；未登记 → `unknown` */
export function deleteErrorKey(code: string | null | undefined): string {
  return DELETE_ERROR_KEY[String(code ?? '')] ?? 'unknown'
}

/**
 * 删库的"输入库名确认"是否成立。
 *
 * 两条都与内核 `deleteSpace` **逐字同口径**（内核也是 `String(confirm).trim()` 后精确比对），
 * 因为这里判错的后果是"前端允许提交、内核拒绝"——用户看到的是点了没反应：
 *   ① trim 掉首尾空白：用户从侧栏复制库名极易带上空格，为此报错只会制造
 *      "我明明输对了"的困惑（**内部**空格不 trim，那是另一个名字）；
 *   ② 与空间 id 精确相等、大小写敏感：空间 id 就是目录名，Windows 上大小写不敏感，
 *      但 macOS/Linux 敏感 —— 统一按敏感处理，宁可多要求用户准确输入，也不要在
 *      某个平台上放行一个在另一个平台上删不掉的输入。
 */
export function isSpaceConfirmOk(input: string | null | undefined, spaceId: string | null | undefined): boolean {
  const want = String(spaceId ?? '')
  const got = String(input ?? '').trim()
  if (!want || !got) return false
  return got === want
}

/** 回收站条目的一句话摘要：`文档 · 研发资料 · 3 文件 · 1.2 MB`（空间项不显示路径） */
export function trashItemSummary(item: {
  kind?: string
  spaceName?: string | null
  fileCount?: number
  bytes?: number
}, formatBytes: (n: unknown) => string): string {
  const parts: string[] = []
  parts.push(item.kind === 'space' ? 'space' : 'doc')
  if (item.spaceName) parts.push(String(item.spaceName))
  const files = Number(item.fileCount)
  if (Number.isFinite(files) && files > 1) parts.push(`${files}`)
  parts.push(formatBytes(item.bytes))
  return parts.join(' · ')
}
