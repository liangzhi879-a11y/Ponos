// kernel/knowledge-cli.mjs —— `--knowledge <op>` 的聚合实现
// ---------------------------------------------------------------------------
// 为什么聚合：10 个 op 的差别只是"调哪个方法、传什么参"，聚合后 cli.mjs 只需一个
// 短路分支 + 10 个 parseArgs case；分散成 10 个 flag 会让 parseArgs 膨胀三倍。
// 与 kernel/readonly.mjs 同款范式：stdout 一个 JSON，code 0/1，不进 loop。
//
// 失败策略（本模块的硬契约）：**永不把异常抛给调用方**——未知 op 与内部异常一律
// 折成 `{ output: { error }, code: 1 }`。CLI 子命令是旁路能力，它的故障不得打断
// 调用方（server/bridge 后续经 kernel-readonly 薄转发，见 Task 11）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKnowledgeStore, knowledgeRoot } from './knowledge.mjs'
// S6：`append` op 复用记忆层的**同一套校验闸门与落盘函数**（不另造一份）——
// 引的是 `validateAppendEntry` + `appendMemoryEntry`，后者已内含幂等去重（hashLine）
// 与增量索引同步（syncKnowledgeIndex），故写完立刻可被检索、关联也随之更新。
import { appendMemoryEntry, listMemoryTags, validateAppendEntry, memoryRoot } from './memory.mjs'
// 文件知识库导入（2026-09-14）：实现全在 knowledge-import.mjs，本文件只做 op 分发。
import { importDocuments } from './knowledge-import.mjs'
// MAX_RELATED 从 shared 中性层取（不另写一个字面量 8）：CLI 的缺省必须与内核缺省同源，
// 抄一份数字的话，将来调阈值时 CLI 会静默停在旧值（`--limit` 缺失路径）——那是查不出来的漂移。
// `isBlockId` 同理由 shared 提供：路由侧（server）也要判同一件事，各写一份必然漂移。
import { MAX_RELATED, isBlockId } from '../shared/knowledge-core.mjs'

/**
 * 读取注入指标 sidecar（S3 §6）：由 kernel/knowledge-inject.mjs 在会话启动注入时写一次。
 * 为什么必须读盘而不是进程内取数：`--knowledge stats` 每次都是新进程，进程内累加器
 * 永远是初值 —— 不读 sidecar 的话 CLI/HTTP 通道上这些指标"恒为 0"，等于没做。
 * 文件缺失/损坏一律返回 null（指标是观测旁路，不能让它把 stats 弄成错误）。
 */
function readMetrics(configDir) {
  if (!configDir) return null
  try {
    return JSON.parse(readFileSync(join(knowledgeRoot(configDir), '.index', 'metrics.json'), 'utf-8'))
  } catch { return null }
}

