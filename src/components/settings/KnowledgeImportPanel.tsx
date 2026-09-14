// src/components/settings/KnowledgeImportPanel.tsx —— 知识库文件导入上限（2026-09-14）
//
// 为什么需要这个设置项：内核默认 500 文件 / 300MB，且是**整批拒绝**式护栏 —— 超出时
// 一个都不导（不是"导前 500 个"）。企业知识库常有上千文件的资料目录，默认档会直接拒绝，
// 而用户看到的只是一条错误，不知道"上限"这回事、更不知道去哪改。把它摆到设置里，
// 并**明确写出"超出会一个都不导"**，用户才能做出知情选择：
//   · 想一次导完 → 调大上限（代价：单次占更多内存/更久）
//   · 想稳一点  → 保持默认，分几次导
//
// 数值范围与钳制都来自 src/lib/knowledgeImportUi.ts（与服务端 knowledge-import-policy.cjs
// 同源，parity 测试钉住）。这里只做渲染与写回，不自己算边界 —— 各算一套必然漂移。
import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useSettingsStore } from '@/stores/settingsStore'
import {
  DEFAULT_KNOWLEDGE_IMPORT_POLICY, KNOWLEDGE_IMPORT_LIMITS, normalizeKnowledgeImportPolicyUi,
} from '@/lib/knowledgeImportUi'

const MB = 1024 * 1024

export function KnowledgeImportPanel() {
  const { t } = useTranslation()
  const settings = useSettingsStore(s => s.settings)
  const updateSettings = useSettingsStore(s => s.updateSettings)
  const policy = normalizeKnowledgeImportPolicyUi(settings.knowledgeImport)

  // 输入框用**字符串**暂存：用户清空重输时会经过空串，若直接绑数字会立刻被归一成默认值
  // （表现为"删掉就跳回 500"，没法正常改）。落库（onBlur）时才归一。
  const [filesText, setFilesText] = useState(String(policy.maxFiles))
  const [mbText, setMbText] = useState(String(Math.round(policy.maxTotalBytes / MB)))

  // 策略变化（例如"恢复默认"、或 onBlur 后被钳制）时回写输入框，让用户看到**实际生效值**。
  // 用 effect 而不是渲染期 setState：后者在渲染中读 DOM/写 state 是反模式，
  // 且 StrictMode 双渲染下容易出现输入被吞。依赖值只在 commit 后变化，不会打断输入。
  useEffect(() => { setFilesText(String(policy.maxFiles)) }, [policy.maxFiles])
  useEffect(() => { setMbText(String(Math.round(policy.maxTotalBytes / MB))) }, [policy.maxTotalBytes])

  function commit(next: { maxFiles?: number; maxTotalBytes?: number }) {
    updateSettings({
      knowledgeImport: normalizeKnowledgeImportPolicyUi({ ...policy, ...next }),
    })
  }

  const limitFiles = KNOWLEDGE_IMPORT_LIMITS.maxFiles
  const limitMb = Math.round(KNOWLEDGE_IMPORT_LIMITS.maxTotalBytes / MB)
  const isDefault = policy.maxFiles === DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxFiles
    && policy.maxTotalBytes === DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxTotalBytes

  return (
    <div className="space-y-4" data-testid="knowledge-import-panel">
      <div className="flex items-center gap-2">
        <Upload className="w-4 h-4 text-brand-500" />
        <h3 className="text-sm font-medium text-primary">{t('settings.importTab')}</h3>
      </div>

      {/* 把"整批拒绝"的语义写在最显眼处：这是用户唯一无法从"上限"二字推断出来的关键后果 */}
      <p className="text-xs text-secondary leading-relaxed">
        {t('settings.importLimitNote')}
      </p>

      <div className="grid grid-cols-2 gap-3 max-w-lg">
        <label className="block">
          <span className="text-xs text-secondary">{t('settings.importMaxFiles')}</span>
          <input
            id="ki-max-files"
            type="number"
            min={KNOWLEDGE_IMPORT_LIMITS.minFiles}
            max={limitFiles}
            value={filesText}
            onChange={(e) => setFilesText(e.target.value)}
            onBlur={() => commit({ maxFiles: Number(filesText) })}
            className="mt-1 w-full rounded-md border bg-surface px-2 py-1.5 text-sm text-primary"
          />
          <span className="mt-0.5 block text-[10px] text-tertiary">
            {t('settings.importRangeHint').replace('{min}', String(KNOWLEDGE_IMPORT_LIMITS.minFiles)).replace('{max}', String(limitFiles))}
          </span>
        </label>

        <label className="block">
          <span className="text-xs text-secondary">{t('settings.importMaxTotalMb')}</span>
          <input
            id="ki-max-mb"
            type="number"
            min={Math.round(KNOWLEDGE_IMPORT_LIMITS.minTotalBytes / MB)}
            max={limitMb}
            value={mbText}
            onChange={(e) => setMbText(e.target.value)}
            onBlur={() => commit({ maxTotalBytes: Number(mbText) * MB })}
            className="mt-1 w-full rounded-md border bg-surface px-2 py-1.5 text-sm text-primary"
          />
          <span className="mt-0.5 block text-[10px] text-tertiary">
            {t('settings.importRangeHint').replace('{min}', String(Math.round(KNOWLEDGE_IMPORT_LIMITS.minTotalBytes / MB))).replace('{max}', String(limitMb))}
          </span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={isDefault}
          onClick={() => {
            updateSettings({ knowledgeImport: { ...DEFAULT_KNOWLEDGE_IMPORT_POLICY } })
          }}
          className="rounded-md border px-2.5 py-1 text-xs text-secondary hover:text-primary disabled:opacity-40"
        >
          {t('settings.importRestoreDefault')}
        </button>
        <span className="text-[10px] text-tertiary">
          {t('settings.importCurrentDefault')
            .replace('{files}', String(DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxFiles))
            .replace('{mb}', String(Math.round(DEFAULT_KNOWLEDGE_IMPORT_POLICY.maxTotalBytes / MB)))}
        </span>
      </div>

      {/* 越界值会被静默钳制到边界（服务端同口径）：说出来，免得用户以为"我填的 0 生效了" */}
      <p className="text-[10px] text-tertiary leading-relaxed">
        {t('settings.importClampNote')}
      </p>
    </div>
  )
}
