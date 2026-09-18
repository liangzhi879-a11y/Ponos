// src/components/settings/ProxySettings.tsx —— 网络代理设置面板（P1「应用内增加网络VPN代理配置功能」，2026-09-17）
//
// 为什么需要它：需要经 VPN / 公司代理上网的环境里，此前只能改系统环境变量再启动应用，
// 应用内没有任何入口。本面板把三档摆出来，并且**逐档写清生效面** ——
// "跟随系统"只管浏览器（Node 侧没有可靠的跨系统读取接口）、"手动"才覆盖模型调用与命令行，
// 这是用户无法自己推断的关键差异，不写清就会出现"我配了代理怎么还连不上"。
//
// 设计取舍（与后端契约一一对应，见 shared/proxy-config.cjs）：
//   · **自带保存按钮**，直接 `saveBridgeConfig({ network: { proxy } })`（局部补丁）。
//     不并入模型页的"保存"按钮：代理是后端配置、与 provider 无关，且局部补丁由桥侧
//     `mergeProxyPatch` 合并其余键 —— 顺带保证"在模型页保存"不会把代理设置打回默认。
//   · **保存失败必须如实显示**：桥对非法代理回 400（不静默保留现值）。
//     若把失败显示成成功，用户会带着"已配置"的错觉去排查模型连不上的问题。
//   · 地址含凭据时，桥回显的是 `user:***@host`；原样发回由桥侧回填真密码 —— 故界面**不做**任何
//     本地替换，否则"用户只改端口"就会把 *** 当密码存下去。
import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { fetchBridgeConfig, saveBridgeConfig } from '@/lib/config'
import {
  DEFAULT_PROXY_UI, type ProxyMode, type ProxyUiConfig, effectiveBypass, normalizeProxyUi,
  validateProxyUi,
} from '@/lib/proxyUi'

const MODES: Array<{ id: ProxyMode; labelKey: string; descKey: string }> = [
  { id: 'off', labelKey: 'settings.proxyModeOff', descKey: 'settings.proxyModeOffDesc' },
  { id: 'system', labelKey: 'settings.proxyModeSystem', descKey: 'settings.proxyModeSystemDesc' },
  { id: 'manual', labelKey: 'settings.proxyModeManual', descKey: 'settings.proxyModeManualDesc' },
]

export function ProxySettings() {
  const { t } = useTranslation()
  // 本地状态而非 settingsStore：代理是**桥侧配置**（落 config.json、由桥与主进程读取），
  // 与渲染层持久化的偏好设置不是一回事。既有的 knowledgeImport 曾走 store，
  // 但那条路径要靠模型页的"保存"按钮才落盘；代理自带保存按钮，直连桥更直接、无隐式依赖。
  const [cfg, setCfg] = useState<ProxyUiConfig>(DEFAULT_PROXY_UI)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    fetchBridgeConfig()
      .then((c) => {
        if (!alive) return
        setCfg(normalizeProxyUi(c.network && c.network.proxy))
        setLoaded(true)
      })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  const errorKey = validateProxyUi(cfg)
  const effective = effectiveBypass(cfg.bypass)

  async function handleSave() {
    if (validateProxyUi(cfg)) return // 按钮已禁用，这里再挡一次（回车提交等路径）
    setSaving(true)
    setMsg(null)
    try {
      const ok = await saveBridgeConfig({ network: { proxy: normalizeProxyUi(cfg) } })
      setMsg({ ok, text: ok ? t('settings.proxySaved') : t('settings.proxySaveFail') })
      if (ok) {
        // 回读一次：桥会对凭据打码（`user:***@host`）并采用钳制后的值。
        // 不回读的话，界面显示的是用户输入、磁盘可能是另一种形态，用户无从发现。
        try {
          const c = await fetchBridgeConfig()
          setCfg(normalizeProxyUi(c.network && c.network.proxy))
        } catch { /* 回读失败不影响"已保存"这一结论 */ }
      }
    } catch {
      setMsg({ ok: false, text: t('settings.proxySaveFail') })
    }
    setSaving(false)
    setTimeout(() => setMsg(null), 4000)
  }

  return (
    <div className="space-y-4" data-testid="proxy-settings">
      <div className="flex items-center gap-2">
        <Globe className="w-4 h-4 text-brand-500" />
        <h3 className="text-sm font-semibold text-primary">{t('settings.proxyTitle')}</h3>
      </div>

      <p className="text-xs text-secondary leading-relaxed">{t('settings.proxyDesc')}</p>

      {/* 三档：逐档把生效面写在旁边（用户无法从档位名推断"跟随系统只管浏览器"） */}
      <div className="space-y-2">
        <label className="text-xs text-tertiary">{t('settings.proxyMode')}</label>
        {MODES.map((m) => {
          const active = cfg.mode === m.id
          return (
            <button
              key={m.id}
              type="button"
              disabled={!loaded}
              onClick={() => setCfg((p) => ({ ...p, mode: m.id }))}
              className={
                'w-full text-left px-3 py-2 rounded-lg border text-sm transition-all ' +
                (active
                  ? 'border-brand-500/50 bg-brand-500/10 text-primary'
                  : 'border bg-surface text-secondary hover:text-primary')
              }
              data-testid={`proxy-mode-${m.id}`}
            >
              <div className="font-medium">{t(m.labelKey)}</div>
              <div className="text-xs text-tertiary mt-0.5 leading-relaxed">{t(m.descKey)}</div>
            </button>
          )
        })}
      </div>

      {cfg.mode === 'manual' && (
        <div className="space-y-2">
          <label className="text-xs text-tertiary">{t('settings.proxyUrl')}</label>
          <input
            type="text"
            value={cfg.url}
            spellCheck={false}
            placeholder="http://10.0.0.1:7890"
            onChange={(e) => { setCfg((p) => ({ ...p, url: e.target.value })); setMsg(null) }}
            className="w-full h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            data-testid="proxy-url"
          />
          <p className="text-xs text-tertiary">{t('settings.proxyUrlHint')}</p>
          {errorKey && <p className="text-xs text-danger">{t(errorKey)}</p>}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-tertiary">{t('settings.proxyBypass')}</label>
        <input
          type="text"
          value={cfg.bypass}
          spellCheck={false}
          placeholder="*.corp.example, 10.0.0.0/8"
          onChange={(e) => setCfg((p) => ({ ...p, bypass: e.target.value }))}
          className="w-full h-8 rounded-md border border bg-surface px-2 text-xs text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          data-testid="proxy-bypass"
        />
        <p className="text-xs text-tertiary">{t('settings.proxyBypassHint')}</p>
        {/* 把"实际生效"的完整列表显示出来（含系统强制追加的回环项）：
            用户只填了自己的域名时，也要能看见回环在里面，否则会以为漏了配置。 */}
        {cfg.mode !== 'off' && (
          <p className="text-xs text-tertiary" data-testid="proxy-effective-bypass">
            {t('settings.proxyEffectiveBypass').replace('{list}', effective.join('、'))}
          </p>
        )}
      </div>

      <p className="text-xs text-tertiary leading-relaxed">{t('settings.proxyCredNote')}</p>
      <p className="text-xs text-tertiary leading-relaxed">{t('settings.proxyRestartHint')}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !loaded || !!errorKey}
          className="h-8 px-3 rounded-md border border bg-surface text-xs text-primary hover:border-brand-500/50 disabled:opacity-50"
          data-testid="proxy-save"
        >
          {saving ? t('settings.saving') : t('settings.proxySave')}
        </button>
        {msg && (
          <span className={'text-xs ' + (msg.ok ? 'text-secondary' : 'text-danger')} data-testid="proxy-msg">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
