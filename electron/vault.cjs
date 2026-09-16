'use strict'
// electron/vault.cjs —— 应用及密码管理库（vault）主进程核心
//
// spec：docs/superpowers/specs/2026-09-15-password-vault-design.md
//
// 为什么全部在这里（主进程）：密文与密钥不进渲染进程（D3）。渲染层只能经 IPC 拿
// 到"已脱敏的列表"或"单条按需取出的明文"。
//
// 为什么加密器是**注入**的（D10）：本模块不 require('electron')——① 非 Electron 进程
// （node --test）里 require 会抛；② 注入后 CRUD/原子写/损坏恢复/不可用分支全部可单测。
// 生产由 main.cjs 传 Electron 的 safeStorage。
//
// 三条不可退让的纪律：
//   · fail-closed（D2）：加密不可用时**拒绝**读写，绝不回退明文落盘。
//   · 损坏不覆盖（D6）：读不出来就报错并原样保留文件——一次误判写成空库 = 用户密码全灭。
//   · 日志不落明文（D8）：本模块**没有任何 console 输出**（有测试断言钉住）。
const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, mkdirSync, statSync } = require('fs')
const { join } = require('path')

/** 信封版本与方案标识。scheme 是未来加"主密码/可移植"方案的迁移位（spec §4） */
const VAULT_VERSION = 1
const SCHEME_OS = 'electron-safe-storage'

/** 错误码（IPC 原样上抛给渲染层做分类提示，不要用自由文本当协议） */
const ERR = {
  UNAVAILABLE: 'unavailable',   // OS 安全存储不可用（Linux 无 keyring 等）→ fail closed
  CORRUPT: 'corrupt',           // 信封/密文/明文结构读不出来
  NOT_FOUND: 'not_found',
  INVALID: 'invalid',           // 入参不合法（空名称等）
  IO: 'io',
}

const FILE_NAME = 'vault.enc'

/** 本模块的协议错误码集合（用于区分"我们的码"与 Node errno） */
const OUR_CODES = new Set(Object.values(ERR))

function vaultPathOf(home) {
  return join(home, FILE_NAME)
}

