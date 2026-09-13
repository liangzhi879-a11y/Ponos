// 上下文失真 GUI 渲染验证（手动运行，不属 npm test —— 需要 electron 与图形会话）
// ---------------------------------------------------------------------------
//   node scripts/verify-gui-fidelity.mjs
// 目的：把 Task 6 的**核心语义**在真实 DOM 里验掉，而不是只在代码里"看起来对"：
//   ① 失真红 → 证据卡出现（逐条证据 + 两级动作按钮）
//   ② 失真琥珀 → 只有角标、不弹卡（不打扰）
//   ③ 压力红 + 失真绿 → 血条变红但**无角标无卡**（两轴严禁互相赋值）
//   ④ 老内核（无 distortion 字段）→ 无角标无卡（向后兼容）
// 做法：esbuild 打包"真组件 + 真 store"，electron 无头加载，读回 computed style 与 innerText。
// 临时文件全部生成在系统 temp 目录，不污染仓库。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(findNodeModules(REPO_ROOT), 'electron', 'dist', 'electron.exe')
const TMP = mkdtempSync(join(tmpdir(), 'yfw-gui-verify-'))
/** 截图输出目录（放 release/ 下，仓库 gitignore，便于人工眼见为实） */
const SHOT_DIR = process.env.GUI_VERIFY_SHOT_DIR || join(REPO_ROOT, 'release', '_gui-fidelity-shots')

/** 取构建产物里的 CSS（组件用到的类与主题令牌都在其中）
 *  可用 GUI_VERIFY_CSS_DIR 指向别的 dist（如调试版 release/YFWorking/dist），
 *  验证"调试版 CSS 下布局类同样生效"。 */
function builtCssPath() {
  const dir = process.env.GUI_VERIFY_CSS_DIR || join(REPO_ROOT, 'dist', 'assets')
  const css = readdirSync(dir).filter((f) => f.endsWith('.css'))
  if (!css.length) throw new Error(`未找到 ${dir}/*.css —— 请先 npm run build`)
  return join(dir, css[0])
}

// ---- 夹具（与 kernel/fidelity.mjs 下发的形状一致） ----
const issue = (i, axis, kind, strength) => ({
  id: `${axis[0]}:${kind}:${i}`, axis, kind, strength, turn: i, evidence: `证据 ${i}：引用了已删除的 src/f${i}.ts`, at: '2026-09-12T00:00:00.000Z',
})
const dist = (tier, issues, extra = {}) => ({
  score: tier === 'green' ? 0 : tier === 'amber' ? 45 : 85,
  tier, axes: { memory: tier === 'green' ? 0 : 40, coherence: tier === 'green' ? 0 : 60, goal: 0 },
  issues, trigger: issues.length ? issues[0].id : null, observeUntilTurn: null,
  anchorAvailable: tier === 'red', ...(tier === 'red' ? { anchorText: '【上下文锚定·权威事实】\n■ 原始任务 实现删除交互\n■ 硬约束 不改动 API 契约' } : {}), ...extra,
})
const pressure = (tier) => ({ score: tier === 'red' ? 90 : 10, tier, compactCount: tier === 'red' ? 2 : 0, remainingPct: tier === 'red' ? 9 : 60, remainingTurns: tier === 'red' ? 158 : 900, suggestNewSession: tier === 'red', reason: '压力档' })

const CASES = [
  { key: 'red-distortion', desc: '失真红（3 条证据）+ 压力绿', health: { ...pressure('green'), distortion: dist('red', [issue(1, 'coherence', 'stale_ref', 'strong'), issue(2, 'memory', 'summary_missing', 'strong'), issue(3, 'goal', 'drift', 'medium')]) } },
  { key: 'amber-distortion', desc: '失真琥珀（2 条证据）+ 压力绿', health: { ...pressure('green'), distortion: dist('amber', [issue(1, 'coherence', 'stale_ref', 'medium'), issue(2, 'coherence', 'contradiction', 'medium')]) } },
  { key: 'red-pressure-only', desc: '压力红 + 失真绿（关键：不得弹卡/角标）', health: { ...pressure('red'), distortion: dist('green', []) } },
  { key: 'legacy-no-distortion', desc: '老内核：完全无 distortion 字段', health: pressure('green') },
  {
    key: 'recurred-distortion', desc: '同源复发（此前处理过 → 应重现并提示升级）',
    health: { ...pressure('green'), distortion: dist('red', [{ ...issue(1, 'coherence', 'stale_ref', 'strong'), recurred: true }]) },
    // 模拟"用户已处理过该证据"：首次抑制键已登记（复发态用 #recurred 键，故仍应弹卡）
    shownIds: ['c:stale_ref:1'],
  },
  {
    key: 'recurred-twice-distortion', desc: '第二次复发（首次+第一次复发都处理过 → 仍应提醒）',
    health: { ...pressure('green'), distortion: dist('red', [{ ...issue(1, 'coherence', 'stale_ref', 'strong'), recurred: true, recurredCount: 2 }]) },
    // 首次与第一次复发的键都已登记：抑制键须含次数（#recurred2）才能再提醒
    shownIds: ['c:stale_ref:1', 'c:stale_ref:1#recurred1'],
  },
]

