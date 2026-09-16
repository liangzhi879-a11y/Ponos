import { useState } from 'react'
import { Repeat, X, ListChecks, Trash2, Send } from 'lucide-react'
import { Button } from '@/components/ui'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { cn } from '@/lib/utils'
import { buildLoopCommand, validateLoopInput } from '@/lib/loopCommand'

interface Props {
  conversationId: string
  onClose: () => void
}

/** 循环次数快捷选项（'' = 不限；不限时须配间隔，否则内核按默认 3 轮） */
const LOOP_COUNTS = [
  { label: '3 次', value: '3' },
  { label: '5 次', value: '5' },
  { label: '10 次', value: '10' },
  { label: '不限', value: '' },
]

/** 循环间隔快捷选项 → /loop 的间隔后缀（'' = 连续执行，轮间不等） */
const LOOP_INTERVALS = [
  { label: '连续执行', value: '' },
  { label: '5分钟', value: '5m' },
  { label: '10分钟', value: '10m' },
  { label: '30分钟', value: '30m' },
  { label: '1小时', value: '1h' },
  { label: '2小时', value: '2h' },
  { label: '1天', value: '1d' },
]

export function ScheduleGuide({ conversationId, onClose }: Props) {
  const { send } = useYFWCLI()
  const [task, setTask] = useState('')
  // 次数为主（设计 §5.6）：默认 3 次，'' = 不限（持续）
  const [count, setCount] = useState('3')
  // 可选间隔：'' = 连续执行
  const [interval, setInterval] = useState('5m')
  const [customInterval, setCustomInterval] = useState('')
  const [customIntervalActive, setCustomIntervalActive] = useState(false)
  // 可选终止/验真条件
  const [until, setUntil] = useState('')
  const [done, setDone] = useState('')

  const intervalUsed = customIntervalActive ? customInterval.trim() : interval
  const countUsed = count.trim()

  /** 提交前校验（错误则禁用按钮并给出原因，不做静默兜底） */
  const loopError = validateLoopInput({ count, interval: intervalUsed, task })

  /** 组装 /loop 指令（次数为主 + 可选间隔 + 可选 --until/--done；逻辑与测试见 lib/loopCommand.ts） */
  const loopCommand = buildLoopCommand({ count, interval: intervalUsed, until, done, task })

  const submit = () => {
    const t = task.trim()
    if (!t) return
    if (loopError) return
    // 结构化 loop 语法（2026-09-14 loop 运行时）：次数位在前（`/loop 3 …`），间隔走
    // `--every`。内核虽也认 `/loop 10m <任务>`（等价 `--every 10m`），但那种写法
    // count 恒为 null（持续运行），无法表达"跑几轮"，故显式输出次数。
    send(conversationId, loopCommand)
    onClose()
  }

  /** 查看当前会话的循环状态（内核 /loop status，见 kernel/loop-commands.mjs:LOOP_OPS） */
  const listTasks = () => {
    send(conversationId, '/loop status')
    onClose()
  }

  /** 停止当前会话的循环（内核 /loop stop；每个会话只挂一个循环，故无需逐个删） */
  const stopAllLoops = () => {
    send(conversationId, '/loop stop')
    onClose()
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 cut-sm animate-slide-up z-40"
      style={{ filter: 'drop-shadow(var(--modal-drop))' }}
    >
      <div className="ci overflow-hidden flex flex-col" style={{ maxHeight: '420px', background: 'var(--popover-bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-subtle bg-elevated">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Repeat className="w-3.5 h-3.5 text-brand-500" />
          循环任务
        </span>
        <button onClick={onClose} className="text-tertiary hover:text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="overflow-y-auto px-3 py-2.5 space-y-2.5" style={{ maxHeight: '330px' }}>
        {/* Mode hint */}
        <p className="text-[10px] text-tertiary leading-relaxed">
          循环任务：先定循环次数（或选“不限”持续跑），可选执行间隔；由内核在会话内按轮次自动推进，无需保持前端窗口在前台。
        </p>

        {/* Task description */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">要做什么</label>
          <textarea
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder="例如：检查部署状态 / 同步最新代码 / 汇报进度"
            rows={2}
            className="w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
          />
        </div>

        {/* 循环次数（次数为主；不限 = ''，须配间隔） */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">循环次数</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {LOOP_COUNTS.map(c => (
              <button
                key={c.label}
                onClick={() => setCount(c.value)}
                className={cn(
                  'px-2 py-1 rounded-md text-[10px] border transition-colors',
                  countUsed === c.value
                    ? 'bg-brand-500/15 border-brand-500/40 text-brand-500 font-medium'
                    : 'bg-surface/60 border border-subtle text-secondary hover:bg-elevated'
                )}
              >
                {c.label}
              </button>
            ))}
            <input
              value={count}
              onChange={e => setCount(e.target.value)}
              placeholder="自定义"
              className="w-20 bg-surface/80 border border rounded-lg px-2 py-1 text-[10px] text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
            />
          </div>
          {!countUsed && (
            <p className="mt-1 text-[9px] text-tertiary/80 leading-relaxed">
              不限次数：将持续运行，靠达成条件 / 预算上限 / 手动停止收尾。
            </p>
          )}
        </div>

        {/* 执行间隔（可选：连续执行 = 不加 --every） */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">执行间隔（可选）</label>
          <div className="flex flex-wrap gap-1.5">
            {LOOP_INTERVALS.map(iv => (
              <button
                key={iv.label}
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
          {!intervalUsed && !customIntervalActive && (
            <p className="mt-1 text-[9px] text-tertiary/80 leading-relaxed">
              连续执行：每轮结束立即进入下一轮。
            </p>
          )}
        </div>

        {/* 达成条件（可选）→ --until：由内核按轮次判定是否达成 */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">达成条件（可选）</label>
          <input
            value={until}
            onChange={e => setUntil(e.target.value)}
            placeholder="如：全部测试通过 / 部署状态恢复正常"
            className="w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
          />
          <p className="mt-1 text-[9px] text-tertiary/80 leading-relaxed">
            满足即收尾（内核判定）。与下方验收命令同时填写时，验收命令优先。
          </p>
        </div>

        {/* 验收命令（可选）→ --done：命令式验真，退出码 0 为通过 */}
        <div>
          <label className="text-[10px] font-medium text-secondary mb-1 block">验收命令（可选，每行一条）</label>
          <textarea
            value={done}
            onChange={e => setDone(e.target.value)}
            placeholder={'如：\nnpm test\nnpm run build'}
            rows={2}
            className="w-full bg-surface/80 border border rounded-lg px-2.5 py-1.5 text-xs text-primary placeholder:text-tertiary resize-none font-mono focus:outline-none focus:ring-1 focus:ring-brand-500/25 focus:border-brand-500/40"
          />
          <p className="mt-1 text-[9px] text-tertiary/80 leading-relaxed">
            每轮结束执行一次，全部退出码为 0 才算达成（与内核同受审批与黑名单约束）。
          </p>
        </div>

        {/* Preview */}
        {(task.trim() || countUsed || intervalUsed) && (
          <div className="bg-surface/60 border border-subtle rounded-lg px-2.5 py-1.5">
            <div className="text-[9px] text-tertiary mb-0.5">即将发送</div>
            <div className="text-[11px] text-secondary font-mono leading-snug break-all">
              {loopCommand}
            </div>
          </div>
        )}

        {/* Validation */}
        {loopError && (
          <p className="text-[10px] text-error leading-relaxed">{loopError}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button variant="primary" size="sm" onClick={submit} disabled={!task.trim() || !!loopError} className="flex-1">
            <Send className="w-3.5 h-3.5 mr-1" />
            开始循环
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" onClick={listTasks} className="text-tertiary hover:text-secondary flex-1">
            <ListChecks className="w-3 h-3 mr-1" />
            查看循环状态
          </Button>
          <Button variant="ghost" size="xs" onClick={stopAllLoops} className="text-tertiary hover:text-error flex-1">
            <Trash2 className="w-3 h-3 mr-1" />
            停止循环
          </Button>
        </div>
      </div>
      </div>
    </div>
  )
}
