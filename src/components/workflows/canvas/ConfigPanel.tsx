// src/components/workflows/canvas/ConfigPanel.tsx —— 右侧配置面板（UI Task 13）
//
// 三件事（spec §6）：
//   ① 按节点类型渲染动态表单（llm/http/if/tool/iterate… 各自字段）；
//   ② 每个文本输入旁给**变量选择器**：候选 = 上游可达节点的输出字段 `{{<nodeId>.<field>}}`
//      （reachableVars，按祖先可达性过滤——与本地校验同一份可达性逻辑）；
//   ③ 未选中节点时显示工作流级设置（name/inputs/expose/permissions/max_parallel），
//      与顶部工具栏共用一份 model（画布是位置/config 的真相，此处只改非位置字段）。
//
// 输入更新纪律：所有改动都走 onChange(nextModel)（整模型替换）——避免就地 mutate，
// 保证画布"节流回写 + 保存前 flush"两份更新不会互相覆盖（都基于最新 model 派生）。
import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Braces, ChevronDown, ChevronRight } from 'lucide-react'
import { Badge, Button, Input, Switch, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  nodeTypeLabel, reachableVars, retryOnError,
  type NodeModel, type WorkflowModel,
} from '@/lib/workflowModel'

export interface ConfigPanelProps {
  model: WorkflowModel
  nodeId: string | null
  onChange: (next: WorkflowModel) => void
}

const OPS = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'not_contains', 'matches', 'is_empty', 'not_empty']

