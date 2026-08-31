/** 输入/输出双色堆叠条（青=输入 / 粉=输出，百分比标注）。 */
export function BarStack({ input, output, className }: { input: number; output: number; className?: string }) {
  const total = input + output
  const inputPct = total > 0 ? (input / total) * 100 : 0
  const outputPct = total > 0 ? (output / total) * 100 : 0
  return (
    <div className={className}>
      <div className="flex h-3 w-full rounded-full bg-input/50 overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${inputPct}%`, background: 'var(--accent-cyan)' }} />
        <div className="h-full transition-all" style={{ width: `${outputPct}%`, background: 'var(--brand-500)' }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-tertiary tabular-nums">
        <span>输入 {Math.round(inputPct)}%</span>
        <span>输出 {Math.round(outputPct)}%</span>
      </div>
    </div>
  )
}
