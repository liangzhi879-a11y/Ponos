import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../kernel/tools.mjs'

// 2026-08-31 dsh-pseudo-vision 借鉴：OCR 增强管线 + 工具可用性修复
// 覆盖：OCR enhance 参数、Read 二进制引导、Vision 未配置降级、引擎多路径探测

function tmpReg() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-tools-'))
  return { dir, reg: createToolRegistry({ cwd: dir, addDirs: [dir], skipPermissions: true }) }
}

// 1x1 透明 PNG（真实字节）
function writePng(path) {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72e5c6b0000000049454e44ae426082', 'hex')
  writeFileSync(path, png)
}

test('OCR schema：新增 enhance 参数（auto/off），required 仍仅 file_path', () => {
  const schemas = createToolRegistry({ cwd: '/tmp', addDirs: ['/tmp'], skipPermissions: false }).toolSchemas()
  const ocr = schemas.find((s) => s.name === 'OCR')
  assert.ok(ocr.input_schema.properties.enhance)
  assert.equal(ocr.input_schema.properties.enhance.type, 'string')
  assert.deepEqual(ocr.input_schema.required, ['file_path'])
})

test('Read：二进制图片引导走 OCR（返回提示而非乱码）', async () => {
  const { dir, reg } = tmpReg()
  const f = join(dir, 'img.png')
  writePng(f)
  const r = await reg.run({ name: 'Read', input: { file_path: f } }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /图片文件/)
  assert.match(r.content, /OCR/)
})

test('Read：普通文本仍正常读取（二进制探测不误伤）', async () => {
  const { dir, reg } = tmpReg()
  const f = join(dir, 't.txt')
  writeFileSync(f, 'hello 世界\n', 'utf-8')
  const r = await reg.run({ name: 'Read', input: { file_path: f } }, {})
  assert.equal(r.isError, false)
  assert.match(r.content, /hello 世界/)
})

test('Read：PDF 引导走 OCR/doc_toolkit', async () => {
  const { dir, reg } = tmpReg()
  const f = join(dir, 'doc.pdf')
  writeFileSync(f, '%PDF-1.4 fake pdf content', 'utf-8')
  const r = await reg.run({ name: 'Read', input: { file_path: f } }, {})
  assert.equal(r.isError, true)
  assert.match(r.content, /PDF/)
  assert.match(r.content, /OCR/)
})

test('Vision：无视觉配置 + PONOS_AUTO_IMAGE_BRIDGE=1 时降级（不报错）', async () => {
  const { dir, reg } = tmpReg()
  const f = join(dir, 'img.png')
  writePng(f)
  const prev = process.env.PONOS_AUTO_IMAGE_BRIDGE
  const prevBase = process.env.PONOS_VISION_BASE_URL
  const prevModel = process.env.PONOS_VISION_MODEL
  const prevToken = process.env.PONOS_VISION_AUTH_TOKEN
  delete process.env.PONOS_VISION_BASE_URL
  delete process.env.PONOS_VISION_MODEL
  delete process.env.PONOS_VISION_AUTH_TOKEN
  process.env.PONOS_AUTO_IMAGE_BRIDGE = '1'
  try {
    const r = await reg.run({ name: 'Vision', input: { file_path: f } }, {})
    // 降级路径必须触发（即使 OCR 失败也带降级说明，而非"Vision 未配置"错误）
    assert.equal(r.isError, false)
    assert.match(r.content, /已自动降级为本地 OCR 证据/)
    assert.doesNotMatch(r.content, /需设置 PONOS_VISION_BASE_URL/)
  } finally {
    if (prev === undefined) delete process.env.PONOS_AUTO_IMAGE_BRIDGE
    else process.env.PONOS_AUTO_IMAGE_BRIDGE = prev
    if (prevBase !== undefined) process.env.PONOS_VISION_BASE_URL = prevBase
    if (prevModel !== undefined) process.env.PONOS_VISION_MODEL = prevModel
    if (prevToken !== undefined) process.env.PONOS_VISION_AUTH_TOKEN = prevToken
  }
})

