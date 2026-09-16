// src/components/agents/AgentToolsEditor.tsx —— Agent 卡片的「关联工具控制」（2026-09-15，P1 A 条款）。
//
// ## 为什么是"模式 + 勾选"而不是继续用文本框
//
// 原来只有一个自由文本框写 `Agent.tools`，用户既不知道有哪些工具，也不知道句式怎么算对；
// 而内核把自然语言句式按逗号切成伪工具名，最终让专业 agent 只剩下 Edit/Write（详见
// `@/lib/agentTools` 的文件头与 `kernel/agents.mjs` 的 parseToolsSpec）。本组件把该字段
// 变成**受控选择**：工具名来自内核真实工具目录，写回的字面量由 `formatAgentTools` 产出，
// 与内核解析同语义——"配得出"必然"跑得动"。
//
// ## 交互上的三个刻意选择
//
//   ① 三态而非"勾选集合"：`全部 / 全部（除…）/ 仅选中的`——因为三种意图在真实使用中完全不同
//      （全开、只读型白名单、黑名单），统一成"勾选集合"会让"新增工具默认可用否"变得含糊
//      （内核新增工具时，白名单用户会静默失去它，黑名单用户会静默得到它——前者是坑）。
//   ② 只读/可写徽标：把 `isReadOnlyTools` 的结果直接显示出来。用户真正关心的不是"勾了哪些"，
//      而是"这个 agent 会不会动我的文件"。
//   ③ 未知名字**出声**：老数据里的自由文本（内核不认识）必须展示为警告，而不是被静默丢弃——
//      否则用户会以为自己的配置还在（内核侧也确实会退回"不限制"，与界面显示不符）。
import { useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/useTranslation'
import type { Agent } from '@/lib/agents'
import {
  ALL_TOOL_NAMES, TOOL_CATALOG, TOOL_GROUPS, parseAgentTools, formatAgentTools,
  effectiveTools, isReadOnlyTools, type AgentToolsSpec, type AgentToolsMode,
} from '@/lib/agentTools'
import { cn } from '@/lib/utils'

type Props = {
  agent: Agent
  /** 保存回调：入参是**已格式化的字面量**（store 不碰解析细节） */
  onSave: (tools: string) => void
}

export function AgentToolsEditor({ agent, onSave }: Props) {
  const { t } = useTranslation()
  const parsed = useMemo(() => parseAgentTools(agent.tools), [agent.tools])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AgentToolsSpec>(parsed)

  const eff = useMemo(() => effectiveTools(parsed), [parsed])
  const dirty = formatAgentTools(draft) !== formatAgentTools(parsed)

  // 每次重新展开都以磁盘/内存中的当前值为基准（避免上次未保存的草稿"粘住"）。
  const openEditor = () => { setDraft(parsed); setOpen(true) }

  const setMode = (mode: AgentToolsMode) => setDraft((d) => ({
    mode,
    // 模式切换时保留已选名字：用户在"仅选中"与"全部（除）"之间来回比较是常见行为，
    // 清空会迫使其重选（而两种模式下"我圈的那批工具"是同一个心理对象）。
    names: d.names.length ? d.names : (mode === 'custom' ? ['Read', 'Glob', 'Grep'] : []),
  }))

  const toggleTool = (name: string) => setDraft((d) => ({
    ...d,
    names: d.names.includes(name) ? d.names.filter((x) => x !== name) : [...d.names, name],
  }))

  return (
    <div className="mt-2 border-t border-subtle pt-2">
      {/* 摘要行：卡片折叠时也要能看清"能用什么" */}
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openEditor())}
        className="w-full flex items-center gap-2 text-left group"
      >
        <span className="text-[10px] text-tertiary shrink-0">{t('agents.toolsLabel')}</span>
        <span className="text-[11px] text-secondary truncate flex-1" title={formatAgentTools(parsed)}>
          {t('agents.toolsSummary', { summary: summarizeLocal(t, parsed) })}
        </span>
        {isReadOnlyTools(parsed) && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-subtle text-tertiary">
            {t('agents.toolsReadOnly')}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-tertiary group-hover:text-primary">
          {open ? t('common.collapse') : t('common.edit')}
        </span>
      </button>

      {/* 未知名字：内核不认识 → 必须出声（内核会退回"不限制"，界面不能装作已生效） */}
      {eff.unknownNames.length > 0 && (
        <p className="mt-1 text-[10px] text-warning">
          {t('agents.toolsUnknown', { names: eff.unknownNames.join('、') })}
        </p>
      )}

      {open && (
        <div className="mt-2 rounded border border-subtle p-2 space-y-2">
          {/* 三态选择 */}
          <div className="flex items-center gap-1">
            {(['all', 'allExcept', 'custom'] as AgentToolsMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'px-2 h-[22px] rounded text-[11px] border transition-colors',
                  draft.mode === m ? 'bg-brand-500 text-white border-brand-500' : 'text-secondary border-subtle hover:text-primary',
                )}
              >
                {t(`agents.toolsMode.${m}`)}
              </button>
            ))}
          </div>

          {draft.mode !== 'all' && (
            <div className="max-h-56 overflow-auto space-y-2 pr-1">
              {TOOL_GROUPS.map((group) => (
                <div key={group}>
                  <p className="text-[10px] text-tertiary mb-0.5">{group}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {TOOL_CATALOG.filter((x) => x.group === group).map((tool) => (
                      <label key={tool.name} className="flex items-center gap-1 text-[11px] text-secondary cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-brand-500"
                          checked={draft.names.includes(tool.name)}
                          onChange={() => toggleTool(tool.name)}
                        />
                        <span title={tool.name}>{tool.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {draft.mode === 'custom' && draft.names.length === 0 && (
            <p className="text-[10px] text-warning">{t('agents.toolsEmptyWarn')}</p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] text-tertiary truncate">
              {t('agents.toolsEffective', { count: effectiveTools(draft).names.length, total: ALL_TOOL_NAMES.length })}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setDraft(parsed)}
                disabled={!dirty}
                className="px-2 h-[22px] rounded text-[11px] border border-subtle text-secondary disabled:opacity-40"
              >
                {t('common.reset')}
              </button>
              <button
                type="button"
                onClick={() => { onSave(formatAgentTools(draft)); setOpen(false) }}
                disabled={!dirty}
                className="px-2 h-[22px] rounded text-[11px] bg-brand-500 text-white disabled:opacity-40"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 摘要文案（走 i18n；`summarizeAgentTools` 是纯逻辑与语言无关，故组合在此）。 */
function summarizeLocal(t: (k: string, o?: Record<string, string | number>) => string, spec: AgentToolsSpec): string {
  const eff = effectiveTools(spec)
  if (spec.mode === 'all') return t('agents.toolsAll')
  if (spec.mode === 'allExcept') {
    return spec.names.length
      ? t('agents.toolsExcept', { names: spec.names.join('、') })
      : t('agents.toolsAll')
  }
  if (eff.unrestricted) return t('agents.toolsAllFallback')
  return eff.names.length <= 4
    ? eff.names.join('、')
    : t('agents.toolsSome', { names: eff.names.slice(0, 4).join('、'), count: eff.names.length })
}
