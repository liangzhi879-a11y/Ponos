// Ponos-turbo 内核媒体工具：OCR（扫描件识别）与 Vision（图片语义理解）
// ---------------------------------------------------------------------------
// **为什么独立成模块**（P2-1 巨石瘦身第二刀，`kernel/tools.mjs` 拆出）：
//   这两族工具与"工具注册表"没有共享状态：它们各自只做"校验 → 调外部能力 → 组装结果"，
//   且**不依赖 tools.mjs 的任何工具逻辑**（本模块的依赖只有 node 内置 + exec-base + provider）。
//   拆开后依赖方向仍是单向 DAG，**无环**：
//
//       exec-base ─┐
//       provider ──┴→ media-tools ← tools
//                                 ← knowledge-import
//
//   `knowledge-import.mjs` 需要 `findOcrEngine` / `visionDescribe`（PDF/图片转换时调 OCR、
//   文档附图的语义描述）。从前它只能从 `tools.mjs` 取，而 tools 又要用它的 KnowledgeImport
//   工具 → 两者构成 ESM 环（tools.mjs 当时用**动态 import** 回避，但图谱生成器把动态 import
//   也计为边，环仍在）。本模块拆出后，knowledge-import 直接依赖 media-tools，
//   **不再依赖 tools**，那个文件级环随之消失。
//
// **本模块承载**：
//   ① OCR：引擎探测（多路径）+ python 子进程执行 + 输出解析（PDF 走 CLI 临时 JSON、
//      图片走内联 import 调 ocr_image；table 模式追加表格块）。内核保持**零 npm 依赖**。
//   ② Vision：**两套协议**的图片语义理解调用（独立视觉模型端点，`PONOS_VISION_*`）：
//      Anthropic 走 /v1/messages + image block，OpenAI 走 /v1/chat/completions + image_url
//      data URL；未配置时可按 PONOS_AUTO_IMAGE_BRIDGE 自动降级为增强 OCR。
//
// **接口**：`findOcrEngine()` / `ocrFile(...)` / `visionDescribe(...)`；
// 另导出 Vision 的可测纯函数：`buildVisionBody` / `visionRequestTarget` / `visionApiFormat` /
// `extractVisionText`。
// 四者都做路径边界校验（withinBoundary）——边界实现下沉在 exec-base，故本模块无需依赖 tools。
import { spawn } from 'node:child_process'
import { readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { withinBoundary, childEnv, registerChild } from './exec-base.mjs'
import { visionEnv } from './provider.mjs'
import { resolveApiFormat, anthropicStreamUrl, openaiStreamUrl } from './wire/url.mjs'
import { openaiHeaders } from './wire/openai.mjs'
// 平台能力层（2026-10-09 迁移）：python 解释器名（win→`python` / 其余→`python3`）由能力层给出。
// 模块级缓存一次（OCR 热路径每次执行都要取）。
import { platformCapabilities } from '../shared/platform-capabilities.mjs'
const CAPS = platformCapabilities()

// ---------------------------------------------------------------------------
// OCR：扫描件识别。内核保持零 npm 依赖——OCR 能力来自外部 python 引擎
// （RapidOCR/PP-OCRv4，见 skills/_common/ocr_engine.py），工具仅负责
// 定位引擎、传参、解析输出。引擎探测：PONOS_OCR_ENGINE env 覆盖 → 常见技能路径。
// 输出用 --output 写临时 JSON 全量结果（stdout 仅 500 字符预览），解析后删除。
// ---------------------------------------------------------------------------
const OCR_TIMEOUT_MS = 300_000

export function findOcrEngine() {
  if (process.env.PONOS_OCR_ENGINE && existsSync(process.env.PONOS_OCR_ENGINE)) return process.env.PONOS_OCR_ENGINE
  const home = process.env.USERPROFILE || process.env.HOME || ''
  // 多路径探测（修复"新设备报 OCR 不可用"）：
  //   1. PONOS_SKILLS_DIR（bridge 注入的技能根，PONOS_HOME 机制权威来源）
  //   2. PONOS_HOME/skills（skillRoot 兜底）
  //   3. 打包资源 runtime/skills（electron-builder extraResources → <app>/resources/runtime/skills）
  //   4. 传统路径 ~/.ponos/skills、~/.ponos-dev/skills
  // 全部命中失败时再尝试从 python 同目录找（嵌入式 runtime 的 skills 并排部署）。
  const candidates = []
  const push = (p) => { if (p) candidates.push(p) }
  const skillsDir = process.env.PONOS_SKILLS_DIR || ''
  const ponosHome = process.env.PONOS_HOME || ''
  push(join(skillsDir, '_common', 'ocr_engine.py'))
  push(join(ponosHome, 'skills', '_common', 'ocr_engine.py'))
  // 打包资源：dev 便携版 runtime 在仓库根；安装版在 resources/runtime（__dirname 相对 kernel/）
  push(join(dirname(dirname(process.cwd())), 'runtime', 'skills', '_common', 'ocr_engine.py'))
  push(join(dirname(dirname(process.cwd())), 'resources', 'runtime', 'skills', '_common', 'ocr_engine.py'))
  push(join(home, '.ponos', 'skills', '_common', 'ocr_engine.py'))
  push(join(home, '.ponos-dev', 'skills', '_common', 'ocr_engine.py'))
  return candidates.find((p) => existsSync(p)) || null
}

// Windows 优先 python（rapidocr_onnxruntime 装入的解释器），ENOENT 时回退 py。
// 优先使用 bridge 注入的 PONOS_PYTHON（随应用捆绑的 runtime/python/python.exe，
// 见 server/bridge.mjs findPythonExe），新环境无系统 python 时 OCR 仍可用。
/**
 * 跑 python 子进程并捕获输出（ENOENT 时按 `pythons` 顺序回退下一解释器）。
 * @param {any[]} args 传给解释器的参数（脚本/子命令/选项）
 * @param {{ cwd?: any, timeoutMs?: number }} [opts]
 */
function runPythonCapture(args, { cwd, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const envPy = process.env.PONOS_PYTHON
    const pythons = envPy
      ? [envPy]
      // 主解释器名取自能力层；备选名由它派生（Windows 备选是 `py` 启动器，其余平台是 `python`）
      // —— 候选列表内容与顺序逐字未变。
      : [CAPS.python.bin, CAPS.python.bin === 'python' ? 'py' : 'python']
    let idx = 0
    const attempt = () => {
      const py = pythons[idx]
      if (!py) return resolvePromise({ content: 'OCR 失败：未找到 python 解释器（需安装 python + rapidocr_onnxruntime）', isError: true })
      // ★ 2026-10-17 真机修复（OCR 中文全乱码）：Windows 上 Python 的 stdout 默认按
      //   **系统 ANSI 代码页**（本机 cp936）编码，而 Node 侧 `d.toString()` 按 UTF-8 解码
      //   ⇒ 中文/日文结果全成 mojibake（表现为"OCR 能跑，但读不出内容"，极易被误判成识别质量差）。
      //   显式设 `PYTHONIOENCODING=utf-8` 让**源头**就按 UTF-8 写。
      //   ★ 为什么要在这里加、而不是只加进 `childEnv()` 的白名单：那是**全局**子进程策略
      //     （连 Bash 子进程一起变），改它影响面太大；本处只需约束"我们调 OCR 引擎"这一条路。
      //     `childEnv()` 会剥掉未登记变量，故必须在它之后**覆盖式**追加。
      const env = { ...childEnv(), PYTHONIOENCODING: 'utf-8' }
      const child = registerChild(spawn(py, args, { cwd: cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }))
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (content, isError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ content, isError })
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish(`OCR 超时（${timeoutMs}ms）`, true)
      }, timeoutMs)
      child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 500_000) stdout = stdout.slice(-500_000) })
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000) })
      child.on('error', (e) => {
        if (e.code === 'ENOENT') { idx++; attempt() }
        else finish(`OCR 引擎启动失败：${e.message}`, true)
      })
      child.on('close', (code) => {
        const out = stdout.trim()
        const err = stderr.trim()
        const body = code === 0
          ? (out || '(OCR 引擎执行完成，无输出)')
          : `OCR 引擎退出码 ${code}\n${out ? out + '\n' : ''}${err ? 'stderr: ' + err.slice(0, 2000) : ''}`.trim()
        finish(body, code !== 0)
      })
    }
    attempt()
  })
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp']

