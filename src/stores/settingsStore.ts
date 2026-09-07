import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppSettings, YFWorkingConfig, ModelProvider, YFWorkingConfigV2 } from '@/types'
import { useChatStore } from './chatStore'
import { verifyActiveProvider, type ProviderVerifyResult } from '@/lib/config'

/** Show a system notification through Electron's Notification API (cross-platform).
 *  Falls back silently in dev mode (no preload → no yfworkingAPI). */
function notify(title: string, body: string) {
  try {
    const api = (typeof window !== 'undefined' ? (window as any).yfworkingAPI : null)
    if (api?.notifyTaskComplete) api.notifyTaskComplete({ title, body, onlyBackground: false })
    else if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('yfworking:notify', { detail: { title, body } }))
  } catch { /* ignore */ }
}

/** Fire a one-shot CLI verification of the active provider and surface the
 *  result through a system notification. Runs in the background — never
 *  blocks the UI or the user's current conversation. */
async function runVerifyAndNotify() {
  notify('正在验证模型配置', '正在后台启动 CLI 进程验证新模型...')
  const res: ProviderVerifyResult = await verifyActiveProvider()
  if (res.ok) {
    notify(
      '✅ 模型切换成功',
      `模型已激活: ${res.model || '已应用'}\n延迟: ${res.latencyMs}ms`
    )
  } else {
    notify(
      '⚠️ 模型验证失败',
      `CLI 无法使用新配置启动。\n错误: ${res.error || '未知'}${res.stderr ? `\n详情: ${res.stderr.slice(0, 200)}` : ''}`
    )
  }
}

const defaultSettings: AppSettings = {
  theme: 'yuanfang-light',
  language: 'zh-CN',
  fontSize: 14,
  fontFamily: 'Inter',
  sendOnEnter: true,
  interjectShortcut: 'ctrl+enter',
  showTimestamps: true,
  compactMode: false,
  showThinking: true,
  autoScroll: true,

  glassOpacity: 0.30,
  glassAurora: true,
  glassHueShift: 0,           // 【plan §3 步骤 7】色调偏移（度），仅玻璃主题生效
  speedMode: false,
  speedModePromptDismissed: false,

  model: 'deepseek-chat',
  maxTokens: 4096,
  temperature: 0.7,
  systemPrompt: '',

  apiUrl: 'https://api.deepseek.com/anthropic',
  apiKey: '',
  streamingEnabled: true,

  autoApproveFileRead: false,
  autoApproveFileWrite: false,
  autoApproveBash: false,
  autoApproveWebSearch: false,
  restrictedDirectories: [],

  sidebarOpen: true,
  sidebarWidth: 300,

  // YFWorking multi-provider config
  // Model names verified against official docs (2026-08):
  //   DeepSeek: deepseek-v4-flash (1M, 思考模式可切换), deepseek-v4-pro (1M, 旗舰)
  //     旧名 deepseek-chat / deepseek-reasoner 已于 2026/07/24 弃用。
  //   MiniMax:  MiniMax-M3[1m] (1M 上下文, anthropic 兼容端点)
  activeProvider: 'deepseek',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      apiBaseUrl: 'https://api.deepseek.com/anthropic',
      authToken: '',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      primaryModel: 'deepseek-v4-pro',
      subagentModel: 'deepseek-v4-flash',
      visionModel: '',
      effortLevel: 'max',
      contextWindow: 1000000,
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      apiBaseUrl: 'https://api.minimaxi.com/anthropic',
      authToken: '',
      models: ['MiniMax-M3[1m]'],
      primaryModel: 'MiniMax-M3[1m]',
      subagentModel: 'MiniMax-M3[1m]',
      visionModel: '',
      effortLevel: 'max',
      contextWindow: 1000000,
    },
  ] as ModelProvider[],
  skillRoot: '',
  autoCapture: true,
  autoImageBridge: true,
  // 视觉模型来源 provider id（空=跟随 activeProvider），视觉模型取自该 provider 的 visionModel
  visionProviderId: '',

  minimizeToTray: true,
  notifyMode: 'background' as const,
  petEnabled: false,
  petSize: 35,
  petRandomChat: true,
}

