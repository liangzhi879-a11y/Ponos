// kernel-tests/media-tools-vision.test.mjs
// ---------------------------------------------------------------------------
// Task 7（Vision 统一走 wire）单测。**零回归 + 可移植**两条主线：
//   ① Anthropic 路径的 URL/请求头/请求体必须与改动前**逐字一致**（本文件锁死到具体值；
//      真端点零回归另有 .yfworking/process/openai-wire-task7/ 的取证与烟测）；
//   ② OpenAI 路径按协议换 URL 与图片块编码（`image_url` 的 data URL），语义对等。
// 另锁三条易踩的坑：
//   ・协议来源是 **Vision 自己的配置**（`PONOS_VISION_API_FORMAT` / `YFW_VISION_API_FORMAT`），
//      **不得**误读主 provider 的 `PONOS_API_FORMAT`（本文件用 env 反证）；
//   ・`auto` 沿用既有行为（anthropic）+ 失败时报可读错误（含实际 URL 与端点半截报文）；
//   ・OpenAI 响应体也能取到文本（否则"200 却读不出内容"= 假可移植）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildVisionBody, visionRequestTarget, visionApiFormat, extractVisionText, visionDescribe,
} from '../kernel/media-tools.mjs'
import { visionEnv } from '../kernel/provider.mjs'

/** 换行符常量（避免在正则/字符串里写转义，跨平台按 LF 归一） */
const NEWLINE = String.fromCharCode(10)

const B64 = 'AAAA'
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// ---------------------------------------------------------------------------
// 纯函数：请求体
// ---------------------------------------------------------------------------

test('Vision 请求体：Anthropic 用 image block', () => {
  const b = buildVisionBody({ format: 'anthropic', model: 'm', mediaType: 'image/png', base64: B64, prompt: '看图', maxTokens: 1024 })
  assert.deepEqual(b.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } })
  assert.equal(b.messages[0].content[1].type, 'text')
})

test('Vision 请求体：OpenAI 用 image_url data URL（语义对等）', () => {
  const b = buildVisionBody({ format: 'openai', model: 'm', mediaType: 'image/png', base64: B64, prompt: '看图', maxTokens: 1024 })
  assert.deepEqual(b.messages[0].content[0], { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } })
  assert.equal(b.messages[0].content[1].type, 'text')
})

test('Vision 请求体：Anthropic 形状与改动前逐字一致（键序即 JSON 字符串字节序）', () => {
  const b = buildVisionBody({ format: 'anthropic', model: 'vm', mediaType: 'image/jpeg', base64: 'BBBB', prompt: '看图', maxTokens: 2048 })
  assert.equal(JSON.stringify(b), JSON.stringify({
    model: 'vm',
    max_tokens: 2048,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }, { type: 'text', text: '看图' }] }],
  }))
})

// ---------------------------------------------------------------------------
// 纯函数：请求目标（URL + 鉴权头）
// ---------------------------------------------------------------------------

test('Vision 目标：按协议选 URL（OpenAI 走 rootOf，防 /anthropic/v1 双段）', () => {
  assert.equal(visionRequestTarget({ format: 'anthropic', baseUrl: 'https://api.x.com/anthropic' }).url, 'https://api.x.com/anthropic/v1/messages')
  assert.equal(visionRequestTarget({ format: 'openai', baseUrl: 'https://api.x.com/anthropic' }).url, 'https://api.x.com/v1/chat/completions')
})

test('Vision 目标：Anthropic 鉴权头**保持原样**（双鉴权头同发是刻意的兼容做法，勿顺手清理）', () => {
  const { headers } = visionRequestTarget({ format: 'anthropic', baseUrl: 'https://api.x.com/anthropic', provider: { authToken: 'tok-1' } })
  assert.deepEqual(headers, {
    'content-type': 'application/json',
    'x-api-key': 'tok-1',
    authorization: 'Bearer tok-1',
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
    'user-agent': 'Ponos-turbo/0.1',
  })
})

