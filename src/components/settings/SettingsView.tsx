import { useState } from 'react'
import { Settings } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button,
} from '@/components/ui'
import { useUIStore } from '@/stores/uiStore'
import { useTranslation } from '@/i18n/useTranslation'
import { SettingsContent } from '@/components/settings/SettingsContent'

/**
 * 设置弹窗（主窗口形态）：Radix Dialog 壳 + SettingsContent 内容主体。
 * 独立设置模块窗口复用 SettingsContent（见 SettingsModule），不经过本组件。
 */
export function SettingsView() {
  const { settingsOpen, closeSettings } = useUIStore()
  const { t } = useTranslation()
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
        <SettingsContent onClose={closeSettings} onInnerDialogChange={setShowAddProviderDialog} />
        <DialogFooter>
          <Button variant="ghost" onClick={closeSettings}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