interface SettingsState {
  settings: AppSettings
  updateSettings: (updates: Partial<AppSettings>) => void
  updateYFWorkingConfig: (updates: Partial<YFWorkingConfig>) => void
  setYFWorkingConfig: (cfg: YFWorkingConfigV2) => void
  updateActiveProvider: (providerId: string) => void
  updateProvider: (providerId: string, updates: Partial<ModelProvider>) => void
  addProvider: (provider: ModelProvider) => void
  removeProvider: (providerId: string) => void
  resetSettings: () => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      updateSettings: (updates) => {
        const prevActiveProvider = get().settings.activeProvider
        set(state => ({ settings: { ...state.settings, ...updates } }))
        // Only act when the active provider actually changed. The settings
        // panel syncs from the bridge every time it opens, calling this with
        // activeProvider — acting unconditionally would kill the running
        // conversation's CLI session and spawn a verify probe on every open.
        if (updates.activeProvider !== undefined && updates.activeProvider !== prevActiveProvider) {
          const activeId = useChatStore.getState().activeConversationId
          if (activeId) useChatStore.getState().invalidateSession(activeId)
          // Probe: spawn a one-shot CLI process to confirm the new provider
          // actually works, then kill it. Frontend gets a system notification.
          void runVerifyAndNotify()
        }
      },
      updateYFWorkingConfig: (updates) => {
        set(state => {
          const active = state.settings.providers.find(p => p.id === state.settings.activeProvider)
          if (!active) return state
          const updated = state.settings.providers.map(p =>
            p.id === active.id ? { ...p, ...updates } : p
          )
          return {
            settings: {
              ...state.settings,
              providers: updated,
              ...(updates.skillRoot !== undefined ? { skillRoot: updates.skillRoot } : {}),
              ...(updates.autoCapture !== undefined ? { autoCapture: updates.autoCapture } : {}),
            },
          }
        })
        // Active provider fields (authToken/baseUrl/primaryModel/etc.) changed —
        // drop the running CLI session so the next message spawns with new env vars.
        const activeId = useChatStore.getState().activeConversationId
        if (activeId) useChatStore.getState().invalidateSession(activeId)
        // Probe the new config in the background.
        void runVerifyAndNotify()
      },
      setYFWorkingConfig: (cfg) => {
        set(state => ({
          settings: {
            ...state.settings,
            activeProvider: cfg.activeProvider,
            providers: cfg.providers,
            skillRoot: cfg.skillRoot,
            autoCapture: cfg.autoCapture,
            autoImageBridge: cfg.autoImageBridge !== false,
            visionProviderId: cfg.visionProviderId || '',
          },
        }))
        // Bridge-saved config may have changed active provider or its model —
        // invalidate the running CLI session so the next message spawns fresh.
        const activeId = useChatStore.getState().activeConversationId
        if (activeId) useChatStore.getState().invalidateSession(activeId)
        void runVerifyAndNotify()
      },
      updateActiveProvider: (providerId) => {
        set(state => ({ settings: { ...state.settings, activeProvider: providerId } }))
      },
      updateProvider: (providerId, updates) => {
        set(state => ({
          settings: {
            ...state.settings,
            providers: state.settings.providers.map(p =>
              p.id === providerId ? { ...p, ...updates } : p
            ),
          },
        }))
      },
      addProvider: (provider) => {
        set(state => ({
          settings: {
            ...state.settings,
            providers: [...state.settings.providers, provider],
          },
        }))
      },
      removeProvider: (providerId) => {
        set(state => ({
          settings: {
            ...state.settings,
            providers: state.settings.providers.filter(p => p.id !== providerId),
            activeProvider: state.settings.activeProvider === providerId
              ? (state.settings.providers.find(p => p.id !== providerId)?.id || 'deepseek')
              : state.settings.activeProvider,
          },
        }))
      },
      resetSettings: () => set({ settings: { ...defaultSettings } }),
    }),
    {
      name: 'yfworking-settings',
      // Migrate old persisted state to include new fields with defaults
      onRehydrateStorage: () => (state) => {
        if (state?.settings) {
          // Ensure all default keys exist (fill in any missing ones)
          state.settings = { ...defaultSettings, ...state.settings }
          state.settings.glassHueShift ??= 0 // 【plan §3 步骤 7】兜底旧持久化数据
          state.settings.autoImageBridge ??= true // 自动图片桥接默认开启
          state.settings.visionProviderId ??= '' // 视觉来源默认跟随 activeProvider
        }
      },
    }
  )
)
