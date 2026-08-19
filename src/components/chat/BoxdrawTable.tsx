import type { ParsedBoxTable } from '@/lib/utils'

interface Props {
  table: ParsedBoxTable
}

function normalizeCells(cells: string[], colCount: number): { cells: string[]; colSpan?: number } {
  if (cells.length === 1 && colCount > 1) return { cells, colSpan: colCount }
  const padded = [...cells]
  while (padded.length < colCount) padded.push('')
  return { cells: padded.slice(0, colCount) }
}

export function BoxdrawTable({ table }: Props) {
  const colCount = table.header?.length ?? table.rows[0]?.length ?? 1
  return (
    <div className="overflow-x-auto my-2 max-w-full">
      <table className="min-w-full border-collapse border border text-sm">
        {table.caption && (
          <caption className="caption-top border border-b-0 bg-elevated px-3 py-1.5 text-left text-xs font-semibold text-primary break-words [overflow-wrap:anywhere]">
            {table.caption}
          </caption>
        )}
        {table.header && (
          <thead>
            <tr>
              {table.header.map((cell, i) => (
                <th key={i} className="border border bg-elevated px-3 py-1.5 text-left font-semibold break-words [overflow-wrap:anywhere]">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {table.rows.map((row, ri) => {
            const { cells, colSpan } = normalizeCells(row, colCount)
            if (colSpan) {
              return (
                <tr key={ri}>
                  <td colSpan={colSpan} className="border border bg-app/40 px-3 py-1.5 text-xs font-medium text-secondary break-words [overflow-wrap:anywhere]">
                    {cells[0]}
                  </td>
                </tr>
              )
            }
            return (
              <tr key={ri}>
                {cells.map((cell, ci) => (
                  <td key={ci} className="border border px-3 py-1.5 break-words [overflow-wrap:anywhere]">
                    {cell}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
        {table.footer && (
          <tfoot>
            <tr>
              <td colSpan={colCount} className="border border bg-app/40 px-3 py-1.5 text-xs font-medium text-secondary break-words [overflow-wrap:anywhere]">
                {table.footer.join(' ')}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
