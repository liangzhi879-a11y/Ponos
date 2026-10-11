// shared/tag-registry.mjs —— S2-D6 **标签实体化的唯一实现**（纯函数，无 IO；持久化见 kernel/tag-store.mjs）。
//
// 依据（spec 2026-09-14-team-collaboration-design）：
//   §6.2 D6 现状  「三处裸字符串：Conversation.tags、知识 collectTags、经验标签」
//   §6.2 D6 目标  「标签独立实体 + 别名合并表 + 作用域（个人/团队）。**不做强制受控词表**」
//   §6.2 批注     「5–20 人规模先自动合并 + 可撤销」+ §14-4（该题 = D6 开工前必答，用户裁定：
//                  **自动合并 + 可撤销**）⇒ 合并**无审核即生效**，且**必须可撤销**
//   §5.1         「标签」属**冷·内容 ✅ 双向**（会过团队源）⇒ 实体 id 要**跨机一致**
//   §5.9         一级形态 = 个人/团队；scope 取 `personal` / `team`，L1 恒 `personal`
//   §10 S2-5     「标签为独立实体，支持别名合并与个人/团队作用域」
//
// 【为什么必须只有一个实现】
// 归一规则原本已散在两处：渲染层 `src/lib/knowledgeTags.ts` 的 `normalizeTag`（去 #、合并 //、去首尾 /）
// 与内核 `collectTags` 出口（只去 #）——两者规则本就不同。若这里再写第三套，会出现"合并表认 A、
// 索引存 A'、界面显示 A''"的鬼现象：用户明明合并了两个标签，界面上仍是两个。
// 故本模块的 `normalizeTagName` = **渲染层规则的逐字镜像**（并由 src/lib/tagRegistryParity.test.ts
// 以 parity 测试钉住），且解析时**先归一化入参**，使历史上未归一的存量串（如 `a//b`）也能被正确解析。

import { createHash } from 'node:crypto'

/** 作用域取值（§5.9：个人 / 团队）。 */
export const TAG_SCOPES = ['personal', 'team']

/** L1 缺省作用域（§5.9：一级形态恒为个人）。 */
export const DEFAULT_TAG_SCOPE = 'personal'

/** 注册表结构版本（落盘用；将来若要迁移结构，靠它判定）。 */
export const TAG_REGISTRY_VERSION = 1

/**
 * 标签名归一 —— **与渲染层 `src/lib/knowledgeTags.ts:21` 的 `normalizeTag` 逐字同规则**：
 * `trim` → 去前导 `#` → 合并连续 `/` → 去首尾 `/` → `trim`；空 → `null`。
 *
 * 为什么"空 → null"而不是空串：调用方必须能区分"没有标签"与"标签名是空"，
 * 空串会静默进入标签集合，在界面/计数里表现为一个看不见的标签。
 */
export function normalizeTagName(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
  return s || null
}

/**
 * 实体 id —— 由 `scope + name` **确定性**派生（`tag-` + 12 位 hex）。
 *
 * 为什么不用自增序号：标签是**要双向同步**的冷内容（§5.1）。自增序号在多台机器各自注册时必然撞号
 * （都从 1 开始），届时"同名标签"在两机上是不同 id，同步会产出一堆重复实体。
 * 确定性 id 让"同一 scope 下同名 = 同一实体"**跨机天然成立**，为 S3 的去重打底。
 *
 * 为什么合并改名后 id 不变：别名合并是"同一个标签的另一种写法"，**不是换实体**
 * （否则撤销、跨机对齐都失去锚点）。
 */
export function tagId(scope, name) {
  const h = createHash('sha1').update(`${scope}\u0000${name}`, 'utf-8').digest('hex')
  return `tag-${h.slice(0, 12)}`
}

/** 空注册表。`tags` = 实体表（别名合并表即在实体的 `aliases` 上）；`merges` = 合并历史（撤销凭据）。 */
export function createTagRegistry() {
  return { version: TAG_REGISTRY_VERSION, updatedAt: null, tags: [], merges: [] }
}

function assertScope(scope) {
  if (!TAG_SCOPES.includes(scope)) {
    throw new Error(`未知标签作用域：${scope}（允许：${TAG_SCOPES.join(' / ')}）`)
  }
}

function asArray(reg) {
  if (!reg || !Array.isArray(reg.tags)) throw new Error('标签注册表结构非法：缺少 tags 数组')
  if (!Array.isArray(reg.merges)) reg.merges = []
  return reg
}

/**
 * 查找实体：**先按规范名精确匹配，再按别名匹配**，且都限定在同一 scope 内。
 * 顺序不能反：名字匹配优先可保证"实体名"永远比"别名"更具解释权。
 */
export function findTag(reg, raw, { scope = DEFAULT_TAG_SCOPE } = {}) {
  assertScope(scope)
  const name = normalizeTagName(raw)
  if (!name) return null
  const pool = asArray(reg).tags.filter((t) => t.scope === scope)
  return pool.find((t) => t.name === name) || pool.find((t) => Array.isArray(t.aliases) && t.aliases.includes(name)) || null
}

