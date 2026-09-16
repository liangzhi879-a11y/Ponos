// src/lib/disabledApi.ts —— Agent / Skill 全局停用注册表的客户端（2026-09-15，P1 D 条款）。
//
// 三条纪律（都是本仓库既有教训，不是洁癖）：
//   ① **PUT 只发要改的键**：桥/内核侧的写语义是"未传入的键保持原值"。若这里总是发
//      `{agents, skills}` 全量，两个面板（agent / skill）就会互相覆盖对方的停用清单——
//      用户会撞上"停用了 agent → 去技能面板点一下 → agent 又能跑了"。
//   ② **失败不静默**：写失败必须把错误交回调用方由界面出声。开关是"用户以为已生效"的典型
//      场景，静默失败会让人长期以为某个技能已被停用。
//   ③ **读失败降级为空清单但透出 readable**：注册表损坏时"界面显示全开"是对的（内核也按全开处理），
//      但必须让界面能说明"读取失败"，否则用户会以为自己的停用配置丢了。

export type DisabledState = {
  agents: string[]
  skills: string[]
  /** false = 注册表存在但读不出来；界面据此提示"配置读取失败，当前按全部启用处理" */
  readable: boolean
}

const BASE = 'http://127.0.0.1:3939'

/** 归一：去空、去重、保序（与内核 normalizeDisabled 同口径）。 */
export function normalizeIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((s) => String(s ?? '').trim()).filter(Boolean))]
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, init)
}

/** 读取停用注册表。网络异常时返回"全开 + unreadable"，绝不抛给渲染层。 */
export async function fetchDisabled(): Promise<DisabledState> {
  try {
    const r = await req('/disabled')
    if (!r.ok) return { agents: [], skills: [], readable: false }
    const j = await r.json() as Partial<DisabledState>
    return { agents: normalizeIdList(j.agents), skills: normalizeIdList(j.skills), readable: j.readable !== false }
  } catch {
    // 桥未就绪（应用启动早期）不该让面板报错：按"全部启用"展示，readable=false 供界面说明。
    return { agents: [], skills: [], readable: false }
  }
}

/**
 * 写入停用清单（**只发要改的键**，见文件头 ①）。
 * @returns 成功返回 `null`，失败返回可展示的错误文案
 */
export async function saveDisabled(patch: { agents?: string[]; skills?: string[] }): Promise<string | null> {
  const body: Record<string, string[]> = {}
  if (patch.agents !== undefined) body.agents = normalizeIdList(patch.agents)
  if (patch.skills !== undefined) body.skills = normalizeIdList(patch.skills)
  if (!Object.keys(body).length) return null   // 无事可做：不发空请求（避免触发无谓的重启判定）
  try {
    const r = await req('/disabled', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      return `保存失败（HTTP ${r.status}）${t ? `：${t.slice(0, 120)}` : ''}`
    }
    return null
  } catch (e) {
    return `保存失败：${(e as Error)?.message || e}`
  }
}

/** 在清单里切换某 id 的停用状态（纯函数，供组件与单测共用）。 */
export function toggleDisabledId(current: string[], id: string, disabled: boolean): string[] {
  const list = normalizeIdList(current)
  const target = String(id ?? '').trim()
  if (!target) return list
  const has = list.includes(target)
  if (disabled && !has) return [...list, target]
  if (!disabled && has) return list.filter((x) => x !== target)
  return list
}
