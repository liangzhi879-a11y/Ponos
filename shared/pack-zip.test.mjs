// shared/pack-zip.test.mjs —— 自研 zip 编解码的测试
// ---------------------------------------------------------------------------
// 关键：**外部实现的对拍**，否则"自研编解码"就成了自己证明自己对。
//   · 内嵌 fixture = Python `zipfile`（CPython 实现，deflate）产出的真实 zip；
//   · 若 `jszip` 可用（传递依赖，随 mammoth 进来）**再对拍一次双向**：它读我们的产物、
//     我们读它的产物。jszip 不可用时该用例跳过，不让整段测试依赖传递依赖的存续。
// 恶意输入逐条构造：截断 / 非 zip / 声明尺寸炸弹 / zip64 哨兵 / 加密位 / 符号链接条目 /
// deflate 流被篡改 / 声明长度不符。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readZip, writeZip, crc32 } from './pack-zip.mjs'

// Python zipfile 产物（4 条目：pack.json / README.md / content/a.md / content/sub/b.md，
// 含中文内容，deflate）。生成命令见 S4 报告"需人工走查"节。
const FIXTURE_B64 = 'UEsDBBQAAAAIAHgGLl0ReNamXQAAAHQAAAAJAAAAcGFjay5qc29uq1bKTFGyUkrLrCgpLUrVLUhMzlbSUcpLzE0FirpBRIECZalFxZn5eUAxQz0DPQOgSG5mnmNBQRhc3EDPECyek5mcmlcM0u3rGQLkF+eXFiWDuMn5eSWpeSVKtVwAUEsDBBQAAAAIAHgGLl3GpniNEQAAAA8AAAAJAAAAUkVBRE1FLm1kU1Zwy6woKS1KVQhITM7mAgBQSwMEFAAAAAgAeAYuXfGYnfYuAAAAKQAAAAwAAABjb250ZW50L2EubWQBKQDW/yMg6auY5LyB6K6k5a6a5YyFCgrorrjlj6/or4HvvJpDQy1CWS00LjAKUEsDBBQAAAAIAHgGLl2NlavrCQAAAAcAAAAQAAAAY29udGVudC9zdWIvYi5tZMtLLS5JTeECAFBLAQIUABQAAAAIAHgGLl0ReNamXQAAAHQAAAAJAAAAAAAAAAAAAAC2gQAAAABwYWNrLmpzb25QSwECFAAUAAAACAB4Bi5dxqZ4jREAAAAPAAAACQAAAAAAAAAAAAAAtoGEAAAAUkVBRE1FLm1kUEsBAhQAFAAAAAgAeAYuXfGYnfYuAAAAKQAAAAwAAAAAAAAAAAAAALaBvAAAAGNvbnRlbnQvYS5tZFBLAQIUABQAAAAIAHgGLl2NlavrCQAAAAcAAAAQAAAAAAAAAAAAAAC2gRQBAABjb250ZW50L3N1Yi9iLm1kUEsFBgAAAAAEAAQA5gAAAEsBAAAAAA=='

const fixture = () => Buffer.from(FIXTURE_B64, 'base64')

/** 中央目录第 index 项的字段偏移（EOCD 无注释时在末尾 22 字节）。 */
function patchCentral(buf, index, field, value) {
  const out = Buffer.from(buf)
  const eocd = out.length - 22
  let p = out.readUInt32LE(eocd + 16)
  for (let i = 0; i < index; i++) {
    p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32)
  }
  if (field === 'usize') out.writeUInt32LE(value, p + 24)
  else if (field === 'flags') out.writeUInt16LE(value, p + 8)
  else if (field === 'attrs') out.writeUInt32LE(value, p + 38)
  else throw new Error('unknown field ' + field)
  return out
}

const throws = (fn, code) => {
  try {
    fn()
  } catch (e) {
    assert.equal(e.code, code, `期望 code=${code}，实得 ${e.code}（${e.message}）`)
    return e
  }
  assert.fail(`期望抛错 code=${code}，但没有抛`)
}

