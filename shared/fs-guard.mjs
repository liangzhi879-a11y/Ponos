/**
 * 路径闸门（单一真源）——桥文件端点与内核共用。
 *
 * 设计依据：docs/superpowers/specs/2026-09-17-bridge-fs-hardening-and-arch-cleanup-design.md §2 D1
 *
 * 为什么需要它：原实现 `resolve(path)` 只做"相对转绝对"，没有任何"是否在允许根内"
 * 的判断（server/bridge.mjs 的 /list-dir /read-file /raw-file /write-file /convert-office），
 * 持令牌方可任意读写本机文件；写能力 = 持久化 RCE 入口（覆盖 preload/启动项/shell 配置）。
 *
 * 级别语义（env `YFW_FS_GUARD`，用于灰度与单开关回滚）：
 *   - `off`     ：完全不校验（应急回滚用）
 *   - `warn`    ：越界只告警不拦（**读侧默认**——S1 实测 /list-dir 的合法需求是"任意目录"，
 *                 /read-file 还要读 ~/.yfworking 下的知识库文档，强拦会直接打坏功能）
 *   - `enforce` ：越界抛错（**写侧默认**——S1 实测 /write-file 全仓仅 1 个调用点，误伤面最小）
 *
 * 未设置 env 时的默认：写 = enforce，读 = warn。
 * 注意 denyRoots（写的硬闸门，如 ~/.yfw）在 warn 级别下**仍然拦**——它挡的是凭据目录，
 * 且 S5 已证应用自身不经桥端点读写该目录，零误伤。
 */

import { realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute, extname } from 'node:path'

/** 带 code/status 的闸门错误；status 直接用作 HTTP 状态码 */
export class FSGuardError extends Error {
  constructor(code, message, status = 403) {
    super(message)
    this.name = 'FSGuardError'
    this.code = code
    this.status = status
  }
}

/**
 * 解析当前生效的级别。
 * @param {boolean} write 是否为写操作（决定未设置 env 时的默认级别）
 */
export function effectiveGuardMode(write) {
  const v = String(process.env.YFW_FS_GUARD ?? '').toLowerCase()
  if (v === 'off' || v === 'warn' || v === 'enforce') return v
  return write ? 'enforce' : 'warn'
}

/** 入参基本校验：非空字符串、拒绝 NUL 与控制字符 */
function assertInput(input) {
  if (typeof input !== 'string' || input === '') {
    throw new FSGuardError('EBADARG', 'path required', 400)
  }
  // 控制字符（含 NUL）可被用于截断路径、绕过扩展名判定等，一律拒
  if (/[\u0000-\u001f]/.test(input)) {
    throw new FSGuardError('EBADARG', 'path contains control characters', 400)
  }
}

/**
 * 对"可能不存在"的路径做 realpath：逐级向上找到第一个存在的祖先，
 * 对祖先 realpath，再把余下段拼回。写模式下目标通常还不存在，
 * 若只对目标本身 realpath 会直接 ENOENT，从而绕过符号链接校验。
 */
async function realpathDeep(input) {
  let cur = resolve(input)
  const rest = []
  for (;;) {
    try {
      const rp = await realpath(cur)
      return rest.length ? resolve(rp, ...rest.reverse()) : rp
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      const parent = resolve(cur, '..')
      if (parent === cur) return resolve(cur) // 已到根仍不存在
      rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
      cur = parent
    }
  }
}

/** roots 侧也必须 realpath（否则 root 内含符号链接时判定失效），并按长度降序便于取最深命中 */
async function normalizeRoots(roots) {
  const out = []
  for (const r of roots) {
    if (typeof r !== 'string' || r === '') continue
    try {
      out.push(await realpathDeep(r))
    } catch {
      // 不可解析的 root 直接忽略（不因此放行）
    }
  }
  return out.sort((a, b) => b.length - a.length)
}

/**
 * 包含判定：必须用 path.relative，不能用字符串前缀比较
 * （否则 `/a/b` 会误放 `/a/b-evil`）。
 * 跨盘符时 relative 返回绝对路径 ⇒ isAbsolute 命中 ⇒ 判定为"不在内"，正确。
 */
