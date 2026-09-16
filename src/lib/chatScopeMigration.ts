// src/lib/chatScopeMigration.ts —— 会话持久化的消毒与迁移（纯函数，2026-09-15）
//
// 为什么从 chatStore.ts 抽出来：`chatStore.ts` 有 12 处**运行期** `@/` 别名导入
// （utils/chatParts/config/其它 store），Node 原生 `node --test` 解析不了别名，
// 于是 store 内部的迁移逻辑**永远进不了单测**。而 v3 → v4（新增会话知识范围）恰恰是
// "写错了会静默损坏数据"的一类改动：迁移分支若顺手重建行，会把 v3 行里已算好的
// messageCount/tokensTotal 按"已剥离的 messages"重算成 0，界面上表现为会话列表统计全部归零。
//
// 抽出后本模块只依赖**类型**（`@/types` 的 import type 在 Node 类型剥离后不产生运行期导入），
// 因此可被 `node --test` 直接加载（见 chatScopeMigration.test.ts）；chatStore 侧只剩一行调用，
// 由 kernel-tests/knowledge-scope-plumbing.test.mjs 的静态守卫钉住"确实调的是这一份"。
import type { Conversation } from '@/types'

/**
 * 会话知识范围归一（2026-09-15，P1「会话模式关联经验库之外的知识库」）。
 *
 * 归一到"数组 或 undefined"两种形态，理由是**桥侧按值算签名**（`knowledgeSpacesSig`）：
 * `[]`、`['','']`、`[null]` 若各自保留，会得到互不相同的签名 → 每次发消息都判定"范围变了"
 * → 白重启一次内核（用户看到首字节变慢）。故脏值一律塌缩成 undefined = 未关联。
 * 保序（不去重排序）：顺序在提示词里表达优先级，排序会静默改变模型的注意力分配。
 */
export function sanitizeKnowledgeSpaces(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const list = [...new Set(v.map((s) => String(s ?? '').trim()).filter(Boolean))]
  return list.length ? list : undefined
}

/**
 * 应用页作用域归一（2026-09-16，P2「应用页会话」）。
 *
 * 与 sanitizeKnowledgeSpaces 同一条纪律、但形态是单值：`''` / `null` / 非字符串 / 纯空白
 * 一律塌缩成 undefined = 无作用域。理由是桥侧按值算 spawn 冻结签名（`appPageSig`）：
 * 若把 `''` 和 `undefined` 各自留下，一次"清空作用域"就会被判成"作用域变了" → 白重启一次
 * 内核（用户看到首字节变慢）。两端（渲染层持久化、桥侧）必须是同一套归一，否则
 * 界面上"同一个状态"在签名上仍是两个。
 *
 * 归一到 undefined 后，sanitizeConversations 里展开 `{ appPageId: undefined }` 恰好把该键
 * 抹掉（JSON.stringify 丢弃 undefined 值），不留一个 null 在持久化里。
 */
/** 单值 id 归一的共用实现（appPageId / appId 同一条纪律，避免两处各写一份必然漂移） */
function sanitizeIdValue(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s : undefined
}

export function sanitizeAppPageId(v: unknown): string | undefined {
  return sanitizeIdValue(v)
}

/**
 * 应用会话归属归一（2026-09-16，Task 4「应用生成后自动质检」）。
 *
 * 与 sanitizeAppPageId **同一套语义**（非字符串 / 空串 / 纯空白 → undefined）：
 * 它是"一个应用一个常驻会话"的幂等键，脏值若留下来（`''` / `null` / 数字），
 * getOrCreateAppConversation 的 `c.appId === appId` 就永远匹配不上 → 每进一次应用页
 * 就多出一个"应用·xxx"会话（用户视角是"会话列表越用越乱"）。
 */
export function sanitizeAppId(v: unknown): string | undefined {
  return sanitizeIdValue(v)
}

