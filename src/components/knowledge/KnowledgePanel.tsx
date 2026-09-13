// src/components/knowledge/KnowledgePanel.tsx —— 知识库面板（S2 第 7 rail 的宿主）
//
// S2 Task 1 只建**占位**：保证 rail 可点、可持久化、面板可辨识即可。
// 三栏骨架（左 236px 空间+文件树 / 中 flex-1 四视图 / 右 212px 大纲反链元信息）与
// 阅读、编辑、图谱、搜索四视图由 Task 3 起逐任务填充——此处不提前搭架子，避免与 Task 3 重叠返工。
// 图标唯一性：知识语义用 Library（BookOpen 已被 SkillsPanel 占用），与 railMeta 保持一致。
import { Library } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'
import { useKnowledgeStore } from '@/stores/knowledgeStore'

export function KnowledgePanel() {
  const { t } = useTranslation()
  // 只订阅自己用得到的字段（仓库纪律：不整店订阅，避免无关写入重建整棵面板树）
  const view = useKnowledgeStore(s => s.view)
  const spaceId = useKnowledgeStore(s => s.spaceId)

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-default">
        <Library className="w-[15px] h-[15px] text-secondary" />
        <span className="text-sm text-primary">{t('rail.knowledge')}</span>
        <span className="micro text-tertiary">{spaceId ?? '—'} · {view}</span>
      </div>
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="py-8 text-center text-tertiary text-xs">{t('knowledge.placeholder')}</p>
      </div>
    </div>
  )
}
