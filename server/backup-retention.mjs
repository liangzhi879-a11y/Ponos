// server/backup-retention.mjs —— 戳记备份的保留策略（纯函数，可单测）
//
// 背景（实测，不是推测）：server/bridge.mjs 的 safeWriteJsonWithBak 注释写的是
// "Stamp a dated snapshot once per day"，但实现是**每次写入都打戳**（formatStamp 精确到秒），
// 而 pruneStampedBackups(target, 7) 只按 **7 天龄期**裁剪、**没有任何条数上限**。
// 后果：同一天写 N 次就留 N 份。实测 ~/.yfworking/ 顶层 1738 项里 1691 个是 .bak*，
// 其中 config.json.* 827 份、settings.json.* 778 份、providers.json.* 88 份 ——
// 用户主目录被自己的备份淹掉，还拖慢目录遍历。
//
// 为什么单独成模块：保留策略是"删文件"的判断，判错就是**永久删掉用户数据**。
// 写进 bridge.mjs 那个巨型文件里既无法单测、也无法复核。这里全是纯函数：
// 输入清单 → 输出"该删谁"，不碰磁盘（读目录/删除由调用方做）。

/** 每天最多保留几份（同日冗余备份对用户没有额外价值：一天内的中间态几乎不可能用到） */
export const DEFAULT_KEEP_PER_DAY = 1
/** 总数上限：即使每天 1 份、跨 7 天也只有 7 份；上限是防"日期被改/时钟跳变"这类异常 */
export const DEFAULT_KEEP_TOTAL = 20
/** 龄期上限（天）：与既有行为一致（原来就是 7 天） */
export const DEFAULT_MAX_AGE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** 匹配 `<base>.bak.YYYYMMDD-HHMMSS`，捕获日期与时间两部分 */
const STAMP_RE = /\.bak\.(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/

/**
 * 从备份文件名解出"属于哪一天"（YYYYMMDD）。
 * 解不出（不是本策略管理的戳记文件）返回 null —— 调用方必须**跳过**这类文件：
 * 名字不认识的备份可能有别的用途，宁可少删也不能误删。
 */
export function stampDayOf(name) {
  if (typeof name !== 'string') return null
  const m = STAMP_RE.exec(name)
  return m ? `${m[1]}${m[2]}${m[3]}` : null
}

/**
 * 纯函数：算出应删除的备份文件名。
 *
 * @param {{name: string, mtimeMs: number}[]} items 候选清单（由调用方 readdir+stat 得到）
 * @param {{keepPerDay?: number, keepTotal?: number, maxAgeDays?: number, nowMs?: number}} [opts]
 * @returns {string[]} 应删除的文件名（去重；同一文件只会出现一次）
 *
 * 规则（三条独立生效，任一条命中即删）：
 *   1. **龄期**：mtime 早于 now - maxAgeDays 的删；
 *   2. **同日冗余**：同一天内只保留最新 keepPerDay 份，其余删（这条直接治 827 份的病）；
 *   3. **总量**：剩余里按 mtime 由新到旧保留 keepTotal 份，更旧的删。
 * 非戳记文件（stampDayOf 返回 null）**永不入选**。
 */
export function selectStaleBackups(items, opts = {}) {
  const keepPerDay = Number.isFinite(opts.keepPerDay) ? Math.max(1, opts.keepPerDay) : DEFAULT_KEEP_PER_DAY
  const keepTotal = Number.isFinite(opts.keepTotal) ? Math.max(1, opts.keepTotal) : DEFAULT_KEEP_TOTAL
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? Math.max(0, opts.maxAgeDays) : DEFAULT_MAX_AGE_DAYS
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()

  const known = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.name !== 'string') continue
    const day = stampDayOf(it.name)
    if (!day) continue                       // 规则：非本策略管理的文件不碰
    if (!Number.isFinite(it.mtimeMs)) continue // mtime 缺失无法比较 ⇒ 保守不删
    known.push({ name: it.name, day, mtimeMs: it.mtimeMs })
  }

  const doomed = new Set()

  // 规则 1：龄期
  const cutoff = nowMs - maxAgeDays * DAY_MS
  for (const b of known) if (b.mtimeMs < cutoff) doomed.add(b.name)

  // 规则 2：同日冗余（按 mtime 降序，每天保留前 keepPerDay 份）
  const byDay = new Map()
  for (const b of known) {
    if (!byDay.has(b.day)) byDay.set(b.day, [])
    byDay.get(b.day).push(b)
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const b of list.slice(keepPerDay)) doomed.add(b.name)
  }

  // 规则 3：总量（在"未被规则 1/2 判死"的幸存者里再砍最旧的）
  const survivors = known.filter(b => !doomed.has(b.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const b of survivors.slice(keepTotal)) doomed.add(b.name)

  return [...doomed]
}

/**
 * 今天是否已经有戳记备份（供 safeWriteJsonWithBak 决定"跳过打戳"）。
 * 这是**断源**：光裁剪存量只能治标，每次写入仍不断产生新的同日冗余。
 */
export function hasBackupForDay(names, day, baseName) {
  if (!Array.isArray(names) || typeof day !== 'string') return false
  const prefix = `${baseName}.bak.${day}-`
  return names.some(n => typeof n === 'string' && n.startsWith(prefix))
}
