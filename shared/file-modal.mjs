/**
 * S4-1 文件模态分层与三层兜底（纯逻辑，无 IO）
 *
 * 总设计 §5.1 定的分层判据是**能力**而不是文件类型：
 *   判据 = "是否存在稳定寻址单元 + 是否可回写"，两者皆备 → L-A（可合并）
 *        ；能读不能写 → L-B（可提取，只追加版本、**永不原地写**）
 *        ；经转换可归入 L-A/L-B → L-C（先转换）
 *        ；无稳定单元且不可转换 → L-D（不可解析，检出式独占）
 * 三层兜底顺序（总设计）：**先转换**（`doc_toolkit.py convert`，不重新实现转换器）→
 * **再提取**（转成结构化知识，引用锚定版本 id）→ **最后降级**（L-D 检出式独占）。
 *
 * 为什么把这一层做成纯函数：分层规则是 S4 里最容易出错、也最值得反复回归的部分
 * （每个扩展名走错一层，后面"能不能原地写""要不要独占"就全错），而它完全不依赖磁盘。
 * 纯函数 ⇒ 毫秒级单测即可覆盖全部格式与边界，不需要造真文件。
 */
import { TEXT_EXTS } from './knowledge-pack.mjs'

/** 模态常量（避免裸字符串散落各处写错）。 */
export const MODAL = Object.freeze({ A: 'L-A', B: 'L-B', C: 'L-C', D: 'L-D' })

/** L-A 的结构化部分：有稳定寻址单元（段落/块、行/列）且可回写（S1 的 ops 契约）。 */
export const STRUCTURED_EXTS = new Set(['.docx', '.xlsx'])

/**
 * L-A 的**代码/样式**文本部分。
 *
 * 为什么要单独一份：总设计 L-A 行写的是"文本/md/**代码**（`TEXT_EXTS`）"，但 `TEXT_EXTS`
 * （`shared/knowledge-pack.mjs:54`）是**知识导入**的口径，只含 `.md/.markdown/.txt/.csv/.json/
 * .yaml/.yml/.svg` —— 不含代码。实测发现若只认 `TEXT_EXTS`，`code.ts` 会掉进"未知扩展名 ⇒ L-D"，
 * 于是"改一行代码"要走检出式独占，与总设计意图（可原地写、可合并）相反。
 * 故 L-A 的文本类 = `TEXT_EXTS` **∪** 本集合：前者保持既有导入口径不变，后者补上代码与样式表。
 */
export const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.sh', '.ps1', '.bat', '.sql',
  '.css', '.scss', '.less', '.vue', '.svelte',
])

/**
 * L-C：可转换、但**当前格式**不能原地写。
 * `.doc→.docx` 依赖 win32com（Word COM）；`.xls→.xlsx` 依赖 xlrd(+openpyxl)。
 * `.html/.eml` 走"提取"而不是"转换"（无对应 ops 目标格式），但同属"需要先加工"这一层。
 */
export const CONVERT_TARGETS = new Map([
  ['.doc', '.docx'],
  ['.xls', '.xlsx'],
])

/** 需要"提取"而非"转换"的（能读懂内容，但没有可回写的结构化目标）。 */
export const EXTRACT_EXTS = new Set(['.html', '.htm', '.eml'])

/**
 * L-B：能读、有内容，但**没有稳定寻址单元或不可回写** ⇒ 只追加版本。
 * 含 pdf 与图片。
 *
 * 记档（归属说明）：总设计 L-B 行还举了 `.doc`（win32com 读）、`.xls`（xlrd 读）作"能读不能写"的
 * 例子，而 L-C 行又把 `doc→docx`、`xls→xlsx` 列为"经转换归入 L-A"。两者不矛盾但归属必须唯一：
 * 这里把 `.doc/.xls` 判为 **L-C**（它们有明确的转换目标，先转换再协同比"只追加版本"更有用），
 * 其"不可原地写"的事实由 L-C 分支保证（`writesInPlace:false`，仅在转换产物上协同）。
 * 注意 `.svg` **不在此处**：它在 `TEXT_EXTS` 里（文本类，可原地写），归 L-A。
 */
export const READONLY_EXTS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic',
])

