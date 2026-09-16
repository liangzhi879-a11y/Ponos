// src/components/mcp/McpConfigEditor.tsx —— MCP 服务器**配置编辑器**（由设置窗的 McpPanel 拆分而来）
//
// 2026-09-16（MCP 顶层面板）：MCP 从设置窗提升为顶层 rail。原 665 行的 McpPanel 职责已偏多
// （配置 IO + 校验 + 表单 + 状态），故拆成两件：
//   · 本文件 = **配置编辑器**（表单 + 增删 + 连接测试 + 保存 + 每卡的授权控件）
//   · `McpView.tsx` = **视图层**（内核真实接入状态条 + 工具清单），提供外壳与滚动容器
// 拆分以"搬家 + 加授权控件"为限，既有交互逻辑不动（既有 15 条 mcpFormat 测试是这次拆分的回归网）。
//
// 设计要点（为什么这么做）：
//   ① **文件是唯一真源**：本页面只通过桥的 /mcp 路由读写 <configDir>/mcp.json，
//      与内核 loadMcpServers 读的是同一个文件，所以"界面里看到的"就是"内核将加载的"。
//   ② **不静默失败**：读/写/测试的任何错误都就地显示（含后端原文），
//      否则用户会误以为"保存成功了"或"配置丢了"。
//   ③ **连接测试是可选步骤**：测试失败不阻止保存——用户可能先存好再装依赖。
//      但必须与"内核已接入"区分：测试只证明"这台此刻连得上"（面板自己发的探测），
//      内核是否真把它接进工具表由 McpView 顶部状态条回答（内核上报的真值）。
//   ④ 校验只拦"必然无效"的输入（名称空/重复、传输必填字段、bound 未选 agent），
//      其余交给内核侧归一化（单一真源）：URL 是否可达、`${ENV_VAR}` 是否已定义都是运行期事实。
//   ⑦ **两种传输**（2026-09-16 扩展）：每卡片可选「本地命令」(stdio) / 「远程 HTTP」，
//      切换时**清掉另一侧专属字段**（否则写出 command+url 并存，后端一律 400 拒绝），
//      但保留两传输共用的 `timeoutMs` **与授权字段**——授权与传输无关，
//      切一次传输就把"指定 agent"重置回"公开"属静默的权限扩大。
//   ⑤ **状态与工具清单**（2026-09-16 增强）：每张卡片显示"已连接·N 个工具"徽章并列出工具名，
//      打开面板与保存后自动逐台实测，顶部给汇总（如"2 通 · 1 失败"）与「全部测试」。
//      ——数据来源是 /mcp/test 的真实握手，而非猜测。
//   ⑥ **多服务器**：并发测试（内核侧同样是 Promise.allSettled 并发启动），
//      一台失败不影响其它台——汇总如实呈现"2 通 1 失败"，不整体判死。
//   ⑧ **授权四档**（2026-09-16）：关闭 / 仅测试 / 公开 / 指定 agent。档位 ↔ 配置的互转
//      与校验规则都在 `mcpFormat.ts`（纯函数，可回归）；本文件只负责画控件与调用。
//      `bound` 但未选 agent ⇒ 校验报错、禁用保存（fail-closed 的界面侧对应：内核读侧
//      遇到空列表会让该服务器对**所有人**不可见，绝不退化成 public）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import {
  getMcpConfig,
  saveMcpConfig,
  testMcpServer,
  type McpServerConfig,
} from '@/lib/mcpApi'
// 授权多选的 agent 来源：与 agent 管理页**同源**（`GET /agents` 返回完整目录 + disabled 标记）。
// 若面板自己另立一份列表，用户就会在两边看到不同的可选集合，甚至"选了一个不存在的 agent"
// （而那个工具将无人可用）。
import { fetchKernelAgents } from '@/lib/agentsApi'
import {
  badgeOf, toolsOf, errorOf, summarize, summaryText, transportOf, configForTransport, canSaveConfig,
  parseArgLines, formatArgLines, parseKeyValueLines, formatKeyValueLines, nextDraft,
  authLevelOf, applyAuthLevel, authFieldsOf, requiredFilledOf, validateRowIssues,
  type McpTestState, type McpTransport,
} from '@/components/mcp/mcpFormat'

