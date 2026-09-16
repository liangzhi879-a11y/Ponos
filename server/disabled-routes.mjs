// server/disabled-routes.mjs —— Agent / Skill 全局停用注册表的 HTTP 面（2026-09-15，P1 D 条款）。
//
// 抽成**纯 handler**（`{status, body}` 或 `null`）而不是写在 bridge 的内联分支里，理由取自本仓库
// 既有纪律（`server/knowledge-routes.mjs` 的头注）：测试**不得起 bridge、不得起内核子进程**
// —— 本仓库有过"测试起桥误杀运行中应用"的前车之鉴，且 bridge 在 import 期就会扫真实 home
// （`sweeping orphan prompt files` 之类）。纯 handler 让路由可被直调测试，不触碰任何进程与真实目录。
//
// 落点 = `<configDir>/disabled.json`，与内核读的**同一个文件**（内核 `configDir` = 桥的 `YFW_HOME`）。
// 故这里是"写"、内核是"读"，中间没有任何 spawn 透传参数 —— 这正是不用 spawn 参数做全局开关的理由：
// 少一条会静默失效的链路（本仓库已有 `--spaces`/`--confirm` 两次"漏登记被静默忽略"的前车之鉴）。
import { readDisabled, writeDisabled } from '../kernel/disabled.mjs'

/**
 * 处理 `/disabled` 的 GET / PUT。
 * @param {{method: string, pathname: string, readJsonBody: () => Promise<any>, configDir: string}} ctx
 * @returns {Promise<{status: number, body: object} | null>} 未匹配路径返回 `null`（交给后续路由）
 *
 * 写语义：**只改传入的键**（`agents` / `skills`）。用整体替换的话，两次来自不同面板的请求会
 * 互相覆盖——用户会撞上"停用了 agent → 去技能面板点一下 → agent 又能跑了"这种跨面板丢配置。
 */
export async function handleDisabledRoute(ctx) {
  const { method, pathname, readJsonBody, configDir } = ctx || {}
  if (pathname !== '/disabled') return null
  if (method === 'GET') {
    const cur = readDisabled({ configDir })
    return { status: 200, body: { ok: true, agents: cur.agents, skills: cur.skills, file: 'disabled.json', readable: cur.ok } }
  }
  if (method !== 'PUT') return null
  let body
  try {
    body = await readJsonBody()
  } catch (e) {
    // 坏负载必须报错：静默写成"全开"会让用户的停用清单在下次点开关时无声消失。
    return { status: 400, body: { ok: false, error: `请求体不是合法 JSON：${e.message}` } }
  }
  const cur = readDisabled({ configDir })
  const has = (k) => body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, k)
  const next = {
    agents: has('agents') ? body.agents : cur.agents,
    skills: has('skills') ? body.skills : cur.skills,
  }
  const w = writeDisabled({ configDir, data: next })
  if (!w.ok) return { status: 500, body: { ok: false, error: w.error } }
  return { status: 200, body: { ok: true, ...w.data } }
}