// ---- 等待态常显条用例（T8，2026-09-12 卡在思考界面事故）----
// 验的是本次事故的**直接现象**：内核静默时 UI 只有静态「思考中…」。旧出口
//（RightStatusRail）限 task 模式、默认折叠、秒数只在 hover tooltip 里。
const GREEN_HEALTH = { ...pressure('green'), distortion: dist('green', []) }
const WAIT_CASES = [
  { key: 'wait-firstbyte', desc: '首字节等待 5s → 常显条带秒数（无需 hover）', wait: { firstByteMs: 5000 } },
  { key: 'wait-stall', desc: '内核失速 96s → 告警色 + 秒数', wait: { stallMs: 96_000 } },
  { key: 'wait-approval', desc: '等审批 → 常显且不带秒数（等的是人）；他会话审批不得串台', wait: { approval: true } },
  { key: 'wait-question', desc: '等回答 → 常显且不带秒数', wait: { question: true } },
  { key: 'wait-compact', desc: '压缩中 → 常显（无时间基准故无秒数）', wait: { compacting: true } },
  { key: 'wait-none', desc: '无等待态 → 不占位（元素不存在）', wait: {} },
  { key: 'wait-priority', desc: '多态并存 → 只出优先级最高的一条（失速 > 首字节）', wait: { stallMs: 96_000, firstByteMs: 5000 } },
  { key: 'wait-after-close', desc: '内核已死复位 → 等待条/提问卡/审批弹窗不得残留', wait: { firstByteMs: 5000, question: true, approval: true }, clearFirst: true },
  // 终态复位（error/cancelled/closed → clearSessionWaitState）也必须清压缩指示：exception 收尾
  // 恰是最容易丢 done 帧的场景，此前该路径够不到这个镜像（cancelled/closed 靠各自内联补丁）。
  { key: 'wait-compact-clear', desc: '内核终态复位 → 悬挂的压缩指示必须一并清除', wait: { compacting: true, compactingSinceAgoMs: 21 * 60 * 1000 }, clearFirst: true },
  // 压缩指示常驻收口（2026-09-13）：done 帧丢一次即常驻 ⇒ 兜底必须复位**陈旧**指示，
  // 且**不得误清**仍在跑的新压缩。哨兵取真实判定用的数据（21min > 20min 上限；1min 远小）。
  { key: 'wait-compact-stale', desc: '压缩指示挂起 21min（超兜底上限）→ 巡检复位，条必须消失', wait: { compacting: true, compactingSinceAgoMs: 21 * 60 * 1000 }, sweepFirst: true },
  { key: 'wait-compact-fresh', desc: '压缩指示挂起 1min（未超上限）→ 巡检不得误清', wait: { compacting: true, compactingSinceAgoMs: 60 * 1000 }, sweepFirst: true },
]
for (const c of WAIT_CASES) CASES.push({ ...c, health: GREEN_HEALTH })

// ---- 提问卡到达即展开（2026-09-13：提问帧投递可见性）----
// 验的是 9 次提问里 3 次等满内核 600s 超时的**直接形态**：卡片默认折叠成输入栏上方的小
// chip，配合等待条那句静止的"等待你的回答"，用户整段错过。真源：载荷替换（新问题）必须
// 展开；同一条提问的 WS 重连 hello 重放**不得**把用户手动收起的卡再弹开（cardKey 稳定）。
const QCARD_TEXT = '要继续吗？'
// cardKey 与 WorkShell.tsx:207 同形（`${convId}:${q.id}|${q.question.slice(0,24)}`）——
// 一致性正是这条用例的被测点：同一提问重放时 key 必须逐字符相同，才会走「不重挂载」分支。
const QCARD_FIX = {
  key: `c1:q1|${QCARD_TEXT.slice(0, 24)}`,
  context: '',
  questions: [{
    id: 'q1',
    header: '确认',
    question: QCARD_TEXT,
    options: [{ label: '继续', description: '按原计划继续' }, { label: '停止', description: '停下来等你' }],
    multiSelect: false,
  }],
}
const QCARD_CASES = [
  { key: 'qcard-new', desc: '新提问到达 → 默认展开（不得只留折叠 chip）', qcard: QCARD_FIX },
  { key: 'qcard-replay', desc: '同一提问 hello 重放 → 不得把用户收起的卡再弹开', qcard: QCARD_FIX, replayQcard: true },
]
for (const c of QCARD_CASES) CASES.push({ ...c, health: GREEN_HEALTH })

// ---- R6 长列表 containment（2026-09-13）----
// 本脚本此前**没有任何 timing**。这条用例补两件在别处验不了的事：
//   ① **接线**：长会话时滚动容器必须真的拿到 `.msg-contain`。组件是 `.tsx`，而 Node 的类型
//      擦除不认 `.tsx`（`Unknown file extension`）⇒ `npm test` 结构上够不着这一行，只能在这儿验。
//   ② **量化**：两臂 DOM **逐字节相同**，只改 store 里上报的 `messageCount`（59 ⇒ 不挂类），
//      差的就是那一个类带来的排版开销。量的是"内容变化后强制重排"——与 R6 立项时的 Electron
//      探针同一个操作（探针：400 条 0.311ms → 0.003ms；探针是手搓 DOM，这里是**真 ChatWindow**）。
const CHAT_COUNT = 200
CASES.push(
  { key: 'chat-long-contained', desc: `长会话 ${CHAT_COUNT} 条 · 上报条数 ≥60 ⇒ containment 生效`, chat: { count: CHAT_COUNT, reportedCount: CHAT_COUNT }, health: GREEN_HEALTH },
  { key: 'chat-long-baseline', desc: `长会话 ${CHAT_COUNT} 条 · 上报条数 <60 ⇒ 对照（DOM 相同，仅少一个类）`, chat: { count: CHAT_COUNT, reportedCount: 59 }, health: GREEN_HEALTH },
)