const OPS = new Set([
  'spaces', 'tree', 'doc', 'entries', 'search', 'links', 'related', 'graph', 'stats', 'reindex', 'update-doc',
  // S6：写入通道与标签枚举。
  // `append` 是**唯一写 op**（append-only：结构上没有覆盖路径，故比放开 Write 白名单更安全）；
  // `tags` 供写前"优先复用已有标签"（否则单例标签越积越多 → 孤立条目，S5.1 实测主源）。
  'append', 'tags',
  // 索引标签枚举（2026-09-14 对标 Obsidian 批次 1）：**全库文档标签**（含用户空间与只读
  // packs），与上面 `tags`（S6，只认经验库、条目级）不是一回事 —— 故新开一个读 op 而不改
  // 旧 op 的输出形状（旧 op 的消费方是"写前查已有标签"，改它会静默破坏 S6）。
  // 读 op，不进 WRITE_OPS：根不存在时返回空标签集是合理语义。
  'index-tags',
  // 文件知识库（2026-09-14）：把一批文件转成 Markdown 落进一个空间。
  // 它是第二个写 op，但写入面比 append 更窄：只能写 `knowledge/spaces/<id>/`，
  // 目标空间 id 必须过 validateSpaceId（拒内置空间/pack- 前缀/非法字符），
  // 且扩展名走白名单（脚本类一律拒）—— 见 kernel/knowledge-import.mjs 的分层说明。
  'import',
  // 知识库删除管理（2026-09-14）：软删除 + 回收站。见 .yfw-spec/knowledge-trash/spec.md。
  // 为什么条目与整库**分成两个 op**：`delete-space` 是不可逆量级更大的操作，
  // 不该能因"漏给 --path"而落到删库分支（`delete-doc` 缺 --path 直接报 bad-path，
  // 两条路径各自的失败模式都是明确的）。
  // 引用体系补全（2026-09-14 批次 2）：未链接提及 与 断链清单。
  // 两个都是**读** op（不改盘），也都不进 WRITE_OPS —— 根不存在时返回空集是合理语义。
  // 为什么分开成两个 op 而不是塞进 links/stats：消费场景与护栏完全不同 ——
  // `mentions` 是"发现本该有的连接"（全库扫描、必须限流），`broken-links` 是"修坏掉的连接"
  // （只扫 links 表、需按目标聚合）。合成一条会让 limit 语义含糊。
  'mentions', 'broken-links',
  // 回收站管理 + 覆盖前备份（2026-09-14 批次 4 加 `stash-doc`）。
  // ⚠️ 这五个删除/还原 op 在批次 2 那次编辑里被误删过（新增 op 时把带 `])` 的整行替换掉了）——
  // 症状是 `trash-list`/`delete-doc` 等全部变成 "unknown knowledge op"，而 WRITE_OPS 里还留着它们。
  // 教训：往 Set 的字面量里加东西时，**不要拿结尾行当锚点**。
  'trash-list', 'delete-doc', 'delete-space', 'restore', 'purge',
  // `stash-doc`（批次 4）：**复制**当前内容进回收站、原文件保留（覆盖前备份）。
  // 与 delete-doc 是两件不同的事：那个是"删除"（文件消失），这个是"留档"（文件还在），
  // 且**不重载索引**（内容与路径都没变）。合进 delete-doc 就得给它加个 mode 开关，
  // 而"删除"是最不能出歧义的操作 —— 宁可多一个 op。
  'stash-doc',
])

/**
 * **写** op 白名单（2026-09-14 抽出常量，原先写死成 `name === 'append' || name === 'import'`）。
 *
 * 抽出来的理由：加入删除管理后，"哪些 op 是写"从 2 个变成 6 个，继续写成并列的 `||`
 * 表达式迟早会漏 —— 而漏掉一个写 op 的代价是**配置根短路失效**（见下方 rootExistedBefore
 * 处的长注释）：拼错的 `PONOS_HOME` 会让写操作静默长出一棵没人找得到的树。
 * `trash-list` 是**读**（列回收站），不在本表 —— 根不存在时返回空清单是合理语义。
 */
const WRITE_OPS = new Set(['append', 'import', 'delete-doc', 'delete-space', 'restore', 'purge', 'stash-doc'])

/**
 * `--limit` 解析（S5 §7.3）：非负整数照收（0 合法——只想要 duplicate 标记时用得上）；
 * 空/缺失 → 内核缺省 `MAX_RELATED`；其余（负数/小数/非数字）→ 明确报错。
 * 为什么**报错而不静默取缺省**：`--limit 20` 被静默当 8 时，调用方会以为"这个块只有 8 条锚点"
 * ——把参数错误读成数据事实，正是本项目反复踩的"静默空集/静默截断"病灶。
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: MAX_RELATED }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `related: --limit 必须是非负整数（收到 ${JSON.stringify(raw)}）` }
  }
  return { ok: true, value: n }
}

/**
 * `related` 的参数校验：**空 id / 形状错 / 坏 limit 一律明确报错**，不通融成空数组。
 * 形状判定用 shared 的 `isBlockId`（路由侧同用，避免两套口径漂移）。
 * 只判形状、不判存在性："库里没这条"与"没有锚点"在内核视图里本就是一回事（空数组），
 * 拿形状错当空数组返回，会让调用方把"参数写错"读成"这个块没有关联"——最贵的那种假阴性。
 * @returns {{ ok: true, id: string, limit: number } | { ok: false, error: string }}
 */
function relatedParams(args) {
  const id = String(args.id ?? '').trim()
  if (!id) return { ok: false, error: 'related: missing --id (blockId 形如 <docId>#<n>)' }
  if (!isBlockId(id)) return { ok: false, error: `related: invalid blockId: ${id}（须为 <docId>#<n>）` }
  const lim = parseLimit(args.limit)
  if (!lim.ok) return lim
  return { ok: true, id, limit: lim.value }
}

