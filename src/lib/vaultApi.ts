// src/lib/vaultApi.ts —— 密码库渲染层数据层
//
// spec：docs/superpowers/specs/2026-09-15-password-vault-design.md
//
// 纪律（D9）：逻辑落 `.ts`，`.tsx` 只做展示——`.tsx` 不能被 `node --test` import，
// 把校验/分类逻辑写进组件就等于没有单测。
//
// 三条都在这里收口：
//   ① 桌面端可用性：浏览器 dev 下 `window.yfworkingVault` 不存在 → 明确告知，而不是抛异常；
//   ② **不信任 bridge 返回值**：IPC 对面可能返回缺字段/类型不对的对象（版本不匹配、旧产物），
//      一律走 normalize 后再交给 UI，避免"看着像空库其实是坏数据"；
//   ③ 失败分类：unavailable（环境）与 corrupt（文件）是两种故障，文案与后续动作不同，
//      且**都不得渲染成"库是空的"**——那会诱导用户以为密码丢了、进而重新录入甚至覆盖。
import type {
  VaultEntryMeta,
  VaultErrorCode,
  VaultFailure,
  VaultListResult,
  VaultStatus,
  VaultUpsertInput,
  YFWVaultAPI,
} from '@/types'

/** 取密码库 bridge；浏览器 dev / 旧产物下为 null */
export function getVaultApi(): YFWVaultAPI | null {
  if (typeof window === 'undefined') return null
  return window.yfworkingVault ?? null
}

export function isVaultAvailable(): boolean {
  return getVaultApi() !== null
}

/** 错误码 → 用户可读文案。
 * 措辞刻意区分"环境问题（可修可等）"与"文件问题（需人工介入）"，
 * 并统一声明"原文件已保留"——这是用户最需要立刻知道的一件事。 */
export function describeVaultError(code: VaultErrorCode | undefined, message?: string): string {
  switch (code) {
    case 'unavailable':
      return message || '系统安全存储当前不可用，密码库暂时无法读写（不会以明文保存）'
    case 'corrupt':
      return message || '密码库文件读不出来（可能被改动或换了系统账户）；原文件已保留未改动'
    case 'not_found':
      return '条目不存在（可能已在其它窗口删除）'
    case 'invalid':
      return message || '输入不合法'
    case 'io':
      return message || '写入失败，原文件未改动'
    default:
      return message || '密码库操作失败'
  }
}

/** 无 bridge 时的统一失败结果（不是空库！） */
function noHost<T extends { ok: false; error: VaultErrorCode; message?: string }>(): T {
  return { ok: false, error: 'unavailable', message: '当前环境不支持密码库（仅桌面端可用）' } as T
}

/** 无 bridge 的**列表**结果：必须带 entries: [] ——
 * 只给 {ok:false} 会让 `list.entries.map(...)` 直接崩（UI 的失败态也常常要渲染列表壳） */
