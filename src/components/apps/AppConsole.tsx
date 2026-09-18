// 应用控制台（Task 2.3 → Task 4 后段：三标签化）
//
// 职责：
//   1. 进入即绑定 / 离开即解绑（AI 能调这个应用 ↔ 不能调），严格单开由主进程保证；
//   2. 进入前自检（app:check）——broken 时给出可见警告，但不阻断（用户常需进去改 Spec）；
//   3. 手工执行命令：read 直接跑；write 需**二次确认**（写操作会在目标应用产生真实改动）。
//   4. （Task 4）**默认落在 agent 标签**：应用专属会话（appPageId 收窄工具池）+ 生成后自动跑一轮质检。
//
// ★ 为什么写操作要二次确认：控制台是人工点按的路径，没有内核侧审批链兜底
//   （内核侧审批只覆盖 AI 调用）。漏了这一步，用户点一下就可能真的提交/删除数据。
//
// ★ 为什么 agent 树**常挂**（切走只 CSS hidden、不 unmount）：ChatWindow 内部持有滚动位置、
//   assistant-ui 的视图状态与流式订阅；切到"命令"再切回来就重建的话，正在跑的质检输出会
//   从可视区消失（滚动到底部的跟踪也丢）。诊断/命令两棵树反之——它们带各自的 IPC 请求与
//   表单状态，一次只挂一棵（切换即重挂，符合"看的时候才去查"）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, LogIn, Play, Radio, Settings2, ShieldCheck, Sparkles, Terminal, Wrench } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, Tooltip } from '@/components/ui'
import { Button, Input } from '@/components/ui'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { ChatInput } from '@/components/chat/ChatInput'
import { FloatingQuestionCard } from '@/components/chat/FloatingQuestionCard'
import { useTranslation } from '@/i18n/useTranslation'
import { sendAnswer, dismissQuestion, useYFWCLI } from '@/hooks/useYFWCLI'
import { useChatStore } from '@/stores/chatStore'
import { APPS_TABS, readAppsTab, sanitizeAppsTab, writeAppsTab } from '@/lib/appsTab'
import { buildQualityPrompt, shouldAutoQuality, specFingerprint } from '@/lib/appQuality'
import { VERDICT_COPY, groupCapabilities, normalizeSurface, reviewSummary, summarizeSpec } from '@/lib/appSurface'
import { cn } from '@/lib/utils'
import { AppCoverage } from './AppCoverage'
import { SpecEditor } from './SpecEditor'
import type { AppsTab } from '@/lib/appsTab'
import type { AppSurface } from '@/lib/appSurface'
import type { AppCheckResult, AppItem, AppRepairResult, AppRunResult, AppSpec, AppSpecCommand, AppVerifyResult } from '@/types'

/** 标签元数据：图标 + i18n 键 + 一行说明（默认顺序与 APPS_TABS 一致） */
const TAB_META: Record<AppsTab, { labelKey: 'apps.tabAgent' | 'apps.tabDiagnose' | 'apps.tabCommands'; hintKey: 'apps.tabAgentHint' | 'apps.tabDiagnoseHint' | 'apps.tabCommandsHint' }> = {
  agent: { labelKey: 'apps.tabAgent', hintKey: 'apps.tabAgentHint' },
  diagnose: { labelKey: 'apps.tabDiagnose', hintKey: 'apps.tabDiagnoseHint' },
  commands: { labelKey: 'apps.tabCommands', hintKey: 'apps.tabCommandsHint' },
}

/**
 * 主标签（P1 面板降级，2026-09-17）：控制台以 **agent 智能运行为主**，`commands`（手工执行）
 * **保留但从主标签条撤下**，改由页头「手工执行命令」入口打开。
 *
 * 为什么不直接改 `APPS_TABS`：它是**持久化契约**（`sanitizeAppsTab` 会校验历史值、
 * localStorage / 会话里可能存着 `'commands'`）。把 `commands` 从 `APPS_TABS` 删掉会让
 * 老用户的落点被静默改写。所以只改**渲染**：主标签条少一项，`shownTab` 仍可等于 `'commands'`，
 * 只是那个状态现在由页头按钮进入（`shownTab === 'commands'` 时按钮呈激活态）。
 */
const PRIMARY_TABS = APPS_TABS.filter((v) => v !== 'commands')

/**
 * 自动质检的可见状态机（每一步都必须能看见——本仓库纪律"不得静默"）：
 *   verifying = 正在真实试跑（app:verify）；running = 已把质检提示词发给应用会话；
 *   skip = 判定不必跑（这一版已查过）或不该跑；done = 收到结论并已落标记；error = 发起失败。
 */
type QualityState =
  | { phase: 'verifying' }
  | { phase: 'running' }
  | { phase: 'skip'; message: string }
  | { phase: 'done'; message: string; clean: boolean; findings: number; markFailed?: string }
  | { phase: 'error'; message: string }

