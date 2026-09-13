// shared/pack-zip.mjs —— 极简 ZIP 编解码（知识包分发用）
// ---------------------------------------------------------------------------
// 为什么自研而不引第三方库：仓库**没有** zip 的直接依赖——`jszip` / `unzipper` / `tar` 全是
// 传递依赖（随 mammoth / electron-builder 进来），把传递依赖当契约，一旦上游换实现就会在
// 打包后的应用里静默失效。而本模块只需要 ZIP 的一个很小子集（stored/deflate、无 zip64、
// 无加密、无多卷），且**解压路径的每一项校验都得写在自己手里**（条目名穿越、符号链接条目、
// 声明尺寸炸弹），用 `node:zlib` + 自算 CRC32 反而比适配一个大库的 API 更短、更可控。
//
// 只实现需要的子集，**明确拒绝**其余：zip64 哨兵、加密位、多卷、method 0/8 之外的算法。
// 拒绝即抛带 `code` 的错误（上层折成可读文案），绝不"尽力而为地猜"。
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CD = 0x02014b50
const SIG_LFH = 0x04034b50
const U32_MAX = 0xffffffff
// 固定的 DOS 时间戳（1980-01-01 00:00）。**刻意不写真实 mtime**：同样的内容必须产出逐字节
// 相同的 zip——导出产物可哈希、可复现，测试也不必为了稳定性去 mock 时钟。
const DOS_DATE_FIXED = 0x0021

function zipErr(code, message) {
  return Object.assign(new Error(message), { code })
}

let CRC_TABLE = null
/** CRC32（IEEE 802.3，ZIP 用的那个）。查表法：表只算一次，热路径是纯位运算。 */
export function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 条目名的字节 → 字符串。
 * 通用位 0x800（UTF-8）置位时按 UTF-8；否则按"先试严格 UTF-8，再退 GBK"——
 * Windows 资源管理器打的包不带该位且用 GBK 编中文名，一律按 UTF-8 解会得到乱码路径
 * （然后被穿越校验当成"非法名"拒掉，用户看到的是"名字不合法"而不是真正的原因）。
 */
function decodeName(bytes, flags) {
  if (flags & 0x800) return bytes.toString('utf-8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try { return new TextDecoder('gbk').decode(bytes) } catch { return bytes.toString('latin1') }
  }
}

/** 从尾部反向找 EOCD（注释长度不定，故不能只试末尾 22 字节）。返回偏移，找不到返回 -1。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 解析 zip。**解压前**先用中央目录的声明值挡上限——只在解压后统计等于允许 zip bomb
 * 先吃满内存（200MB 压缩包可以声明 10GB 解压量）。
 * 每条返回 `{ name, data, method, size, crc, isDir, isSymlink, isSpecial }`；
 * 符号链接与特殊文件条目**标记后返回**、不在这里丢：拒绝与否是上层（知识包校验）的决策，
 * 上层要能把"包里有符号链接条目"这条原因原样展示给用户。
 */