test('Vision 目标：Anthropic 对已带 Bearer 前缀的 token 不重复加前缀（原行为）', () => {
  const { headers } = visionRequestTarget({ format: 'anthropic', baseUrl: 'https://api.x.com', provider: { authToken: 'Bearer tok-2' } })
  assert.equal(headers.authorization, 'Bearer tok-2')
  assert.equal(headers['x-api-key'], 'Bearer tok-2')
})

test('Vision 目标：OpenAI 走 openaiHeaders（Authorization: Bearer，不夹带 x-api-key）', () => {
  const { headers } = visionRequestTarget({ format: 'openai', baseUrl: 'https://api.x.com', provider: { authToken: 'tok-3' } })
  assert.equal(headers.authorization, 'Bearer tok-3')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['x-api-key'], undefined, 'OpenAI 协议不该带 x-api-key')
})

// ---------------------------------------------------------------------------
// 协议判定：来源必须是 Vision 自己的配置，不得误用主 provider 的键
// ---------------------------------------------------------------------------

test('Vision 协议：显式 apiFormat 优先（两值都认）', () => {
  assert.equal(visionApiFormat({ apiFormat: 'openai', baseUrl: 'https://api.x.com/anthropic' }), 'openai')
  assert.equal(visionApiFormat({ apiFormat: 'anthropic', baseUrl: 'https://api.x.com' }), 'anthropic')
})

test('Vision 协议：未显式指定时按 URL 尾缀判定，其余为 auto（不猜）', () => {
  assert.equal(visionApiFormat({ baseUrl: 'https://api.x.com/anthropic' }), 'anthropic')
  assert.equal(visionApiFormat({ baseUrl: 'https://api.x.com/v1' }), 'auto')
  assert.equal(visionApiFormat({}), 'anthropic', '无 baseUrl 时 resolveApiFormat 的既有语义是 anthropic')
})

test('Vision 协议：**不读主 provider 的 PONOS_API_FORMAT**（勘察踩坑点）', () => {
  const saved = process.env.PONOS_API_FORMAT
  process.env.PONOS_API_FORMAT = 'openai'
  try {
    // 主 provider 设成 openai，Vision 未显式配置 → 必须仍是 auto（否则 Vision 会误用主协议）
    assert.equal(visionApiFormat({ baseUrl: 'https://api.x.com/v1' }), 'auto')
    assert.equal(visionApiFormat({}), 'anthropic')
  } finally {
    if (saved === undefined) delete process.env.PONOS_API_FORMAT
    else process.env.PONOS_API_FORMAT = saved
  }
})

test('Vision 协议：visionEnv 同时认 PONOS_/YFW_ 前缀（沿用既有 pick 先例），PONOS_ 优先', () => {
  const base = { PONOS_VISION_BASE_URL: 'https://gw/anthropic', PONOS_VISION_MODEL: 'vm', PONOS_VISION_AUTH_TOKEN: 't' }
  assert.equal(visionEnv({ ...base, YFW_VISION_API_FORMAT: 'openai' }).apiFormat, 'openai', 'YFW_ 前缀必须被认（bridge 注入的就是它）')
  assert.equal(visionEnv({ ...base, PONOS_VISION_API_FORMAT: 'openai', YFW_VISION_API_FORMAT: 'anthropic' }).apiFormat, 'openai', 'PONOS_ 权威优先')
  assert.equal(visionEnv(base).apiFormat, '', '未配置时为空串（由 visionApiFormat 归一到 auto）')
  // 非法值不得让 visionApiFormat 崩：归一成 auto
  assert.equal(visionApiFormat({ apiFormat: 'grpc', baseUrl: 'https://api.x.com/v1' }), 'auto')
})

// ---------------------------------------------------------------------------
// 纯函数：响应取文（两种协议都要能读出文本）
// ---------------------------------------------------------------------------

test('Vision 取文：Anthropic 形状（content[].text）', () => {
  assert.equal(extractVisionText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'anthropic'), 'a\nb')
})

