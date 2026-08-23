// OCR 工具真实冒烟：spawn python 调 ocr_engine.py 识别测试图片（含缓存命中验证）
// 用法：node zz-smoke/ocr-smoke.mjs <image-path>
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createToolRegistry } from '../kernel/tools.mjs'

const file = process.argv[2] || join(tmpdir(), 'ponos-ocr-smoke.png')
const dir = process.cwd()
const reg = createToolRegistry({ cwd: dir, addDirs: [dir, tmpdir()], skipPermissions: true })

const t0 = Date.now()
const r1 = await reg.run({ name: 'OCR', input: { file_path: file, project: 'smoke-test' } })
const ms1 = Date.now() - t0

let ok = true
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) ok = false }
check('OCR 返回成功', !r1.isError)
console.log('--- 首次识别（含引擎加载）---')
console.log(r1.content)
check('识别出 Ponos-OCR', /Ponos-OCR|Ponos/i.test(String(r1.content ?? '')))
check('识别出中文 测试', String(r1.content ?? '').includes('测试'))
check('识别出数字 12345', String(r1.content ?? '').includes('12345'))
check('meta.scanned 合理（PDF 扫描件=true / 图片=null）', /\.pdf$/i.test(file) ? r1.meta?.scanned === true : r1.meta?.scanned === null)

// 第二次：缓存命中（同 project + 同文件 MD5）
const t1 = Date.now()
const r2 = await reg.run({ name: 'OCR', input: { file_path: file, project: 'smoke-test' } })
const ms2 = Date.now() - t1
check('缓存命中', r2.meta?.cacheHit === true)
check('缓存命中秒回（<2s）', ms2 < 2000, )
console.log(`\n首次 ${ms1}ms；缓存命中 ${ms2}ms`)
process.exit(ok ? 0 : 1)
