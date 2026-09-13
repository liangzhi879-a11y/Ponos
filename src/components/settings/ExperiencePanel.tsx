// src/components/settings/ExperiencePanel.tsx —— 设置 → 经验与知识库（S2 Task 10 简化：338 → 200 行内）
//
// 简化依据 spec §10 D4 + §7：本页从"经验浏览器"收窄为**知识库设置子页**，只留三类东西：
//   ① 注入设置（开关 / 上限）—— 落 ~/.yfworking/config.json，全库无第二个入口
//   ② 经验空间路径 + 索引状态与重建（/knowledge/spaces + /knowledge/stats + /knowledge/reindex）
//   ③ 主题"激活"开关 + 导入/导出 —— 数据维护操作，同样无其他 GUI 入口
//
// **被移除功能的去向（对照表见 .superpowers/sdd/2026-09-13-knowledge-core-S1/s2-task-10-report.md）**：
//   经验条目列表 / 主题搜索 / 展开"查看全部" / 逐条删除 → **知识 面板**。经验主题就是
//   `~/.yfworking/memory/personal/*.md`，而它正是知识库的内置空间「个人经验」
//   （shared/knowledge-core.mjs:builtinSpaceSpecs）——同一份文件在知识面板按文档阅读/编辑/删除，
//   `- [会话|标签] 摘要 -- 全文` 行渲染为经验卡片。本页再放一套浏览 UI 只会造成"两个入口改哪个才生效"的困惑。
//
// 保留"激活"开关的理由：frontmatter `active: false` 让该主题整篇退出注入（server/experience.mjs
// buildExperienceIndex 过滤 active），是相关性控制；知识面板里只能在编辑视图手改 frontmatter。
import { useEffect, useMemo, useState } from 'react'
import { Brain, Database, Download, Library, RefreshCw, Upload } from 'lucide-react'
import { Button, Switch } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useViewStore } from '@/stores/viewStore'
import { fetchBridgeConfig, saveBridgeConfig } from '@/lib/config'
import { getStats, listSpaces, reindex, type KnowledgeStats } from '@/lib/knowledgeApi'
import { cn, CHAT_STORAGE_KEY } from '@/lib/utils'
import type { ExperienceTheme } from '@/types'
import { ExportDialog, ImportDialog } from './ExperienceDataDialogs'
import { fmtAge, fmtBytes, normalizeInjectMax } from './experienceFormat'

// preload 注入的 window.yfworkingAPI 仅存在于 Electron 渲染进程；dev 模式（纯 Vite、无 preload）
// 下为 undefined，所有调用点必须守卫，避免挂载即崩溃。索引一段走 HTTP 桥接（knowledgeApi），
// 无 preload 也能用——dev 下本页至少还能看索引状态。
const api = window.yfworkingAPI

