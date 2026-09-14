import { useState, useEffect, useRef } from 'react'
import { Settings, Monitor, Cpu, Info, Check, Sparkles, Globe, Save, Database, FolderOpen, Brain, ChevronDown, Plus, X, Trash2, Puzzle, ChevronRight, HardDrive, RefreshCw, Wifi, Zap, ShieldCheck, FileText, Upload } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, ScrollArea, Switch,
} from '@/components/ui'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { useYFWCLI, sendEffort } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { cn, formatShortcut, shortcutFromEvent } from '@/lib/utils'
import { fetchSkills } from '@/lib/skills'
import { fetchBridgeConfig, saveBridgeConfig, addProvider, deleteProvider, testProviderConnection, probeProvider } from '@/lib/config'
import { EFFORT_OPTIONS, normalizeEffortUi } from '@/lib/effortUi'
import { normalizeApprovalMode } from '@/lib/approvalModeUi'
import { normalizeLogPolicyUi } from '@/lib/logUi'
import { normalizeKnowledgeImportPolicyUi } from '@/lib/knowledgeImportUi'
// 视觉能力/来源判定：唯一实现在 lib（知识库导入提示与本页共用，避免两处口径分叉）
import { resolveVisionProvider } from '@/lib/visionUi'
import { ExperiencePanel } from '@/components/settings/ExperiencePanel'
import { PermissionsPanel } from '@/components/settings/PermissionsPanel'
import { LogsPanel } from '@/components/settings/LogsPanel'
import { KnowledgeImportPanel } from '@/components/settings/KnowledgeImportPanel'
import type { AppSettings, ModelProvider, YFWorkingConfigV2 } from '@/types'
import { THEMES, type ThemeMode, type ThemeMeta, type Language } from '@/types'

type Section = 'general' | 'model' | 'permissions' | 'logs' | 'knowledgeImport' | 'skills' | 'pet' | 'experience' | 'about'

