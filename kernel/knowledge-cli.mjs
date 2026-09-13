// kernel/knowledge-cli.mjs —— `--knowledge <op>` 的聚合实现
// ---------------------------------------------------------------------------
// 为什么聚合：10 个 op 的差别只是"调哪个方法、传什么参"，聚合后 cli.mjs 只需一个
// 短路分支 + 10 个 parseArgs case；分散成 10 个 flag 会让 parseArgs 膨胀三倍。
// 与 kernel/readonly.mjs 同款范式：stdout 一个 JSON，code 0/1，不进 loop。
//
// 失败策略（本模块的硬契约）：**永不把异常抛给调用方**——未知 op 与内部异常一律
// 折成 `{ output: { error }, code: 1 }`。CLI 子命令是旁路能力，它的故障不得打断
// 调用方（server/bridge 后续经 kernel-readonly 薄转发，见 Task 11）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKnowledgeStore, knowledgeRoot } from './knowledge.mjs'
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
])

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

export async function runKnowledgeCommand({ op, args = {}, configDir = '' } = {}) {
  const name = String(op || '').trim()
  if (!OPS.has(name)) {
    return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
  }
  const store = createKnowledgeStore({ configDir })
  try {
    // reindex 必须 force（用户显式要求重建）；其余 op 走"按需加载"（索引缺失/过期时
    // 内部自动全量重建），但 `--force` 可把任一 op 提到强制重建。load 是同步函数
    // （Task 6 的契约）——此处不写 await。
    store.load({ force: name === 'reindex' || args.force === true })

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
            // 空间过滤。三种入参都要支持，缺一即静默失效（返回未过滤或全空）：
            //   - `args.spaces` 数组（本模块直接调用）
            //   - `args.space` 单值（parseArgs 收的单数形式）
            //   - `args.space` 逗号串（HTTP `?spaces=a,b` 经路由转发的形式）
            // 逗号分隔与 `--keywords` 的既有约定一致。原实现只把 `--space` 当**单个**
            // id，于是 `--space a,b` 匹配不到任何空间 → 过滤掉全部结果、静默 0 命中。
            spaces: (() => {
              if (Array.isArray(args.spaces) && args.spaces.length) return args.spaces
              const raw = String(args.space || '').trim()
              if (!raw) return null
              const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
              return parts.length ? parts : null
            })(),
            topK: Number(args.topK) || 5,
            maxBytes: Number(args.maxBytes) || 2048,
            mode: args.mode === 'full' ? 'full' : 'snippet',
          }),
          code: 0,
        }
      case 'links':
        return { output: store.getLinks(String(args.id || '')), code: 0 }
      case 'related': {
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
            limit: Number(args.limit) || 200,
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
      default:
        return { output: { error: `unknown knowledge op: ${name}` }, code: 1 }
    }
  } catch (e) {
    return { output: { error: e?.message || String(e) }, code: 1 }
  }
}
