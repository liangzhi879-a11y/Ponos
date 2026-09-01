// src/components/dock/DockBar.tsx
// DockBar：dock 到屏幕右侧的功能导航条（独立窗口 ?module=dock）。
// 三区：品牌区（打开驾驶舱）/ 状态气泡区（点击弹出面板）/ 模块导航区（打开模块窗口）。
// 锁定：locked=true → 常驻展开（不随 hover 收起）；false → hover 展开/离开收起。
// 图标统一 lucide（moduleIcons 映射）。
import { useEffect, useState } from 'react'
import { Radar, X } from 'lucide-react'
import { useDockStore, type DockPanelChannel } from '@/stores/dockStore'
import { listModules, openModule, closeModule, subscribeBus } from '@/lib/moduleBridge'
import { CHANNEL_ICONS, moduleIcon, LOCK_ICONS } from '@/lib/moduleIcons'
import type { BusEvent } from '@/types'

/** 不显示在导航区的模块（dock 自身 / approval 由审批到达自动开 / panel 由气泡打开） */
const HIDDEN_MODULES = new Set(['dock', 'approval', 'panel'])

export function DockBar() {
  const { locked, counts, setLocked, bump, reset, panel, setPanel } = useDockStore()
  const [modules, setModules] = useState<Array<{ id: string; name: string }>>([])
  const [floating, setFloating] = useState(false)   // 悬浮模式（拖出后）

  // 加载模块清单（过滤 dock 自身 + approval + panel）
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

  // 气泡点击：打开/关闭对应通道的独立面板窗口
  // （dock 64px 宽放不下面板，独立窗口避免 absolute 裁剪不可见）
  const togglePanel = (ch: DockPanelChannel) => {
    reset(ch)   // 打开面板即清除角标
    if (panel === ch) {
      // 已打开 → 关闭
      void closeModule('panel')
      setPanel(null)
    } else {
      // 未打开 → 先关旧的再开新的
      if (panel) void closeModule('panel')
      void openModule('panel', { channel: ch })
      setPanel(ch)
    }
  }

  const LockIcon = LOCK_ICONS[locked ? 'locked' : 'unlocked']

  return (
    <div
      className="relative h-full flex flex-col items-center py-3 gap-3 border-r border-subtle bg-app text-primary drag-region"
      style={{ width: 64, transition: 'width .15s ease' }}
      onMouseEnter={() => useDockStore.getState().setExpanded(true)}
      onMouseLeave={() => { if (!locked) useDockStore.getState().setExpanded(false) }}
    >
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

      {/* 悬浮提示：拖到屏幕右缘自动吸附回贴 */}
      {floating && (
        <div className="no-drag text-[9px] text-tertiary text-center leading-tight w-12" title="拖到屏幕右缘自动吸附">
          拖到右缘<br />自动吸附
        </div>
      )}

      {/* 锁定展开开关：锁定后常驻展开 */}
      <button
        onClick={() => setLocked(!locked)}
        className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-surface"
        title={locked ? '解锁（恢复 hover 展开）' : '锁定（常驻展开）'}
      >
        <LockIcon size={16} />
      </button>

      {/* 关闭：dock 独立窗口只有关闭按钮（关闭后主窗口恢复显示） */}
      <button
        onClick={() => window.ponosWindow?.close()}
        className="no-drag w-9 h-9 rounded-lg flex items-center justify-center text-tertiary hover:bg-error hover:text-inverse"
        title="关闭导航栏"
      >
        <X size={16} />
      </button>
    </div>
  )
}
