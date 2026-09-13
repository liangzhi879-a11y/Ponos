// server/knowledge-routes.mjs —— /knowledge/* 桥路由
// ---------------------------------------------------------------------------
// 设计（spec §5.7）：读操作一律**薄转发**给内核（`--knowledge <op>`，经 kernel-readonly
// 单飞/超时/限流），server 不复制任何切块/检索逻辑——否则双端漂移无解。
// 唯一例外是"写文档"：内容经 HTTP body 传入，落盘在 server 侧完成（见下方 handleWriteDoc）；
// 落盘后**立即**调内核 `update-doc` 做增量更新（不是"标脏等下次重建"，否则"刚保存就搜不到"）。
//
// 契约与 server/logs-routes.mjs 一致：命中返回 { status, body }，未命中返回 null。
// `callKernel` 可注入（默认 server/kernel-readonly.mjs 的 kernelReadonly）——测试用假实现，
// 绝不起 bridge、不起真实内核子进程。
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { kernelReadonly } from './kernel-readonly.mjs'

// 单文档体积上限（2MB）：超过即拒，防一次 HTTP 写入把索引/内存打爆
const MAX_DOC_BYTES = 2 * 1024 * 1024

/** 路径净化：只允许"空间根内的相对 .md 路径"。这是穿越防护的第一、二道。 */
export function safeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null          // 绝对路径
  const parts = s.split('/').filter(Boolean)
  if (!parts.length) return null
  if (parts.some((p) => p === '..' || p === '.')) return null          // 上跳
  const last = parts[parts.length - 1]
  if (!/\.md$/i.test(last)) return null                                // 只收 md
  return parts.join('/')
}

const ok = (body) => ({ status: 200, body })

// 内核 stdout 是 JSON（cli 的 --knowledge 短路分支 console.log(JSON.stringify(output))）。
// 非 JSON ⇒ 抛 502（绝不要把垃圾/半截输出透给前端）；内核 exit≠0 由 kernelReadonly reject ⇒ 500。
async function callJson(callKernel, argsList) {
  const raw = await callKernel(argsList)
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && v.error && Object.keys(v).length === 1) {
      return { error: v.error }
    }
    return { value: v }
  } catch {
    throw Object.assign(new Error('内核返回非 JSON'), { code: 502 })
  }
}

// 写文档：四重防护 + 落盘 + 触发增量索引。**不复制任何检索/切块逻辑**。
async function handleWriteDoc({ readJsonBody, callKernel }) {
  const body = (await readJsonBody()) || {}
  const spaceId = String(body.spaceId ?? '')
  const content = String(body.content ?? '')
  const rel = safeRelPath(body.path)
  if (!rel) return { status: 400, body: { error: 'invalid path（须为空间内相对 .md 路径）' } }
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    return { status: 413, body: { error: 'document too large（上限 2MB）' } }
  }

  // 空间清单以内核为准（权威来源），server 不自己扫盘
  const sres = await callJson(callKernel, ['--knowledge', 'spaces'])
  const space = (sres.value?.spaces || []).find((s) => s.id === spaceId)
  if (!space) return { status: 404, body: { error: 'space not found' } }
  if (!space.writable) return { status: 403, body: { error: 'space is read-only' } }

  const root = resolve(String(space.root))
  const dest = resolve(root, rel)
  // 第三道：解析后仍在根内（覆盖 root 前缀相同但非子目录的边角，如 /a/notes-x）
  if (dest !== root && !dest.startsWith(root + sep)) {
    return { status: 403, body: { error: 'path escapes space root' } }
  }
  // 第四道：符号链接防护——目标目录的 realpath 必须仍在 realpath(root) 内
  // （前一道只看字符串前缀，空间内的软链可把写入引到根外）
  try {
    const rroot = realpathSync(root)
    mkdirSync(dirname(dest), { recursive: true })
    const rdir = realpathSync(dirname(dest))
    if (rdir !== rroot && !rdir.startsWith(rroot + sep)) {
      return { status: 403, body: { error: 'path escapes space root (symlink)' } }
    }
  } catch { return { status: 500, body: { error: 'space root unreadable' } } }

  writeFileSync(dest, content, 'utf-8')
  const docId = `${spaceId}/${rel}`
  const upd = await callJson(callKernel, ['--knowledge', 'update-doc', '--id', docId])
  return ok({ ok: true, docId, updated: upd.value?.updated ?? false })
}

/**
 * 路由入口。`callKernel` 可注入（测试用假实现，避免起进程）。
 * 返回 { status, body } 或 null（未命中，交后续路由）。
 */
export async function handleKnowledgeRoute({
  method = 'GET', pathname = '', searchParams = new URLSearchParams(),
  readJsonBody = async () => ({}), callKernel = kernelReadonly,
} = {}) {
  if (!pathname.startsWith('/knowledge')) return null
  const p = pathname.replace(/\/+$/, '') || '/knowledge'
  const q = (name) => String(searchParams.get(name) ?? '')
  const isPost = String(method).toUpperCase() === 'POST'

  try {
    if (!isPost && p === '/knowledge/spaces') return ok((await callJson(callKernel, ['--knowledge', 'spaces'])).value)
    if (!isPost && p === '/knowledge/tree') {
      const args = ['--knowledge', 'tree', '--space', q('space')]
      if (q('path')) args.push('--path', q('path'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/doc') return ok((await callJson(callKernel, ['--knowledge', 'doc', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/entries') return ok((await callJson(callKernel, ['--knowledge', 'entries', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/links') return ok((await callJson(callKernel, ['--knowledge', 'links', '--id', q('id')])).value)
    if (!isPost && p === '/knowledge/graph') {
      const args = ['--knowledge', 'graph']
      if (q('space')) args.push('--space', q('space'))
      if (q('limit')) args.push('--limit', q('limit'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (!isPost && p === '/knowledge/stats') return ok((await callJson(callKernel, ['--knowledge', 'stats'])).value)
    // 检索：URL 用 `?q=`（避免与内核 flag `--query` 混淆），转发时映射为 `--query`；
    // `spaces` 只取首个（内核 `--space` 是单数，多空间过滤留给 S2 前端逐次请求）。
    if (!isPost && p === '/knowledge/search') {
      const args = ['--knowledge', 'search', '--query', q('q')]
      if (q('keywords')) args.push('--keywords', q('keywords'))
      if (q('topK')) args.push('--topK', q('topK'))
      if (q('mode')) args.push('--mode', q('mode'))
      // `spaces` 是**列表**（HTTP 契约）。原实现取 split(',')[0] 只保留第一个空间，
      // 于是 `?spaces=a,b` 静默只按 a 过滤——调用方以为限定在两个空间，实际少了一半结果。
      // 逗号串原样透传，由内核侧拆分（与 `--keywords` 同约定）。
      if (q('spaces')) args.push('--space', q('spaces'))
      return ok((await callJson(callKernel, args)).value)
    }
    if (isPost && p === '/knowledge/reindex') return ok((await callJson(callKernel, ['--knowledge', 'reindex', '--force'])).value)
    if (isPost && p === '/knowledge/doc') return await handleWriteDoc({ readJsonBody, callKernel })
    return null
  } catch (e) {
    if (e?.code === 502) return { status: 502, body: { error: e.message } }
    return { status: 500, body: { error: e?.message || String(e) } }
  }
}