test('Vision 取文：OpenAI 形状（choices[].message.content）', () => {
  assert.equal(extractVisionText({ choices: [{ message: { content: '图中有一个红圆' } }] }, 'openai'), '图中有一个红圆')
  // 有的端点把正文放在 delta 里（流式残留）：取不到就空串，不得抛 TypeError
  assert.equal(extractVisionText({ choices: [{}] }, 'openai'), '')
  assert.equal(extractVisionText(null, 'openai'), '')
})

// ---------------------------------------------------------------------------
// 接线（端到端，桩 fetch）：确认调用处真的按协议走，且错误可读
// ---------------------------------------------------------------------------

function withStubbedVision(env, fetchImpl, fn) {
  const keys = ['PONOS_VISION_BASE_URL', 'PONOS_VISION_MODEL', 'PONOS_VISION_AUTH_TOKEN', 'PONOS_VISION_API_FORMAT', 'PONOS_API_FORMAT']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const savedFetch = globalThis.fetch
  return (async () => {
    for (const k of keys) delete process.env[k]
    Object.assign(process.env, env)
    globalThis.fetch = fetchImpl
    try {
      return await fn()
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      globalThis.fetch = savedFetch
    }
  })()
}

function mkImage() {
  const dir = mkdtempSync(join(tmpdir(), 'ponos-vision-'))
  const p = join(dir, 'tiny.png')
  writeFileSync(p, Buffer.from(PNG_1x1, 'base64'))
  return { p, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const BASE_ENV = { PONOS_VISION_BASE_URL: 'https://gw.example.com/anthropic', PONOS_VISION_MODEL: 'vm', PONOS_VISION_AUTH_TOKEN: 'tok' }

test('接线：未设 API_FORMAT + /anthropic 基址 → 走 Anthropic（零回归），URL/头/体与改动前一致', async () => {
  const { p, cleanup } = mkImage()
  const seen = []
  try {
    const r = await withStubbedVision(BASE_ENV, async (url, init) => {
      seen.push({ url: String(url), init })
      return { ok: true, status: 200, async text() { return JSON.stringify({ content: [{ type: 'text', text: '红圆与蓝矩形' }] }) } }
    }, () => visionDescribe(p, null, { instruction: '看图' }, true))
    assert.equal(seen[0].url, 'https://gw.example.com/anthropic/v1/messages')
    assert.equal(seen[0].init.headers['x-api-key'], 'tok')
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok')
    assert.equal(seen[0].init.headers['anthropic-version'], '2023-06-01')
    const body = JSON.parse(seen[0].init.body)
    assert.equal(body.model, 'vm')
    assert.deepEqual(body.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: PNG_1x1 })
    assert.ok(r.content.includes('红圆与蓝矩形'), `应返回模型文本：${r.content}`)
  } finally { cleanup() }
})

test('接线：设 PONOS_VISION_API_FORMAT=openai → 走 OpenAI 端点，图片块为 image_url，响应文本可读', async () => {
  const { p, cleanup } = mkImage()
  const seen = []
  try {
    const r = await withStubbedVision({ ...BASE_ENV, PONOS_VISION_API_FORMAT: 'openai' }, async (url, init) => {
      seen.push({ url: String(url), init })
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '红圆与蓝矩形' } }] }) } }
    }, () => visionDescribe(p, null, { instruction: '看图' }, true))
    assert.equal(seen[0].url, 'https://gw.example.com/v1/chat/completions', 'OpenAI 协议必须走 /v1/chat/completions（防 /anthropic/v1 双段）')
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok')
    assert.equal(seen[0].init.headers['x-api-key'], undefined)
    const body = JSON.parse(seen[0].init.body)
    assert.equal(body.messages[0].content[0].type, 'image_url')
    assert.equal(body.messages[0].content[0].image_url.url, `data:image/png;base64,${PNG_1x1}`)
    assert.ok(r.content.includes('红圆与蓝矩形'), `OpenAI 响应也要能读出文本：${r.content}`)
  } finally { cleanup() }
})

