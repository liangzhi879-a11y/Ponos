import { useEffect, useState } from 'react'
import { LayoutDashboard, MessageSquare, Folder, Settings, Radar } from 'lucide-react'
import { useDockStore, type DockChannel } from '@/stores/dockStore'
import { useViewStore } from '@/stores/viewStore'
import { listModules, openModule, subscribeBus, type ParsedModuleUrl } from '@/lib/moduleBridge'
import type { BusEvent } from '@/types'

const CHANNEL_ICON: Record<DockChannel, string> = { task: '●', question: '?', approval: '!', module: '◈' }

/**
 * DockBar：dock 到屏幕右侧的功能导航条。
 * 三区：品牌区（打开驾驶舱）/ 状态气泡区（task/question/approval/module 计数）/
 * 模块导航区（hover 展开，点击打开模块窗口）。
 * 骨架版：气泡计数订阅 StateBus；审批/提问卡片宿主在阶段 B 补全。
 */
export function DockBar() {
  const { expanded, locked, counts, setExpanded, setLocked, bump, reset } = useDockStore()
  const goDock = useViewStore(s => s.goDock)
  const [modules, setModules] = useState<Array<{ id: string; name: string; icon: string }>>([])

  // 加载模块清单
  useEffect(() => {
    void listModules().then(list => setModules(list.filter(m => m.id !== 'dock')))
  }, [])

  // 订阅 StateBus：task/question/approval 计数累加
  useEffect(() => {
    const offs = (['task', 'question', 'approval'] as const).map(ch =>
      subscribeBus(ch, (e: BusEvent) => {
        bump(ch)
        // action=resolved 时清零
        if (e.action === 'resolved' || e.action === 'status-done') reset(ch)
      })
    )
    return () => offs.forEach(off => off())
  }, [bump, reset])

  const openModuleWindow = (id: string) => {
    void openModule(id)
    reset('module')
  }

  return (
    <div
      className="h-full flex flex-col items-center py-3 gap-3 border-r border-subtle bg-app text-primary"
      style={{ width: expanded || locked ? 64 : 48, transition: 'width .15s ease' }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => !locked && setExpanded(false)}
    >
      {/* 品牌区 */}
      <button
        onClick={() => { useViewStore.getState().goCockpit() }}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-brand-500 hover:bg-surface"
        title="打开驾驶舱"
      >
        <Radar size={20} />
      </button>

      <div className="flex-1" />

      {/* 状态气泡区 */}
      <div className="flex flex-col gap-2">
        {(Object.keys(counts) as DockChannel[]).map(ch => (
          <button
            key={ch}
            onClick={() => reset(ch)}
            className="relative w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
            title={ch}
          >
            <span className="text-sm">{CHANNEL_ICON[ch]}</span>
            {counts[ch] > 0 && (
              <span className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full text-[10px] leading-4 text-center bg-brand-500 text-white">
                {counts[ch] > 99 ? '99+' : counts[ch]}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* 模块导航区 */}
      <div className="flex flex-col gap-1.5">
        {modules.map(m => (
          <button
            key={m.id}
            onClick={() => openModuleWindow(m.id)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-secondary hover:bg-surface hover:text-brand-500"
            title={m.name}
          >
            <span className="text-sm">{m.name.slice(0, 1)}</span>
          </button>
        ))}
      </div>

      {/* 锁定展开开关 */}
      <button
        onClick={() => setLocked(!locked)}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
        title={locked ? '解锁展开' : '锁定展开'}
      >
        <span className="text-xs">{locked ? '🔒' : '🔓'}</span>
      </button>
    </div>
  )
}
