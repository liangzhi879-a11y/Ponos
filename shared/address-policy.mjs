// shared/address-policy.mjs —— **出网目标（地址）收敛**的唯一判据（AI-03 修复）。
//
// ── 病根（台账 AI-03）────────────────────────────────────────────────────────
// 出网只判「协议是不是 http/https」或「network 开关有没有打开」，**从不判目标地址**：
//   · `kernel/tools.mjs#fetchUrl`（WebFetch）：重定向只复检协议、不复检 host；
//   · `kernel/workflow-nodes.mjs#execHttp`：同上；
//   · `kernel/skill-search.mjs`：`PONOS_SKILL_MARKETS` 可注入任意 URL；
//   · `server/knowledge-pack-install.mjs`：registry 可被 config 指到任意地址。
// ⇒ 回环（127.0.0.1 / localhost / ::1）、私网（10./172.16-31./192.168.）、链路本地
//   （169.254.，含云元数据 169.254.169.254）全部可达 = 标准 SSRF 面。公网 302 到
//   `http://127.0.0.1:8080/admin` 就能把「用户以为在抓网页」变成「打本机管理接口」。
//
// ── 为什么是一个独立的中性层模块（而不是各接入点各写一份）───────────────────
// 四处接入点跨 kernel 与 server 两层，而 `kernel ⊥ server` 是硬边界 ⇒ 判据只能落在
// `shared/`（与 `shared/egress-capability.cjs`、`shared/egress-tools.mjs` 同一层级理由）。
// **同一判据两份实现必然漂移**，而漂移在这里的后果是「某个通道的闸是假的」——正是本轮要消灭的形态。
//
// ── 口径（三层，缺一层就有绕过面）──────────────────────────────────────────
// ① **地址分类**（纯函数 `classifyAddress`）：把主机字面量正确解析成 IP 再判段，
//    **不做字符串前缀匹配**（`10.` 前缀匹配会把 `100.example.com` 误杀、把 `10.evil` 漏放）。
//    覆盖绕法：整数/八进制/十六进制 IPv4（`2130706433`）、IPv4-mapped IPv6
//    （`[::ffff:127.0.0.1]` / URL 归一化后的 `[::ffff:7f00:1]`）、NAT64（`[64:ff9b::7f00:1]`）、
//    6to4（`[2002:7f00:1::]`）、`0.0.0.0`、`[::]`、`localhost` / `*.localhost`。
// ② **域名解析后校验**（异步，`assertAllowedUrl`）：域名本身不是 IP，"是不是内网"只能看解析结果
//    ⇒ 解析出**任一**被禁地址即拒（`127.0.0.1.nip.io` 这类"域名绕法"由此被判死）。
// ③ **显式允许**（环境变量 `PONOS_EGRESS_ALLOW`）：默认拒绝内网/本机，**显式写进清单才放行**。
//    没有这条，内网部署 / 本地联调全废 —— 那会逼着用户去删闸，比不做更糟。
//
// ── 已知限制（如实登记，不假装完美）────────────────────────────────────────
// · **DNS rebinding / TOCTOU**：本模块"先解析校验、后由 fetch 自己再解析连接"，两次解析之间
//   攻击者可让域名换 IP（TTL=0）。彻底解法是**把校验过的地址钉给连接**（`http.request` 的
//   `lookup`）。本模块未钉（钉住要改四处连接的握手参数，风险大于收益），故这一段如实登记：
//   恶意 DNS + 自控域名仍可绕。下一轮若要做，应在 fetchUrl/fetchText 传 `lookup`。
// · **解析失败按放行处理**（`unresolved`）：名字解析不出来就发不出请求，闸在这里拦只会把
//   "网络故障"伪装成"策略拒绝"。代价：若请求不经本机解析器（如走 HTTP 代理，由代理解析域名），
//   域名形态的内网目标可能绕过 —— 那属于代理配置面，不在本模块。
// · **不做重定向解析**：逐跳复检由调用方（fetchUrl / fetchText）保证，本模块只判"这一个 URL"。
// · **不做证书校验相关判断**：https 的证书信任仍是 Node 默认行为。