function isInside(root, target) {
  const rel = relative(root, target)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 核心校验。
 * @param {string} input 原始路径（可相对）
 * @param {object} opts
 * @param {string[]} [opts.roots]      允许根（空 = 该侧不做允许校验）
 * @param {string[]} [opts.denyRoots]  拒绝根（写的硬闸门，如凭据目录）
 * @param {string[]} [opts.denyPaths]  拒绝的**具体文件**（读写都拒，如 settings.json / auth.json）
 * @param {boolean}  [opts.write]      是否写操作
 * @param {string}   [opts.mode]       覆盖级别（off/warn/enforce）
 * @returns {Promise<string>} realpath 后的绝对路径
 */
async function guard(input, opts = {}) {
  assertInput(input)
  const { roots = [], denyRoots = [], denyPaths = [], write = false, mode } = opts
  const level = mode ?? effectiveGuardMode(write)
  const target = await realpathDeep(input)

  if (level === 'off') return target

  // 0) 凭据文件：**读也拒**。理由——读侧默认是 warn（不拦越界），若凭据文件可读，
  //    不受信预览内容一旦拿到令牌即可读走 settings.json 里的 provider 明文令牌并外发
  //    （opaque 源仍能发出请求，CORS 只挡读响应，不挡发送）。这是比"任意写"更直接的窃密路径。
  //    实现前已核实：渲染层不经文件端点读这些文件（grep settings.json src/ 命中 0）。
  //    该拒绝在 warn 级别下**同样生效**（与 denyRoots 同理：零误伤 + 高价值）。
  if (denyPaths.length) {
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
    const t = fold(target)
    for (const dp of denyPaths) {
      if (typeof dp !== 'string' || dp === '') continue
      if (fold(await realpathDeep(dp)) === t) {
        throw new FSGuardError('EPROTECTED', 'target is a protected credential file', 403)
      }
    }
  }

  // 1) 拒绝根（写侧硬闸门）：warn 级别下也拦——挡的是凭据数据根，零误伤
  if (write && denyRoots.length) {
    for (const d of await normalizeRoots(denyRoots)) {
      if (isInside(d, target)) {
        throw new FSGuardError('EOUTSIDE', 'target is inside a protected data root', 403)
      }
    }
  }

  // 2) 允许根
  if (roots.length) {
    const inside = (await normalizeRoots(roots)).some(r => isInside(r, target))
    if (!inside) {
      if (level === 'enforce') {
        throw new FSGuardError('EOUTSIDE', 'target is outside allowed roots', 403)
      }
      // warn：只记录，不拦
      console.warn('[fs-guard] outside allowed roots:', target)
    }
  }

  return target
}

/** 读路径校验（未设置 env 时默认 warn） */
export function resolveReadable(input, opts = {}) {
  return guard(input, { ...opts, write: false })
}

/** 写路径校验（未设置 env 时默认 enforce） */
export function resolveWritable(input, opts = {}) {
  return guard(input, { ...opts, write: true })
}

/** 扩展名白名单（不传 = 不校验） */
export function assertExtAllowed(target, exts) {
  if (!Array.isArray(exts) || exts.length === 0) return
  const ext = extname(target).toLowerCase().replace(/^\./, '')
  if (!exts.includes(ext)) {
    throw new FSGuardError('EBADEXT', 'file extension not allowed', 415)
  }
}

/** 体积校验（默认 413） */
export function assertSizeOk(size, maxBytes, status = 413) {
  if (typeof size === 'number' && size > maxBytes) {
    throw new FSGuardError('ETOOLARGE', 'file too large', status)
  }
}

/**
 * 把闸门错误转成 HTTP 响应描述；非闸门错误返回 null（交调用方原样处理）。
 * 刻意**不回显**解析后的完整路径，避免端点变成目录探测工具。
 */
export function guardErrorResponse(err) {
  if (err instanceof FSGuardError) {
    return { status: err.status, body: { error: err.message, code: err.code } }
  }
  return null
}
