/**
 * Centralized configuration — reads from:
 *   Layer 1: import.meta.env.VITE_* (from .env file)
 *   Layer 2: runtime setConfig() overrides
 *   Layer 3: sensible defaults
 */

import type { ModelProvider, PonosConfigV2 } from '@/types'

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

export function getBridgeUrl(): string {
  return import.meta.env.VITE_BRIDGE_URL || `http://localhost:${__BRIDGE_PORT__}`
}

export function getWsUrl(): string {
  return getBridgeUrl().replace(/^http/, 'ws')
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

export function getDefaultHome(): string {
  const envHome = import.meta.env.VITE_DEFAULT_HOME
  if (envHome && envHome !== 'auto') return envHome
  // Runtime detection via preload (works on any machine — preload has Node.js access)
  if (typeof window !== 'undefined' && window.ponosAPI?.userHome) return window.ponosAPI.userHome
  if (typeof process !== 'undefined' && process.env?.HOME) return process.env.HOME
  if (typeof process !== 'undefined' && process.env?.USERPROFILE) return process.env.USERPROFILE
  return ''
}

// ---------------------------------------------------------------------------
// Ponos bridge config
// ---------------------------------------------------------------------------

export async function fetchBridgeConfig(): Promise<PonosConfigV2> {
  const res = await fetch(`${getBridgeUrl()}/config`)
  if (!res.ok) throw new Error('Failed to fetch config')
  return res.json()
}

export async function saveBridgeConfig(cfg: Partial<PonosConfigV2>): Promise<boolean> {
  const res = await fetch(`${getBridgeUrl()}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  if (!res.ok) return false
  const data = await res.json()
  return data.ok === true
}

export async function addProvider(provider: Partial<ModelProvider>): Promise<ModelProvider | null> {
  const res = await fetch(`${getBridgeUrl()}/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(provider),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.ok ? data.provider : null
}

export async function updateProvider(providerId: string, updates: Partial<ModelProvider>): Promise<boolean> {
  const res = await fetch(`${getBridgeUrl()}/providers/${providerId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) return false
  const data = await res.json()
  return data.ok === true
}

export async function deleteProvider(providerId: string): Promise<boolean> {
  const res = await fetch(`${getBridgeUrl()}/providers/${providerId}`, {
    method: 'DELETE',
  })
  if (!res.ok) return false
  const data = await res.json()
  return data.ok === true
}

export interface ProviderTestResult {
  ok: boolean
  reachable: boolean
  httpStatus?: number
  endpoint?: string
  detail?: string
  authValid?: boolean
  error?: string
}

/**
 * Probe a provider's API endpoint with a minimal request to verify
 * connectivity and credentials before saving. The bridge forwards the
 * request server-side to avoid CORS issues from the renderer.
 */
export async function testProviderConnection(provider: Partial<ModelProvider>): Promise<ProviderTestResult> {
  const res = await fetch(`${getBridgeUrl()}/test-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiBaseUrl: provider.apiBaseUrl,
      authToken: provider.authToken,
      model: provider.primaryModel || (provider.models && provider.models[0]),
      models: provider.models,
    }),
  })
  if (!res.ok) {
    return { ok: false, reachable: false, error: `HTTP ${res.status}` }
  }
  return res.json()
}

/**
 * One-shot probe of the currently active provider: the bridge spawns a CLI
 * process with the latest env vars, waits for the `system/init` event
 * (proof CLI loaded the new model + auth), then kills the process. Used by
 * the UI after a provider/model switch so the user gets confirmation the
 * change took effect — without having to start a new conversation.
 */
export interface ProviderVerifyResult {
  ok: boolean
  model?: string
  tools?: string[]
  latencyMs?: number
  error?: string
  stderr?: string
}

export async function verifyActiveProvider(): Promise<ProviderVerifyResult> {
  try {
    const res = await fetch(`${getBridgeUrl()}/verify-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return await res.json()
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Verification request failed' }
  }
}
