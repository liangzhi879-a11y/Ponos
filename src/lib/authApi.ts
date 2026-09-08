// src/lib/authApi.ts —— bridge /api/auth/* HTTP 封装（fetch 域，引 @ alias + DOM fetch，node 不直测）
// 宽容语义：authStatus 失败 catch → { phase:'ok' }——端点未就绪（dev 无 auth 环境）时不卡启动。
// authSetup/authLogin/authLogout：错误统一返回结构化 AuthResult（不 throw），含 HTTP 非 2xx 与网络异常两路。
import { getBridgeUrl } from '@/lib/config'

export interface AuthStatusResp { phase: 'uninitialized' | 'locked' | 'ok'; lockedForMs?: number }
export interface AuthResult { ok: boolean; token?: string; error?: string; lockedForMs?: number | null }

async function post(path: string, body: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`${getBridgeUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error, lockedForMs: data.lockedForMs }
    return data
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export function authStatus(): Promise<AuthStatusResp> {
  return fetch(`${getBridgeUrl()}/api/auth/status`)
    .then((r) => r.json())
    .catch(() => ({ phase: 'ok' }))
}

export const authSetup = (password: string) => post('/api/auth/setup', { password })
export const authLogin = (password: string) => post('/api/auth/login', { password })
export const authLogout = (token?: string) => post('/api/auth/logout', { token })
