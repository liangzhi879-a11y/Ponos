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
  // 回执统一补 `ok`（2026-09-12 实测缺陷，影响面极大）：
  // 客户端 workflowApi.call() 的判定是「HTTP 非 2xx → 失败」+「body.ok === false → 失败」，
  // 而**成功回执没有 ok 字段**时消费方（AuthzDialog / WorkflowsPanel 等）会走 `if (!r.ok)`
  // 的失败分支 —— 表现为：
  //   · 工作流列表恒空（"暂无工作流"，其实 GET 返回了数据）；
  //   · 运行前授权卡「读取信任清单失败：undefined」（GET /workflows/bindings 回 {agents,trusted}）；
  // 即 store 的纯数据回执（list/bindings/runs/versions/duplicate/stop…）在 UI 里全部"失败"。
  // 在此一处补全，胜于逐个路由手改（store 函数返回形状各异，且未来新增路由同样受益）。
  // 已有 ok 的回执（内核/宿主回执多为 {ok:false,error}）**原样保留**，不覆盖。
  const json = (code, obj) => {
    const payload = obj && typeof obj === 'object' && !Array.isArray(obj) && obj.ok === undefined
      ? { ok: true, ...obj }
      : obj
    return reply(code, { 'Content-Type': 'application/json' }, JSON.stringify(payload))
  }
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
        const args = { id: body.id, inputs: body.inputs || {}, capabilities: body.capabilities }
        // 客户端可**预生成 runId**（异步后必须：宿主回执到达前，内核已开始发事件——含
        // start 与 confirm_request；前端以 runId 判事件归属，回执后才认领会丢掉最早的事件，
        // 表现为抽屉里没有首个节点/审批卡不弹）。宿主对非法格式会自行改用随机 id。
        if (body.runId) args.runId = String(body.runId)
        // **异步启动**（2026-09-12）：此路由原先同步等待内核跑完才回执，spec-dev 实测
        // 80–110 秒；客户端在等待期零反馈（授权卡按钮回调已返回、抽屉未开、失败提示被
        // 遮罩挡住）→ 用户重复点击 → 同一工作流并行多份重跑（实测 20 秒内 3 份）。
        // 现在立即回 { runId, status:'running' }，过程经 WS workflow_event 实时推送，
        // 终态可经 GET /workflows/run-status?runId= 兜底查询（丢事件/重连场景）。
        if (typeof h.startRun === 'function') return json(200, h.startRun(args)), true
        // 宿主未实现 startRun（旧注入/测试替身）→ 回退同步语义，不静默失败。
        const r = await h.run(args)
        return json(r.ok === false ? 400 : 200, r), true
      }
      if (id === 'run-status' && req.method === 'GET') {
        // 运行状态/终态查询（异步运行的兜底通道）。path 参数与 /workflows/runs 同风格。
        const runId = url.searchParams.get('runId') || ''
        if (!runId) return json(400, { ok: false, error: 'runId 必填' }), true
        const r = typeof h.runResult === 'function' ? await h.runResult(runId) : { ok: false, error: '宿主不支持运行状态查询' }
        return json(r?.ok === false && r?.unknown !== true ? 400 : 200, r), true
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