test('接线：auto（非 /anthropic 尾缀基址）沿用现状 anthropic —— 零回归优先，不猜协议', async () => {
  const { p, cleanup } = mkImage()
  const seen = []
  try {
    const r = await withStubbedVision({ ...BASE_ENV, PONOS_VISION_BASE_URL: 'https://gw.example.com' }, async (url, init) => {
      seen.push({ url: String(url), init })
      return { ok: true, status: 200, async text() { return JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) } }
    }, () => visionDescribe(p, null, { instruction: '看图' }, true))
    assert.equal(seen[0].url, 'https://gw.example.com/v1/messages')
    assert.equal(JSON.parse(seen[0].init.body).messages[0].content[0].type, 'image')
    assert.equal(r.isError, false)
  } finally { cleanup() }
})

test('接线：auto 遇 404 → 可读错误（含 status、实际 URL、端点半截报文，并提示可改协议）；不出现崩溃', async () => {
  const { p, cleanup } = mkImage()
  try {
    const r = await withStubbedVision({ ...BASE_ENV, PONOS_VISION_BASE_URL: 'https://gw.example.com' }, async () => ({
      ok: false, status: 404,
      async text() { return JSON.stringify({ error: { message: 'no such endpoint' } }) },
    }), () => visionDescribe(p, null, { instruction: '看图' }, true))
    assert.equal(r.isError, true)
    assert.ok(r.content.includes('404'), `应含 status：${r.content}`)
    assert.ok(r.content.includes('https://gw.example.com/v1/messages'), `应含实际 URL：${r.content}`)
    assert.ok(r.content.includes('no such endpoint'), `应含端点半截报文：${r.content}`)
    assert.ok(r.content.includes('PONOS_VISION_API_FORMAT'), `auto 下应提示可切换协议：${r.content}`)
    assert.ok(!/TypeError|Cannot read|is not a function/.test(r.content), `不得是崩溃型错误：${r.content}`)
  } finally { cleanup() }
})

test('接线：OpenAI 404（端点不支持图像）→ 同样给可读错误，不崩', async () => {
  const { p, cleanup } = mkImage()
  try {
    const r = await withStubbedVision({ ...BASE_ENV, PONOS_VISION_API_FORMAT: 'openai' }, async () => ({
      ok: false, status: 400,
      async text() { return '{"error":{"message":"model does not support image input"}}' },
    }), () => visionDescribe(p, null, { instruction: '看图' }, true))
    assert.equal(r.isError, true)
    assert.ok(r.content.includes('400'))
    assert.ok(r.content.includes('model does not support image input'))
    assert.ok(!/TypeError|Cannot read/.test(r.content))
  } finally { cleanup() }
})

/**
 * 剥掉**整行注释**再扫源码。
 * ★ 必须：修复说明里会**合法地**引用旧写法（"原实现调 ocr_image(..., enhance=True)"），
 *   不剥注释的扫描会在**文档**上报红 —— 而修法一旦变成"删注释"，就等于把防线当噪声删掉。
 *   同 kernel-tests/screen-contract.test.mjs 的 stripCommentLines 纪律。
 */
const stripComments = (src) => String(src)
  .split(NEWLINE)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join(NEWLINE)

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-17 真机修复：OCR 的 enhance 参数**根本不存在**（签名 bug）
//
// 现场：任何图片 OCR 都报 `ocr_image() got an unexpected keyword argument 'enhance'`
// —— 连 enhance:'off' 也一样。工具描述却承诺"图片默认走增强管线"。
// 根因不在管线里（`ocr_pipeline.ocr_image_enhanced` 是真存在的），而在**调用处**：
// media-tools 给 `ocr_image(path, project, enhance=True)` 传了一个不存在的关键字参数。
// ─────────────────────────────────────────────────────────────────────────────

