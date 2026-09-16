// src/components/skills/SkillDetailPanel.tsx —— 技能卡片的「详情 + 只读展开管理」（2026-09-15，批次二 C）。
//
// ## 对应需求与决策
//
// 需求：「每张卡片注明 skill 详情，展开可管理触发规则，管理关联脚本」。
// 决策 D2 = **只读展示 + 系统打开文件**：本组件**没有任何保存/写入按钮**，也不向 SKILL.md 写一个字节。
// "管理"的实际动作是"用系统默认程序打开那个文件"（走既有 IPC `openInExplorer` → `shell.openPath`），
// 用户在自己的编辑器里改。这样应用永不参与用户技能文件的格式演进 —— 这些文件里承载着 gxtz-*/yfwdoc-*
// 等大量业务内容，任何"应用规范化写入"都是格式风险。
//
// ## 两个刻意的设计选择
//
//   ① **按需拉取**：详情在展开时才请求（关联脚本清单需 readdir 技能目录，列表页不该为几十个技能做这件事）。
//      请求失败/404 时如实显示"该技能在磁盘上已不存在"，而不是渲染空白面板（用户会以为界面坏了）。
//   ② **父级归因要标明是"声明的"还是"猜的"**（D1：显式声明优先 + 前缀启发式兜底）：两者对用户的意义
//      完全不同——"声明的"是作者的意图，改不了；"猜的"是界面按前缀分的，可以纠正。混在一起显示会让
//      用户以为分组是作者定的。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { FileCode2, FileText, FolderOpen, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// 数据层在 @/lib/skillDetail（.tsx 无法被 node --test 直接 import，故逻辑必须落在 .ts）
import { fetchSkillDetail, openLocalPath, type SkillDetail } from '@/lib/skillDetail'

type Props = {
  skillId: string
  disabled?: boolean
  /** 该技能所属的父级分类（界面分组结果，用于展示归因） */
  folder?: string
}

export function SkillDetailPanel({ skillId, disabled, folder }: Props) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void fetchSkillDetail(skillId).then((d) => {
      if (!alive) return
      if ('error' in d) { setError(d.error === 'not-found' ? t('skills.detailNotFound') : t('skills.detailError', { error: d.error }) ) }
      else setDetail(d)
      setLoading(false)
    })
    return () => { alive = false }
  }, [skillId, t])

  // "管理"的实际动作 = 系统打开文件（只读；失败出声，别让用户以为点了没反应是正常的）
  const fail = (msg: string) => alert(msg)
  const openPath = (p: string) => { void openLocalPath(p).then((err) => { if (err) fail(err) }) }

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-tertiary py-1">
        <Loader2 className="w-3 h-3 animate-spin" />{t('skills.detailLoading')}
      </div>
    )
  }
  if (error || !detail) {
    return (
      <div className="flex items-start gap-1.5 text-[10px] text-warning py-1">
        <AlertTriangle className="w-3 h-3 mt-[1px] shrink-0" />
        <span>{error || t('skills.detailNotFound')}</span>
      </div>
    )
  }

  return (
    <div className="mt-1.5 rounded border border-subtle bg-input/40 p-2 space-y-1.5">
      {/* 头部：来源目录 + 打开 SKILL.md（D2 的"管理"入口） */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-tertiary">{t('skills.detailSource')}</span>
        <code className="text-[10px] text-secondary truncate flex-1" title={detail.skillFile}>
          {detail.dir}
        </code>
        <button
          type="button"
          onClick={() => openPath(detail.skillFile)}
          className="shrink-0 flex items-center gap-1 px-1.5 h-[20px] rounded text-[10px] border border-subtle text-secondary hover:text-primary hover:border-accent/50"
          title={detail.skillFile}
        >
          <FolderOpen className="w-3 h-3" />{t('skills.openSkillFile')}
        </button>
      </div>

      {/* 父级归因（D1）：明确区分"声明的"与"按前缀推断的" */}
      <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
        <span className="text-tertiary">{t('skills.detailParent')}</span>
        {detail.parent ? (
          <>
            <code className="text-secondary">{detail.parent}</code>
            <span className="px-1 rounded bg-brand-500/15 text-brand-400 text-[9px]">
              {t('skills.parentExplicit')}
            </span>
          </>
        ) : (
          <span className="text-tertiary/70">{t('skills.parentNone')}</span>
        )}
        {folder && (
          <>
            <span className="text-tertiary">· {t('skills.detailFolder')}</span>
            <span className="text-secondary">{folder}</span>
            {/* 归因口径（D1）：技能**声明了** parent ⇒ 分类意图是作者定的，标"已声明"；
                没声明 ⇒ 分类是界面按前缀推断的，标"按前缀推断"并提示如何固定下来。
                这两者对用户的意义不同：前者改不了，后者可纠正，混在一起会让人误以为作者定的。 */}
            <span
              className={cn('px-1 rounded text-[9px]', detail.parent
                ? 'bg-brand-500/15 text-brand-400'
                : 'bg-input text-tertiary')}
              title={detail.parent ? t('skills.folderExplicitHint') : t('skills.folderHeuristicHint')}
            >
              {detail.parent ? t('skills.parentExplicit') : t('skills.parentHeuristic')}
            </span>
          </>
        )}
      </div>

      {/* 触发规则（只读原文） */}
      <div>
        <span className="text-[10px] text-tertiary">{t('skills.detailTriggers')}</span>
        {detail.triggers.length ? (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {detail.triggers.map((tr, i) => (
              <span key={`${tr}-${i}`} className="text-[10px] px-1 py-0.5 rounded bg-input text-secondary">{tr}</span>
            ))}
          </div>
        ) : (
          <span className="text-[10px] text-tertiary/70 ml-1">{t('skills.detailTriggersNone')}</span>
        )}
      </div>

      {/* 关联脚本（只读清单 + 逐个用系统程序打开） */}
      <div>
        <span className="text-[10px] text-tertiary">
          {t('skills.detailScripts', { count: detail.scripts.length })}
        </span>
        {detail.scripts.length === 0 ? (
          <span className="text-[10px] text-tertiary/70 ml-1">
            {detail.isFlat ? t('skills.detailScriptsFlat') : t('skills.detailScriptsNone')}
          </span>
        ) : (
          <div className="mt-0.5 space-y-0.5">
            {detail.scripts.map((s) => (
              <div key={s.path} className="flex items-center gap-1.5">
                <FileCode2 className="w-3 h-3 text-tertiary shrink-0" />
                <button
                  type="button"
                  onClick={() => openPath(s.path)}
                  className="text-[10px] text-secondary hover:text-accent truncate text-left"
                  title={s.path}
                >
                  {s.name}
                </button>
                <span className="text-[9px] text-tertiary/60 shrink-0">{s.sizeKb}KB</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 伴随文档（如 README/配置样例）：同样只读 + 可打开 */}
      {detail.docs.length > 0 && (
        <div>
          <span className="text-[10px] text-tertiary">{t('skills.detailDocs', { count: detail.docs.length })}</span>
          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
            {detail.docs.map((d) => (
              <button
                key={d.path}
                type="button"
                onClick={() => openPath(d.path)}
                className="flex items-center gap-1 text-[10px] text-secondary hover:text-accent"
                title={d.path}
              >
                <FileText className="w-3 h-3 text-tertiary" />{d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className={cn('text-[9px] leading-relaxed', disabled ? 'text-warning/80' : 'text-tertiary/70')}>
        {t('skills.detailReadOnlyHint')}
      </p>
    </div>
  )
}
