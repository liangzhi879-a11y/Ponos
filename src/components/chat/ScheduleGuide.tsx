import { useState } from 'react'
import { Repeat, CalendarClock, X, ListChecks, Trash2, Send } from 'lucide-react'
import { Button } from '@/components/ui'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { cn } from '@/lib/utils'

interface Props {
  conversationId: string
  /** loop: 循环执行（/loop 指令）；oneshot: 一次性定时（CronCreate 指令） */
  mode: 'loop' | 'oneshot'
  onClose: () => void
}

/** 循环间隔快捷选项 → /loop 的间隔后缀 */
const LOOP_INTERVALS = [
  { label: '5分钟', value: '5m' },
  { label: '10分钟', value: '10m' },
  { label: '30分钟', value: '30m' },
  { label: '1小时', value: '1h' },
  { label: '2小时', value: '2h' },
  { label: '1天', value: '1d' },
]

/** 一次性触发的快捷时间（自然语言，交给内核 CronCreate 解析） */
const ONESHOT_QUICK = ['10分钟后', '1小时后', '今天18:00', '明天9:00']

export function ScheduleGuide({ conversationId, mode, onClose }: Props) {
  const { send } = useYFWCLI()
  const [task, setTask] = useState('')
  const [interval, setInterval] = useState('5m')
  const [customInterval, setCustomInterval] = useState('')
  const [customIntervalActive, setCustomIntervalActive] = useState(false)
  const [when, setWhen] = useState('10分钟后')
  const [customWhen, setCustomWhen] = useState('')
  const [customWhenActive, setCustomWhenActive] = useState(false)

  const isLoop = mode === 'loop'

  const submit = () => {
    const t = task.trim()
    if (!t) return
    if (isLoop) {
      const iv = customIntervalActive ? customInterval.trim() : interval
      if (!iv) return
      // /loop 语法：/loop <间隔> <任务>（间隔 Ns/Nm/Nh/Nd，默认 10m）
      send(conversationId, `/loop ${iv} ${t}`)
    } else {
      const w = customWhenActive ? customWhen.trim() : when
      if (!w) return
      send(
        conversationId,
        `请使用 CronCreate 工具安排一个一次性定时任务（recurring: false）：
- 触发时间：${w}
- 要执行的任务：${t}

任务需要持久化（durable: true），应用重启后依然生效。安排好后告诉我任务 ID 和触发时间。`
      )
    }
    onClose()
  }

  const listTasks = () => {
    send(
      conversationId,
      '请使用 CronList 工具列出当前所有定时任务（循环和一次性），用易读的方式告诉我：任务内容、触发频率或触发时间、创建时间。'
    )
    onClose()
  }

  const stopAllLoops = () => {
    send(
      conversationId,
      '请使用 CronList 工具列出所有循环任务，然后使用 CronDelete 工具删除全部循环任务（保留一次性任务），并汇报删除结果。'
    )
    onClose()
  }

  const intervalUsed = customIntervalActive ? customInterval.trim() : interval
  const whenUsed = customWhenActive ? customWhen.trim() : when

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-popover border border rounded-xl shadow-2xl animate-slide-up z-40 overflow-hidden"
      style={{ maxHeight: '420px', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-subtle bg-elevated">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          {isLoop ? (
            <>
              <Repeat className="w-3.5 h-3.5 text-brand-500" />
              循环任务
            </>
          ) : (
            <>
              <CalendarClock className="w-3.5 h-3.5 text-brand-500" />
              定时任务
            </>
          )}
        </span>
        <button onClick={onClose} className="text-tertiary hover:text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="overflow-y-auto px-3 py-2.5 space-y-2.5" style={{ maxHeight: '330px' }}>
        {/* Mode hint */}
        <p className="text-[10px] text-tertiary leading-relaxed">
          {isLoop
            ? '循环任务：按固定间隔反复执行。到时间后内核会自动唤醒执行，无需一直开着窗口。'
            : '定时任务：在指定时间执行一次。到时间后内核会自动唤醒执行，无需一直开着窗口。'}
        </p>

        {/* Task description */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">要做什么</label>
          <textarea
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder={isLoop ? '例如：检查部署状态 / 同步最新代码 / 汇报进度' : '例如：整理今天的会议纪要 / 备份项目文件'}
            rows={2}
            className="w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
          />
        </div>

        {/* Interval / time */}
        {isLoop ? (
          <div>
            <label className="text-[10px] font-medium text-secondary mb-1 block">每隔多久执行一次</label>
            <div className="flex flex-wrap gap-1.5">
              {LOOP_INTERVALS.map(iv => (
                <button
                  key={iv.value}
                  onClick={() => { setInterval(iv.value); setCustomIntervalActive(false) }}
                  className={cn(
                    'px-2 py-1 rounded-md text-[10px] border transition-colors',
                    !customIntervalActive && interval === iv.value
                      ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 font-medium'
                      : 'bg-surface/60 border border-subtle text-secondary hover:bg-elevated'
                  )}
                >
                  {iv.label}
                </button>
              ))}
              <button
                onClick={() => { setCustomIntervalActive(true) }}
                className={cn(
                  'px-2 py-1 rounded-md text-[10px] border transition-colors',
                  customIntervalActive
                    ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 font-medium'
                    : 'bg-surface/60 border border-subtle text-secondary hover:bg-elevated'
                )}
              >
                自定义
              </button>
            </div>
            {customIntervalActive && (
              <input
                value={customInterval}
                onChange={e => setCustomInterval(e.target.value)}
                placeholder="如 45m（分钟）/ 3h（小时）/ 2d（天），最小 1m"
                className="mt-1.5 w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
              />
            )}
          </div>
        ) : (
          <div>
            <label className="text-[10px] font-medium text-secondary mb-1 block">什么时候执行</label>
            <div className="flex flex-wrap gap-1.5">
              {ONESHOT_QUICK.map(w => (
                <button
                  key={w}
                  onClick={() => { setWhen(w); setCustomWhenActive(false) }}
                  className={cn(
                    'px-2 py-1 rounded-md text-[10px] border transition-colors',
                    !customWhenActive && when === w
                      ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 font-medium'
                      : 'bg-surface/60 border border-subtle text-secondary hover:bg-elevated'
                  )}
                >
                  {w}
                </button>
              ))}
              <button
                onClick={() => { setCustomWhenActive(true) }}
                className={cn(
                  'px-2 py-1 rounded-md text-[10px] border transition-colors',
                  customWhenActive
                    ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 font-medium'
                    : 'bg-surface/60 border border-subtle text-secondary hover:bg-elevated'
                )}
              >
                自定义
              </button>
            </div>
            {customWhenActive && (
              <input
                value={customWhen}
                onChange={e => setCustomWhen(e.target.value)}
                placeholder="如 今天下午3点 / 明天上午9点半 / 8月20日 14:00"
                className="mt-1.5 w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
              />
            )}
          </div>
        )}

        {/* Preview */}
        {(task.trim() || (isLoop ? intervalUsed : whenUsed)) && (
          <div className="bg-surface/60 border border-subtle rounded-lg px-2.5 py-1.5">
            <div className="text-[9px] text-tertiary mb-0.5">即将发送</div>
            <div className="text-[11px] text-secondary font-mono leading-snug break-all">
              {isLoop
                ? `/loop ${customIntervalActive && customInterval.trim() ? customInterval.trim() : interval} ${task.trim() || '…'}`
                : `在 ${customWhenActive && customWhen.trim() ? customWhen.trim() : when} 执行：${task.trim() || '…'}`}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button variant="primary" size="sm" onClick={submit} disabled={!task.trim()} className="flex-1">
            <Send className="w-3.5 h-3.5 mr-1" />
            {isLoop ? '开始循环' : '创建定时任务'}
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={listTasks} className="text-tertiary hover:text-secondary flex-1">
            <ListChecks className="w-3 h-3 mr-1" />
            查看我的任务
          </Button>
          {isLoop && (
            <Button variant="ghost" size="xs" onClick={stopAllLoops} className="text-tertiary hover:text-error flex-1">
              <Trash2 className="w-3 h-3 mr-1" />
              停止全部循环
            </Button>
          )}
        </div>
        {!isLoop && (
          <p className="text-[9px] text-tertiary/70 leading-relaxed">
            提示：任务会持久化保存，重启应用后仍会按时执行。可通过"查看我的任务"确认或取消。
          </p>
        )}
      </div>
    </div>
  )
}