/**
 * 注册（幂等）。命中**已有实体名或其别名** ⇒ 返回该实体而非新建 ——
 * 否则"同一标签的两种写法"会各自长出实体，别名表就白建了。
 * 未注册的标签**照常注册**（§6.2 D6 明示**不做强制受控词表**：不设白名单、不拒绝）。
 * 返回 `null` 表示入参归一后为空（无效标签，调用方应跳过）。
 */
export function ensureTag(reg, raw, { scope = DEFAULT_TAG_SCOPE, now = new Date().toISOString() } = {}) {
  assertScope(scope)
  const name = normalizeTagName(raw)
  if (!name) return null
  const existing = findTag(reg, name, { scope })
  if (existing) return existing
  const entity = { id: tagId(scope, name), name, scope, aliases: [], createdAt: now, updatedAt: now }
  asArray(reg).tags.push(entity)
  reg.updatedAt = now
  return entity
}

/**
 * 批量注册（供"索引/记忆里见到的标签"一次性入册）。返回实际新建的实体名数组（便于调用方决定是否落盘）。
 */
export function ensureTags(reg, names, { scope = DEFAULT_TAG_SCOPE, now = new Date().toISOString() } = {}) {
  const created = []
  for (const raw of names || []) {
    const name = normalizeTagName(raw)
    if (!name) continue
    const before = findTag(reg, name, { scope })
    const entity = ensureTag(reg, name, { scope, now })
    if (entity && !before) created.push(entity.name)
  }
  return created
}

/**
 * 解析为**规范名**：跟随别名链（A→B→C 解析到 C）。
 *
 * - **未注册的标签原样返回归一值**，不拒绝、不丢弃 —— §6.2 D6 的不做受控词表意味着注册表是
 *   追加式的"认识表"，而不是准入闸门。
 * - **环安全**：`seen` 兜底（正常路径下 mergeTag 已挡住环，此处保证即使历史数据被外部改坏
 *   也不会死循环 —— 死循环会比"解析不准"严重得多：它会卡住整条索引/渲染链路）。
 */
export function resolveTagName(reg, raw, { scope = DEFAULT_TAG_SCOPE } = {}) {
  assertScope(scope)
  const start = normalizeTagName(raw)
  if (!start) return null
  let cur = start
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const owner = findTag(reg, cur, { scope })
    if (!owner) return cur              // 未注册：原样通过（不做受控词表）
    if (owner.name === cur) return cur  // 已是规范名
    cur = owner.name                    // 命中别名 → 跳到规范名
  }
  return cur || start
}