/**
 * `--space` / `--spaces` 参数归一（原先是 search 分支里的内联 IIFE，2026-09-14 批次 1 抽出）。
 *
 * 三种入参都必须支持，缺一即**静默失效**（返回未过滤或全空）：
 *   · `args.spaces` 数组（`--spaces a,b` 经 parseArgs / 本模块直接调用）
 *   · `args.space` 单值（parseArgs 收的单数形式）
 *   · `args.space` 逗号串（HTTP `?spaces=a,b` 经路由转发的形式）
 * 抽出来的理由：`search` 与 `index-tags` 两处都必须遵守**逐字同一口径**，各写一遍必然漂移
 * ——"标签过滤生效、检索过滤不生效"这类假阴性最难排查（看代码两处都"有"过滤）。
 * @returns {string[] | null} null = 不过滤（全部空间）
 */
function parseSpacesArg(args = {}) {
  const list = args.spaces
  if (Array.isArray(list) && list.length) {
    const arr = list.map((s) => String(s).trim()).filter(Boolean)
    return arr.length ? arr : null
  }
  const raw = String(list || args.space || '').trim()
  if (!raw) return null
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts : null
}

export async function runKnowledgeCommand({ op, args = {}, configDir = '', onEvent = null } = {}) {
  const name = String(op || '').trim()
  if (!OPS.has(name)) {
    return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
  }
  // S6：**在 load 之前**采样并短路"配置根是否已存在"。
  // 为什么必须抢在 load 前：`store.load()` 会按需重建索引目录（mkdir -p），
  // 于是 load 之后任何"根是否存在"的检查都会恒为真 —— 拼错的 `PONOS_HOME` 照样通过，
  // 写操作会静默长出一棵没人找得到的树（实测踩过：条目落到 `~/.ponos/workflow.md`，
  // 真正的 memory 目录一个字节没变，返回还是 `ok:true`）。
  // 且必须**在 createKnowledgeStore/load 之前**返回：否则即便拒了写入，索引目录仍被建出来
  // ——"拒绝"就带了副作用（且在硬盘上留下一个半成品的根，更让人困惑）。
  const rootExistedBefore = !!configDir && existsSync(configDir)
  // 为什么只对 append 生效：读类 op 在根不存在时返回空集是合理语义（首次安装、空库），
  // 唯一危险的是**写** —— `appendMemoryEntry` 内部会 `mkdirSync(recursive)`，
  // 拼错一个字符就能种出一棵新树。真实的 configDir 一定存在（内含 config.json/auth.json），
  // 故这条不会误伤正常安装。
  // 文件导入（import）同属**写** op 且更危险：它连 `knowledge/spaces/<id>/` 一起建，
  // 拼错的 `PONOS_HOME` 会长出一整棵没人找得到的资料树，故共用同一道短路。
  if (WRITE_OPS.has(name) && !rootExistedBefore) {
    return {
      output: { error: 'bad-root', message: `配置根不存在: ${configDir}（PONOS_HOME/CLAUDE_CONFIG_DIR 指向了错误的路径？）` },
      code: 1,
    }
  }
  const store = createKnowledgeStore({ configDir })
  try {
    // reindex 必须 force（用户显式要求重建）；其余 op 走"按需加载"（索引缺失/过期时
    // 内部自动全量重建），但 `--force` 可把任一 op 提到强制重建。load 是同步函数
    // （Task 6 的契约）——此处不写 await。
    //
    // ⚠️ `import --dry-run` **必须跳过**这次 load：`load()` 会按需建
    // `<configDir>/knowledge/.index/` 并把索引写盘，于是"预览"也在硬盘上留下痕迹
    // （实测：dry-run 后出现 `.index/{manifest,docs,inverted,links,related}` 与空 jsonl）。
    // spec P2-2 的措辞是"不写任何文件"，预览就该**零落盘副作用**（连索引脚手架都不该有）。
    // 该分支另有 guard：dry-run 下传 `knowledgeIndex: null`（模块内部也提前 return，从不读它），
    // 故不 load 不会让任何消费方拿到"半初始化的 store"。
    const skipLoad = name === 'import' && args.dryRun === true
    if (!skipLoad) store.load({ force: name === 'reindex' || args.force === true })

    switch (name) {
      case 'spaces':
        return { output: { spaces: store.getSpaces() }, code: 0 }
      case 'tree':
        return {
          output: { entries: store.listTree({ space: String(args.space || ''), path: String(args.path || '') }) },
          code: 0,
        }
      case 'doc':
        return { output: { doc: store.getDoc(String(args.id || '')) }, code: 0 }
      case 'entries':
        return { output: { entries: store.listEntries(String(args.id || '')) }, code: 0 }
      case 'search':
        return {
          output: store.search({
            query: String(args.query || ''),
            keywords: Array.isArray(args.keywords) ? args.keywords : [],
            // 空间过滤：口径见 parseSpacesArg（数组 / 单值 / 逗号串三态，缺一即静默失效）。
            spaces: parseSpacesArg(args),
            topK: Number(args.topK) || 5,
            maxBytes: Number(args.maxBytes) || 2048,
            mode: args.mode === 'full' ? 'full' : 'snippet',
          }),
          code: 0,
        }
      case 'links':
        return { output: store.getLinks(String(args.id || '')), code: 0 }
      case 'mentions':
        // 未链接提及（2026-09-14 批次 2）：全库里"提到这篇文档但没打链接"的位置。
        // `--id` 必填（没有目标就无所谓"提及"）；`--limit` 是**硬护栏**——这条路径全库扫描，
        // 缺省 30 条即停（见内核 listMentions 的成本说明），非法值回落缺省而非 0/NaN。
        return {
          output: store.listMentions(String(args.id || ''), {
            limit: (() => { const n = Number(args.limit); return Number.isFinite(n) && n > 0 ? n : 30 })(),
          }),
          code: 0,
        }
      case 'broken-links':
        // 断链清单（2026-09-14 批次 2）：`target` 为 null 的引用，按目标名聚合。
        return {
          output: store.listBrokenLinks({
            space: args.space ? String(args.space) : null,
            limit: (() => { const n = Number(args.limit); return Number.isFinite(n) && n > 0 ? n : 200 })(),
          }),
          code: 0,
        }
      case 'related': {
        // S5 Task 9：`related --doc <docId> [--limit N]` —— 一篇文档内**所有条目块**的锚点。
        // 为什么另开一支而不是让 GUI 逐块问：HTTP 路径每次调用都是一次新内核进程
        // （约 50–70MB RSS），一篇文档几十条条目 = 几十次 spawn（详见内核 getRelatedForDoc）。
        // 与 `--id` 互斥：两个都给了按 `--id`（既有语义优先，不静默改道）。
        const docArg = String(args.doc ?? '').trim()
        if (docArg && !String(args.id ?? '').trim()) {
          const lim = parseLimit(args.limit)
          if (!lim.ok) return { output: { error: lim.error }, code: 1 }
          const validate = args.noValidate !== true
          const blocks = store.getRelatedForDoc(docArg, { validate, limit: lim.value })
          // 只给锚点摘要（同 --id 支）：卡片所需的一切都在 why 里，正文由 /knowledge/doc 给
          return {
            output: { docId: docArg, validate, limit: lim.value, count: blocks.length, blocks },
            code: 0,
          }
        }
        // S5 §7.3：`related --id <blockId> [--no-validate] [--limit N]`。
        // 与 `links` 的差别：links 的 id 是 docId（不存在 ⇒ 空出/入边，本身自洽）；
        // 这里的 id 是 **blockId**，形状错了（含缺省空串）必须报错——否则 `--id` 写漏
        // 会返回空数组，看起来像"这个块没有关联"，把参数错误伪装成数据事实。
        const p = relatedParams(args)
        if (!p.ok) return { output: { error: p.error }, code: 1 }
        // `--no-validate`：关掉读时校验，返回物化里**原样存着**的边（调试用：看存量边
        // 为何在正常视图里消失）。缺省 true 是正常路径（陈旧边必须剔除，spec §6.2）。
        // 显式 `!== true`：只有解析到 true 才关校验，undefined/'false' 都按"开着"处理
        // （宁可多校验，不可因参数解析意外而静默放宽）。
        const validate = args.noValidate !== true
        const related = store.getRelated(p.id, { validate, limit: p.limit })
        // 回显 validate/limit：CLI 是新进程调试口，不回显就没法确认"关校验有没有真的生效"。
        // 只给锚点摘要（blockId/title/why/score/shared），**不含正文**（spec §7.2 防上下文膨胀）。
        return {
          output: { blockId: p.id, validate, limit: p.limit, count: related.length, related },
          code: 0,
        }
      }
      case 'graph':
        return {
          output: store.getGraph({
            space: args.space ? String(args.space) : null,
            // ⚠️ 这里**不设数字缺省**：缺省交由 store 按**层级**决定
            //（条目级 1000 / 文档级 200）。原先写 `Number(args.limit) || 200`，
            // 等于把 200 当成"显式值"传给条目级图 ⇒ 层级缺省永远被覆盖、条目图恒截到 200 节点，
            // 且 `slice(0, 200)` 是从头截 —— 恰好砍掉排在文档尾部的段（S6 实测：合并进来的
            // 那批经验压根不在图里）。非法/非正数一律归为 null（交由层级缺省），
            // 避免 `Number('abc')=NaN` 让 slice(0, NaN) 变成空图。
            limit: (() => { const n = Number(args.limit); return Number.isFinite(n) && n > 0 ? n : null })(),
            // S5 Task 9：`--related` 才附隐式关联层（显式 `=== true`；缺省/字符串一律不带，
            // 宁可少带也不因参数解析意外把 258 条隐式边灌进图谱）
            related: args.related === true,
            // S5.1：`--level entry` 切到条目级图。白名单式解析（只认 'entry'，其余落回 'doc'）：
            // 层级是枚举而不是自由值，非法值静默落回缺省比报错更合用（GUI 传参不该打断浏览）。
            level: args.level === 'entry' ? 'entry' : 'doc',
            // 局部图（2026-09-14 批次 2）：`--around <docId>` 只画该文档 N 跳双向邻域。
            // 为什么需要：全局图在文档多起来后是"毛线球"，只能当装饰；局部图才是能读的结构视图。
            // 缺省不设（null）→ 仍是全局图，行为与旧版一致（GUI 不传就什么都没变）。
            around: args.around ? String(args.around) : null,
            // `--hops` 是**范围参数**，故在这里收敛到 1..3：内核里也 clamp（防御直接调用者），
            // 但 CLI 层先收敛能让"传了 99"这种明显笔误立刻表现为上限 3，而不是悄悄给出大半张图。
            hops: (() => { const n = Number(args.hops); return Number.isFinite(n) && n > 0 ? Math.min(3, Math.floor(n)) : 1 })(),
          }),
          code: 0,
        }
      case 'stats':
        // 索引统计 + 上次会话的注入指标（inject.indexLines/recallBlocks/hitRate、search P50/P95）
        return { output: { ...store.stats(), metrics: readMetrics(configDir) }, code: 0 }
      case 'reindex':
        return { output: { ok: true, ...store.stats() }, code: 0 }
      case 'update-doc':
        // updateDoc 是同步函数（同 load）：增量更新后立即落盘，故此处也不写 await。
        return { output: store.updateDoc(String(args.id || '')), code: 0 }
      case 'tags':
        // S6：标签枚举（读侧"写前先查"的依据）。纯读、无副作用。
        return { output: listMemoryTags(configDir), code: 0 }
      case 'index-tags': {
        // 2026-09-14（批次 1）：全库文档标签枚举。`--spaces a,b` 限定空间，
        // 缺省 = 全部空间。参数解析口径与 search 逐字一致（见 parseSpacesArg）。
        const only = parseSpacesArg(args)
        return { output: store.listIndexTags({ spaces: only }), code: 0 }
      }
      case 'append': {
        // S6：**唯一的写 op**（append-only）。
        //
        // 为什么不做成"放开 Write 白名单"：Write 是整体覆盖语义（工具说明原文：
        // "必须携带完整新内容，遗漏会导致文件被清空"），一次失误能清空整个 theme 文件；
        // append 在**结构上**没有覆盖路径 —— 它反而**强化**了 2026-09-10 那条
        // "不允许任意覆盖记忆"的原始防护意图，同时把 agent 从 Bash `>>`（绕过全部检查）
        // 拉回到有校验的正道。
        //
        // 四道闸门（校验失败**一个字节都不落盘**）：
        //   协议文本 / 空模板 / 正文过短(<MIN_LEN，入库即成孤立条目) / tag 与 theme 字符合法性
        const text = String(args.text ?? '')
        const v = validateAppendEntry({ text, tag: args.tag ?? null, theme: args.theme ?? null })
        if (!v.ok) return { output: { error: v.error, message: v.message }, code: 1 }
        // ⚠️ `root` 是 **`memoryRoot(configDir)`**（= `<configDir>/memory/personal`），
        // 不是 `configDir` 本身 —— `appendMemoryEntry` 内部直接 `themePath(root, theme)`
        // 且会 `mkdirSync(root, {recursive:true})`，传错一层**不会报错**，只会静默新建
        // 一个 `<configDir>/workflow.md`（实测踩过：测试条目落到了 `~/.ponos/workflow.md`，
        // 真正的 memory 目录一个字节没变，而返回值还是 `ok:true`）。
        const root = memoryRoot(configDir)
        // 第二道防呆已在入口短路（见上，`name === 'append' && !rootExistedBefore`）——
        // 这里不再重复判断，避免两处口径漂移。
        const r = appendMemoryEntry({
          root,
          theme: v.theme,
          tag: v.tag,
          // summary 取正文首行截断（列表页展示用）；full 存全文（S5 起 full 才是关联与检索的主口径）
          summary: text.trim().split('\n')[0].slice(0, 60),
          full: text.trim(),
          knowledgeIndex: store,
        })
        // `deduped` 必须回显：调用方要能区分"写进去了"与"早就有了"——
        // 否则重复调用看起来都成功，实际文件没长，会被误判成写入失效。
        return { output: { ok: true, theme: v.theme, tag: v.tag, deduped: !!r?.deduped, ...r }, code: 0 }
      }
      case 'import': {
        // 文件知识库导入（2026-09-14）：唯一入口，白名单/体积/路径防护/台账/索引同步
        // 全部在 kernel/knowledge-import.mjs 里（本 op 只做参数归一与错误→退出码映射）。
        //
        // `--src` 必填且**不做默认值猜测**：缺省猜 cwd 会让"忘了给参数"变成
        // "把整个工作目录导进知识库"——一次误操作几万文件，且不可逆（有台账也没人会去删）。
        // 可重复给出（多选文件/多目录），归一成 string | string[]。
        // （flag 叫 `--src` 而非 `--from`：后者已被 CLI 的范围语义占用，见 kernel/cli.mjs。）
        const fromList = (Array.isArray(args.src) ? args.src : [args.src])
          .map((s) => String(s ?? '').trim()).filter(Boolean)
        if (!fromList.length) {
          return { output: { error: 'missing-from', message: 'import 需要 --src <文件或目录路径>（可重复给出多个；等价写法 --from，但多源必须用可重复的 --src）' }, code: 1 }
        }
        const from = fromList.length === 1 ? fromList[0] : fromList
        // `--max-ocr-pages` 的取值校验：**非法值必须报错，不得静默回落默认 200**。
        // 为什么（与 `related` 的 parseLimit 同一条纪律）：OCR 是分钟级操作 —— `--max-ocr-pages 5`
        // 若被静默当 200，用户会以为"已经限流"，实际跑了 40 倍工作量；`--max-ocr-pages abc`
        // 静默成功更糟（参数错误被读成"数据本来就是这么处理的"）。
        // 缺省（未给 / 空串）= 内核默认 200，是**唯一**允许的缺省路径。
        // 非整数给 floor（`5.5 → 5`，与 server/tool 两层的 Math.floor 同口径，不算参数错误）。
        let maxOcrLimit = null
        const rawMaxOcr = args.maxOcrPages
        if (rawMaxOcr !== undefined && rawMaxOcr !== null && String(rawMaxOcr) !== '') {
          const n = Number(rawMaxOcr)
          if (!Number.isFinite(n) || n < 1) {
            return {
              output: {
                error: 'bad-max-ocr-pages',
                message: `import: --max-ocr-pages 必须是 ≥1 的数值（收到 ${JSON.stringify(rawMaxOcr)}；不传则用内核默认 200）`,
              },
              code: 1,
            }
          }
          maxOcrLimit = Math.floor(n)
        }
        // 视觉表格提取（2026-09-14）：`--vision-tables off` 显式关闭。
        // 默认 `auto` = 配了视觉模型就用、没配就静默跳过（并让报告带上 not-configured 供 GUI 提示）。
        // 为什么不默认关：用户配视觉模型就是为了让它干活；默认关会让"扫描件表格读不出来"
        // 变成一个需要读文档才知道要打开的隐藏开关。
        // 页数上限同样**非法值报错**（理由同 --max-ocr-pages：视觉按页计费，静默回落 = 账单失真）。
        const rawVision = args.visionTables
        let visionTables = 'auto'
        if (rawVision !== undefined && rawVision !== null && String(rawVision) !== '') {
          const v = String(rawVision).toLowerCase()
          if (v === 'off' || v === 'false' || v === '0' || v === 'no') visionTables = false
          else if (v === 'on' || v === 'true' || v === '1' || v === 'yes' || v === 'auto') visionTables = v === 'auto' ? 'auto' : true
          else {
            return {
              output: {
                error: 'bad-vision-tables',
                message: `import: --vision-tables 只接受 auto|on|off（收到 ${JSON.stringify(rawVision)}；不传则 auto）`,
              },
              code: 1,
            }
          }
        }
        let maxVisionLimit = null
        const rawMaxVision = args.maxVisionPages
        if (rawMaxVision !== undefined && rawMaxVision !== null && String(rawMaxVision) !== '') {
          const n = Number(rawMaxVision)
          if (!Number.isFinite(n) || n < 0) {
            return {
              output: {
                error: 'bad-max-vision-pages',
                message: `import: --max-vision-pages 必须是 ≥0 的数值（收到 ${JSON.stringify(rawMaxVision)}；不传则用内核默认 20）`,
              },
              code: 1,
            }
          }
          maxVisionLimit = Math.floor(n)
        }
        // 批量上限（2026-09-14，需求"支持大批量文件压力"+ 上限改为可配置）：
        // `--max-files` / `--max-total-mb` 覆盖内核默认（500 文件 / 300MB）。
        // 为什么必须可配：500 是**整批拒绝**式护栏（超一个就全不导），对企业知识库动辄上千文件
        // 的场景直接不可用；但也不能简单删——它是内存与超时的唯一保护。
        // 故做成"默认保守、可显式放宽"，把放宽的责任明确交给调用方（设置项）。
        // 非法值报错而非静默回落（理由同 --max-ocr-pages：静默把 2000 读成 500，
        // 用户看到的是"莫名只导进去一部分"，而不是"我的参数没生效"）。
        const numOrNull = (raw, { min, errCode, hint }) => {
          if (raw === undefined || raw === null || String(raw) === '') return { ok: true, value: null }
          const n = Number(raw)
          if (!Number.isFinite(n) || n < min) {
            return { ok: false, resp: { output: { error: errCode, message: `import: ${hint}（收到 ${JSON.stringify(raw)}）` }, code: 1 } }
          }
          return { ok: true, value: Math.floor(n) }
        }
        const mf = numOrNull(args.maxFiles, {
          min: 1, errCode: 'bad-max-files',
          hint: '--max-files 必须是 ≥1 的整数；不传则用配置上限（默认 500）',
        })
        if (!mf.ok) return mf.resp
        const mt = numOrNull(args.maxTotalMb, {
          min: 1, errCode: 'bad-max-total-mb',
          hint: '--max-total-mb 必须是 ≥1 的数值（单位 MB）；不传则用配置上限（默认 300）',
        })
        if (!mt.ok) return mt.resp
        const MB = 1024 * 1024
        // ⚠️ 键名必须用**内核 IMPORT_LIMITS 的键**（maxBatchFiles / maxBatchBytes），
        // 不是 importFiles 的友好参数名（maxFiles / maxTotalBytes）。
        // 本 op 直调 importDocuments，它的 limits 是 `{...IMPORT_LIMITS, ...override}` 的
        // **浅合并**——写错键名不会报错，只会静默多出一个无人读取的字段，
        // 于是"我把上限调到 5000"实际仍是 500。这正是本文件反复踩的"漏登记即静默失效"同类坑。
        const limitPairs = {
          ...(maxOcrLimit === null ? {} : { maxOcrPages: maxOcrLimit }),
          ...(maxVisionLimit === null ? {} : { maxVisionPages: maxVisionLimit }),
          ...(mf.value === null ? {} : { maxBatchFiles: mf.value }),
          ...(mt.value === null ? {} : { maxBatchBytes: mt.value * MB }),
        }
        const report = await importDocuments({
          configDir, from,
          space: args.space ?? null, name: args.name ?? null,
          dryRun: args.dryRun === true,
          // 复用本进程已 load 的 store：导入后由它 load({}) 一次，让新空间/新文件立刻可检索。
          // 不传的话"导入完搜不到"要等下次会话 —— 那是用户一眼能看见的毛病。
          // dry-run 传 null：该分支在模块内部提前 return，从不碰索引；传了反而要冒"为预览
          // 付一次 store.load"的风险（那正是上面 skipLoad 要避免的落盘副作用）。
          knowledgeIndex: args.dryRun === true ? null : store,
          limits: Object.keys(limitPairs).length ? limitPairs : null,
          visionTables,
          // 进度旁路（2026-09-14）：由 cli.mjs 注入的 `onEvent` 决定是否落到 stdout。
          // 不在此判断 `--progress`：本 op 不该知道传输格式（NDJSON / 回调 / 静默），那是调用层的事。
          // 函数缺失即静默 ⇒ 单次调用语义与之前完全一致（既有消费者不受影响）。
          onProgress: typeof onEvent === 'function' ? (evt) => onEvent({ type: 'progress', ...evt }) : null,
        })
        if (!report.ok) return { output: { error: report.error, message: report.message }, code: 1 }
        // 三档计数一并回显：调用方（GUI/agent）要能一眼看出"成功了几篇、跳过了几篇、失败几篇及原因"，
        // 只回 ok 等于让用户去猜到底导进去了什么。
        // ⚠️ 逐文件失败**不算** op 失败（exit 0）：op 已正常完成并交出报告，失败明细在
        // `counts.failed` / `failed[]` 里。若这里 exit 1，HTTP 侧 kernelReadonly 会
        // **reject 并丢弃 stdout**（见 server/kernel-readonly.mjs runOnce）→ 用户只拿到
        // 一个无信息量的 500，而我们明明有逐条原因。整批级错误（bad-space-id / not-found /
        // too-many-files）才 code 1 —— 那种情况下 message 就是全部信息。
        return { output: report, code: 0 }
      }
      case 'trash-list':
        // 回收站清单（GUI「最近删除」）。纯读、无副作用（根不存在时返回空清单）。
        return { output: store.listTrash(), code: 0 }
      case 'stash-doc': {
        // 覆盖前备份（2026-09-14 批次 4）：**复制**当前内容进回收站，原文件保留。
        // 服务端在"用户强制覆盖一份已被外部改过的文件"时先调它；失败则放弃写入
        // （宁可这次不保存，也不能把别人的改动销毁得无影无踪）。
        // 属于写操作 → 必须进 WRITE_OPS（否则根目录不存在时会静默"成功"）。
        const r = store.stashDoc({
          space: args.space ?? null,
          path: args.path ?? null,
          reason: args.reason ?? null,
        })
        if (!r.ok) return { output: { error: r.error, message: r.message }, code: 1 }
        return { output: r, code: 0 }
      }
      case 'delete-doc': {
        // 软删除单个条目。空间/路径的合法性一律由内核 `deleteGate` + `normalizeMdRel` 判，
        // 本层只做"参数是否给全"的粗筛（未给就明确报错，不通融成空 path）。
        const r = store.deleteDoc({ space: args.space ?? null, path: args.path ?? null })
        if (!r.ok) return { output: { error: r.error, message: r.message }, code: 1 }
        return { output: r, code: 0 }
      }
      case 'delete-space': {
        // 软删除整个**用户自建**空间。内置经验库/会话记忆库不可删整库（内核 protected-space），
        // 知识包只读（readonly-space）；`--confirm` 必须精确等于空间 id（防手滑删库）。
        const r = store.deleteSpace({ space: args.space ?? null, confirm: args.confirm ?? null })
        if (!r.ok) return { output: { error: r.error, message: r.message }, code: 1 }
        return { output: r, code: 0 }
      }
      case 'restore': {
        const r = store.restore({ trashId: args.trashId ?? null })
        if (!r.ok) return { output: { error: r.error, message: r.message }, code: 1 }
        return { output: r, code: 0 }
      }
      case 'purge': {
        // `--all` 与 `--trash-id` 的区别要**如实传下去**：`all` 只认 `=== true`
        //（字符串 'false' / undefined 都按"单条删除"走，宁可少删不可多删）。
        const r = store.purge({ trashId: args.trashId ?? null, all: args.all === true })
        if (!r.ok) return { output: { error: r.error, message: r.message }, code: 1 }
        return { output: r, code: 0 }
      }
      default:
        return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
    }
  } catch (e) {
    return { output: { error: e?.message || String(e) }, code: 1 }
  }
}
