// kernel/skill-history.mjs —— 技能版本历史与回滚（spec §4.4 步骤 5/6；2026-10-10）
// ---------------------------------------------------------------------------
// 设计真源：docs/superpowers/specs/2026-10-08-runtime-evolution-loop-design.md
//   §4.4「升级闭环（技能类）」第 5 条（版本器：安装前把旧版写 `<skills>/<id>/.history/<ts>.md`，
//   保留 10 版；`CHANGELOG.md` 追加一行含 时间 / changeType / 来源候选 id）与第 6 条（回滚：
//   `POST /evolution/skill-rollback {id, ts}` → 从 `.history` 取版 → 走**同一条**校验 + 安装链
//   → 再记 CHANGELOG）。
//
// 同族先例（照着做，不另发明）：`server/workflow-store.mjs` 的 `versionsDir` / `VERSION_KEEP`
// （保留 20）/ `writeWorkflowYml`（写前快照 + 超限剪枝）/ `rollbackVersion`（取版后走同一写入收口）。
//
// 纪律：
//   · **纯 IO、无 HTTP**：路由层只管状态码，落盘语义只此一处（与 skill-drafts/skill-forge 同分工）。
//   · 路径安全：`id` 与 `ts` 都按白名单校验后才拼路径（`..`、绝对路径、Windows 设备名一律拒），
//     并把最终路径压回技能根之内（双保险）。拒绝时**抛错**而不是返回假成功。
//   · 永不静默：快照失败**不阻断**安装（用户的修订不该因为备份失败而丢失），但返回里如实带
//     `snapshot.error`，由调用方记 CHANGELOG 与响应体——"备份失败"必须可见。
//
// ★ JSDoc 注解纪律（本仓 checkJs）：形如 `({a, b} = {})` 的解构参数，若不写 `@param`，TS 会**按
//   默认值 `{}` 反推**出"所有键都不存在"⇒ 函数体内每个属性访问都报 TS2339/T2739（实测一次 36 条）。
//   故本文件所有对象参数都显式声明键（**可选**记法，与 `kernel/skills.mjs#loadSkillDetail` 先例
//   一致：调用方必须传，类型层不强制）。新加函数时勿省这一步。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 保留版本数（spec §4.4 第 5 条：保留 10 版） */
export const HISTORY_KEEP = 10
/** 历史目录名（技能目录内） */
export const HISTORY_DIR = '.history'
/** 版本文件名后缀（`<ts>.md`） */
export const HISTORY_EXT = '.md'

/** 版本号（时间戳）白名单：ISO 时间把 `:`/`.` 换成 `-`（与 workflow-store 同款） */
const SAFE_TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/
/** 技能 id 白名单：字母数字与 `-_.`（技能目录名实测形态），首字符必须是字母数字 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Windows 保留设备名（`id` 会变成目录名，撞上会创建失败或行为诡异） */
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * 校验技能 id（非法抛错——路由层转 400，绝不静默拼出一个越界路径）。
 * @param {unknown} id
 * @returns {string} 归一后的 id（首尾空白已 trim）
 */
export function assertSafeSkillId(id) {
  const s = String(id ?? '').trim()
  if (!s || !SAFE_ID.test(s) || s.includes('..') || /[. ]$/.test(s)) throw new Error(`非法技能 id: ${id}`)
  if (WINDOWS_DEVICE.test(s) || WINDOWS_DEVICE.test(s.split('.')[0])) throw new Error(`非法技能 id: ${id}（Windows 保留设备名）`)
  return s
}

/**
 * 校验版本号（非法抛错）。
 * @param {unknown} ts
 * @returns {string}
 */
export function assertSafeTs(ts) {
  const s = String(ts ?? '').trim()
  if (!SAFE_TS.test(s)) throw new Error(`非法版本号: ${ts}（形如 2026-10-10T06-12-33-123Z）`)
  return s
}

/**
 * 版本目录：`<skills>/<id>/.history`（id 已校验；返回前压回技能根之内作双保险）。
 * @param {string} skillRoot
 * @param {string} id
 * @returns {string}
 */
export function skillHistoryDir(skillRoot, id) {
  const root = resolve(skillRoot)
  const dir = resolve(root, assertSafeSkillId(id), HISTORY_DIR)
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`版本目录越界: ${dir}`)
  return dir
}

/**
 * 单版文件路径（ts 已校验）。
 * @param {string} skillRoot
 * @param {string} id
 * @param {string} ts
 * @returns {string}
 */
export function skillVersionPath(skillRoot, id, ts) {
  return join(skillHistoryDir(skillRoot, id), assertSafeTs(ts) + HISTORY_EXT)
}

/**
 * 生成一个版本号（path-safe ISO，与 workflow-store 同款格式）。
 * @param {Date|number|string} [now]
 * @returns {string}
 */
