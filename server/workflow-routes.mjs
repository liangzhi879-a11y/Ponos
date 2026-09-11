// server/workflow-routes.mjs —— 工作流 HTTP 路由（独立模块，便于单测；
// 不得置于 bridge.mjs：bridge 顶层会 listen，测试 import 会真起桥并可能 taskkill
// 用户正在运行的应用——与 workflow-install.mjs 同一理由）。
//
// 职责边界：本模块只做「HTTP ↔ 宿主/存储」的翻译。
//   · 宿主（host，bridge 注入，必需）：解析 / 序列化 / 校验 / 运行 / 停止 / 确认 → 内核会话。
//   · 存储（store）：工作流目录唯一写者（落盘、版本快照、导入导出、绑定）。
// host 缺失时一律 500（不静默降级、不在模块内自建 host 单例）：路由挂错配置必须立刻可见。
//
// 约束：本文件只 import `node:*` 与同目录 server 模块；**不得** import `kernel/*.mjs`
// （生产包只带 kernel-dist/cli.mjs，dev 不显现、安装版才崩）。
import * as wfStore from './workflow-store.mjs'
import { resolve, relative, isAbsolute } from 'node:path'

/** 目标路径是否位于 dir 之内（resolve 归一化后比较，防 `..` 穿越；dir 为空 → 不约束）。 */
function isInsideDir(target, dir) {
  if (!dir) return true
  try {
    const base = resolve(String(dir))
    const abs = isAbsolute(String(target)) ? resolve(String(target)) : resolve(base, String(target))
    const rel = relative(base, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch { return false }
}

export async function handleWorkflowRoute({ url, req, reply, readJsonBody, store = wfStore, host, runsRoot = '', root = '' }) {
  const p = url.pathname
  if (p !== '/workflows' && !p.startsWith('/workflows/')) return false
  if (!host) return reply(500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: '工作流宿主未注入' })), true
  const h = host
  const json = (code, obj) => reply(code, { 'Content-Type': 'application/json' }, JSON.stringify(obj))
  try {
    if (p === '/workflows' && req.method === 'GET') {
      return json(200, { workflows: store.listWorkflowMetas({ root, runsRoot }), root: root.replace(/\\/g, '/') }), true
    }
    if (p === '/workflows' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const id = String(body.id || '').trim()
      if (!id) return json(400, { ok: false, error: 'id 必填' }), true
      const saved = await h.save({ id, model: body.model, yaml: body.yaml })
      if (!saved.ok) return json(400, saved), true
      return json(200, { ...store.writeWorkflowYml({ root, id, yml: saved.yml }), id }), true
    }
    const m = p.match(/^\/workflows\/([^/]+)(\/.*)?$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const sub = m[2] || ''
      if (id === 'run' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (!body?.capabilities) return json(400, { ok: false, error: '缺少 capabilities：运行前必须提供授权清单' }), true
        const r = await h.run({ id: body.id, inputs: body.inputs || {}, capabilities: body.capabilities })
        return json(r.ok === false ? 400 : 200, r), true
      }
      if (id === 'stop' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, await h.stop(body.runId)), true
      }
      if (id === 'confirm' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, h.confirm(body)), true
      }
      if (id === 'runs' && req.method === 'GET') {
        const name = url.searchParams.get('name') || ''
        return json(200, { runs: store.recentRuns({ runsRoot, id: name || url.searchParams.get('id') || '', name }) }), true
      }
      if (id === 'verify' && req.method === 'GET') {
        // 审计哈希链校验（RunDrawer「校验完整性」）：内核 verifyRun 逐行复算，篡改即 ok:false。
        // path 必须落在 runsRoot 内——否则该路由会变成"任意文件探测器"（虽只复算哈希，
        // 仍不该允许外部指定任意路径）。2026-09-12：此路由此前**从未实现**，前端调用恒 404。
        const auditPath = url.searchParams.get('path') || ''
        if (!auditPath) return json(400, { ok: false, error: 'path 必填（审计文件绝对路径）' }), true
        if (!isInsideDir(auditPath, runsRoot)) {
          return json(400, { ok: false, error: 'path 必须位于 workflow-runs 目录内' }), true
        }
        return json(200, await h.send({ subtype: 'verify', payload: { auditPath } }, { timeoutMs: 15_000 })), true
      }
      if (id === 'import' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.importBundle({ root, bundle: body.bundle, id: body.id })), true
      }
      if (id === 'bindings') {
        // 方法白名单（Task 12 审查 I-2）：非 GET/PUT 必须回 405——此前任意方法都落进
        // 写分支（DELETE 也会覆盖绑定表），且 405 与「路径不存在」的 404 语义不同，
        // 前端据 405 判定"路径对、方法错"，不误报找不到路由。
        if (req.method === 'GET') return json(200, store.readBindings({ root })), true
        if (req.method === 'PUT') {
          const body = await readJsonBody(req)
          return json(200, store.writeBindings({ root, bindings: body })), true
        }
        return json(405, { ok: false, error: `方法不允许：/workflows/bindings 只接受 GET/PUT（收到 ${req.method}）` }), true
      }
      if (sub === '' && req.method === 'GET') {
        const r = await h.load(id)
        if (!r.ok) return json(404, r), true
        return json(200, r), true
      }
      if (sub === '' && req.method === 'PUT') {
        const body = await readJsonBody(req)
        const saved = await h.save({ id, model: body.model, yaml: body.yaml })
        if (!saved.ok) return json(400, saved), true
        return json(200, { ...store.writeWorkflowYml({ root, id, yml: saved.yml }), id, validation: saved.validation }), true
      }
      if (sub === '' && req.method === 'DELETE') return json(200, store.deleteWorkflow({ root, id })), true
      if (sub === '/duplicate' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.duplicateWorkflow({ root, fromId: id, toId: body.toId })), true
      }
      if (sub === '/validate' && req.method === 'GET') return json(200, await h.validate(id)), true
      if (sub === '/versions' && req.method === 'GET') return json(200, { versions: store.listVersions({ root, id }) }), true
      if (sub === '/rollback' && req.method === 'POST') {
        const body = await readJsonBody(req)
        return json(200, store.rollbackVersion({ root, id, ts: body.ts })), true
      }
      if (sub === '/export' && req.method === 'GET') {
        const r = store.exportBundle({ root, id })
        return json(r.ok === false ? 404 : 200, r), true
      }
    }
    return json(404, { ok: false, error: 'not found' }), true
  } catch (e) {
    // 存储层入参校验（assertSafeId / assertSafeTs 等）抛错 = 请求方错误 → 400；
    // 其余（宿主命令超时、fs 故障）→ 500，不把异常抛穿到 bridge 的 HTTP 处理器。
    const msg = e?.message || String(e)
    return json(/^非法|保留字/.test(msg) ? 400 : 500, { ok: false, error: msg }), true
  }
}
