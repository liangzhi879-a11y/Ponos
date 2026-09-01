// src/components/dock/DockBar.tsx
// DockBar：dock 到屏幕右侧的功能导航条（独立窗口 ?module=dock）。
// 三区：品牌区（打开驾驶舱）/ 状态气泡区（点击弹出面板）/ 模块导航区（打开模块窗口）。
// 锁定：locked=true → 常驻展开（不随 hover 收起）；false → hover 展开/离开收起。
// 图标统一 lucide（moduleIcons 映射）。
import { useEffect, useState } from 'react'
import { Radar } from 'lucide-react'
import { useDockStore, type DockChannel, type DockPanelChannel } from '@/stores/dockStore'
import { listModules, openModule, subscribeBus } from '@/lib/moduleBridge'
import { CHANNEL_ICONS, moduleIcon, LOCK_ICONS } from '@/lib/moduleIcons'
import { DockPanel } from '@/components/dock/DockPanel'
import type { BusEvent } from '@/types'

/** 不显示在导航区的模块（dock 自身 / approval 由审批到达自动开） */
const HIDDEN_MODULES = new Set(['dock', 'approval'])

export function DockBar() {
  const { expanded, locked, counts, setExpanded, setLocked, bump, reset, panel, setPanel } = useDockStore()
  const [modules, setModules] = useState<Array<{ id: string; name: string }>>([])
  const [floating, setFloating] = useState(false)   // 悬浮模式（拖出后）

  // 加载模块清单（过滤 dock 自身 + approval）
  useEffect(() => {
    void listModules().then(list => setModules(list.filter(m => !HIDDEN_MODULES.has(m.id))))
  }, [])

  // 订阅 StateBus：task/question/approval 计数累加
  useEffect(() => {
    const offs = (['task', 'question', 'approval'] as const).map(ch =>
      subscribeBus(ch, (e: BusEvent) => {
        bump(ch)
        if (e.action === 'resolved' || e.action === 'status-done') reset(ch)
      })
    )
    // 监听 module 通道：dock 挂靠/悬浮状态（DockService 发布）
    const offModule = subscribeBus('module', (e: BusEvent) => {
      if (e.action === 'dock-floating') setFloating(true)
      else if (e.action === 'dock-docked') setFloating(false)
    })
    return () => { offs.forEach(off => off()); offModule() }
  }, [bump, reset])

  // 锁定联动主进程：locked=true → 停止自动隐藏（常驻展开）；false → 恢复
  useEffect(() => {
    window.ponosDock?.setAutoHide(!locked)
  }, [locked])

  const openModuleWindow = (id: string) => {
    void openModule(id)
    reset('module')
  }

  // 气泡点击：开/关对应面板
  const togglePanel = (ch: DockPanelChannel) => {
    setPanel(panel === ch ? null : ch)
    reset(ch)   // 打开面板即清除角标
  }

  // 悬浮 → 贴回右缘
  const redock = () => {
    void window.ponosDock?.redock()
    setFloating(false)
  }

  const LockIcon = LOCK_ICONS[locked ? 'locked' : 'unlocked']

  return (
    <div
      className="relative h-full flex flex-col items-center py-3 gap-3 border-r border-subtle bg-app text-primary drag-region"
      style={{ width: 64, transition: 'width .15s ease' }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => { if (!locked) setExpanded(false) }}
    >
      {/* 气泡面板：绝对定位于导航条右侧弹出 */}
      {panel && <DockPanel channel={panel} />}

      {/* 品牌区：打开驾驶舱模块窗口 */}
      <button
        onClick={() => { void openModule('cockpit') }}
        className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-brand-500 hover:bg-surface"
        title="打开驾驶舱"
      >
        <Radar size={20} />
      </button>

      <div className="flex-1" />

      {/* 状态气泡区：点击弹出面板 */}
      <div className="flex flex-col gap-2">
        {(Object.keys(counts).filter(ch => ch !== 'module') as DockPanelChannel[]).map(ch => {
          const Icon = CHANNEL_ICONS[ch]
          const active = panel === ch
          return (
            <button
              key={ch}
              onClick={() => togglePanel(ch)}
              className={`no-drag relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                active ? 'text-brand-500 bg-surface' : 'text-tertiary hover:bg-surface hover:text-secondary'
              }`}
              title={ch}
            >
              <Icon size={18} />
              {counts[ch] > 0 && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full text-[10px] leading-4 text-center bg-brand-500 text-white">
                  {counts[ch] > 99 ? '99+' : counts[ch]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex-1" />

      {/* 模块导航区 */}
      <div className="flex flex-col gap-1.5">
        {modules.map(m => {
          const Icon = moduleIcon(m.id)
          return (
            <button
              key={m.id}
              onClick={() => openModuleWindow(m.id)}
              className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-secondary hover:bg-surface hover:text-brand-500"
              title={m.name}
            >
              <Icon size={18} />
            </button>
          )
        })}
      </div>

      {/* 悬浮时显示"贴回右缘"按钮 */}
      {floating && (
        <button
          onClick={redock}
          className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-accent hover:bg-surface"
          title="贴回右缘（重新挂靠）"
        >
          <Radar size={16} className="rotate-90" />
        </button>
      )}

      {/* 锁定展开开关：锁定后常驻展开 */}
      <button
        onClick={() => setLocked(!locked)}
        className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
        title={locked ? '解锁（恢复 hover 展开）' : '锁定（常驻展开）'}
      >
        <LockIcon size={16} />
      </button>
    </div>
  )
}