// ---- 生成 harness（真组件 + 真 store，按键位夹具渲染） ----
const harness = `
import { createRoot } from 'react-dom/client'
import { HealthMeter } from '@/components/chat/HealthMeter'
import { HealthSuggestCard } from '@/components/chat/HealthSuggestCard'
import { HealthGlow } from '@/components/chat/HealthGlow'
import { WaitStatusBar } from '@/components/chat/WaitStatusBar'
import { FloatingQuestionCard } from '@/components/chat/FloatingQuestionCard'
import { ChatWindow } from '@/components/chat/ChatWindow'
import { TooltipProvider } from '@/components/ui'
import { useHealthStore } from '@/stores/healthStore'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { staleCompactionSids } from '@/lib/compactIndicator'

// 主题类挂在 <html> 上（themes.css 的 .theme-dark 等定义 --health-tier-* 等令牌），
// 不设主题则所有主题变量未定义 → 颜色解析为透明、泛光 box-shadow 失效（测量假阴性）。
document.documentElement.className = 'theme-dark'
const FIXTURES = window.__FIXTURES__ || []
const el = document.getElementById('root')
const root = createRoot(el)

// 页内切换夹具（避免把大 JSON 塞进 file:// 的 query —— 那样会 ERR_FAILED）
window.__render = (i) => {
  const fx = FIXTURES[i]
  useHealthStore.setState({
    healthBySession: { c1: fx.health },
    summaryCompactCountBySession: { c1: 0 },
    dismissedUntilBySession: {},
    distortionShownIdsBySession: { c1: fx.shownIds || [] },
    dismissedDistortionUntilBySession: {},
  })
  // 等待态夹具（T8）：字段缺省即"无等待"。审批刻意混入一个他会话的条目，
  // 验"按 sessionId 过滤"——A 会话的审批不得在 B 会话显示。
  const w = fx.wait || {}
  useUIStore.setState({
    kernelStalls: w.stallMs ? { c1: w.stallMs } : {},
    firstByteWait: w.firstByteMs ? { c1: w.firstByteMs } : {},
  })
  useChatStore.setState({
    pendingPermissions: w.approval
      ? [
          { id: 'p1', sessionId: 'c1', action: 'bash', target: 'rm -rf /tmp/x', risk: 'high', timestamp: 0 },
          { id: 'p2', sessionId: 'other', action: 'bash', target: 'ls', risk: 'low', timestamp: 0 },
        ]
      : [],
    pendingQuestions: w.question ? { c1: { context: '', questions: [] } } : {},
    compactingBySession: w.compacting ? { c1: true } : {},
    // 压缩起始时刻（2026-09-13 收口）：兜底巡检按它判新旧；缺省 = 无时间基准（判陈旧）
    compactingSinceBySession: w.compactingSinceAgoMs ? { c1: Date.now() - w.compactingSinceAgoMs } : {},
  })
  // R6 长列表用例：真 ChatWindow + 真 store。消息按真实形态造（助手消息带多段正文与
  // 行内 code，用户消息短）——高度差本身就是被测量的一部分（containment 的代价与收益都来自它）。
  if (fx.chat) {
    // 正文长度按**应用形态**造：助手条目明显高于 120px 的估算值（实测真实均值 ~113px 的
    // 短正文会让估算反而偏大，"离屏按估算计高"的方向就反了——估算误差的方向取决于夹具）。
    // 注意：本段是**外层模板字符串**的正文，换行转义必须写双反斜杠、反引号必须转义——
    // 否则生成的 harness.tsx 里是**真换行**（单引号字符串跨行 ⇒ SyntaxError），
    // 或提前闭合外层模板（2026-09-13 两种都实际踩过）。
    const mk = (i) => ({
      id: 'm' + i,
      role: i % 4 === 0 ? 'user' : 'assistant',
      timestamp: 1757000000000 + i * 1000,
      content: [{
        type: 'text',
        id: 'b' + i,
        content: i % 4 === 0
          ? '看一下这个。'.repeat(1 + (i % 2))
          : [
              '第 ' + i + ' 条正文：这里是一段会折行的说明文字，用来撑出真实高度——离屏条目的真实高度要明显超过 contain-intrinsic-size 的估算值（120px），否则"离屏按估算计高"这条证据的方向会反过来。',
              '要点 ' + (i % 7) + '：先把目标、范围、产出写清楚，验收标准要能一条条勾；不要顺手扩大范围。接下来按顺序执行，每步结束回报一次进展；需要决策的地方停下来问。',
              '排查记录：入口在 kernel/cli.mjs，桥在 server/bridge.mjs，渲染层在 src/components/chat/。先把可复现的最小样本固定下来，再逐层加日志，避免在噪声里猜。',
              '结论与下一步：把上面的观察写成可验证的断言，再决定是否改代码；每一步都要能单独回退，避免把两处改动混在一起导致归因不清。',
              '补充说明：长会话下滚动条的估算误差会累计，观感是否可接受要看真实任务形态；不能接受就把阈值调高或去掉这个类（一行改动）。',
            ].join('\\n\\n'),
      }],
    })
    useChatStore.setState({
      conversations: [{
        id: 'c1', mode: 'task', cwd: '', messageCount: fx.chat.reportedCount,
        messages: Array.from({ length: fx.chat.count }, (_, i) => mk(i)),
      }],
      streamingConversations: {},
      pendingPermissions: [],
      pendingQuestions: {},
      compactingBySession: {},
    })
    root.render(
      <TooltipProvider>
        {/* 必须给出真正的**高度链**：ChatWindow 根是 flex-1 flex-col min-h-0，父层若只是块级
            容器，flex-1 不生效 ⇒ 滚动区被内容撑高（实测 clientHeight === scrollHeight 24700px，
            根本没在滚），量到的就不是应用里的那个滚动容器。display:flex + 固定高度 = 应用形态。 */}
        <div style={{ width: 900, height: 520, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
          <ChatWindow conversationId="c1" />
        </div>
      </TooltipProvider>,
    )
    return
  }
  root.render(
    // 与真实应用一致：Tooltip 必须在 TooltipProvider 内（App.tsx 根部提供）。
    // 卡片是 absolute bottom-full（悬浮在输入框上方）→ 外层留出上方空间，否则截图拍到视口外。
    <TooltipProvider>
      {/* 等待态常显条（T8）：真实应用里内联在消息滚动区与输入区之间（不悬浮不遮挡）。
          放最上方是为了截图取得到——放底部会被视口切掉。 */}
      <div style={{ width: 800, marginLeft: 40, marginTop: 12, background: 'var(--bg-primary)' }}>
        <WaitStatusBar conversationId="c1" />
      </div>
      <div className="relative" style={{ width: 800, height: 200, marginTop: 300, marginLeft: 40 }}>
        <HealthGlow conversationId="c1" />
        <HealthMeter conversationId="c1" />
        <HealthSuggestCard conversationId="c1" onAnchorApplied={() => {}} onStopSource={() => {}} />
      </div>
      {/* 提问卡（2026-09-13）：真实应用里挂在 ChatWindow 与输入栏之间的悬浮层（WorkShell.tsx:200）。
          payload 每次渲染都新建对象（与线上一致：hello 重放时 store 里是新对象），
          故"重放不弹开"只能靠 cardKey 稳定 + React 不重挂载——正是被测的不变量。 */}
      {fx.qcard && (
        <div style={{ width: 800, marginTop: 24, marginLeft: 40, background: 'var(--bg-primary)' }}>
          <FloatingQuestionCard
            conversationId="c1"
            cardKey={fx.qcard.key}
            payload={{ questions: fx.qcard.questions, context: fx.qcard.context }}
            onAnswer={() => {}}
            onDismiss={() => {}}
          />
        </div>
      )}
    </TooltipProvider>,
  )
}

// 内核已死路径的镜像复位（与 useYFWCLI.clearSessionWaitState 的五个镜像一致）：
// 用于验"内核被杀后等待条/提问卡/审批弹窗/压缩指示不得残留"。
window.__clearWait = () => {
  useUIStore.getState().clearKernelStall('c1')
  useUIStore.getState().clearFirstByteWait('c1')
  useChatStore.getState().setCompacting('c1', false)
  useChatStore.getState().clearPendingQuestion('c1')
  useChatStore.getState().clearPermissionsForSession('c1')
}
window.__render(0)
// 压缩指示兜底巡检的镜像（与 useYFWCLI.sweepStaleCompaction 同一份判定：真实纯函数
// staleCompactionSids + 真实 store 动作）。验的是本次事故的可观测语义：
// done 帧丢失后指示条不得常驻，而仍在跑的新压缩不得被误清。
window.__sweepCompaction = () => {
  const store = useChatStore.getState()
  for (const sid of staleCompactionSids(store.compactingBySession, store.compactingSinceBySession, Date.now())) {
    store.setCompacting(sid, false)
  }
}
`
// 折叠头点击脚本：**必须经 JSON.stringify 注入**。直接写进 main.cjs 的模板字符串里，
// `\n` 会在这一层就被展开成真换行 ⇒ 生成的单引号字符串跨行 ⇒ SyntaxError（electron
// 加载失败后**不退出**，脚本表现为无限等待）。2026-09-13 实际踩过，故此处显式序列化。
const QCARD_CLICK_JS = `(() => {
  const w = document.querySelector('[data-qcard-state="expanded"]')
  if (!w) return false
  const btn = [...w.querySelectorAll('button')].find(b => (b.textContent || '').includes('待回答问题'))
  if (!btn) return false
  btn.click()
  return true
})()`