/** L-D：无稳定寻址单元且不可转换 ⇒ 检出式独占（同一时刻仅一人可改）。 */
export const EXCLUSIVE_EXTS = new Set([
  '.pptx', '.ppt', '.psd', '.ai', '.sketch', '.dwg', '.dxf', '.zip', '.rar', '.7z', '.tar', '.gz',
  '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.flac',
])

/** 取小写扩展名（含点）；无扩展名返回 ''。 */
export function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i).toLowerCase()
}

/**
 * 模态判定（只看"当前格式"本身，不含转换能力）。
 *
 * 记档（与总设计 L-C 代表格式的差异）：总设计把 `CSV/HTML` 并列写在 L-C 行。这里 **CSV 归 L-A**，
 * 理由是仓库既有口径已经把 `.csv` 放进 `TEXT_EXTS`（`shared/knowledge-pack.mjs:54`，内容哈希前
 * 做行尾归一），即既有实现按"可原地写的文本"对待它；S4 若判成 L-C 会与既有行为冲突，
 * 出现"同一文件两套判据"。CSV 的"转换"诉求（转成结构化表格）由提取链路承担，不影响可写性判定。
 */
export function classifyModal(fileName) {
  const ext = extOf(fileName)
  if (STRUCTURED_EXTS.has(ext)) return MODAL.A
  if (TEXT_EXTS.has(ext)) return MODAL.A
  if (CODE_EXTS.has(ext)) return MODAL.A
  if (EXCLUSIVE_EXTS.has(ext)) return MODAL.D
  if (CONVERT_TARGETS.has(ext)) return MODAL.C
  if (EXTRACT_EXTS.has(ext)) return MODAL.C
  if (READONLY_EXTS.has(ext)) return MODAL.B
  // 未知扩展名：保守起见按"不可解析"处理（宁可走独占也不要猜它能合并）
  return MODAL.D
}

/** 原始格式本身能否原地写（不经转换）。 */
export function canWriteInPlace(fileName) {
  return classifyModal(fileName) === MODAL.A
}

/** 该文件是否有可用的升级目标格式（L-C 的"转换"路径）。 */
export function upgradeTarget(fileName) {
  return CONVERT_TARGETS.get(extOf(fileName)) || null
}

/**
 * 三层兜底的决策结果。
 * @param {string} fileName
 * @param {{convert?: string[]|null, extract?: boolean}} caps 能力探测结果
 *   convert：**可用**的转换能力（扩展名数组，如 `['.xls']` —— 本机实测 `.doc` 因缺 win32com 不可用）；
 *   extract：提取链路是否可用（OCR/导入）。
 * @returns {{modal:string, baseModal:string, path:'direct'|'convert'|'extract'|'downgrade',
 *            effectiveName:string, upgradeTo:string|null, writesInPlace:boolean, reason:string}}
 */
export function planFallback(fileName, caps = {}) {
  const baseModal = classifyModal(fileName)
  const ext = extOf(fileName)
  const convertible = upgradeTarget(fileName)
  const convertOk = Array.isArray(caps.convert) ? caps.convert.includes(ext) : false

  if (baseModal === MODAL.A) {
    return {
      modal: MODAL.A, baseModal, path: 'direct', effectiveName: fileName,
      upgradeTo: null, writesInPlace: true,
      reason: '有稳定寻址单元且可回写 ⇒ 直接按 L-A 合并（S1 的 ops 契约）',
    }
  }

  if (convertible && convertOk) {
    // 转换后**在产物上**协同：产物是 docx/xlsx（L-A），原文件只作为"来源版本"
    const target = fileName.slice(0, fileName.length - ext.length) + convertible
    return {
      modal: MODAL.A, baseModal, path: 'convert', effectiveName: target,
      upgradeTo: convertible, writesInPlace: true,
      reason: `经 ${ext}→${convertible} 转换升入 L-A（转换器：doc_toolkit.py convert，不重实现）`,
    }
  }

  if ((EXTRACT_EXTS.has(ext) || READONLY_EXTS.has(ext) || convertible) && caps.extract) {
    return {
      modal: MODAL.B, baseModal, path: 'extract', effectiveName: fileName,
      upgradeTo: convertible, writesInPlace: false,
      reason: '不可原地写但内容可读 ⇒ 提取为结构化知识（引用锚定版本 id），文件本身只追加版本',
    }
  }

  return {
    modal: MODAL.D, baseModal,
    path: baseModal === MODAL.D ? 'downgrade' : 'downgrade',
    effectiveName: fileName, upgradeTo: convertible, writesInPlace: false,
    reason: '既不可转换也不可提取 ⇒ 降级为 L-D 检出式独占（避免产生"看似可合并"的假象）',
  }
}

