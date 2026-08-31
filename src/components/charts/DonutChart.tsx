/** K/M 格式化（从 TokenStatsPanel 复制；YAGNI 不抽公共 utils，两处小重复可接受）。 */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(0)}K`
  return `${(n / 1000000).toFixed(1)}M`
}

const DONUT_COLORS = ['var(--brand-500)', 'var(--accent-cyan)', 'rgb(var(--error-rgb))']

export function DonutChart({ segments, centerValue }: {
  segments: { label: string; value: number }[]
  centerValue: number
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  let acc = 0
  const arcs = segments.map((s, i) => {
    const len = total > 0 ? (s.value / total) * 100 : 0
    const start = acc; acc += len
    return { ...s, len, start, color: DONUT_COLORS[i % DONUT_COLORS.length] }
  })
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-32 h-32 shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <g transform="rotate(-90 50 50)">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-input)" strokeWidth="12" pathLength={100} />
            {arcs.map(a => (
              <circle key={a.label} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="12" pathLength={100}
                strokeDasharray={`${Math.max(0, a.len - 0.5)} ${100 - Math.max(0, a.len - 0.5)}`} strokeDashoffset={-a.start} />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-primary">{formatTokens(centerValue)}</span>
          <span className="text-[10px] text-tertiary">tokens</span>
        </div>
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {segments.length === 0 && <p className="text-xs text-tertiary">—</p>}
        {arcs.map(a => (
          <div key={a.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
            <span className="text-secondary truncate flex-1" title={a.label}>{a.label}</span>
            <span className="text-tertiary tabular-nums shrink-0">{total > 0 ? `${Math.round(a.len)}%` : '0%'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
