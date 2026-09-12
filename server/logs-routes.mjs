// logs-routes.mjs —— 运行日志端点（/logs/list | /logs/tail | /logs/prune）
// ---------------------------------------------------------------------------
// 抽成独立模块（先例：workflow-routes.mjs / browser-routing.mjs）：
//   ① 可单测——测试直接调 handleLogsRoute，不必启动 bridge（本仓库有"测试起桥误杀
//      正在运行的应用"的前车之鉴）；
//   ② 全部路径处理集中一处，穿越防护只写一遍。
// 契约：命中返回 { status, body }，未命中返回 null（调用方继续匹配其他路由）。
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  LOG_BASE_NAMES, LOG_LEVELS, LOG_POLICY_LIMITS, getLogTail, listLogFiles,
  normalizeLogPolicy, rotateLog, readLogPolicy, assertLogFileName,
} from './log-policy.cjs'

// 穿越防护三重（缺一不可）：
//   ① assertLogFileName：正则 + 基名白名单 + 轮转序号 ≤ 保留份数（挡 ../、绝对路径、config.json）
//   ② 只暴露三个已知基名的 .log/.N
//   ③ 最后断言 resolve 之后仍在 logs 目录内（防符号链接/平台差异）
function safeLogPath(dir, name, policy) {
  const check = assertLogFileName(name, policy)
  if (!check.ok) return { error: check.error }
  const full = resolve(join(dir, check.name))
  if (!full.startsWith(resolve(dir) + sep)) return { error: '路径越界' }
  return { full, name: check.name }
}

export function handleLogsRoute({ method = 'GET', pathname = '', searchParams = null, home = '', policy = null } = {}) {
  if (!pathname || !pathname.startsWith('/logs/')) return null
  const dir = join(home, 'logs')
  const eff = policy ? normalizeLogPolicy(policy) : readLogPolicy({ home })

  if (pathname === '/logs/list') {
    return {
      status: 200,
      body: {
        ok: true, dir, persist: eff.persist, policy: eff,
        limits: LOG_POLICY_LIMITS, levels: LOG_LEVELS,
        files: listLogFiles({ dir, policy: eff }),
      },
    }
  }

  if (pathname === '/logs/tail') {
    const req = safeLogPath(dir, searchParams?.get?.('file') || 'app.log', eff)
    if (req.error) return { status: 400, body: { ok: false, error: req.error } }
    const raw = Number(searchParams?.get?.('lines') ?? 200)
    const lines = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.floor(raw))) : 200
    return { status: 200, body: { ok: true, file: req.name, lines: getLogTail(req.full, lines) } }
  }

  // [立即清理]：删掉全部轮转份（.1/.2/…）+ 把当前主文件轮转成新的 .1（现场变干净，
  // 历史仍留一份）。**只删轮转份**——三个基名的主文件从不被直接 unlink（kernel-stderr
  // 的崩溃原文可能正被诊断读取）；主文件由 rotateLog 改名成 .1，路径让出，下次写入
  // 由 appendFileSync 重建。不受 persist 开关影响——用户主动点清理即明确意图。
  if (pathname === '/logs/prune') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: '请用 POST' } }
    let freed = 0
    let removed = 0
    // 用 maxFiles 上限（而非当前策略）扫描：策略收紧后遗留的 .4/.5 也要清掉
    const scanPolicy = { ...eff, maxFiles: LOG_POLICY_LIMITS.maxFiles }
    for (const f of listLogFiles({ dir, policy: scanPolicy })) {
      if (!f.index) continue // 只清轮转份，保留正在写的主文件
      try { freed += f.size; unlinkSync(join(dir, f.name)); removed++ } catch { /* 占用/并发：跳过 */ }
    }
    for (const base of LOG_BASE_NAMES) {
      const p = join(dir, base)
      try { if (existsSync(p) && statSync(p).size > 0) rotateLog(p, eff) } catch { /* 忽略单文件失败 */ }
    }
    return { status: 200, body: { ok: true, removed, freedBytes: freed, files: listLogFiles({ dir, policy: eff }) } }
  }

  return { status: 404, body: { ok: false, error: `未知日志端点：${pathname}` } }
}
