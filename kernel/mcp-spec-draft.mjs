import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * P5c（2026-10-27）：OPP-15（反复手搓外部 API）→ **MCP 规格草稿**。
 *
 * 三条硬约束（都来自设计稿 §6.2）：
 * 1. **只出规格草稿**，绝不碰 `mcp.json` —— 装不装、装哪个由人决定
 * 2. **凭据槽位一律空值**：草稿里不写任何 token/key，只留 `credentialSlot` 的名字
 *    （写了值就等于把凭据复制到另一个文件里，泄露面凭空多一处）
 * 3. **`writeOps: false` 默认**：外部系统默认只读；允许写是人的决定，不是草稿的默认
 */

/** 从候选里取域名（subject 优先；没有就从 evidence 里挑第一个 URL） */
export function domainOf(candidate = {}) {
  const s = typeof candidate.subject === 'string' ? candidate.subject.trim() : ''
  if (s) return s.toLowerCase()
  const refs = Array.isArray(candidate.refs) ? candidate.refs : []
  for (const r of refs) {
    const u = typeof r?.url === 'string' ? r.url : ''
    const m = /^https?:\/\/([^/?#]+)/i.exec(u)
    if (m) return m[1].toLowerCase()
  }
  return ''
}

/**
 * 构建草稿（纯函数，不碰磁盘）。
 * @param {{ candidate?: object, nowIso?: string }} [o]
 * @returns {{ ok: true, dirName: string, spec: object } | { ok: false, reason: string }}
 */
export function buildMcpSpecDraft({ candidate = {}, nowIso = new Date().toISOString() } = {}) {
  const domain = domainOf(candidate)
  if (!domain) return { ok: false, reason: 'no-domain' }
  const fp = createHash('sha1').update(`mcp:${domain}`).digest('hex').slice(0, 8)
  const refs = (Array.isArray(candidate.refs) ? candidate.refs : []).slice(0, 20).map((r) => ({
    sessionId: typeof r?.sessionId === 'string' ? r.sessionId : null,
    seq: Number.isFinite(Number(r?.seq)) ? Number(r.seq) : null,
    url: typeof r?.url === 'string' ? r.url : null,
  }))
  return {
    ok: true,
    dirName: `mcp-${fp}`,
    spec: {
      specVersion: 1,
      kind: 'mcp',
      generatedAt: nowIso,
      generatedBy: { ruleId: 'OPP-15', subject: domain },
      // 3 条硬约束见文件头：空凭据槽位 + writeOps:false + 只出草稿
      server: {
        transport: 'http',
        url: `https://${domain}/mcp`,
        auth: { type: 'none', credentialSlot: '' },
      },
      tools: [],
      writeOps: false,
      evidence: refs,
      note: '草稿：安装方式与工具清单需人确认；写入凭据请走设置页，不要写进本文件',
    },
  }
}

/**
 * 落盘到 `<home>/evolution/drafts/<mcp-xxxx>/spec.json`。
 * 已存在 ⇒ 不覆盖（`exists`）：同一域名重复挖掘不该把人改过的草稿冲掉。
 * @param {{ home: string, draft: { dirName: string, spec: object } }} o
 * @returns {{ ok: boolean, path?: string, reason?: string }}
 */
export function writeMcpSpecDraft({ home, draft } = /** @type {any} */ ({})) {
  if (!home || !draft?.dirName || !draft?.spec) return { ok: false, reason: 'bad-input' }
  // 目录名只由我们拼（mcp-<8hex>），仍做一次白名单校验：拼错也不能逃出 drafts/
  if (!/^mcp-[0-9a-f]{8}$/.test(draft.dirName)) return { ok: false, reason: 'bad-dirname' }
  const dir = join(home, 'evolution', 'drafts', draft.dirName)
  const abs = join(dir, 'spec.json')
  try {
    if (existsSync(abs)) return { ok: false, reason: 'exists', path: abs }
    mkdirSync(dir, { recursive: true })
    writeFileSync(abs, `${JSON.stringify(draft.spec, null, 2)}\n`, 'utf-8')
    return { ok: true, path: abs }
  } catch (e) {
    return { ok: false, reason: `write-failed:${e && e.message}` }
  }
}
