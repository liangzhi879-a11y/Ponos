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
  asTriggerList, describeDataFlow, nodeTypeLabel, reachableVars, retryOnError,
  type NodeModel, type WorkflowInput, type WorkflowModel,
} from '@/lib/workflowModel'

export interface ConfigPanelProps {
  model: WorkflowModel
  nodeId: string | null
  onChange: (next: WorkflowModel) => void
}

/** 比较符清单 = 内核 `kernel/workflow-dsl.mjs` 的 `OPS` 键（写别的会在 evalCondition 抛「未知比较符」） */
const OPS = ['is', 'is not', '=', '≠', '>', '<', '>=', '<=', 'contains', 'not contains', 'empty', 'not empty', 'start with', 'end with']

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

            <NodeForm node={node} vars={vars} model={model} onChange={onChange} patchConfig={patchConfig} patchNode={patchNode} />

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

function NodeForm({ node, vars, model, onChange, patchConfig, patchNode }: {
  node: NodeModel
  vars: Array<{ path: string; label: string }>
  model: WorkflowModel
  /** 工作流级字段（inputs 等）的写入口——start 节点直接编辑输入参数，见下 */
  onChange: (next: WorkflowModel) => void
  patchConfig: (p: Record<string, any>) => void
  patchNode: (p: Partial<NodeModel>) => void
}) {
  const cfg = node.config || {}
  switch (node.type) {
    case 'start':
      // 开始节点 = 工作流的**输入口**。此前这里只有一句说明、inputs 藏在「工作流设置」里，
      // 用户看不到"数据从哪进"（2026-09-12 UX 反馈）。现在就地编辑工作流级 inputs，
      // 并给出每个参数的引用写法与"谁在用它"的使用情况（describeDataFlow）。
      return <StartPanel model={model} onChange={onChange} />
    case 'inputs':
      return (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] text-tertiary leading-relaxed">
            输入参数在工作流级定义（与开始节点同源，两处编辑的是同一份数据）。
            本节点仅作画布标注，运行时不执行。
          </div>
          <InputsEditor model={model} onChange={onChange} />
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
      // 内核 execAgent：prompt（或 query）/system/tools[]/max_iters（不是 max_rounds）
      return (
        <>
          <VarField label="prompt" value={cfg.prompt || ''} onChange={(v) => patchConfig({ prompt: v })} vars={vars} rows={5} />
          <VarField label="system（可选）" value={cfg.system || ''} onChange={(v) => patchConfig({ system: v })} vars={vars} rows={3} />
          <ListField
            label="tools（可选工具名，逗号分隔）"
            value={Array.isArray(cfg.tools) ? cfg.tools.join(', ') : ''}
            onChange={(v) => patchConfig({ tools: v.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="Read, Write, Bash"
          />
          <Field label="max_iters" hint="ReAct 循环上限（内核 execAgent 键名）">
            <Input
              type="number" value={cfg.max_iters ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ max_iters: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'classify':
      // 内核 execClassify：读 node.input（或 query）/instruction/**node.classes**（字符串数组，缺失即 throw）
      return (
        <>
          <VarField label="input" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} rows={2} />
          <VarField label="instruction（分类指令，可选）" value={cfg.instruction || ''} onChange={(v) => patchConfig({ instruction: v })} vars={vars} rows={2} />
          <StringListEditor
            label="classes（类别名 → route:i 出边）"
            items={Array.isArray(cfg.classes) ? cfg.classes : []}
            onChange={(classes) => patchConfig({ classes })}
            vars={vars}
            addLabel="类别"
            placeholder="类别名"
            hint="下标 i 对应出边 handle route:i；未命中走 default"
          />
        </>
      )
    case 'extract':
      // 内核 execExtract：读 node.parameters[]（{name,type?,required?,description?}，缺失即 throw）
      return (
        <>
          <VarField label="input" value={cfg.input || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} rows={3} />
          <VarField label="instruction（提取指令，可选）" value={cfg.instruction || ''} onChange={(v) => patchConfig({ instruction: v })} vars={vars} rows={2} />
          <ParamsEditor
            items={Array.isArray(cfg.parameters) ? cfg.parameters : []}
            onChange={(parameters) => patchConfig({ parameters })}
          />
        </>
      )
    case 'code':
      return <VarField label="code（沙箱 JS）" value={cfg.code || ''} onChange={(v) => patchConfig({ code: v })} vars={vars} rows={8} mono />
    case 'template':
      return <VarField label="template" value={cfg.template || ''} onChange={(v) => patchConfig({ template: v })} vars={vars} rows={6} />
    case 'http':
      // 内核 execHttp：headers 走 **parseHeaderLines(多行文本)**（对象会被 String() 成 [object Object] → 全丢）；
      // body 只认 {type:'json',data:[{key,value}]} 或 {type:'raw',raw}
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
          <VarField
            label="headers（每行一条 Name: value）"
            value={typeof cfg.headers === 'string' ? cfg.headers : ''}
            onChange={(v) => patchConfig({ headers: v })}
            vars={vars}
            rows={3}
            mono
            placeholder={'Content-Type: application/json\nAuthorization: Bearer sk-...'}
          />
          <BodyEditor value={cfg.body} onChange={(body) => patchConfig({ body })} vars={vars} />
          <Field label="authorization.type">
            <select
              value={cfg.authorization?.type || 'none'}
              onChange={(e) => patchConfig({ authorization: { ...(cfg.authorization || {}), type: e.target.value } })}
              className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
            >
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api-key">api-key</option>
            </select>
          </Field>
          {cfg.authorization?.type && cfg.authorization.type !== 'none' && (
            <>
              <Field label="authorization.token">
                <VarField label="" value={cfg.authorization?.token || ''} onChange={(v) => patchConfig({ authorization: { ...(cfg.authorization || {}), token: v } })} vars={vars} />
              </Field>
              {cfg.authorization.type === 'api-key' && (
                <Field label="authorization.header（缺省 X-API-Key）">
                  <Input
                    value={cfg.authorization?.header || ''} className="h-7 text-xs"
                    onChange={(e) => patchConfig({ authorization: { ...(cfg.authorization || {}), header: e.target.value } })}
                  />
                </Field>
              )}
            </>
          )}
          <Field label="timeout_ms">
            <Input
              type="number" value={cfg.timeout_ms ?? ''} className="h-7 text-xs"
              onChange={(e) => patchConfig({ timeout_ms: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </>
      )
    case 'document':
      // 内核 execDocument：只读 **node.input || node.file**（缺失即 throw「缺少 input」）；
      // 先 Read，失败再 OCR —— 无 mode 开关
      return (
        <Field label="input（文件路径）" hint="内核先 Read；读不到再走 OCR（图片/扫描件）">
          <VarField label="" value={cfg.input || cfg.file || ''} onChange={(v) => patchConfig({ input: v })} vars={vars} />
        </Field>
      )
    case 'list':
      // 内核 execList：读 node.variable / filter_by{enabled,key,op,value} / order_by{enabled,key,order} / extract_by{enabled,serial}
      return (
        <>
          <VarField label="variable（数组引用）" value={cfg.variable || ''} onChange={(v) => patchConfig({ variable: v })} vars={vars} />
          <div className="pt-1 border-t flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[11px] text-secondary">
              filter_by.enabled
              <Switch checked={cfg.filter_by?.enabled === true} onCheckedChange={(v) => patchConfig({ filter_by: { ...(cfg.filter_by || {}), enabled: v } })} />
            </label>
            {cfg.filter_by?.enabled && (
              <>
                <Field label="filter_by.key">
                  <Input value={cfg.filter_by?.key || ''} onChange={(e) => patchConfig({ filter_by: { ...cfg.filter_by, key: e.target.value } })} className="h-7 text-xs" />
                </Field>
                <Field label="filter_by.op">
                  <select
                    value={cfg.filter_by?.op || 'is'}
                    onChange={(e) => patchConfig({ filter_by: { ...cfg.filter_by, op: e.target.value } })}
                    className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
                  >
                    {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                </Field>
                <Field label="filter_by.value">
                  <Input value={cfg.filter_by?.value ?? ''} onChange={(e) => patchConfig({ filter_by: { ...cfg.filter_by, value: e.target.value } })} className="h-7 text-xs" />
                </Field>
              </>
            )}
          </div>
          <div className="pt-1 border-t flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[11px] text-secondary">
              order_by.enabled
              <Switch checked={cfg.order_by?.enabled === true} onCheckedChange={(v) => patchConfig({ order_by: { ...(cfg.order_by || {}), enabled: v } })} />
            </label>
            {cfg.order_by?.enabled && (
              <>
                <Field label="order_by.key">
                  <Input value={cfg.order_by?.key || ''} onChange={(e) => patchConfig({ order_by: { ...cfg.order_by, key: e.target.value } })} className="h-7 text-xs" />
                </Field>
                <Field label="order_by.order">
                  <select
                    value={cfg.order_by?.order || 'asc'}
                    onChange={(e) => patchConfig({ order_by: { ...cfg.order_by, order: e.target.value } })}
                    className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
                  >
                    {['asc', 'desc'].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
              </>
            )}
          </div>
          <div className="pt-1 border-t flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[11px] text-secondary">
              extract_by.enabled
              <Switch checked={cfg.extract_by?.enabled === true} onCheckedChange={(v) => patchConfig({ extract_by: { ...(cfg.extract_by || {}), enabled: v } })} />
            </label>
            {cfg.extract_by?.enabled && (
              <Field label="extract_by.serial">
                <select
                  value={cfg.extract_by?.serial || 'first'}
                  onChange={(e) => patchConfig({ extract_by: { ...cfg.extract_by, serial: e.target.value } })}
                  className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
                >
                  {['first', 'last'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            )}
          </div>
        </>
      )
    case 'loop':
      // 内核 execLoop：count / while_conditions[]（轮前）/ break_conditions[]（轮后）/ continue_on_error
      return (
        <>
          <Field label="count（循环次数）">
            <Input
              type="number" value={cfg.count ?? 1} className="h-7 text-xs"
              onChange={(e) => patchConfig({ count: Number(e.target.value) || 1 })}
            />
          </Field>
          <label className="flex items-center justify-between text-[11px] text-secondary">
            continue_on_error（单轮失败继续）
            <Switch checked={cfg.continue_on_error === true} onCheckedChange={(v) => patchConfig({ continue_on_error: v })} />
          </label>
          <ConditionsEditor
            label="while_conditions（轮前检查，不满足即停）"
            conditions={Array.isArray(cfg.while_conditions) ? cfg.while_conditions : []}
            onChange={(while_conditions) => patchConfig({ while_conditions })}
            vars={vars}
          />
          <ConditionsEditor
            label="break_conditions（本轮执行后满足即 break）"
            conditions={Array.isArray(cfg.break_conditions) ? cfg.break_conditions : []}
            onChange={(break_conditions) => patchConfig({ break_conditions })}
            vars={vars}
          />
          <BodyPicker node={node} model={model} patchNode={patchNode} />
        </>
      )
    case 'iterate':
      // 内核 execIterate：iterable（或 input）为数组引用；is_parallel + parallel_nums 控制并发
      return (
        <>
          <VarField label="iterable（数组引用）" value={cfg.iterable || cfg.input || ''} onChange={(v) => patchConfig({ iterable: v })} vars={vars} />
          <label className="flex items-center justify-between text-[11px] text-secondary">
            is_parallel（并行迭代）
            <Switch checked={cfg.is_parallel === true} onCheckedChange={(v) => patchConfig({ is_parallel: v })} />
          </label>
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
      // 内核 execStore：theme + summary 必填（缺失即 throw），tag/full（或 content）可选
      return (
        <>
          <VarField label="theme（必填，记忆主题）" value={cfg.theme || cfg.topic || ''} onChange={(v) => patchConfig({ theme: v })} vars={vars} />
          <VarField label="summary（必填，摘要）" value={cfg.summary || ''} onChange={(v) => patchConfig({ summary: v })} vars={vars} rows={3} />
          <VarField label="tag（可选标签）" value={cfg.tag || ''} onChange={(v) => patchConfig({ tag: v })} vars={vars} />
          <VarField label="full（可选全文）" value={cfg.full || cfg.content || ''} onChange={(v) => patchConfig({ full: v })} vars={vars} rows={4} />
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
      // 内核 execIf / evalCondition：conditions 的键是 {var, op, value}（写 left/right 会被当空变量比较）
      return <ConditionsEditor conditions={Array.isArray(cfg.conditions) ? cfg.conditions : []} onChange={(conditions) => patchConfig({ conditions })} vars={vars} />
    case 'join':
      // 内核 execJoin：sources[]（选择器）+ mode（concat/array/first）+ separator
      return (
        <>
          <Field label="mode" hint="concat=拼接文本；array=收集数组；first=第一个非空">
            <select
              value={cfg.mode || 'concat'}
              onChange={(e) => patchConfig({ mode: e.target.value })}
              className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
            >
              {['concat', 'array', 'first'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <StringListEditor
            label="sources（上游输出选择器）"
            items={Array.isArray(cfg.sources) ? cfg.sources : []}
            onChange={(sources) => patchConfig({ sources })}
            vars={vars}
            addLabel="来源"
            placeholder="{{node.field}}"
          />
          {cfg.mode !== 'first' && cfg.mode !== 'array' && (
            <Field label="separator（concat 分隔符）">
              <Input value={cfg.separator ?? '\n'} onChange={(e) => patchConfig({ separator: e.target.value })} className="h-7 text-xs" />
            </Field>
          )}
        </>
      )
    case 'assign':
      // 内核 execAssign：items[] = [{variable, value, operation?}]（over-write/append/clear）
      return (
        <ItemsEditor
          items={Array.isArray(cfg.items) ? cfg.items : []}
          onChange={(items) => patchConfig({ items })}
          vars={vars}
        />
      )
    case 'aggregate':
      // 内核 execAggregate：variables[]（选择器数组）+ output_type（string/array）+ separator
      return (
        <>
          <StringListEditor
            label="variables（待聚合的输出选择器）"
            items={Array.isArray(cfg.variables) ? cfg.variables : []}
            onChange={(variables) => patchConfig({ variables })}
            vars={vars}
            addLabel="变量"
            placeholder="{{node.field}}"
          />
          <Field label="output_type">
            <select
              value={cfg.output_type || 'string'}
              onChange={(e) => patchConfig({ output_type: e.target.value })}
              className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
            >
              {['string', 'array'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          {cfg.output_type !== 'array' && (
            <Field label="separator（缺省换行）">
              <Input value={cfg.separator ?? '\n'} onChange={(e) => patchConfig({ separator: e.target.value })} className="h-7 text-xs" />
            </Field>
          )}
        </>
      )
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
      // 内核 end 分支（workflow-nodes.mjs dispatch）与 workflow-engine.synthesizeOutput 都
      // **for...of node.outputs** —— 必须是数组 [{name, variable?, selector}]，对象会直接抛 TypeError
      return <EndPanel model={model} node={node} vars={vars} patchConfig={patchConfig} />
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

/** 键值编辑器（tool.input / subworkflow.inputs）：值用 VarField，可插变量。
 *  注意：内核 http.headers 只认**多行文本**（parseHeaderLines），不在此列。 */
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

/** 行列表容器（统一标题/加号/空态，与内核字段名一起显示） */
function RowList({ label, hint, onAdd, addLabel, count, children }: {
  label: string
  hint?: string
  onAdd: () => void
  addLabel: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">{label}</span>
        <Button size="xs" variant="ghost" onClick={onAdd}>
          <Plus className="w-3 h-3" />{addLabel}
        </Button>
      </div>
      {hint && <span className="text-[10px] text-tertiary leading-tight">{hint}</span>}
      {children}
      {count === 0 && <span className="text-[10px] text-tertiary">暂无条目</span>}
    </div>
  )
}

/** 字符串列表（classify.classes / aggregate.variables / join.sources）：每行一个 VarField */
function StringListEditor({ label, hint, items, onChange, vars, addLabel, placeholder }: {
  label: string
  hint?: string
  items: any[]
  onChange: (v: string[]) => void
  vars: Array<{ path: string; label: string }>
  addLabel: string
  placeholder?: string
}) {
  const list = items.map((x) => (typeof x === 'string' ? x : ''))
  return (
    <RowList label={label} hint={hint} addLabel={addLabel} count={list.length} onAdd={() => onChange([...list, ''])}>
      {list.map((it, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <VarField label="" value={it} onChange={(v) => onChange(list.map((x, idx) => (idx === i ? v : x)))} vars={vars} placeholder={placeholder} />
          </div>
          <Button size="xs" variant="ghost" onClick={() => onChange(list.filter((_, idx) => idx !== i))} title="删除">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}
    </RowList>
  )
}

/** end.outputs 编辑：内核 for...of 数组，行形状 {name, variable?, selector}。
 *  marks（可选）：与行下标对齐的数据流标记（来源节点是否可达）——由 EndPanel 注入。 */
function OutputsEditor({ items, onChange, vars, marks }: {
  items: any[]
  onChange: (v: Array<Record<string, any>>) => void
  vars: Array<{ path: string; label: string }>
  marks?: Array<{ from: string | null; ok: boolean; warn?: string } | undefined>
}) {
  const rows = items.map((x) => (x && typeof x === 'object' ? x : {}))
  const set = (i: number, patch: Record<string, any>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  return (
    <RowList
      label="outputs（返回值数组）"
      hint="每行 = 一个具名返回值：输出名 + 取值来源。来源写 {{节点}}（该节点整个输出）或 {{节点.字段}}（输出为对象时取字段）"
      addLabel="返回值"
      count={rows.length}
      onAdd={() => onChange([...rows, { name: `out${rows.length + 1}`, selector: '' }])}
    >
      {rows.map((r, i) => {
        const mark = marks?.[i]
        return (
          <div key={i} className="cut-xs">
            <div className="ci p-1.5 flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  value={r.name || ''}
                  onChange={(e) => set(i, { name: e.target.value })}
                  className="h-7 text-xs flex-1 min-w-0 font-mono"
                  placeholder="name（输出键名）"
                />
                <Button size="xs" variant="ghost" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} title="删除">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
              <VarField label="selector（取值：{{节点}} 取整输出；{{节点.字段}} 取字段）" value={r.selector || r.value || ''} onChange={(v) => set(i, { selector: v })} vars={vars} />
              <Field label="variable（可选：另存到变量名）">
                <Input value={r.variable || ''} onChange={(e) => set(i, { variable: e.target.value })} className="h-7 text-xs font-mono" />
              </Field>
              {/* 数据流回读：这条输出"接到没有"——空 selector / 非上游引用都会被内核拒（VAR_UNREACHABLE） */}
              <div className="text-[10px] leading-tight">
                {!mark || !mark.from
                  ? <span className="text-warning/90">未接取值源（运行时会取到空值）</span>
                  : mark.ok
                    ? <span className="text-success/90">← {mark.from}（上游可达）</span>
                    : <span className="text-error">{mark.from} 不是本节点的上游，保存会被内核拒绝</span>}
              </div>
              {/* 写法陷阱（能过校验、运行期却取不到值）：{{节点.output}} —— 实测踩过，静默丢键 */}
              {mark?.warn && <div className="text-[10px] leading-tight text-warning/90">⚠ {mark.warn}</div>}
            </div>
          </div>
        )
      })}
    </RowList>
  )
}

// ===================== 开始 / 结束：输入输出的唯一编辑入口（2026-09-12 UX）=====================
//
// 反馈："开始及结束增加输入输出配置，明确数据流传输"。
// 此前：inputs 只在「工作流设置」里编辑、outputs 只在 end 的 config 里编辑，两处都没有
// "这条数据接到哪去了"的回读——用户定义完输入不知道有没有节点在用，定义完输出不知道
// 取值源能不能解析。现在两个端点各自成面板：就地编辑 + 引用写法 + 上图实际引用者清单。

/** 工作流级输入参数编辑（start 节点面板与「工作流设置」共用同一份 model.inputs） */
function InputsEditor({ model, onChange }: { model: WorkflowModel; onChange: (m: WorkflowModel) => void }) {
  const inputs = model.inputs || []
  const flow = useMemo(() => describeDataFlow(model), [model])
  const usedBy = new Map(flow.inputs.map((i) => [i.name, i.usedBy]))
  const setInput = (i: number, patch: Partial<WorkflowInput>) => onChange({ ...model, inputs: inputs.map((x, idx) => (idx === i ? { ...x, ...patch } : x)) })
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-tertiary uppercase tracking-wider">输入参数（{inputs.length}）</span>
        <Button size="xs" variant="ghost" onClick={() => onChange({ ...model, inputs: [...inputs, { name: `arg${inputs.length + 1}`, type: 'string' }] })}>
          <Plus className="w-3 h-3" />参数
        </Button>
      </div>
      {inputs.map((inp, i) => {
        const users = usedBy.get(String(inp.name || '')) || []
        return (
          <div key={i} className="cut-xs">
            <div className="ci p-1.5 flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input value={inp.name} onChange={(e) => setInput(i, { name: e.target.value })} className="h-7 text-xs flex-1 min-w-0 font-mono" placeholder="name" />
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
              <div className="flex items-center gap-1.5 text-[10px]">
                <code className="px-1 py-0.5 rounded bg-elevated text-secondary font-mono truncate">{`{{inputs.${inp.name || '…'}}}`}</code>
                {users.length
                  ? <span className="text-tertiary truncate" title={`被引用于：${users.join('、')}`}>← {users.join('、')}</span>
                  : <span className="text-warning/90">未被任何节点引用</span>}
              </div>
            </div>
          </div>
        )
      })}
      {inputs.length === 0 && <span className="text-[10px] text-tertiary">无输入参数（工作流将不接收外部入参）</span>}
    </div>
  )
}

/** 开始面板 = 输入口：输入参数 + 它们流向哪些节点 */
function StartPanel({ model, onChange }: { model: WorkflowModel; onChange: (m: WorkflowModel) => void }) {
  return (
    <>
      <div className="text-[11px] text-tertiary leading-relaxed">
        工作流入口 = <span className="text-secondary">数据入口</span>。这里声明的每个参数，
        运行时由用户在「运行前授权」卡里填写；节点里用 <span className="font-mono">{'{{inputs.名}}'}</span> 引用。
      </div>
      <InputsEditor model={model} onChange={onChange} />
    </>
  )
}

/** 结束面板 = 输出口：返回值定义 + 取值源可达性（本地先把内核 VAR_UNREACHABLE 挡住） */
function EndPanel({ model, node, vars, patchConfig }: {
  model: WorkflowModel
  node: NodeModel
  vars: Array<{ path: string; label: string }>
  patchConfig: (p: Record<string, any>) => void
}) {
  const flow = useMemo(() => describeDataFlow(model), [model])
  const outOf = useMemo(() => new Map(flow.outputs.map((o, i) => [i, o])), [flow])
  const rows = Array.isArray(node.config?.outputs) ? node.config!.outputs : []
  return (
    <>
      <div className="text-[11px] text-tertiary leading-relaxed">
        结束节点 = <span className="text-secondary">数据出口</span>。每个返回值都会被写进工作流的最终输出
        （模型调用工作流时读到的就是这个对象的键）。
      </div>
      <OutputsEditor
        items={rows}
        onChange={(outputs) => patchConfig({ outputs })}
        vars={vars}
        marks={rows.map((_, i) => outOf.get(i))}
      />
      {rows.length === 0 && (
        <div className="text-[10px] text-warning/90 leading-tight">
          未定义返回值：作为工具被调用时将回退到最后一个成功节点的输出（不稳定，建议显式声明）。
        </div>
      )}
    </>
  )
}

/** extract.parameters 编辑：内核读 {name, type?, required?, description?} 拼 schema 描述 */
function ParamsEditor({ items, onChange }: { items: any[]; onChange: (v: Array<Record<string, any>>) => void }) {
  const rows = items.map((x) => (x && typeof x === 'object' ? x : {}))
  const set = (i: number, patch: Record<string, any>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  return (
    <RowList
      label="parameters（提取字段）"
      hint="内核 execExtract 必填：每行一个字段名（type/description 进提示词）"
      addLabel="字段"
      count={rows.length}
      onAdd={() => onChange([...rows, { name: `field${rows.length + 1}`, type: 'string', required: true, description: '' }])}
    >
      {rows.map((r, i) => (
        <div key={i} className="cut-xs">
          <div className="ci p-1.5 flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Input
                value={r.name || ''}
                onChange={(e) => set(i, { name: e.target.value })}
                className="h-7 text-xs flex-1 min-w-0 font-mono"
                placeholder="name"
              />
              <select
                value={r.type || 'string'}
                onChange={(e) => set(i, { type: e.target.value })}
                className="h-7 text-xs bg-input border rounded px-1 text-primary w-[86px] shrink-0"
              >
                {['string', 'number', 'boolean', 'array', 'object'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                type="button"
                title="required"
                onClick={() => set(i, { required: !r.required })}
                className={cn('text-[10px] px-1.5 h-7 rounded border shrink-0', r.required ? 'text-brand-500 border-brand-500/40' : 'text-tertiary')}
              >必填</button>
              <Button size="xs" variant="ghost" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} title="删除">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
            <Input
              value={r.description || ''}
              onChange={(e) => set(i, { description: e.target.value })}
              className="h-7 text-xs"
              placeholder="description（可选）"
            />
          </div>
        </div>
      ))}
    </RowList>
  )
}

/** assign.items 编辑：内核读 [{variable, value, operation}]（operation: over-write/append/clear） */
function ItemsEditor({ items, onChange, vars }: {
  items: any[]
  onChange: (v: Array<Record<string, any>>) => void
  vars: Array<{ path: string; label: string }>
}) {
  const rows = items.map((x) => (x && typeof x === 'object' ? x : {}))
  const set = (i: number, patch: Record<string, any>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  return (
    <RowList
      label="items（赋值项：写 {{var.名}} 读取）"
      hint="内核 execAssign 必填：variable 变量名 + value 取值 + operation"
      addLabel="赋值"
      count={rows.length}
      onAdd={() => onChange([...rows, { variable: '', value: '', operation: 'over-write' }])}
    >
      {rows.map((r, i) => (
        <div key={i} className="cut-xs">
          <div className="ci p-1.5 flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Input
                value={r.variable || r.name || ''}
                onChange={(e) => set(i, { variable: e.target.value })}
                className="h-7 text-xs flex-1 min-w-0 font-mono"
                placeholder="variable"
              />
              <select
                value={r.operation || 'over-write'}
                onChange={(e) => set(i, { operation: e.target.value })}
                className="h-7 text-xs bg-input border rounded px-1 text-primary w-[104px] shrink-0"
              >
                {['over-write', 'append', 'clear'].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <Button size="xs" variant="ghost" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} title="删除">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
            <VarField label="value（取值）" value={r.value || r.selector || ''} onChange={(v) => set(i, { value: v })} vars={vars} />
          </div>
        </div>
      ))}
    </RowList>
  )
}

/** http.body 编辑：内核只认 {type:'json',data:[{key,value}]} 或 {type:'raw',raw} */
function BodyEditor({ value, onChange, vars }: {
  value: any
  onChange: (v: Record<string, any>) => void
  vars: Array<{ path: string; label: string }>
}) {
  // 容错读取：旧版（错误形状）写过的字符串按 raw 展示，不静默丢内容
  const body = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : (typeof value === 'string' && value ? { type: 'raw', raw: value } : { type: 'json', data: [] })
  const type = body.type === 'raw' ? 'raw' : 'json'
  const data: any[] = Array.isArray(body.data) ? body.data : []
  return (
    <>
      <Field label="body.type">
        <select
          value={type}
          onChange={(e) => onChange(e.target.value === 'raw' ? { type: 'raw', raw: body.raw || '' } : { type: 'json', data })}
          className="w-full h-7 text-xs bg-input border rounded px-1.5 text-primary"
        >
          <option value="json">json（data 键值 → JSON 对象）</option>
          <option value="raw">raw（原始文本）</option>
        </select>
      </Field>
      {type === 'raw' ? (
        <VarField label="body.raw" value={body.raw || ''} onChange={(v) => onChange({ type: 'raw', raw: v })} vars={vars} rows={4} mono />
      ) : (
        <RowList
          label="body.data（键值）"
          addLabel="字段"
          count={data.length}
          onAdd={() => onChange({ type: 'json', data: [...data, { key: '', value: '' }] })}
        >
          {data.map((d, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={d?.key || ''}
                onChange={(e) => onChange({ type: 'json', data: data.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)) })}
                className="h-7 text-xs w-[88px] shrink-0 font-mono"
                placeholder="key"
              />
              <div className="flex-1 min-w-0">
                <VarField
                  label=""
                  value={d?.value ?? ''}
                  onChange={(nv) => onChange({ type: 'json', data: data.map((x, idx) => (idx === i ? { ...x, value: nv } : x)) })}
                  vars={vars}
                />
              </div>
              <Button size="xs" variant="ghost" onClick={() => onChange({ type: 'json', data: data.filter((_, idx) => idx !== i) })} title="删除">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </RowList>
      )}
    </>
  )
}

/** 条件行编辑（if.conditions / loop.while_conditions / loop.break_conditions）。
 *  行形状与内核 evalCondition 一致：**{var, op, value}**（写 left/right 会被当空变量比较）。 */
function ConditionsEditor({ label = 'conditions（全部满足 → true 出边）', conditions, onChange, vars }: {
  label?: string
  conditions: any[]
  onChange: (c: any[]) => void
  vars: Array<{ path: string; label: string }>
}) {
  const set = (i: number, patch: Record<string, any>) => onChange(conditions.map((c, idx) => (idx === i ? { ...(c || {}), ...patch } : c)))
  return (
    <RowList label={label} addLabel="条件" count={conditions.length} onAdd={() => onChange([...conditions, { var: '', op: 'is', value: '' }])}>
      {conditions.map((c, i) => (
        <div key={i} className="cut-xs">
          <div className="ci p-1.5 flex flex-col gap-1">
            <VarField label="var（取值）" value={c?.var || ''} onChange={(v) => set(i, { var: v })} vars={vars} />
            <div className="flex items-center gap-1">
              <select
                value={c?.op || 'is'}
                onChange={(e) => set(i, { op: e.target.value })}
                className="h-7 text-xs bg-input border rounded px-1 text-primary w-[110px] shrink-0"
              >
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              <div className="flex-1 min-w-0">
                <VarField label="" value={c?.value ?? ''} onChange={(v) => set(i, { value: v })} vars={vars} />
              </div>
              <Button size="xs" variant="ghost" onClick={() => onChange(conditions.filter((_, idx) => idx !== i))} title="删除">
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </RowList>
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
          value={asTriggerList(model.triggers).join(', ')}
          onChange={(e) => onChange({ ...model, triggers: asTriggerList(e.target.value) })}
          className="h-7 text-xs"
        />
      </Field>

      <div className="pt-1 border-t flex flex-col gap-1">
        {/* 输入参数与「开始节点」面板编辑的是同一份 model.inputs（单一真相，两处入口同源） */}
        <div className="text-[10px] text-tertiary leading-tight">输入参数（也可在画布上点「开始」节点就地编辑）</div>
        <InputsEditor model={model} onChange={onChange} />
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