// OCR 主逻辑：边界/存在性校验 → 引擎探测 → python 执行 → 解析。
// PDF 走 CLI（--output 临时 JSON 全量结果）；图片走内联 import 调 ocr_image()
// （引擎 CLI 的 ocr 命令面向 PDF，fitz 包装图片会判为空白页）。零 npm 依赖。
export async function ocrFile(filePath, allowDirs, input = {}, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!skipBoundary && !withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (statSync(filePath).isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const mode = input?.mode === 'table' ? 'table' : 'text'
    const project = String(input?.project || 'default')
    // 增强管线开关：auto=图片默认增强（深色反色/对比度/低置信度重试/数字复核/超长分块），
    // off=基础 OCR（兼容旧行为，用于图片预处理导致误伤时回退）。PDF 走 CLI 不受影响。
    const enhance = input?.enhance === 'off' ? false : true
    const engine = findOcrEngine()
    if (!engine) {
      const home = process.env.USERPROFILE || process.env.HOME || ''
      const checked = [
        process.env.PONOS_SKILLS_DIR && join(process.env.PONOS_SKILLS_DIR, '_common'),
        process.env.PONOS_HOME && join(process.env.PONOS_HOME, 'skills', '_common'),
        join(dirname(dirname(process.cwd())), 'runtime', 'skills', '_common'),
        join(home, '.ponos', 'skills', '_common'),
        join(home, '.ponos-dev', 'skills', '_common'),
      ].filter(Boolean).join('、')
      return { content: `OCR 引擎不可用：未找到 ocr_engine.py（已检查 ${checked}；可设置 PONOS_OCR_ENGINE 指向引擎路径，或确认应用已安装技能库）`, isError: true }
    }
    const isImage = IMAGE_EXTS.includes(extname(filePath).toLowerCase())
    let data = null
    if (isImage) {
      // 图片：内联 import 引擎函数（table 模式对图片无意义，一律全文）。
      //
      // ★ 2026-10-17 真机修复：原实现在这里调 `ocr_image(path, project, enhance=True)` ——
      //   而 `ocr_engine.ocr_image` 的签名只有 `(image_path, project_name="default")`，
      //   **没有 enhance 参数** ⇒ 任何图片 OCR 都直接 TypeError:
      //     "ocr_image() got an unexpected keyword argument 'enhance'"
      //   （连 enhance='off' 也一样，因为参数名压根不存在）。工具描述却承诺了
      //   "图片默认走增强管线（深色反色/对比度/低置信度重试/数字复核/超长分块）"
      //   ⇒ 承诺与实现之间断了一整条线，且断点在**调用处**，不在管线里。
      // ★ 增强管线本来就有：`ocr_pipeline.ocr_image_enhanced(image_path, engine, ...)`，
      //   它需要的是 **RapidOCR 实例**（不是路径），故这里经 `ocr_engine.get_engine()._ensure_engine()`
      //   取同一个单例引擎（复用已加载模型，不重复加载）。
      // ★ 回退：增强管线不可用（缺 PIL / 缺 ocr_pipeline / 内部报错）时**落回基础 OCR**，
      //   并在结果里带 `enhanceFallback` 说明 —— 宁可给"较弱但可用"的结果并说清楚，
      //   也不要因为增强环节坏了就整条 OCR 失败（那会让用户以为文件有问题）。
      const engineDir = dirname(engine)
      const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(engineDir)})
from ocr_engine import ocr_image as _basic
_enhance = ${enhance ? 'True' : 'False'}
_path = ${JSON.stringify(filePath)}
_proj = ${JSON.stringify(project)}
if _enhance:
    try:
        from ocr_engine import get_engine
        from ocr_pipeline import ocr_image_enhanced
        r = ocr_image_enhanced(_path, get_engine()._ensure_engine())
        if r.get('error'):
            r = _basic(_path, _proj)
            r['enhanceFallback'] = True
            r['enhanceError'] = 'pipeline-returned-error'
    except Exception as e:
        r = _basic(_path, _proj)
        r['enhanceFallback'] = True
        r['enhanceError'] = str(e)[:200]
else:
    r = _basic(_path, _proj)
print(json.dumps(r, ensure_ascii=False))
`.trim()
      const r = await runPythonCapture(['-c', script], { cwd: dirname(filePath) })
      if (r.isError) return { content: `OCR 失败\n${r.content}`, isError: true }
      // 引擎初始化日志（[ocr] …）混在 stdout，JSON 是最后一个以 { 开头的行
      const jsonLine = r.content.split('\n').reverse().find((l) => l.trim().startsWith('{'))
      try { data = JSON.parse(jsonLine) } catch { return { content: `OCR 引擎输出无效\n${r.content}`, isError: true } }
      if (data?.error) return { content: `OCR 失败：${data.error}`, isError: true }
    } else {
      const tmpOut = join(tmpdir(), `ponos-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      const args = mode === 'table'
        ? [engine, 'ocr-table', '--file', filePath, '--project', project, '--output', tmpOut]
        : [engine, 'ocr', '--file', filePath, '--project', project, '--output', tmpOut]
      const r = await runPythonCapture(args, { cwd: dirname(filePath) })
      try { data = JSON.parse(readFileSync(tmpOut, 'utf-8')) } catch {}
      try { rmSync(tmpOut, { force: true }) } catch {}
      if (r.isError) {
        const errMsg = data?.error ? `：${data.error}` : ''
        return { content: `OCR 失败${errMsg}\n${r.content}`, isError: true }
      }
      if (!data) return { content: `OCR 引擎无有效输出\n${r.content}`, isError: true }
    }
    // 组装结果：多页加页标记；table 模式追加表格（tab 分隔行）
    const pages = Array.isArray(data.pages) ? data.pages : []
    const textBlock = pages.length > 1
      ? pages.map((p) => `--- 第 ${p.page} 页 ---\n${p.text || ''}`).join('\n')
      : (pages[0]?.text || data.text || '')
    const tables = Array.isArray(data.tables) ? data.tables : []
    const tableBlock = tables.length
      ? tables.map((t, i) => {
          const rows = Array.isArray(t.data) ? t.data : []
          const lines = rows.map((row) => (Array.isArray(row) ? row.join('\t') : String(row ?? '')))
          return `[表格 ${i + 1}（第 ${t.page} 页，${lines.length} 行）]\n${lines.join('\n')}`
        }).join('\n\n')
      : ''
    const meta = {
      scanned: isImage ? null : data.is_scanned === true,
      pages: pages.length,
      cacheHit: data.cache_hit === true,
      tables: tables.length,
      confidence: data.confidence ?? pages[0]?.confidence ?? null,
      // ★ 2026-10-17：把增强管线的实际执行情况回吐出来（可审计"到底走了哪条路"）。
      //   没有这几个字段时，调用方无法区分"增强跑了"与"静默回退了基础 OCR"——
      //   而那正是本次 bug（enhance 参数根本不存在）能藏那么久的原因：没人能看见它没跑。
      ...(isImage ? {
        enhanced: data.enhanced === true,
        pipeline: data.pipeline || null,
        ...(data.enhanceFallback ? { enhanceFallback: true, enhanceError: data.enhanceError || null } : {}),
        ...(data.is_dark_mode === true ? { darkMode: true } : {}),
        ...(Number(data.chunk_count) > 1 ? { chunks: Number(data.chunk_count) } : {}),
        ...(Number(data.digit_fix_count) > 0 ? { digitFixes: Number(data.digit_fix_count) } : {}),
      } : {}),
    }
    const kind = isImage ? '图片' : (meta.scanned ? '扫描件' : '含文本层')
    const head = `[OCR] ${data.file || filePath}（${kind}，${meta.pages} 页，缓存命中：${meta.cacheHit ? '是' : '否'}）`
    const body = [head, textBlock, tableBlock].filter(Boolean).join('\n\n').trim()
    return { content: body || `OCR 未识别到文本（${filePath}）`, isError: false, meta }
  } catch (e) {
    return { content: `OCR 失败：${e.message}`, isError: true }
  }
}

