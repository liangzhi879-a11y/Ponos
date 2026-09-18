import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { AlertTriangle, Lock, LockOpen, RefreshCw, Users } from 'lucide-react'
import { Tooltip } from '@/components/ui'
import { getBridgeUrl } from '@/lib/config'
import { cn } from '@/lib/utils'

/**
 * 【S4】文件协同状态条（批注 #9 的裁定：**显式"检出/检入"按钮 + 顶栏状态条**）
 *
 * 设计取舍（照裁定的字面执行，不自行发挥）：
 * * **不做"打开即自动检出"**：检出是显式动作。自动检出会在"用户只是打开看一眼"时就把文件
 *   锁给别人，且窗口崩溃/忘记关闭会长期占住文件（那正是裁定里被否掉的两个方案的问题）。
 * * **状态常驻可见**：只读原因、持有者、剩余时间都写在条上 —— 否则用户只看到"不能编辑"，
 *   既不知为何、也不知要等多久。
 * * **默认安静**：目录未开启占用（批注 #3 全局默认关闭）时，本组件**不显示任何占用信息**，
 *   只显示"未纳管/已纳管"，不打扰任何人。这正是 opt-in 语义在 UI 上的体现。
 *
 * 冲突处置（总设计 §5.4 四选一）由 `openConflict()` 触发：接受对方 / 保留我的 / 另存副本 /
 * 进编辑器。其中"另存副本"在服务端会**降级为草稿**（不产生同目录近似文件）。
 */
export interface FileCollabHandle {
  /** 由编辑器在遇到 409/版本冲突时调用，弹出四选一处置。 */
  openConflict: (payload: {
    fileId: string
    baseVersionId: string
    mineVersionId: string
    theirsVersionId: string
  }) => void
  /** 重新拉取状态（保存成功、外部改动后调用）。 */
  refresh: () => void
}

interface Props {
  path: string
  name: string
  /** 本地成员标识（团队设备 id）；缺省时条上的占用动作会被禁用 */
  memberId?: string | null
  className?: string
}

interface CollabStatus {
  teamId?: string
  deviceId?: string | null
  fileId?: string | null
  ingested?: boolean
  modal?: string
  readonly?: boolean
  reason?: string
  holder?: string | null
  remainingMs?: number | null
  policy?: { softClaim?: boolean; occupancy?: string }
}

type ConflictChoice = 'use-theirs' | 'use-mine' | 'save-copy' | 'edit-merge'

const REASON_TEXT: Record<string, string> = {
  'held-by-other': '他人正在编辑',
  'modal-not-writable': '该格式不支持原地编辑',
  'claims-disabled': '本目录未开启占用',
  free: '空闲',
  held: '已检出',
  expired: '占用已过期',
}

const MODAL_TEXT: Record<string, string> = {
  'L-A': '可合并',
  'L-B': '只追加版本',
  'L-C': '需先转换',
  'L-D': '独占编辑',
}

