// 文件类路由（P1 · 从 server/bridge.mjs 抽出）
// ---------------------------------------------------------------------------
// 约定与 `server/logs-routes.mjs` 一致：**纯粹算响应，不碰 res/socket**
//   · 返回 `{ status, body }`            → 调用方回 JSON
//   · 返回 `{ stream: { filePath, headers } }` → 调用方自行流式回包（/raw-file 专属）
//   · 返回 `null`                        → 不是本模块负责的路径
// 这样抽出的好处之一是可**独立单测**（不必起桥，避免测试误杀正在运行的应用实例）。
//
// 迁移时**逐字保留**原有语义与注释要点；行为不变由下列测试守住：
//   server/bridge-fs-guard.test.mjs（24 条：越界/前缀绕过/符号链接/凭据/NUL/413/svg/html 头/正例）
//   server/bridge-auth-token.test.mjs（68 断言：令牌与来源判定）
import { readdir, stat, readFile, writeFile } from 'fs/promises'
import { join, dirname } from 'node:path'
import { guardErrorResponse } from '../shared/fs-guard.mjs'

/** 闸门/体积错误 → 响应；非闸门错误原样抛出（交由调用方的通用错误出口处理） */
function guardFail(e) {
  const r = guardErrorResponse(e)
  if (!r) throw e
  return { status: r.status, body: r.body }
}

const json400 = (code) => ({ status: 400, body: { error: 'Invalid path', code } })

/**
 * 处理文件类路径。
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {URLSearchParams} p.searchParams
 * @param {object|null} p.body         已解析的 JSON body（仅 POST 端点需要，由调用方提供）
 * @param {string} p.sep               平台路径分隔符（调用方传入，避免路径分隔语义漂移）
 * @param {{read:string[],write:string[],writeDeny:string[],credentials:string[]}} p.roots
 * @param {{resolveReadable:Function,resolveWritable:Function,assertSizeOk:Function}} p.guard
 * @returns {Promise<{status:number,body:any}|{stream:{filePath:string,headers:object}}|null>}
 */
export async function handleFilesRoute({ method, pathname, searchParams, body, sep, roots, guard }) {
  const { resolveReadable, resolveWritable, assertSizeOk } = guard
  const readOpts = { roots: roots.read, denyPaths: roots.credentials }
  const writeOpts = { roots: roots.write, denyRoots: roots.writeDeny, denyPaths: roots.credentials }

  // ── GET /list-dir ──────────────────────────────────────────────────────
  if (pathname === '/list-dir') {
    let dir
    try {
      dir = await resolveReadable((searchParams.get('path') || '.').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    // 异步读取 + 条目上限：原实现 readdirSync + 逐文件 statSync 全同步跑在
    // HTTP handler 里——大目录（尤其机械盘上的项目树）会阻塞整个 bridge
    // 事件循环数秒到数十秒，期间所有会话转发与 WS 心跳停摆（整机卡死诱因之一）。
    const MAX_LIST_ENTRIES = 2000
    const items = await readdir(dir, { withFileTypes: true })
    const dirNames = []
    const fileNames = []
    for (const x of items) {
      if (x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('$')) dirNames.push(x.name)
      else if (x.isFile()) fileNames.push(x.name)
    }
    dirNames.sort((a, b) => a.localeCompare(b))
    fileNames.sort((a, b) => a.localeCompare(b))
    const dirs = dirNames.slice(0, MAX_LIST_ENTRIES).map(name => ({ name, path: join(dir, name).replace(/\\/g, '/'), type: 'directory' }))
    const files = (await Promise.all(fileNames.slice(0, MAX_LIST_ENTRIES).map(async name => {
      try { return { name, path: join(dir, name).replace(/\\/g, '/'), type: 'file', size: (await stat(join(dir, name))).size } }
      catch { return null }
    }))).filter(Boolean)
    const entries = [...dirs, ...files]
    const truncated = dirNames.length + fileNames.length > entries.length
    return {
      status: 200,
      body: { path: dir.replace(/\\/g, '/'), parent: dirname(dir).replace(/\\/g, '/'), entries, truncated },
    }
  }

  // ── GET /read-file ─────────────────────────────────────────────────────
  if (pathname === '/read-file') {
    let fp
    try {
      fp = await resolveReadable((searchParams.get('path') || '').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    // 改异步：原 statSync + readFileSync 跑在 HTTP handler 里，会阻塞整个 bridge
    // 事件循环（桥单进程承载全部会话的 token 流）⇒ 一次大文件读让所有会话卡住。
    const st = await stat(fp)
    if (st.isDirectory()) return json400('EISDIR')
    try { assertSizeOk(st.size, 524288) } catch (e) { return guardFail(e) }
    return {
      status: 200,
      body: { path: fp.replace(/\\/g, '/'), content: await readFile(fp, 'utf-8'), size: st.size },
    }
  }

  // ── GET /raw-file（唯一需要流式回包的端点）──────────────────────────────
  if (pathname === '/raw-file') {
    let fp
    try {
      fp = await resolveReadable((searchParams.get('path') || '').replace(/\//g, sep), readOpts)
    } catch (e) { return guardFail(e) }
    const st = await stat(fp)
    if (st.isDirectory()) return json400('EISDIR')
    // P0-2：原实现**没有任何体积上限**（同文件 /read-file 有 512KB、/write-file 有 2MB，
    // 唯独它没有），且 readFileSync 把整个文件读进内存 ⇒ 一个 2GB 文件既 OOM 又阻塞事件循环。
    const MAX_RAW_BYTES = Number(process.env.YFW_RAW_FILE_MAX_BYTES) > 0
      ? Number(process.env.YFW_RAW_FILE_MAX_BYTES)
      : 32 * 1024 * 1024
    try { assertSizeOk(st.size, MAX_RAW_BYTES) } catch (e) { return guardFail(e) }
    const ext = fp.split('.').pop().toLowerCase()
    // svg 已移出白名单：SVG 可内嵌脚本，直接导航/iframe 加载会执行；统一降级为下载态
    // （图片仍可用 <img> 引用 .svg——那时由浏览器按图片解码，不执行脚本）。
    const mimes = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', pdf: 'application/pdf',
      html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    }
    const headers = {
      'Content-Type': mimes[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
    }
    // html/htm：给该响应一个**不透明源**（CSP sandbox）。刻意**不加** script-src/default-src——
    // 预览载荷会合法引用外部 CDN（如 skills/space-generative-art/.../viewer.html 的 p5.js），
    // 套严格 script-src 会直接打断它（依据 spec §6 S2/S3 实测）。
    if (ext === 'html' || ext === 'htm') headers['Content-Security-Policy'] = 'sandbox allow-scripts'
    return { stream: { filePath: fp, headers } }
  }

  // ── POST /write-file ───────────────────────────────────────────────────
  if (pathname === '/write-file' && method === 'POST') {
    if (!body || !body.path) return { status: 400, body: { error: 'path required', code: 'EBADARG' } }
    let fp
    // 写侧默认 enforce（S1：全仓仅 1 个调用点），且带 denyRoots 硬闸门（凭据/系统目录）
    try {
      fp = await resolveWritable((body.path || '').replace(/\//g, sep), writeOpts)
    } catch (e) { return guardFail(e) }
    const content = String(body.content ?? '')
    const size = Buffer.byteLength(content, 'utf-8')
    try { assertSizeOk(size, 2097152) } catch (e) { return guardFail(e) }
    await writeFile(fp, content, 'utf-8')
    return { status: 200, body: { ok: true, path: fp.replace(/\\/g, '/') } }
  }

  return null
}