/** 结构化错误：IPC 里 `ok:false` 的载荷来源；message 只含现场信息，**绝不含字段值** */
function fail(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

/**
 * 创建 vault 实例。
 * @param {object} opts
 * @param {string} opts.home            数据根（resolveYfwHome()）
 * @param {{isAvailable:()=>boolean, encryptString:(s:string)=>Buffer, decryptString:(b:Buffer)=>string}} opts.crypto
 * @param {()=>string} [opts.now]       时间源（测试可注入）
 */
function createVault({ home, crypto, now = () => new Date().toISOString() }) {
  const file = vaultPathOf(home)

  const encryptionAvailable = () => {
    try {
      if (!crypto || !crypto.isAvailable()) return false
      // Linux 上 safeStorage 可能落到 basic_text 后端（硬编码密钥、文件谁拿到谁能解），
      // 此时"加密可用"是个假象。D2 的立场是宁可不可用，也不给"以为加密了"的假安全感——
      // 后者会让用户放心把真密码放进来。仅在该后端被明确报出时才判不可用（老版本 Electron
      // 无此方法时按未知处理，不误伤）。
      if (typeof crypto.getSelectedStorageBackend === 'function'
        && crypto.getSelectedStorageBackend() === 'basic_text') {
        return false
      }
      return true
    } catch { return false }
  }

  /**
   * 文件是否存在。**刻意不用 existsSync**：其语义是"任何错误都返回 false"，
   * 于是 EACCES/EBUSY/网络盘掉线会被读成"库不存在"→ 空库 → 下一次写入用"只含新条目"
   * 的库覆盖原文件，用户的密码就没了。这里只有确凿的 ENOENT 才算不存在，其余一律报错。
   */
  function fileExists(p) {
    try {
      statSync(p)
      return true
    } catch (e) {
      if (e && e.code === 'ENOENT') return false
      throw fail(ERR.IO, '密码库文件无法访问（原文件未改动）')
    }
  }

  /** 读并解密；文件不存在 → 空库（**不**视为错误）。任何读/解密失败 → 抛错且不动文件 */
  function readState() {
    // 空库也要带全形状（含 secrets）：writeState 会拒绝残缺状态，
    // 少了这个键会让"首次写入"直接被拦住（这正是那个防御想抓的错）
    if (!fileExists(file)) return { v: VAULT_VERSION, entries: [], secrets: {} }
    // 先判可用性：加密不可用时文件必然读不出来，报 unavailable（可执行提示）而不是 corrupt（不可执行）
    if (!encryptionAvailable()) {
      throw fail(ERR.UNAVAILABLE, '系统安全存储当前不可用，无法解密密码库；文件已保留未改动')
    }
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      // 读失败（EACCES/EISDIR/EBUSY…）与环境/IO 有关，不是"文件内容坏了"：
      // 归到 io，免得 UI 让用户"别动这个坏文件"，而其实重试或修权限就好
      throw fail(ERR.IO, '密码库文件读取失败；原文件未改动')
    }
    let env
    try {
      env = JSON.parse(raw)
    } catch {
      throw fail(ERR.CORRUPT, '密码库文件无法解析；文件已保留未改动')
    }
    if (!env || typeof env !== 'object' || typeof env.cipher !== 'string') {
      throw fail(ERR.CORRUPT, '密码库文件格式不认识；文件已保留未改动')
    }
    if (env.v !== VAULT_VERSION) {
      // 版本不认识就明确拒绝：照旧格式读写会把高版本库按低版本结构覆盖写回，等于降级毁数据
      throw fail(ERR.CORRUPT, `密码库版本(${String(env.v)})本版本不认识；文件已保留未改动`)
    }
    if (env.scheme !== SCHEME_OS) {
      // 未来方案（master-key-v2 等）在此分派；当前不认识就明确拒绝，不做猜测式降级
      throw fail(ERR.CORRUPT, `密码库使用了本版本不认识的加密方案：${String(env.scheme)}`)
    }
    let plain
    try {
      plain = crypto.decryptString(Buffer.from(env.cipher, 'base64'))
    } catch {
      // 换 OS 账户/换机后 DPAPI 解不开也走这里（spec N4）：这是"解不开"，不是"库是空的"
      throw fail(ERR.CORRUPT, '密码库解密失败（可能换了系统账户或文件被改动）；文件已保留未改动')
    }
    let data
    try {
      data = JSON.parse(plain)
    } catch {
      throw fail(ERR.CORRUPT, '密码库内容无法解析；文件已保留未改动')
    }
    if (!data || !Array.isArray(data.entries)) {
      throw fail(ERR.CORRUPT, '密码库内容结构不认识；文件已保留未改动')
    }
    // 形状不合的条目**必须报错，不能过滤掉**：过滤后 list 仍返回 ok，用户看不出异常，
    // 而下一次 upsert/remove 会把"被截断的库"rename 覆盖上去 —— 那些条目就从磁盘永久消失。
    // 触发条件不需要攻击：跨版本读写的库、手工还原的备份都可能带上本版本不认识的条目。
    const kept = data.entries.filter(isEntryShaped)
    if (kept.length !== data.entries.length) {
      throw fail(ERR.CORRUPT, '密码库内容有本版本无法识别的条目；文件已保留未改动')
    }
    // secrets（2026-09-15）：应用自身的密钥（模型供应商 authToken 等），与"用户的密码条目"
    // 分开存但同库同密文——同一份加密与原子写，少一套密钥生命周期要维护。
    // 老库没有这个键 ⇒ 视为空（向后兼容）；有但形状不对 ⇒ corrupt（同 entries 的纪律）。
    const secrets = data.secrets === undefined ? {} : data.secrets
    if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
      throw fail(ERR.CORRUPT, '密码库密钥区结构不认识；文件已保留未改动')
    }
    for (const v of Object.values(secrets)) {
      if (typeof v !== 'string') throw fail(ERR.CORRUPT, '密码库密钥区含非文本值；文件已保留未改动')
    }
    return { v: VAULT_VERSION, entries: kept, secrets }
  }

  /**
   * 原子写（D5）：临时文件 → 回读校验 → rename。
   * 回读校验是必要的：只写不验时，磁盘满/被拦截的半截文件会在下次读取时被当成"库损坏"，
   * 而对用户来说那等于"密码没了"。
   */
  function writeState(state) {
    // 防御：整库单块写回，任何"只带一半状态"的调用都会把另一半（密码或密钥）从磁盘抹掉。
    // 与其靠每个调用点记得传全，不如在这里拒绝残缺状态 —— 忘传就报错，绝不静默丢数据。
    if (!state || !Array.isArray(state.entries)
      || typeof state.secrets !== 'object' || state.secrets === null || Array.isArray(state.secrets)) {
      throw fail(ERR.IO, '内部状态不完整，已放弃写入（原文件未改动）')
    }
    if (!encryptionAvailable()) {
      throw fail(ERR.UNAVAILABLE, '系统安全存储不可用，拒绝写入（不会以明文保存）')
    }
    const payload = JSON.stringify({ entries: state.entries, secrets: state.secrets })
    let cipher
    try {
      // 统一按字节处理：Electron safeStorage 返回 Buffer，注入的测试实现可能返回字符串
      const raw = crypto.encryptString(payload)
      cipher = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw)
    } catch {
      throw fail(ERR.UNAVAILABLE, '加密失败，已放弃写入（不会以明文保存）')
    }
    if (cipher.length === 0) {
      // 空密文会被当成"写入成功"，把好库换成一个解不开的坏库（下次读取直接 corrupt）
      throw fail(ERR.IO, '加密结果为空，已放弃写入（原文件未改动）')
    }
    // 语义级回读：不只看"文件文本写对没有"，还要确认写下去的密文真能解回原文。
    // 加密器是可注入的（spec §4 预留了 master-key-v2 之类），"能加密但解不回"必须在这里拦。
    try {
      if (crypto.decryptString(cipher) !== payload) throw fail(ERR.IO, '加密结果无法解回，已放弃写入（原文件未改动）')
    } catch (e) {
      if (e && OUR_CODES.has(e.code)) throw e
      throw fail(ERR.IO, '加密结果无法解回，已放弃写入（原文件未改动）')
    }
    const env = {
      v: VAULT_VERSION,
      scheme: SCHEME_OS,
      updatedAt: now(),
      cipher: cipher.toString('base64'),
    }
    const text = JSON.stringify(env, null, 2)
    const tmp = file + '.tmp'
    try {
      // home 由应用启动流程保证存在；此处仍兜底建目录——直接拿 ENOENT 当"写入失败"
      // 会把"环境没就绪"误报成"密码库坏了"，用户无从下手
      mkdirSync(home, { recursive: true })
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      if (readFileSync(tmp, 'utf8') !== text) throw fail(ERR.IO, '写入校验失败，已放弃（原文件未改动）')
      renameSync(tmp, file)
      try { chmodSync(file, 0o600) } catch { /* Windows 上多为 no-op；失败不影响机密性 */ }
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理失败不掩盖主错误 */ }
      // 只把本模块的协议码原样上抛；Node 的 errno（ENOSPC/EACCES…）归一到 io，
      // 免得 errno 字符串混进 IPC 协议码、渲染层分类失效
      if (e && OUR_CODES.has(e.code)) throw e
      throw fail(ERR.IO, '密码库写入失败（原文件未改动）')
    }
    return state.entries
  }

  // ---------------- 应用密钥（secrets） ----------------
  // 用途：存应用自身的凭证（模型供应商 authToken、历史遗留的 apiKey），使其不再以明文
  // 落在 localStorage / 配置文件里。与用户密码条目**分区存放**：密码 UI 永不会列出它们，
  // 也就不存在"误删/误展示应用密钥"的路径。

  /** 只回键名，不回值：UI 想知道"配没配"时用它（值本身没必要离开主进程） */
  function listSecretKeys() {
    try {
      return { ok: true, keys: Object.keys(readState().secrets) }
    } catch (e) {
      return { ok: false, keys: [], error: e.code || ERR.CORRUPT, message: e.message }
    }
  }

  /** 取全部键值（启动时一次性注水用）。调用方是渲染层宿主，故与现状曝光面相同 */
  function getSecrets() {
    try {
      return { ok: true, secrets: { ...readState().secrets } }
    } catch (e) {
      return { ok: false, secrets: {}, error: e.code || ERR.CORRUPT, message: e.message }
    }
  }

  function getSecret(key) {
    const k = typeof key === 'string' ? key : ''
    if (!k) return { ok: false, error: ERR.INVALID, message: '密钥名不能为空' }
    try {
      const secrets = readState().secrets
      if (!(k in secrets)) return { ok: false, error: ERR.NOT_FOUND, message: '未配置该密钥' }
      return { ok: true, value: secrets[k] }
    } catch (e) {
      return { ok: false, error: e.code || ERR.CORRUPT, message: e.message }
    }
  }

  /** 写密钥。value 为 '' ⇒ 等价删除（调用方不必区分"清空"与"删除"） */
  function setSecret(key, value) {
    const k = typeof key === 'string' ? key.trim() : ''
    if (!k) return { ok: false, error: ERR.INVALID, message: '密钥名不能为空' }
    if (typeof value !== 'string') return { ok: false, error: ERR.INVALID, message: '密钥值必须是文本' }
    let st
    try { st = readState() } catch (e) {
      return { ok: false, error: e.code || ERR.CORRUPT, message: e.message }
    }
    const secrets = { ...st.secrets }
    if (value === '') delete secrets[k]
    else secrets[k] = value
    try { writeState({ entries: st.entries, secrets }) } catch (e) {
      return { ok: false, error: e.code || ERR.IO, message: e.message }
    }
    return { ok: true }
  }

  function deleteSecret(key) {
    return setSecret(key, '')
  }

  /** 出站脱敏：password 永不出现在 list 结果里（A5） */
  function publicEntry(e) {
    return {
      id: e.id, name: e.name, url: e.url, username: e.username,
      notes: e.notes, tags: e.tags, createdAt: e.createdAt, updatedAt: e.updatedAt,
    }
  }

  function status() {
    try {
      const st = readState()
      return { ok: true, available: encryptionAvailable(), count: st.entries.length }
    } catch (e) {
      // 读不出来也要报可用性：UI 需要区分"系统不支持"与"文件坏了"
      return { ok: false, available: encryptionAvailable(), count: 0, error: e.code || ERR.CORRUPT, message: e.message }
    }
  }

  function list() {
    try {
      return { ok: true, entries: readState().entries.map(publicEntry) }
    } catch (e) {
      return { ok: false, entries: [], error: e.code || ERR.CORRUPT, message: e.message }
    }
  }

  /**
   * 新增/更新。
   * password 语义（避免"改个备注要重打密码"，也避免静默清空）：
   *   · 新增：必填（空字符串视为未填 → invalid）
   *   · 更新：**缺省/undefined = 保持原密码**；显式 '' = 清空
   */
  function upsert(input) {
    const inId = typeof input?.id === 'string' && input.id ? input.id : null
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (!name) return { ok: false, error: ERR.INVALID, message: '名称不能为空' }

    let st
    try { st = readState() } catch (e) {
      return { ok: false, error: e.code || ERR.CORRUPT, message: e.message }   // 不清空、不重建
    }
    const entries = st.entries.slice()
    const ts = now()
    const idx = inId ? entries.findIndex(e => e.id === inId) : -1

    if (inId && idx < 0) {
      // 显式带 id 却找不到：报错而不是"悄悄新建"——后者会造成重复条目，用户以为改成功了
      return { ok: false, error: ERR.NOT_FOUND, message: '要更新的条目不存在' }
    }

    const keep = idx >= 0 ? entries[idx] : null
    const pw = input?.password
    let password
    if (pw === undefined || pw === null) {
      // 未提供 ⇒ 更新时保持原密码（避免"改个备注要重打密码"）；新增时下面按空值拦下
      password = keep ? (keep.password ?? '') : ''
    } else if (typeof pw === 'string') {
      password = pw
    } else {
      // 不接受数字/对象等：String(null) 会变成字面量 "null" 存进库，
      // 用户以为"没填密码被拦住"，实际存了个假密码，事后无从解释（登录失败且查不出原因）
      return { ok: false, error: ERR.INVALID, message: '密码必须是文本' }
    }
    if (idx < 0 && !password) return { ok: false, error: ERR.INVALID, message: '密码不能为空' }

    const next = {
      id: keep ? keep.id : (globalThis.crypto?.randomUUID?.() || `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      name,
      url: typeof input?.url === 'string' ? input.url.trim() : (keep?.url || ''),
      username: typeof input?.username === 'string' ? input.username : (keep?.username || ''),
      password,
      notes: typeof input?.notes === 'string' ? input.notes : (keep?.notes || ''),
      tags: Array.isArray(input?.tags) ? input.tags.filter(t => typeof t === 'string') : (keep?.tags || []),
      createdAt: keep ? keep.createdAt : ts,
      updatedAt: ts,
    }
    if (idx >= 0) entries[idx] = next; else entries.push(next)

    // 必须带上 st.secrets：否则改一条密码就会把应用密钥（模型 authToken 等）从库里抹掉
    try { writeState({ entries, secrets: st.secrets }) } catch (e) {
      return { ok: false, error: e.code || ERR.IO, message: e.message }
    }
    return { ok: true, entry: publicEntry(next) }
  }

  function remove(id) {
    let st
    try { st = readState() } catch (e) {
      return { ok: false, error: e.code || ERR.CORRUPT, message: e.message }
    }
    const rest = st.entries.filter(e => e.id !== id)
    if (rest.length === st.entries.length) {
      return { ok: false, error: ERR.NOT_FOUND, message: '条目不存在' }
    }
    try { writeState({ entries: rest, secrets: st.secrets }) } catch (e) {
      return { ok: false, error: e.code || ERR.IO, message: e.message }
    }
    return { ok: true }
  }

  /** 单条取明文（§5：泄漏面随需求放大，而非默认放大） */
  function reveal(id) {
    let st
    try { st = readState() } catch (e) {
      return { ok: false, error: e.code || ERR.CORRUPT, message: e.message }
    }
    const e = st.entries.find(x => x.id === id)
    if (!e) return { ok: false, error: ERR.NOT_FOUND, message: '条目不存在' }
    return { ok: true, password: e.password }
  }

  return { status, list, upsert, remove, reveal, filePath: file,
    listSecretKeys, getSecrets, getSecret, setSecret, deleteSecret }
}

/** 条目形状最小校验：脏数据不应让整个库不可用（过滤而非抛错） */
function isEntryShaped(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string'
}

module.exports = { createVault, vaultPathOf, VAULT_VERSION, SCHEME_OS, ERR }