type Row = {
  /** 稳定 key：重命名时不能丢焦点 */
  key: string
  name: string
  /**
   * **传输类型的唯一真源**，不从 config 反推。
   *
   * 起因（真实 bug）：HTTP 形态刚切过去时 `url` 还是空串，而"从 url 是否非空反推"会把
   * 空串判成 stdio ⇒ 点「远程 HTTP」按钮高亮立刻弹回「本地命令」、HTTP 表单也不渲染，
   * 用户看到的就是"点了没反应、选不中"。
   * 本质问题：**空值状态无法表达"已选 HTTP 但还没填 URL"** —— 意图必须自己存一份，
   * 不能靠数据倒推。读已有配置时（toRows）才可以从 config 判定，因为后端只存合法数据
   * （HTTP 条目必有非空 url）。
   */
  transport: McpTransport
  config: McpServerConfig
}

let seq = 0
const nextKey = () => `row-${++seq}`

/** 新建行默认「本地命令」：既有用户几乎都是 stdio，默认值保持原样（零行为变化） */
const emptyConfig = (kind: McpTransport = 'stdio'): McpServerConfig =>
  kind === 'http'
    ? { url: '', headers: {}, timeoutMs: 30000, enabled: true, expose: { mode: 'public', bindAgents: [] } }
    : { command: '', args: [], env: {}, timeoutMs: 30000, enabled: true, expose: { mode: 'public', bindAgents: [] } }

/**
 * 切换传输时重造配置对象（清另一侧字段、保留 timeoutMs 与授权字段）。
 * 实现已下沉到 `mcpFormat.ts` —— 它是纯逻辑，放在组件里无法被单测覆盖，
 * 而正是这段逻辑"归还空 url"的特性踩了"反推传输类型"的坑（详见该函数注释）。
 */

/** 探测载荷：只带该传输的字段（HTTP 上多发 args/env 会被后端 400 拒掉） */
function probePayload(row: Row): McpServerConfig {
  const timeoutMs = row.config.timeoutMs
  if (row.transport === 'http') {
    return {
      url: String(row.config.url ?? '').trim(),
      headers: row.config.headers ?? {},
      timeoutMs,
    }
  }
  const payload: McpServerConfig = {
    command: String(row.config.command ?? '').trim(),
    args: row.config.args ?? [],
    env: row.config.env ?? {},
    timeoutMs,
  }
  const cwd = String(row.config.cwd ?? '').trim()
  if (cwd) payload.cwd = cwd
  return payload
}

/**
 * 两次探测的载荷是否一致 —— 用来判断"测试发起之后，这份配置有没有被改"。
 * 比较探测载荷（命令/参数/环境/工作目录/URL/认证头/超时），也就是**决定能否连通的全部字段**：
 * 改了任何一项，先前那次结论就不再代表现在这份配置。
 */
function sameProbe(a: Row, b: Row): boolean {
  return JSON.stringify(probePayload(a)) === JSON.stringify(probePayload(b))
}

/** 配置对象 → 行模型（args 一行一个，env/headers 一行一个 KEY=VALUE，便于编辑） */
function toRows(servers: Record<string, McpServerConfig>): Row[] {
  return Object.entries(servers).map(([name, cfg]) => {
    // 读已有配置时**可以**从数据判定：后端只存合法数据，HTTP 条目必有非空 url。
    // 编辑态则不行（url 可能还是空串），所以 Row 上另存 transport 作真源。
    const transport = transportOf(cfg)
    return {
      key: nextKey(),
      name,
      transport,
      // 只保留该传输形态的字段：带过去另一侧的键会在保存时被后端判为非法组合；
      // 授权字段（enabled/expose）与传输无关，必须一并保留（否则"指定 agent"会在读一次后丢档）。
      config: transport === 'http'
        ? {
            url: cfg.url ?? '',
            headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
            timeoutMs: cfg.timeoutMs,
            enabled: cfg.enabled !== false,
            expose: { mode: cfg.expose?.mode || 'public', bindAgents: [...(cfg.expose?.bindAgents || [])] },
          }
        : {
            command: cfg.command ?? '',
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
            cwd: cfg.cwd ?? undefined,
            timeoutMs: cfg.timeoutMs,
            enabled: cfg.enabled !== false,
            expose: { mode: cfg.expose?.mode || 'public', bindAgents: [...(cfg.expose?.bindAgents || [])] },
          },
    }
  })
}