/** 从助手回复里抽结构化结论：取**最后一个** ```json 块（提示词要求结论放末尾） */
function extractQualityVerdict(text: string): { hasJson: boolean; findings: number } {
  const blocks = String(text || '').match(/```json\s*([\s\S]*?)```/gi) || []
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const body = blocks[i].replace(/^```json\s*/i, '').replace(/```$/, '')
    try {
      const o = JSON.parse(body) as { findings?: unknown }
      return { hasJson: true, findings: Array.isArray(o?.findings) ? o.findings.length : 0 }
    } catch { /* 不是结论块（可能是示意/片段），继续往前找 */ }
  }
  return { hasJson: false, findings: 0 }
}

/** 取会话里**最后一条助手消息**的全部文本（质检结论就在那里） */
function lastAssistantText(conversationId: string): string {
  const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
  const msgs = conv?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role !== 'assistant') continue
    return (msgs[i].content || []).filter((b) => b.type === 'text').map((b) => b.content).join('\n')
  }
  return ''
}

export function AppConsole({ app, sessionId, onBack, autoQuality = false, onQualityDone }: {
  app: AppItem
  sessionId: string | null
  onBack: () => void
  /**
   * 进入应用页是否允许自动质检（默认 false 以便单测/嵌入场景静默）。
   * ★ 它只是"允许"开关，**是否真跑由 Spec 指纹判定**：与上次质检标记指纹一致 ⇒ 跳过；
   *   变了（刚生成 / 手工改过 spec / 修复过）⇒ 跑一轮。故"指纹变化即重跑"与
   *   "生成后跑一轮"共用同一条路径，调用方恒传 true 即可。
   */
  autoQuality?: boolean
  /** 质检已发起完毕（成功/跳过/失败都调）——调用方可用于收尾（如清一次性标记）。 */
  onQualityDone?: () => void
}) {
  // lang 一并取出：`t` 每次渲染都是新函数（useTranslation 未 memo），
  // 放进依赖数组会让下方 useCallback/useEffect 每帧重建（本文件曾因此类隐患抖动）。
  // lang 是稳定字符串，且 t 的行为只由 lang 决定 ⇒ 语义不变、引用稳定。
  const { t, lang } = useTranslation()
  const api = window.yfworkingAPI
  const [spec, setSpec] = useState<AppSpec | null>(null)
  const [check, setCheck] = useState<AppCheckResult | null>(null)
  // 能力清单（M5）：按需探测，不在进入控制台时自动跑——web 探测要开一次隐藏浏览器，
  // desktop 探测会真的执行 --help（最长 5s/层），"只是看一眼命令"不该付这个成本。
  const [surface, setSurface] = useState<AppSurface | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [argValues, setArgValues] = useState<Record<string, Record<string, string>>>({})
  const [pending, setPending] = useState<AppSpecCommand | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<{ action: string; r: AppRunResult } | null>(null)
  const [bound, setBound] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repair, setRepair] = useState<AppRepairResult | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginMsg, setLoginMsg] = useState<string | null>(null)

  // ---- 标签（Task 4）：默认 agent；per-app 持久化（localStorage key 含 appId）----
  const [tab, setTab] = useState<AppsTab>(() => readAppsTab(app.id))
  // 极少数情况下本组件不换挂载就换了 app（列表筛选/同一位置复用），必须重读该应用的键，
  // 否则会把上一个应用停留的标签带过来
  useEffect(() => { setTab(readAppsTab(app.id)) }, [app.id])

  // ---- 应用专属会话（agent 标签的宿主）----
  // 幂等：一个应用一个常驻会话（见 getOrCreateAppConversation）。放在 effect 里而不是
  // useState 初始化函数里——创建会话是 store 写入，render 期间写 store 会触发 React 的
  // "渲染中更新他人"警告。首帧 agentConvId 为空 → 显示"正在准备会话"占位。
  const [agentConvId, setAgentConvId] = useState<string | null>(null)
  useEffect(() => {
    const id = useChatStore.getState().getOrCreateAppConversation(app.id, app.name)
    setAgentConvId(id)
  }, [app.id, app.name])

  const { send } = useYFWCLI()
  const pendingQuestion = useChatStore((s) => (agentConvId ? s.pendingQuestions[agentConvId] : undefined))
  const clearPendingQuestion = useChatStore((s) => s.clearPendingQuestion)
  const agentStreaming = useChatStore((s) => (agentConvId ? !!s.streamingConversations[agentConvId] : false))

  // ---- 质检状态（可见）----
  const [quality, setQuality] = useState<QualityState | null>(null)
  /** 试跑报告的失败明细（有则展示——"哪里坏了、为什么"不能只留在 AI 上下文里） */
  const [verifyFailures, setVerifyFailures] = useState<AppVerifyResult['failures']>([])
  /** 防重入 + "同一 appId 只跑一次"（StrictMode 双跑 effect、依赖变化重跑都靠它挡住） */
  const qualityStartedRef = useRef(false)
  /** 待收尾的质检：记录指纹与试跑结果，等 agent 轮次结束后落标记 */
  const qualityPendingRef = useRef<{ fingerprint: string; failures: number } | null>(null)
  /** 是否已经观察到该会话进入过流式（区分"发送后还没开跑"与"轮次已结束"） */
  const qualityStreamSeenRef = useRef(false)
  const qualityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onQualityDoneRef = useRef(onQualityDone)
  onQualityDoneRef.current = onQualityDone

  /** 落质检标记：写入失败**不阻塞界面**，但要可见提示（与"不得静默"一致） */
  const markQuality = useCallback(async (fingerprint: string, clean: boolean, findings: number) => {
    try {
      const r = await api?.appMarkQuality?.({ appId: app.id, quality: { fingerprint, checkedAt: Date.now(), clean, findings } })
      // 只判 ok===false（主进程真拒绝）；错误原因缺省时给 '-'，不塞一句假文案
      return r && r.ok === false ? t('apps.qualityMarkFailed', { msg: r.error || '-' }) : undefined
    } catch (e) {
      return t('apps.qualityMarkFailed', { msg: String((e as Error)?.message || e) })
    }
  }, [api, app.id, lang])   // 原为 t：不稳定引用会让此回调每帧重建

  // ---- 绑定生命周期：进入即绑、离开即解绑、依赖 sessionId 变化重绑 ----
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    void api?.appEnterConsole?.({ sessionId, appId: app.id })
      .then((r: { ok?: boolean; appId?: string } | undefined) => { if (alive) setBound(r?.appId ?? app.id) })
      .catch(() => { /* 绑定失败不阻断控制台（本地执行不需要绑定） */ })
    return () => {
      alive = false
      // 解绑必须带上 appId：主进程按 appId 校验，避免"迟到的离开事件"清掉用户刚切过去的另一个应用
      void api?.appLeaveConsole?.({ sessionId, appId: app.id })?.catch?.(() => {})
      setBound(null)
    }
  }, [api, app.id, sessionId])

  // ---- 载入 Spec + 自检 ----
  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const s = await api?.appReadSpec?.(app.id)
      setSpec(s ?? null)
      const c = await api?.appCheck?.(app.id)
      setCheck(c ?? null)
    } finally {
      setChecking(false)
    }
  }, [api, app.id])

  useEffect(() => { void runCheck() }, [runCheck])

  /**
   * 探测接入路径：复用既有 app:probe（返回值在 M5 起带上 surface）。
   * 无论成功失败都给出反馈——清单是"为什么这么接"的唯一解释，静默失败等于让用户猜。
   */
  const onProbeSurface = useCallback(async () => {
    if (!spec?.target) { setProbeMsg('尚未读取到 Spec，无法探测'); return }
    setProbing(true)
    setProbeMsg(null)
    try {
      const r = await api?.appProbe?.({ target: spec.target })
      const s = normalizeSurface(r?.surface)
      setSurface(s)
      if (!r?.ok) setProbeMsg(r?.error || '探测失败')
      else if (!s) setProbeMsg(r?.error || '本次未取得能力清单（可能缺少程序路径或浏览器执行器未就绪）')
      else setProbeMsg(null)
    } catch (e) {
      setProbeMsg(String((e as Error)?.message || e))
    } finally {
      setProbing(false)
    }
  }, [api, spec])

  /**
   * 打开登录窗口（用户主动触发，与应用命令/模型探索共用同一浏览器会话）。
   * 自动化窗口平时是隐藏的，没有这个入口用户就无处登录，登录态探索也就无从谈起。
   * 无论成功失败都给出反馈——不得静默。
   */
  const openLogin = useCallback(async () => {
    const url = spec?.target?.type === 'web' ? spec.target.url : ''
    if (!url) { setLoginMsg(t('apps.loginNoUrl')); return }
    setLoggingIn(true)
    setLoginMsg(null)
    try {
      const r = await api?.appLogin?.({ url, sessionId: sessionId || undefined })
      setLoginMsg(r?.ok ? t('apps.loginOpened') : (r?.error || t('apps.loginFail')))
    } catch (e) {
      setLoginMsg(String((e as Error)?.message || e))
    } finally {
      setLoggingIn(false)
    }
  }, [api, spec, sessionId, lang])   // 原为 t：不稳定引用会让此 effect 每帧重跑

  /**
   * 漂移修复：只修"最近一次执行失败"的命令（后端按 history 判定），
   * 写盘前自动备份、修完整体再校验，不合法就整体放弃。
   * 无论成功失败都把返回结果原样展示——不得静默。
   */
  const onRepair = useCallback(async () => {
    setRepairing(true)
    setRepair(null)
    try {
      const r = await api?.appRepair?.({ appId: app.id })
      setRepair(r ?? null)
      if (r?.ok) await runCheck()
    } catch (e) {
      setRepair({ ok: false, reason: String((e as Error)?.message || e), repaired: [], failed: [], backup: null })
    } finally {
      setRepairing(false)
    }
  }, [api, app.id, runCheck])

  const commands = useMemo(() => spec?.commands ?? [], [spec])

  /**
   * 评审结论（M4 的 spec.review，质量结论要看得见）。
   * ★ review 已正式进 AppSpec 类型，这里直接用 spec?.review；老 spec.json 没这个字段时为 undefined，
   *   reviewSummary 内部按"无评审记录"处理（不编内容）。
   */
  const reviewText = reviewSummary(spec?.review)

  // ---- 自动质检（Task 4）：发起 ----
  useEffect(() => {
    if (!autoQuality || !api || qualityStartedRef.current) return
    if (!agentConvId) return                       // 应用会话还没就绪（下一帧 effect 会重跑）
    qualityStartedRef.current = true
    void (async () => {
      // ① 确定性试跑（不写 history）：真实执行结果优先于模型猜测，失败必须可见
      setQuality({ phase: 'verifying' })
      let verify: AppVerifyResult | null = null
      try {
        verify = (await api.appVerify?.(app.id)) ?? null
      } catch (e) {
        setQuality({ phase: 'error', message: t('apps.qualityVerifyError', { msg: String((e as Error)?.message || e) }) })
        onQualityDoneRef.current?.()
        return
      }
      if (verify && verify.ok === false && verify.error) {
        // 环境级失败（执行器未就绪 / Spec 不存在）：如实说清，不当成"应用有 N 个问题"
        setQuality({ phase: 'error', message: t('apps.qualityVerifyError', { msg: verify.error }) })
        onQualityDoneRef.current?.()
        return
      }
      const failures = verify?.failures ?? []
      setVerifyFailures(failures)

      // ② 该不该跑：指纹一致（这一版已查过）/ 会话正流式（绝不并发）都判否
      let specNow: AppSpec | null = null
      try {
        specNow = (await api.appReadSpec?.(app.id)) ?? null
      } catch { /* 读不到 spec ⇒ 交给 shouldAutoQuality 的 !spec 分支判否 */ }
      const fingerprint = specFingerprint(specNow)
      const live = useChatStore.getState()
      const streaming = agentConvId ? !!live.streamingConversations[agentConvId] : false
      if (!shouldAutoQuality({ autoQuality: true, quality: app.quality, fingerprint, spec: specNow, isStreaming: streaming })) {
        // 三种判否各有各的话：这一版已查过 / 会话正忙（绝不并发）/ 没有 spec 可查
        const msg = app.quality?.fingerprint === fingerprint ? t('apps.qualityAlready')
          : streaming ? t('apps.qualityBusy')
            : t('apps.qualityNoSpec')
        setQuality({ phase: 'skip', message: msg })
        onQualityDoneRef.current?.()
        return
      }

      // ③ 组装提示词并发到应用会话（把"已给事实"喂给模型，不让它重复探测）
      const prompt = buildQualityPrompt({
        appName: app.name || app.id,
        check: check ?? null,
        verifyReport: verify ?? null,
        specSummary: summarizeSpec(specNow),
      })
      qualityPendingRef.current = { fingerprint, failures: failures.length }
      qualityStreamSeenRef.current = false
      setQuality({ phase: 'running' })
      try {
        send(agentConvId, prompt)
      } catch (e) {
        qualityPendingRef.current = null
        setQuality({ phase: 'error', message: t('apps.qualityCantRun', { msg: String((e as Error)?.message || e) }) })
        onQualityDoneRef.current?.()
        return
      }
      // 兜底：内核长时间无终态（提问卡死/进程异常）时不把质检永久挂在"进行中"
      qualityTimerRef.current = setTimeout(() => {
        const p = qualityPendingRef.current
        if (!p) return
        qualityPendingRef.current = null
        void markQuality(p.fingerprint, p.failures === 0, p.failures).then((markFailed) =>
          setQuality({ phase: 'done', message: t('apps.qualityNoConclusion'), clean: p.failures === 0, findings: p.failures, markFailed }))
      }, 10 * 60 * 1000)
    })()
  }, [autoQuality, api, agentConvId, app.id, app.name, app.quality, check, send, markQuality, lang])

  // ---- 自动质检：轮次结束 → 解析结论 → 落标记 ----
  useEffect(() => {
    if (agentStreaming) { qualityStreamSeenRef.current = true; return }
    const p = qualityPendingRef.current
    if (!p || !qualityStreamSeenRef.current) return          // 还没观察到开跑，不算结束
    qualityPendingRef.current = null
    qualityStreamSeenRef.current = false
    if (qualityTimerRef.current) { clearTimeout(qualityTimerRef.current); qualityTimerRef.current = null }
    const verdict = extractQualityVerdict(lastAssistantText(agentConvId || ''))
    // 没收到结构化结论时**退回试跑结果**记录（不编造"已通过"），文案上也说清
    const findings = verdict.hasJson ? verdict.findings : p.failures
    const clean = findings === 0
    void markQuality(p.fingerprint, clean, findings).then((markFailed) => {
      setQuality({
        phase: 'done',
        clean,
        findings,
        message: !verdict.hasJson
          ? t('apps.qualityNoConclusion')
          : clean ? t('apps.qualityPassed') : t('apps.qualityFound', { n: findings }),
        markFailed,
      })
      onQualityDoneRef.current?.()
    })
  }, [agentStreaming, agentConvId, markQuality, lang])   // 原为 t：不稳定引用会让此 effect 每帧重跑

  // 卸载清掉质检兜底计时器（组件走了还留着定时器等于内存泄漏 + 可能写已关闭页面的 state）
  useEffect(() => () => { if (qualityTimerRef.current) clearTimeout(qualityTimerRef.current) }, [])

  // 质检进行中**强制回 agent**：否则用户停在"命令"页看不到任何输出，以为功能坏了
  const qualityActive = quality?.phase === 'verifying' || quality?.phase === 'running'
  const shownTab: AppsTab = qualityActive ? 'agent' : tab

  const onTabChange = useCallback((v: string) => {
    const safe = sanitizeAppsTab(v)
    setTab(safe)
    writeAppsTab(app.id, safe)
  }, [app.id])

  function setArg(action: string, name: string, value: string) {
    setArgValues((prev) => ({ ...prev, [action]: { ...(prev[action] || {}), [name]: value } }))
  }

  async function execute(cmd: AppSpecCommand) {
    setPending(null)
    setRunning(cmd.action)
    setResult(null)
    try {
      const r = await api?.appRun?.({ appId: app.id, action: cmd.action, args: argValues[cmd.action] || {}, sessionId: sessionId || undefined })
      setResult({ action: cmd.action, r: r as AppRunResult })
    } catch (e) {
      setResult({ action: cmd.action, r: { ok: false, data: null, error: String((e as Error)?.message || e), kind: cmd.kind, durationMs: 0 } })
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-subtle">
        <Button size="sm" variant="ghost" onClick={onBack} title={t('apps.back')}>
          <ArrowLeft className="w-3.5 h-3.5" />
        </Button>
        <h2 className="text-xs font-semibold text-primary truncate">{app.name || app.id}</h2>
        <span className="text-[10px] text-tertiary font-mono truncate">{spec?.driver || ''}</span>
        <div className="flex-1" />
        {/* 手工执行命令的次级入口（P1 面板降级）：控制台以 agent 运行为主，命令执行仍可用但不再占主标签。
            放在页头而非标签条，是为了让"以 agent 为主"在视觉上成立——它是一条退路，不是主路径。
            激活态与 shownTab 同步（点开时高亮、"返回"式再点一次回到自检页）。 */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onTabChange(shownTab === 'commands' ? 'diagnose' : 'commands')}
          title={t('apps.manualCommandsHint')}
          aria-pressed={shownTab === 'commands'}
          className={shownTab === 'commands' ? 'text-primary bg-active' : 'text-tertiary'}
          data-testid="app-manual-commands"
        >
          <Terminal className="w-3.5 h-3.5" />
          <span className="text-[10px] ml-1">{t(TAB_META.commands.labelKey)}</span>
        </Button>
        {sessionId ? (
          <span className="flex items-center gap-1 text-[10px] text-success" title={t('apps.aiBoundHint')}>
            <ShieldCheck className="w-3.5 h-3.5" />
            {bound ? t('apps.aiBound') : '…'}
          </span>
        ) : (
          <span className="text-[10px] text-tertiary" title={t('apps.noSession')}>—</span>
        )}
      </div>

      {/* 主标签条：只渲染 agent / diagnose（commands 已降级为页头入口，见 PRIMARY_TABS 注释）*/}
      <Tabs value={shownTab} onValueChange={onTabChange}>
        <TabsList className="w-full justify-start gap-0.5 px-2 h-9 rounded-none bg-transparent p-0 border-b border-subtle">
          {PRIMARY_TABS.map((v) => {
            const meta = TAB_META[v]
            const label = t(meta.labelKey)
            return (
              <Tooltip key={v} content={t(meta.hintKey)} side="bottom">
                <TabsTrigger
                  value={v}
                  aria-label={label}
                  className="clip-sm h-[22px] rounded-none px-2.5 text-[11px] font-medium text-tertiary hover:text-secondary data-[state=active]:bg-active data-[state=active]:text-primary data-[state=active]:shadow-none"
                >
                  {label}
                </TabsTrigger>
              </Tooltip>
            )
          })}
        </TabsList>
      </Tabs>

      {/* 质检状态条：每条状态都可见（进行中/已通过/发现 N 个问题/标记失败） */}
      {quality && (
        <div className={cn(
          'flex flex-col gap-1 px-4 py-1.5 shrink-0 border-b text-[10px]',
          quality.phase === 'done' && quality.clean ? 'border-subtle bg-success/10 text-success'
            : quality.phase === 'error' ? 'border-subtle bg-error/10 text-error'
              : quality.phase === 'done' ? 'border-subtle bg-warning/10 text-warning'
                : 'border-subtle bg-input text-secondary',
        )}>
          <div className="flex items-center gap-1.5">
            {qualityActive ? <Loader2 className="w-3 h-3 animate-spin" />
              : quality.phase === 'done' && quality.clean ? <CheckCircle2 className="w-3 h-3" />
                : <AlertTriangle className="w-3 h-3" />}
            <span>
              {quality.phase === 'verifying' ? t('apps.qualityVerify')
                : quality.phase === 'running' ? t('apps.qualityRunning')
                  : quality.message}
            </span>
          </div>
          {quality.phase === 'done' && quality.markFailed && (
            <div className="text-warning">{quality.markFailed}</div>
          )}
          {/* 试跑失败明细：真实 action + 真实报错（"哪里坏了"不能只留在 AI 上下文里） */}
          {!qualityActive && verifyFailures.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="text-warning">{t('apps.qualityVerifyFail', { n: verifyFailures.length })}</div>
              {verifyFailures.slice(0, 6).map((f) => (
                <div key={f.action} className="font-mono text-tertiary break-all">{f.action}：{f.error}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- agent 树：**常挂**（切走只 hidden，丢流式/滚动状态不可接受）---- */}
      <div className={cn('flex-1 min-h-0 flex-col', shownTab === 'agent' ? 'flex' : 'hidden')}>
        {agentConvId ? (
          <>
            <div className="flex-1 flex min-h-0">
              <div className="flex-1 min-w-0 flex flex-col">
                <ChatWindow conversationId={agentConvId} />
              </div>
            </div>
            {pendingQuestion && (
              <FloatingQuestionCard
                conversationId={agentConvId}
                // 新问题到达（载荷对象替换）时强制重挂载，清空旧卡的选择/备注状态
                cardKey={`${agentConvId}:${pendingQuestion.questions.map((q) => `${q.id}|${q.question.slice(0, 24)}`).join('&') || 'raw'}`}
                payload={pendingQuestion}
                onAnswer={(response) => {
                  sendAnswer(agentConvId, response.answers, response.notes)
                  clearPendingQuestion(agentConvId)
                }}
                onDismiss={() => {
                  clearPendingQuestion(agentConvId)
                  // 通知桥接端广播"提问已处理"，外部监听者撤销提问提示
                  dismissQuestion(agentConvId)
                }}
              />
            )}
            <ChatInput conversationId={agentConvId} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center gap-2 text-tertiary text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />{t('apps.agentPreparing')}
          </div>
        )}
      </div>

      {/* ---- diagnose 树：自检结论 / 能力清单 / 评审 / 登录 / 修复（一次只挂这一棵）---- */}
      {shownTab === 'diagnose' && (
        <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
          {/* 控制命令覆盖率（P1）：把"全量控制命令覆盖到多少 / 缺哪些"摆在自检结论旁，
              因为这两个是同一类问题——"这个应用现在到底能不能被好好控制"。 */}
          <AppCoverage appId={app.id} />
          {/* 自检结果 */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            {checking ? (
              <span className="flex items-center gap-1 text-tertiary"><Loader2 className="w-3.5 h-3.5 animate-spin" />{t('apps.checking')}</span>
            ) : check?.status === 'healthy' ? (
              <span className="flex items-center gap-1 text-success"><CheckCircle2 className="w-3.5 h-3.5" />{t('apps.checkOk')}</span>
            ) : check?.status === 'drifted' ? (
              <span className="flex items-center gap-1 text-warning"><AlertTriangle className="w-3.5 h-3.5" />{t('apps.checkDrift')}</span>
            ) : (
              <span className="flex items-center gap-1 text-error"><AlertTriangle className="w-3.5 h-3.5" />{t('apps.checkBroken')}</span>
            )}
            <Button size="sm" variant="ghost" onClick={() => void runCheck()}>{t('apps.recheck')}</Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setEditing(true); onTabChange('commands') }}
            >
              <Settings2 className="w-3 h-3" />{t('apps.editSpec')}
            </Button>
            {/* 登录入口：自动化窗口是隐藏的，没有它就无处可登录；登录后命令与模型探索都带上该登录态 */}
            {spec?.target?.type === 'web' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={loggingIn}
                title={t('apps.loginHint')}
                onClick={() => void openLogin()}
              >
                {loggingIn ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />}
                {t('apps.login')}
              </Button>
            )}
            {(check?.status === 'drifted' || check?.status === 'broken' || (check?.issues?.length ?? 0) > 0) && (
              <Button size="sm" variant="ghost" disabled={repairing || check?.status === 'broken'}
                title={check?.status === 'broken' ? t('apps.repairBroken') : undefined}
                onClick={() => void onRepair()}>
                {repairing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}{t('apps.repair')}
              </Button>
            )}
          </div>
          {!!check?.issues?.length && (
            <ul className="flex flex-col gap-1 px-3 py-2 rounded bg-warning/10">
              {check.issues.map((i, idx) => <li key={idx} className="text-[10px] text-warning">{i}</li>)}
            </ul>
          )}

          {/* 接入路径（能力清单，M5）：三段与后端 renderSurfaceReport 一一对应——
              已实测 / 待确认 / 已排除。三分措辞由 VERDICT_COPY 统一供给，
              weak（证据不足）不得被降级说成不可接入——该措辞协议由 src/lib/appSurface.test.ts 钉住。 */}
          <div className="rounded-lg border border-subtle bg-elevated p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">接入路径（能力清单）</span>
              {surface && (
                <span className={
                  surface.verdict === 'connectable' ? 'text-[9px] px-1 py-0.5 rounded bg-success/20 text-success'
                    : surface.verdict === 'weak' ? 'text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning'
                      : 'text-[9px] px-1 py-0.5 rounded bg-error/20 text-error'
                }>{VERDICT_COPY[surface.verdict].label}</span>
              )}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" disabled={probing} onClick={() => void onProbeSurface()}>
                {probing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />}
                探测接入路径
              </Button>
            </div>
            <div className="text-[10px] text-secondary">{summarizeSpec(spec)}</div>
            {surface && <p className="text-[10px] text-secondary">{VERDICT_COPY[surface.verdict].detail}</p>}
            {probeMsg && <div className="text-[10px] text-warning">{probeMsg}</div>}
            {!surface && !probeMsg && (
              <p className="text-[10px] text-tertiary">点「探测接入路径」查看该应用有哪些可控通道、各自的证据与下一步（探测会真实访问目标，可能需要几秒）。</p>
            )}
            {surface && (() => {
              const g = groupCapabilities(surface)
              const Section = ({ title, items, tone }: { title: string; items: typeof g.verified; tone: string }) => (
                items.length === 0 ? null : (
                  <div className="flex flex-col gap-0.5">
                    <div className={`text-[10px] ${tone}`}>{title}</div>
                    {items.map((c) => (
                      <div key={c.channel} className="text-[10px] text-secondary">
                        <span className="font-mono">{c.channel}</span>
                        {c.driver ? <span className="text-tertiary">{` → ${c.driver}`}</span> : null}
                        {'：'}{c.label}
                        {c.evidence ? <span className="text-tertiary">{'（'}{c.evidence}{'）'}</span> : null}
                        {c.next ? <div className="text-tertiary pl-3">下一步：{c.next}</div> : null}
                      </div>
                    ))}
                  </div>
                )
              )
              return (
                <>
                  <Section title="已实测可用" items={g.verified} tone="text-success" />
                  <Section title="待进一步确认（证据不足，尚不能断言可行）" items={g.probable} tone="text-warning" />
                  <Section title="已排查且不成立" items={g.dead} tone="text-tertiary" />
                </>
              )
            })()}
          </div>

          {/* 评审结论（M4 写入 spec.review）：质量结论在面板上要看得见，而不是只留在生成过程里 */}
          {reviewText && (
            <div className="px-3 py-2 rounded bg-input text-[10px] text-secondary">{reviewText}</div>
          )}

          {/* 登录反馈：无论成功失败都要说清（登录态探索依赖它） */}
          {loginMsg && (
            <div className="px-3 py-2 rounded bg-info/10 text-[10px] text-secondary">{loginMsg}</div>
          )}

          {/* 修复结果：改动明细必须展示出来，不能"修了但不说改了啥" */}
          {repair && (
            <div className={'rounded-lg border p-3 flex flex-col gap-1.5 ' + (repair.ok ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10')}>
              <div className={'text-[11px] ' + (repair.ok ? 'text-success' : 'text-warning')}>
                {repair.ok
                  ? t('apps.repairDone', { n: repair.repaired.length })
                  : (repair.reason || t('apps.repairNone'))}
              </div>
              {repair.ok && !!repair.repaired.length && (
                <div className="flex flex-col gap-0.5">
                  <div className="text-[10px] text-tertiary">{t('apps.repairDetail')}</div>
                  {repair.repaired.map((x) => (
                    <div key={x.action} className="text-[10px] text-secondary">
                      <span className="font-mono">{x.action}</span>
                      {'：'}{x.from.title || '(无标题)'}{' → '}{x.to.title || '(无标题)'}
                      <span className="text-tertiary">{'（'}{x.reason}{'）'}</span>
                    </div>
                  ))}
                </div>
              )}
              {!!repair.failed.length && (
                <div className="text-[10px] text-warning">
                  {t('apps.repairFailed', { n: repair.failed.length })}
                  {'：'}{repair.failed.map((f) => `${f.action}（${f.reason}）`).join('；')}
                </div>
              )}
              {repair.backup && <div className="text-[10px] text-tertiary">{t('apps.repairBackup', { name: repair.backup })}</div>}
              {!repair.ok && <div className="text-[10px] text-tertiary">{t('apps.repairNotRun')}</div>}
            </div>
          )}
          {!sessionId && <div className="text-[10px] text-tertiary">{t('apps.noSession')}</div>}
          {/* 清网提示：agent 标签才是"直接给这个应用下指令"的地方，避免用户在命令页找对话入口 */}
          <div className="flex items-center gap-1 text-[10px] text-tertiary">
            <Sparkles className="w-3 h-3" />{t('apps.tabAgentHint')}
          </div>
        </div>
      )}

      {/* ---- commands 树：命令列表 / 参数 / 执行结果 / Spec 编辑与写操作二次确认 ---- */}
      {shownTab === 'commands' && (
        <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
          <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">{t('apps.commands')}</div>
          {commands.length === 0 ? (
            <p className="text-[11px] text-tertiary">{t('apps.noCommands')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {commands.map((cmd) => (
                <div key={cmd.action} className="rounded-lg bg-elevated border border-subtle p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-primary">{cmd.title || cmd.action}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary font-mono">{cmd.action}</span>
                    <span className={cmd.kind === 'write' ? 'text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning' : 'text-[9px] px-1 py-0.5 rounded bg-input text-tertiary'}>
                      {cmd.kind}
                    </span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-input text-tertiary font-mono" title="这条命令的执行后端">
                      {spec?.driver || '—'}
                    </span>
                    <div className="flex-1" />
                    <Button size="sm" variant={cmd.kind === 'write' ? 'secondary' : 'primary'}
                      disabled={running !== null}
                      onClick={() => (cmd.kind === 'write' ? setPending(cmd) : void execute(cmd))}>
                      {running === cmd.action ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      {cmd.kind === 'write' ? t('apps.runWrite') : t('apps.runRead')}
                    </Button>
                  </div>
                  {!!cmd.params?.length && (
                    <div className="flex flex-col gap-1.5">
                      {cmd.params.map((p) => (
                        <div key={p.name} className="flex items-center gap-2">
                          <span className="text-[10px] text-secondary w-28 shrink-0 truncate">
                            {p.name}{p.required ? ' *' : ''}
                          </span>
                          <Input
                            value={argValues[cmd.action]?.[p.name] ?? ''}
                            onChange={(e) => setArg(cmd.action, p.name, e.target.value)}
                            placeholder={p.desc || p.type || ''}
                            className="h-6 text-[11px] flex-1"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 结果 */}
          {result && (
            <div className="flex flex-col gap-1">
              <div className="text-[11px] font-semibold text-tertiary uppercase tracking-wider">{t('apps.result')}</div>
              <div className={`rounded border p-2 text-[11px] font-mono whitespace-pre-wrap break-all ${result.r.ok ? 'border-subtle text-primary' : 'border-error/40 text-error'}`}>
                {result.r.ok
                  ? (typeof result.r.data === 'string' ? result.r.data : JSON.stringify(result.r.data, null, 2))
                  : result.r.error}
              </div>
              <div className="text-[10px] text-tertiary">{t('apps.duration')} {result.r.durationMs}ms</div>
            </div>
          )}

          {/* Spec 编辑（保存后重跑自检） */}
          {editing && (
            <SpecEditor appId={app.id} appName={app.name}
              onClose={() => setEditing(false)}
              onSaved={() => void runCheck()} />
          )}

          {/* 写操作二次确认（写操作会在目标应用产生真实改动） */}
          {pending && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[11px] text-warning">
                <AlertTriangle className="w-3.5 h-3.5" />
                {t('apps.writeConfirm')}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPending(null)}>{t('apps.cancel')}</Button>
                <Button size="sm" variant="danger" onClick={() => void execute(pending)}>{t('apps.confirm')}</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