// R6 长列表用例的量测脚本。滚动/让步在**计时之外**，每个计时循环**整段同步**跑完：
// 中间一旦让出事件循环，浏览器自己先排完版，读数就失真（探针 v3 第一版正是这么废掉的）。
// 同样经 JSON.stringify 注入（模板字符串会吃掉反斜杠与反引号）。
const CHAT_BENCH_JS = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  const all = [...document.querySelectorAll('[data-message-id]')]
  // 外层的 data-message-id 是 ChatWindow 自己挂的（HistoryView 跳转定位用）；assistant-ui 的
  // MessagePrimitive.Root 会**再挂一个**（同一 id），故节点数是消息数的两倍——数外层才是
  // "渲染了几条消息"，也才是 CSS 规则命中的那批（嵌套命中无害）。
  const outer = all.filter((n) => !(n.parentElement && n.parentElement.closest('[data-message-id]')))
  const first = outer[0]
  // 滚动容器：从消息节点往上找第一个 overflow-y 非 visible 的祖先。两臂**同一条取法**——
  // 用 .msg-contain 去找容器只对生效臂成立，会把"接线错了"伪装成"没测到"。
  let scroller = null
  for (let el = first && first.parentElement; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY
    if (oy === 'auto' || oy === 'scroll') { scroller = el; break }
  }
  if (!scroller) return { chatNodes: all.length, chatNodesOuter: outer.length, chatError: '未找到滚动容器' }
  const sample = outer[outer.length - 1]
  const first0 = outer[0]
  const cs = first ? getComputedStyle(first) : null
  // ① 顶部 + 让出两帧再强排：贴底时尾部若干条是"已排版"的（auto 会记住真实高度），
  //    不归零会污染估算证据。读数即"跳过排版"的直接证据——离屏条目按估算计高。
  scroller.scrollTop = 0
  await frame(); await frame()
  void scroller.scrollHeight
  const scrollHeightAtTop = scroller.scrollHeight
  const clientHeight = scroller.clientHeight
  // ② 贴底 + 让出两帧：把尾部变成"真的可见、真的排过版"的状态——这才是流式的现场
  //    （应用里滚动贴底，增量写在可见的最后一条上）。
  scroller.scrollTop = scroller.scrollHeight
  await frame(); await frame()
  // 计时循环整段同步（预热 10 次丢弃：否则后跑的臂白拿 JIT 优化，两臂不可比）。
  // N=100：Chromium 的 performance.now() 分辨率约 0.1ms，30 次在生效臂上量不到（实测读成 0）。
  const N = 100
  const timeN = (n, fn) => { const t = performance.now(); for (let k = 0; k < n; k++) fn(k); return performance.now() - t }
  const bench = (fn) => { timeN(10, fn); return Math.round(timeN(N, fn) * 1000) / 1000 }
  // 四种操作分开量（2026-09-13 真 ChatWindow，200 条，贴底后）：
  //   ① 改**远离视口**的条目 —— R6 声称的那件事（离屏条目跳过 style/layout）。实测
  //      生效臂 ~2µs/次 vs 对照臂 ~530µs/次（~265×），**被断言的就是这条**。
  //   ② 改**可见**的尾条（流式现场）—— 只报不判：两次运行符号相反（生效臂 557 vs 对照 725，
  //      另一次 662 vs 584），即差值在噪声内 ⇒ **不声称**流式路径有收益。
  //   ③ 容器字号变化后强排 —— 也是只报不判：实测两臂相当（183 vs 185µs），没分离出全量重排成本
  //      （夹具的正文有自己固定的字号类，容器字号变化未必真的失效整棵子树）。
  //   ④ 纯读高度 —— 底噪参照。
  const benches = [
    { name: 'append离屏首(远离视口)', ms: bench(() => { first0.appendChild(document.createTextNode('x')); void scroller.scrollHeight }), asserted: true },
    { name: 'append可见尾(流式形态)', ms: bench(() => { sample.appendChild(document.createTextNode('x')); void scroller.scrollHeight }), asserted: false },
    { name: '字号失效强排(全量重排)', ms: bench((k) => { scroller.style.fontSize = (k % 2 ? '13px' : '13.5px'); void scroller.scrollHeight }), asserted: false },
    { name: '纯读高度', ms: bench(() => { void scroller.scrollHeight }), asserted: false },
  ]
  const appendTotalMs = benches[0].ms
  return {
    chatNodes: all.length,
    chatNodesOuter: outer.length,
    chatScrollerIsContain: scroller.classList.contains('msg-contain'),
    hasContainClass: !!document.querySelector('.msg-contain'),
    contentVisibility: cs ? cs.contentVisibility : null,
    containIntrinsicSize: cs ? (cs.containIntrinsicSize || cs.containIntrinsicWidth || null) : null,
    scrollHeightAtTop,
    clientHeight,
    appendTotalMs,
    appendPerIterUs: Math.round((appendTotalMs / N) * 1000),
    appendIterations: N,
    timerFloorMs: 0.1,
    benches,
  }
})()`

const mainCjs = `
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync, mkdirSync } = require('node:fs')
const HTML = ${JSON.stringify(join(TMP, 'index.html'))}
const RESULT_FILE = ${JSON.stringify(join(TMP, 'result.json'))}
const SHOT_DIR = ${JSON.stringify(SHOT_DIR)}
const QCARD_CLICK_JS = ${JSON.stringify(QCARD_CLICK_JS)}
const CHAT_BENCH_JS = ${JSON.stringify(CHAT_BENCH_JS)}
const shotFiles = []
let shotErr = null
const FX = ${JSON.stringify(CASES.map((c) => ({ key: c.key, clearFirst: !!c.clearFirst, sweepFirst: !!c.sweepFirst, replayQcard: !!c.replayQcard, chat: !!c.chat })))}