import { lookup as dnsLookup } from 'node:dns/promises'

/** 显式允许清单的环境变量名（唯一真源；文档与报错文案都引用这里）。 */
export const EGRESS_ALLOW_ENV = 'PONOS_EGRESS_ALLOW'

/** 地址分类（稳定枚举，测试与排障都依赖字面量，**改动即破坏契约**） */
export const ADDRESS_CLASS = Object.freeze({
  PUBLIC: 'public',
  HOSTNAME: 'hostname',           // 域名：本身不判死，交给解析那一道
  LOOPBACK: 'loopback',           // 127.0.0.0/8、::1、localhost
  PRIVATE: 'private',             // 10/8、172.16/12、192.168/16、fc00::/7
  CGNAT: 'cgnat',                 // 100.64/10（运营商级 NAT，常被云内网复用）
  LINK_LOCAL: 'link-local',       // 169.254/16（含云元数据 169.254.169.254）、fe80::/10
  UNSPECIFIED: 'unspecified',     // 0.0.0.0/8、::
  MULTICAST: 'multicast',         // 224/4、ff00::/8
  RESERVED: 'reserved',           // 240/4、255.255.255.255、198.18/15、2001:0::/32 等
  DOCUMENTATION: 'documentation', // 192.0.2/24、198.51.100/24、203.0.113/24、2001:db8::/32
  INVALID: 'invalid',             // 看起来是 IP 但解析不出来（数字分段越界等）
})

/** 中文标签：错误文案用（用户读得懂，排障不用猜） */
const CLASS_LABEL = Object.freeze({
  loopback: '回环地址',
  private: '私网地址',
  cgnat: '运营商级 NAT 地址',
  'link-local': '链路本地地址（含云元数据 169.254.169.254）',
  unspecified: '未指定地址（0.0.0.0 / ::）',
  multicast: '组播地址',
  reserved: '保留地址',
  documentation: '文档示例地址',
  invalid: '非法地址',
})

/** 被禁的地址类别（**白名单式**：不在 PUBLIC/HOSTNAME 里的一律不放行）
 *  ★ 显式标 `Set<string>`：`checkJs` 会把字面量数组推成**字面量联合**，于是 `has(任意 string)`
 *  在类型层就是错的（本判据的输入按设计就是"任意字符串"——绕法形态本来就不可枚举）。
 *  同款先例：`shared/egress-capability.cjs` 的 `KNOWN`。 */
const BLOCKED_CLASSES = /** @type {Set<string>} */ (new Set([
  ADDRESS_CLASS.LOOPBACK, ADDRESS_CLASS.PRIVATE, ADDRESS_CLASS.CGNAT, ADDRESS_CLASS.LINK_LOCAL,
  ADDRESS_CLASS.UNSPECIFIED, ADDRESS_CLASS.MULTICAST, ADDRESS_CLASS.RESERVED,
  ADDRESS_CLASS.DOCUMENTATION, ADDRESS_CLASS.INVALID,
]))

/** 拒绝原因（稳定枚举） */
export const EGRESS_DENY_REASONS = Object.freeze({
  BAD_URL: 'bad-url',
  BAD_SCHEME: 'bad-scheme',
  INSECURE_SCHEME: 'insecure-scheme',
  PRIVATE_ADDRESS: 'private-address',
})

/** 放行/拒绝结果里共用的字段（`allowedBy` 为命中的允许清单条目原文） */
const HINT = `如需放行，把它加入环境变量 ${EGRESS_ALLOW_ENV}（逗号分隔；支持主机名、host:port、CIDR、*.后缀；`
  + `例如 ${EGRESS_ALLOW_ENV}=127.0.0.1:8080 或 ${EGRESS_ALLOW_ENV}=10.0.0.0/8）`

// ─────────────────────────────────────────────────────────────────────────────
// IP 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 IPv4 字面量为 4 字节。**按 WHATWG `URL` 的 IPv4 语法**（不是"点分四段十进制"）：
 * 单段整数（`2130706433`）、末段吃剩余字节（`127.1`）、`0x` 十六进制、前导 0 八进制都接受 ——
 * 这些正是绕过"字符串前缀匹配式私网判断"的常用写法。全数字段但越界 ⇒ `null`（调用方判 invalid）。
 * @param {string} host
 * @returns {number[] | null}
 */