// ---------------------------------------------------------------------------
// Vision：图片语义理解。走独立视觉模型端点（PONOS_VISION_BASE_URL/MODEL/
// AUTH_TOKEN，bridge buildChildEnv 已注入；visionFromEnv 上报同源），**协议两套**：
// Anthropic 兼容 /v1/messages 带 image block；OpenAI 兼容 /v1/chat/completions 带
// image_url 的 data URL（两者语义对等，见 2026-09-23 设计稿 §3.5）。零新依赖。
// OCR 是"提取文字"，Vision 是"看图说话"（版面/物体/图表趋势/设计风格等语义），
// 两者互补不替代。
// ---------------------------------------------------------------------------
const VISION_TIMEOUT_MS = 60_000
const VISION_MAX_TOKENS = 2048
const VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const VISION_IMAGE_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/**
 * Vision 生效协议（纯函数）：**只认 Vision 自己的配置**。
 * `resolveApiFormat({ format: vision.apiFormat, baseUrl: vision.baseUrl })` —— 显式传
 * `format`，且**刻意不传 `env`**：`resolveApiFormat` 读的是 `env.PONOS_API_FORMAT`
 * （**主 provider 的键**），把 env 传进来会让 Vision 误用主链路的协议（两者可以不同）。
 * 返回 `'anthropic' | 'openai' | 'auto'`；`auto` 的含义由调用方决定（见 visionDescribe）。
 */
