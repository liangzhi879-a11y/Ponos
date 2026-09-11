// src/components/workflows/AuthzDialog.tsx —— 运行前授权卡（UI Task 14，spec §5）
//
// 语义（brief Step 1）：**一次放行**——逐项可勾除，勾除项在本次运行内 fail-closed
// （宿主 mergeCapabilities 后按清单放行，未命中即拒绝，**不挂起、不中断整轮**）。
// 审计不受影响：授权只免除交互打断，每次工具调用仍写哈希链。
//
// 行 → 后端字段的映射（只送宿主认得的 { tools, write_dirs, network }，不自创字段）：
//   读文件       → tools ∩ {Read, OCR}
//   写这些目录   → write_dirs[]（逐目录可勾除）
//   执行 Shell   → tools ∩ {Bash, BashOutput, KillShell}
//   访问网络     → network
//   调用这些工具 → tools 中其余具名工具（tool/agent 节点声明）
// 工作流未用到的行开关置灰（不是"放行"，而是"本次运行不涉及"）。
import { useEffect, useMemo, useState } from 'react'
import { Play, ShieldCheck } from 'lucide-react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Switch } from '@/components/ui'
import { cn } from '@/lib/utils'
import { getBindings, setWorkflowTrusted } from '@/lib/workflowApi'
import type { Capabilities, WorkflowInput } from '@/lib/workflowModel'

const READ_TOOLS = ['Read', 'OCR']
const SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell']

export interface AuthzDialogProps {
  /** 工作流 id（「信任此工作流」写绑定清单用） */
  id: string
  name?: string
  /** deriveCapabilities(model) 的推导结果——本组件只做勾除，不新增能力 */
  capabilities: Capabilities
  /** 工作流声明的输入参数（有才渲染该段；值由父组件持有） */
  inputs?: WorkflowInput[]
  values?: Record<string, string>
  onValuesChange?: (v: Record<string, string>) => void
  /** 确认 → 已勾除后的清单（宿主唯一认得的形状） */
  onConfirm: (capabilities: Capabilities) => void
  onCancel: () => void
}

