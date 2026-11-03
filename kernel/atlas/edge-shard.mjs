// kernel/atlas/edge-shard.mjs —— C/C++ `#include` 边的独立分片
// ---------------------------------------------------------------------------
// 为什么单独存：Chromium 级工作区里 `#include` 边可达百万级，而 find/overview/
// search 一条都不用。把它们塞进 edges.json 会让**每次**查询都多解析几十 MB；
// 分片后只有 impact/related/path/card（C++ 节点）才读，且一个 atlas 代只读一次。
//
// 格式（小端）：
//   'AIN1' | u32 version | u32 count | count × (u32 fromIndex, u32 toIndex)
// 索引指向 nodes.json 的数组下标 —— 边只连 code/test 节点，路径字符串不重复存。
// meta.includes 记录 {file, count, bytes, buildId}；加载时核对 buildId 与下标范围，
// 缺片/坏片明确返回 ok:false，绝不静默当作“没有 include 依赖”。
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomicSync } from '../../shared/atomic-write.mjs'

export const INCLUDE_SHARD_FILE = 'includes.bin'
const MAGIC = 'AIN1'
const VERSION = 1
const HEADER_BYTES = 12
const ENTRY_BYTES = 8

let shardCache = new WeakMap()
let inlineEdges = new WeakSet()

export function includeShardPath(dir) {
  return path.join(dir, INCLUDE_SHARD_FILE)
}

/**
 * 把 include 边写成独立分片。返回 meta.includes；没有 include 边也写空分片
 * （空分片是**合法事实**，不能与“分片缺失”混淆）。
 * @param {{dir:string, buildId:string, nodes:Array<any>, edges:Array<any>}} o
 */
export function writeIncludeShard({ dir, buildId, nodes, edges }) {
  const idx = new Map()
  for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].id, i)
  const pairs = []
  for (const e of edges || []) {
    if (e.via !== 'include') continue
    const from = idx.get(e.from)
    const to = idx.get(e.to)
    if (from == null || to == null) continue
    pairs.push([from, to])
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const buf = Buffer.allocUnsafe(HEADER_BYTES + pairs.length * ENTRY_BYTES)
  buf.write(MAGIC, 0, 'ascii')
  buf.writeUInt32LE(VERSION, 4)
  buf.writeUInt32LE(pairs.length, 8)
  let off = HEADER_BYTES
  for (const [from, to] of pairs) {
    buf.writeUInt32LE(from, off)
    buf.writeUInt32LE(to, off + 4)
    off += ENTRY_BYTES
  }
  writeFileAtomicSync(includeShardPath(dir), buf)
  return { file: INCLUDE_SHARD_FILE, version: VERSION, count: pairs.length, bytes: buf.length, buildId }
}

/** 构建结果本身已含全部边：标记后 allEdges 不再尝试读盘（write=false 也成立）。 */
export function markEdgesInline(atlas) {
  if (atlas && typeof atlas === 'object') inlineEdges.add(atlas)
}

function missing(reason) {
  return { ok: false, reason, edges: [], all: [] }
}

function shardState(atlas) {
  if (!atlas || typeof atlas !== 'object') return missing('no-atlas')
  if (inlineEdges.has(atlas)) {
    return { ok: true, reason: null, edges: [], all: atlas.edges || [] }
  }
  const hit = shardCache.get(atlas)
  if (hit) return hit
  let state
  try {
    const info = atlas.meta?.includes
    if (!info || !info.file) state = missing('no-shard')
    else if (info.buildId && atlas.meta?.buildId && info.buildId !== atlas.meta.buildId) {
      state = missing('generation-mismatch')
    } else if (!Array.isArray(atlas.nodes)) {
      state = missing('no-nodes')
    } else {
      const buf = fs.readFileSync(includeShardPath(atlas.dir || atlas.meta?.cacheDir || ''))
      if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== MAGIC) {
        state = missing('corrupt-shard')
      } else if (buf.readUInt32LE(4) !== VERSION) {
        state = missing('shard-version-mismatch')
      } else {
        const count = buf.readUInt32LE(8)
        if (buf.length !== HEADER_BYTES + count * ENTRY_BYTES) state = missing('corrupt-shard')
        else {
          const edges = []
          for (let i = 0; i < count; i++) {
            const from = atlas.nodes[buf.readUInt32LE(HEADER_BYTES + i * ENTRY_BYTES)]
            const to = atlas.nodes[buf.readUInt32LE(HEADER_BYTES + i * ENTRY_BYTES + 4)]
            if (!from || !to) { edges.length = 0; break }
            edges.push({ type: 'imports', from: from.id, to: to.id, via: 'include' })
          }
          state = edges.length === count
            ? { ok: true, reason: null, edges, all: (atlas.edges || []).concat(edges) }
            : missing('corrupt-shard')
        }
      }
    }
  } catch (err) {
    state = missing(err?.code === 'ENOENT' ? 'missing-shard' : 'unreadable-shard')
  }
  shardCache.set(atlas, state)
  return state
}

/** 分片状态（不触发额外读盘；首次调用会读一次并缓存）。 */
export function includeShardState(atlas) {
  const s = shardState(atlas)
  return { ok: s.ok, reason: s.reason }
}

/** 全部边（核心边 + include 分片）。分片坏了只回核心边，调用方用状态提示不完整。 */
export function allEdges(atlas) {
  return shardState(atlas).all
}

/** 测试/诊断用：清空分片缓存（WeakMap 没有 clear，换代即可）。 */
export function clearIncludeCache() {
  shardCache = new WeakMap()
  inlineEdges = new WeakSet()
}