export const FileCollabBar = forwardRef<FileCollabHandle, Props>(function FileCollabBar(
  { path, name, memberId, className },
  ref,
) {
  const [status, setStatus] = useState<CollabStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [conflict, setConflict] = useState<null | {
    fileId: string
    baseVersionId: string
    mineVersionId: string
    theirsVersionId: string
  }>(null)

  // 成员标识：优先用传入的；否则取团队设备的 deviceId（同一台机器即同一成员）
  const me = memberId || status?.deviceId || null

  const load = useCallback(async () => {
    try {
      const u = new URL(getBridgeUrl() + '/file-collab/status')
      u.searchParams.set('path', path)
      if (memberId) u.searchParams.set('memberId', memberId)
      const res = await fetch(u.toString())
      const d = await res.json()
      // 没有团队源（no-team）不是错误：此时协同功能整体不可用，条上只报这一件事
      if (!res.ok || !d.ok) {
        setStatus(null)
        setError(d.reason === 'no-team' ? '' : (d.error || `HTTP ${res.status}`))
        return
      }
      setStatus(d)
      setError('')
    } catch (e: any) {
      setError(e?.message || '状态获取失败')
    }
  }, [path, memberId])

  useEffect(() => { load() }, [load])

  const post = async (endpoint: string, body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(getBridgeUrl() + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, memberId: me, ...body }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) {
        // 检入冲突是**唯一的自然三方入口**（检出→他人提交→我检入）：转成冲突处置对话框，
        // 而不是把错误抛给用户去自行理解"为什么检不了"。
        if (d.code === 'checkin-conflict' && d.baseVersionId && d.mineVersionId && d.theirsVersionId && status?.fileId) {
          setConflict({
            fileId: status.fileId,
            baseVersionId: d.baseVersionId,
            mineVersionId: d.mineVersionId,
            theirsVersionId: d.theirsVersionId,
          })
        }
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      await load()
      return d
    } catch (e: any) {
      setError(e?.message || '操作失败')
      return null
    } finally {
      setBusy(false)
    }
  }

  useImperativeHandle(ref, () => ({
    openConflict: (payload) => setConflict(payload),
    refresh: () => { load() },
  }), [load])

  const ingest = () => post('/file-collab/ingest', {})
  const checkout = () => post('/file-collab/claim', {})
  const release = () => post('/file-collab/release', { fileId: status?.fileId })

  const resolveConflict = async (choice: ConflictChoice) => {
    if (!conflict) return
    const d = await post('/file-collab/conflict', { ...conflict, choice, logicalName: name })
    if (!d) return

    // `edit-merge` 现在会真的执行三路合并并落盘，所以按**真实结果**回报。
    // （此前这里只写"已交给三路合并"，而服务端当年没有任何编排 —— 提示与事实不符，
    //   会让人在以为已合并的状态下继续操作；谎报成功比报错更危险。）
    const m = d.merge
    if (m) {
      if (m.ok && m.written) {
        const sheets = Array.isArray(m.sheets) && m.sheets.length ? `，涉及 ${m.sheets.length} 张表` : ''
        setNote(`三路合并完成并已落盘（${m.ops} 处改动${sheets}）`)
        setConflict(null)
        return
      }
      if (m.ok) {
        setNote('三路合并：两边内容一致，无需改动')
        setConflict(null)
        return
      }
      if (m.reason === 'conflict') {
        const n = Array.isArray(m.conflicts) ? m.conflicts.length : 0
        const first = m.conflicts?.[0]
        const where = first ? `${first.label || ''}${first.sheet ? `${first.sheet}!` : ''}${first.colId ? `${first.rowId}/${first.colId}` : ''} ` : ''
        // 未落盘 ⇒ 保持弹窗打开，用户可改选其它处置方式
        setNote(`三路合并有 ${n} 处无法自动判定（${where}${first?.reason || ''}）——未落盘，请改选其它方式`)
        return
      }
      setNote(`三路合并未能落盘：${m.reason}${m.detail ? `（${m.detail.error || m.detail}）` : ''}`)
      return
    }

    setNote(d.action === 'save-draft'
      ? `已另存为草稿（见团队源 drafts/）：${d.draftPath}`
      : '已按所选版本处理（内容落盘需重新载入后再保存）')
    setConflict(null)
  }

  // 未纳管 / 无团队源：条上只保留一件可做的事（纳管），不显示占用信息（默认安静的语义）
  const ingested = status?.ingested
  const holder = status?.holder || null
  const readonly = !!status?.readonly
  const claimsOn = !!status?.policy?.softClaim
  const remaining = status?.remainingMs

  return (
    <div className={cn('flex items-center gap-2 px-3 py-1 text-xs border-b bg-elevated/40 shrink-0', className)}>
      <Users className="w-3 h-3 text-tertiary shrink-0" />

      {!status ? (
        <>
          <span className="text-tertiary">协同：未启用</span>
          {error && <span className="text-error truncate max-w-[240px]" title={error}>⚠ {error}</span>}
          <button
            onClick={load}
            className="ml-1 px-1.5 py-0.5 rounded border border-tertiary/30 hover:bg-elevated text-tertiary"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </>
      ) : (
        <>
          <span className="text-tertiary">
            {status.modal ? (MODAL_TEXT[status.modal] || status.modal) : '—'}
          </span>

          {!ingested ? (
            <button
              onClick={ingest}
              disabled={busy}
              className="px-1.5 py-0.5 rounded border border-brand-500/40 text-brand-500 hover:bg-brand-500/10 disabled:opacity-40"
            >
              纳入协同
            </button>
          ) : (
            <>
              {/* 只读原因必须常驻可见（#9）：只说"不能编辑"等于没说 */}
              {readonly && (
                <span className="flex items-center gap-1 text-warning">
                  <Lock className="w-3 h-3" />
                  {REASON_TEXT[status.reason || ''] || '只读'}
                  {holder && <span className="text-tertiary">（{holder}）</span>}
                  {typeof remaining === 'number' && remaining > 0 && (
                    <span className="text-tertiary">剩余 {Math.ceil(remaining / 1000)}s</span>
                  )}
                </span>
              )}

              {/* 显式动作按钮：检出 / 检入（#9 裁定） */}
              {claimsOn && (
                readonly && holder && holder !== me ? (
                  <span className="text-tertiary">等待 {holder} 检入或租约到期后可接管</span>
                ) : (
                  <>
                    <button
                      onClick={checkout}
                      disabled={busy || !me}
                      className="px-1.5 py-0.5 rounded border border-tertiary/30 hover:bg-elevated disabled:opacity-40"
                      title={me ? '检出后独占编辑，其他人只读' : '缺少成员标识，无法检出'}
                    >
                      检出
                    </button>
                    <button
                      onClick={release}
                      disabled={busy || !me || !status.fileId}
                      className="px-1.5 py-0.5 rounded border border-tertiary/30 hover:bg-elevated disabled:opacity-40"
                      title="检入：提交当前内容为新版本并释放占用"
                    >
                      <span className="flex items-center gap-1"><LockOpen className="w-3 h-3" />检入</span>
                    </button>
                  </>
                )
              )}

              {!claimsOn && (
                <span className="text-tertiary">本目录未开启占用（可在团队设置中按目录开启）</span>
              )}
            </>
          )}

          {error && <span className="text-error truncate max-w-[240px]" title={error}>⚠ {error}</span>}
          {note && <span className="text-brand-500 truncate max-w-[320px]" title={note}>{note}</span>}
          <button
            onClick={load}
            className="ml-auto px-1.5 py-0.5 rounded border border-tertiary/30 hover:bg-elevated text-tertiary"
            title="刷新协同状态"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </>
      )}

      {/* 冲突处置（总设计 §5.4 四选一） */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConflict(null)}>
          <div
            className="w-[420px] rounded-lg border bg-modal p-4 text-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2 text-warning">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">文件已被他人修改</span>
            </div>
            <p className="text-tertiary text-xs mb-3">
              你的版本与对方版本存在冲突，请选择处理方式（不会自动替你决定）。
            </p>
            <div className="flex flex-col gap-1.5">
              <button onClick={() => resolveConflict('use-theirs')} className="px-2 py-1.5 rounded border hover:bg-elevated text-left">
                接受对方版本<span className="text-tertiary">（放弃我的改动）</span>
              </button>
              <button onClick={() => resolveConflict('use-mine')} className="px-2 py-1.5 rounded border hover:bg-elevated text-left">
                保留我的版本<span className="text-tertiary">（放弃对方改动）</span>
              </button>
              <button onClick={() => resolveConflict('save-copy')} className="px-2 py-1.5 rounded border hover:bg-elevated text-left">
                我的改动另存为草稿<span className="text-tertiary">（不改动正本）</span>
              </button>
              <button onClick={() => resolveConflict('edit-merge')} className="px-2 py-1.5 rounded border hover:bg-elevated text-left">
                进入编辑器逐处合并<span className="text-tertiary">（三路合并）</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button onClick={() => setConflict(null)} className="px-2 py-1 text-tertiary hover:text-primary">取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