test('★ 源码契约：图片 OCR 不得再给 ocr_image 传 enhance（那个参数不存在）', async () => {
  const { readFileSync } = await import('node:fs')
  // ★ 必须剥掉注释再扫：文件头/修复说明里**合法地**引用了旧写法
  //   （"原实现在这里调 ocr_image(path, project, enhance=True)"），
  //   不剥注释的 includes/正则扫描会在**文档**上报红 ⇒ 然后诱惑后来者去删注释。
  //   扫描对象必须是**代码**。同 kernel-tests/screen-contract.test.mjs 的 stripCommentLines 纪律。
  const raw = readFileSync(new URL('../kernel/media-tools.mjs', import.meta.url), 'utf8')
  const src = stripComments(raw)
  // ① 绝不能出现旧写法（它会让每一次图片 OCR 直接 TypeError）
  assert.ok(!/ocr_image\([^)]*enhance\s*=/.test(src),
    '不得再给 ocr_image(...) 传 enhance= —— 引擎签名只有 (image_path, project_name)')
  // ② 增强路径必须走 ocr_pipeline 的真入口
  assert.match(src, /from ocr_pipeline import ocr_image_enhanced/, '增强路径必须调 ocr_pipeline.ocr_image_enhanced')
  // ③ 引擎实例必须复用单例（不重复加载模型）
  assert.match(src, /get_engine\(\)\._ensure_engine\(\)/, '增强管线需要 RapidOCR 实例，必须复用已加载的单例引擎')
  // ④ 增强失败必须**回退基础 OCR**并标注（不让"增强坏了"变成"整条 OCR 失败"）
  assert.match(src, /r\[.enhanceFallback.\]\s*=\s*True/, '增强失败必须回退基础 OCR 并标记 enhanceFallback')
  assert.match(src, /from ocr_engine import ocr_image as _basic/, '必须有基础 OCR 的回退入口')
})

test('★ 源码契约：增强管线的执行情况必须**可审计**（否则"它没跑"没人看得见）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = stripComments(readFileSync(new URL('../kernel/media-tools.mjs', import.meta.url), 'utf8'))
  // 本次 bug 能藏那么久的原因：结果里没有任何字段能区分"增强跑了"与"没跑"。
  assert.match(src, /enhanced:\s*data\.enhanced === true/, 'meta 必须回报 enhanced')
  assert.match(src, /pipeline:\s*data\.pipeline \|\| null/, 'meta 必须回报 pipeline 名（可核对是哪条管线）')
  assert.match(src, /enhanceFallback: true/, '回退时必须回报 enhanceFallback')
})

test('★ 2026-10-17：OCR 子进程必须强制 PYTHONIOENCODING=utf-8（否则中文全乱码）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = stripComments(readFileSync(new URL('../kernel/media-tools.mjs', import.meta.url), 'utf8'))
  // 病灶：Windows 上 Python 的 stdout 默认按系统 ANSI 代码页（本机 cp936）编码，
  //   而 Node 侧 `d.toString()` 按 UTF-8 解码 ⇒ 中文结果全成 mojibake。
  //   症状极具误导性：OCR **能跑通**（不报错、有文本），只是内容读不出 —— 很容易被
  //   误判成"识别质量差/图片不清晰"，从而去调参数而不是修编码。
  assert.match(src, /PYTHONIOENCODING:\s*'utf-8'/,
    'OCR 子进程必须显式设 PYTHONIOENCODING=utf-8（源头按 UTF-8 写）')
  // ★ 必须写在 childEnv() **之后**覆盖式追加：childEnv 是白名单过滤，
  //   未登记变量会被剥掉 ⇒ 只改 process.env 是无效的（这条最容易写错）。
  assert.match(src, /env\s*=\s*\{\s*\.\.\.childEnv\(\),\s*PYTHONIOENCODING:\s*'utf-8'\s*\}/,
    'PYTHONIOENCODING 必须在 childEnv() 之后覆盖（childEnv 会剥掉未登记变量）')
  assert.match(src, /spawn\(py,\s*args,\s*\{[^}]*env\s*\}\)/,
    'spawn 必须真的用上这个 env（不能构造了却传 childEnv()）')
})