// ---------------------------------------------------------------------------
// 目录策略（批注 #3 裁定：**全局默认关闭 + 按目录开启**）
// ---------------------------------------------------------------------------

/**
 * 策略默认值。
 *
 * 批注 #3 裁定"全局默认关闭 + 按目录开启" ⇒ `softClaim` 默认 **false**：
 * 未显式开启的目录**不产生任何占用记录**、不打断任何编辑。
 * 这一条是可测的行为契约（测试断言：默认下占用日志目录为空）。
 */
export const DEFAULT_DIR_POLICY = Object.freeze({
  softClaim: false,        // 软占用总开关（默认关）
  occupancy: 'advisory',   // 'advisory'（只提示）| 'exclusive'（L-D 检出式互斥）
  maxFileBytes: null,      // 批注 #8 未定 ⇒ 只度量、可配、不阻断
  extract: false,          // 提取链路是否可用（由调用方探测后覆盖）
  convert: null,           // 可用转换能力（同上）
})

/** 归一化目录策略：缺字段取默认，显式值优先。 */
export function parseDirPolicy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULT_DIR_POLICY }
  if (typeof p.softClaim === 'boolean') out.softClaim = p.softClaim
  if (p.occupancy === 'advisory' || p.occupancy === 'exclusive') out.occupancy = p.occupancy
  if (Number.isFinite(p.maxFileBytes)) out.maxFileBytes = p.maxFileBytes
  if (typeof p.extract === 'boolean') out.extract = p.extract
  if (Array.isArray(p.convert)) out.convert = p.convert
  return out
}

/**
 * 该文件是否应启用占用/检出（占用的前置判定）。
 * 默认关闭时**一律 false** —— 即便文件是 L-D。
 */
export function claimEnabled(modal, policy) {
  if (!policy || !policy.softClaim) return false
  if (modal === MODAL.D) return true
  return policy.occupancy === 'exclusive'
}

/** 体积度量（批注 #8 未定 ⇒ 只报告，不阻断）。 */
export function measureSize(bytes, policy) {
  const limit = policy && Number.isFinite(policy.maxFileBytes) ? policy.maxFileBytes : null
  return { bytes, limit, overLimit: limit !== null && bytes > limit }
}

// ---------------------------------------------------------------------------
// 占用 / 检出（append-only 日志 → 当前状态）
// ---------------------------------------------------------------------------

/**
 * 把 append-only 的占用日志折叠成"当前状态"。
 *
 * 为什么用日志而不是一份可覆盖的 JSON：多人/多次写同一份状态文件会互相覆盖（正是 S1/S3
 * 反复处理的"丢失更新"）。日志只追加 ⇒ 天然无覆盖；折叠规则集中在这里，可单测。
 */
export function foldClaims(records, now = Date.now()) {
  let state = null
  for (const r of records || []) {
    if (!r || typeof r !== 'object') continue
    if (r.type === 'claim') {
      state = { holder: r.holder, deviceId: r.deviceId || null, at: r.at, leaseMs: r.leaseMs ?? null, note: r.note || null, versionId: r.versionId || null }
    } else if (r.type === 'heartbeat') {
      if (state && state.holder === r.holder) { state.at = r.at; state.leaseMs = r.leaseMs ?? state.leaseMs }
    } else if (r.type === 'release') {
      if (state && state.holder === r.holder) state = null
    } else if (r.type === 'takeover') {
      state = { holder: r.to, deviceId: r.deviceId || null, at: r.at, leaseMs: r.leaseMs ?? null, note: r.note || null, takenFrom: r.from, versionId: r.versionId || null }
    }
  }
  if (!state) return { state: 'free', holder: null, expiresAt: null, remainingMs: 0 }
  if (state.leaseMs == null) return { state: 'held', holder: state.holder, expiresAt: null, remainingMs: Infinity, record: state }
  const expiresAt = state.at + state.leaseMs
  if (now >= expiresAt) return { state: 'expired', holder: state.holder, expiresAt, remainingMs: 0, record: state }
  return { state: 'held', holder: state.holder, expiresAt, remainingMs: expiresAt - now, record: state }
}

