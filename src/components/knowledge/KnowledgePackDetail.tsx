// src/components/knowledge/KnowledgePackDetail.tsx —— 市场右栏详情（S4 Task 6）
//
// README 渲染**必须**沿用 src/components/chat/MarkdownText.tsx 的 MD_PLUGINS/MD_COMPONENTS：
// spec §6 要求"只用 react-markdown + remark-gfm、禁 rehype-raw、禁 dangerouslySetInnerHTML"——
// README 是**不可信输入**（清单里任意人可提交的包），用 raw HTML 通道等于把 XSS 面开在知识库里。
// components 表在模块顶层建好（稳定引用）：MarkdownText.tsx 记着那起"每渲染新建对象导致整棵子树重挂载"的事故。
//
// 版本状态必须显式展示三态：`current`（兼容）/`fallback`（按 versions.json 回退，**装到的不是清单最新版**）/
// `needs-higher-app`（装不了）。只显示一个版本号会让用户以为回退版本就是清单里的最新版。
import ReactMarkdown from 'react-markdown'
import { AlertTriangle, Download, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { MD_COMPONENTS, MD_PLUGINS } from '@/components/chat/MarkdownText'
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgePackDetailData } from '@/lib/knowledgePacksApi'
import { versionTone } from '@/lib/knowledgeMarket'
import { KnowledgeEmpty } from './KnowledgeEmpty'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'

export interface KnowledgePackDetailProps {
  data: KnowledgePackDetailData | null
  loading: boolean
  error: string | null
  /** 有在途写操作时禁用全部按钮（安装/卸载不可重入） */
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
}

export function KnowledgePackDetail({ data, loading, error, busy, onInstall, onUninstall }: KnowledgePackDetailProps) {
  const { t } = useTranslation()
  if (loading) return <KnowledgeSkeleton lines={10} className="!px-3" />
  if (error) return <KnowledgeEmpty title={t('knowledge.loadFailed')} hint={error} className="m-auto" />
  if (!data) return <KnowledgeEmpty title={t('knowledge.marketSelect')} className="m-auto" />

  const { pack, installed } = data
  const tone = versionTone(data.version)
  const installedVersion = installed?.version || ''
  const canUpdate = !!installed && data.updateAvailable

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-default space-y-1">
        <div className="flex items-center gap-1.5">
          <h3 className="flex-1 min-w-0 truncate text-xs font-semibold text-primary">{pack.name}</h3>
          {data.pack.author && <span className="micro shrink-0">{pack.author}</span>}
        </div>
        <p className="text-[10px] text-tertiary truncate" title={pack.id}>
          {pack.id} · v{data.version.version || pack.version}
          {pack.tags.length ? ` · ${pack.tags.join(' / ')}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
          <span className="text-tertiary">{t('knowledge.marketLicense')}：<span className="text-secondary">{pack.license}</span></span>
          {installed && (
            <span className="text-tertiary">
              {t('knowledge.marketInstalledAt', { version: installedVersion, files: installed.files })}
            </span>
          )}
          {/* 来源：本地清单（未联网）/ 在线清单地址。详情响应里没有 localPath（那是清单条目字段），
              故用 registry 与 source 表达"这个包是从哪儿读出来的" */}
          <span className="text-tertiary truncate" title={data.registry}>
            {t('knowledge.marketSourcePath')}：{data.source === 'local' ? t('knowledge.marketSourceLocal') : (data.registry || '—')}
          </span>
        </div>
        {/* 版本兼容状态：三态各有各的处置（能装 / 装的是回退版 / 装不了） */}
        {tone === 'current' && (
          <p className="flex items-center gap-1 text-[10px] text-success">
            <ShieldCheck className="w-3 h-3 shrink-0" />{t('knowledge.marketVersionCurrent')}
          </p>
        )}
        {tone === 'fallback' && (
          <p className="flex items-center gap-1 text-[10px] text-warning">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            {t('knowledge.marketVersionFallback', { version: data.version.version || '' })}
          </p>
        )}
        {tone === 'needs-higher-app' && (
          <p className="flex items-center gap-1 text-[10px] text-error">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            {t('knowledge.marketVersionHigher', { min: data.version.requiredMin || '' })}
          </p>
        )}
        {!!data.warnings?.length && (
          <p className="text-[10px] text-tertiary">{[...new Set(data.warnings)].join(' · ')}</p>
        )}
      </div>

      {/* 动作区：装/更新/卸载。安装一律走确认浮层（宿主负责），这里只发意图 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-default">
        <Button variant="primary" size="xs" disabled={busy || tone === 'needs-higher-app'} onClick={onInstall}>
          {canUpdate ? <RefreshCw className="w-3 h-3" /> : <Download className="w-3 h-3" />}
          {canUpdate ? t('knowledge.marketUpdate', { version: data.version.version || pack.version }) : t('knowledge.marketInstall')}
        </Button>
        {!!installed && (
          <Button variant="danger" size="xs" disabled={busy} onClick={onUninstall}>
            <Trash2 className="w-3 h-3" />{t('knowledge.marketUninstall')}
          </Button>
        )}
      </div>

      {/* README：不可信输入 → 只用 react-markdown（无 raw HTML 通道） */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[11px] text-secondary">
        {data.readme?.trim()
          ? <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>{data.readme}</ReactMarkdown>
          : <p className="text-tertiary">{t('knowledge.marketNoReadme')}</p>}
      </div>
    </div>
  )
}
