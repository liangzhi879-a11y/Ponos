import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppSettings, YFWorkingConfig, ModelProvider, YFWorkingConfigV2 } from '@/types'
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from '@/lib/approvalModeUi'
import { DEFAULT_LOG_POLICY, normalizeLogPolicyUi } from '@/lib/logUi'
import { DEFAULT_KNOWLEDGE_IMPORT_POLICY, normalizeKnowledgeImportPolicyUi } from '@/lib/knowledgeImportUi'
import { useChatStore } from './chatStore'
import { verifyActiveProvider, type ProviderVerifyResult } from '@/lib/config'
import { migrateThemeId } from '@/lib/themeMap'
import { deleteSecret, describeVaultError, getVaultApi, loadAllSecrets, saveSecret } from '@/lib/vaultApi'
import {
  applySecretsToSettings,
  collectSecrets,
  createHydrationGate,
  planHydration,
  planSecretSync,
  providerTokenKey,
  stripSecretsFromPersisted,
} from '@/lib/providerSecrets'

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
  // 子代理并发上限（第 10 项，2026-09-17）：'auto' = 按系统配置推导（内核默认，
  // 不注入 env）；'0' = 不限；数字串 = 显式上限。经 buildChildEnv 注入
  // PONOS_LANE_MAX_CONCURRENT（只影响新 spawn 的内核进程）
  maxSubAgents: 'auto',

  // 审批放行档位（全局，2026-09-12）：'loose' = 应用今天的真实行为（桥硬编码
  // --dangerously-skip-permissions）→ 存量用户零行为变化。设置页改这里（持久化 +
  // saveBridgeConfig 落盘）；状态栏改的是本会话临时覆盖，不进这个字段。
  approvalMode: DEFAULT_APPROVAL_MODE,

  // 运行日志持久化策略（全局，2026-09-12）：与 server/log-policy.cjs 的默认值同源
  // （parity 测试钉住）；写入端读桥 config.json，这里是 GUI 的显示与编辑副本。
  logPolicy: DEFAULT_LOG_POLICY,

  // 知识库文件导入上限（全局，2026-09-14）：与 server/knowledge-import-policy.cjs 的默认值
  // 同源（parity 测试钉住）。默认 500 文件 / 300MB —— 保守，因为超限是**整批拒绝**
  // （一个都不导），宁可让用户显式放宽，也不要默默吃掉服务器内存。
  knowledgeImport: DEFAULT_KNOWLEDGE_IMPORT_POLICY,

  minimizeToTray: true,
  notifyMode: 'background' as const,
  petEnabled: false,
  petSize: 35,
  petRandomChat: true,
}