/**
 * 能否检出（L-D 的核心语义）。
 * @returns {{ok:boolean, reason:string, holder?:string|null, remainingMs?:number, canTakeover?:boolean}}
 */
export function canCheckout({ claims, requesterId, now = Date.now(), policy }) {
  const cur = foldClaims(claims, now)
  if (cur.state === 'free') return { ok: true, reason: 'free' }
  if (cur.holder === requesterId) return { ok: true, reason: 'already-held' }
  if (cur.state === 'expired') {
    // 过期 ⇒ 允许接管，但**必须留痕**（takeover 记录），否则"谁抢了谁的"无从追溯
    return { ok: true, reason: 'takeover-expired', holder: cur.holder, canTakeover: true }
  }
  return { ok: false, reason: 'held-by-other', holder: cur.holder, remainingMs: cur.remainingMs }
}

/** 只读判定（#9：占用他人时"你目前只读"）。默认关闭占用的目录里永远可写。 */
export function isReadonlyFor({ modal, claims, requesterId, now = Date.now(), policy }) {
  if (!claimEnabled(modal, policy)) return { readonly: false, reason: 'claims-disabled' }
  const cur = foldClaims(claims, now)
  if (cur.state === 'held' && cur.holder !== requesterId) {
    return { readonly: true, reason: 'held-by-other', holder: cur.holder, remainingMs: cur.remainingMs }
  }
  return { readonly: false, reason: cur.state }
}

/** 检入许可（未检出者不得检入 —— 否则等于绕过独占）。 */
export function canCheckin({ claims, requesterId, now = Date.now() }) {
  const cur = foldClaims(claims, now)
  if (cur.state === 'free') return { ok: false, reason: 'not-checked-out' }
  if (cur.holder !== requesterId) return { ok: false, reason: 'held-by-other', holder: cur.holder }
  return { ok: true, reason: cur.state === 'expired' ? 'expired-but-holder' : 'held' }
}

// ---------------------------------------------------------------------------
// 冲突处置（总设计 §5.4 的四选一）
// ---------------------------------------------------------------------------

export const CONFLICT_CHOICES = Object.freeze(['use-theirs', 'use-mine', 'save-copy', 'edit-merge'])

/**
 * 四选一的决策。
 *
 * 关键一条：`save-copy` 的结果**降级为草稿**（总设计 §5.4 定案）—— 不产生"同目录多份近似文件"
 * （那会让"哪份是正本"永久模糊，也是仓库既有的定案 3 想避免的形态）。
 * 本函数只产出**决策**，落盘由调用方走 S1 的 ops 契约 / 草稿写入。
 */
export function planConflict({ choice, base, mine, theirs }) {
  if (!CONFLICT_CHOICES.includes(choice)) {
    return { ok: false, reason: `未知处置方式：${choice}`, choices: [...CONFLICT_CHOICES] }
  }
  switch (choice) {
    case 'use-theirs':
      return { ok: true, action: 'write', source: 'theirs', content: theirs, note: '接受对方版本（我的改动放弃）' }
    case 'use-mine':
      return { ok: true, action: 'write', source: 'mine', content: mine, note: '保留我的版本（对方改动放弃）' }
    case 'save-copy':
      return {
        ok: true, action: 'save-draft', source: 'mine', content: mine,
        note: '我的改动另存为**草稿**（不进主干、不产生同目录近似文件），正本留给对方/人工处置',
      }
    case 'edit-merge':
      return {
        ok: true, action: 'merge-then-write', source: 'merge', content: null,
        note: '交给 S1 的三路合并（base/mine/theirs）逐块处理后落盘；仍冲突的块需人工选择',
      }
    default:
      return { ok: false, reason: 'unreachable' }
  }
}