const EXTRACT = \`(() => {
  const fill = document.querySelector('.health-meter-fill')
  // 泛光 = inset 红色 box-shadow 的覆盖层（卡片用的是 filter: drop-shadow，不会误判）
  const glow = [...document.querySelectorAll('div')].find(d => {
    const s = getComputedStyle(d)
    return s.boxShadow && s.boxShadow !== 'none' && s.boxShadow.includes('inset')
  })
  return {
    hasMeter: !!document.querySelector('.health-meter'),
    fillBg: fill ? getComputedStyle(fill).backgroundColor : null,
    text: document.body.innerText,
    buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean),
    hasGlow: !!glow,
    // 等待态常显条（T8）：kind 取 data-wait-kind；visible 按 boundingRect 判定
    //（"无需 hover 即可见"正是本次事故的验收点——旧出口的秒数只在 tooltip 里）
    waitKind: (() => { const el = document.querySelector('[data-wait-kind]'); return el ? el.getAttribute('data-wait-kind') : null })(),
    waitText: (() => { const el = document.querySelector('[data-wait-kind]'); return el ? (el.textContent || '').trim() : '' })(),
    waitVisible: (() => {
      const el = document.querySelector('[data-wait-kind]')
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })(),
    // 提问卡折叠态（2026-09-13）：collapsed = 只剩输入栏上方那个小 chip（用户会整段错过）
    qcardState: (() => { const el = document.querySelector('[data-qcard-state]'); return el ? el.getAttribute('data-qcard-state') : null })(),
    // 复发提示（"锚定未根治"）：按可见文本判定，不依赖具体文案
    recurredNotice: /再次出现|came back/.test(document.body.innerText),
    htmlLen: document.getElementById('root').innerHTML.length,
    errors: window.__ERRORS__ || [],
  }
})()\`

app.whenReady().then(async () => {
  const results = []
  const win = new BrowserWindow({ show: true, width: 900, height: 560, webPreferences: { contextIsolation: true } })
  await win.loadFile(HTML)
  await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
  for (let i = 0; i < FX.length; i++) {
    const key = FX[i].key
    await win.webContents.executeJavaScript('window.__render(' + i + ')')
    await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 300))')
    const data = await win.webContents.executeJavaScript(EXTRACT)
    // R6 长列表用例：接在通用 EXTRACT 之后（EXTRACT 里的 innerText 会先逼出一次排版，
    // 两臂同等；量测脚本自己会重新归零滚动位置）。放在截图之前，避免截图开销掺进读数。
    if (FX[i].chat) Object.assign(data, await win.webContents.executeJavaScript(CHAT_BENCH_JS))
    // clearFirst 用例：先量"有等待"（waitKind 非 null），再走内核已死路径的复位，
    // 再量一次——用于验"内核被杀后等待条不得残留"。
    if (FX[i].clearFirst) {
      await win.webContents.executeJavaScript('window.__clearWait()')
      await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
      const after = await win.webContents.executeJavaScript(EXTRACT)
      data.waitKindAfterClear = after.waitKind
      data.waitKindBeforeClear = data.waitKind
    }
    // sweepFirst 用例：先量"有指示"（应为 compact），再走兜底巡检，再量一次——
    // 验"done 帧丢失的陈旧指示必须消失 / 新鲜压缩不得被误清"。
    if (FX[i].sweepFirst) {
      data.waitKindBeforeSweep = data.waitKind
      await win.webContents.executeJavaScript('window.__sweepCompaction()')
      await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
      const afterSweep = await win.webContents.executeJavaScript(EXTRACT)
      data.waitKindAfterSweep = afterSweep.waitKind
    }

    // replayQcard 用例：模拟「用户手动收起 → WS 重连 hello 重放同一条提问」。
    // 收起与重放都必须用真交互（点折叠头）与真重渲染，不能靠直接读 store。
    if (FX[i].replayQcard) {
      data.qcardCollapseClicked = await win.webContents.executeJavaScript(QCARD_CLICK_JS)
      await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
      data.qcardAfterCollapse = (await win.webContents.executeJavaScript(EXTRACT)).qcardState
      // hello 重放：同一条提问的帧再来一次（载荷新对象、cardKey 不变）
      await win.webContents.executeJavaScript('window.__render(' + i + ')')
      await win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(1), 250))')
      data.qcardAfterReplay = (await win.webContents.executeJavaScript(EXTRACT)).qcardState
    }

    // 截图留证（人工眼见为实）：release/_gui-fidelity-shots/<key>.png
    try {
      const img = await win.webContents.capturePage()
      const png = img.toPNG()
      if (!png || !png.length) throw new Error('capturePage 返回空图')
      mkdirSync(SHOT_DIR, { recursive: true })
      writeFileSync(join(SHOT_DIR, key + '.png'), png)
      shotFiles.push(key + '.png')
    } catch (e) { shotErr = String(e?.message || e) }
    results.push({ key, ...data })
  }
  win.destroy()
  // electron.exe 是 GUI 子系统程序：stdout 不可靠 → 结果落文件
  writeFileSync(RESULT_FILE, JSON.stringify({ results, shotFiles, shotErr }))
  app.quit()
}).catch((e) => { writeFileSync(RESULT_FILE, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1) })
`