export function ExperiencePanel() {
  const [injectEnabled, setInjectEnabled] = useState(true)
  const [injectMax, setInjectMax] = useState(4096)
  const [themes, setThemes] = useState<ExperienceTheme[]>([])
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [spacePath, setSpacePath] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const lastCwd = useChatStore(s => s.lastCwd)

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 5000)
  }

  const loadThemes = () => {
    if (!api) return
    api.experienceList().then(r => {
      if (r.ok && r.themes) setThemes(r.themes)
      else flash(r.error || '读取经验主题失败', false)
    })
  }

  // 索引状态与空间路径都来自 S1 的 HTTP 端点：桌面环境与否都能看（dev 下不再是一片"未检测到桌面环境"）
  const loadIndex = () => {
    getStats().then(r => { if (r.ok) setStats(r.data); else flash(r.error, false) })
    listSpaces().then(r => {
      if (!r.ok) return
      const exp = r.data.spaces.find(s => s.source === 'experience' || s.id === 'experience')
      setSpacePath(exp?.root ?? null)
    })
  }

  useEffect(() => {
    loadThemes()
    loadIndex()
    fetchBridgeConfig().then(cfg => {
      setInjectEnabled(cfg.experienceInjectEnabled !== false)
      setInjectMax(normalizeInjectMax(cfg.experienceInjectMaxBytes))
    }).catch(() => {})
  }, [])

  const saveInject = (enabled: boolean, maxBytes: number) => {
    fetchBridgeConfig().then(cfg => {
      saveBridgeConfig({ ...cfg, experienceInjectEnabled: enabled, experienceInjectMaxBytes: maxBytes })
        .then(() => flash('注入设置已保存'))
    }).catch(() => flash('保存失败', false))
  }

  const rebuildIndex = async () => {
    setBusy(true)
    const r = await reindex()
    setBusy(false)
    if (!r.ok) { flash(r.error || '重建失败', false); return }
    setStats(r.data)
    flash('索引已重建')
  }

  // 打开知识面板：设置窗与主窗共享同一份 localStorage（'yfworking-view'），写入 rail 后由
  // viewStore 的 storage 监听把主窗口切到「知识」（见 viewStore.ts 末尾）。view 字段不影响它。
  const openKnowledge = () => {
    useViewStore.getState().enterWork('knowledge')
    flash('已请求主窗口打开「知识」面板（主窗口未运行时请先打开）')
  }

  // 导出会话数据用：localStorage 在隐私模式/配额异常下会抛，捕获后按"没有会话数据"处理
  const chatsJson = () => { try { return window.localStorage.getItem(CHAT_STORAGE_KEY) } catch { return null } }

  const totalEntries = useMemo(() => themes.reduce((s, x) => s + x.entryCount, 0), [themes])
  // 激活开关的两种"没得选"状态给同一处文案位：dev 无 preload 时 IPC 不可用，空库时没主题
  const themeHint = !api
    ? '未检测到桌面环境（dev 模式无 preload）：激活开关不可用'
    : themes.length === 0 ? '暂无经验主题，多用 YFWorking 工作会自动沉淀' : null

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-primary mb-1 flex items-center gap-2">
          <Brain className="w-4 h-4" />
          个人经验与知识库
        </h3>
        <p className="text-xs text-tertiary mb-1">
          经验全自动静默沉积于 <span className="font-mono text-secondary">{spacePath || '~/.yfworking/memory/personal'}</span>，
          新会话按相关性注入（上限 {injectMax} 字符）。共 {themes.length} 个主题 / {totalEntries} 条经验。
        </p>
        {/* 去向说明：原"条目列表/搜索/删除"被移除，用户必须能一眼看到该去哪找（spec §10 D4） */}
        <p className="text-xs text-tertiary mb-4">
          浏览、搜索、编辑或删除具体经验条目请到 <span className="text-secondary">知识</span> 面板左栏的「个人经验」空间
          （就是上面这个目录，同一份 md 文件，条目会渲染成卡片）。
        </p>

        {/* ① 注入设置 */}
        <div className="cut-sm mb-4">
          <div className="ci p-4 space-y-3">
          <label className="flex items-center justify-between gap-3 py-1">
            <span className="text-sm text-secondary">新会话注入经验
              <span className="block text-[10px] text-tertiary mt-0.5">开启后每次会话自动携带已激活经验（含沉积引导）</span>
            </span>
            <Switch checked={injectEnabled} onCheckedChange={v => { setInjectEnabled(v); saveInject(v, injectMax) }} />
          </label>
          <label className="flex items-center justify-between gap-3 py-1">
            <span className="text-sm text-secondary">注入上限（字符）
              <span className="block text-[10px] text-tertiary mt-0.5">超出部分按最近更新截断</span>
            </span>
            <input
              type="number" min={512} max={16384} step={512} value={injectMax}
              onChange={e => setInjectMax(Number(e.target.value) || 4096)}
              onBlur={() => saveInject(injectEnabled, injectMax)}
              className="w-28 h-8 rounded-md border border bg-surface px-2 text-xs text-primary text-right font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          </div>
        </div>

        {/* ② 索引状态 + 重建（spec §7：本页保留"索引状态与重建入口"） */}
        <div className="cut-sm mb-4">
          <div className="ci p-4">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-3.5 h-3.5 text-tertiary" />
              <span className="text-sm text-secondary">知识索引</span>
              <span className="ml-auto text-[10px] text-tertiary">{stats ? `${fmtAge(stats.indexAgeMs)}构建 · ${fmtBytes(stats.indexBytes)}` : '读取中…'}</span>
              <Button variant="outline" size="sm" disabled={busy} leftIcon={<RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />} onClick={rebuildIndex}>
                {busy ? '重建中…' : '重建索引'}
              </Button>
            </div>
            <p className="text-[10px] text-tertiary">
              {stats ? `${stats.docs} 篇文档 / ${stats.blocks} 块 · ${stats.spaces} 个空间 · 倒排 ${stats.grams} gram` : '尚未读到索引统计（桥接服务未启动？）'}
              　内容改动后通常自动增量更新；检索结果缺漏时点「重建索引」全量重扫。
            </p>
          </div>
        </div>

        {/* ③ 主题激活（frontmatter active）——注入相关性控制，全库唯一入口 */}
        <div className="cut-sm mb-4">
          <div className="ci p-4">
            <div className="text-sm text-secondary mb-1">注入哪些主题</div>
            <p className="text-[10px] text-tertiary mb-2">关闭即把该主题 md 的 frontmatter 写成 active: false，整篇退出注入（条目仍在，不被删除）。</p>
            {themeHint ? <p className="text-[10px] text-tertiary">{themeHint}</p> : (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 pr-1">
                {themes.map(x => (
                  <label key={x.theme} className="flex items-center gap-1.5 text-xs text-secondary">
                    <Switch checked={x.active} onCheckedChange={v => { api?.setExperienceActive(x.theme, v).then(r => { if (r.ok) loadThemes() }) }} />
                    <span>{x.theme} <span className="text-[10px] text-tertiary">{x.entryCount}</span></span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ④ 数据搬运 + 刷新 + 跳知识面板 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" leftIcon={<Library className="w-3.5 h-3.5" />} onClick={openKnowledge}>在知识面板中打开</Button>
          <Button variant="outline" size="sm" leftIcon={<Download className="w-3.5 h-3.5" />} onClick={() => setExportOpen(true)}>导出</Button>
          <Button variant="outline" size="sm" leftIcon={<Upload className="w-3.5 h-3.5" />} onClick={() => setImportOpen(true)}>导入</Button>
          <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => { loadThemes(); loadIndex() }}>刷新</Button>
          {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-error')}>{msg.text}</span>}
        </div>
      </div>

      {exportOpen && <ExportDialog lastCwd={lastCwd} chatsJson={chatsJson} onClose={() => setExportOpen(false)} onDone={m => flash(m)} />}
      {importOpen && <ImportDialog lastCwd={lastCwd} onClose={() => setImportOpen(false)} onDone={m => flash(m)} />}
    </div>
  )
}