function parseIPv4(host) {
  const s = String(host || '')
  if (!s || !s.includes('.') && !/^[0-9]+$/.test(s)) return null
  const parts = s.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  /** @type {number[]} */
  const nums = []
  for (const p of parts) {
    if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(p)) return null
    let n
    if (/^0[xX]/.test(p)) n = parseInt(p.slice(2), 16)
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8)
    else n = parseInt(p, 10)
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null
    return [(nums[0] >>> 24) & 0xff, (nums[0] >>> 16) & 0xff, (nums[0] >>> 8) & 0xff, nums[0] & 0xff]
  }
  const tailBytes = 5 - nums.length  // 末段可占的字节数
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  if (nums[nums.length - 1] >= Math.pow(256, tailBytes)) return null
  let value = 0
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i)
  value += nums[nums.length - 1]
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/**
 * 解析 IPv6 字面量为 8 组 16 位整数（支持 `::` 压缩、内嵌 IPv4 尾段、`%zone`）。
 * @param {string} host 允许带方括号（`new URL().hostname` 的 IPv6 形态就是带括号的）
 * @returns {number[] | null}
 */
function parseIPv6(host) {
  let h = String(host || '')
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (!h.includes(':')) return null
  const pct = h.indexOf('%')          // 链路本地带 zone id（fe80::1%eth0）
  if (pct >= 0) h = h.slice(0, pct)
  const halves = h.split('::')
  if (halves.length > 2) return null
  /** @param {string} seg @returns {number[] | null} */
  const groupsOf = (seg) => {
    if (!seg) return []
    const bits = seg.split(':')
    /** @type {number[]} */
    const out = []
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i]
      if (!b) return null
      if (b.includes('.')) {
        if (i !== bits.length - 1) return null
        const v4 = parseIPv4(b)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(b)) return null
      out.push(parseInt(b, 16))
    }
    return out
  }
  if (halves.length === 1) {
    const g = groupsOf(halves[0])
    return g && g.length === 8 ? g : null
  }
  const head = groupsOf(halves[0])
  const tail = groupsOf(halves[1])
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...new Array(missing).fill(0), ...tail]
}

/** @param {number[]} g 8 组 */
const v6tailToV4 = (g) => [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]

/**
 * IPv4 分段归类。
 * @param {number[]} o 4 字节
 * @returns {string}
 */
function classifyIPv4(o) {
  const [a, b, c] = o
  if (a === 0) return ADDRESS_CLASS.UNSPECIFIED                                   // 0.0.0.0/8
  if (a === 10) return ADDRESS_CLASS.PRIVATE
  if (a === 127) return ADDRESS_CLASS.LOOPBACK
  if (a === 169 && b === 254) return ADDRESS_CLASS.LINK_LOCAL                    // 云元数据在此段
  if (a === 172 && b >= 16 && b <= 31) return ADDRESS_CLASS.PRIVATE
  if (a === 192 && b === 168) return ADDRESS_CLASS.PRIVATE
  if (a === 100 && b >= 64 && b <= 127) return ADDRESS_CLASS.CGNAT               // 100.64/10
  if (a === 192 && b === 0 && c === 0) return ADDRESS_CLASS.RESERVED             // 192.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return ADDRESS_CLASS.DOCUMENTATION        // 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return ADDRESS_CLASS.RESERVED         // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return ADDRESS_CLASS.DOCUMENTATION     // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return ADDRESS_CLASS.DOCUMENTATION      // 203.0.113/24
  if (a >= 224 && a <= 239) return ADDRESS_CLASS.MULTICAST                       // 224/4
  if (a >= 240) return ADDRESS_CLASS.RESERVED                                    // 240/4 含 255.255.255.255
  return ADDRESS_CLASS.PUBLIC
}

/**
 * IPv6 8 组归类（含"内嵌 IPv4 的几种封装"——绕过面最集中的地方）。
 * @param {number[]} g
 * @returns {string}
 */