export function SettingsView() {
  const { settings, updateSettings } = useSettingsStore()
  const { sessionModel } = useChatStore()
  const { connected } = useYFWCLI()
  const { t } = useTranslation()
  const [section, setSection] = useState<Section>('general')
  // 添加供应商子对话框的打开标志（对话框内部自管 outside-click，无需外层守卫）
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)

  // 2026-09-10 页面化重构：原 Radix 弹窗壳退役——独立窗口内的完整页面布局：
  // 页头（标题）+ 左侧分区导航 + 右侧内容滚动区。窗口关闭由 UtilityWindowShell
  // 拖拽条上的关闭钮承担。
  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="h-12 flex items-center gap-2.5 px-5 border-b shrink-0">
        <Settings className="w-[18px] h-[18px] text-brand-500" />
        <h1 className="text-sm font-semibold text-primary">{t('settings.title')}</h1>
        <span className="text-[10px] font-mono text-tertiary mt-px">v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}</span>
      </header>
        <div className="flex-1 flex min-h-0">
          <nav className="w-52 shrink-0 border-r py-3 overflow-y-auto">
            {[
              { id: 'general' as Section, label: t('settings.general'), icon: Monitor },
              { id: 'model' as Section, label: t('settings.model'), icon: Cpu },
              // 权限档位 / 日志策略（2026-09-12）：两个新分区的全局设置入口
              { id: 'permissions' as Section, label: t('settings.permissionsTab'), icon: ShieldCheck },
              { id: 'logs' as Section, label: t('settings.logsTab'), icon: FileText },
              // 知识库导入上限（2026-09-14）：批量导入的护栏可配入口
              { id: 'knowledgeImport' as Section, label: t('settings.importTab'), icon: Upload },
              { id: 'skills' as Section, label: t('settings.skillsTab'), icon: Puzzle },
              { id: 'pet' as Section, label: t('settings.petTab'), icon: Sparkles },
              { id: 'experience' as Section, label: t('settings.experienceTab'), icon: Brain },
              { id: 'about' as Section, label: t('settings.about'), icon: Info },
            ].map(item => {
              const Icon = item.icon
              const active = section === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-4 py-2 mx-2 rounded-lg text-sm transition-colors',
                    active
                      ? 'text-primary bg-brand-500/15 font-medium'
                      : 'text-secondary hover:text-primary hover:bg-elevated'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </button>
              )
            })}
          </nav>
          <ScrollArea className="flex-1 min-w-0">
            <div className="p-6 max-w-3xl">
              {section === 'general' && (
                <div className="space-y-6">
                  {/* Language */}
                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                      <Globe className="w-4 h-4" />
                      {t('settings.language')}
                      <span className="micro ml-1">LANGUAGE</span>
                    </h3>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { id: 'zh-CN' as Language, label: t('settings.chinese'), flag: '🇨🇳' },
                        { id: 'en-US' as Language, label: t('settings.english'), flag: '🇺🇸' },
                      ]).map(lang => (
                        <button
                          key={lang.id}
                          onClick={() => updateSettings({ language: lang.id })}
                          className={cn(
                            'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all',
                            settings.language === lang.id
                              ? 'border-brand-500/50 bg-brand-500/10 text-primary'
                              : 'border bg-surface text-secondary hover:border hover:text-primary'
                          )}
                        >
                          <span className="text-base">{lang.flag}</span>
                          <span className="font-medium">{lang.label}</span>
                          {settings.language === lang.id && (
                            <Check className="w-4 h-4 ml-auto text-brand-500" />
                          )}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-tertiary mt-2">{t('settings.languageDesc')}</p>
                  </div>

                  <div className="h-px bg-elevated" />

                  <ThemePicker
                    value={settings.theme}
                    onChange={t => updateSettings({ theme: t })}
                    t={t}
                  />

                  <div className="h-px bg-elevated" />

                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3">{t('settings.appearance')}<span className="micro ml-1">APPEARANCE</span></h3>
                    <div className="space-y-3">
                      <SettingRow label={t('settings.fontSize')}>
                        <select
                          value={settings.fontSize}
                          onChange={e => updateSettings({ fontSize: Number(e.target.value) })}
                          className="h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        >
                          {[12, 13, 14, 15, 16, 18, 20].map(n => (
                            <option key={n} value={n}>{n}px</option>
                          ))}
                        </select>
                      </SettingRow>

                      {/* Glass 磨砂玻璃设置 —— 仅 dark-glass / light-glass 主题显示 */}
                      {(settings.theme === 'dark-glass' || settings.theme === 'light-glass') && (
                        <>
                          <div>
                            <label className="flex items-center justify-between py-1">
                              <div>
                                <span className="text-sm text-secondary">{t('settings.glassOpacity')}</span>
                                <p className="text-[10px] text-tertiary mt-0.5">{t('settings.glassOpacityDesc')}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="range"
                                  min="0.3"
                                  max="0.98"
                                  step="0.05"
                                  value={settings.glassOpacity}
                                  onChange={e => updateSettings({ glassOpacity: Number(e.target.value) })}
                                  className="w-32 accent-brand-500"
                                />
                                <span className="text-xs text-primary w-10 text-right tabular-nums">{Math.round(settings.glassOpacity * 100)}%</span>
                              </div>
                            </label>
                          </div>
                          <label className="flex items-center justify-between py-1">
                            <div>
                              <span className="text-sm text-secondary">{t('settings.glassAurora')}</span>
                              <p className="text-[10px] text-tertiary mt-0.5">{t('settings.glassAuroraDesc')}</p>
                            </div>
                            <Switch
                              checked={settings.glassAurora}
                              onCheckedChange={v => updateSettings({ glassAurora: v })}
                            />
                          </label>
                          {/* plan §3 步骤 7 — 玻璃色调滑块（仅玻璃主题） */}
                          <div>
                            <label className="flex items-center justify-between py-1">
                              <div>
                                <span className="text-sm text-secondary">{t('settings.glassHueShift')}</span>
                                <p className="text-[10px] text-tertiary mt-0.5">{t('settings.glassHueShiftDesc')}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <input
                                  type="range"
                                  min="-180"
                                  max="180"
                                  step="5"
                                  value={settings.glassHueShift}
                                  onChange={e => updateSettings({ glassHueShift: Number(e.target.value) })}
                                  className="w-32 accent-brand-500"
                                />
                                <span className="text-xs text-primary w-10 text-right tabular-nums">{settings.glassHueShift}°</span>
                              </div>
                            </label>
                          </div>
                        </>
                      )}

                      {/* 极速形态 —— 任意主题生效 */}
                      <label className="flex items-center justify-between py-1">
                        <div>
                          <span className="text-sm text-secondary">{t('settings.speedMode')}</span>
                          <p className="text-[10px] text-tertiary mt-0.5">{t('settings.speedModeDesc')}</p>
                        </div>
                        <Switch
                          checked={settings.speedMode}
                          onCheckedChange={v => updateSettings({ speedMode: v })}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="h-px bg-elevated" />

                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3">{t('settings.backgroundNotify')}<span className="micro ml-1">NOTIFY</span></h3>
                    <div className="space-y-3">
                      <SettingRow label={t('settings.minimizeToTray')}>
                        <Switch
                          checked={settings.minimizeToTray}
                          onCheckedChange={v => updateSettings({ minimizeToTray: v })}
                        />
                      </SettingRow>
                      <p className="text-[10px] text-tertiary -mt-1.5">{t('settings.minimizeToTrayDesc')}</p>
                      <SettingRow label={t('settings.notifyMode')}>
                        <select
                          value={settings.notifyMode}
                          onChange={e => updateSettings({ notifyMode: e.target.value as 'background' | 'always' })}
                          className="h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                        >
                          <option value="background">{t('settings.notifyBackground')}</option>
                          <option value="always">{t('settings.notifyAlways')}</option>
                        </select>
                      </SettingRow>
                    </div>
                  </div>

                  <div className="h-px bg-elevated" />

                  {/* 打断插话快捷键 */}
                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                      <Zap className="w-4 h-4" />
                      {t('settings.interjectShortcut')}
                      <span className="micro ml-1">SHORTCUT</span>
                    </h3>
                    <label className="flex items-center justify-between py-1">
                      <div>
                        <span className="text-sm text-secondary">{t('settings.interjectShortcutDesc')}</span>
                      </div>
                      <ShortcutCapture
                        t={t}
                        value={settings.interjectShortcut}
                        onChange={s => updateSettings({ interjectShortcut: s })}
                      />
                    </label>
                    <p className="text-[10px] text-tertiary mt-1">{t('settings.interjectShortcutDesc2')}</p>
                  </div>
                </div>
              )}

              {section === 'model' && (
                <YFWorkingModelPanel
                  t={t}
                  settings={settings}
                  updateSettings={updateSettings}
                  showAddDialog={showAddProviderDialog}
                  setShowAddDialog={setShowAddProviderDialog}
                />
              )}

              {section === 'permissions' && <PermissionsPanel />}

              {section === 'logs' && <LogsPanel />}
              {section === 'knowledgeImport' && <KnowledgeImportPanel />}

              {section === 'skills' && (
                <SkillsPanel t={t} settings={settings} updateSettings={updateSettings} />
              )}

              {section === 'pet' && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
                      <Sparkles className="w-4 h-4" />
                      {t('settings.petTab')}
                    </h3>
                    <p className="text-xs text-tertiary mb-4">{t('settings.petDesc')}</p>

                    <div className="space-y-3">
                      {/* Enable desktop pet */}
                      <div>
                        <label className="flex items-center justify-between py-1">
                          <div>
                            <span className="text-sm text-secondary">{t('settings.petEnabled')}</span>
                            <p className="text-[10px] text-tertiary mt-0.5">{t('settings.petEnabledDesc')}</p>
                          </div>
                          <Switch
                            checked={settings.petEnabled}
                            onCheckedChange={v => updateSettings({ petEnabled: v })}
                          />
                        </label>
                      </div>

                      {/* Pet size slider */}
                      <div>
                        <label className="flex items-center justify-between py-1">
                          <div>
                            <span className="text-sm text-secondary">{t('settings.petSize')}</span>
                            <p className="text-[10px] text-tertiary mt-0.5">{t('settings.petSizeDesc')}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <input
                              type="range"
                              min="25"
                              max="200"
                              step="10"
                              value={settings.petSize}
                              onChange={e => updateSettings({ petSize: Number(e.target.value) })}
                              className="w-32 accent-brand-500"
                            />
                            <span className="text-xs text-primary w-10 text-right tabular-nums">{settings.petSize}%</span>
                          </div>
                        </label>
                      </div>

                      {/* Random speech bubbles */}
                      <div>
                        <label className="flex items-center justify-between py-1">
                          <div>
                            <span className="text-sm text-secondary">{t('settings.petRandomChat')}</span>
                            <p className="text-[10px] text-tertiary mt-0.5">{t('settings.petRandomChatDesc')}</p>
                          </div>
                          <Switch
                            checked={settings.petRandomChat}
                            onCheckedChange={v => updateSettings({ petRandomChat: v })}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {section === 'experience' && <ExperiencePanel />}

              {section === 'about' && (
                <div className="space-y-4 text-sm text-secondary">
                  <h3 className="text-sm font-semibold text-primary">YFWorking</h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-tertiary">Version</span>
                      <span>{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-tertiary">Bridge</span>
                      <span className={connected ? 'text-success' : 'text-error'}>
                        {connected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-tertiary">CLI Session</span>
                      <span className="text-tertiary font-mono text-xs">{sessionModel || '—'}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
    </div>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-secondary">{label}</span>
      {children}
    </div>
  )
}

function YFWorkingModelPanel({ t, settings, updateSettings, showAddDialog, setShowAddDialog }: {
  t: (key: string, params?: Record<string, string | number>) => string
  settings: AppSettings
  updateSettings: (u: Partial<AppSettings>) => void
  showAddDialog: boolean
  setShowAddDialog: (v: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveOk, setSaveOk] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [newProvider, setNewProvider] = useState({ name: '', apiBaseUrl: '', modelList: '' })
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [testOk, setTestOk] = useState<boolean | null>(null)

  useEffect(() => {
    fetchBridgeConfig()
      .then(cfg => {
        updateSettings({
          activeProvider: cfg.activeProvider,
          providers: cfg.providers,
          skillRoot: cfg.skillRoot,
          autoCapture: cfg.autoCapture,
          autoImageBridge: cfg.autoImageBridge,
          visionProviderId: cfg.visionProviderId || '',
          // 顶层 effortLevel 从 bridge config 回读（旧 config 无此键 → normalize 兜底 'auto'）
          effortLevel: normalizeEffortUi(cfg.effortLevel),
          // 审批档位（2026-09-12）：磁盘 config.json 是全局档的唯一真源——桥侧 spawn
          // 与 WS 热切都读它，GUI 打开设置页时回读，避免"上次改完重启又变回来"。
          // 旧 config 无此键 → normalize 兜底 loose（= 等价旧行为）。
          approvalMode: normalizeApprovalMode(cfg.approvalMode),
          // 日志策略：同样以磁盘为准（写入端读的就是它）
          logPolicy: normalizeLogPolicyUi(cfg.logPolicy),
          // 知识库导入上限（2026-09-14）：同上，以磁盘为准（桥与主进程读的就是它）
          knowledgeImport: normalizeKnowledgeImportPolicyUi(cfg.knowledgeImport),
        })
      })
      .catch(() => {})
  }, [])

  const activeProv = (settings.providers || []).find(p => p.id === settings.activeProvider)
  const isBuiltin = (id: string) => id === 'deepseek' || id === 'minimax'
  /** 视觉模型来源 provider：判定收在 src/lib/visionUi.ts（与知识库导入提示同一份口径）。
   *  此前这里内联写过一遍同样的 find 逻辑 —— 两份判定迟早会分叉，故改为只消费。 */
  const visionProv = resolveVisionProvider(settings)

  const handleSwitchProvider = (providerId: string) => {
    updateSettings({ activeProvider: providerId })
  }

  const handleUpdateActiveProvider = (field: keyof ModelProvider, value: string | number | boolean | string[] | undefined) => {
    if (!activeProv) return
    const updated = (settings.providers || []).map(p =>
      p.id === activeProv.id ? { ...p, [field]: value } : p
    )
    updateSettings({ providers: updated as ModelProvider[] })
  }

  const handleAddProvider = async () => {
    const models = newProvider.modelList.split(',').map(s => s.trim()).filter(Boolean)
    const prov = await addProvider({
      name: newProvider.name,
      apiBaseUrl: newProvider.apiBaseUrl,
      models,
      primaryModel: models[0] || '',
      subagentModel: models[0] || '',
      effortLevel: 'max',
      // 0 = 自动（2026-09-10）：保存/激活后探测 /v1/models 回填真实窗口；探测不到
      // 时内核按内置模型表 / 画像默认（本地 64K、云端 200K）规划。旧默认 1000000
      // 对本地小窗口模型几乎必然虚高，是切换模型后上下文撑爆的根因之一。
      contextWindow: 0,
    })
    if (prov) {
      updateSettings({ providers: [...settings.providers, prov], activeProvider: prov.id })
      setNewProvider({ name: '', apiBaseUrl: '', modelList: '' })
      setShowAddDialog(false)
    }
  }

  const handleDeleteProvider = async (providerId: string) => {
    if (isBuiltin(providerId)) return
    if (!confirm(t('settings.deleteProviderConfirm').replace('{name}',  (settings.providers || []).find(p => p.id === providerId)?.name || ''))) return
    const ok = await deleteProvider(providerId)
    if (ok) {
      updateSettings({
        providers: settings.providers.filter(p => p.id !== providerId),
        activeProvider: settings.activeProvider === providerId
          ? (settings.providers.find(p => p.id !== providerId)?.id || 'deepseek')
          : settings.activeProvider,
      })
    }
  }

  const handleTestConnection = async (): Promise<boolean> => {
    if (!activeProv) return false
    if (!activeProv.apiBaseUrl || !activeProv.authToken) {
      setTestOk(false)
      setTestMsg(t('settings.testMissingCreds'))
      return false
    }
    setTesting(true)
    setTestMsg(t('settings.testing'))
    setTestOk(null)
    try {
      const result = await testProviderConnection(activeProv)
      if (result.reachable && result.authValid !== false) {
        setTestOk(true)
        setTestMsg(t('settings.testSuccess'))
        // 能力探测异步触发（2026-09-09）：预填充基准可能耗时数十秒，不阻塞保存。
        // 回填成功后刷新本地 provider 状态，让新字段即时显示在表单里。
        void (async () => {
          try {
            const probe = await probeProvider(settings.activeProvider)
            if (Object.keys(probe.updates || {}).length) {
              const cfg = await fetchBridgeConfig()
              updateSettings({ providers: cfg.providers })
            }
            const parts: string[] = []
            if (probe.notes?.length) parts.push(t('settings.probeAutoTuned', { notes: probe.notes.join('、') }))
            if (probe.skipped?.length) parts.push(t('settings.probeKeptManual', { fields: probe.skipped.join('、') }))
            if (probe.fromCache) parts.push(t('settings.probeFromCache'))
            if (parts.length) {
              setTestMsg(parts.join('；'))
              setTimeout(() => setTestMsg(''), 8000)
            }
          } catch { /* 探测失败静默——连接测试已通过，不打扰用户 */ }
        })()
        return true
      } else if (result.reachable && result.authValid === false) {
        setTestOk(false)
        setTestMsg(t('settings.testAuthFail') + (result.detail ? `: ${result.detail}` : ''))
        return false
      } else {
        setTestOk(false)
        setTestMsg(t('settings.testUnreachable') + (result.error ? `: ${result.error}` : ''))
        return false
      }
    } catch (e) {
      setTestOk(false)
      setTestMsg(t('settings.testFail') + (e instanceof Error ? `: ${e.message}` : ''))
      return false
    } finally {
      setTesting(false)
      setTimeout(() => setTestMsg(''), 8000)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(t('settings.saving'))
    try {
      // Save first — never block the user from saving their config.
      // Test connectivity separately afterwards so a missing authToken
      // doesn't create a deadlock where save requires test but test
      // requires saved credentials.
      const cfg: YFWorkingConfigV2 = {
        activeProvider: settings.activeProvider,
        skillRoot: settings.skillRoot || '',
        autoCapture: settings.autoCapture,
        autoImageBridge: settings.autoImageBridge,
        visionProviderId: settings.visionProviderId || '',
        // 全局思考深度并入 cfg（Task 12）：bridge saveConfig 整包透传写 config.json，
        // 新会话 spawn 时 buildChildEnv 读它注入 CLAUDE_CODE_EFFORT_LEVEL
        effortLevel: normalizeEffortUi(settings.effortLevel),
        // 全局审批档位（2026-09-12）：bridge 侧 sanitizeConfigPatch 再钳一次后落盘，
        // 并对无覆盖的活会话热切（否则"设置页点了没反应"）。落盘后新会话 spawn 用
        // approvalSpawnArgs(档位) 决定是否传 --dangerously-skip-permissions。
        approvalMode: normalizeApprovalMode(settings.approvalMode),
        // 日志策略：桥/主进程的写入端按 TTL(5s) 重读 config.json，无需重启即生效
        logPolicy: normalizeLogPolicyUi(settings.logPolicy),
        // 导入上限：桥按 TTL 重读，保存后下一次导入即生效（无需重启）
        knowledgeImport: normalizeKnowledgeImportPolicyUi(settings.knowledgeImport),
        providers: settings.providers,
      }
      const saved = await saveBridgeConfig(cfg)
      if (saved) {
        setSaveOk(true)
        setSaveMsg(t('settings.saveSuccess'))
        // Background verify — does NOT block the save result
        handleTestConnection()
      } else {
        setSaveOk(false)
        setSaveMsg(t('settings.saveFail'))
      }
    } catch {
      setSaveOk(false)
      setSaveMsg(t('settings.saveFail'))
    }
    setSaving(false)
    setTimeout(() => setSaveMsg(''), 3000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Database className="w-4 h-4" />
          {t('settings.yfworking')}
        </h3>
        <p className="text-xs text-tertiary mb-4">{t('settings.yfworkingDesc')}</p>

        {/* Provider Selector */}
        <div className="mb-4">
          <label className="text-xs font-medium text-secondary mb-1.5 block">{t('settings.activeProvider')}</label>
          <p className="text-[10px] text-tertiary mb-1.5">{t('settings.activeProviderDesc')}</p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <select
                value={settings.activeProvider}
                onChange={e => handleSwitchProvider(e.target.value)}
                className="w-full h-8 rounded-md border border bg-surface px-3 pr-8 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent appearance-none"
              >
                { (settings.providers || []).map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} {isBuiltin(p.id) ? `[${t('settings.providerBuiltin')}]` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-tertiary pointer-events-none" />
            </div>
            <button
              onClick={() => setShowAddDialog(true)}
              className="flex items-center gap-1 px-2.5 h-8 rounded-md border border-dashed text-[10px] font-medium text-accent hover:bg-accent/5 transition-colors whitespace-nowrap"
            >
              <Plus className="w-3 h-3" />
              {t('settings.addCustomProvider')}
            </button>
          </div>
        </div>

        {activeProv && (
          <>
            {/* Provider Configuration —— 恒展开（2026-09-11：折叠入口发现性差，用户
                找不到"已配置供应商的更新入口"；下拉选中即编辑，标题明示当前对象） */}
            <div className="flex items-center gap-2 py-2 mb-2">
              <span className="text-xs font-semibold text-secondary">{t('settings.providerConfig')}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-brand-500/30 bg-brand-500/10 text-brand-500 font-medium">
                {activeProv.name}
              </span>
              {isBuiltin(activeProv.id) && <span className="text-[10px] text-tertiary">[内置]</span>}
            </div>
            {(
              <div className="space-y-3 pl-5 border-l-2 border-subtle mb-4">
                {/* Provider Name */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerName')}</label>
                  <input
                    type="text"
                    value={activeProv.name}
                    onChange={e => handleUpdateActiveProvider('name', e.target.value)}
                    disabled={isBuiltin(activeProv.id)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                  />
                </div>

                {/* API Base URL */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerApiBaseUrl')}</label>
                  <input
                    type="text"
                    value={activeProv.apiBaseUrl}
                    onChange={e => handleUpdateActiveProvider('apiBaseUrl', e.target.value)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                </div>

                {/* Auth Token */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerAuthToken')}</label>
                  <input
                    type="password"
                    value={activeProv.authToken}
                    onChange={e => handleUpdateActiveProvider('authToken', e.target.value)}
                    placeholder="sk-..."
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerAuthTokenDesc')}</p>
                </div>

                {/* Primary Model */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerPrimaryModel')}</label>
                  <select
                    value={activeProv.primaryModel}
                    onChange={e => handleUpdateActiveProvider('primaryModel', e.target.value)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  >
                    { (activeProv.models || []).map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {/* Subagent Model */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerSubagentModel')}</label>
                  <select
                    value={activeProv.subagentModel}
                    onChange={e => handleUpdateActiveProvider('subagentModel', e.target.value)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  >
                    { (activeProv.models || []).map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {/* Behavior Profile（2026-09-09 本地模型适配） */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerProfile')}</label>
                  <select
                    value={activeProv.profile || 'auto'}
                    onChange={e => handleUpdateActiveProvider('profile', e.target.value as ModelProvider['profile'])}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="auto">{t('settings.providerProfileAuto')}</option>
                    <option value="cloud">{t('settings.providerProfileCloud')}</option>
                    <option value="local">{t('settings.providerProfileLocal')}</option>
                  </select>
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerProfileDesc')}</p>
                </div>

                {/* Sampling temperature [0,2]；空 = 画像默认 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerTemperature')}</label>
                  <input
                    type="number" min={0} max={2} step={0.1}
                    value={activeProv.temperature ?? ''}
                    placeholder={t('settings.providerTemperatureDesc')}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === '') { handleUpdateActiveProvider('temperature', undefined); return }
                      const n = parseFloat(raw)
                      if (!Number.isFinite(n)) return
                      handleUpdateActiveProvider('temperature', Math.min(2, Math.max(0, n)))
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerTemperatureDesc')}</p>
                </div>

                {/* Max output tokens；空 = 画像默认 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerMaxOutputTokens')}</label>
                  <input
                    type="number" min={1} step={1}
                    value={activeProv.maxOutputTokens ?? ''}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === '') { handleUpdateActiveProvider('maxOutputTokens', undefined); return }
                      const n = parseInt(raw, 10)
                      if (!Number.isFinite(n) || n < 1) return
                      handleUpdateActiveProvider('maxOutputTokens', n)
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerMaxOutputTokensDesc')}</p>
                </div>

                {/* Tool result byte budget；空 = 内核默认 20000（落盘+预览替换） */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerToolResultBudget')}</label>
                  <input
                    type="number" min={1000} step={1000}
                    value={activeProv.toolResultBudgetBytes ?? ''}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === '') { handleUpdateActiveProvider('toolResultBudgetBytes', undefined); return }
                      const n = parseInt(raw, 10)
                      if (!Number.isFinite(n) || n < 1000) return
                      handleUpdateActiveProvider('toolResultBudgetBytes', n)
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerToolResultBudgetDesc')}</p>
                </div>

                {/* First-content grace ms；空 = 内核默认 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerFirstByteMs')}</label>
                  <input
                    type="number" min={1} step={1000}
                    value={activeProv.firstByteMs ?? ''}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === '') { handleUpdateActiveProvider('firstByteMs', undefined); return }
                      const n = parseInt(raw, 10)
                      if (!Number.isFinite(n) || n < 1) return
                      handleUpdateActiveProvider('firstByteMs', n)
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerFirstByteMsDesc')}</p>
                </div>

                {/* Generation idle window ms；空 = 内核默认 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerIdleMs')}</label>
                  <input
                    type="number" min={1} step={1000}
                    value={activeProv.idleMs ?? ''}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === '') { handleUpdateActiveProvider('idleMs', undefined); return }
                      const n = parseInt(raw, 10)
                      if (!Number.isFinite(n) || n < 1) return
                      handleUpdateActiveProvider('idleMs', n)
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerIdleMsDesc')}</p>
                </div>

                {/* 思考模式（2026-09-10）：thinking:enabled+budget 注入——MiniMax 等
                    不认 reasoning_effort 的云端经此才有 thinking_delta 流 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-secondary">{t('settings.providerThinkingEnabled')}</div>
                      <p className="text-[10px] text-tertiary mt-0.5">{t('settings.providerThinkingEnabledDesc')}</p>
                    </div>
                    <Switch
                      checked={activeProv.thinkingEnabled === true}
                      onCheckedChange={v => handleUpdateActiveProvider('thinkingEnabled', v || undefined)}
                    />
                  </div>
                  {activeProv.thinkingEnabled && (
                    <div>
                      <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerThinkingBudget')}</label>
                      <input
                        type="number" min={256} step={256}
                        value={activeProv.thinkingBudget ?? 4096}
                        onChange={e => {
                          const n = parseInt(e.target.value, 10)
                          if (!Number.isFinite(n) || n < 1) return
                          handleUpdateActiveProvider('thinkingBudget', n)
                        }}
                        className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                      />
                    </div>
                  )}
                </div>

                {/* Vision Provider Source（可指向任意已配置 provider） */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerVisionSource')}</label>
                  <select
                    value={settings.visionProviderId || settings.activeProvider}
                    onChange={e => updateSettings({ visionProviderId: e.target.value === settings.activeProvider ? '' : e.target.value })}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    { (settings.providers || []).map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerVisionSourceDesc')}</p>
                </div>

                {/* Vision Model（来自视觉来源 provider） */}
                {visionProv && (
                  <div>
                    <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerVisionModel')}</label>
                    <select
                      value={visionProv.visionModel || ''}
                      onChange={e => {
                        const updated = (settings.providers || []).map(p =>
                          p.id === visionProv.id ? { ...p, visionModel: e.target.value || undefined } : p
                        )
                        updateSettings({ providers: updated as ModelProvider[] })
                      }}
                      className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                    >
                      <option value="">{t('settings.providerVisionModelNone')}</option>
                      { (visionProv.models || []).map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-tertiary mt-1">{t('settings.providerVisionModelDesc')}</p>
                  </div>
                )}

                {/* Auto Image Bridge（全局开关：对话粘贴图片自动桥接） */}
                <label className="flex items-center justify-between py-1 pt-2 border-t border-subtle">
                  <div>
                    <span className="text-sm text-secondary">{t('settings.autoImageBridge')}</span>
                    <p className="text-[10px] text-tertiary mt-0.5">{t('settings.autoImageBridgeDesc')}</p>
                  </div>
                  <Switch
                    checked={settings.autoImageBridge !== false}
                    onCheckedChange={v => updateSettings({ autoImageBridge: v })}
                  />
                </label>

                {/* Delete Provider (custom only) */}
                {!isBuiltin(activeProv.id) && (
                  <div className="pt-2 border-t border-subtle">
                    <button
                      onClick={() => handleDeleteProvider(activeProv.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-error/80 hover:bg-error/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {t('settings.deleteProvider')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Advanced Settings — collapsible */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 w-full text-left py-2 mb-2 hover:text-primary transition-colors"
            >
              <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', showAdvanced && 'rotate-90')} />
              <span className="text-xs font-semibold text-secondary">{t('settings.advanced')}</span>
              <span className="text-[10px] text-tertiary ml-auto">{showAdvanced ? t('common.collapse') : t('common.expand')}</span>
            </button>
            {showAdvanced && (
              <div className="space-y-3 pl-5 border-l-2 border-subtle mb-4">
                {/* Effort Level —— 思考深度（全局，Task 12）
                    旧 provider 级 effortLevel select 已移除（provider 字段保留仅作存储兼容）：
                    本控制绑定全局 settings.effortLevel → handleSave 并入 cfg（新会话 env 注入），
                    onChange 同步向运行中会话发 WS reasoning_effort 热切换（sendEffort 无会话幂等）。 */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.effortLevel')}</label>
                  <select
                    value={normalizeEffortUi(settings.effortLevel)}
                    onChange={e => {
                      const v = normalizeEffortUi(e.target.value)
                      updateSettings({ effortLevel: v })
                      sendEffort(useChatStore.getState().activeConversationId ?? undefined, v)
                    }}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {EFFORT_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.effortLevelDesc')}</p>
                </div>

                {/* Context Window */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerContextWindow')}</label>
                  <input
                    type="number"
                    value={activeProv.contextWindow}
                    onChange={e => handleUpdateActiveProvider('contextWindow', parseInt(e.target.value) || 0)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                  />
                  <p className="text-[10px] text-tertiary mt-1">{t('settings.providerContextWindowDesc')}</p>
                </div>
              </div>
            )}
          </>
        )}

      </div>

      {/* Save & Test buttons */}
      <div className="flex items-center gap-3 pt-2 border-t border-subtle flex-wrap">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || testing} leftIcon={<Save className="w-3.5 h-3.5" />}>
          {saving ? t('common.loading') : t('common.save')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleTestConnection} disabled={testing || saving} leftIcon={<Wifi className="w-3.5 h-3.5" />}>
          {testing ? t('settings.testing') : t('settings.testConnection')}
        </Button>
        {saveMsg && (
          <span className={cn('text-xs', saveOk ? 'text-success' : 'text-error')}>
            {saveMsg}
          </span>
        )}
        {testMsg && (
          <span className={cn('text-xs', testOk === true ? 'text-success' : testOk === false ? 'text-error' : 'text-tertiary')}>
            {testMsg}
          </span>
        )}
      </div>

      {/* Add Custom Provider Dialog（2026-09-11 修复 v2：Radix Dialog 在独立设置窗口
          实测仅遮罩可见（动画/切角/变量组合异常）——改用内联样式模态，全部颜色走
          var(--x, 兜底) 双保险，零动画零 clip-path，任何主题/极速形态下必然可见。
          【设计语言例外】此弹窗按上述修复结论刻意不套 .cut 切角，避免复发不可见。） */}
      {showAddDialog && (
        <>
          <div
            className="fixed inset-0 z-[80]"
            style={{ background: 'var(--overlay-bg, rgba(0,0,0,0.45))', backdropFilter: 'blur(var(--overlay-blur, 4px))' }}
            onClick={() => setShowAddDialog(false)}
          />
          <div
            className="fixed left-1/2 top-1/2 z-[81] w-[420px] max-w-[calc(100vw-32px)] rounded-xl p-5"
            style={{
              transform: 'translate(-50%, -50%)',
              background: 'var(--modal-bg, var(--bg-elevated, #161c28))',
              border: '1px solid var(--border-default, rgba(255,255,255,0.14))',
              color: 'var(--text-primary, #e8e4dd)',
              boxShadow: 'var(--shadow-window, 0 16px 48px rgba(0,0,0,0.5))',
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary, #e8e4dd)' }}>
                <Plus className="w-4 h-4" style={{ color: 'var(--text-accent, #ff7a45)' }} />
                {t('settings.addCustomProvider')}
              </h3>
              <button onClick={() => setShowAddDialog(false)} className="p-1 rounded-md hover:opacity-70" style={{ color: 'var(--text-tertiary, #8a8f98)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] mb-4" style={{ color: 'var(--text-tertiary, #8a8f98)' }}>{t('settings.addCustomProviderDesc')}</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary, #b8bcc4)' }}>{t('settings.providerName')}</label>
                <input
                  type="text"
                  value={newProvider.name}
                  onChange={e => setNewProvider({ ...newProvider, name: e.target.value })}
                  placeholder="e.g. Moonshot"
                  className="w-full h-8 rounded-md border px-3 text-xs focus:outline-none"
                  style={{
                    background: 'var(--bg-surface, #1e2635)',
                    borderColor: 'var(--border-default, rgba(255,255,255,0.14))',
                    color: 'var(--text-primary, #e8e4dd)',
                  }}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary, #b8bcc4)' }}>{t('settings.providerApiBaseUrl')}</label>
                <input
                  type="text"
                  value={newProvider.apiBaseUrl}
                  onChange={e => setNewProvider({ ...newProvider, apiBaseUrl: e.target.value })}
                  placeholder="https://api.example.com/anthropic"
                  className="w-full h-8 rounded-md border px-3 text-xs focus:outline-none font-mono"
                  style={{
                    background: 'var(--bg-surface, #1e2635)',
                    borderColor: 'var(--border-default, rgba(255,255,255,0.14))',
                    color: 'var(--text-primary, #e8e4dd)',
                  }}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-secondary, #b8bcc4)' }}>{t('settings.providerModelList')}</label>
                <input
                  type="text"
                  value={newProvider.modelList}
                  onChange={e => setNewProvider({ ...newProvider, modelList: e.target.value })}
                  placeholder="model-v1, model-v2-light（留空 = 保存后自动从服务端探测）"
                  className="w-full h-8 rounded-md border px-3 text-xs focus:outline-none font-mono"
                  style={{
                    background: 'var(--bg-surface, #1e2635)',
                    borderColor: 'var(--border-default, rgba(255,255,255,0.14))',
                    color: 'var(--text-primary, #e8e4dd)',
                  }}
                />
                <p className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary, #8a8f98)' }}>{t('settings.providerModelListDesc')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.08))' }}>
              <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={handleAddProvider} disabled={!newProvider.name || !newProvider.apiBaseUrl}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ============================================================
   Skills Settings Panel
   ============================================================ */

function SkillsPanel({ t, settings, updateSettings }: {
  t: (key: string) => string
  settings: AppSettings
  updateSettings: (u: Partial<AppSettings>) => void
}) {
  const [skillCount, setSkillCount] = useState(0)

  useEffect(() => {
    // 与 Sidebar/输入框共用同一加载逻辑（bridge 优先，skills.json 兜底）
    fetchSkills('', dir => updateSettings({ skillRoot: dir })).then(list => setSkillCount(list.length))
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Puzzle className="w-4 h-4" />
          {t('settings.skillsTab')}
        </h3>
        <p className="text-xs text-tertiary mb-4">{t('settings.skillsTabDesc')}</p>

        <div className="space-y-4">
          {/* Skill Root */}
          <div>
            <label className="text-xs font-medium text-secondary mb-1 flex items-center gap-1.5">
              <FolderOpen className="w-3 h-3" />
              {t('settings.skillRoot')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.skillRoot}
                readOnly
                className="flex-1 h-8 rounded-md border border bg-surface px-3 text-xs text-tertiary focus:outline-none font-mono"
              />
              <button
                className="flex items-center gap-1 px-2.5 h-8 rounded-md border border text-[10px] font-medium text-secondary hover:text-primary hover:bg-elevated transition-colors"
                onClick={() => {
                  fetchBridgeConfig().then(cfg => {
                    updateSettings({ skillRoot: cfg.skillRoot })
                  }).catch(() => {})
                }}
              >
                <RefreshCw className="w-3 h-3" />
                {t('common.refresh')}
              </button>
            </div>
            <p className="text-[10px] text-tertiary mt-1">{t('settings.skillRootDesc')}</p>
          </div>

          {/* Auto Capture */}
          <div>
            <label className="flex items-center justify-between py-1">
              <div>
                <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
                  <Brain className="w-3 h-3" />
                  {t('settings.autoCapture')}
                </span>
                <p className="text-[10px] text-tertiary mt-0.5">{t('settings.autoCaptureDesc')}</p>
              </div>
              <Switch
                checked={settings.autoCapture}
                onCheckedChange={v => updateSettings({ autoCapture: v })}
              />
            </label>
          </div>

          <div className="h-px bg-elevated" />

          {/* Skills summary */}
          <div>
            <h4 className="text-xs font-semibold text-secondary mb-2 flex items-center gap-1.5">
              <HardDrive className="w-3 h-3" />
              {t('settings.installedSkills')}
            </h4>
            <div className="cut-sm">
              <div className="ci p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold text-primary">{skillCount}</span>
                  <span className="text-xs text-tertiary ml-1">{t('settings.installedSkillsCount')}</span>
                </div>
              </div>
              <p className="text-[10px] text-tertiary mt-2">{t('settings.skillsManageHint')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   Theme Picker — 3 theme cards with live preview
   ============================================================ */

/* ============================================================
   打断插话快捷键捕获器：点击后进入捕获态，按下组合键即保存
   ============================================================ */

function ShortcutCapture({ t, value, onChange }: {
  t: (key: string) => string
  value: string
  onChange: (s: string) => void
}) {
  const [capturing, setCapturing] = useState(false)
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={e => {
          if (!capturing) return
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') { setCapturing(false); return }
          const s = shortcutFromEvent(e)
          if (s) { setCapturing(false); onChange(s) }
        }}
        className={cn(
          'px-2.5 h-7 rounded-md border text-[11px] font-mono transition-colors',
          capturing ? 'border-accent text-accent animate-pulse' : 'text-primary hover:border-accent'
        )}
      >
        {capturing ? t('settings.interjectShortcutCapture') : formatShortcut(value)}
      </button>
      <button
        type="button"
        title={t('settings.interjectShortcutReset')}
        onClick={() => onChange('ctrl+enter')}
        className="px-1.5 h-7 rounded-md text-[10px] text-tertiary hover:text-primary transition-colors"
      >
        {t('settings.interjectShortcutReset')}
      </button>
    </div>
  )
}

function ThemePicker({ value, onChange, t }: { value: ThemeMode; onChange: (t: ThemeMode) => void; t: (key: string) => string }) {
  const activeTheme = THEMES.find(theme => theme.id === value) ?? THEMES[0]
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-primary">{t('settings.theme')}</h3>
        <span className="text-[10px] text-tertiary uppercase tracking-wider">
          {activeTheme.name}{activeTheme.variant ? ` · ${activeTheme.variant}` : ''} {activeTheme.isDefault ? `· ${t('common.default')}` : ''} · {t('settings.themeCount')}
        </span>
      </div>
      {/* 四主题 2×2（实色/玻璃各二）—— 设计语言统一：单对角切角卡 + 热边选中 */}
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map(theme => (
          <ThemePreviewCard
            key={theme.id}
            theme={theme}
            active={value === theme.id}
            onSelect={() => onChange(theme.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ThemePreviewCard({
  theme,
  active,
  onSelect,
}: {
  theme: ThemeMeta
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative text-left cut-sm transition-all duration-200 focus:outline-none',
        active && 'hot glow-hover',
      )}
      style={active ? { filter: 'drop-shadow(var(--glow-hot))' } : undefined}
      aria-pressed={active}
    >
      <div className="ci overflow-hidden">
      {/* Preview swatch — miniature "app" rendered with this theme's tokens */}
      <div
        className="relative h-28 overflow-hidden"
        style={{ background: theme.surface }}
      >
        {/* faux sidebar */}
        <div
          className="absolute left-0 top-0 bottom-0 w-9 border-r"
          style={{
            background: `color-mix(in srgb, ${theme.surface} 80%, black 20%)`,
            borderColor: `color-mix(in srgb, ${theme.primary} 18%, transparent)`,
          }}
        >
          <div className="p-1.5 space-y-1">
            <div className="w-full h-1.5 rounded-sm" style={{ background: theme.primary, opacity: 0.85 }} />
            <div className="w-3/4 h-1 rounded-sm" style={{ background: theme.primary, opacity: 0.25 }} />
            <div className="w-2/3 h-1 rounded-sm" style={{ background: theme.primary, opacity: 0.18 }} />
            <div className="w-1/2 h-1 rounded-sm" style={{ background: theme.primary, opacity: 0.12 }} />
          </div>
        </div>

        {/* faux accent button */}
        <div
          className="absolute right-2 top-2 h-4 px-2 rounded-md text-[8px] font-semibold flex items-center"
          style={{ background: theme.primary, color: 'var(--text-inverse)' }}
        >
          Send
        </div>

        {/* faux message bubbles */}
        <div className="absolute left-12 right-2 top-8 space-y-1.5">
          <div
            className="h-2 rounded"
            style={{
              background: `color-mix(in srgb, ${theme.primary} 22%, transparent)`,
              width: '78%',
            }}
          />
          <div
            className="h-2 rounded"
            style={{
              background: `color-mix(in srgb, ${theme.primary} 14%, transparent)`,
              width: '54%',
            }}
          />
          <div
            className="h-2 rounded"
            style={{
              background: `color-mix(in srgb, ${theme.primary} 18%, transparent)`,
              width: '66%',
            }}
          />
        </div>

        {/* primary swatch dot — bottom right */}
        <div className="absolute right-2 bottom-2 flex gap-1">
          <div
            className="w-3 h-3 rounded-full ring-1 ring-white/20"
            style={{ background: theme.primary }}
            title={theme.primary}
          />
          <div
            className="w-3 h-3 rounded-full ring-1 ring-white/20"
            style={{ background: theme.deep }}
            title={theme.deep}
          />
        </div>

        {/* active checkmark */}
        {active && (
          <div className="absolute top-2 left-2 w-5 h-5 rounded-full flex items-center justify-center"
               style={{ background: theme.primary, color: 'var(--text-inverse)' }}>
            <Check className="w-3 h-3" strokeWidth={3} />
          </div>
        )}

        {/* default badge */}
        {theme.isDefault && !active && (
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wider flex items-center gap-0.5"
               style={{
                 background: 'rgba(0,0,0,0.55)',
                 color: theme.primary,
                 backdropFilter: 'blur(4px)',
               }}>
            <Sparkles className="w-2.5 h-2.5" />
            default
          </div>
        )}
      </div>

      {/* meta */}
      <div className="px-3 py-2.5 bg-surface border-t border-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <div className="font-semibold text-sm text-primary truncate">{theme.name}</div>
            {theme.variant && (
              <div className="text-[10px] text-tertiary font-medium shrink-0">
                · {theme.variant}
              </div>
            )}
          </div>
          <div
            className="font-mono text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0"
            style={{
              background: `${theme.primary}1f`,
              color: theme.primary,
            }}
          >
            {theme.glyph}
          </div>
        </div>
        <p className="text-[11px] text-tertiary mt-0.5 leading-snug line-clamp-1">
          {theme.tagline}
        </p>
      </div>
      </div>
    </button>
  )
}
