// src/components/apps/AppCoverage.tsx —— 控制命令覆盖率展示（P1「真正 agent 可智控」，2026-09-17）
//
// 为什么要有这一块：清单 P1 的验收写着「网站和应用应至少 70% 能匹配上全量控制命令」，
// 而这个数字此前**在界面上完全不可见** —— 用户没有任何办法知道"到底覆盖了多少、缺的是哪些"。
// 数字不落地的要求等于没有要求，所以把它显示出来。
//
// 数据来源：主进程 `app:coverage`（`electron/app-ipc.cjs`），因为全量命令目录与"可用性判定"的
// **唯一实现**在 `shared/app-control-commands.cjs`（CJS），渲染层拿不到；渲染层自己再抄一份必然漂移，
// 而漂移出来的覆盖率是**假指标**（显示 100% 却没那个能力），比没有指标更糟。本组件只负责渲染。
//
// 两个数字刻意分开显示，别混：
//   · **能力覆盖**（分母=该类目标的全量控制命令）—— 参与 70% 判定，达标/未达标如实标注。
//   · **本条用到**（该应用 Spec 实际用到哪些命令）—— 信息性的，**不参与判定**。
//     真实语料里 web 应用普遍 `goto+js` 一步到位（如三个真实目标都没用 click/type/scroll），
//     拿"用到/全量"当覆盖率会得出 33% 这种失真结论：能力明明在，只是这批命令没用到。
import { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { useTranslation } from '@/i18n/useTranslation'

interface CoverageRow {
  id: string
  i18nKey: string
  reasonKey?: string
}
interface Coverage {
  covered: number
  total: number
  ratio: number
  met: boolean
  missing: CoverageRow[]
}
interface Payload {
  class: string | null
  coverage: Coverage | null
  spec: { usedIds: string[]; unusedIds: string[] } | null
}

export function AppCoverage({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const [data, setData] = useState<Payload | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const api = (window as unknown as { api?: { appCoverage?: (id: string) => Promise<Payload> } }).api
    // 拿不到就什么都不显示（**不显示假数字**）：这一块是"如实呈现"，宁可缺席也不许编。
    if (!api?.appCoverage) { setFailed(true); return }
    api.appCoverage(appId)
      .then((d) => { if (alive) setData(d) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [appId])

  if (failed || !data || !data.coverage) return null
  const { coverage, class: cls, spec } = data
  const pct = Math.round(coverage.ratio * 100)
  const reasons = [...new Set(coverage.missing.map((m) => m.reasonKey).filter(Boolean))] as string[]

  return (
    <div className="flex flex-col gap-1 text-[11px]" data-testid="app-coverage">
      <div className="flex items-center gap-1.5">
        <Gauge className="w-3.5 h-3.5 text-tertiary" />
        <span className="text-tertiary">{t('apps.coverageTitle')}</span>
        <span className={coverage.met ? 'text-success' : 'text-warning'}>
          {t('apps.coverageValue', { covered: String(coverage.covered), total: String(coverage.total), pct: String(pct) })}
        </span>
        {/* 未达标时明说"未达 70%"，不要只给一个数字让人自己比大小 */}
        <span className={coverage.met ? 'text-success' : 'text-warning'}>
          {coverage.met ? t('apps.coverageMet') : t('apps.coverageUnmet')}
        </span>
      </div>
      {coverage.missing.length > 0 && (
        <div className="text-warning">
          {t('apps.coverageMissing', {
            list: coverage.missing.map((m) => t(m.i18nKey)).join('、'),
          })}
          {reasons.map((r) => `（${t(r)}）`).join('')}
        </div>
      )}
      {spec && (
        <div className="text-tertiary">
          {t('apps.coverageUsed', {
            list: spec.usedIds.length ? spec.usedIds.map((id) => t(`apps.cmd_${cls}_${id}`)).join('、') : t('apps.coverageUsedNone'),
          })}
        </div>
      )}
    </div>
  )
}
