/**
 * Packs PNG files (16/32/48/64/128/256) into a single multi-size ICO file.
 * Windows Vista+ supports PNG-compressed ICO entries.
 * Usage: node scripts/png-to-ico.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const SIZES = [16, 32, 48, 64, 128, 256]

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
  const pngPath = path.join(PUBLIC, `icon-${size}.png`)
  if (!fs.existsSync(pngPath)) {
    console.error('Missing:', pngPath)
    continue
  }
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
fs.writeFileSync(path.join(PUBLIC, 'icon.ico'), ico)
console.log(`icon.ico created: ${ico.length} bytes (${SIZES.length} sizes: ${SIZES.join(', ')})`)