export function visionApiFormat(vision = {}) {
  return resolveApiFormat({ format: vision.apiFormat, baseUrl: vision.baseUrl })
}

/**
 * Vision 请求目标（URL + 鉴权头）：按当前生效协议选，不再硬编码 Anthropic 端点。
 * Anthropic 分支**完整保留原实现的鉴权头**——`x-api-key` 与 `authorization`
 * **同时下发**是该文件刻意的兼容做法（不同网关认不同的头），勿"顺手清理"。
 * `'auto'` 由调用方传成 `'anthropic'`（零回归优先，见 visionDescribe）。
 * @param {{ format?: any, baseUrl?: any, provider?: any }} p
 */
export function visionRequestTarget({ format, baseUrl, provider = {} }) {
  if (format === 'openai') {
    return { url: openaiStreamUrl(baseUrl), headers: openaiHeaders(provider) }
  }
  const token = String(provider.authToken ?? '')
  return {
    url: anthropicStreamUrl(baseUrl),
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
      'user-agent': 'Ponos-turbo/0.1',
    },
  }
}

/** Vision 请求体（纯函数）：两种协议**语义对等**的图片块编码。 */
export function buildVisionBody({ format, model, mediaType, base64, prompt, maxTokens }) {
  const text = { type: 'text', text: prompt }
  if (format === 'openai') {
    return {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }, text] }],
    }
  }
  return {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, text] }],
  }
}