test('Vision：无视觉配置且未开桥接 → 仍报配置指引（错误信息含 OCR 建议）', async () => {
  const { dir, reg } = tmpReg()
  const f = join(dir, 'img.png')
  writePng(f)
  const prevBase = process.env.PONOS_VISION_BASE_URL
  const prevModel = process.env.PONOS_VISION_MODEL
  const prevToken = process.env.PONOS_VISION_AUTH_TOKEN
  const prevBridge = process.env.PONOS_AUTO_IMAGE_BRIDGE
  delete process.env.PONOS_VISION_BASE_URL
  delete process.env.PONOS_VISION_MODEL
  delete process.env.PONOS_VISION_AUTH_TOKEN
  delete process.env.PONOS_AUTO_IMAGE_BRIDGE
  try {
    const r = await reg.run({ name: 'Vision', input: { file_path: f } }, {})
    assert.equal(r.isError, true)
    assert.match(r.content, /Vision 未配置/)
    assert.match(r.content, /OCR/)
  } finally {
    if (prevBase !== undefined) process.env.PONOS_VISION_BASE_URL = prevBase
    if (prevModel !== undefined) process.env.PONOS_VISION_MODEL = prevModel
    if (prevToken !== undefined) process.env.PONOS_VISION_AUTH_TOKEN = prevToken
    if (prevBridge !== undefined) process.env.PONOS_AUTO_IMAGE_BRIDGE = prevBridge
    else delete process.env.PONOS_AUTO_IMAGE_BRIDGE
  }
})

test('OCR：引擎探测优先 PONOS_SKILLS_DIR（新路径优先于传统 ~/.claude）', async () => {
  const { dir, reg } = tmpReg()
  const engineDir = join(dir, 'skills', '_common')
  mkdirSync(engineDir, { recursive: true })
  // 放置一个最小的 ocr_engine.py（仅占位，探测只需 existsSync）
  writeFileSync(join(engineDir, 'ocr_engine.py'), '# placeholder\n', 'utf-8')
  const realFile = join(dir, 'real.png')
  writePng(realFile)
  const prev = process.env.PONOS_OCR_ENGINE
  const prevSkills = process.env.PONOS_SKILLS_DIR
  const prevHome = process.env.PONOS_HOME
  delete process.env.PONOS_OCR_ENGINE
  process.env.PONOS_SKILLS_DIR = join(dir, 'skills')
  process.env.PONOS_HOME = join(dir, 'home')
  try {
    // OCR 命中 PONOS_SKILLS_DIR 下的占位引擎 → 错误来自"引擎执行"而非"未找到引擎"
    const r = await reg.run({ name: 'OCR', input: { file_path: realFile } }, {})
    assert.equal(r.isError, true)
    assert.doesNotMatch(r.content, /未找到 ocr_engine\.py/)
  } finally {
    if (prev === undefined) delete process.env.PONOS_OCR_ENGINE
    else process.env.PONOS_OCR_ENGINE = prev
    if (prevSkills === undefined) delete process.env.PONOS_SKILLS_DIR
    else process.env.PONOS_SKILLS_DIR = prevSkills
    if (prevHome === undefined) delete process.env.PONOS_HOME
    else process.env.PONOS_HOME = prevHome
  }
})

test('兜底：工具实现抛异常 → 归一化为错误结果（不中断 run）', async () => {
  const { dir, reg } = tmpReg()
  // 篡改一个非并发安全工具使其抛异常（Write 走串行路径）
  const orig = reg.registry.Write.run
  reg.registry.Write.run = async () => { throw new Error('模拟 Write 内部崩溃') }
  try {
    const r = await reg.run({ name: 'Write', input: { file_path: join(dir, 'x.txt'), content: 'x' } }, {})
    assert.equal(r.isError, true)
    assert.match(r.content, /工具执行异常/)
    assert.match(r.content, /模拟 Write 内部崩溃/)
  } finally {
    reg.registry.Write.run = orig
  }
  // 恢复后正常
  const r2 = await reg.run({ name: 'Write', input: { file_path: join(dir, 'ok.txt'), content: 'ok' } }, {})
  assert.equal(r2.isError, false)
})
