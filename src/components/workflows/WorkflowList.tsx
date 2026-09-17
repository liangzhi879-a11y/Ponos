// src/components/workflows/WorkflowList.tsx —— 工作流列表（UI Task 13，spec §6 第 1 层）
//
// 卡片网格（与 SkillsPanel/AgentsPanel 同一套全主界面卡片化语言）：行内显示
// 节点数 / 触发词 / 暴露态 / 最近运行状态 / 需升级标记；操作：打开 / 运行 / 复制 / 导出 / 删除。
// 分组：我的 / 已公开（列表 API 未提供"内置"标志，故不做内置分组——内置工作流与用户工作流
// 同目录同形态，硬编码名单会随内核更新失准）。
import { useState } from 'react'
import { Plus, Import, Play, Copy, Download, Trash2, AlertTriangle, Clock, GitBranch } from 'lucide-react'
import { Badge, Button, Input, ScrollArea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { asTriggerList, checkWorkflowId } from '@/lib/workflowModel'
import { runStatusOf, type WorkflowMeta } from '@/lib/workflowApi'
import { WorkflowDeleteDialog } from './WorkflowDeleteDialog'

export interface WorkflowListProps {
  list: WorkflowMeta[]
  loading: boolean
  error?: string
  onOpen: (id: string) => void
  onCreate: (id: string) => void
  onRun: (id: string) => void
  onDuplicate: (id: string) => void
  onExport: (id: string) => void
  /** 删除确认对话框已先行拦截（见 WorkflowDeleteDialog 的 why）；此回调只管执行删除，
   *  返回 { ok:false } 时对话框会就地显示原因且不关闭。 */
  onDelete: (id: string) => void | Promise<{ ok: boolean; error?: string } | void>
  onImport: (bundle: unknown) => void
  importing?: boolean
}

const STATUS_TONE: Record<string, { cls: string; text: string }> = {
  never: { cls: 'text-tertiary', text: '未运行' },
  ok: { cls: 'text-success', text: '上次成功' },
  failed: { cls: 'text-error', text: '上次失败' },
  cancelled: { cls: 'text-warning', text: '上次取消' },
  running: { cls: 'text-brand-500', text: '运行中' },
}

export function WorkflowList(props: WorkflowListProps) {
  const { list, loading, error } = props
  const [q, setQ] = useState('')
  const [newId, setNewId] = useState('')
  const [creating, setCreating] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  /** 待删除目标：非空即弹确认对话框（替代原先的 window.confirm，见 WorkflowDeleteDialog 的 why） */
  const [pendingDelete, setPendingDelete] = useState<WorkflowMeta | null>(null)

  const kw = q.trim().toLowerCase()
  /** 新建 id 的前端预校验（Task 12 审查 I-1）：非法即就地提示并禁用「创建」，不把错误推给后端 */
  const idIssue = newId ? checkWorkflowId(newId) : null
  const idOk = !!idIssue?.ok
  const submitNew = () => {
    if (!newId) return
    if (idIssue && !idIssue.ok) return
    props.onCreate(newId)
    setCreating(false)
    setNewId('')
  }
  const filtered = kw
    ? list.filter((m) => `${m.id} ${m.name || ''} ${asTriggerList(m.triggers).join(' ')}`.toLowerCase().includes(kw))
    : list
  const mine = filtered.filter((m) => m.expose?.mode !== 'public')
  const published = filtered.filter((m) => m.expose?.mode === 'public')

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* 头部：新建 / 导入 / 搜索 */}
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-brand-500" />
        <span className="text-sm font-semibold text-primary">工作流</span>
        <Badge variant="default">{list.length}</Badge>

        <div className="flex-1" />

        {creating ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={newId}
              placeholder="工作流 id（字母数字-_ .）"
              onChange={(e) => setNewId(e.target.value.replace(/[^\w.-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') submitNew() }}
              className={cn('h-7 w-[200px] text-xs', idIssue && !idIssue.ok && 'border-error')}
            />
            <Button size="xs" disabled={!idOk} onClick={submitNew}>创建</Button>
            <Button size="xs" variant="ghost" onClick={() => { setCreating(false); setNewId('') }}>取消</Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" />新建</Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}><Import className="w-3.5 h-3.5" />导入</Button>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-7 w-[160px] text-xs" />
      </div>

      {error && <div className="px-4 py-2 text-[11px] text-error border-b">{error}</div>}
      {creating && idIssue && !idIssue.ok && (
        <div className="px-4 py-1.5 text-[11px] text-error border-b">{idIssue.error}</div>
      )}
      {loading && <div className="px-4 py-2 text-[11px] text-tertiary">加载中…</div>}

      <ScrollArea className="flex-1">
        <div className="p-4 flex flex-col gap-4">
          {mine.length === 0 && published.length === 0 && !loading && (
            <div className="text-[11px] text-tertiary px-1 py-6 text-center">
              暂无工作流。点「新建」从 开始 → 结束 的最小骨架开始，或「导入」.yfwflow 分享包。
            </div>
          )}
          <Group title="我的工作流" items={mine} render={props} onRequestDelete={setPendingDelete} />
          <Group title="已公开（任意会话可调用）" items={published} render={props} onRequestDelete={setPendingDelete} />
        </div>
      </ScrollArea>

      {pendingDelete && (
        <WorkflowDeleteDialog
          meta={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const r = await props.onDelete(pendingDelete.id)
            // 成功 → 关掉对话框（列表由父组件 refreshList 刷新）
            if (!r || r.ok) setPendingDelete(null)
            return r
          }}
        />
      )}

      {importOpen && (
        <div className="border-t p-3 flex flex-col gap-2">
          <div className="text-[11px] text-secondary">粘贴 .yfwflow 包内容（JSON）</div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            className="w-full text-[11px] font-mono bg-input border rounded p-2 text-primary"
            placeholder='{"wf": "name: ...", "version": 1}'
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={props.importing}
              onClick={() => {
                try { props.onImport(JSON.parse(importText)); setImportOpen(false); setImportText('') } catch { /* 非法 JSON：保持输入框，用户自行修正 */ }
              }}
            >{props.importing ? '导入中…' : '导入'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setImportOpen(false)}>取消</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Group({ title, items, render, onRequestDelete }: {
  title: string
  items: WorkflowMeta[]
  render: WorkflowListProps
  onRequestDelete: (m: WorkflowMeta) => void
}) {
  if (items.length === 0) return null
  return (
    <div>
      <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-2">{title}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 content-start">
        {items.map((m) => <Row key={m.id} meta={m} {...render} onRequestDelete={onRequestDelete} />)}
      </div>
    </div>
  )
}

function Row({ meta, onOpen, onRun, onDuplicate, onExport, onRequestDelete }: { meta: WorkflowMeta; onRequestDelete: (m: WorkflowMeta) => void } & WorkflowListProps) {
  const st = STATUS_TONE[runStatusOf(meta)] || STATUS_TONE.never
  const mode = meta.expose?.mode || 'private'
  return (
    <div className={cn('cut-sm transition-all hover:hot-hover', meta.legacy && 'warn')}>
      <div className="ci p-3 flex flex-col gap-2 h-full">
        <div className="flex items-start gap-2">
          <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(meta.id)}>
            <div className="text-sm font-medium text-primary truncate">{meta.name || meta.id}</div>
            <div className="text-[10px] text-tertiary font-mono truncate">{meta.id}</div>
          </button>
          {meta.legacy && (
            <span className="flex items-center gap-1 text-[9px] text-warning shrink-0" title="旧格式（无 edges）：需升级为 DSL v2">
              <AlertTriangle className="w-3 h-3" />需升级
            </span>
          )}
        </div>

        {meta.description && <div className="text-[11px] text-secondary line-clamp-2">{meta.description}</div>}

        <div className="flex items-center flex-wrap gap-1.5 text-[10px] text-tertiary">
          <span className="px-1 py-0.5 rounded bg-elevated">{meta.nodeCount ?? 0} 节点</span>
          <span className="px-1 py-0.5 rounded bg-elevated">{meta.edgeCount ?? 0} 边</span>
          <span className={cn('px-1 py-0.5 rounded bg-elevated', mode === 'public' && 'text-brand-500')}>{mode}</span>
          {typeof meta.version === 'string' && <span className="px-1 py-0.5 rounded bg-elevated">v{meta.version}</span>}
        </div>

        {asTriggerList(meta.triggers).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {asTriggerList(meta.triggers).slice(0, 4).map((t) => (
              <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500/85">{t}</span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[10px]">
          <Clock className="w-3 h-3 text-tertiary" />
          <span className={st.cls}>{st.text}</span>
          {meta.lastRun?.nodes ? <span className="text-tertiary">· {meta.lastRun.nodes} 步</span> : null}
        </div>

        <div className="flex items-center gap-1 pt-1 mt-auto border-t">
          <Button size="xs" onClick={() => onRun(meta.id)} title="运行（先确认授权清单）"><Play className="w-3 h-3" />运行</Button>
          <Button size="xs" variant="ghost" onClick={() => onOpen(meta.id)}>打开</Button>
          <div className="flex-1" />
          <Button size="xs" variant="ghost" title="复制" onClick={() => onDuplicate(meta.id)}><Copy className="w-3 h-3" /></Button>
          <Button size="xs" variant="ghost" title="导出 .yfwflow" onClick={() => onExport(meta.id)}><Download className="w-3 h-3" /></Button>
          <Button size="xs" variant="ghost" title="删除" className="text-error" onClick={() => onRequestDelete(meta)}><Trash2 className="w-3 h-3" /></Button>
        </div>
      </div>
    </div>
  )
}
