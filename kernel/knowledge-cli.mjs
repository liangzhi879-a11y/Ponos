// kernel/knowledge-cli.mjs —— `--knowledge <op>` 的聚合实现
// ---------------------------------------------------------------------------
// 为什么聚合：10 个 op 的差别只是"调哪个方法、传什么参"，聚合后 cli.mjs 只需一个
// 短路分支 + 10 个 parseArgs case；分散成 10 个 flag 会让 parseArgs 膨胀三倍。
// 与 kernel/readonly.mjs 同款范式：stdout 一个 JSON，code 0/1，不进 loop。
//
// 失败策略（本模块的硬契约）：**永不把异常抛给调用方**——未知 op 与内部异常一律
// 折成 `{ output: { error }, code: 1 }`。CLI 子命令是旁路能力，它的故障不得打断
// 调用方（server/bridge 后续经 kernel-readonly 薄转发，见 Task 11）。
import { createKnowledgeStore } from './knowledge.mjs'

const OPS = new Set([
  'spaces', 'tree', 'doc', 'entries', 'search', 'links', 'graph', 'stats', 'reindex', 'update-doc',
])

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
      case 'graph':
        return {
          output: store.getGraph({
            space: args.space ? String(args.space) : null,
            limit: Number(args.limit) || 200,
          }),
          code: 0,
        }
      case 'stats':
        return { output: store.stats(), code: 0 }
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