function noHostList(): VaultListResult {
  return { ok: false, entries: [], error: 'unavailable', message: '当前环境不支持密码库（仅桌面端可用）' }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 条目归一：字段缺失/类型不对一律填安全默认值，绝不放行 undefined 进渲染 */
function normalizeEntry(raw: unknown): VaultEntryMeta | null {
  if (!isObj(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!id || !name) return null
  return {
    id,
    name,
    url: typeof raw.url === 'string' ? raw.url : '',
    username: typeof raw.username === 'string' ? raw.username : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

/** 列表响应归一：ok:true 但形状不对 ⇒ 归为 corrupt（宁可报坏，也不假装空库） */
export function normalizeListResult(raw: unknown): VaultListResult {
  if (!isObj(raw)) return { ok: false, entries: [], error: 'corrupt', message: '密码库返回了无法识别的数据' }
  if (raw.ok !== true) {
    return {
      ok: false,
      entries: [],
      error: (raw.error as VaultErrorCode) || 'corrupt',
      message: typeof raw.message === 'string' ? raw.message : undefined,
    }
  }
  if (!Array.isArray(raw.entries)) {
    return { ok: false, entries: [], error: 'corrupt', message: '密码库返回的条目列表格式不正确' }
  }
  return { ok: true, entries: raw.entries.map(normalizeEntry).filter((e): e is VaultEntryMeta => e !== null) }
}

export function normalizeStatus(raw: unknown): VaultStatus {
  if (!isObj(raw)) return { ok: false, available: false, count: 0, error: 'corrupt', message: '密码库状态无法识别' }
  return {
    ok: raw.ok === true,
    available: raw.available === true,
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : 0,
    error: typeof raw.error === 'string' ? (raw.error as VaultErrorCode) : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  }
}

/** 读列表（含可用性），把"没有 bridge"也收成结构化失败，UI 无需 try/catch 分支 */
export async function loadVault(): Promise<{ status: VaultStatus; list: VaultListResult }> {
  const api = getVaultApi()
  if (!api) {
    return { status: { ok: false, available: false, count: 0, error: 'unavailable', message: '当前环境不支持密码库（仅桌面端可用）' }, list: noHostList() }
  }
  let status: VaultStatus
  let list: VaultListResult
  try {
    status = normalizeStatus(await api.status())
  } catch (e) {
    status = { ok: false, available: false, count: 0, error: 'io', message: (e as Error)?.message }
  }
  try {
    list = normalizeListResult(await api.list())
  } catch (e) {
    list = { ok: false, entries: [], error: 'io', message: (e as Error)?.message }
  }
  return { status, list }
}

export async function saveVaultEntry(input: VaultUpsertInput): Promise<{ ok: true; entry: VaultEntryMeta } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  const invalid = validateEntryInput(input)
  if (invalid) return { ok: false, error: 'invalid', message: invalid }
  try {
    const raw = await api.upsert(input)
    if (!isObj(raw) || raw.ok !== true) {
      return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
    }
    const entry = normalizeEntry((raw as { entry?: unknown }).entry)
    if (!entry) return { ok: false, error: 'corrupt', message: '保存成功但返回的条目无法识别，请重新打开密码库确认' }
    return { ok: true, entry }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}

export async function removeVaultEntry(id: string): Promise<{ ok: true } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  try {
    const raw = await api.remove(id)
    if (isObj(raw) && raw.ok === true) return { ok: true }
    return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}

export async function revealVaultEntry(id: string): Promise<{ ok: true; password: string } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  try {
    const raw = await api.reveal(id)
    if (isObj(raw) && raw.ok === true && typeof raw.password === 'string') return { ok: true, password: raw.password }
    return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}

export async function copyVaultEntry(id: string): Promise<{ ok: true; clearInMs: number } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  try {
    const raw = await api.copy(id)
    if (isObj(raw) && raw.ok === true) {
      return { ok: true, clearInMs: typeof raw.clearInMs === 'number' ? raw.clearInMs : 0 }
    }
    return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}

/** 入参校验，返回错误文案；通过返回 null。
 * 更新时 password 缺省 = 保持原密码（与主进程语义一致，见 vault.cjs upsert），
 * 所以只有**新增**才强制要求密码。 */
export function validateEntryInput(input: VaultUpsertInput): string | null {
  if (!input || typeof input.name !== 'string' || !input.name.trim()) return '名称不能为空'
  if (!input.id) {
    if (typeof input.password !== 'string' || input.password === '') return '新增条目必须填写密码'
  }
  if (input.url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input.url.trim()) && !input.url.includes('.')) {
    return '地址看起来不正确（可留空）'
  }
  return null
}

/** 搜索：名称/用户名/地址/标签/备注 全字段模糊匹配（空查询返回全部） */
export function filterEntries(entries: VaultEntryMeta[], query: string): VaultEntryMeta[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter(e =>
    [e.name, e.username, e.url, e.notes, ...e.tags].some(f => (f || '').toLowerCase().includes(q)),
  )
}

/** 排序：名称升序（中文走 localeCompare，避免按码位乱序） */
export function sortEntries(entries: VaultEntryMeta[]): VaultEntryMeta[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

// ---------------- 应用密钥（secrets） ----------------
// 用途：模型供应商 authToken、历史遗留 apiKey —— 它们此前以明文躺在 localStorage
// （以及 bridge 的 config.json）。这里把它们交给同一个加密库，与用户密码条目分区存放。
//
// 为什么单独一组函数而不是复用密码条目：密码条目会出现在密码列表 UI 里，
// 把应用密钥混进去，用户就能在界面上看到/删掉自己的模型凭证——那条路径不该存在。

/** 读全部密钥（启动注水用）。失败时 secrets 为空对象且 ok:false —— 调用方**不得**
 *  把"读失败"当成"没有密钥"，否则会用空视图覆盖真实密钥（见 settingsStore 的闸门）。 */
export async function loadAllSecrets(): Promise<{ ok: boolean; secrets: Record<string, string>; error?: VaultErrorCode; message?: string }> {
  const api = getVaultApi()
  if (!api) return { ok: false, secrets: {}, error: 'unavailable', message: '当前环境不支持密码库（仅桌面端可用）' }
  try {
    const raw = await api.secretGetAll()
    if (!isObj(raw) || raw.ok !== true) {
      return {
        ok: false,
        secrets: {},
        error: ((raw as { error?: VaultErrorCode })?.error) || 'corrupt',
        message: (raw as { message?: string })?.message,
      }
    }
    // 只放行"键值都是字符串"的项：脏数据不得进入设置状态
    const secrets: Record<string, string> = {}
    if (isObj(raw.secrets)) {
      for (const [k, v] of Object.entries(raw.secrets)) {
        if (typeof v === 'string') secrets[k] = v
      }
    }
    return { ok: true, secrets }
  } catch (e) {
    return { ok: false, secrets: {}, error: 'io', message: (e as Error)?.message }
  }
}

/** 只读键名（UI 判断"配没配"，不必把值捞出来） */
export async function loadSecretKeys(): Promise<{ ok: boolean; keys: string[]; error?: VaultErrorCode; message?: string }> {
  const api = getVaultApi()
  if (!api) return { ok: false, keys: [], error: 'unavailable', message: '当前环境不支持密码库（仅桌面端可用）' }
  try {
    const raw = await api.secretKeys()
    if (!isObj(raw) || raw.ok !== true) {
      return { ok: false, keys: [], error: ((raw as { error?: VaultErrorCode })?.error) || 'corrupt', message: (raw as { message?: string })?.message }
    }
    return { ok: true, keys: Array.isArray(raw.keys) ? raw.keys.filter((k): k is string => typeof k === 'string') : [] }
  } catch (e) {
    return { ok: false, keys: [], error: 'io', message: (e as Error)?.message }
  }
}

/** 写密钥；value 传 '' 等价删除 */
export async function saveSecret(key: string, value: string): Promise<{ ok: true } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  if (!key) return { ok: false, error: 'invalid', message: '密钥名不能为空' }
  try {
    const raw = await api.secretSet(key, value)
    if (isObj(raw) && raw.ok === true) return { ok: true }
    return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}

export async function deleteSecret(key: string): Promise<{ ok: true } | VaultFailure> {
  const api = getVaultApi()
  if (!api) return noHost<VaultFailure>()
  if (!key) return { ok: false, error: 'invalid', message: '密钥名不能为空' }
  try {
    const raw = await api.secretDelete(key)
    if (isObj(raw) && raw.ok === true) return { ok: true }
    return { ok: false, error: ((raw as { error?: VaultErrorCode })?.error) || 'io', message: (raw as { message?: string })?.message }
  } catch (e) {
    return { ok: false, error: 'io', message: (e as Error)?.message }
  }
}
