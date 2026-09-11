// src/components/workflows/canvas/nodes/WorkflowNode.tsx —— 画布自定义节点（UI Task 13）
//
// 设计语言（spec 2026-09-10 + §6）：单对角切角卡（.cut-sm + >.ci）、发丝线外框、四主题变量；
// 外层细线颜色 = 运行状态色（idle 灰 / running 品牌 / done 成功 / failed 失败 / skipped 淡化），
// 与 SkillsPanel/AgentsPanel 的卡片同一套语义色，不引入新颜色。
//
// 条件节点（if/classify/confirm）按 handle 分色（spec §2 契约②）：
//   true=品牌橙 · false=中性灰 · route:i=品牌→信息色渐变 · fail=警示红（retry.on_error=branch）
//   confirm 三态：approved=成功绿 / rejected=失败红 / timeout=警示黄
// handle → 色的唯一映射来自 workflowModel.handleTone（配置面板共用，避免两处漂移）。
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { nodeTypeLabel, outputHandles, type HandleTone, type NodeRunStatus } from '@/lib/workflowModel'
import { cn } from '@/lib/utils'

/** handle 语义色（与 .cut 状态色同源；渐变用于 route:i） */
const TONE_BG: Record<HandleTone, string> = {
  true: 'var(--brand-500)',
  false: 'var(--text-tertiary)',
  route: 'linear-gradient(180deg, var(--brand-500), var(--info))',
  fail: 'var(--error)',
  approve: 'var(--success)',
  reject: 'var(--error)',
  timeout: 'var(--warning)',
  plain: 'var(--border-default)',
}

/** 状态 → 外框细线色（.cut-sm 的 padding 区即细线，直接改 background） */
const STATUS_LINE: Record<NodeRunStatus, string> = {
  idle: 'var(--border-default)',
  running: 'var(--brand-500)',
  done: 'color-mix(in srgb, var(--success) 70%, transparent)',
  failed: 'var(--error)',
  skipped: 'color-mix(in srgb, var(--text-tertiary) 45%, transparent)',
}

const STATUS_TEXT: Record<NodeRunStatus, string> = {
  idle: '',
  running: '执行中',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
}

export function WorkflowNode({ data, selected }: NodeProps) {
  const d = data as { label?: string; nodeType?: string; config?: Record<string, any>; status?: NodeRunStatus }
  const nodeType = String(d.nodeType || 'code')
  const status: NodeRunStatus = d.status ?? 'idle'
  const label = d.label || nodeTypeLabel(nodeType)
  const handles = outputHandles({ id: 'x', type: nodeType, config: d.config || {} })
  const summary = configSummary(nodeType, d.config || {})

  return (
    <div
      className={cn('cut-sm min-w-[168px] max-w-[220px] transition-[background] duration-200', selected && 'hot')}
      style={{
        background: STATUS_LINE[status],
        ...(status === 'skipped' ? { opacity: 0.6 } : {}),
      }}
    >
      <div className="ci px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          {/* 类型徽标：中文名（图标域内复用会与 rail 撞语义，故只用文字微标） */}
          <span className="text-[9px] px-1 py-0.5 rounded bg-brand-500/10 text-brand-500/85 shrink-0">
            {nodeTypeLabel(nodeType)}
          </span>
          <span className="text-xs font-medium text-primary truncate flex-1" title={label}>{label}</span>
          {status !== 'idle' && (
            <span
              className={cn(
                'text-[9px] shrink-0',
                status === 'running' && 'text-brand-500',
                status === 'done' && 'text-success',
                status === 'failed' && 'text-error',
                status === 'skipped' && 'text-tertiary',
              )}
            >
              {STATUS_TEXT[status]}
            </span>
          )}
        </div>
        {/* 一行配置摘要（让画布无需点开也大致可读） */}
        {summary && (
          <div className="mt-1 text-[10px] text-tertiary font-mono truncate" title={summary}>
            {summary}
          </div>
        )}

        {/* 入口（左侧中点） */}
        <Handle type="target" position={Position.Left} style={{ background: 'var(--border-default)', width: 8, height: 8 }} />

        {/* 出口：非条件节点单出口（右中点）；条件节点按 outputHandles 沿右侧等分排布 */}
        {handles.length === 0 ? (
          <Handle type="source" position={Position.Right} style={{ background: 'var(--brand-500)', width: 8, height: 8 }} />
        ) : (
          handles.map((h, i) => (
            <Handle
              key={h.id}
              id={h.id}
              type="source"
              position={Position.Right}
              title={h.label}
              style={{
                background: TONE_BG[h.tone],
                width: 8,
                height: 8,
                top: `${((i + 1) / (handles.length + 1)) * 100}%`,
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** 配置摘要：每种类型取最有信息量的一两个字段 */
function configSummary(type: string, config: Record<string, any>): string {
  const cut = (v: unknown, n = 26) => {
    const s = typeof v === 'string' ? v : v === undefined || v === null || v === '' ? '' : JSON.stringify(v)
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  switch (type) {
    case 'llm': case 'agent': return cut(config.prompt)
    case 'code': return cut(config.code)
    case 'template': case 'answer': return cut(config.template)
    case 'http': return `${config.method || 'GET'} ${cut(config.url, 20)}`.trim()
    case 'document': return cut(config.path)
    case 'tool': return String(config.tool || '')
    case 'subworkflow': return String(config.workflow || '')
    case 'if': return Array.isArray(config.conditions) ? `${config.conditions.length} 个条件` : ''
    case 'join': return String(config.mode || '')
    case 'assign': return config.var ? `${config.var} = ${cut(config.value, 14)}` : ''
    case 'list': return String(config.op || '')
    case 'iterate': return config.input ? `${cut(config.input, 18)} ×${config.parallel_nums ?? 1}` : ''
    case 'loop': return config.count ? `×${config.count}` : ''
    case 'memory': case 'store': return cut(config.query || config.content)
    case 'classify': return Array.isArray(config.routes) ? `${config.routes.length} 类` : ''
    case 'extract': return cut(config.input, 20)
    case 'confirm': return cut(config.message, 20)
    case 'aggregate': return cut(config.output, 20)
    case 'end': return config.outputs && Object.keys(config.outputs).length ? `${Object.keys(config.outputs).length} 项输出` : ''
    default: return ''
  }
}
