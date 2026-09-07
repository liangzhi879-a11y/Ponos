import { useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import type { QuestionPayload, QuestionAnswer } from '../../types'

interface QuestionCardProps {
  payload: QuestionPayload & { raw?: string }
  /** 只读展示（历史回放/解析失败兜底）：不渲染交互控件，仅展示问题内容 */
  readOnly?: boolean
  onAnswer?: (response: { answers: QuestionAnswer[]; notes: string }) => void
  onDismiss?: () => void
}

export default function QuestionCard({ payload, onAnswer, onDismiss, readOnly = false }: QuestionCardProps) {
  const { questions, context } = payload
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [notes, setNotes] = useState('')

  const toggleOption = (questionId: string, label: string, multi: boolean) => {
    setSelections(prev => {
      const current = prev[questionId] || []
      if (!multi) return { ...prev, [questionId]: current.includes(label) ? [] : [label] }
      return {
        ...prev,
        [questionId]: current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label],
      }
    })
  }

  // 零选项问题（模型载荷缺 options）不阻塞提交：这类卡片只能靠输入框直接回复，
  // 提交按钮退化为「确认并推进」——answers 为空时仍可带 notes 提交解除卡片。
  const allAnswered = questions.every(q => q.options.length === 0 || (selections[q.id] || []).length > 0)
  const submittedRef = useRef(false)

  const handleSubmit = () => {
    // 防重入：onAnswer 完成前连点只提交一次（组件随后被卸载，重复提交会向 CLI 注入多条答案）
    if (submittedRef.current) return
    submittedRef.current = true
    const answers: QuestionAnswer[] = questions
      .filter(q => (selections[q.id] || []).length > 0)
      .flatMap(q => (selections[q.id] || []).map(sel => {
        const isCustom = sel === 'Other'
        return {
          questionId: q.id,
          question: q.question,
          selected: sel,
          ...(isCustom && { customText: sel }),
        }
      }))
    for (const q of questions) {
      const sel = selections[q.id] || []
      const others = sel.filter(s => !q.options.some(o => o.label === s))
      if (others.length > 0) {
        answers.push(...others.map(s => ({
          questionId: q.id,
          question: q.question,
          selected: s,
          customText: s,
        })))
      }
    }
    onAnswer?.({ answers: answers.filter(a => !a.customText || a.customText !== a.selected || !questions.find(q => q.options.some(o => o.label === a.selected))), notes })
  }

  const handleOtherInput = (questionId: string, value: string) => {
    setSelections(prev => {
      const current = (prev[questionId] || []).filter(s => !s.startsWith('Other:'))
      if (value) current.push(`Other: ${value}`)
      return { ...prev, [questionId]: current }
    })
  }

  return (
    <div className="w-full max-w-[640px] my-4 bg-surface/60 border border-default rounded-lg overflow-hidden animate-slide-up">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-default/60 bg-elevated/30">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
          <span className="text-xs font-semibold text-primary tracking-wide">
            {readOnly ? '提问卡片' : '需要你的选择'}
          </span>
        </div>
        {!readOnly && (
          <button
            onClick={onDismiss}
            className="p-1 text-tertiary hover:text-secondary transition-colors rounded"
            title="跳过"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {context && (
        <div className="px-4 pt-3 pb-1">
          <p className="text-xs text-secondary leading-relaxed whitespace-pre-wrap break-all">{context}</p>
        </div>
      )}

      {questions.length === 0 && payload.raw && (
        <div className="px-4 pt-2">
          <p className="text-[10px] text-tertiary mb-1">此卡片未能自动解析，以下为原始内容：</p>
          <pre className="text-[11px] text-secondary bg-elevated rounded-md p-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-all">
            {payload.raw}
          </pre>
        </div>
      )}

      <div className="p-4 space-y-4">
        {questions.map((q) => {
          const sel = selections[q.id] || []
          const otherSelected = sel.some(s => s.startsWith('Other:'))
          const otherValue = otherSelected ? (sel.find(s => s.startsWith('Other:')) || '').replace('Other: ', '') : ''

          return (
            <div key={q.id} className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-500/80 bg-brand-500/10 px-1.5 py-0.5 rounded">
                  {q.header}
                </span>
                <span className="text-sm font-medium text-primary">{q.question}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const isSelected = sel.includes(opt.label)
                  if (readOnly) {
                    return (
                      <span
                        key={opt.label}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-elevated text-secondary border border-subtle"
                        title={opt.description}
                      >
                        {opt.label}
                        {opt.description && (
                          <span className="block text-[10px] font-normal text-tertiary/70 truncate max-w-[120px]">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    )
                  }
                  return (
                    <button
                      key={opt.label}
                      onClick={() => toggleOption(q.id, opt.label, q.multiSelect)}
                      className={`
                        group relative px-3 py-1.5 rounded-md text-xs font-medium
                        transition-all duration-150
                        ${isSelected
                          ? 'bg-brand-500/20 text-brand-600 border border-brand-500/40 shadow-sm'
                          : 'bg-elevated text-secondary border border-transparent hover:border-[var(--accent-red)]/50 hover:text-[var(--accent-red)] hover:bg-[var(--accent-red-soft)]'}
                      `}
                      title={opt.description}
                    >
                      {opt.label}
                      <span className="block text-[10px] font-normal text-tertiary/70 group-hover:text-tertiary transition-colors truncate max-w-[120px]">
                        {opt.description}
                      </span>
                    </button>
                  )
                })}
                {!readOnly && (
                  <button
                    onClick={() => {
                      if (otherSelected) {
                        setSelections(prev => ({
                          ...prev,
                          [q.id]: (prev[q.id] || []).filter(s => !s.startsWith('Other:')),
                        }))
                      } else {
                        setSelections(prev => ({
                          ...prev,
                          [q.id]: q.multiSelect
                            ? [...(prev[q.id] || []), 'Other: ']
                            : ['Other: '],
                        }))
                      }
                    }}
                    className={`
                      px-3 py-1.5 rounded-md text-xs font-medium
                      transition-all duration-150
                      ${otherSelected
                        ? 'bg-brand-500/20 text-brand-600 border border-brand-500/40 shadow-sm'
                        : 'bg-elevated text-secondary border border-transparent hover:border-default hover:text-primary'}
                    `}
                  >
                    Other
                  </button>
                )}
              </div>
              {q.options.length === 0 && !readOnly && (
                <p className="text-[11px] text-tertiary">此卡片没有可选选项，请直接在输入框回复。</p>
              )}
              {otherSelected && (
                <input
                  type="text"
                  placeholder="输入你的自定义选项..."
                  value={otherValue}
                  onChange={e => handleOtherInput(q.id, e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-md bg-elevated border border-default text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500/30 transition-colors"
                  autoFocus
                />
              )}
            </div>
          )
        })}

        {!readOnly && (
          <div>
            <textarea
              placeholder="补充说明（可选）..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-xs rounded-md bg-elevated border border-default text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500/30 resize-none transition-colors"
            />
          </div>
        )}
      </div>

      {readOnly ? (
        <div className="px-4 py-2.5 border-t border-default/60 bg-elevated/20 text-[10px] text-tertiary">
          历史提问卡片（只读展示）
        </div>
      ) : (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-default/60 bg-elevated/20">
          <span className="text-[10px] text-tertiary">
            {questions.length > 1 ? `${questions.length} 个问题` : ''}
            {questions.some(q => q.multiSelect) ? ' (多选)' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onDismiss}
              className="px-3 py-1.5 text-xs text-secondary hover:text-primary transition-colors"
            >
              跳过
            </button>
            <button
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Send className="w-3 h-3" />
              提交
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