writeFileSync(join(TMP, 'harness.tsx'), harness)
writeFileSync(join(TMP, 'main.cjs'), mainCjs)
// 夹具经脚本全局注入（页内切换，避免 file:// query 体积限制）
writeFileSync(join(TMP, 'fixtures.js'), `window.__FIXTURES__ = ${JSON.stringify(CASES.map((c) => ({ health: c.health, shownIds: c.shownIds || [], wait: c.wait || {}, qcard: c.qcard || null, chat: c.chat || null })))};`)
writeFileSync(join(TMP, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${builtCssPath().replace(/\\/g, '/')}"></head>
<body style="background: var(--bg-primary)"><div id="root"></div>
<script>window.__ERRORS__=[];window.addEventListener('error',e=>window.__ERRORS__.push(String(e.message||e.error)));window.addEventListener('unhandledrejection',e=>window.__ERRORS__.push('reject: '+String(e.reason)));</script>
<script src="./fixtures.js"></script><script src="./bundle.js"></script></body></html>`)

/** 就近查找 node_modules：从仓库根向上走（worktree 自身没有，依赖在主仓库/上层）。 */
function findNodeModules(from) {
  let dir = from
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'node_modules')
    if (existsSync(cand)) return cand
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return join(from, 'node_modules')
}

// ---- esbuild：打包真组件（别名 @ → src；用 JS API 避免 shell 引号/Windows 路径转义） ----
const { build } = await import('esbuild')
await build({
  entryPoints: [join(TMP, 'harness.tsx')],
  bundle: true,
  outfile: join(TMP, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  alias: { '@': join(REPO_ROOT, 'src') },
  // harness 在系统 temp 下，Node 解析不到仓库依赖 → 显式给出 node_modules 搜索路径
  nodePaths: [findNodeModules(REPO_ROOT)],
  // iife 下 import.meta 为空对象；config.ts 只在函数体内用它（非加载期），
  // 这里显式给个空 env 以免运行期读到 undefined。
  // __BRIDGE_PORT__ / __APP_VERSION__ 是 vite.config.ts 的 define——esbuild 侧必须补上，
  // 否则用到它们的模块**在求值期**就抛 ReferenceError（useYFWCLI.ts:27 顶层就调
  // getWsUrl() → config.ts:15 直接引用该标识符），表现为整包加载失败、所有用例一起红。
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"', __BRIDGE_PORT__: '"51517"', __APP_VERSION__: '"0.0.0"' },
  logLevel: 'warning',
})

/** 跑子进程并收 stdout（shell 关闭以免 Windows 引号转义）。
 *  timeoutMs 是必需的：electron 在**主进程脚本加载失败**时不退出（打印完
 *  "App threw an error during load" 就一直等），没有上限就成了无限挂起——
 *  2026-09-13 实际发生（生成的 main.cjs 语法错误），排查耗时 15 分钟。 */
function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, ...spawnOpts } = opts
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts })
    let out = '', err = '', killed = false
    const timer = timeoutMs > 0 ? setTimeout(() => { killed = true; try { p.kill() } catch {} }, timeoutMs) : null
    p.stdout.on('data', (d) => out += d)
    p.stderr.on('data', (d) => err += d)
    p.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (killed) return rej(new Error(`${cmd} 超时 ${timeoutMs}ms 未退出（已强杀）\n${err || out}`))
      code === 0 ? res(out) : rej(new Error(`${cmd} 退出码 ${code}\n${err || out}`))
    })
  })
}

// electron.exe 是 GUI 子系统程序（stdout 不可靠）→ 以结果文件为准，忽略其退出码；
// 但**保留错误文本**：加载失败/超时时它是唯一线索，不能吞掉。
const ELECTRON_TIMEOUT_MS = Number(process.env.GUI_VERIFY_TIMEOUT_MS || 240000)
let runErr = null
try { await run(ELECTRON, [join(TMP, 'main.cjs')], { shell: false, timeoutMs: ELECTRON_TIMEOUT_MS }) } catch (e) { runErr = e }
let payload
try {
  payload = JSON.parse(readFileSync(join(TMP, 'result.json'), 'utf8'))
} catch (e) {
  throw new Error(`未取到结果文件：${e.message}（electron 未完成渲染？）${runErr ? `\n--- electron 侧 ---\n${runErr.message}` : ''}`)
}
if (payload && payload.error) throw new Error(`electron 渲染失败：${payload.error}`)
const results = payload.results
const shotFiles = payload.shotFiles || []
const shotErr = payload.shotErr

// ---- 断言 ----
const fails = []
const byKey = Object.fromEntries(results.map((r) => [r.key, r]))
const check = (cond, msg) => { if (!cond) fails.push(msg) }
const rowsOf = (text) => (String(text).match(/第 \d+ 轮 ·/g) || []).length
const REANCHOR = '重新锚定'
const NEW_SESSION = '新建会话'

const A = byKey['red-distortion'], B = byKey['amber-distortion'], C = byKey['red-pressure-only'], D = byKey['legacy-no-distortion'], E = byKey['recurred-distortion'], F = byKey['recurred-twice-distortion']

check(!!A?.hasMeter && !!D?.hasMeter, '血条应始终渲染（两个被测量中它是常驻仪表）')
check(A && rowsOf(A.text) === 3, `失真红应逐条列出 3 条证据，实测 ${A ? rowsOf(A.text) : '缺失'}`)
check(A && A.buttons.some((b) => b.includes(REANCHOR)), '失真红应出现「重新锚定」按钮')
check(A && A.buttons.some((b) => b.includes(NEW_SESSION)), '失真红应出现「新建会话」按钮')
check(A && /×\s*3/.test(A.text), '失真红应显示角标 ×3')
check(B && rowsOf(B.text) === 0, `失真琥珀不得弹卡（不打扰），实测证据行 ${B ? rowsOf(B.text) : '缺失'}`)
check(B && !B.buttons.some((b) => b.includes(REANCHOR)), '失真琥珀不得出现「重新锚定」按钮')
check(B && /×\s*2/.test(B.text), '失真琥珀应显示角标 ×2')
check(C && rowsOf(C.text) === 0, '压力红 + 失真绿：不得弹失真卡')
check(C && !C.buttons.some((b) => b.includes(REANCHOR)), '压力红 + 失真绿：不得出现「重新锚定」按钮')
check(C && !/×\s*\d/.test(C.text), '压力红 + 失真绿：不得点亮失真角标（两轴严禁互相赋值）')
check(C && D && C.fillBg !== D.fillBg, `血条颜色必须跟随压力档（压力红=${C?.fillBg} vs 压力绿=${D?.fillBg}）`)
check(A && D && A.fillBg === D.fillBg, `失真红不得改变血条颜色（失真红=${A?.fillBg} vs 压力绿=${D?.fillBg}）`)
check(D && rowsOf(D.text) === 0 && !/×\s*\d/.test(D.text), '老内核（无 distortion 字段）：不得弹卡/角标')
check(!B?.hasGlow && !C?.hasGlow && !D?.hasGlow, '泛光应只在失真红出现（琥珀/压力红/老内核都不泛光）')
check(!!A && A.hasGlow, '失真红应出现泛光（泛光已换轴到失真）')
// 复发：即使该证据已展示过也必须重新提醒，并给出"锚定没根治"提示（spec 验收项 6）
check(E && rowsOf(E.text) === 1, `同源复发应重现卡片，实测证据行 ${E ? rowsOf(E.text) : '缺失'}`)
check(E && E.buttons.some((b) => b.includes(REANCHOR)) && E.buttons.some((b) => b.includes(NEW_SESSION)), '复发卡片应仍提供两级动作')
check(!!E && E.recurredNotice, '复发卡片应显示"锚定未根治"提示')
check(B && !B.recurredNotice && A && !A.recurredNotice, '非复发不得显示复发提示')
// 第二次复发：首次与第一次复发的抑制键都已登记 → 仍须提醒（键含复发次数）
check(F && rowsOf(F.text) === 1, `第二次复发应仍弹卡，实测证据行 ${F ? rowsOf(F.text) : '缺失'}`)
check(!!F && F.recurredNotice, '第二次复发同样提示"锚定未根治"')

// ---- T8 等待态常显条 ----
const W1 = byKey['wait-firstbyte'], W2 = byKey['wait-stall'], W3 = byKey['wait-approval']
const W4 = byKey['wait-question'], W5 = byKey['wait-compact'], W6 = byKey['wait-none']
const W7 = byKey['wait-priority'], W8 = byKey['wait-after-close']
// 核心验收：无需 hover 即可见 + 带秒数（旧出口正是"秒数只在 tooltip 里"）
check(!!W1?.waitVisible, '等待模型时必须常显可见（不得只在 hover tooltip 里），实测 ' + JSON.stringify(W1?.waitText))
check(!!W1 && W1.waitKind === 'firstByte' && /\d/.test(W1.waitText), `等待模型应显示递增秒数，实测 kind=${W1?.waitKind} text=${W1?.waitText}`)
check(!!W2 && W2.waitKind === 'stall' && W2.waitVisible && /\d/.test(W2.waitText), `失速应常显且带秒数，实测 kind=${W2?.waitKind} text=${W2?.waitText}`)
check(!!W3 && W3.waitKind === 'approval' && W3.waitVisible, '等审批应常显可见')
check(!!W3 && !/\d/.test(W3.waitText), `等审批不得显示秒数（等的是人不是模型），实测 ${W3?.waitText}`)
check(!!W4 && W4.waitKind === 'question' && W4.waitVisible && !/\d/.test(W4.waitText), `等回答应常显且不带秒数，实测 ${W4?.waitText}`)
check(!!W5 && W5.waitKind === 'compact' && W5.waitVisible, '压缩指示应常显可见')
check(W6 && W6.waitKind === null, `无等待态不得渲染等待条（不占位），实测 ${W6?.waitKind}`)
check(!!W7 && W7.waitKind === 'stall', `多态并存应只出优先级最高的一条，实测 ${W7?.waitKind}`)
check(!!W8 && W8.waitKindBeforeClear === 'approval' && W8.waitKindAfterClear === null,
  `内核已死复位后等待条不得残留，实测 before=${W8?.waitKindBeforeClear} after=${W8?.waitKindAfterClear}`)
// ---- 压缩指示常驻收口（2026-09-13）----
const W9 = byKey['wait-compact-stale'], W10 = byKey['wait-compact-fresh']
check(!!W9 && W9.waitKindBeforeSweep === 'compact', `兜底前应先看到压缩指示，实测 ${W9?.waitKindBeforeSweep}`)
check(!!W9 && W9.waitKindAfterSweep === null,
  `done 帧丢失的陈旧压缩指示必须被兜底复位（不得常驻），实测 after=${W9?.waitKindAfterSweep}`)
check(!!W10 && W10.waitKindBeforeSweep === 'compact' && W10.waitKindAfterSweep === 'compact',
  `仍在跑的新压缩不得被误清，实测 before=${W10?.waitKindBeforeSweep} after=${W10?.waitKindAfterSweep}`)
const W11 = byKey['wait-compact-clear']
check(!!W11 && W11.waitKindBeforeClear === 'compact' && W11.waitKindAfterClear === null,
  `内核终态复位（clearSessionWaitState）必须清掉悬挂的压缩指示，实测 before=${W11?.waitKindBeforeClear} after=${W11?.waitKindAfterClear}`)
// ---- 提问卡到达即展开（2026-09-13）----
const Q1 = byKey['qcard-new'], Q2 = byKey['qcard-replay']
check(!!Q1 && Q1.qcardState === 'expanded',
  `新提问到达必须默认展开（折叠 chip 是"用户整段错过提问"的直接形态），实测 ${Q1?.qcardState}`)
check(!!Q2 && Q2.qcardState === 'expanded', `重放用例的到达态也应先展开，实测 ${Q2?.qcardState}`)
check(!!Q2 && Q2.qcardCollapseClicked === true, '重放用例必须真的点到折叠头（否则"不弹开"无从验证）')
check(!!Q2 && Q2.qcardAfterCollapse === 'collapsed', `点折叠头应收起，实测 ${Q2?.qcardAfterCollapse}`)
check(!!Q2 && Q2.qcardAfterReplay === 'collapsed',
  `同一条提问的 hello 重放不得把用户收起的卡再弹开（cardKey 稳定），实测 ${Q2?.qcardAfterReplay}`)

// ---- R6 长列表 containment：接线 + 计时（2026-09-13）----
// 这里补的是**别处验不了**的两件事：① 挂类的调用点在 ChatWindow 里（.tsx，npm test 结构上够不着）；
// ② 一个类到底省了多少 —— 两臂 DOM 逐字节相同，只差 store 上报的 messageCount。
const R6C = byKey['chat-long-contained'], R6B = byKey['chat-long-baseline']
check(!!R6C && R6C.chatNodesOuter === CHAT_COUNT, `containment 臂应渲染 ${CHAT_COUNT} 条消息，实测 ${R6C?.chatNodesOuter}`)
check(!!R6B && R6B.chatNodesOuter === CHAT_COUNT, `对照臂应渲染 ${CHAT_COUNT} 条消息（两臂 DOM 必须相同），实测 ${R6B?.chatNodesOuter}`)
check(!!R6C && !!R6B && R6C.chatNodes === R6B.chatNodes, `两臂 DOM 必须逐节点相同（只差一个类），实测 ${R6C?.chatNodes} vs ${R6B?.chatNodes}`)
check(!!R6C && R6C.hasContainClass === true, '长会话（上报条数 ≥60）滚动容器必须挂 .msg-contain——这一行没有单测覆盖，只有此处能验')
check(!!R6B && R6B.hasContainClass === false, `短会话不得挂 .msg-contain（阈值失效会让所有会话都吃估算误差），实测 ${R6B?.hasContainClass}`)
check(!!R6C && R6C.chatScrollerIsContain === true, '取到的滚动容器必须就是挂类的那一个（否则后面的读数不是这个类的效果）')
check(!!R6C && R6C.contentVisibility === 'auto', `CSS 规则必须真的命中消息节点（"改名忘改 CSS"是静默失效路径），实测 content-visibility=${R6C?.contentVisibility}`)
check(!!R6B && R6B.contentVisibility !== 'auto', `对照臂不得是 auto，实测 ${R6B?.contentVisibility}`)
const r6Ci = R6C?.containIntrinsicSize
check(r6Ci == null || /auto\s+\d+(\.\d+)?px/i.test(r6Ci), `contain-intrinsic-size 应为 auto + 正数 px，实测 ${r6Ci}`)
// 跳过排版的直接证据：离屏消息按 120px 估算计入总高（探针实测估算/真实 ≈ 0.74）。
// 方向由夹具决定：正文短于 120px 时估算反而偏大 ⇒ 这条断言会反过来——故夹具按应用形态造长正文。
check(!!R6C && !!R6B && R6C.scrollHeightAtTop > 0 && R6C.scrollHeightAtTop <= R6B.scrollHeightAtTop * 0.9,
  `离屏消息应按估算计入总高：containment 臂 ${R6C?.scrollHeightAtTop}px 应显著小于对照臂 ${R6B?.scrollHeightAtTop}px`)
check(!!R6C && !!R6B && R6C.clientHeight > 0 && R6C.clientHeight < R6C.scrollHeightAtTop,
  `量到的必须是真滚动容器（否则量的是被内容撑高的块，读数无意义），实测 clientHeight=${R6C?.clientHeight} scrollHeight=${R6C?.scrollHeightAtTop}`)
// 计时：两臂操作完全相同（在**远离视口**的条目上追加文本 → 读 scrollHeight 强排），只差那一个
// 类。噪声底线：对照臂合计低于时间戳分辨率（0.1ms）时比值断言无意义。
const R6_NOISE_MS = 0.5
const tC = R6C?.appendTotalMs, tB = R6B?.appendTotalMs
check(typeof tC === 'number' && typeof tB === 'number', `两臂都应取到"改离屏条目"计时，实测 ${tC} / ${tB}`)
if (typeof tC === 'number' && typeof tB === 'number') {
  check(tC <= tB, `containment 臂改离屏条目不得慢于对照臂，实测 ${tC}ms vs ${tB}ms`)
  if (tB >= R6_NOISE_MS) check(tC <= tB * 0.5, `containment 应显著降低"改离屏条目后强制重排"（离屏子树跳过 style/layout），实测 ${tC}ms vs ${tB}ms`)
  else console.log(`\n（R6 对照臂合计仅 ${tB}ms < 噪声阈 ${R6_NOISE_MS}ms：只校验方向，比值断言跳过）`)
  if (tC > 0 && tC < (R6C?.timerFloorMs || 0.1)) console.log(`（R6 生效臂合计 ${tC}ms 低于时间戳分辨率，按"低于 ${R6C?.timerFloorMs || 0.1}ms 量不出"理解）`)
}

console.log('\n失真 GUI 渲染验证：')
for (const r of results) {
  // R6 用例的 text 是 200 条消息的正文、buttons 里还混着每条消息的复制按钮 →
  // 走通用那行会把控制台刷爆，故单独一行报量测字段。
  if (r.chatNodes !== undefined) {
    console.log(`  · ${r.key.padEnd(22)} 消息=${r.chatNodesOuter}(节点 ${r.chatNodes}) .msg-contain=${r.hasContainClass ? 'on' : 'off'} content-visibility=${r.contentVisibility} 总高@顶=${r.scrollHeightAtTop}px 视口=${r.clientHeight}px${r.chatError ? ` ⚠ ${r.chatError}` : ''}`)
    for (const b of (r.benches || [])) console.log(`      ${b.name.padEnd(22)} ${String(b.ms).padStart(8)}ms / ${r.appendIterations} 次 = ${Math.round((b.ms / r.appendIterations) * 1000)}µs/次`)
    continue
  }
  console.log(`  · ${r.key.padEnd(22)} fillBg=${r.fillBg} 证据行=${rowsOf(r.text)} 角标=${/×\s*\d/.test(r.text) ? 'on' : 'off'} 泛光=${r.hasGlow ? 'on' : 'off'}${r.qcardState ? ` 提问卡=${r.qcardState}${r.qcardAfterCollapse ? `→收起=${r.qcardAfterCollapse}` : ''}${r.qcardAfterReplay ? `→重放后=${r.qcardAfterReplay}` : ''}` : ''} 按钮=[${r.buttons.join(', ')}] rootHtml=${r.htmlLen}`)
}
const errs = [...new Set(results.flatMap((r) => r.errors || []))]
if (errs.length) console.log(`\n页内错误：\n  - ${errs.slice(0, 4).join('\n  - ')}`)
console.log(fails.length ? `\n✖ ${fails.length} 项未通过：\n  - ${fails.join('\n  - ')}` : '\n✔ 全部通过')
if (shotFiles.length) console.log(`\n截图：${SHOT_DIR}（${shotFiles.join(', ')}）`)
else if (shotErr) console.log(`\n（截图不可用：${shotErr} —— 不影响断言结论）`)

rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exit(fails.length ? 1 : 0)
