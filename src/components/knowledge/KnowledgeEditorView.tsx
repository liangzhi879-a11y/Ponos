// src/components/knowledge/KnowledgeEditorView.tsx —— 编辑视图（S2 Task 6）
//
// 三个坑（spec §11.3 对源码复核后的实测结论）在这里逐个避开：
//  ① `CodeEditor` **非受控**：`EditorState.create` 只在挂载的 effect 里跑一次
//     （editor/CodeEditor.tsx:236-253 有注释说明），另有一条 diff effect 负责同步外部内容。
//     所以**必须**传 `key={doc.id}`——不传的话切换文档时编辑器实例不重建，
//     用户会在"新文档"的标题下看到上一篇的正文，此时保存就是**写坏另一篇文档**。
//  ② `CodeEditor` **没有 readOnly prop，且约定不改它的接口** ⇒ 只读空间的能力靠"不渲染编辑视图"
//     实现：视图 tab 禁用 + tooltip「知识包为只读」（KnowledgeViewTabs），
//     已停在编辑视图时切到只读空间由宿主**降级回阅读视图**（KnowledgePanel 的 effect）。
//  ③ `CodeEditor` 根节点只有 `flex-1 min-h-0`、**自身无高度** ⇒ 宿主必须给确定高度，
//     否则编辑器高度塌成 0（表现为"编辑视图一片空白"）。故这里是 flex-col + 头部定高 + 编辑器 flex-1。
//
// 内容从哪来：`knowledgeApi.readRawDoc`（bridge /read-file）—— 不能拿 `/knowledge/doc` 的 blocks
// 拼正文：块层已丢掉 `- [ ]` 这类标记，拼回去保存会**永久写坏**用户文件（见该函数注释）。
// 保存走 `useKnowledge.saveDoc`：成功后失效 doc/tree/search/stats 缓存，"刚保存却搜不到"就不会出现。
//
// 提示一律用既有件：头部一行 `.micro` 文案 + 既有 `Button`；**不新建 Toast**（仓库无 Toast 组件，
// 为一个保存提示引入全局容器不划算）。保存失败**不抛**，把 `{ok:false,error}` 的文案显示出来即可
// （403 只读 / 413 过大 / 400 非法路径 都有可读说明）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readRawDoc, type KnowledgeDoc } from '@/lib/knowledgeApi'
import { saveDoc } from '@/hooks/useKnowledge'
import { useTranslation } from '@/i18n/useTranslation'
import { Button } from '@/components/ui'
import { CodeEditor } from '@/components/editor/CodeEditor'
import type { FileTab } from '@/types'
import { KnowledgeSkeleton } from './KnowledgeSkeleton'

export interface KnowledgeEditorViewProps {
  doc: KnowledgeDoc
  /** 空间 id（写回时的 `space`） */
  spaceId: string
  /** 空间根绝对路径（读原文用；来自 `spaces[].root`） */
  spaceRoot: string
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; error: string }
  /**
   * 409 冲突（2026-09-14 批次 4）：磁盘上的文件在你加载它之后被外部程序改过。
   * 这是**独立状态**而不是 failed —— 它不是错误，是"需要用户二选一"：
   * 载入外部版本（丢弃本地编辑）或覆盖（服务端先备份外部版本）。
   * 混进 failed 只会显示一行红字，用户根本不知道还有"覆盖"这个出口。
   */
  | { kind: 'conflict'; info: { mtime: number | null; size: number | null } | null }