interface SettingsState {  settings: AppSettings
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
      /**
       * 落盘（localStorage）**剥掉一切密钥**（2026-09-15）：
       * providers[].authToken / apiKey 的真相源改为密码库（safeStorage 加密）。
       * 只改"要落盘的那份"，内存状态不变——否则正在用的密钥会当场消失。
       * ⚠️ 加字段时记得检查是否是秘密：新密钥字段必须同时进 stripSecretsFromPersisted。
       */
      partialize: (state) => ({ settings: stripSecretsFromPersisted(state.settings) }),
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
          // 审批档位 / 日志策略（2026-09-12）：旧快照无键 → 落默认档（loose = 等价旧
          // 行为；日志 5MB×3+14 天）。**用归一而非 ??=**：脏值（手改 localStorage、
          // 旧版本残留）不能带着越界数字进轮转器，否则轮转器按坏参数运行。
          state.settings.approvalMode = normalizeApprovalMode(state.settings.approvalMode)
          state.settings.logPolicy = normalizeLogPolicyUi(state.settings.logPolicy)
          // 导入上限同理：越界值（手改 localStorage / 旧版本残留）绝不能进导入路径，
          // 否则会拿一个 0 或天文数字去请求内核（0 会被判非法、天文数字会撑爆内存）。
          state.settings.knowledgeImport = normalizeKnowledgeImportPolicyUi(state.settings.knowledgeImport)
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

// ============================================================================
// 密钥迁入密码库（2026-09-15）
//
// 背景：此前 providers[].authToken / apiKey 以**明文**存在 localStorage。
// 现在库是唯一真相源，localStorage 只留非秘密配置（见上面 partialize）。
//
// 顺序很关键（错一步就会把用户 API Key 清掉）：
//   1. 注水前：闸门关闭，任何写回都跳过（此刻内存里"没有密钥"不代表"密钥该没有"）；
//   2. 读库 → 库里有值 ⇒ 注回内存；内存有值而库里没有 ⇒ 迁移写库（首次搬迁明文）；
//   3. 注水完成后才打开闸门，之后按差量写回；
//   4. 最后强制重写一次持久化，把 localStorage 里**残留的旧明文**擦掉
//      （partialize 只影响"以后的写入"，历史快照得靠这一次覆盖）。
// 全程 fire-and-forget：密钥同步失败不该阻塞 UI（失败时下次启动会重试迁移）。
// ============================================================================
const secretGate = createHydrationGate()
/** 本轮已同步到库的快照，用于算差量（避免每次 set 都写盘） */
let syncedSecrets: Record<string, string> = {}

/** 读库→注水→迁移→擦除本地明文。可重复调用（幂等）。 */
export async function hydrateSecretsFromVault(): Promise<{ ok: boolean; migrated: number; error?: string }> {
  const api = getVaultApi()
  if (!api) return { ok: false, migrated: 0, error: '当前环境不支持密码库（仅桌面端可用）' }
  try {
    // 闸门此刻必须是关闭的：下面要基于"库 + 内存"做一次性决策
    const res = await loadAllSecrets()
    if (!res.ok) {
      // 读不出来（未启用/损坏）⇒ **保持闸门关闭**：宁可本次不写回，
      // 也不能用一个空的库视图去覆盖用户真实存在的密钥
      return { ok: false, migrated: 0, error: describeVaultError(res.error, res.message) }
    }
    const inMemory = collectSecrets(useSettingsStore.getState().settings)
    const { toWrite, toApply } = planHydration(inMemory, res.secrets)

    // 2a) 首次迁移：把既有明文搬进库
    let migrated = 0
    for (const [k, v] of Object.entries(toWrite)) {
      const r = await saveSecret(k, v)
      if (r.ok) migrated += 1
    }
    // 2b) 注入内存（库优先）
    if (Object.keys(toApply).length > 0) {
      useSettingsStore.setState(s => ({ settings: applySecretsToSettings(s.settings, toApply) }))
    }
    syncedSecrets = { ...res.secrets, ...toWrite }
    secretGate.markHydrated()
    // 4) 擦掉 localStorage 里的历史明文（此时才允许写入）
    useSettingsStore.setState(s => ({ settings: { ...s.settings } }))
    return { ok: true, migrated }
  } catch (e) {
    return { ok: false, migrated: 0, error: (e as Error)?.message }
  }
}

/** 差量写回。注水前直接跳过（见闸门注释）。 */
async function syncSecretsToVault(settings: AppSettings): Promise<void> {
  if (!secretGate.canSync()) return
  const inMemory = collectSecrets(settings)
  const ops = planSecretSync(inMemory, syncedSecrets)
  const keys = Object.keys(ops)
  if (keys.length === 0) return
  for (const k of keys) {
    const r = await saveSecret(k, ops[k])   // 空串即删除（用户清空了 token 输入框）
    if (r.ok) syncedSecrets[k] = ops[k]
  }
}

if (typeof window !== 'undefined') {
  // 订阅 store：一处覆盖全部改密钥的入口（updateProvider / addProvider /
  // setYFWorkingConfig / resetSettings…），不必逐个 setter 记得写库
  useSettingsStore.subscribe((state) => { void syncSecretsToVault(state.settings) })
}

/** 删除某供应商时显式清掉它的密钥（删除是破坏性动作，必须显式，不由差量推断） */
export async function deleteProviderSecret(providerId: string): Promise<void> {
  const key = providerTokenKey(providerId)
  const r = await deleteSecret(key)
  if (r.ok) delete syncedSecrets[key]
}
