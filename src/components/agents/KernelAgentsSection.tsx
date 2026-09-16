// src/components/agents/KernelAgentsSection.tsx —— 「内核内置智能体」分区（2026-09-15，批次二 H）。
//
// ## 为什么单独一节（补 D 条款的覆盖缺口）
//
// 内核 `resolveAgents` 里有 5 个 agent 的内置定义**不在 GUI 自己的 agent 列表**中：
// `researcher` / `implementer` / `reviewer` / `explorer` / `planner`。此前它们在界面上完全不可见，
// 于是用户既不知道它们存在、也无法停用（内核的停用机制早已支持，缺的只是入口）。
//
// ## 三个刻意的设计选择
//
//   ① **列表来自内核**（`GET /agents` → `resolveAgents`）而非前端再抄一份名单：抄一份就是第二个
//      真相源，内核增删内置 agent 时界面不跟着变（本仓库刚修完的 `Agent.tools` 缺陷正是这类分叉）。
//   ② **停用后该行仍留在列表里**（只是标为"已停用"）：否则用户停掉后它就消失，**永远点不回来**——
//      开关成了单向操作。这也是路由刻意返回"完整目录 + disabled 标记"的原因。
//   ③ **只展示 GUI 列表里没有的项**：GUI 已有的 agent 有自己的卡片与开关（走 `agentStore`），
//      这里再列一遍会出现两个开关对应同一 agent（一个走 enabled、一个走注册表），界面自相矛盾。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import { fetchKernelAgents, selectKernelOnlyAgents, type KernelAgent } from '@/lib/agentsApi'
import { summarizeAgentTools, parseAgentTools } from '@/lib/agentTools'
import { useDisabledStore } from '@/stores/disabledStore'
import { useAgentStore } from '@/stores/agentStore'
import { cn } from '@/lib/utils'

export function KernelAgentsSection() {
  const { t } = useTranslation()
  const [list, setList] = useState<KernelAgent[]>([])
  const [loaded, setLoaded] = useState(false)
  // 本 store 已有的 id：用于剔除"已有自己卡片"的 agent（见文件头 ③）
  const localIds = useAgentStore(s => s.agents.map(a => a.id))
  const disabledAgents = useDisabledStore(s => s.agents)
  const setDisabledAgents = useDisabledStore(s => s.setDisabledAgents)

  useEffect(() => {
    let alive = true
    void (async () => {
      const all = await fetchKernelAgents()
      if (!alive) return
      setList(all)
      setLoaded(true)
    })()
    return () => { alive = false }
  }, [])

  const kernelOnly = selectKernelOnlyAgents(list, localIds)
  if (!loaded || kernelOnly.length === 0) return null

  return (
    <div className="contents">
      <div className="col-span-full pt-2 pb-1 text-[11px] font-semibold text-tertiary uppercase tracking-wider">
        {t('agents.kernelSection')}
      </div>
      {kernelOnly.map((a) => {
        // 停用态以**注册表**为准（disabledStore 是它的界面镜像），而不是本组件的本地 state ——
        // 这样别的入口（或用户在别处）改动后，这里显示的状态不会过期。
        const off = disabledAgents.includes(a.id)
        return (
          <div
            key={a.id}
            className={cn(
              'rounded-lg border bg-panel p-3 transition-colors',
              off ? 'border-subtle opacity-60' : 'border-subtle hover:border-accent/40',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h4 className="text-xs font-semibold text-primary truncate">{a.name}</h4>
                  <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-input text-tertiary">
                    {t('agents.kernelBadge')}
                  </span>
                  {off && (
                    <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-warning/15 text-warning">
                      {t('agents.disabledBadge')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-tertiary line-clamp-3">{a.description}</p>
                <p className="mt-1 text-[10px] text-tertiary truncate" title={a.tools}>
                  {t('agents.toolsLabel')}：{summarizeAgentTools(parseAgentTools(a.tools))}
                </p>
              </div>
              {/* 开关：直接写停用注册表（这一节没有 agentStore 侧的 enabled 字段） */}
              <button
                type="button"
                role="switch"
                aria-checked={!off}
                title={off ? t('agents.enableHint') : t('agents.disableHint')}
                onClick={() => {
                  const next = off
                    ? disabledAgents.filter(x => x !== a.id)
                    : [...new Set([...disabledAgents, a.id])]
                  void setDisabledAgents(next).then((err) => {
                    // 失败出声：静默失败会留下"界面显示已停用、内核照旧派发"的假状态。
                    if (err) alert(t('skills.toggleFailed', { error: err }))
                  })
                }}
                className={cn(
                  'relative shrink-0 w-8 h-[18px] rounded-full transition-colors',
                  off ? 'bg-input' : 'bg-brand-500',
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all',
                    off ? 'left-[2px]' : 'left-[16px]',
                  )}
                />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