/** Vision 响应取文（纯函数）：Anthropic 看 `content[]`，OpenAI 看 `choices[].message.content`。 */
export function extractVisionText(payload, format) {
  if (format === 'openai') {
    const c = payload?.choices?.[0]?.message?.content
    if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    return String(c ?? '').trim()
  }
  const blocks = Array.isArray(payload?.content) ? payload.content : []
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
}

// mock：PONOS_MOCK_API=1 时返回固定文本（测试零依赖，验证边界/参数链路）
function visionMock(filePath, instruction) {
  return { content: `【Vision · mock】${filePath}\n描述：${instruction}`, isError: false }
}

export async function visionDescribe(filePath, allowDirs, input = {}, skipBoundary) {
  try {
    if (!filePath) return { content: 'file_path 缺失', isError: true }
    if (!skipBoundary && !withinBoundary(filePath, allowDirs)) return { content: `拒绝访问：路径超出会话目录边界（${filePath}）`, isError: true }
    if (!existsSync(filePath)) return { content: `文件不存在：${filePath}`, isError: true }
    if (statSync(filePath).isDirectory()) return { content: `是目录：${filePath}`, isError: true }
    const ext = extname(filePath).toLowerCase()
    const mediaType = VISION_IMAGE_EXTS[ext]
    if (!mediaType) {
      return { content: `Vision 仅支持 PNG/JPEG/WebP/GIF 图片（${ext || '无扩展名'} 不支持）——PDF/扫描件用 OCR 提取文字，文本文件用 Read`, isError: true }
    }
    const instruction = String(input?.instruction || '').trim() || '详细描述这张图片的内容（版面、物体、图表、文字），并总结其表达的核心信息'
    const bytes = readFileSync(filePath)
    if (bytes.length > VISION_MAX_IMAGE_BYTES) {
      return { content: `图片过大（${(bytes.length / 1024 / 1024).toFixed(1)}MB > 20MB），请先压缩或用 OCR 提取文字`, isError: true }
    }
    if (process.env.PONOS_MOCK_API === '1') return visionMock(filePath, instruction)
    // env 走 provider.visionEnv（**同时认 PONOS_VISION_* 与 YFW_VISION_***）：
    // 原先只读 PONOS_*，而 bridge 注入的是 YFW_* —— 实测后果是"用户配好了视觉模型，
    // 工具却一直提示未配置"。兼容先例见 kernel/health.mjs:79 的同类记录。
    const v = visionEnv() || {}
    const base = String(v.baseUrl || '').replace(/\/+$/, '')
    const model = v.model || ''
    const token = v.token || ''
    if (!base || !model || !token) {
      // 未配置视觉模型时：PONOS_AUTO_IMAGE_BRIDGE=1（bridge 注入）→ 自动降级走
      // 增强 OCR 本地证据（text-only 模型用 OCR 文字
      // "看"图），而非直接报错。OCR 失败也带降级说明（明确告知尝试了本地 OCR
      // 但失败原因），不会让模型误判"视觉功能本身缺失"。
      // ★ TS2367 断言（checkJs 门禁）：`&&` 链里**同一个元素访问**会被控制流分析收窄成字面量
      //   `"1"`，于是右侧 `!== '0'` 被判成"类型不相交的比较"（谓词本身是对的，是收窄造成的
      //   伪阳性）。此处只给**右侧那个操作数**加 `/** @type {any} */` 类型断言：纯 JSDoc、
      //   运行时零影响，表达式/字面量/分支逐字未动（见 BRIEF 模式 7：必要时加 `(expr)` 断言）。
      if (process.env.PONOS_AUTO_IMAGE_BRIDGE === '1' && /** @type {any} */ (process.env.PONOS_AUTO_IMAGE_BRIDGE) !== '0') {
        const ocrR = await ocrFile(filePath, allowDirs, { project: 'vision-bridge' }, skipBoundary)
        return {
          content: `【Vision 未配置 · 已自动降级为本地 OCR 证据】\n${ocrR.isError ? `（本地 OCR 失败：${ocrR.content}）` : ocrR.content}\n\n（视觉模型未启用：PONOS_VISION_* 未配置。以上为本地增强 OCR 提取的文字；如需版面/物体/图表语义理解，请在应用设置中启用视觉模型）`,
          isError: false,
        }
      }
      return { content: 'Vision 未配置：需设置 PONOS_VISION_BASE_URL / PONOS_VISION_MODEL / PONOS_VISION_AUTH_TOKEN（GUI 设置中选中视觉模型后由 bridge 注入）。需要提取图中文字时可先用 OCR', isError: true }
    }
    // 协议（**Vision 自有配置**，与主 provider 的 PONOS_API_FORMAT 无关，见 visionApiFormat）：
    //   `auto` ⇒ **沿用既有行为（anthropic）**，与主链路 auto 的语义一致（"先按既有行为，
    //   失败再说"）。Vision 侧**没有**主链路那套"失败后记忆并切换协议"的回退机制，故这里
    //   不猜协议（猜错会静默改变端点，是本任务要消灭的那类问题）；真配错时报可读错误并把
    //   `PONOS_VISION_API_FORMAT=openai` 的处置写进消息（下 !res.ok 分支）。
    const declaredFormat = visionApiFormat(v)
    const format = declaredFormat === 'openai' ? 'openai' : 'anthropic'
    // `provider` 取 `{ authToken }` 形状：`openaiHeaders` 的既有契约就是读 `provider.authToken`
    // （visionEnv 里该字段叫 `token`，故在此显式对齐，不在纯函数里做双名兼容）。
    const { url, headers } = visionRequestTarget({ format, baseUrl: base, provider: { authToken: token } })
    const body = buildVisionBody({
      format, model, mediaType, prompt: instruction, maxTokens: VISION_MAX_TOKENS,
      base64: bytes.toString('base64'),
    })
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      })
    } catch (e) {
      return { content: `Vision 请求失败：${e.message}（网络/端点不可达）`, isError: true }
    }
    if (!res.ok) {
      // 可读错误：status + **实际 URL** + 端点半截报文（诊断"配错协议/模型名/鉴权"三件事
      // 全靠这三个信息）+ 协议处置提示。曾经的失败形态只有 status，用户无从判断是协议不对
      // 还是模型名不对。
      let raw = ''
      try { raw = await res.text() } catch {}
      let detail = ''
      try {
        const j = JSON.parse(raw)
        detail = j?.error?.message || j?.error?.type || ''
      } catch {}
      const excerpt = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      // ★ 2026-10-17：鉴权类失败（401/403）单独给**可执行的诊断**。
      //   真实事故：报错只说 "api key invalid"，而病因是"端点/模型/凭据三者来自不同 provider"
      //   （visionProviderId 指向一个没有 visionModel 的 provider ⇒ 旧 bridge 半覆盖，
      //     端点被换成 A、模型还是 B、凭据是 C ⇒ 怎么都不可能成功，但错误看起来像"key 过期"）。
      //   ⇒ 把**实际生效的端点与模型**回显出来（**绝不回显 token**），让"混搭"一眼可见。
      const authHint = (res.status === 401 || res.status === 403)
        ? `；★ 鉴权失败诊断：本次实际使用 端点=${base} 模型=${model}` +
          `（凭据不回显）。` +
          // ★ 令牌**来源**必须是可读的：2026-10-17 的真机病因正是"端点/模型换了、令牌还是
          //   密码库里那条失效的历史 vision 令牌"，而旧报错只显示 "key invalid"，
          //   让人误以为 provider 的 key 也不对。来源标记不含凭据，只说明取了哪一份。
          `${process.env.PONOS_VISION_TOKEN_ORIGIN ? `令牌来源=${process.env.PONOS_VISION_TOKEN_ORIGIN}` : ''}` +
          `${process.env.PONOS_VISION_TOKEN_ORIGIN === 'legacy-settings'
            ? '（取自密码库的**历史** vision 令牌，很可能已失效；在设置里重新选定视觉模型即可改用该 provider 的凭据）'
            : ''}` +
          `。若仍失败：请确认该 provider 的 API Key 本身有效（这是配置层，代码无法替代提供有效凭据）；` +
          `另注 deepseek-flash **原生支持图片**（官方 图像理解），故"端点+flash"本身不是问题` +
          `${process.env.PONOS_VISION_SKIP_REASON ? `；注入诊断=${process.env.PONOS_VISION_SKIP_REASON}` : ''}`
        : ''
      const hint = (declaredFormat === 'auto' && (res.status === 404 || res.status === 405)
        ? `；该端点可能只支持 OpenAI 协议，可设 PONOS_VISION_API_FORMAT=openai 后重试`
        : '') + authHint
      return { content: `Vision 端点返回 HTTP ${res.status}（${url}）${detail ? `：${detail}` : ''}——检查 PONOS_VISION_* 配置；如需图中文字可改用 OCR${excerpt ? `；端点报文：${excerpt}` : ''}${hint}`, isError: true }
    }
    let payload
    try { payload = JSON.parse(await res.text()) } catch { return { content: 'Vision 响应解析失败（非 JSON）', isError: true } }
    const text = extractVisionText(payload, format)
    if (!text) return { content: 'Vision 模型未返回文本描述', isError: false }
    return { content: `[Vision] ${filePath}\n${text}`, isError: false }
  } catch (e) {
    return { content: `Vision 失败：${e.message}`, isError: true }
  }
}