/**
 * 会话消毒：保证每个 conversation.messages 是数组（undefined/null/非数组 → []），
 * 同时保证 conv 是非 null 对象。rehydrate/migrate 后统一调用，避免持久化数据
 * 缺字段（partialize 不存 messages）或损坏时下游 `c.messages.length`/`[...c.messages]` 崩。
 * 2026-08-18 修复：启动报 `Cannot read properties of undefined (reading 'length')`
 * 与 `r.messages is not iterable` 根因 = rehydrate 后 messages 字段缺失。
 * 2026-09-09（mode v3）：会话模式缺省归一——persist 版本 2→3 后旧行 mode 未定义，
 * 统一补 'task'，保证任何经过本消毒的会话（migrate v2 分支 / rehydrate / getItem 兜底）
 * 都不会复活 undefined-mode 会话；新建会话恒由 createConversation 显式落 mode。
 * 2026-09-15（v4）：会话知识范围归一（脏值 → undefined，见 sanitizeKnowledgeSpaces）。
 * 2026-09-16：应用页作用域归一（脏值 → undefined，见 sanitizeAppPageId）——**不 bump persist
 * version**：该字段是纯新增的可选字段，缺字段与脏值在本函数里都已归一，旧行无需迁移。
 * 2026-09-16（Task 4）：应用会话归属归一（脏值 → undefined，见 sanitizeAppId）——同样**不 bump
 * version**（纯新增可选字段；它是"一个应用一个常驻会话"的幂等键，脏值会让幂等失效）。
 */
export function sanitizeConversations(convs: unknown): Conversation[] {
  if (!Array.isArray(convs)) return []
  const out: Conversation[] = []
  let changed = false
  for (const c of convs) {
    if (!c || typeof c !== 'object') { changed = true; continue }
    const obj = c as Record<string, unknown>
    const needMessages = !Array.isArray(obj.messages)
    const needMode = obj.mode === undefined
    const raw = obj.knowledgeSpaces
    const ks = sanitizeKnowledgeSpaces(raw)
    // `needKs` 的判据要分两支写，不能只用 `JSON.stringify(ks) !== JSON.stringify(raw ?? undefined)`：
    // 那个写法把 `null` 与"缺字段"当同一状态（都 stringify 成 undefined），于是 `null` **永远判为干净**
    // 而被原样留下——持久化里长期存着一个 `knowledgeSpaces: null`，与"未关联"在桥侧虽等价，
    // 但会污染"同一状态只有一个签名"这条不变量，也让"归一"名不副实（实测由单测抓出）。
    // 归一到 undefined 时，下面展开 `{ knowledgeSpaces: undefined }` 恰好把该键抹掉
    // （JSON.stringify 丢弃 undefined 值），不是留一个 null 在那里。
    const needKs = ks === undefined ? raw !== undefined : JSON.stringify(ks) !== JSON.stringify(raw)
    // 应用页作用域（2026-09-16）：与 knowledgeSpaces 同款两支判据（`''`/null 必须被判为脏值
    // 并归一，而不是"与缺字段等价所以永远干净"——那会让持久化里长期留着一个 `''`）。
    const rawAppPage = obj.appPageId
    const appPage = sanitizeAppPageId(rawAppPage)
    const needAppPage = appPage === undefined ? rawAppPage !== undefined : appPage !== rawAppPage
    // 应用会话归属（2026-09-16，Task 4）：与 appPageId 同款两支判据（脏 `''`/null 必须被
    // 判为脏并归一，而不是"与缺字段等价所以永远干净"）。
    const rawAppId = obj.appId
    const appId = sanitizeAppId(rawAppId)
    const needAppId = appId === undefined ? rawAppId !== undefined : appId !== rawAppId
    if (needMessages || needMode || needKs || needAppPage || needAppId) {
      changed = true
      out.push({
        ...obj,
        messages: needMessages ? [] : obj.messages,
        mode: needMode ? 'task' : obj.mode,
        ...(needKs ? { knowledgeSpaces: ks } : {}),
        ...(needAppPage ? { appPageId: appPage } : {}),
        ...(needAppId ? { appId } : {}),
      } as unknown as Conversation)
    } else {
      out.push(c as Conversation)
    }
  }
  // 全部干净时返回原引用：调用方据此跳过无谓的 setState/写回
  return changed ? out : convs as Conversation[]
}

/**
 * v3 → v4 迁移（2026-09-15）：只做消毒（补/归一 `knowledgeSpaces`），**其它字段一律原样保留**。
 *
 * **为什么不能复用下面的 "<2 重建分支"**：那个分支按"已剥离的 messages"重算
 * `messageCount`/`tokensTotal`，而 v3 行里这两个值恰恰是当初算好存下来的（partialize 只存
 * 计数、不存消息体）——重建一遍就把会话列表的统计全部清零。迁移只该补新字段，不该顺手重建。
 */
export function migrateChatV3(persisted: unknown): Record<string, unknown> {
  const st = (persisted as Record<string, unknown>) || {}
  return { ...st, conversations: sanitizeConversations(st.conversations) }
}
