/** 近 N 日趋势线图 — SVG polyline + 面积渐变（按最高值归一化，零依赖）。 */
export function TrendChart({ values, labels }: { values: number[]; labels: string[] }) {
  const W = 600; const H = 150
  const PAD_L = 6; const PAD_R = 6; const PAD_T = 12; const PAD_B = 22
  const n = values.length
  const max = Math.max(1, ...values)
  const innerW = W - PAD_L - PAD_R; const innerH = H - PAD_T - PAD_B
  const x = (i: number) => (n <= 1 ? PAD_L : PAD_L + (i / (n - 1)) * innerW)
  const y = (v: number) => PAD_T + (1 - v / max) * innerH
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const areaPath = n > 0
    ? `M ${x(0).toFixed(1)} ${y(values[0]).toFixed(1)} ` +
      values.map((v, i) => `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ') +
      ` L ${x(n - 1).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`
    : ''
  const labelIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="tsp-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--accent-cyan)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)' }} />
          </linearGradient>
          <linearGradient id="tsp-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.28 }} />
            <stop offset="100%" style={{ stopColor: 'var(--brand-500)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {n > 0 && (
          <>
            <path d={areaPath} fill="url(#tsp-fill)" />
            <polyline points={points} fill="none" stroke="url(#tsp-stroke)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
            {values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={1.8} fill="var(--accent-cyan)">
                <title>{`${labels[i] ?? ''} · ${v.toLocaleString()} tokens`}</title>
              </circle>
            ))}
          </>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-tertiary">
        {labelIdx.map(i => <span key={i}>{labels[i] ?? ''}</span>)}
      </div>
    </>
  )
}