function classifyIPv6(g) {
  const allZero = g.every((x) => x === 0)
  if (allZero) return ADDRESS_CLASS.UNSPECIFIED                                   // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return ADDRESS_CLASS.LOOPBACK  // ::1
  // IPv4-mapped ::ffff:a.b.c.d 与 IPv4-compatible ::a.b.c.d（后者已废弃，但解析器仍接受）
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyIPv4(v6tailToV4(g))
  if (g.slice(0, 6).every((x) => x === 0)) return classifyIPv4(v6tailToV4(g))
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyIPv4(v6tailToV4(g))
  // 6to4 2002::/16：内嵌 IPv4 在前两组
  if (g[0] === 0x2002) return classifyIPv4([(g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff])
  // Teredo 2001:0::/32（隧道能转投本机服务，按保留处理）
  if (g[0] === 0x2001 && g[1] === 0x0000) return ADDRESS_CLASS.RESERVED
  if (g[0] === 0x2001 && g[1] === 0x0db8) return ADDRESS_CLASS.DOCUMENTATION      // 2001:db8::/32
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return ADDRESS_CLASS.RESERVED // 100::/64
  if ((g[0] & 0xffc0) === 0xfe80) return ADDRESS_CLASS.LINK_LOCAL                 // fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return ADDRESS_CLASS.RESERVED                   // fec0::/10 站点本地（废弃）
  if ((g[0] & 0xfe00) === 0xfc00) return ADDRESS_CLASS.PRIVATE                    // fc00::/7 ULA
  if ((g[0] & 0xff00) === 0xff00) return ADDRESS_CLASS.MULTICAST                  // ff00::/8
  return ADDRESS_CLASS.PUBLIC
}

/** 归一主机名：小写、去方括号、去 DNS 根点（`example.com.` 与 `example.com` 是同一个） */
function normHost(raw) {
  let h = String(raw || '').trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h
}

/**
 * **地址分类的唯一入口**（纯函数，不解析 DNS）。
 *
 * 返回值语义：`public` / `hostname` 可继续（域名还要过解析那一道），其余在 `BLOCKED_CLASSES` 里。
 * `localhost` 与 `*.localhost` **直接判 loopback**：RFC 6761 规定它映射到回环，且它是 SSRF 头号目标，
 * 不能依赖"本机解析器恰好这样解析"（改 hosts 或换解析器即可绕过）。
 *
 * @param {string} rawHost 主机名/字面量（可带方括号，勿带端口）
 * @returns {string} `ADDRESS_CLASS` 之一
 */
export function classifyAddress(rawHost) {
  const h = normHost(rawHost)
  if (!h) return ADDRESS_CLASS.INVALID
  if (h === 'localhost' || h.endsWith('.localhost')) return ADDRESS_CLASS.LOOPBACK
  // 含冒号 ⇒ 只可能是 IPv6 字面量（域名里不允许冒号；带端口时应先剥端口）
  if (h.includes(':')) {
    const g = parseIPv6(h)
    return g ? classifyIPv6(g) : ADDRESS_CLASS.INVALID
  }
  // 全数字分段 ⇒ 按 IPv4 字面量判（解析不出来就是非法，不能当域名放行）
  if (/^[0-9a-fA-FxX.]+$/.test(h) && /^[0-9]/.test(h)) {
    const v4 = parseIPv4(h)
    if (v4) return classifyIPv4(v4)
    if (/^[0-9.]+$/.test(h)) return ADDRESS_CLASS.INVALID
  }
  return ADDRESS_CLASS.HOSTNAME
}

/**
 * 这个主机字面量是否**不可出网**（回环/私网/链路本地/未指定/组播/保留/非法）。
 * ⚠️ 对 `hostname` 返回 `false` —— 域名是否内网要看解析结果，请用 `assertAllowedUrl`。
 * @param {string} rawHost
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(rawHost) {
  return BLOCKED_CLASSES.has(classifyAddress(rawHost))
}

// ─────────────────────────────────────────────────────────────────────────────
// 显式允许清单
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AllowEntry
 * @property {'any'|'exact'|'suffix'|'cidr'} kind
 * @property {string} host            归一后的主机名/IP（`any` 为 `*`）
 * @property {string} port            `''` = 任意端口
 * @property {number[]|null} base     cidr 起始地址（4 或 8 段）
 * @property {number} bits            cidr 前缀位数
 * @property {string} raw             条目原文（回显给用户"是这条放行的"）
 */

/**
 * 解析显式允许清单。条目语法（逗号或空白分隔）：
 *   · `*`              —— 放行一切（逃生口，会在日志/文案里显式回显）
 *   · `host`           —— 精确主机（任意端口；IPv6 用方括号 `[::1]` 或裸 `::1`）
 *   · `host:port`      —— 精确到端口（`127.0.0.1:8080`、`[::1]:8080`）
 *   · `*.suffix` / `.suffix` —— 后缀匹配（`*.corp.internal` 命中 `api.corp.internal`，不命中 `corp.internal.evil`）
 *   · `10.0.0.0/8`     —— CIDR（IPv4/IPv6 都支持）
 * 读不懂的条目**丢弃**（= 不放行，fail-closed；不会因为清单里有个错字就多放行一类）。
 * @param {string|string[]|null|undefined} raw
 * @returns {AllowEntry[]}
 */
export function parseAllowList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/)
  /** @type {AllowEntry[]} */
  const out = []
  for (const item of list) {
    let s = String(item ?? '').trim()
    if (!s) continue
    if (s === '*') { out.push({ kind: 'any', host: '*', port: '', base: null, bits: 0, raw: s }); continue }
    // 端口：`host:port` / `[v6]:port`（裸 IPv6 `::1` 的多个冒号不当端口分隔）
    let port = ''
    if (s.startsWith('[')) {
      const close = s.indexOf(']')
      if (close < 0) continue
      const rest = s.slice(close + 1)
      if (rest.startsWith(':')) {
        if (!/^[0-9]{1,5}$/.test(rest.slice(1))) continue
        port = rest.slice(1)
      } else if (rest) continue
      s = s.slice(0, close + 1)
    } else {
      const colons = (s.match(/:/g) || []).length
      if (colons === 1) {
        const [h, p] = s.split(':')
        if (!/^[0-9]{1,5}$/.test(p)) continue
        s = h; port = p
      } else if (colons > 1) {
        continue   // 裸 IPv6 带端口的歧义写法：拒绝（请写 [::1]:8080）
      }
    }
    const cidrAt = s.indexOf('/')
    if (cidrAt > 0) {
      const addr = normHost(s.slice(0, cidrAt))
      const bitsRaw = s.slice(cidrAt + 1)
      if (!/^[0-9]{1,3}$/.test(bitsRaw)) continue
      const bits = parseInt(bitsRaw, 10)
      const base = addr.includes(':') ? parseIPv6(addr) : parseIPv4(addr)
      const maxBits = addr.includes(':') ? 128 : 32
      if (!base || bits > maxBits) continue
      out.push({ kind: 'cidr', host: addr, port, base, bits, raw: String(item).trim() })
      continue
    }
    let host = normHost(s)
    if (!host) continue
    if (host.startsWith('*.')) out.push({ kind: 'suffix', host: host.slice(2), port, base: null, bits: 0, raw: String(item).trim() })
    else if (host.startsWith('.')) out.push({ kind: 'suffix', host: host.slice(1), port, base: null, bits: 0, raw: String(item).trim() })
    else out.push({ kind: 'exact', host, port, base: null, bits: 0, raw: String(item).trim() })
  }
  return out
}