export function AuthzDialog({ id, name, capabilities, inputs = [], values = {}, onValuesChange, onConfirm, onCancel }: AuthzDialogProps) {
  const all = useMemo(() => capabilities.tools || [], [capabilities])
  const [tools, setTools] = useState<string[]>(all)
  const [dirs, setDirs] = useState<string[]>(capabilities.write_dirs || [])
  const [network, setNetwork] = useState(!!capabilities.network)
  const [trust, setTrust] = useState(false)
  const [trustedNow, setTrustedNow] = useState(false)
  const [trustMsg, setTrustMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // 勾选框反映落盘真值（避免「看着没勾、其实已在信任清单」）
  useEffect(() => {
    let alive = true
    void getBindings().then((r) => {
      if (!alive) return
      if (!r.ok) { setTrustMsg(`读取信任清单失败：${r.error}`); return }
      const on = (r.trusted || []).includes(id)
      setTrustedNow(on)
      setTrust(on)
    })
    return () => { alive = false }
  }, [id])

  const usedOf = (group: readonly string[]) => all.some((t) => group.includes(t))
  const onOf = (group: readonly string[]) => {
    const inGroup = all.filter((t) => group.includes(t))
    return inGroup.length > 0 && inGroup.every((t) => tools.includes(t))
  }
  const toggleGroup = (group: readonly string[], on: boolean) => {
    setTools((prev) => on
      ? [...new Set([...prev, ...all.filter((t) => group.includes(t))])]
      : prev.filter((t) => !group.includes(t)))
  }

  const others = all.filter((t) => !READ_TOOLS.includes(t) && !SHELL_TOOLS.includes(t))

  /** 确认：先落信任开关（失败不成阻断——授权清单本身已可用），再交付清单 */
  const confirm = async () => {
    setBusy(true)
    if (trust !== trustedNow) {
      const r = await setWorkflowTrusted(id, trust)
      if (!r.ok) setTrustMsg(`信任清单写入失败：${r.error}`)
      else { setTrustedNow(trust); setTrustMsg(trust ? '已加入信任清单' : '已移出信任清单') }
    }
    setBusy(false)
    onConfirm({ tools, write_dirs: dirs, network })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>运行前授权：{name || id}</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="text-[11px] text-tertiary mb-3">
            勾除的项在本次运行内一律拒绝（fail-closed）——被拒调用直接返回错误，不挂起、不中断整轮；
            每次工具调用仍写审计哈希链，授权只免除交互打断。
          </div>

          {inputs.length > 0 && (
            <div className="mb-3 flex flex-col gap-2">
              <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">输入参数</div>
              {inputs.map((i) => (
                <div key={i.name} className="flex items-center gap-2">
                  <span className="text-[11px] text-secondary w-[120px] shrink-0 truncate font-mono">
                    {i.name}{i.required ? ' *' : ''}
                  </span>
                  <Input
                    value={values[i.name] ?? ''}
                    onChange={(e) => onValuesChange?.({ ...values, [i.name]: e.target.value })}
                    className="h-7 text-xs"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">能力清单（deriveCapabilities 推导，逐项可勾除）</div>

            <Row label="读文件" hint={usedOf(READ_TOOLS) ? READ_TOOLS.join(' / ') : '本工作流未用到'} disabled={!usedOf(READ_TOOLS)} checked={onOf(READ_TOOLS)} onChange={(v) => toggleGroup(READ_TOOLS, v)} />

            <div className="text-[11px] text-secondary">
              <div className="flex items-center justify-between">
                <span>写这些目录</span>
                <Switch
                  checked={dirs.length > 0}
                  disabled={(capabilities.write_dirs || []).length === 0}
                  onCheckedChange={(v) => setDirs(v ? [...(capabilities.write_dirs || [])] : [])}
                />
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {(capabilities.write_dirs || []).length === 0 && (
                  <span className="text-[10px] text-tertiary">无（写类工具将按工作目录相对路径判定）</span>
                )}
                {(capabilities.write_dirs || []).map((d) => {
                  const on = dirs.includes(d)
                  return (
                    <button
                      key={d}
                      onClick={() => setDirs(on ? dirs.filter((x) => x !== d) : [...dirs, d])}
                      title={on ? '点击勾除（本次运行内写入被拒）' : '点击恢复'}
                      className={cn('text-[10px] px-1.5 py-0.5 rounded border font-mono',
                        on ? 'text-brand-500 border-brand-500/30 bg-brand-500/10' : 'text-tertiary border line-through')}
                    >{d}{on ? ' ×' : ''}</button>
                  )
                })}
              </div>
            </div>

            <Row label="执行 Shell" hint={usedOf(SHELL_TOOLS) ? SHELL_TOOLS.join(' / ') : '本工作流未用到'} disabled={!usedOf(SHELL_TOOLS)} checked={onOf(SHELL_TOOLS)} onChange={(v) => toggleGroup(SHELL_TOOLS, v)} />

            <Row label="访问网络" hint={capabilities.network ? '含 http 节点' : '本工作流未用到'} disabled={!capabilities.network} checked={network} onChange={setNetwork} />

            <div className="text-[11px] text-secondary">
              <div className="flex items-center justify-between">
                <span>调用这些工具（{tools.length}）</span>
                <Switch
                  checked={others.length > 0 && others.every((t) => tools.includes(t))}
                  disabled={others.length === 0}
                  onCheckedChange={(v) => toggleGroup(others, v)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {others.length === 0 && <span className="text-[10px] text-tertiary">本工作流未声明具名工具</span>}
                {others.map((t) => {
                  const on = tools.includes(t)
                  return (
                    <button
                      key={t}
                      onClick={() => setTools(on ? tools.filter((x) => x !== t) : [...tools, t])}
                      title={on ? '点击勾除（本次运行内拒绝该工具）' : '点击恢复'}
                      className={cn('text-[10px] px-1.5 py-0.5 rounded border font-mono',
                        on ? 'text-brand-500 border-brand-500/30 bg-brand-500/10' : 'text-tertiary border line-through')}
                    >{t}{on ? ' ×' : ''}</button>
                  )
                })}
              </div>
            </div>

            <label className="flex items-center justify-between text-[11px] text-secondary mt-1 pt-2 border-t">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-brand-500" />
                信任此工作流（写入绑定清单，下次运行默认放行；审计照旧）
              </span>
              <Switch checked={trust} onCheckedChange={setTrust} />
            </label>
            {trustMsg && <span className="text-[10px] text-tertiary">{trustMsg}</span>}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
          <Button size="sm" onClick={() => void confirm()} disabled={busy}>
            <Play className="w-3.5 h-3.5" />按此清单运行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, hint, checked, disabled, onChange }: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between text-[11px] text-secondary">
      <span className="truncate">
        {label} <span className="text-[10px] text-tertiary font-mono">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
