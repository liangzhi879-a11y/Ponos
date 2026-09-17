// src/components/workflows/WorkflowDeleteDialog.tsx —— 删除工作流确认（应用内对话框）
//
// 为什么不再用 window.confirm（2026-09-17 排查「删了还在」时实测）：
//   原入口是 `if (window.confirm(...)) onDelete(id)`（WorkflowList 卡片垃圾桶）。
//   原生模态一旦未被应答（显示在窗口之后 / 被忽略 / 误按 Esc），confirm 直接返回 false ——
//   **既不删、也不提示**。用户侧观测到的就是"点了删除没反应""删了重启还在"；而事后取证
//   （磁盘父目录 mtime 未变、桥侧零请求日志、全部会话记录无删除动作）证明那次点击的
//   DELETE **从未发出**。原生模态的失败模式是静默的，代码路径上也留不下任何痕迹。
//   换成应用内 Dialog 后有三点硬保证：
//     ① 未应答 = 对话框仍开着（"没做完"是可见状态），不会静默丢掉用户意图；
//     ② 提交失败**就地显示原因且不关闭**（沿用 AuthzDialog 2026-09-12 的同一条教训：
//        把失败丢到被遮罩挡住的面板顶部 notice，用户看不到就会反复点击）；
//     ③ busy 期间禁用按钮 —— 删除是异步的，防重复提交（避免一次点出两次删除）。
//
// 影响面先说清（破坏性操作不留遗憾）：删除不只删本体，还会连带清掉版本历史、
// 该工作流的授权信任凭据、以及各 Agent 对它的绑定（后两者由 server 端 deleteWorkflow
// 同步清理）。这些连带项在 UI 上原本完全不可见，用户无从预判"删了会不会影响某个 Agent"。
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui'
import { getBindings, runStatusOf, type WorkflowMeta } from '@/lib/workflowApi'

export interface WorkflowDeleteDialogProps {
  meta: WorkflowMeta
  onCancel: () => void
  /** 确认删除。返回 { ok:false, error } 表示**删除未成功**：对话框保持打开并就地显示原因。 */
  onConfirm: () => void | Promise<{ ok: boolean; error?: string } | void>
}

export function WorkflowDeleteDialog({ meta, onCancel, onConfirm }: WorkflowDeleteDialogProps) {
  const id = meta.id
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 绑定该工作流的 Agent 名（读不到就留空——影响面属"锦上添花"，不得阻塞删除） */
  const [boundAgents, setBoundAgents] = useState<string[]>([])
  const [trusted, setTrusted] = useState(false)
  const [bindErr, setBindErr] = useState('')

  useEffect(() => {
    let alive = true
    void getBindings().then((r) => {
      if (!alive) return
      if (!r.ok) { setBindErr(r.error); return }
      setBoundAgents(Object.entries(r.agents || {}).filter(([, ids]) => (ids || []).includes(id)).map(([name]) => name))
      setTrusted((r.trusted || []).includes(id))
    })
    return () => { alive = false }
  }, [id])

  const status = runStatusOf(meta)
  const running = status === 'running'

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    const res = await onConfirm()
    if (res && res.ok === false) {
      setErr(res.error || '删除失败')
      setBusy(false) // 失败 → 对话框留着，用户可重试或改去导出备份（成功时父组件已卸载本组件）
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onCancel() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-error" />删除工作流
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="text-[11px] text-secondary">
            确认删除「<span className="text-primary font-medium">{meta.name || id}</span>」？
            此操作不可撤销，<span className="text-error">不会进回收站</span>。
          </div>
          <div className="text-[10px] text-tertiary font-mono mt-0.5">{id}</div>

          {running && (
            <div className="mt-3 flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>该工作流正在运行中。删除本体不会中止已启动的运行，但运行记录将不再可查。</span>
            </div>
          )}

          {/* 连带删除项：这些原本在界面上完全不可见 */}
          <div className="mt-3 flex flex-col gap-1">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">将一并删除</div>
            <Item>本体与版本历史（{meta.nodeCount ?? 0} 节点 / {meta.edgeCount ?? 0} 边 的当前配置及历史快照）</Item>
            {trusted && <Item>信任凭据 —— 该工作流在信任清单中，删除后其授权一并清除</Item>}
            {boundAgents.length > 0 && (
              <Item>
                以下 {boundAgents.length} 个 Agent 的绑定将解除：<span className="font-mono">{boundAgents.join('、')}</span>
              </Item>
            )}
            {bindErr && <div className="text-[10px] text-tertiary">（未能读取绑定清单：{bindErr}）</div>}
          </div>

          <div className="mt-3 text-[10px] text-tertiary leading-relaxed">
            如需保留，请先「取消」并点卡片上的导出按钮存一份 .yfwflow 包（可再导入恢复）。
          </div>
        </DialogBody>
        <DialogFooter>
          {err && <span className="text-[11px] text-error mr-auto truncate" title={err}>删除失败：{err}</span>}
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button size="sm" variant="danger" onClick={() => void confirm()} disabled={busy}>
            <Trash2 className="w-3.5 h-3.5" />{busy ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Item({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-secondary">
      <span className="text-error mt-px shrink-0">·</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}