/** 批量解析 + 去重（保序），丢弃空值。供索引/记忆的标签枚举直接用。 */
export function resolveTagNames(reg, list, { scope = DEFAULT_TAG_SCOPE } = {}) {
  const out = []
  const seen = new Set()
  for (const raw of list || []) {
    const name = resolveTagName(reg, raw, { scope })
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * **自动合并**（无审核即生效，用户裁定 #4）：把 `from` 的标签并入 `into`。
 *
 * 实现要点（每一条都对应一个"不做就会出错"）：
 * - `into` **先解析到规范实体**：调用方可能传的是别名，合并必须落在实体上，否则别名链会断。
 * - `from` **连同它自己的 aliases 一并并入**：若 A→B 之后又有 C→A，则 C 的解析路径是
 *   `C → A → B`；只把 `A` 写进 `B.aliases` 而丢掉 `A` 的别名 `C`，`C` 就会解析失败。
 * - **不静默失败**：自身合并 / 已同实体 / 源是别处的别名 / 未注册源，都返回带 `reason` 的结果
 *   （合并是数据改写，静默 no-op 会让人以为成功了）。
 * - **保留快照**：撤销要能**逐字还原**被吸收的实体（含自身 aliases 与 createdAt）。
 *
 * 返回 `{ ok:true, mergeId, from, into }` 或 `{ ok:false, reason, message }`。
 */
export function mergeTag(reg, fromRaw, intoRaw, { scope = DEFAULT_TAG_SCOPE, now = new Date().toISOString() } = {}) {
  assertScope(scope)
  asArray(reg)
  const fromName = normalizeTagName(fromRaw)
  const intoName = normalizeTagName(intoRaw)
  if (!fromName || !intoName) return { ok: false, reason: 'empty-tag', message: '待合并的标签名为空' }
  if (fromName === intoName) return { ok: false, reason: 'same-tag', message: '不能把标签合并到自身' }

  const fromCanon = resolveTagName(reg, fromName, { scope })
  const target = ensureTag(reg, intoName, { scope, now }) // 不存在则自动注册（不做受控词表）
  if (fromCanon === target.name) {
    return { ok: false, reason: 'already-merged', message: `「${fromName}」已经就是「${target.name}」` }
  }
  if (fromCanon !== fromName) {
    // 源是"别处的别名"：真正该合并的是它的规范实体。明确报出规范名，让调用方重发指令，
    // 而不是自作主张把另一个实体整个并过来 —— 那会一次改动两个实体，超出调用方表达的范围。
    return { ok: false, reason: 'source-is-alias', message: `「${fromName}」是「${fromCanon}」的别名，请改用「${fromCanon}」` }
  }
  // 源不存在则**自动注册**再合并（与 target 对称）：注册表是追加式"认识表"，不是准入闸门
  // （§6.2 D6 明示不做强制受控词表）。若在此直接拒绝，用户想合并一个"库里有、但尚未入册"的
  // 裸字符串时会被莫名挡住 —— 而"尚未入册"恰恰是这三处裸字符串的**常态**，那会让 D6 形同虚设。
  const source = ensureTag(reg, fromName, { scope, now })
  if (!source) return { ok: false, reason: 'source-missing', message: `标签名非法：${fromName}` }

  const absorb = [source.name, ...(Array.isArray(source.aliases) ? source.aliases : [])]
  target.aliases = Array.from(new Set([...(Array.isArray(target.aliases) ? target.aliases : []), ...absorb]))
  target.updatedAt = now
  reg.tags = reg.tags.filter((t) => t !== source)

  const mergeId = `mrg-${String(reg.merges.length + 1).padStart(4, '0')}`
  reg.merges.push({
    id: mergeId,
    scope,
    from: source.name,
    fromRequested: fromName,
    into: target.name,
    intoRequested: intoName,
    at: now,
    undoneAt: null,
    // 快照 = 被吸收实体的完整副本 ⇒ 撤销可逐字还原（含其自身 aliases 与 createdAt）
    snapshot: JSON.parse(JSON.stringify(source)),
  })
  reg.updatedAt = now
  return { ok: true, mergeId, from: source.name, into: target.name }
}

/**
 * **撤销合并**（用户裁定 #4 的"可撤销"）：用快照逐字还原，并把相应别名从目标实体剥回。
 *
 * - 重复撤销 / 未知 id 明确报错（不是静默成功）。
 * - 目标实体若已消失（外部改动），**宁可不撤销也不写坏数据** ⇒ `target-missing`。
 * - id 冲突（同 id 实体已存在）⇒ `conflict`，同样不写。
 * - 合并记录**保留**并记 `undoneAt`：撤销是"可追溯的反向操作"，不是"抹掉历史"
 *   （抹掉会让审计无法解释"这个标签为什么曾经消失过"）。
 */
export function undoMerge(reg, mergeId, { now = new Date().toISOString() } = {}) {
  asArray(reg)
  const rec = reg.merges.find((m) => m.id === mergeId)
  if (!rec) return { ok: false, reason: 'not-found', message: `未找到合并记录 ${mergeId}` }
  if (rec.undoneAt) return { ok: false, reason: 'already-undone', message: `合并 ${mergeId} 已于 ${rec.undoneAt} 撤销过` }
  const target = findTag(reg, rec.into, { scope: rec.scope })
  if (!target) return { ok: false, reason: 'target-missing', message: `目标实体「${rec.into}」已不存在，拒绝撤销以免写坏数据` }
  const snap = rec.snapshot || {}
  if (reg.tags.some((t) => t.id === snap.id)) {
    return { ok: false, reason: 'conflict', message: `实体 ${snap.id} 已存在，拒绝覆盖` }
  }

  const strip = new Set([snap.name, ...(Array.isArray(snap.aliases) ? snap.aliases : [])])
  target.aliases = (Array.isArray(target.aliases) ? target.aliases : []).filter((a) => !strip.has(a))
  target.updatedAt = now
  reg.tags.push(JSON.parse(JSON.stringify(snap)))
  rec.undoneAt = now
  reg.updatedAt = now
  return { ok: true, restored: snap.name, into: target.name }
}

/** 某作用域下的实体清单（别名一并给出）。 */
export function listTags(reg, { scope = DEFAULT_TAG_SCOPE } = {}) {
  assertScope(scope)
  return asArray(reg).tags.filter((t) => t.scope === scope)
}

/**
 * 可观测视图（供 `GET /tags` 与排障）：注册表当前"长什么样"。
 * 给别名计数而非直接给别名数组，是为了让"某标签被合并了多少种写法"一眼可读。
 */
export function tagRegistryView(reg, { scope = DEFAULT_TAG_SCOPE } = {}) {
  assertScope(scope)
  asArray(reg)
  const tags = reg.tags
    .filter((t) => t.scope === scope)
    .map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope,
      aliasCount: Array.isArray(t.aliases) ? t.aliases.length : 0,
      aliases: Array.isArray(t.aliases) ? [...t.aliases] : [],
      createdAt: t.createdAt || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const merges = reg.merges
    .filter((m) => m.scope === scope)
    .map((m) => ({ id: m.id, from: m.from, into: m.into, at: m.at, undoneAt: m.undoneAt || null }))
  return { version: reg.version || TAG_REGISTRY_VERSION, scope, total: tags.length, tags, merges }
}
