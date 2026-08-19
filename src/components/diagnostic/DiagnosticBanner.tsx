import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useDiagStore } from '@/stores/diagStore'
import { useTranslation } from '@/i18n/useTranslation'

export function DiagnosticBanner() {
  const { overall, errorCount, openDiagnostics } = useDiagStore()
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (overall !== 'error') { setVisible(false); return }
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), 5000)
    return () => clearTimeout(timer)
  }, [overall])

  if (!visible || overall !== 'error') return null
  return (
    <button
      onClick={() => { setVisible(false); openDiagnostics() }}
      className="fixed right-4 top-14 z-[90] flex items-center gap-2 px-4 py-2.5 rounded-lg bg-error/15 border border-error/30 text-sm text-error shadow-modal"
    >
      <AlertTriangle className="w-4 h-4" />
      {t('diagnostic.overallError', { n: errorCount })}
      <X className="w-3.5 h-3.5 opacity-60" onClick={(e) => { e.stopPropagation(); setVisible(false) }} />
    </button>
  )
}
