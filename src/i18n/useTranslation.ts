import { useMemo } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { zhCN, enUS, type Language } from './'

// Simple string interpolation: "Hello {name}" + {name: "World"} → "Hello World"
function interpolate(str: string, params?: Record<string, string | number>): string {
  if (!params) return str
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match
  })
}

// Deep access: t('settings.title') → translations.settings.title
function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => acc?.[part], obj)
}

export function useTranslation() {
  const { settings, updateSettings } = useSettingsStore()
  const lang = settings.language as Language

  const translations = useMemo(() => {
    return lang === 'zh-CN' ? zhCN : enUS
  }, [lang])

  const t = (key: string, params?: Record<string, string | number>): string => {
    const value = getByPath(translations, key)
    if (typeof value !== 'string') return key // fallback to key itself
    return interpolate(value, params)
  }

  const setLanguage = (language: Language) => {
    updateSettings({ language })
  }

  return { t, lang, setLanguage, translations }
}
