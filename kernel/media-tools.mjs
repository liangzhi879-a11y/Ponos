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
//   ② Vision：Anthropic 兼容 /v1/messages 的 image block 调用（独立视觉模型端点），
//      未配置时可按 PONOS_AUTO_IMAGE_BRIDGE 自动降级为增强 OCR。
//
// **接口**：`findOcrEngine()` / `ocrFile(...)` / `visionDescribe(...)`。
// 三者都做路径边界校验（withinBoundary）——边界实现下沉在 exec-base，故本模块无需依赖 tools。
import { spawn } from 'node:child_process'
import { readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { withinBoundary, childEnv, registerChild } from './exec-base.mjs'
import { visionEnv } from './provider.mjs'

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
function runPythonCapture(args, { cwd, timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const envPy = process.env.PONOS_PYTHON
    const pythons = envPy
      ? [envPy]
      : (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])
    let idx = 0
    const attempt = () => {
      const py = pythons[idx]
      if (!py) return resolvePromise({ content: 'OCR 失败：未找到 python 解释器（需安装 python + rapidocr_onnxruntime）', isError: true })
      const child = registerChild(spawn(py, args, { cwd: cwd || undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }))
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
      // 图片：内联 import ocr_engine.ocr_image（table 模式对图片无意义，一律全文；
      // enhance 透传：auto 走增强管线，off 走基础 OCR）
      const engineDir = dirname(engine)
      const script = [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(engineDir)})`,
        'from ocr_engine import ocr_image',
        `r = ocr_image(${JSON.stringify(filePath)}, ${JSON.stringify(project)}, enhance=${enhance ? 'True' : 'False'})`,
        'print(json.dumps(r, ensure_ascii=False))',
      ].join('; ')
      const r = await runPythonCapture(['-c', script], { cwd: dirname(filePath) })
      if (r.isError) return { content: `OCR 失败\n${r.content}`, isError: true }
      // 引擎初始化日志混在 stdout，JSON 是最后一个以 { 开头的行
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
// AUTH_TOKEN，bridge buildChildEnv 已注入；visionFromEnv 上报同源），Anthropic
// 兼容 /v1/messages 带 image block。零新依赖。OCR 是"提取文字"，Vision 是
// "看图说话"（版面/物体/图表趋势/设计风格等语义），两者互补不替代。
// ---------------------------------------------------------------------------
const VISION_TIMEOUT_MS = 60_000
const VISION_MAX_TOKENS = 2048
const VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const VISION_IMAGE_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

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
      if (process.env.PONOS_AUTO_IMAGE_BRIDGE === '1' && process.env.PONOS_AUTO_IMAGE_BRIDGE !== '0') {
        const ocrR = await ocrFile(filePath, allowDirs, { project: 'vision-bridge' }, skipBoundary)
        return {
          content: `【Vision 未配置 · 已自动降级为本地 OCR 证据】\n${ocrR.isError ? `（本地 OCR 失败：${ocrR.content}）` : ocrR.content}\n\n（视觉模型未启用：PONOS_VISION_* 未配置。以上为本地增强 OCR 提取的文字；如需版面/物体/图表语义理解，请在应用设置中启用视觉模型）`,
          isError: false,
        }
      }
      return { content: 'Vision 未配置：需设置 PONOS_VISION_BASE_URL / PONOS_VISION_MODEL / PONOS_VISION_AUTH_TOKEN（GUI 设置中选中视觉模型后由 bridge 注入）。需要提取图中文字时可先用 OCR', isError: true }
    }
    let res
    try {
      res = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          // 与 webSearch 同策略：两种鉴权头超集同发，Bearer 前缀容忍（见上）
          'authorization': /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'accept': 'application/json',
          'user-agent': 'Ponos-turbo/0.1',
        },
        body: JSON.stringify({
          model,
          max_tokens: VISION_MAX_TOKENS,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
              { type: 'text', text: instruction },
            ],
          }],
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      })
    } catch (e) {
      return { content: `Vision 请求失败：${e.message}（网络/端点不可达）`, isError: true }
    }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        detail = j?.error?.message || j?.error?.type || ''
      } catch {}
      return { content: `Vision 端点返回 HTTP ${res.status}${detail ? `：${detail}` : ''}——检查 PONOS_VISION_* 配置；如需图中文字可改用 OCR`, isError: true }
    }
    let payload
    try { payload = await res.json() } catch { return { content: 'Vision 响应解析失败（非 JSON）', isError: true } }
    const text = (payload?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return { content: 'Vision 模型未返回文本描述', isError: false }
    return { content: `[Vision] ${filePath}\n${text}`, isError: false }
  } catch (e) {
    return { content: `Vision 失败：${e.message}`, isError: true }
  }
}
