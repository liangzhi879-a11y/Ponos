import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppSettings, YFWorkingConfig, ModelProvider, YFWorkingConfigV2 } from '@/types'
import { useChatStore } from './chatStore'
import { verifyActiveProvider, type ProviderVerifyResult } from '@/lib/config'
import { migrateThemeId } from '@/lib/themeMap'

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
  theme: 'dark',
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
      // 0 = 自动（2026-09-11）：内核按模型表解析——v4-flash=200K / v4-pro=1M。
      // 旧固定 1M 在 flash 上虚高（真实 200K），压缩阈值按 1M 算永不触发，
      // 大会话每轮全量重发 1MB 请求（实测"切 DS 也卡"根因）。
      contextWindow: 0,
      // 画像与高级参数缺省（云端：温度 0 / 预算 64000 由内核默认，无注入）
      profile: 'auto',
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
      profile: 'auto',
    },
  ] as ModelProvider[],
  skillRoot: '',
  autoCapture: true,
  autoImageBridge: true,
  // 视觉模型来源 provider id（空=跟随 activeProvider），视觉模型取自该 provider 的 visionModel
  visionProviderId: '',
  // 思考深度（全局，Task 12）：'auto' = 内核默认（不注入 env）；非 auto 新会话
  // spawn 注入 + 运行中会话 WS 热切换
  effortLevel: 'auto',

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
        // activeProvider — acting unconditionally would spawn a verify probe
        // on every open. 会话切换由 bridge 在下次 send 时按 provider 环境
        // 签名自动收割重启（2026-09-10 模型热切换修复）——前端不再清
        // sessionId，--resume 历史无缝保留。
        if (updates.activeProvider !== undefined && updates.activeProvider !== prevActiveProvider) {
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
        // 会话切换由 bridge 下次 send 按 provider 环境签名自动收割重启
        //（2026-09-10 模型热切换修复），前端保留 sessionId 供 --resume。
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
        // 会话切换由 bridge 下次 send 按 provider 环境签名自动收割重启
        //（2026-09-10 模型热切换修复），前端保留 sessionId 供 --resume。
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
          // 主题 ID 收敛 6→4 归一（spec §1.1）：旧值/未知值一次性映射
          state.settings.theme = migrateThemeId(state.settings.theme)
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

// 跨窗口设置同步（2026-09-10 设置外置）：独立设置窗修改持久化后，主窗口经
// storage 事件重灌 store——主题/字号等 UI 设置双窗即时一致（zustand persist
// 默认不监听跨窗口 storage 变更）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'yfworking-settings') useSettingsStore.persist.rehydrate()
  })
}
