import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Settings, Monitor, Cpu, Info, Check, Sparkles, Globe, Save, Database, FolderOpen, Brain, ChevronDown, Plus, X, Trash2, Puzzle, ChevronRight, HardDrive, RefreshCw, Wifi, Zap, ShieldOff } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, ScrollArea, Switch,
} from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useChatStore } from '@/stores/chatStore'
import { usePonosCLI } from '@/hooks/usePonosCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { cn, formatShortcut, shortcutFromEvent } from '@/lib/utils'
import { fetchSkills } from '@/lib/skills'
import { fetchBridgeConfig, saveBridgeConfig, addProvider, deleteProvider, testProviderConnection } from '@/lib/config'
import { ExperiencePanel } from '@/components/settings/ExperiencePanel'
import type { AppSettings, ModelProvider, PonosConfigV2, Language } from '@/types'

type Section = 'general' | 'model' | 'skills' | 'pet' | 'experience' | 'about'

export function SettingsView() {
  const { settingsOpen, closeSettings } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const { sessionModel } = useChatStore()
  const { connected } = usePonosCLI()
  const { t } = useTranslation()
  const [section, setSection] = useState<Section>('general')
  // Lifted state: the outer Radix Dialog's outside-click & focus guards must
  // react synchronously when the inner add-provider dialog opens. Keeping it
  // here (instead of a module flag) means SettingsView re-renders and
  // DialogContent receives fresh prop functions on every toggle.
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)
  const suppressOuterDismiss = (e: Event) => e.preventDefault()

  return (
    <Dialog open={settingsOpen} onOpenChange={v => { if (!v && !showAddProviderDialog) closeSettings() }}>
      <DialogContent
        size="lg"
        className="grid grid-rows-[auto_1fr_auto] max-h-[85vh]"
        onPointerDownOutside={showAddProviderDialog ? suppressOuterDismiss : undefined}
        onInteractOutside={showAddProviderDialog ? suppressOuterDismiss : undefined}
        onFocusOutside={showAddProviderDialog ? suppressOuterDismiss : undefined}
        onEscapeKeyDown={showAddProviderDialog ? suppressOuterDismiss : undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            {t('settings.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 overflow-hidden">
          <nav className="w-40 shrink-0 border-r border py-2 overflow-y-auto">
            {[
              { id: 'general' as Section, label: t('settings.general'), icon: Monitor },
              { id: 'model' as Section, label: t('settings.model'), icon: Cpu },
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
                    'w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors',
                    active
                      ? 'text-primary bg-brand-500/15 border-r-2 border-brand-500/50'
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
            <div className="p-6">
              {section === 'general' && (
                <div className="space-y-6">
                  {/* Language */}
                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                      <Globe className="w-4 h-4" />
                      {t('settings.language')}
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

                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-3">{t('settings.appearance')}</h3>
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
                    <h3 className="text-sm font-semibold text-primary mb-3">{t('settings.backgroundNotify')}</h3>
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
                <PonosModelPanel
                  t={t}
                  settings={settings}
                  updateSettings={updateSettings}
                  showAddDialog={showAddProviderDialog}
                  setShowAddDialog={setShowAddProviderDialog}
                />
              )}

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
                      {/* Pet type selector */}
                      <div>
                        <label className="block text-sm text-secondary mb-1">{t('settings.petType')}</label>
                        <p className="text-[10px] text-tertiary mb-2">{t('settings.petTypeDesc')}</p>
                        <div className="grid grid-cols-2 gap-2">
                          {([
                            { id: 'jiajia', label: t('settings.petJiajia'), desc: t('settings.petJiajiaDesc') },
                            { id: 'dafeiyu', label: t('settings.petDafeiyu'), desc: t('settings.petDafeiyuDesc') },
                          ] as const).map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => updateSettings({ petType: p.id })}
                              className={cn(
                                'rounded-lg border px-3 py-2.5 text-left transition-colors',
                                settings.petType === p.id
                                  ? 'border-brand-500 bg-brand-500/10'
                                  : 'border-border hover:border-brand-500/50'
                              )}
                            >
                              <span className="block text-sm font-medium text-primary">{p.label}</span>
                              <span className="block text-[10px] text-tertiary mt-0.5 leading-snug">{p.desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>

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
                  <h3 className="text-sm font-semibold text-primary">Ponos dev</h3>
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
        <DialogFooter>
          <Button variant="ghost" onClick={closeSettings}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function PonosModelPanel({ t, settings, updateSettings, showAddDialog, setShowAddDialog }: {
  t: (key: string) => string
  settings: AppSettings
  updateSettings: (u: Partial<AppSettings>) => void
  showAddDialog: boolean
  setShowAddDialog: (v: boolean) => void
}) {
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveOk, setSaveOk] = useState(true)
  const [showProviderConfig, setShowProviderConfig] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [newProvider, setNewProvider] = useState({ name: '', apiBaseUrl: '', modelList: '' })
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const addDialogRootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showAddDialog) return
    const root = addDialogRootRef.current
    if (!root) return
    const isInside = (el: EventTarget | null) => el instanceof Node && root.contains(el)
    const onFocusIn = (e: FocusEvent) => {
      if (isInside(e.target)) e.stopPropagation()
    }
    const onFocusOut = (e: FocusEvent) => {
      if (isInside(e.relatedTarget)) e.stopPropagation()
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
    }
  }, [showAddDialog])

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
          allowOutsideDirs: cfg.allowOutsideDirs === true,
        })
      })
      .catch(() => {})
  }, [])

  const activeProv = settings.providers.find(p => p.id === settings.activeProvider)
  const isBuiltin = (id: string) => id === 'deepseek' || id === 'minimax'
  /** 视觉模型来源 provider：显式指定 visionProviderId 则用该 provider，否则跟随 activeProvider */
  const visionProv = settings.providers.find(p => p.id === settings.visionProviderId) || activeProv

  const handleSwitchProvider = (providerId: string) => {
    updateSettings({ activeProvider: providerId })
  }

  const handleUpdateActiveProvider = (field: keyof ModelProvider, value: string | number | boolean | string[] | undefined) => {
    if (!activeProv) return
    const updated = settings.providers.map(p =>
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
      contextWindow: 1000000,
    })
    if (prov) {
      updateSettings({ providers: [...settings.providers, prov], activeProvider: prov.id })
      setNewProvider({ name: '', apiBaseUrl: '', modelList: '' })
      setShowAddDialog(false)
    }
  }

  const handleDeleteProvider = async (providerId: string) => {
    if (isBuiltin(providerId)) return
    if (!confirm(t('settings.deleteProviderConfirm').replace('{name}', settings.providers.find(p => p.id === providerId)?.name || ''))) return
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
      const cfg: PonosConfigV2 = {
        activeProvider: settings.activeProvider,
        skillRoot: settings.skillRoot || '',
        autoCapture: settings.autoCapture,
        autoImageBridge: settings.autoImageBridge,
        visionProviderId: settings.visionProviderId || '',
        allowOutsideDirs: settings.allowOutsideDirs,
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
          {t('settings.ponos')}
        </h3>
        <p className="text-xs text-tertiary mb-4">{t('settings.ponosDesc')}</p>

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
                {settings.providers.map(p => (
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

        {/* 会话目录外文件访问开关（全局权限，非 provider 级） */}
        <div className="mb-4">
          <label className="flex items-center justify-between py-1">
            <div>
              <span className="text-xs font-medium text-secondary flex items-center gap-1.5">
                <ShieldOff className="w-3 h-3" />
                {t('settings.allowOutsideDirs')}
              </span>
              <p className="text-[10px] text-tertiary mt-0.5">{t('settings.allowOutsideDirsDesc')}</p>
            </div>
            <Switch
              checked={settings.allowOutsideDirs}
              onCheckedChange={v => updateSettings({ allowOutsideDirs: v })}
            />
          </label>
        </div>

        {activeProv && (
          <>
            {/* Provider Configuration — collapsible */}
            <button
              onClick={() => setShowProviderConfig(!showProviderConfig)}
              className="flex items-center gap-2 w-full text-left py-2 mb-2 hover:text-primary transition-colors"
            >
              <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', showProviderConfig && 'rotate-90')} />
              <span className="text-xs font-semibold text-secondary">{t('settings.providerConfig')}</span>
              <span className="text-[10px] text-tertiary ml-auto">{showProviderConfig ? t('common.collapse') : t('common.expand')}</span>
            </button>
            {showProviderConfig && (
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
                    {activeProv.models.map(m => (
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
                    {activeProv.models.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {/* Vision Provider Source（可指向任意已配置 provider） */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerVisionSource')}</label>
                  <select
                    value={settings.visionProviderId || settings.activeProvider}
                    onChange={e => updateSettings({ visionProviderId: e.target.value === settings.activeProvider ? '' : e.target.value })}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    {settings.providers.map(p => (
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
                        const updated = settings.providers.map(p =>
                          p.id === visionProv.id ? { ...p, visionModel: e.target.value || undefined } : p
                        )
                        updateSettings({ providers: updated as ModelProvider[] })
                      }}
                      className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                    >
                      <option value="">{t('settings.providerVisionModelNone')}</option>
                      {visionProv.models.map(m => (
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
                {/* Effort Level */}
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerEffortLevel')}</label>
                  <select
                    value={activeProv.effortLevel}
                    onChange={e => handleUpdateActiveProvider('effortLevel', e.target.value)}
                    className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="max">max</option>
                  </select>
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

      {/* Add Custom Provider Dialog */}
      {showAddDialog && createPortal(
        <>
          <div className="fixed inset-0 z-[60] pointer-events-auto" style={{ background: 'var(--overlay-bg)' }} onClick={() => setShowAddDialog(false)} />
          <div
            ref={addDialogRootRef}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] w-96 bg-surface rounded-xl shadow-modal border border p-5 pointer-events-auto"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-primary flex items-center gap-1.5">
                <Plus className="w-4 h-4 text-accent" />
                {t('settings.addCustomProvider')}
              </h3>
              <button onClick={() => setShowAddDialog(false)} className="p-1 hover:bg-elevated rounded-md">
                <X className="w-4 h-4 text-tertiary" />
              </button>
            </div>
            <p className="text-[10px] text-tertiary mb-4">{t('settings.addCustomProviderDesc')}</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerName')}</label>
                <input
                  type="text"
                  value={newProvider.name}
                  onChange={e => setNewProvider({ ...newProvider, name: e.target.value })}
                  placeholder="e.g. Moonshot"
                  className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerApiBaseUrl')}</label>
                <input
                  type="text"
                  value={newProvider.apiBaseUrl}
                  onChange={e => setNewProvider({ ...newProvider, apiBaseUrl: e.target.value })}
                  placeholder="https://api.example.com/anthropic"
                  className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-secondary mb-1 block">{t('settings.providerModelList')}</label>
                <input
                  type="text"
                  value={newProvider.modelList}
                  onChange={e => setNewProvider({ ...newProvider, modelList: e.target.value })}
                  placeholder="model-v1, model-v2-light"
                  className="w-full h-8 rounded-md border border bg-surface px-3 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
                />
                <p className="text-[10px] text-tertiary mt-1">{t('settings.providerModelListDesc')}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-subtle">
              <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={handleAddProvider} disabled={!newProvider.name || !newProvider.apiBaseUrl}>
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </>,
        document.body
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
            <div className="rounded-lg border border bg-surface p-4">
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
