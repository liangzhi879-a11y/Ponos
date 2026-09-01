// src/lib/moduleBridge.ts
// 渲染层模块窗口桥接：URL 解析 + window.ponosModules / window.ponosBus IPC 封装。
// 纯函数 parseModuleUrl 可单测；IPC 封装均走可选链兜底，非模块窗口返回安全空值。
import type { BusEvent, ModuleDescriptor } from '@/types'

export interface ParsedModuleUrl {
  moduleId: string | null
  params: Record<string, string>
}

/** 纯函数：从 URL 解析模块 id 与参数（可单测）。 */
export function parseModuleUrl(url: string): ParsedModuleUrl {
  try {
    const u = new URL(url)
    const moduleId = u.searchParams.get('module')
    const params: Record<string, string> = {}
    for (const [k, v] of u.searchParams.entries()) {
      if (k !== 'module') params[k] = v
    }
    return { moduleId, params }
  } catch {
    return { moduleId: null, params: {} }
  }
}

export function getModuleId(): string | null {
  if (typeof window === 'undefined') return null
  return parseModuleUrl(window.location.href).moduleId
}

export function getModuleParam(key: string): string | null {
  if (typeof window === 'undefined') return null
  return parseModuleUrl(window.location.href).params[key] ?? null
}

export function isModuleWindow(): boolean {
  return getModuleId() !== null
}

// --- IPC 封装（窗口内可选链兜底，非模块窗口返回安全空值） ---

export async function listModules(): Promise<ModuleDescriptor[]> {
  try { return await window.ponosModules?.list() ?? [] } catch { return [] }
}

export async function openModule(id: string, params?: Record<string, string>) {
  try { return await window.ponosModules?.open(id, params) ?? { ok: false, error: 'ponosModules unavailable' } }
  catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function closeModule(id: string) {
  try { return await window.ponosModules?.close(id) ?? { ok: false } } catch { return { ok: false } }
}

export function publishBus(event: BusEvent): void {
  window.ponosBus?.publish(event)
}

export function subscribeBus(channel: string, cb: (e: BusEvent) => void): () => void {
  return window.ponosBus?.onEvent(channel, cb) ?? (() => {})
}

export async function getSnapshot(channel: string): Promise<BusEvent[]> {
  try { return await window.ponosBus?.getSnapshot(channel) ?? [] } catch { return [] }
}