export function versionStamp(now = new Date()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/**
 * 快照当前 SKILL.md 到 `.history/<ts>.md` 并剪枝到 HISTORY_KEEP 版。
 *
 * @param {{skillRoot?: string, id?: string, ts?: string}} [p]
 * @returns {{ok: true, ts: string, path: string, pruned: string[]} | {ok: false, reason: string, error: string}}
 *   `reason`：`no-skill`（技能不存在/无 SKILL.md —— 首次安装没有旧版可备份，**是正常路径**）
 *            /`snapshot-failed`（真有旧版但没备份成 —— 调用方必须把它当**可见**的异常）。
 */
export function snapshotSkill({ skillRoot = '', id = '', ts = versionStamp() } = {}) {
  const sid = assertSafeSkillId(id)
  const stamp = assertSafeTs(ts)
  const src = join(resolve(skillRoot), sid, 'SKILL.md')
  if (!existsSync(src)) return { ok: false, reason: 'no-skill', error: '技能不存在或没有 SKILL.md（首次安装无需备份）' }
  const dir = skillHistoryDir(skillRoot, sid)
  const dest = join(dir, stamp + HISTORY_EXT)
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(src, dest)
  } catch (e) {
    return { ok: false, reason: 'snapshot-failed', error: String((e && e.message) || e) }
  }
  return { ok: true, ts: stamp, path: dest, pruned: pruneHistory(skillRoot, sid) }
}

/**
 * 剪枝：按名（=时间）升序保留最新 HISTORY_KEEP 版，返回被删名单。
 * @param {string} skillRoot
 * @param {string} id
 * @returns {string[]} 被删的版本号（空 = 无需剪枝）
 */
export function pruneHistory(skillRoot, id) {
  const dir = skillHistoryDir(skillRoot, id)
  /** @type {string[]} */
  let all = []
  try { all = readdirSync(dir).filter((f) => f.endsWith(HISTORY_EXT)).sort() } catch { return [] }
  const removed = []
  for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) {
    try { rmSync(join(dir, old), { force: true }); removed.push(old.slice(0, -HISTORY_EXT.length)) } catch { /* 剪枝失败不影响本次快照 */ }
  }
  return removed
}

/**
 * 列出历史版本（新→旧）。
 * @param {{skillRoot?: string, id?: string}} [p]
 * @returns {Array<{ts: string, bytes: number, at: string|null}>}
 *   空数组 = 无版本（**不是**错误：新技能或从未修订过）。
 */
export function listSkillVersions({ skillRoot = '', id = '' } = {}) {
  const dir = skillHistoryDir(skillRoot, id)
  /** @type {string[]} */
  let names = []
  try { names = readdirSync(dir).filter((f) => f.endsWith(HISTORY_EXT)).sort().reverse() } catch { return [] }
  return names.map((f) => {
    const ts = f.slice(0, -HISTORY_EXT.length)
    let bytes = 0
    let at = null
    try {
      const st = statSync(join(dir, f))
      bytes = st.size
      at = new Date(st.mtimeMs).toISOString()
    } catch { /* 读不到就不填（不编造） */ }
    return { ts, bytes, at }
  })
}

/**
 * 读某一版正文。
 * @param {{skillRoot?: string, id?: string, ts?: string}} [p]
 * @returns {string | null} null = 该版不存在（调用方转 404）。
 */
export function readSkillVersion({ skillRoot = '', id = '', ts = '' } = {}) {
  const p = skillVersionPath(skillRoot, id, ts)
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

/**
 * CHANGELOG 追加一行（spec §4.4 第 5 条）。
 *
 * 格式：`- <ISO 时间> · <changeType> · <note>`（Markdown 列表，最新在下——追加即可，
 * 天然保留全部历史，不重写文件）。文件不存在则带标题建（首行 `# 变更记录` 说明它是应用写的台账）。
 *
 * @param {{skillRoot?: string, id?: string, changeType?: string, note?: string, at?: Date}} [p]
 * @returns {{ok: boolean, path: string, error?: string}} 写失败**不抛**（台账不该阻断安装），
 *   但如实回报 ok:false —— 调用方负责让它可见。
 */
export function appendSkillChangelog({ skillRoot = '', id = '', changeType = 'update', note = '', at = new Date() } = {}) {
  const sid = assertSafeSkillId(id)
  const file = join(resolve(skillRoot), sid, 'CHANGELOG.md')
  const line = `- ${new Date(at).toISOString()} · ${String(changeType || 'update')}${note ? ' · ' + String(note) : ''}\n`
  try {
    if (!existsSync(file)) {
      writeFileSync(file, `# 变更记录\n\n> 由应用在技能安装/更新/回滚时追加（每行：时间 · 类型 · 说明）。\n\n`, 'utf-8')
    }
    // 追加写：不读全文、不重写 —— 用户可能自己也在里面写东西（不覆盖别人的字）。
    writeFileSync(file, line, { flag: 'a', encoding: 'utf-8' })
    return { ok: true, path: file }
  } catch (e) {
    return { ok: false, path: file, error: String((e && e.message) || e) }
  }
}