export function readZip(buffer, {
  maxEntries = 10000, maxFileBytes = 8 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024,
} = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (buf.length < 22) throw zipErr('zip-truncated', 'zip 文件过小或已截断')
  const eocd = findEocd(buf)
  if (eocd < 0) throw zipErr('zip-truncated', '找不到 zip 中央目录（文件截断，或不是 zip）')
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (disk !== 0 || cdDisk !== 0) throw zipErr('zip-unsupported', '不支持分卷（多盘）zip')
  if (total === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
    // 知识包上限 50MB，正常打包不可能触发 zip64；出现即属异常输入，宁可拒绝也不猜
    throw zipErr('zip-unsupported', '不支持 zip64（条目数/尺寸超出 32 位）')
  }
  if (cdOffset + cdSize > buf.length) throw zipErr('zip-truncated', '中央目录越界（文件已截断）')
  if (total > maxEntries) throw zipErr('zip-too-large', `条目数 ${total} 超过上限 ${maxEntries}`)

  const entries = []
  let p = cdOffset
  let declaredTotal = 0
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) {
      throw zipErr('zip-truncated', `第 ${i + 1} 个中央目录项损坏`)
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const startDisk = buf.readUInt16LE(p + 34)
    const externalAttrs = buf.readUInt32LE(p + 38)
    const lho = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw zipErr('zip-truncated', '中央目录项越界')
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags)

    if (startDisk !== 0) throw zipErr('zip-unsupported', `条目「${name}」属于其它分卷`)
    if (flags & 0x1) throw zipErr('zip-unsupported', `条目「${name}」已加密，无法解压`)
    if (csize === U32_MAX || usize === U32_MAX || lho === U32_MAX) {
      throw zipErr('zip-unsupported', `条目「${name}」使用 zip64 扩展`)
    }
    if (method !== 0 && method !== 8) throw zipErr('zip-unsupported', `条目「${name}」使用了不支持的压缩算法（${method}）`)
    if (usize > maxFileBytes) throw zipErr('zip-too-large', `条目「${name}」声明解压尺寸 ${usize} 字节，超过单文件上限 ${maxFileBytes}`)
    declaredTotal += usize
    if (declaredTotal > maxTotalBytes) throw zipErr('zip-too-large', `声明解压总量超过上限 ${maxTotalBytes} 字节`)

    const isDir = name.endsWith('/')
    // 外部属性高 16 位是 unix mode（非 unix 工具写 0）——符号链接是穿越防护的重点：
    // 解压时若照名字写文件，软链会把后续写入引到目标目录之外。
    const mode = (externalAttrs >>> 16) & 0xffff
    const fmt = mode & 0xf000
    const isSymlink = fmt === 0xa000
    const isSpecial = fmt !== 0 && fmt !== 0x8000 && fmt !== 0x4000 && !isSymlink

    let data = Buffer.alloc(0)
    if (!isDir) {
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LFH) {
        throw zipErr('zip-truncated', `条目「${name}」的本地头损坏`)
      }
      // 数据偏移只信本地头（中央目录的 extra 与本地 extra 可以不同长度）；
      // 尺寸/CRC 只信中央目录（本地头在流式写盘时可能是 0 + data descriptor）。
      const lnameLen = buf.readUInt16LE(lho + 26)
      const lextraLen = buf.readUInt16LE(lho + 28)
      const dstart = lho + 30 + lnameLen + lextraLen
      if (dstart + csize > buf.length) throw zipErr('zip-truncated', `条目「${name}」的数据越界`)
      const raw = buf.subarray(dstart, dstart + csize)
      if (method === 0) {
        data = Buffer.from(raw)
      } else {
        try {
          data = inflateRawSync(raw)
        } catch (e) {
          throw zipErr('zip-integrity', `条目「${name}」解压失败（数据损坏）：${e?.message || e}`)
        }
      }
      // 完整性双查：实际长度 == 声明长度，且 CRC 相符。篡改/截断都落在这里。
      if (data.length !== usize) throw zipErr('zip-integrity', `条目「${name}」解压后长度 ${data.length} 与声明 ${usize} 不符`)
      if (crc32(data) !== crc) throw zipErr('zip-integrity', `条目「${name}」CRC32 校验失败（内容被改动或损坏）`)
    }

    entries.push({ name, data, method, size: usize, crc, isDir, isSymlink, isSpecial })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries }
}

/**
 * 打包。`files = [{ name, data }]`（data 可为 Buffer 或字符串）。
 * 只写目录条目之外的**文件**条目：空目录不入包（解压侧按需 mkdir），
 * 于是"包内空目录"这个既无意义又要额外校验的形态直接不存在。
 */
export function writeZip(files, { level = 9 } = {}) {
  const list = Array.isArray(files) ? files : []
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of list) {
    const name = String(f?.name ?? '').replace(/\\/g, '/')
    // writer 也做一遍条目名净化：产出非法 zip 是比"读不动"更糟的失败（用户拿到手打不开）
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)
      || name.split('/').some((s) => !s || s === '.' || s === '..') || name.includes('\0')) {
      throw zipErr('zip-bad-name', `非法条目名：${JSON.stringify(name)}`)
    }
    const data = Buffer.isBuffer(f?.data) ? f.data : Buffer.from(String(f?.data ?? ''), 'utf-8')
    const crc = crc32(data)
    const comp = deflateRawSync(data, { level })
    const nameBuf = Buffer.from(name, 'utf-8')

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(SIG_LFH, 0)
    lfh.writeUInt16LE(20, 4)                    // version needed
    lfh.writeUInt16LE(0x800, 6)                 // 通用位：UTF-8 名字
    lfh.writeUInt16LE(8, 8)                     // deflate
    lfh.writeUInt16LE(0, 10)                    // 时间
    lfh.writeUInt16LE(DOS_DATE_FIXED, 12)       // 日期
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    locals.push(lfh, nameBuf, comp)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(SIG_CD, 0)
    cd.writeUInt16LE(20, 4)                     // version made by（MS-DOS）
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(DOS_DATE_FIXED, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)                     // extra
    cd.writeUInt16LE(0, 32)                     // comment
    cd.writeUInt16LE(0, 34)                     // 起始盘
    cd.writeUInt16LE(0, 36)                     // 内部属性
    cd.writeUInt32LE(0, 38)                     // 外部属性（0 = 非 unix，绝不产生符号链接条目）
    cd.writeUInt32LE(offset, 42)
    centrals.push(cd, nameBuf)

    offset += 30 + nameBuf.length + comp.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBuf, eocd])
}