export function ConfigPanel({ model, nodeId, onChange }: ConfigPanelProps) {
  const node = model.nodes.find((n) => n.id === nodeId) || null
  const vars = useMemo(() => (node ? reachableVars(model, node.id) : []), [model, nodeId])

  const patchNode = (patch: Partial<NodeModel>) => {
    if (!node) return
    onChange({ ...model, nodes: model.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) })
  }
  const patchConfig = (patch: Record<string, any>) => {
    if (!node) return
    patchNode({ config: { ...(node.config || {}), ...patch } })
  }

  return (
    <div className="w-[300px] shrink-0 border-l flex flex-col min-h-0">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <span className="text-[11px] font-semibold text-secondary">
          {node ? '节点配置' : '工作流设置'}
        </span>
        {node && (
          <>
            <Badge variant="primary">{nodeTypeLabel(node.type)}</Badge>
            <span className="text-[10px] text-tertiary font-mono truncate">{node.id}</span>
          </>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {!node ? (
          <WorkflowSettings model={model} onChange={onChange} />
        ) : (
          <>
            <Field label="显示名">
              <Input
                value={node.label || ''}
                placeholder={nodeTypeLabel(node.type)}
                onChange={(e) => patchNode({ label: e.target.value })}
                className="h-7 text-xs"
              />
            </Field>

            <NodeForm node={node} vars={vars} model={model} patchConfig={patchConfig} patchNode={patchNode} />

            {/* 错误策略（内核 retry.on_error；branch 时画布多一个 fail 出口） */}
            <div className="pt-1 border-t">
              <div className="text-[10px] font-semibold text-tertiary uppercase tracking-wider mb-1.5">失败处理</div>
              <Field label="on_error" hint="branch = 走 fail 出边；continue = 记错误继续；fail = 整轮失败">
                <select
                  value={retryOnError(node) || 'fail'}
                  onChange={(e) => patchNode({ retry: { ...(node.retry || {}), on_error: e.target.value } })}
                  className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
                >
                  <option value="fail">fail（整轮失败）</option>
                  <option value="continue">continue（跳过并继续）</option>
                  <option value="branch">branch（走失败分支）</option>
                </select>
              </Field>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ===================== 各节点类型表单 =====================

function NodeForm({ node, vars, model, patchConfig, patchNode }: {
  node: NodeModel
  vars: Array<{ path: string; label: string }>
  model: WorkflowModel
  patchConfig: (p: Record<string, any>) => void
  patchNode: (p: Partial<NodeModel>) => void
}) {
  const cfg = node.config || {}
  switch (node.type) {
    case 'start':
      return (
        <div className="text-[11px] text-tertiary leading-relaxed">
          工作流入口。可用输入在下方「工作流设置」里定义（<span className="font-mono">{'{{inputs.x}}'}</span>）。
        </div>
      )
    case 'inputs':
      return (
        <div className="text-[11px] text-tertiary leading-relaxed">
          输入参数在工作流级定义，见「工作流设置 → 输入参数」。本节点仅作画布标注，运行时不执行。
        </div>
      )
    case 'llm':
      return (
        <>
          <VarField label="prompt" value={cfg.prompt || ''} onChange={(v) => patchConfig({ prompt: v })} vars={vars} rows={5} />
          <VarField label="system" value={cfg.system || ''} onChange={(v) => patchConfig({ system: v })} vars={vars} rows={3} />
          <Field label="model" hint="留空用当前会话默认模型">
            <Input value={cfg.model || ''} onChange={(e) => patchConfig({ model: e.target.value })} className="h-7 text-xs" />
          </Field>
          <Field label="max_tokens">
            <Input
              type="number" value={cfg.max_tokens ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ max_tokens: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'agent':
      return (
        <>
          <VarField label="prompt" value={cfg.prompt || ''} onChange={(v) => patchConfig({ prompt: v })} vars={vars} rows={5} />
          <ListField
            label="tools（可选工具名，逗号分隔）"
            value={Array.isArray(cfg.tools) ? cfg.tools.join(', ') : ''}
            onChange={(v) => patchConfig({ tools: v.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="Read, Write, Bash"
          />
          <Field label="max_rounds" hint="ReAct 循环上限">
            <Input
              type="number" value={cfg.max_rounds ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ max_rounds: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'classify':
      return (
        <>
          <VarField label="input" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} rows={2} />
          <RoutesEditor routes={Array.isArray(cfg.routes) ? cfg.routes : []} onChange={(routes) => patchConfig({ routes })} />
        </>
      )
    case 'extract':
      return (
        <>
          <VarField label="input" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} rows={3} />
          <Field label="schema（JSON）" hint="字段名 → 类型/描述">
            <Textarea
              value={typeof cfg.schema === 'string' ? cfg.schema : JSON.stringify(cfg.schema || {}, null, 2)}
              onChange={(e) => patchConfig({ schema: e.target.value })}
              rows={4}
              className="text-[11px] font-mono"
              placeholder={'{\n  "title": "string"\n}'}
            />
          </Field>
        </>
      )
    case 'code':
      return <VarField label="code（沙箱 JS）" value={cfg.code || ''} onChange={(v) => patchConfig({ code: v })} vars={vars} rows={8} mono />
    case 'template':
      return <VarField label="template" value={cfg.template || ''} onChange={(v) => patchConfig({ template: v })} vars={vars} rows={6} />
    case 'http':
      return (
        <>
          <Field label="url">
            <VarField label="" value={cfg.url || ''} onChange={(v) => patchConfig({ url: v })} vars={vars} />
          </Field>
          <Field label="method">
            <select
              value={cfg.method || 'GET'}
              onChange={(e) => patchConfig({ method: e.target.value })}
              className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <KVEditor label="headers" value={cfg.headers || {}} onChange={(v) => patchConfig({ headers: v })} vars={vars} />
          <VarField label="body" value={cfg.body || ''} onChange={(v) => patchConfig({ body: v })} vars={vars} rows={4} mono />
          <Field label="timeout_ms">
            <Input
              type="number" value={cfg.timeout_ms ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ timeout_ms: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'document':
      return (
        <>
          <Field label="path">
            <VarField label="" value={cfg.path || ''} onChange={(v) => patchConfig({ path: v })} vars={vars} />
          </Field>
          <Field label="mode" hint="text=纯文本读取；ocr=图片/扫描件">
            <select
              value={cfg.mode || 'text'}
              onChange={(e) => patchConfig({ mode: e.target.value })}
              className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
            >
              <option value="text">text</option>
              <option value="ocr">ocr</option>
            </select>
          </Field>
        </>
      )
    case 'list':
      return (
        <>
          <VarField label="input" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} />
          <Field label="op" hint="first/last/filter/sort/slice/join…">
            <Input value={cfg.op || ''} onChange={(e) => patchConfig({ op: e.target.value })} className="h-7 text-xs" />
          </Field>
          <VarField label="field（比较/排序字段，可选）" value={cfg.field || ''} onChange={(v) => patchConfig({ field: v })} vars={vars} />
          <Field label="value（比较值，可选）">
            <Input value={cfg.value ?? ''} onChange={(e) => patchConfig({ value: e.target.value })} className="h-7 text-xs" />
          </Field>
        </>
      )
    case 'loop':
      return (
        <>
          <Field label="count（循环次数）">
            <Input
              type="number" value={cfg.count ?? 1} className="h-7 text-xs"
              onChange={(e) => patchConfig({ count: Number(e.target.value) || 1 })}
            />
          </Field>
          <VarField label="until（条件，满足即停，可选）" value={cfg.until || ''} onChange={(v) => patchConfig({ until: v })} vars={vars} />
          <BodyPicker node={node} model={model} patchNode={patchNode} />
        </>
      )
    case 'iterate':
      return (
        <>
          <VarField label="input（数组引用）" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} />
          <Field label="parallel_nums（并行度，1=串行）">
            <Input
              type="number" value={cfg.parallel_nums ?? 1} className="h-7 text-xs"
              onChange={(e) => patchConfig({ parallel_nums: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Field>
          <BodyPicker node={node} model={model} patchNode={patchNode} />
        </>
      )
    case 'memory':
      return <VarField label="query" value={cfg.query || ''} onChange={(v) => patchConfig({ query: v })} vars={vars} rows={3} />
    case 'store':
      return (
        <>
          <VarField label="content" value={cfg.content || ''} onChange={(v) => patchConfig({ content: v })} vars={vars} rows={4} />
          <Field label="tags（逗号分隔）">
            <Input
              value={Array.isArray(cfg.tags) ? cfg.tags.join(', ') : (cfg.tags || '')}
              onChange={(e) => patchConfig({ tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              className="h-7 text-xs"
            />
          </Field>
        </>
      )
    case 'tool':
      return (
        <>
          <Field label="tool" hint="内置工具名（Read/Write/Bash/Template/OCR…）或自定义工具">
            <Input value={cfg.tool || ''} onChange={(e) => patchConfig({ tool: e.target.value })} className="h-7 text-xs" />
          </Field>
          <KVEditor label="input（参数键值）" value={cfg.input || {}} onChange={(v) => patchConfig({ input: v })} vars={vars} />
        </>
      )
    case 'subworkflow':
      return (
        <>
          <Field label="workflow（工作流 id）">
            <Input value={cfg.workflow || ''} onChange={(e) => patchConfig({ workflow: e.target.value })} className="h-7 text-xs" />
          </Field>
          <KVEditor label="inputs（参数键值）" value={cfg.inputs || {}} onChange={(v) => patchConfig({ inputs: v })} vars={vars} />
        </>
      )
    case 'if':
      return <ConditionsEditor conditions={Array.isArray(cfg.conditions) ? cfg.conditions : []} onChange={(conditions) => patchConfig({ conditions })} vars={vars} />
    case 'join':
      return (
        <Field label="mode" hint="concat=拼接文本；array=收集数组；first=取第一个">
          <select
            value={cfg.mode || 'concat'}
            onChange={(e) => patchConfig({ mode: e.target.value })}
            className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
          >
            {['concat', 'array', 'first'].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      )
    case 'assign':
      return (
        <>
          <Field label="var（变量名，写 {{var.名}} 读取）">
            <Input value={cfg.var || ''} onChange={(e) => patchConfig({ var: e.target.value })} className="h-7 text-xs" />
          </Field>
          <VarField label="value" value={cfg.value || ''} onChange={(v) => patchConfig({ value: v })} vars={vars} rows={3} />
        </>
      )
    case 'aggregate':
      return <VarField label="output（聚合模板）" value={cfg.output || ''} onChange={(v) => patchConfig({ output: v })} vars={vars} rows={4} />
    case 'confirm':
      return (
        <>
          <VarField label="message（给审批人看的说明）" value={cfg.message || ''} onChange={(v) => patchConfig({ message: v })} vars={vars} rows={3} />
          <Field label="timeout_ms（超时走 timeout 出边，可选）">
            <Input
              type="number" value={cfg.timeout_ms ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ timeout_ms: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'answer':
      return <VarField label="template（对话型输出）" value={cfg.template || ''} onChange={(v) => patchConfig({ template: v })} vars={vars} rows={5} />
    case 'end':
      return (
        <>
          <VarField label="output（整体输出模板，可选）" value={cfg.output || ''} onChange={(v) => patchConfig({ output: v })} vars={vars} rows={3} />
          <KVEditor label="outputs（具名返回值键值）" value={cfg.outputs || {}} onChange={(v) => patchConfig({ outputs: v })} vars={vars} />
        </>
      )
    default:
      return (
        <div className="text-[11px] text-tertiary">
          该类型暂无专属表单，配置以 JSON 编辑：
          <Textarea
            value={JSON.stringify(cfg, null, 2)}
            onChange={(e) => { try { patchConfig(JSON.parse(e.target.value || '{}')) } catch { /* 输入过程中的非法 JSON 忽略 */ } }}
            rows={5}
            className="text-[11px] font-mono mt-1"
          />
        </div>
      )
  }
}

// ===================== 结构化子编辑器 =====================

/** 变量选择器 + 文本输入（插入到光标处；候选按上游可达性过滤） */
function VarField({ label, value, onChange, vars, rows, mono, placeholder }: {
  label: string
  value: string
  onChange: (v: string) => void
  vars: Array<{ path: string; label: string }>
  rows?: number
  mono?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const insert = (path: string) => {
    const el = ref.current
    if (!el) { onChange(value + path); return }
    const s = el.selectionStart ?? value.length
    const e = el.selectionEnd ?? s
    onChange(value.slice(0, s) + path + value.slice(e))
    requestAnimationFrame(() => { el.focus(); try { el.setSelectionRange(s + path.length, s + path.length) } catch { /* 元素可能已卸载 */ } })
  }
  const control = rows ? (
    <Textarea
      ref={ref as any}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn('text-xs', mono && 'font-mono text-[11px]')}
    />
  ) : (
    <Input
      ref={ref as any}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-7 text-xs', mono && 'font-mono text-[11px]')}
    />
  )
  return (
    <div className="flex flex-col gap-1">
      {label && <div className="flex items-center justify-between"><span className="text-[10px] text-tertiary uppercase tracking-wider">{label}</span></div>}
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0">{control}</div>
        <VarPicker vars={vars} onPick={insert} />
      </div>
    </div>
  )
}

/** 变量下拉：插入 {{上游节点.字段}} 或 {{inputs.x}} */
function VarPicker({ vars, onPick }: { vars: Array<{ path: string; label: string }>; onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        title="插入变量（仅列上游可达）"
        onClick={() => setOpen((v) => !v)}
        className={cn('cut-xs h-7 w-7 flex items-center justify-center', open && 'hot')}
      >
        <span className="ci w-full h-full flex items-center justify-center">
          <Braces className="w-3.5 h-3.5 text-tertiary" />
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-[240px] max-h-[260px] overflow-y-auto cut-pop shadow-lg">
          <div className="ci py-1">
            {vars.length === 0 && <div className="px-2 py-1.5 text-[10px] text-tertiary">无上游变量（起点节点）</div>}
            {vars.map((v) => (
              <button
                key={v.path}
                type="button"
                onClick={() => { onPick(v.path); setOpen(false) }}
                className="w-full text-left px-2 py-1 text-[11px] text-secondary hover:bg-hover hover:text-primary truncate"
                title={v.path}
              >
                <span className="font-mono text-brand-500/85">{v.path}</span>
                <span className="ml-1.5 text-tertiary text-[10px]">{v.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[10px] text-tertiary uppercase tracking-wider">{label}</span>}
      {children}
      {hint && <span className="text-[10px] text-tertiary leading-tight">{hint}</span>}
    </div>
  )
}

function ListField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs" />
    </Field>
  )
}

/** 键值编辑器（tool.input / headers / end.outputs）：值用 VarField，可插变量 */
function KVEditor({ label, value, onChange, vars }: {
  label: string
  value: Record<string, any>
  onChange: (v: Record<string, any>) => void
  vars: Array<{ path: string; label: string }>
}) {
  const entries = Object.entries(value || {})
  const set = (i: number, k: string, v: string) => {
    const next: Record<string, any> = {}
    entries.forEach(([ek, ev], idx) => { next[idx === i ? k : ek] = idx === i ? v : ev })
    onChange(next)
  }
  const remove = (i: number) => {
    const next: Record<string, any> = {}
    entries.forEach(([ek, ev], idx) => { if (idx !== i) next[ek] = ev })
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">{label}</span>
        <Button size="xs" variant="ghost" onClick={() => onChange({ ...value, '': '' })}>
          <Plus className="w-3 h-3" />键
        </Button>
      </div>
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1">
          <Input value={k} onChange={(e) => set(i, e.target.value, String(v ?? ''))} className="h-7 text-xs w-[88px] shrink-0 font-mono" placeholder="key" />
          <div className="flex-1 min-w-0">
            <VarField label="" value={typeof v === 'string' ? v : JSON.stringify(v ?? '')} onChange={(nv) => set(i, k, nv)} vars={vars} />
          </div>
          <Button size="xs" variant="ghost" onClick={() => remove(i)} title="删除">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}
      {entries.length === 0 && <span className="text-[10px] text-tertiary">暂无键值</span>}
    </div>
  )
}

/** classify 的类别清单（routes[i] → 画布 handle route:i） */
function RoutesEditor({ routes, onChange }: { routes: any[]; onChange: (r: any[]) => void }) {
  const set = (i: number, patch: Record<string, any>) => onChange(routes.map((r, idx) => (idx === i ? { ...(r || {}), ...patch } : r)))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">routes（类别 → route:i 出边）</span>
        <Button size="xs" variant="ghost" onClick={() => onChange([...routes, { name: `类别${routes.length + 1}` }])}>
          <Plus className="w-3 h-3" />类别
        </Button>
      </div>
      {routes.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-tertiary w-[52px] shrink-0 truncate">route:{i}</span>
          <Input
            value={r?.name || r?.label || r?.category || ''}
            onChange={(e) => set(i, { name: e.target.value })}
            className="h-7 text-xs flex-1 min-w-0"
            placeholder="类别名"
          />
          <Button size="xs" variant="ghost" onClick={() => onChange(routes.filter((_, idx) => idx !== i))} title="删除">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}
      {routes.length === 0 && <span className="text-[10px] text-tertiary">无类别：至少加一类</span>}
    </div>
  )
}

/** if 的条件行编辑（全部满足走 true，否则 false） */
function ConditionsEditor({ conditions, onChange, vars }: { conditions: any[]; onChange: (c: any[]) => void; vars: Array<{ path: string; label: string }> }) {
  const set = (i: number, patch: Record<string, any>) => onChange(conditions.map((c, idx) => (idx === i ? { ...(c || {}), ...patch } : c)))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">conditions（全部满足 → true 出边）</span>
        <Button size="xs" variant="ghost" onClick={() => onChange([...conditions, { left: '', op: '==', right: '' }])}>
          <Plus className="w-3 h-3" />条件
        </Button>
      </div>
      {conditions.map((c, i) => (
        <div key={i} className="cut-xs">
          <div className="ci p-1.5 flex flex-col gap-1">
            <VarField label="" value={c?.left || ''} onChange={(v) => set(i, { left: v })} vars={vars} />
            <div className="flex items-center gap-1">
              <select
                value={c?.op || '=='}
                onChange={(e) => set(i, { op: e.target.value })}
                className="h-7 text-xs bg-input border rounded px-1 text-primary w-[104px] shrink-0"
              >
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              <div className="flex-1 min-w-0">
                <VarField label="" value={c?.right || ''} onChange={(v) => set(i, { right: v })} vars={vars} />
              </div>
              <Button size="xs" variant="ghost" onClick={() => onChange(conditions.filter((_, idx) => idx !== i))} title="删除">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>
      ))}
      {conditions.length === 0 && <span className="text-[10px] text-tertiary">无条件：始终走 true</span>}
    </div>
  )
}

/** loop/iterate 的 body 成员多选（子图；成员间连线仍写在 edges 上） */
function BodyPicker({ node, model, patchNode }: { node: NodeModel; model: WorkflowModel; patchNode: (p: Partial<NodeModel>) => void }) {
  const [open, setOpen] = useState(true)
  const body = node.body || []
  const others = model.nodes.filter((n) => n.id !== node.id && n.type !== 'start')
  const owner = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of model.nodes) if (n.body) for (const b of n.body) m.set(b, n.id)
    return m
  }, [model])
  const toggle = (id: string) => patchNode({ body: body.includes(id) ? body.filter((b) => b !== id) : [...body, id] })
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className="flex items-center gap-1 text-[10px] text-tertiary uppercase tracking-wider" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        body（子图成员 {body.length}）
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pl-1">
          {others.map((n) => {
            const occupiedBy = owner.get(n.id)
            const disabled = !!occupiedBy && occupiedBy !== node.id
            return (
              <label key={n.id} className={cn('flex items-center gap-1.5 text-[11px]', disabled ? 'text-tertiary opacity-60' : 'text-secondary')} title={disabled ? `已属于 ${occupiedBy} 的子图` : ''}>
                <input type="checkbox" disabled={disabled} checked={body.includes(n.id)} onChange={() => toggle(n.id)} />
                <span className="truncate">{n.label || n.id}</span>
                <span className="text-[9px] text-tertiary font-mono truncate">{n.id}</span>
              </label>
            )
          })}
          {others.length === 0 && <span className="text-[10px] text-tertiary">无其他节点可选</span>}
        </div>
      )}
    </div>
  )
}

// ===================== 工作流级设置 =====================

function WorkflowSettings({ model, onChange }: { model: WorkflowModel; onChange: (m: WorkflowModel) => void }) {
  const inputs = model.inputs || []
  const setInput = (i: number, patch: Record<string, any>) => onChange({ ...model, inputs: inputs.map((x, idx) => (idx === i ? { ...x, ...patch } : x)) })
  return (
    <>
      <Field label="名称（name）">
        <Input value={model.name} onChange={(e) => onChange({ ...model, name: e.target.value })} className="h-7 text-xs" />
      </Field>
      <Field label="描述">
        <Textarea value={model.description || ''} rows={2} onChange={(e) => onChange({ ...model, description: e.target.value })} className="text-xs" />
      </Field>
      <Field label="版本">
        <Input value={model.version || ''} onChange={(e) => onChange({ ...model, version: e.target.value })} className="h-7 text-xs" />
      </Field>
      <Field label="触发词（逗号分隔）" hint="命中触发词自动运行（trigger_config.auto_trigger）">
        <Input
          value={(model.triggers || []).join(', ')}
          onChange={(e) => onChange({ ...model, triggers: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          className="h-7 text-xs"
        />
      </Field>

      <div className="pt-1 border-t flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-tertiary uppercase tracking-wider">输入参数（{inputs.length}）</span>
          <Button size="xs" variant="ghost" onClick={() => onChange({ ...model, inputs: [...inputs, { name: `arg${inputs.length + 1}`, type: 'string' }] })}>
            <Plus className="w-3 h-3" />参数
          </Button>
        </div>
        {inputs.map((inp, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input value={inp.name} onChange={(e) => setInput(i, { name: e.target.value })} className="h-7 text-xs flex-1 min-w-0" placeholder="name" />
            <select
              value={inp.type || 'string'}
              onChange={(e) => setInput(i, { type: e.target.value })}
              className="h-7 text-xs bg-input border rounded px-1 text-primary w-[76px] shrink-0"
            >
              {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button
              type="button"
              title="必填"
              onClick={() => setInput(i, { required: !inp.required })}
              className={cn('text-[10px] px-1.5 h-7 rounded border shrink-0', inp.required ? 'text-brand-500 border-brand-500/40' : 'text-tertiary')}
            >必填</button>
            <Button size="xs" variant="ghost" onClick={() => onChange({ ...model, inputs: inputs.filter((_, idx) => idx !== i) })}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
        {inputs.length === 0 && <span className="text-[10px] text-tertiary">无输入参数</span>}
      </div>

      <div className="pt-1 border-t flex flex-col gap-1">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">暴露方式（expose）</span>
        <select
          value={model.expose?.mode || 'private'}
          onChange={(e) => onChange({ ...model, expose: { ...(model.expose || {}), mode: e.target.value } })}
          className="h-7 text-xs bg-input border rounded px-1.5 text-primary"
        >
          <option value="private">private（仅画布手动运行）</option>
          <option value="bound">bound（绑定指定 agent）</option>
          <option value="public">public（任意会话可调用）</option>
        </select>
        {model.expose?.mode === 'bound' && (
          <Field label="bind_agents（逗号分隔）">
            <Input
              value={(model.expose?.bind_agents || []).join(', ')}
              onChange={(e) => onChange({ ...model, expose: { ...(model.expose || {}), bind_agents: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
              className="h-7 text-xs"
            />
          </Field>
        )}
        <Field label="tool_name（模型可见的工具名，缺省 run_<id>）">
          <Input
            value={model.expose?.tool_name || ''}
            onChange={(e) => onChange({ ...model, expose: { ...(model.expose || {}), tool_name: e.target.value } })}
            className="h-7 text-xs"
          />
        </Field>
      </div>

      <div className="pt-1 border-t flex flex-col gap-1">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">并发与权限</span>
        <Field label="settings.max_parallel">
          <Input
            type="number" value={model.settings?.max_parallel ?? 4} className="h-7 text-xs"
            onChange={(e) => onChange({ ...model, settings: { ...(model.settings || {}), max_parallel: Math.max(1, Number(e.target.value) || 4) } })}
          />
        </Field>
        <Field label="permissions.tools（逗号分隔）" hint="运行授权清单的声明式预填；实际授权仍在运行前确认">
          <Input
            value={(model.permissions?.tools || []).join(', ')}
            onChange={(e) => onChange({ ...model, permissions: { ...(model.permissions || {}), tools: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
            className="h-7 text-xs"
          />
        </Field>
        <Field label="permissions.write_dirs（逗号分隔）">
          <Input
            value={(model.permissions?.write_dirs || []).join(', ')}
            onChange={(e) => onChange({ ...model, permissions: { ...(model.permissions || {}), write_dirs: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
            className="h-7 text-xs"
          />
        </Field>
        <label className="flex items-center justify-between text-[11px] text-secondary">
          允许网络（network）
          <Switch
            checked={model.permissions?.network === true}
            onCheckedChange={(v) => onChange({ ...model, permissions: { ...(model.permissions || {}), network: v } })}
          />
        </label>
      </div>

      {/* 出边 handle 速查（条件节点分色说明，与画布 handle 同源） */}
      <div className="pt-1 border-t">
        <div className="text-[10px] text-tertiary uppercase tracking-wider mb-1">出边 handle（条件节点）</div>
        <div className="flex flex-wrap gap-1">
          {['true', 'false', 'route:i', 'fail'].map((h) => <span key={h} className="text-[9px] px-1.5 py-0.5 rounded bg-elevated text-tertiary font-mono">{h}</span>)}
        </div>
      </div>
    </>
  )
}
