// src/stores/authStore.ts —— 认证状态机：authApi 结果 → phase/lockedForMs/pending/error 派发
// persist 不需要：token 本机 bridge 每次启动失效。
// AuthPhase 在端点四态（uninitialized/locked/ok）外加 'unknown'（未拉取）与 'setup-done'（客户端完成 setup 后置位）。
import { create } from 'zustand'
import { authStatus, authLogin, authSetup, authLogout, type AuthStatusResp } from '@/lib/authApi'

export type AuthPhase = 'unknown' | AuthStatusResp['phase'] | 'setup-done'

interface AuthState {
  phase: AuthPhase
  lockedForMs: number | null
  pending: boolean
  error: string | null
  init: () => Promise<void>
  setup: (pw: string) => Promise<boolean>
  login: (pw: string) => Promise<boolean>
  logout: () => Promise<void>
  setPhase: (p: AuthPhase) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  phase: 'unknown',
  lockedForMs: null,
  pending: false,
  error: null,
  async init() {
    const st = await authStatus()
    set({ phase: st.phase, lockedForMs: st.lockedForMs ?? null })
  },
  async setup(pw) {
    set({ pending: true, error: null })
    const r = await authSetup(pw)
    set({ pending: false })
    if (!r.ok) { set({ error: r.error ?? 'fail' }); return false }
    set({ phase: 'setup-done' })
    return true
  },
  async login(pw) {
    set({ pending: true, error: null })
    const r = await authLogin(pw)
    set({ pending: false })
    if (!r.ok) { set({ error: r.error ?? 'fail', lockedForMs: r.lockedForMs ?? null }); return false }
    set({ phase: 'ok' })
    return true
  },
  async logout() {
    set({ pending: true, error: null })
    const r = await authLogout()
    set({ pending: false })
    if (!r.ok) { set({ error: r.error ?? 'fail' }); return }
    set({ phase: 'locked' })
  },
  setPhase(p) { set({ phase: p }) },
}))