/**
 * 候选主机/端口是否命中允许清单。命中返回**条目原文**（用于"是这条放行的"回显），否则 `null`。
 * @param {string} rawHost
 * @param {string|number} [rawPort]
 * @param {string|string[]|AllowEntry[]|null} [allow]
 * @returns {string | null}
 */
export function isAllowlisted(rawHost, rawPort = '', allow = null) {
  /** @type {AllowEntry[]} */
  const entries = Array.isArray(allow)
    ? /** @type {AllowEntry[]} */ (allow)
    : parseAllowList(/** @type {string|string[]|null|undefined} */ (allow))
  const host = normHost(rawHost)
  const port = String(rawPort ?? '').trim()
  if (!host) return null
  for (const e of entries) {
    if (e.port && e.port !== port) continue
    if (e.kind === 'any') return e.raw
    if (e.kind === 'exact' && e.host === host) return e.raw
    if (e.kind === 'suffix' && (host === e.host || host.endsWith('.' + e.host))) return e.raw
    if (e.kind === 'cidr' && e.base) {
      const cand = host.includes(':') ? parseIPv6(host) : parseIPv4(host)
      if (!cand || cand.length !== e.base.length) continue
      // 元素位宽由地址族决定：IPv4 存 4 个 8 位元素，IPv6 存 8 个 16 位元素。
      // ★ 这里曾按"固定 16 位一组"比较 ⇒ `10.0.0.0/8` 的掩码落到错误的元素上，
      //   实测把 `127.0.0.1` 也放行了（前缀比较写错的后果是"放行了不该放行的"）。
      const elemBits = e.base.length === 4 ? 8 : 16
      let remaining = e.bits
      let ok = true
      for (let i = 0; i < e.base.length && remaining > 0; i++) {
        const take = Math.min(elemBits, remaining)
        const mask = take >= elemBits ? (elemBits === 8 ? 0xff : 0xffff) : ((0xffff << (elemBits - take)) & 0xffff)
        if ((cand[i] & mask) !== (e.base[i] & mask)) { ok = false; break }
        remaining -= take
      }
      if (!ok) continue
      return e.raw
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 出网目标判定（唯一入口）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} GateResult
 * @property {boolean} ok
 * @property {string} url           归一化后的 URL（解析失败时为入参原文）
 * @property {string} [host]
 * @property {string} [port]
 * @property {string} [addressClass] `ADDRESS_CLASS` 之一
 * @property {string} [reason]       `EGRESS_DENY_REASONS` 之一（仅拒绝时有）
 * @property {string} [message]      可读中文（含规则与放行办法；仅拒绝时有）
 * @property {string|null} [allowedBy] 命中的允许清单条目原文（未命中为 null）
 * @property {string[]} [resolved]   解析出的地址（仅域名 + 解析成功时有）
 * @property {boolean} [unresolved]  true = 域名解析失败，按放行处理（见文件头"已知限制"）
 */

/** 默认 DNS 解析器（OS 解析器，尊重 /etc/hosts 等） */
async function defaultResolve(host) {
  const rows = await dnsLookup(host, { all: true, verbatim: true })
  return rows.map((r) => r.address)
}

/**
 * 组装拒绝结果（文案统一在这里，接入点不要各写一份）。
 * @returns {GateResult}
 */
function deny(url, host, addressClass, reason, detail, allowedBy = null) {
  const rule = reason === EGRESS_DENY_REASONS.PRIVATE_ADDRESS
    ? `${CLASS_LABEL[addressClass] || addressClass}（${addressClass}）`
    : reason === EGRESS_DENY_REASONS.INSECURE_SCHEME ? '只接受 https（明文 http 会被中间人改写目标）' : reason
  const message = `出网策略拒绝：${url} —— 规则「${rule}」：${detail}。${HINT}`
  return { ok: false, url, host, addressClass, reason, message, allowedBy }
}

/**
 * **出网目标判定的唯一入口**：给定 URL，回答"能不能发请求"。
 *
 * 判据顺序（**顺序有意义**：先把不需要 DNS 的判死，避免"为了判断先泄露一次解析"）：
 *   ① URL 合法 + 协议是 http/https；
 *   ② 主机字面量分类（IP 直接判；`localhost` 直接判回环）；
 *   ③ 显式允许清单命中 ⇒ 放行（**唯一出口**，`host:port` 只放行该端口）；
 *   ④ 通道要求 https 而这里是 http ⇒ 拒（仅对"机器配置源"，见各接入点的传参理由）；
 *   ⑤ 域名 ⇒ 解析后逐个校验，**任一**地址被禁即拒（防 `127.0.0.1.nip.io` 这类域名绕法）。
 *
 * @param {string|URL} rawUrl
 * @param {{
 *   channel?: string,                     // 用于文案/审计的通道名（如 'WebFetch 工具'）
 *   requireHttps?: boolean,               // 该通道是否强制 https（默认 false）
 *   allow?: string|string[]|null,         // 显式允许清单；不传 ⇒ 读 PONOS_EGRESS_ALLOW
 *   resolve?: ((host: string) => Promise<string[]>) | null,  // 注入 DNS（测试/特殊解析器）
 * }} [opts]
 * @returns {Promise<GateResult>}
 */
export async function assertAllowedUrl(rawUrl, {
  channel = '', requireHttps = false, allow = null, resolve = null,
} = {}) {
  const label = channel ? `（${channel}）` : ''
  let u
  try { u = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl ?? '')) } catch {
    return {
      ok: false, url: String(rawUrl ?? ''), reason: EGRESS_DENY_REASONS.BAD_URL, addressClass: ADDRESS_CLASS.INVALID,
      message: `出网策略拒绝${label}：URL 无效。${HINT}`, allowedBy: null,
    }
  }
  const url = u.toString()
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false, url, host: u.hostname, reason: EGRESS_DENY_REASONS.BAD_SCHEME, addressClass: ADDRESS_CLASS.INVALID,
      message: `出网策略拒绝${label}：只支持 http/https，收到 ${u.protocol}。${HINT}`, allowedBy: null,
    }
  }
  const host = normHost(u.hostname)
  const port = String(u.port || (u.protocol === 'https:' ? 443 : 80))
  const entries = Array.isArray(allow) || typeof allow === 'string'
    ? parseAllowList(allow)
    : parseAllowList(process.env[EGRESS_ALLOW_ENV] || '')
  const allowedBy = isAllowlisted(host, port, entries)
  const addressClass = classifyAddress(host)

  // ② 字面量（含 localhost）直接判 —— 不需要 DNS，也不给"解析器恰好解析成公网"留门
  if (BLOCKED_CLASSES.has(addressClass)) {
    if (allowedBy) return { ok: true, url, host, port, addressClass, allowedBy }
    return deny(url, host, addressClass, EGRESS_DENY_REASONS.PRIVATE_ADDRESS,
      `目标是${CLASS_LABEL[addressClass] || addressClass}，默认禁止访问本机/内网`, null)
  }
  // ④ 机器配置源强制 https（显式允许的是"内网联调"，此时允许明文）
  if (requireHttps && u.protocol !== 'https:' && !allowedBy) {
    return deny(url, host, addressClass, EGRESS_DENY_REASONS.INSECURE_SCHEME,
      `该通道的地址来自环境变量/配置（不是用户逐次点击），明文 http 不可接受`, null)
  }
  // ③ 已显式放行 ⇒ 不再解析（用户已明确表态；也避免"放行了还要 DNS 才能用"）
  if (allowedBy) return { ok: true, url, host, port, addressClass, allowedBy }
  if (addressClass !== ADDRESS_CLASS.HOSTNAME) return { ok: true, url, host, port, addressClass, allowedBy: null }

  // ⑤ 域名解析后复检
  let addrs = []
  try {
    addrs = await (resolve || defaultResolve)(host)
  } catch {
    // 解析不出来 ⇒ 请求本身发不出去 ⇒ 不当成策略拒绝（否则"网络故障"会被伪装成"被策略拦"）
    return { ok: true, url, host, port, addressClass, allowedBy: null, resolved: [], unresolved: true }
  }
  const list = Array.isArray(addrs) ? addrs.map((a) => normHost(String(a))) : []
  for (const addr of list) {
    const cls = classifyAddress(addr)
    if (BLOCKED_CLASSES.has(cls)) {
      return deny(url, host, cls, EGRESS_DENY_REASONS.PRIVATE_ADDRESS,
        `域名解析到${CLASS_LABEL[cls] || cls} ${addr}，默认禁止访问本机/内网`, null)
    }
  }
  return { ok: true, url, host, port, addressClass, allowedBy: null, resolved: list }
}

/** 环境变量里当前的显式允许清单（排障/审计用；解析失败不影响判定——判定里各自读） */
export function egressAllowFromEnv() {
  return parseAllowList(process.env[EGRESS_ALLOW_ENV] || '')
}