test('crc32 命中标准校验值（IEEE 802.3 check value）', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('round-trip：文本/二进制/空文件/嵌套路径/中文名', () => {
  const files = [
    { name: 'pack.json', data: '{"id":"demo"}\n' },
    { name: 'content/a.md', data: '# 标题\n\n正文\n' },
    { name: 'content/deep/b.bin', data: Buffer.from([0, 1, 2, 255, 254, 0]) },
    { name: 'content/empty.md', data: '' },
    { name: 'content/中文名.md', data: '中文内容' },
  ]
  const zip = writeZip(files)
  const { entries } = readZip(zip)
  assert.equal(entries.length, 5)
  assert.deepEqual(entries.map((e) => e.name).sort(), files.map((f) => f.name).sort())
  for (const f of files) {
    const e = entries.find((x) => x.name === f.name)
    assert.equal(e.method, 8, 'writer 一律 deflate')
    assert.ok(e.data.equals(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf-8')), `${f.name} 内容不符`)
  }
})

test('产物确定：同内容两次打包逐字节相同（测试与导出可哈希的前提）', () => {
  const files = [{ name: 'a.md', data: 'same' }, { name: 'b.md', data: 'same' }]
  assert.ok(writeZip(files).equals(writeZip(files)))
})

test('读外部实现（Python zipfile）的产物：条目名/内容/中文均正确', () => {
  const { entries } = readZip(fixture())
  assert.deepEqual(entries.map((e) => e.name).sort(), ['README.md', 'content/a.md', 'content/sub/b.md', 'pack.json'])
  const pack = JSON.parse(entries.find((e) => e.name === 'pack.json').data.toString('utf-8'))
  assert.equal(pack.id, 'fixture-pack')
  const a = entries.find((e) => e.name === 'content/a.md').data.toString('utf-8')
  assert.match(a, /高企认定包/, '中文内容按 UTF-8 解出')
  assert.equal(entries.find((e) => e.name === 'content/sub/b.md').data.toString('utf-8'), 'nested\n')
})

test('与 jszip 双向对拍（传递依赖不可用时跳过）', async (t) => {
  let JSZip = null
  try { JSZip = (await import('jszip')).default } catch { /* 未安装则跳过 */ }
  if (!JSZip) { t.skip('jszip 不可用（传递依赖已移除）'); return }
  // ① 我们写的 → 别人读
  const zip = writeZip([{ name: 'content/x.md', data: 'x' }, { name: 'pack.json', data: '{}' }])
  const theirs = await JSZip.loadAsync(zip)
  assert.equal(await theirs.file('content/x.md').async('string'), 'x')
  assert.deepEqual(Object.keys(theirs.files).sort(), ['content/x.md', 'pack.json'])
  // ② 别人写的 → 我们读
  const mine = new JSZip()
  mine.file('content/y.md', 'y')
  mine.file('deep/z.md', 'z')
  const buf = await mine.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const { entries } = readZip(buf)
  // jszip 会写显式目录条目（'content/'）——reader 原样返回并标 isDir，由上层跳过；
  // 这里顺带断言"目录条目被正确识别"，因为漏判会让上层把目录当文件写。
  assert.deepEqual(entries.filter((e) => !e.isDir).map((e) => e.name).sort(), ['content/y.md', 'deep/z.md'])
  assert.ok(entries.filter((e) => e.isDir).every((e) => e.size === 0))
  assert.equal(entries.find((e) => e.name === 'deep/z.md').data.toString('utf-8'), 'z')
})

test('截断/非 zip：报可读错误而非崩', () => {
  throws(() => readZip(Buffer.alloc(4)), 'zip-truncated')
  throws(() => readZip(Buffer.from('这不是 zip，只是一串文本'.repeat(4))), 'zip-truncated')
  const zip = writeZip([{ name: 'a.md', data: 'aaa' }])
  throws(() => readZip(zip.subarray(0, zip.length - 10)), 'zip-truncated')
})

test('体积防线在解压前：声明解压尺寸超限即拒（zip bomb）', () => {
  // 5MB 全零 → deflate 后仅几 KB。若先解压再统计，炸弹已经进内存了。
  const bomb = writeZip([{ name: 'content/big.md', data: Buffer.alloc(5 * 1024 * 1024, 0) }])
  assert.ok(bomb.length < 100 * 1024, '压缩后应远小于解压量')
  const e = throws(() => readZip(bomb, { maxFileBytes: 1024 }), 'zip-too-large')
  assert.match(e.message, /声明解压尺寸/)
  // 总量防线同理（把单文件上限放宽，总量收紧）
  throws(() => readZip(bomb, { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 1024 }), 'zip-too-large')
  throws(() => readZip(bomb, { maxEntries: 0 }), 'zip-too-large')
})

test('zip64 哨兵 / 加密位 / 特殊条目一律拒绝或标记', () => {
  const zip = writeZip([{ name: 'a.md', data: 'aaa' }])
  throws(() => readZip(patchCentral(zip, 0, 'usize', 0xffffffff)), 'zip-unsupported')
  throws(() => readZip(patchCentral(zip, 0, 'flags', 0x1)), 'zip-unsupported')
  // 符号链接条目：标记后返回（拒绝与否由上层知识包校验决定，错误文案要能说清原因）
  const { entries } = readZip(patchCentral(zip, 0, 'attrs', 0xa1ff0000))
  assert.equal(entries[0].isSymlink, true)
})

test('完整性：deflate 流被篡改 / 声明长度不符 → zip-integrity', () => {
  const zip = writeZip([{ name: 'a.md', data: 'hello world' }])
  const nameLen = Buffer.byteLength('a.md', 'utf-8')
  const eocd = zip.length - 22
  const cd = zip.readUInt32LE(eocd + 16)
  const csize = zip.readUInt32LE(cd + 20)
  const tampered = Buffer.from(zip)
  tampered[30 + nameLen + csize - 1] ^= 0xff   // 末字节属 deflate 的 adler32，改必被检出
  throws(() => readZip(tampered), 'zip-integrity')
  throws(() => readZip(patchCentral(zip, 0, 'usize', 12)), 'zip-integrity')
})

test('writer 拒绝非法条目名（产出非法 zip 比读不动更糟）', () => {
  throws(() => writeZip([{ name: '../evil.md', data: 'x' }]), 'zip-bad-name')
  throws(() => writeZip([{ name: '/abs.md', data: 'x' }]), 'zip-bad-name')
  throws(() => writeZip([{ name: 'C:/win.md', data: 'x' }]), 'zip-bad-name')
  throws(() => writeZip([{ name: '', data: 'x' }]), 'zip-bad-name')
  throws(() => writeZip([{ name: 'a//b.md', data: 'x' }]), 'zip-bad-name')
})