/** 行模型 → 配置对象（HTTP 行不写 command/args/env；空 cwd 不下发，避免写入无意义键） */
function toServers(rows: Row[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    let cfg: McpServerConfig
    if (r.transport === 'http') {
      cfg = { url: String(r.config.url ?? '').trim(), headers: r.config.headers ?? {} }
    } else {
      cfg = {
        command: String(r.config.command ?? '').trim(),
        args: r.config.args ?? [],
        env: r.config.env ?? {},
      }
      const cwd = String(r.config.cwd ?? '').trim()
      if (cwd) cfg.cwd = cwd
    }
    if (r.config.timeoutMs && r.config.timeoutMs > 0) cfg.timeoutMs = r.config.timeoutMs
    // 授权字段必须显式落盘：漏掉它们时内核会用缺省（开启 + public），
    // 用户设的"关闭/仅测试/指定 agent"会静默失效——而界面显示的仍是用户设的档位。
    // `authFieldsOf` 只搬运**存在**的键（读旧配置时也能原样往返）。
    Object.assign(cfg, authFieldsOf(r.config))
    out[name] = cfg
  }
  return out
}

export function McpConfigEditor() {
  // lang 必须一并取出：`t` 是**每次渲染新建**的函数（useTranslation 未做 memo），
  // 把它放进依赖数组会让 useCallback 每帧重建 ⇒ 依赖它的 useEffect 每帧重跑。
  // 本面板的 load() 首行就是 setLoading(true)、末尾 setLoading(false)，
  // 于是"重跑 ⇒ 置真 ⇒ 异步置假 ⇒ 重渲染 ⇒ 再重跑"形成无限循环：
  // 界面永远停在"读取中"、新增的卡片也因走 loading 分支而看不见。
  // lang 是字符串、引用稳定，用它当依赖既断开循环，又保住"切换语言时刷新文案"的语义
  //（重建时捕获的 t 恰好对应新语言）。
  const { t, lang } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [configPath, setConfigPath] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>('')
  // 上一次「读取配置」是否失败：读不出当前状态时必须禁用保存，
  // 否则空列表会被当成"用户清空了配置"写回磁盘，覆盖那份可能还能救的文件（见 canSaveConfig）
  const [loadFailed, setLoadFailed] = useState(false)
  const [notice, setNotice] = useState<string>('')
  // 每台服务器的最近一次连接测试结果（按行 key 存）
  const [tests, setTests] = useState<Record<string, McpTestState>>({})
  // 自动实测只跑一次（用户编辑表单会频繁改 rows，不能每次重测）
  const autoRan = useRef(false)
  // 供异步的 doTest 在拿到结果时回看"这份配置还是不是当初那份"（见 doTest 内的过期判定）
  const rowsRef = useRef<Row[]>([])
  rowsRef.current = rows
  // 授权多选的 agent 目录（与 agent 管理页同源）。取不到就只显示档位，不阻塞配置编辑：
  // 拉列表失败不该让用户连"改 URL"都做不到。
  const [agents, setAgents] = useState<Array<{ id: string; name?: string; disabled?: boolean }>>([])
  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchKernelAgents()
        setAgents(list.map(a => ({ id: a.id, name: a.name, disabled: a.disabled })))
      } catch { /* 取不到就只显示档位（见上） */ }
    })()
  }, [])

  /** 测一台（结果结构化存 tools/error，供徽章与工具清单渲染） */
  const doTest = useCallback(async (row: Row): Promise<void> => {
    setTests(prev => ({ ...prev, [row.key]: { running: true } }))
    const r = await testMcpServer(probePayload(row))
    // 拿到结果先回看这份配置还在不在、还是不是当初那份：
    // 测试期间用户可能改了 URL/命令，或干脆删了这一行。若照写不误，界面上就会出现
    // "新配置 + 旧结论"（绿勾或红叉都可能），是实打实的误导 —— 结论只对被测的那份配置成立。
    const cur = rowsRef.current.find(x => x.key === row.key)
    if (!cur || !sameProbe(cur, row)) {
      setTests(prev => { const n = { ...prev }; delete n[row.key]; return n })
      return
    }
    setTests(prev => ({
      ...prev,
      [row.key]: r.ok
        ? { ok: true, tools: r.tools || [] }
        : { ok: false, error: r.error || t('settings.mcpTestFailed') },
    }))
  }, [lang])   // 不能用 t（每次渲染新建）；lang 稳定且足以覆盖"语言变了要换文案"

  /** 测全部：并发（内核侧也是并发启动），单台失败不影响其它台 */
  const testAll = useCallback(async (list: Row[]): Promise<void> => {
    const valid = list.filter(r => r.name.trim() && requiredFilledOf(r.config, r.transport))
    await Promise.all(valid.map(r => doTest(r)))
  }, [doTest])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setTests({})
    autoRan.current = false       // 「重新读取」后应重新实测
    try {
      const r = await getMcpConfig()
      setRows(toRows(r.servers))
      setConfigPath(r.configPath || '')
      setLoadFailed(!r.ok)        // 读不出来 ⇒ 不许保存（空列表会覆盖掉磁盘上那份配置）
      if (!r.ok) setError(r.error || t('settings.mcpLoadFailed'))
    } catch (e) {
      // getMcpConfig 本身不抛（内部已兜底），但 toRows 遇到意外形状会抛。
      // 若不兜住，异常会越过下面的 setLoading(false)，界面就永远停在「读取中」——
      // 这正是刚修的无限循环的表现（同一个死角，必须一并堵上）。
      setLoadFailed(true)         // 没读到可信状态，同样不许保存
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)   // 无条件复位：loading 卡住会让整个面板不可用
    }
  }, [lang])   // 循环根源：原先依赖 t ⇒ load 每帧新 ⇒ 下面的 effect 每帧重跑

  useEffect(() => { void load() }, [load])

  // 打开面板后自动逐台实测（只跑一次）；配好就能一眼看到哪台通、有哪些工具
  useEffect(() => {
    if (loading || autoRan.current || rows.length === 0) return
    autoRan.current = true
    void testAll(rows)
  }, [loading, rows, testAll])

  const patch = (key: string, fn: (r: Row) => Row) =>
    setRows(prev => prev.map(r => (r.key === key ? fn(r) : r)))

  /**
   * 改"连接相关"字段（命令/参数/环境/工作目录/URL/认证头/超时）时，顺手丢掉该行的测试结论。
   *
   * 结论只对**被测的那份配置**成立，配置一改就不再可信；留着那个绿勾，用户会以为
   * 刚填的 URL/命令已经验证过（与 setTransport 作废结论同一个道理）。
   * 名称只影响标识、不影响连接，故仍走 patch —— 改个名字不该把已验证的结果清掉。
   */
  const patchConfig = (key: string, fn: (r: Row) => Row) => {
    patch(key, fn)
    setTests(prev => {
      if (!(key in prev)) return prev     // 本来就没结论：原样返回，避免无谓重渲染
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const addRow = () => {
    // 新卡片默认本地命令（最常用），transport 显式写入，不从 config 反推
    setRows(prev => [...prev, { key: nextKey(), name: '', transport: 'stdio' as McpTransport, config: emptyConfig() }])
    setNotice('')
  }

  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key))

  /**
   * 切换传输类型：重造配置（清另一侧字段）+ **作废该台的测试结论**。
   * 结论必须作废：换了传输就是换了连接方式，上一次的「✓ 3 个工具」再显示出来就是误导。
   *
   * 判定必须读 `row.transport` 而不是 `transportOf(row.config)`：后者在"刚切到 HTTP、
   * url 还是空串"时会判回 stdio，于是这次切换被当成"没变化"直接 return，而 config
   * 已经变成 HTTP 形态 —— 表现为按钮点了没反应、选中态弹回。
   */
  const setTransport = (row: Row, kind: McpTransport) => {
    if (row.transport === kind) return
    patch(row.key, r => ({ ...r, transport: kind, config: configForTransport(r.config, kind) }))
    setTests(prev => {
      const next = { ...prev }
      delete next[row.key]
      return next
    })
    setNotice('')
  }

  // 校验：规则全在 `mcpFormat.validateRowIssues`（纯函数，可回归）。
  // 这里只负责把 issue 映射成本地化文案——规则与文案分开，是为了让同一份规则既能在
  // 中文界面下报错、又能被单测直接断言（无需 DOM / i18n）。
  // 规则：名称必填、名称不重复、该传输的必填字段已填（**关闭的跳过**）、bound 必须选 agent。
  const issue = validateRowIssues(rows)
  const validateMsg = issue === null
    ? ''
    : issue.kind === 'dupName'
      ? t('settings.mcpErrDupName', { name: issue.name })
      : issue.kind === 'boundNoAgent'
        ? t('settings.mcpErrBoundNoAgent', { name: issue.name })
        : issue.transport === 'http'
          ? t('settings.mcpErrUrlRequired')
          : t('settings.mcpErrRequired')
  // 读取失败时优先说明"为什么不能保存"，否则用户只会盯着一个灰掉的保存按钮发愣
  const blockedMsg = loadFailed ? t('settings.mcpSaveBlocked') : ''
  const canSave = canSaveConfig({ rowCount: rows.length, validateMsg, loadFailed })

  const onSave = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    const r = await saveMcpConfig(toServers(rows))
    if (r.ok) {
      const next = toRows(r.servers)
      setRows(next)
      setNotice(t('settings.mcpSaved'))
      void testAll(next)          // 配置变了 ⇒ 重测，徽章不留在旧结论上
    } else {
      setError(r.error || t('settings.mcpSaveFailed'))
    }
    setSaving(false)
  }

  const stats = summarize(rows.map(r => r.key), tests)
  const statsText = summaryText(stats, {
    ok: t('settings.mcpSummaryOk'),
    failed: t('settings.mcpSummaryFailed'),
    testing: t('settings.mcpSummaryTesting'),
    untested: t('settings.mcpSummaryUntested'),
  })

  return (
    <div className="space-y-5 p-4 text-sm">
      {/* 页面级标题/说明已上移到 McpView（那是"面板"的标题）：这里只留**配置维度的工具条**——
          配置文件路径 + 重新读取 + 新增。"重新读取"必须留在本组件内：它同时重置 rows/测试结论
          并且是保存被禁用时的自救入口（见 mcpSaveBlocked 文案），搬走反而会两处状态不同步。 */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Plug className="w-[18px] h-[18px] text-brand-500" />
            {t('settings.mcpTitle')}
          </h3>
          {configPath && (
            <p className="mt-1 font-mono text-[10px] text-tertiary break-all">{configPath}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cnSpin(loading)} />
            {t('settings.mcpReload')}
          </Button>
          <Button size="sm" onClick={addRow}>
            <Plus className="w-4 h-4" />
            {t('settings.mcpAdd')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-tertiary">{t('settings.mcpLoading')}</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-xs text-tertiary">{t('settings.mcpEmpty')}</p>
        </div>
      ) : (
        <>
          {/* 汇总条：N 台服务器 + 「2 通 · 1 失败」 + 全部测试 */}
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <span className="text-xs text-secondary">
              {t('settings.mcpServersCount', { count: stats.total })}
            </span>
            {statsText && (
              <span className={`text-xs ${stats.failed ? 'text-red-400' : 'text-tertiary'}`}>
                {statsText}
              </span>
            )}
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={stats.testing > 0 || rows.length === 0}
              onClick={() => void testAll(rows)}
            >
              <RefreshCw className={cnSpin(stats.testing > 0)} />
              {t('settings.mcpTestAll')}
            </Button>
          </div>

          <div className="space-y-4">
            {rows.map(row => {
              const test = tests[row.key]
              const badge = badgeOf(test)
              const tools = toolsOf(test)
              const err = errorOf(test)
              const kind = row.transport   // 真源：不从 config 反推（刚切到 HTTP 时 url 还是空的）
              return (
                <div key={row.key} className="space-y-3 rounded-xl border p-4">
                  {/* 传输类型放在卡片最上方：它是"这台服务器怎么连"的第一决策，决定下面渲染哪组字段 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-secondary">{t('settings.mcpTransport')}</span>
                    <Button
                      variant={kind === 'stdio' ? 'primary' : 'outline'}
                      size="xs"
                      onClick={() => setTransport(row, 'stdio')}
                    >
                      {t('settings.mcpTransportStdio')}
                    </Button>
                    <Button
                      variant={kind === 'http' ? 'primary' : 'outline'}
                      size="xs"
                      onClick={() => setTransport(row, 'http')}
                    >
                      {t('settings.mcpTransportHttp')}
                    </Button>
                  </div>

                  {/* 授权档位：关闭 / 仅测试 / 公开 / 指定 agent（2026-09-16）。
                      档位只改本地 state，**保存后才落盘**（与既有表单一致）——半途点错档不会
                      立刻改变 AI 的可用工具；而对"带凭证的远程服务器"来说，粒度粗一档就是
                      "对所有子 agent 开放"，改错代价高，故宁多一步显式保存。
                      档位 ↔ 配置的互转在 `mcpFormat.applyAuthLevel`（保留 bindAgents 列表）。 */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-secondary">{t('settings.mcpAuth')}</span>
                    <div className="flex gap-1">
                      {(['off', 'test', 'public', 'bound'] as const).map(lv => (
                        <Button
                          key={lv}
                          size="xs"
                          variant={authLevelOf(row.config) === lv ? 'primary' : 'outline'}
                          onClick={() => patchConfig(row.key, r => ({ ...r, config: applyAuthLevel(r.config, lv) }))}
                        >
                          {t(`settings.mcpAuth_${lv}`)}
                        </Button>
                      ))}
                    </div>
                    {/* 档位语义就地说明：光看按钮文字（"仅测试"）不足以让人知道它=连上但不给 AI */}
                    <span className="text-[10px] text-tertiary">{t('settings.mcpAuthHint')}</span>
                  </div>
                  {authLevelOf(row.config) === 'bound' && (
                    <div className="mt-2 space-y-1">
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {agents.length === 0 && (
                          <span className="text-[10px] text-tertiary">{t('settings.mcpAuthNoAgents')}</span>
                        )}
                        {agents.map(a => {
                          const on = (row.config.expose?.bindAgents || []).includes(a.id)
                          return (
                            <label key={a.id} className="flex items-center gap-1 text-xs text-secondary">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => patchConfig(row.key, r => {
                                  const cur = r.config.expose?.bindAgents || []
                                  const next = on ? cur.filter(x => x !== a.id) : [...cur, a.id]
                                  return { ...r, config: { ...r.config, expose: { mode: 'bound' as const, bindAgents: next } } }
                                })}
                              />
                              {a.name || a.id}
                              {/* 已停用的 agent 照列不滤：按设计（§4.5）要"展示全部并标出状态"，
                                  否则用户会以为"面板里选不到的 agent"不存在。绑定已停用 agent ⇒
                                  该工具无人可用（fail-closed），故状态必须显示出来。 */}
                              {a.disabled ? <span className="text-tertiary">{t('settings.mcpAuthAgentDisabled')}</span> : null}
                            </label>
                          )
                        })}
                      </div>
                      <span className="block text-[10px] text-tertiary">{t('settings.mcpAuthBoundHint')}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Input
                      value={row.name}
                      placeholder={t('settings.mcpNamePlaceholder')}
                      className="max-w-[220px]"
                      onChange={e => patch(row.key, r => ({ ...r, name: e.target.value }))}
                    />
                    {/* 状态徽章：直答"这台通不通、有几个工具" */}
                    {badge === 'running' && (
                      <span className="shrink-0 text-xs text-tertiary">{t('settings.mcpTesting')}</span>
                    )}
                    {badge === 'ok' && (
                      <span className="shrink-0 text-xs text-emerald-400">
                        ✓ {t('settings.mcpToolsCount', { count: tools.length })}
                      </span>
                    )}
                    {badge === 'failed' && (
                      <span className="shrink-0 text-xs text-red-400">✗ {t('settings.mcpStatusFailed')}</span>
                    )}
                    {badge === 'untested' && (
                      <span className="shrink-0 text-xs text-tertiary">{t('settings.mcpStatusUntested')}</span>
                    )}
                    <div className="flex-1" />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!requiredFilledOf(row.config, row.transport) || test?.running}
                      onClick={() => void doTest(row)}
                    >
                      <Plug className="w-4 h-4" />
                      {test?.running ? t('settings.mcpTesting') : t('settings.mcpTest')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeRow(row.key)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>

                  {kind === 'http' ? (
                    <>
                      <label className="block space-y-1">
                        <span className="text-xs text-secondary">{t('settings.mcpUrl')}</span>
                        <Input
                          value={row.config.url ?? ''}
                          placeholder="https://example.com/mcp"
                          className="font-mono text-xs"
                          onChange={e => patchConfig(row.key, r => ({ ...r, config: { ...r.config, url: e.target.value } }))}
                        />
                      </label>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1">
                          <span className="text-xs text-secondary">{t('settings.mcpHeaders')}</span>
                          <KeyValueArea
                            value={row.config.headers ?? {}}
                            rows={2}
                            placeholder={'Authorization=Bearer ${MY_TOKEN}'}
                            onChange={headers =>
                              patchConfig(row.key, r => ({ ...r, config: { ...r.config, headers } }))}
                          />
                          {/* 让人看见"为什么不填明文"：写进文件的只是占位符，真值运行时才取 */}
                          <span className="block text-[10px] text-tertiary">{t('settings.mcpHeadersHint')}</span>
                        </label>
                        <label className="block space-y-1">
                          <span className="text-xs text-secondary">{t('settings.mcpTimeout')}</span>
                          <Input
                            type="number"
                            value={row.config.timeoutMs ? String(row.config.timeoutMs) : ''} placeholder="30000"
                            className="font-mono text-xs"
                            onChange={e =>
                              patchConfig(row.key, r => ({ ...r, config: { ...r.config, timeoutMs: Number(e.target.value) || 0 } }))
                            }
                          />
                        </label>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="block space-y-1">
                        <span className="text-xs text-secondary">{t('settings.mcpCommand')}</span>
                        <Input
                          value={row.config.command ?? ''}
                          placeholder="npx"
                          className="font-mono text-xs"
                          onChange={e => patchConfig(row.key, r => ({ ...r, config: { ...r.config, command: e.target.value } }))}
                        />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs text-secondary">{t('settings.mcpArgs')}</span>
                        <MultilineArea
                          text={formatArgLines(row.config.args ?? [])}
                          placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/me'}
                          rows={3}
                          onText={text =>
                            patchConfig(row.key, r => ({ ...r, config: { ...r.config, args: parseArgLines(text) } }))}
                        />
                      </label>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1">
                          <span className="text-xs text-secondary">{t('settings.mcpEnv')}</span>
                          <KeyValueArea
                            value={row.config.env ?? {}}
                            rows={2}
                            placeholder="API_KEY=xxx"
                            onChange={env => patchConfig(row.key, r => ({ ...r, config: { ...r.config, env } }))}
                          />
                        </label>
                        <div className="space-y-3">
                          <label className="block space-y-1">
                            <span className="text-xs text-secondary">{t('settings.mcpCwd')}</span>
                            <Input
                              value={row.config.cwd ?? ''}
                              placeholder="/path/to/workdir"
                              className="font-mono text-xs"
                              onChange={e => patchConfig(row.key, r => ({ ...r, config: { ...r.config, cwd: e.target.value } }))}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-xs text-secondary">{t('settings.mcpTimeout')}</span>
                            <Input
                              type="number"
                              value={row.config.timeoutMs ? String(row.config.timeoutMs) : ''} placeholder="30000"
                              className="font-mono text-xs"
                              onChange={e =>
                                patchConfig(row.key, r => ({ ...r, config: { ...r.config, timeoutMs: Number(e.target.value) || 0 } }))
                              }
                            />
                          </label>
                        </div>
                      </div>
                    </>
                  )}

                  {/* 工具清单：证明"连上了且能干这些事"；名字带 mcp__<server>__<tool> 前缀可直接核对 */}
                  {tools.length > 0 && (
                    <div className="space-y-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-tertiary">
                        {t('settings.mcpToolsHeading')}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {tools.map(tool => (
                          <span
                            key={tool.name}
                            title={tool.description || ''}
                            className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-secondary"
                          >
                            {tool.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {err && (
                    <p className="text-xs text-red-400">{t('settings.mcpTestBad')}: {err}</p>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={() => void onSave()} disabled={!canSave || saving || loading}>
          {saving ? t('settings.mcpSaving') : t('settings.mcpSave')}
        </Button>
        {(blockedMsg || validateMsg) && (
          <span className="text-xs text-amber-400">{blockedMsg || validateMsg}</span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-tertiary">{t('settings.mcpRestartHint')}</span>
      </div>
    </div>
  )
}

/** 刷新按钮的旋转态（避免额外依赖） */
function cnSpin(spinning: boolean): string {
  return spinning ? 'w-4 h-4 animate-spin' : 'w-4 h-4'
}

/**
 * `KEY=VALUE` 行编辑器（环境变量与认证头共用同款交互）。
 *
 * 抽成一处是为了让两侧解析规则**必然一致**（规则在 `parseKeyValueLines`）：
 * 值里可能出现 `=`（如 base64 的 `==`），故只按**第一个** `=` 切分；键为空的行忽略。
 */
function KeyValueArea({ value, rows, placeholder, onChange }: {
  value: Record<string, string>
  rows: number
  placeholder?: string
  onChange: (v: Record<string, string>) => void
}) {
  return (
    <MultilineArea
      text={formatKeyValueLines(value)}
      placeholder={placeholder}
      rows={rows}
      onText={text => onChange(parseKeyValueLines(text))}
    />
  )
}

/**
 * 多行草稿输入框：**显示用户敲的原文**，对外只推解析结果。
 *
 * 为什么必须留草稿（本次交互自查发现的两个真实故障，同一根因）：
 *   · env / headers 原本直接受控于 `Object.entries(value).map(...).join('\n')`：
 *     用户敲下 "A"（还没到 `=`）会被 `parseKeyValueLines` 当"半输入行"丢弃 ⇒
 *     受控值回到空串 ⇒ **一个字都打不进去，只能把 `KEY=VALUE` 整段粘进来**；
 *   · args 原本直接受控于 `args.join('\n')`：敲回车产生的尾随空行被 `filter(Boolean)` 吃掉
 *     ⇒ 受控值回退 ⇒ **回车"没反应"，无法一行一个参数地输入**。
 * 根因是同一个：`format(parse(text))` 有损，拿它当受控值就会不停抹掉半成品输入。
 * 解法：草稿留在本组件，仅当**外部文本真的变了**（重新读取、切换传输清空）才回灌；
 * 判定逻辑提为纯函数 `nextDraft`，已有回归测试钉住这几个性质。
 *
 * ⚠️ 不要"简化"回 `value={format(parse(text))}`：那样看起来更贴近单一真源，
 * 却会让上面两个故障原样复活，而且不报错、typecheck 与单测都拦不住。
 */
function MultilineArea({ text, onText, rows, placeholder }: {
  text: string
  onText: (t: string) => void
  rows: number
  placeholder?: string
}) {
  const [draft, setDraft] = useState(text)
  const lastExternal = useRef(text)
  useEffect(() => {
    const next = nextDraft(draft, text, lastExternal.current)
    if (next.lastExternal !== lastExternal.current) lastExternal.current = next.lastExternal
    if (next.draft !== draft) setDraft(next.draft)
  }, [text, draft])
  return (
    <textarea
      value={draft}
      placeholder={placeholder}
      rows={rows}
      className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
      onChange={e => { setDraft(e.target.value); onText(e.target.value) }}
    />
  )
}
