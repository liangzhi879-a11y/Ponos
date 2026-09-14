// src/components/knowledge/KnowledgeImportReport.tsx —— 导入结果报告（2026-09-14 抽出）
//
// 从 `KnowledgeImportDialog.tsx` 抽出的**唯一理由**是文件长度纪律：那个对话框在加入
// 视觉模型提示后越过了 `scripts/verify-knowledge-gui.mjs` 的 400 行上限。抽出的这两块
// 本就是一个自洽单元（"导入/视觉的结果如何呈现"），与对话框的**输入与流程**无关：
//   · KnowledgeImportReport —— 结果分区（计数 / 索引待同步 / 视觉表格来源 / 四个明细清单）
//   · EntryList / MAX_ROWS —— 报告内部专用的明细列表（此前已只有报告在用）
//
// 归档于此的一个**真缺陷修复**：原先这里的告警用的是 `text-warn` / `text-danger`，
// 而主题里定义的 token 是 `warning` / `error`（`tailwind.config.ts` 的 colors）。
// 未定义的类名不会报错、只是**不生效** —— 表现为"告警文字渲染成普通灰色"，
// 也就是**该醒目的提示反而不醒目**。这类错法没有编译期信号，只能靠对照主题定义发现。
import { useTranslation } from '@/i18n/useTranslation'
import type { KnowledgeImportEntry, KnowledgeImportReport as ImportReport } from '@/lib/knowledgeApi'

/**
 * 明细清单最多展示多少条（对话框的文件列表也用同一个值 —— 故导出，避免两处各写一份
 * 而慢慢分叉：用户会看到"文件列表 20 条、结果清单 6 条"这种说不清理由的不一致）。
 */
export const MAX_ROWS = 20

interface EntryListProps {
  title: string
  items: KnowledgeImportEntry[]
  /** 施加在**标题行**上的颜色类（条目行恒为次要色 + 溢出计数） */
  tone: string
  render: (e: KnowledgeImportEntry) => string
}

/** 三档明细的统一渲染：只展示前 MAX_ROWS 条 + 溢出计数，避免一次导入几百文件把对话框撑爆 */
function EntryList({ title, items, tone, render }: EntryListProps) {
  const { t } = useTranslation()
  if (!items.length) return null
  return (
    <div>
      <p className={`text-[10px] ${tone}`}>{title}（{items.length}）</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.slice(0, MAX_ROWS).map((e, i) => (
          // `title` + `truncate`：路径可能很长，截断显示但悬停可读全文（原先就有，勿删）
          <li key={`${e.source}#${i}`} className="text-[10px] text-tertiary truncate" title={render(e)}>
            {render(e)}
          </li>
        ))}
        {items.length > MAX_ROWS && (
          <li className="text-[10px] text-tertiary">{t('knowledge.importMoreRows', { n: items.length - MAX_ROWS })}</li>
        )}
      </ul>
    </div>
  )
}

/**
 * 这份结果是不是"扫描件/图片"（= 若配了视觉模型才有机会拿到表格的那类）。
 *
 * 为什么按 `converter` 判而不是按扩展名：`.pdf` 既有文本层也有扫描件 —— 文本层 PDF 的表格
 * 由本地 PyMuPDF 直接读（不受视觉模型影响），只有 `pdf-ocr` / `ocr` 这两种才依赖视觉模型。
 * 按扩展名判会对着已经读出表格的文本层 PDF 说"表格没被提取"，是**假告警**。
 *
 * 判据与原实现逐字一致（精确匹配两种 converter）：改成 `includes('ocr')` 看着更宽容，
 * 但会把将来任何一种名字里带 ocr 的转换器都算进来 —— 那可能根本不是"依赖视觉模型"的路径，
 * 于是又回到假告警。要放宽应当**先确认新转换器的语义**，而不是先放宽判据。
 */
function isScannedResult(e: KnowledgeImportEntry): boolean {
  const c = e.converter || ''
  return c === 'pdf-ocr' || c === 'ocr'
}

export interface KnowledgeImportReportProps {
  report: ImportReport
}

export function KnowledgeImportReport({ report }: KnowledgeImportReportProps) {
  const { t } = useTranslation()
  return (
    <div className="mt-3 border-t border-default pt-2 space-y-2">
      <p className="text-[11px] text-secondary">
        {report.dryRun ? t('knowledge.importPreviewDone') : t('knowledge.importDone')}
        {' · '}
        {`${report.spaceName} · ${t('knowledge.importOk')} ${report.counts.converted} / ${t('knowledge.importSkipped')} ${report.counts.skipped} / ${t('knowledge.importFailedShort')} ${report.counts.failed}`}
      </p>
      {/* 索引未同步时必须说一声：否则用户会以为"导入失败"（明明文件已经在树里） */}
      {!report.dryRun && report.counts.converted > 0 && report.indexSync !== 'reloaded' && (
        <p className="text-[10px] text-tertiary">{t('knowledge.importIndexPending')}</p>
      )}
      {/* 视觉表格提取的**事后**口径：读了表格要说清是哪来的（用词可追溯，避免用户以为
          "扫描件里本来没表格"）；没读出来且确实有扫描件/图片时，给出"怎么才能读到"
          —— 这两句正是用户判断"要不要去配/重导"的唯一依据，缺失就等于让用户自己猜。 */}
      {(report.vision?.tables ?? 0) > 0 && (
        <p className="text-[10px] text-secondary">
          {t('knowledge.importVisionExtracted', { tables: report.vision!.tables, pages: report.vision!.pages })}
        </p>
      )}
      {report.vision?.skipped === 'not-configured' && report.converted.some(isScannedResult) && (
        <p className="text-[10px] text-warning">{t('knowledge.importVisionSkipped')}</p>
      )}
      <EntryList
        title={report.dryRun ? t('knowledge.importWillConvert') : t('knowledge.importConverted')}
        items={report.converted}
        tone="text-secondary"
        render={e => `${e.source} → ${e.out ?? ''}${e.converter ? `（${e.converter}）` : ''}`}
      />
      <EntryList
        title={t('knowledge.importSkippedList')}
        items={report.skipped}
        tone="text-secondary"
        render={e => `${e.source} → ${e.out ?? ''}`}
      />
      <EntryList
        title={t('knowledge.importFailedList')}
        items={report.failed}
        // 失败清单的标题用 error 色（原先写的是 `text-danger` —— 主题里没有这个 token，
        // 类名不生效、只是静默渲染成默认色，于是"失败"看着和"成功"一样。见文件头注释）
        tone="text-error"
        render={e => `${e.source}：${e.message ?? e.error ?? ''}`}
      />
      {report.warnings?.length > 0 && (
        <EntryList
          title={t('knowledge.importWarnings')}
          items={report.warnings.map(w => ({ source: w }))}
          tone="text-secondary"
          render={e => e.source}
        />
      )}
    </div>
  )
}