export function KnowledgeEditorView({ doc, spaceId, spaceRoot }: KnowledgeEditorViewProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  // 在途保存的序号：连按 Ctrl+S 时晚到的**旧**响应不得覆盖新状态（旧响应可能带着 403 回来）
  const seqRef = useRef(0)

  // 读原文：随文档变化重取。alive 标记防"文档已经切走，旧响应才落定"把内容写成上一篇的
  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError(undefined)
    setSaveState({ kind: 'idle' })
    setContent('')
    setOriginal('')
    void (async () => {
      const r = await readRawDoc(spaceRoot, doc.rel)
      if (!alive) return
      if (r.ok) { setContent(r.data); setOriginal(r.data) } else { setLoadError(r.error) }
      setLoading(false)
    })()
    return () => { alive = false }
  }, [spaceRoot, doc.rel])

  const dirty = !loading && content !== original

  const onContentChange = useCallback((next: string) => {
    setContent(next)
    // 「已保存」随下一次输入失效：否则用户会以为新改动也一起保存了
    setSaveState(s => (s.kind === 'saved' ? { kind: 'idle' } : s))
  }, [])

  const doSave = useCallback((force = false) => {
    if (loading || !dirty) return          // 无改动不发请求：POST 会触发落盘 + 增量索引，白白重建
    const seq = ++seqRef.current
    setSaveState({ kind: 'saving' })
    void (async () => {
      // `mtime: doc.mtime`（2026-09-14 批次 4）：带上传给服务端做**覆盖前置校验**。
      // 知识空间目录是共享的 —— Obsidian/VSCode 会直接改同一批 md。带 mtime 后，服务端发现
      // "加载之后这文件被外部改过"就拒绝写入（409），而不是让外部那笔改动无声消失。
      // 只有用户明确选择"以我这份为准"（force=true）才允许覆盖，且服务端会先把外部版本备份进回收站。
      const r = await saveDoc({ space: spaceId, path: doc.rel, content, mtime: doc.mtime, force })
      if (seq !== seqRef.current) return   // 已有更新的保存发起 → 本次结果作废
      if (r.ok) { setOriginal(content); setSaveState({ kind: 'saved' }) }
      // 409 冲突不是"保存失败"，是"需要你决定"：单独一种状态，UI 给出两个出口
      // （载入外部版本 / 覆盖并备份）。混在 failed 里只会显示一行红字，用户不知道还能怎么办。
      else if (r.status === 409) setSaveState({ kind: 'conflict', info: r.conflict ?? null })
      else setSaveState({ kind: 'failed', error: r.error })
    })()
  }, [loading, dirty, spaceId, doc.rel, doc.mtime, content])

  /**
   * 冲突时「载入外部版本」：重新读磁盘原文，**丢弃本地编辑**。
   * 之所以要二次确认（由调用处的按钮文案承担：按钮就叫"载入外部版本"，不做静默替换）——
   * 这一步会把用户刚写的内容丢掉，而用户可能只是想看看外部改了什么。
   */
  const reloadExternal = useCallback(() => {
    setSaveState({ kind: 'idle' })
    setLoading(true)
    void (async () => {
      const r = await readRawDoc(spaceRoot, doc.rel)
      if (r.ok) { setContent(r.data); setOriginal(r.data); setLoadError(undefined) }
      else setLoadError(r.error)
      setLoading(false)
    })()
  }, [spaceRoot, doc.rel])

  // FileTab 是 CodeEditor 的入参形状（types/index.ts:373-381）；markdown 模式 = language: 'markdown'
  const file: FileTab = useMemo(() => ({
    id: doc.id,
    path: doc.rel,
    name: doc.rel.split(/[\\/]/).pop() || doc.rel,
    language: 'markdown',
    content,
    originalContent: original,
    modified: content !== original,
  }), [doc.id, doc.rel, content, original])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-default">
        <span className="text-[11px] text-primary truncate">{file.name}</span>
        <span className="flex-1 min-w-0" />
        {/* 冲突态（2026-09-14 批次 4）：给两个明确出口 + 磁盘版本的大小/时间。
            只显示"冲突了"等于把问题丢回给用户 —— 他需要知道外部版本是什么、该选哪个。 */}
        {saveState.kind === 'conflict' ? (
          <>
            <span className="text-[10px] text-warning truncate" title={t('knowledge.writeConflict')}>
              {t('knowledge.writeConflict')}
            </span>
            {saveState.info?.size != null && (
              <span className="micro shrink-0">{(saveState.info.size / 1024).toFixed(1)} KB</span>
            )}
            <Button variant="ghost" size="xs" onClick={reloadExternal} title={t('knowledge.writeConflictReload')}>
              {t('knowledge.writeConflictReload')}
            </Button>
            <Button variant="primary" size="xs" onClick={() => doSave(true)} title={t('knowledge.writeConflictOverwrite')}>
              {t('knowledge.writeConflictOverwrite')}
            </Button>
          </>
        ) : null}
        {saveState.kind === 'failed' ? (
          <span className="text-[10px] text-error truncate max-w-[45%]" title={saveState.error}>
            {t('knowledge.saveFailed', { msg: saveState.error })}
          </span>
        ) : saveState.kind === 'saving' ? (
          <span className="micro shrink-0">{t('knowledge.saving')}</span>
        ) : saveState.kind === 'conflict' ? null : dirty ? (
          <span className="micro shrink-0">{t('knowledge.unsaved')}</span>
        ) : saveState.kind === 'saved' ? (
          <span className="micro shrink-0">{t('knowledge.saved')}</span>
        ) : null}
        <Button
          variant="primary"
          size="xs"
          disabled={!dirty || saveState.kind === 'saving'}
          // 显式包一层：`onClick={doSave}` 会把 MouseEvent 当成 `force` 参数传进去
          // （`force = event` → 真值 → **任何一次普通保存都变成强制覆盖**）。这个坑很隐蔽：
          // 类型上 TS 会报错拦住，但如果哪天 doSave 的签名改成单参数就再也拦不住了。
          onClick={() => doSave()}
          title={t('knowledge.saveHint')}
        >
          {t('knowledge.save')}
        </Button>
      </div>

      {loading ? (
        <KnowledgeSkeleton lines={12} />
      ) : loadError ? (
        // 读原文失败（文件被删 / >512KB / 非 UTF-8）：给文案而不是空白编辑器——
        // 空白编辑器 + 保存钮会诱导用户把空内容写回，那才是真事故
        <div className="flex-1 min-h-0 flex items-center justify-center px-4">
          <span className="max-w-full text-xs text-error text-center break-all">
            {t('knowledge.rawFailed', { msg: loadError })}
          </span>
        </div>
      ) : (
        // key={doc.id}：见文件头 ①（CodeEditor 非受控，只靠挂载时读 file.content）
        <CodeEditor key={doc.id} file={file} onChange={onContentChange} onSave={doSave} />
      )}
    </div>
  )
}
