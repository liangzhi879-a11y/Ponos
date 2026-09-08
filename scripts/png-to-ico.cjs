/**
 * Packs PNG files (16/32/48/64/128/256) into a single multi-size ICO file.
 * Windows Vista+ supports PNG-compressed ICO entries.
 * Usage: node scripts/png-to-ico.cjs [basename] [outputPath]
 *   basename   PNG 前缀，读取 public/${basename}-{size}.png（默认 'icon'）
 *   outputPath 输出 .ico 路径（默认 public/icon.ico）
 *   仅打包实际存在的尺寸（SIZES 按文件过滤），favicon 传 16/32/48/64 子集亦可。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const base = process.argv[2] || 'icon'
const outPath = process.argv[3] || path.join(PUBLIC, 'icon.ico')
const SIZES = [16, 32, 48, 64, 128, 256].filter(s =>
  fs.existsSync(path.join(PUBLIC, `${base}-${s}.png`)))

// --- ICO header (6 bytes) ---
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)                 // reserved
header.writeUInt16LE(1, 2)                 // type: ICO
header.writeUInt16LE(SIZES.length, 4)      // image count

// --- Entries (16 bytes each) ---
const entries = []
const payloads = []
let offset = 6 + SIZES.length * 16

for (const size of SIZES) {
  const pngPath = path.join(PUBLIC, `${base}-${size}.png`)
  const png = fs.readFileSync(pngPath)

  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size   // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size   // height
  entry[2] = 0                        // color count
  entry[3] = 0                        // reserved
  entry.writeUInt16LE(1, 4)           // color planes
  entry.writeUInt16LE(32, 6)          // bits per pixel
  entry.writeUInt32LE(png.length, 8)  // size of data
  entry.writeUInt32LE(offset, 12)     // offset in file
  entries.push(entry)
  payloads.push(png)
  offset += png.length
}

const ico = Buffer.concat([header, ...entries, ...payloads])
fs.writeFileSync(outPath, ico)
console.log(`${path.basename(outPath)} created: ${ico.length} bytes (${SIZES.length} sizes: ${SIZES.join(', ')})`)
