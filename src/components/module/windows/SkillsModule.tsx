// src/components/module/windows/SkillsModule.tsx
// 技能 · Agent 模块窗口（?module=skills）。
// 复用 Sidebar 中的 SkillsPanel / AgentsPanel，tab 切换。
import { useState } from 'react'
import { TooltipProvider } from '@/components/ui'
import { SkillsPanel } from '@/components/skills/SkillsPanel'
import { AgentsPanel } from '@/components/agents/AgentsPanel'

export function SkillsModule() {
  const [tab, setTab] = useState<'skills' | 'agents'>('skills')

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-app text-primary">
        {/* tab 切换条 */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-subtle shrink-0">
          <button
            onClick={() => setTab('skills')}
            className={`px-3 py-1 rounded-lg text-xs ${tab === 'skills' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
          >
            技能
          </button>
          <button
            onClick={() => setTab('agents')}
            className={`px-3 py-1 rounded-lg text-xs ${tab === 'agents' ? 'bg-surface text-brand-500' : 'text-tertiary hover:text-secondary'}`}
          >
            Agent
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === 'skills' ? <SkillsPanel /> : <AgentsPanel />}
        </div>
      </div>
    </TooltipProvider>
  )
}
