// kernel/tag-store.mjs —— S2-D6 标签注册表的**持久化层**（纯逻辑在 shared/tag-registry.mjs）。
//
// 分工（与 D4 的 `shared/attribution.mjs` + 各 store 同构）：
//   shared/tag-registry.mjs  = 规则（归一、实体、别名链、自动合并、撤销、作用域），零 IO、可单测
//   kernel/tag-store.mjs     = 落到 `<configDir>/tags/registry.json`（原子写）、并给生产路径提供**解析器工厂**
//
// 【为什么写盘用 writeFileAtomicSync 而不是 writeFileSync】
// 复用 `shared/atomic-write.mjs`（tmp + fsync + rename）。理由见该文件头：就地覆写一旦在半截处崩溃，
// 留下的就是"注册表只剩前若干字节"的半截文件，且**没有报错**。标签注册表被索引/记忆/界面共同读取，
// 半截文件会同时污染三条链路。不自己再实现一遍原子写，是为了不产生第二个"看起来也安全"的写入口。
//
// 【损坏文件的两种态度（关键设计）】
// - 读侧（构建知识索引、内存标签枚举、解析器）用**非严格**：文件坏掉就当作"没有别名表"继续跑
//   （别名暂不生效，但索引仍能构建、界面仍能用）。让一个可选的便利功能坏掉，不该连带把主链路拖死。
// - 写侧（合并/撤销）用**严格**：坏文件**抛错拒绝写**。否则一次自动合并就会把损坏内容覆盖成"空注册表"，
//   抹掉本可人工恢复的数据。宁可这次操作失败，也不能静默毁数据。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../shared/atomic-write.mjs'
import {
  createTagRegistry, ensureTags, mergeTag, undoMerge, resolveTagName, tagRegistryView, TAG_REGISTRY_VERSION,
  DEFAULT_TAG_SCOPE,
} from '../shared/tag-registry.mjs'

/** 注册表落盘路径。与其它 store 一致：目录由调用方注入（模块不自解析 home）。 */
export function tagRegistryPath(configDir) {
  return join(String(configDir || '.'), 'tags', 'registry.json')
}

/**
 * 读取注册表。
 * - 文件不存在 → 空注册表（**不是错误**：全新安装从未建过表）
 * - 文件损坏 → `strict` 抛错（写侧）/ 非严格返回空表（读侧降级，见文件头）
 */
export function loadTagRegistry(configDir, { strict = false } = {}) {
  const p = tagRegistryPath(configDir)
  if (!existsSync(p)) return createTagRegistry()
  let raw = ''
  try {
    raw = readFileSync(p, 'utf-8')
  } catch (e) {
    if (strict) throw new Error(`标签注册表不可读：${p}（${e && e.message ? e.message : e}）`)
    return createTagRegistry()
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tags)) throw new Error('缺少 tags 数组')
    if (!Array.isArray(parsed.merges)) parsed.merges = []
    if (!parsed.version) parsed.version = TAG_REGISTRY_VERSION
    return parsed
  } catch (e) {
    if (strict) throw new Error(`标签注册表已损坏，拒绝覆盖：${p}（${e && e.message ? e.message : e}）。请先人工修复或移走该文件。`)
    return createTagRegistry()
  }
}

/** 写入注册表（原子）。返回写入字节数。 */
export function saveTagRegistry(configDir, reg) {
  reg.updatedAt = new Date().toISOString()
  return writeFileAtomicSync(tagRegistryPath(configDir), JSON.stringify(reg, null, 2) + '\n')
}

/**
 * 把"见到过的标签"批量入册（追加式，不做受控词表）。
 * **有新增才写盘**：知识索引构建会在每次扫描时把全库标签送进来，若每次都写盘就是无谓的 IO 与
 * 无意义的 mtime 抖动（会让备份/同步误判"文件变了"）。
 */
export function syncTagNames(configDir, names, { scope = DEFAULT_TAG_SCOPE } = {}) {
  const reg = loadTagRegistry(configDir, { strict: false })
  const created = ensureTags(reg, names, { scope })
  if (created.length) saveTagRegistry(configDir, reg)
  return { created, total: reg.tags.filter((t) => t.scope === scope).length }
}

/**
 * **自动合并**（无审核，用户裁定 #4）+ 落盘。
 * 返回 `{ ok, mergeId?, reason?, message? }`；失败时**不写盘**（避免把一次 no-op 写成 mtime 变化）。
 */
export function mergeTagsInStore(configDir, from, into, { scope = DEFAULT_TAG_SCOPE } = {}) {
  const reg = loadTagRegistry(configDir, { strict: true })
  const before = reg.merges.length
  const r = mergeTag(reg, from, into, { scope })
  if (r.ok) {
    if (reg.merges.length === before) throw new Error('内部错误：合并成功但未留下撤销凭据，拒绝落盘')
    saveTagRegistry(configDir, reg)
  }
  return r
}

/** **撤销合并** + 落盘。同样：失败不写盘。 */
export function undoMergeInStore(configDir, mergeId) {
  const reg = loadTagRegistry(configDir, { strict: true })
  const r = undoMerge(reg, mergeId)
  if (r.ok) saveTagRegistry(configDir, reg)
  return r
}

/** 可观测快照（供 `GET /tags` 与排障）。 */
export function tagRegistrySnapshot(configDir, { scope = DEFAULT_TAG_SCOPE } = {}) {
  return tagRegistryView(loadTagRegistry(configDir, { strict: false }), { scope })
}

/**
 * 构造"裸字符串 → 规范名"的解析器（生产接线用，见 kernel/knowledge-cli.mjs 的 tags / index-tags）。
 *
 * 传入 `registry` 可复用已加载的注册表（避免一次调用里反复读盘）；不传则读一次并**缓存于闭包**。
 * 只缓存"这次调用内"的形态 ⇒ 单次 CLI 调用/单次请求内一致；跨调用不缓存，
 * 以免长驻进程（桥）把合并结果缓存成陈旧视图。
 */
export function makeTagResolver({ configDir, scope = DEFAULT_TAG_SCOPE, registry = null, strict = false } = {}) {
  const reg = registry || loadTagRegistry(configDir, { strict })
  return (raw) => resolveTagName(reg, raw, { scope })
}
