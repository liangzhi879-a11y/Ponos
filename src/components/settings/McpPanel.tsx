// src/components/settings/McpPanel.tsx —— 设置 → MCP 服务器（P1-5 扩展：GUI 配置界面）
//
// 设计要点（为什么这么做）：
//   ① **文件是唯一真源**：本页面只通过桥的 /mcp 路由读写 <configDir>/mcp.json，
//      与内核 loadMcpServers 读的是同一个文件，所以"界面里看到的"就是"内核将加载的"。
//   ② **不静默失败**：读/写/测试的任何错误都就地显示（含后端原文），
//      否则用户会误以为"保存成功了"或"配置丢了"。
//   ③ **连接测试是可选步骤**：测试失败不阻止保存——用户可能先存好再装依赖。
//   ④ 校验只拦"必然无效"的输入（名称空/重复，以及本地命令 / HTTP URL 为空），
//      其余交给内核侧归一化（单一真源）：URL 是否可达、`${ENV_VAR}` 是否已定义都是运行期事实。
//   ⑦ **两种传输**（2026-09-16 扩展）：每卡片可选「本地命令」(stdio) / 「远程 HTTP」，
//      切换时**清掉另一侧专属字段**（否则写出 command+url 并存，后端一律 400 拒绝），
//      但保留两传输共用的 `timeoutMs`。认证头只存 `${ENV_VAR}` 占位符 ⇒ 密钥不落盘。
//   ⑤ **状态与工具清单**（2026-09-16 增强）：每张卡片显示"已连接·N 个工具"徽章并列出工具名，
//      打开面板与保存后自动逐台实测，顶部给汇总（如"2 通 · 1 失败"）与「全部测试」。
//      ——数据来源是 /mcp/test 的真实握手，而非猜测；这正是"哪台连不上、各有什么工具"的答案。
//   ⑥ **多服务器**：并发测试（内核侧同样是 Promise.allSettled 并发启动），
//      一台失败不影响其它台——汇总如实呈现"2 通 1 失败"，不整体判死。
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
import {
  badgeOf, toolsOf, errorOf, summarize, summaryText, transportOf,
  type McpTestState, type McpTransport,
} from '@/components/settings/mcpFormat'

type Row = {
  /** 稳定 key：重命名时不能丢焦点 */
  key: string
  name: string
  config: McpServerConfig
}

let seq = 0
const nextKey = () => `row-${++seq}`

/** 新建行默认「本地命令」：既有用户几乎都是 stdio，默认值保持原样（零行为变化） */
const emptyConfig = (kind: McpTransport = 'stdio'): McpServerConfig =>
  kind === 'http'
    ? { url: '', headers: {}, timeoutMs: 30000 }
    : { command: '', args: [], env: {}, timeoutMs: 30000 }

/**
 * 切换传输时**重造配置对象**，也就是清掉另一侧的全部传输专属字段。
 *
 * 为什么必须清（而不是把另一侧字段留在对象里、只是不渲染）：后端把
 * 「command 与 url 并存」「args/env/cwd 配 url」「headers 配 command」一律判为非法并返回 400。
 * 字段若只是被 UI 藏起来，保存就会被拒，而界面上找不到任何可疑输入 —— 属于极难自诊的失败。
 * `timeoutMs` 两种传输共用，必须显式保留：否则用户设过的超时会因切一次传输而莫名回到默认。
 * 代价是切走再切回会丢掉另一侧已填内容，属刻意取舍（重填成本低，而 400 无法自诊）。
 */
const configForTransport = (config: McpServerConfig, kind: McpTransport): McpServerConfig =>
  kind === 'http'
    ? { url: '', headers: {}, timeoutMs: config.timeoutMs }
    : { command: '', args: [], env: {}, timeoutMs: config.timeoutMs }

/** 该传输形态的必填字段是否已填：本地 = 命令，HTTP = URL */
function requiredFilled(row: Row): boolean {
  return transportOf(row.config) === 'http'
    ? Boolean(String(row.config.url ?? '').trim())
    : Boolean(String(row.config.command ?? '').trim())
}

/** 探测载荷：只带该传输的字段（HTTP 上多发 args/env 会被后端 400 拒掉） */
function probePayload(row: Row): McpServerConfig {
  const timeoutMs = row.config.timeoutMs
  if (transportOf(row.config) === 'http') {
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

/** 配置对象 → 行模型（args 一行一个，env/headers 一行一个 KEY=VALUE，便于编辑） */
function toRows(servers: Record<string, McpServerConfig>): Row[] {
  return Object.entries(servers).map(([name, cfg]) => ({
    key: nextKey(),
    name,
    // 只保留该传输形态的字段：带过去另一侧的键会在保存时被后端判为非法组合
    config: transportOf(cfg) === 'http'
      ? {
          url: cfg.url ?? '',
          headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
          timeoutMs: cfg.timeoutMs,
        }
      : {
          command: cfg.command ?? '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
          cwd: cfg.cwd ?? undefined,
          timeoutMs: cfg.timeoutMs,
        },
  }))
}

/** 行模型 → 配置对象（HTTP 行不写 command/args/env；空 cwd 不下发，避免写入无意义键） */
function toServers(rows: Row[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    let cfg: McpServerConfig
    if (transportOf(r.config) === 'http') {
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
    out[name] = cfg
  }
  return out
}

export function McpPanel() {
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
  const [notice, setNotice] = useState<string>('')
  // 每台服务器的最近一次连接测试结果（按行 key 存）
  const [tests, setTests] = useState<Record<string, McpTestState>>({})
  // 自动实测只跑一次（用户编辑表单会频繁改 rows，不能每次重测）
  const autoRan = useRef(false)

  /** 测一台（结果结构化存 tools/error，供徽章与工具清单渲染） */
  const doTest = useCallback(async (row: Row): Promise<void> => {
    setTests(prev => ({ ...prev, [row.key]: { running: true } }))
    const r = await testMcpServer(probePayload(row))
    setTests(prev => ({
      ...prev,
      [row.key]: r.ok
        ? { ok: true, tools: r.tools || [] }
        : { ok: false, error: r.error || t('settings.mcpTestFailed') },
    }))
  }, [lang])   // 不能用 t（每次渲染新建）；lang 稳定且足以覆盖"语言变了要换文案"

  /** 测全部：并发（内核侧也是并发启动），单台失败不影响其它台 */
  const testAll = useCallback(async (list: Row[]): Promise<void> => {
    const valid = list.filter(r => r.name.trim() && requiredFilled(r))
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
      if (!r.ok) setError(r.error || t('settings.mcpLoadFailed'))
    } catch (e) {
      // getMcpConfig 本身不抛（内部已兜底），但 toRows 遇到意外形状会抛。
      // 若不兜住，异常会越过下面的 setLoading(false)，界面就永远停在「读取中」——
      // 这正是刚修的无限循环的表现（同一个死角，必须一并堵上）。
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

  const addRow = () => {
    setRows(prev => [...prev, { key: nextKey(), name: '', config: emptyConfig() }])
    setNotice('')
  }

  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key))

  /**
   * 切换传输类型：重造配置（清另一侧字段）+ **作废该台的测试结论**。
   * 结论必须作废：换了传输就是换了连接方式，上一次的「✓ 3 个工具」再显示出来就是误导。
   */
  const setTransport = (row: Row, kind: McpTransport) => {
    if (transportOf(row.config) === kind) return
    patch(row.key, r => ({ ...r, config: configForTransport(r.config, kind) }))
    setTests(prev => {
      const next = { ...prev }
      delete next[row.key]
      return next
    })
    setNotice('')
  }

  // 校验：只拦必然无效的（名称空/重复，以及该传输形态的必填字段为空：本地=命令，HTTP=URL）。
  // URL 是否可达、`${ENV_VAR}` 变量是否已定义属运行期事实，交给「连接测试」定论。
  const names = rows.map(r => r.name.trim()).filter(Boolean)
  const dupName = names.find((n, i) => names.indexOf(n) !== i)
  const invalidRow = rows.find(r => !r.name.trim() || !requiredFilled(r))
  const validateMsg = dupName
    ? t('settings.mcpErrDupName', { name: dupName })
    : !invalidRow
      ? ''
      : transportOf(invalidRow.config) === 'http' && !requiredFilled(invalidRow)
        ? t('settings.mcpErrUrlRequired')
        : t('settings.mcpErrRequired')
  const canSave = rows.length === 0 || !validateMsg

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
    <div className="max-w-3xl space-y-5 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-primary">
            <Plug className="w-[18px] h-[18px] text-brand-500" />
            {t('settings.mcpTitle')}
          </h2>
          <p className="mt-1 text-xs text-tertiary">{t('settings.mcpDesc')}</p>
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
              const kind = transportOf(row.config)
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
                      disabled={!requiredFilled(row) || test?.running}
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
                          onChange={e => patch(row.key, r => ({ ...r, config: { ...r.config, url: e.target.value } }))}
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
                              patch(row.key, r => ({ ...r, config: { ...r.config, headers } }))}
                          />
                          {/* 让人看见"为什么不填明文"：写进文件的只是占位符，真值运行时才取 */}
                          <span className="block text-[10px] text-tertiary">{t('settings.mcpHeadersHint')}</span>
                        </label>
                        <label className="block space-y-1">
                          <span className="text-xs text-secondary">{t('settings.mcpTimeout')}</span>
                          <Input
                            type="number"
                            value={String(row.config.timeoutMs ?? 30000)}
                            className="font-mono text-xs"
                            onChange={e =>
                              patch(row.key, r => ({ ...r, config: { ...r.config, timeoutMs: Number(e.target.value) || 0 } }))
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
                          onChange={e => patch(row.key, r => ({ ...r, config: { ...r.config, command: e.target.value } }))}
                        />
                      </label>

                      <label className="block space-y-1">
                        <span className="text-xs text-secondary">{t('settings.mcpArgs')}</span>
                        <textarea
                          value={(row.config.args ?? []).join('\n')}
                          placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/me'}
                          rows={3}
                          className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
                          onChange={e =>
                            patch(row.key, r => ({
                              ...r,
                              config: { ...r.config, args: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) },
                            }))
                          }
                        />
                      </label>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1">
                          <span className="text-xs text-secondary">{t('settings.mcpEnv')}</span>
                          <KeyValueArea
                            value={row.config.env ?? {}}
                            rows={2}
                            placeholder="API_KEY=xxx"
                            onChange={env => patch(row.key, r => ({ ...r, config: { ...r.config, env } }))}
                          />
                        </label>
                        <div className="space-y-3">
                          <label className="block space-y-1">
                            <span className="text-xs text-secondary">{t('settings.mcpCwd')}</span>
                            <Input
                              value={row.config.cwd ?? ''}
                              placeholder="/path/to/workdir"
                              className="font-mono text-xs"
                              onChange={e => patch(row.key, r => ({ ...r, config: { ...r.config, cwd: e.target.value } }))}
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-xs text-secondary">{t('settings.mcpTimeout')}</span>
                            <Input
                              type="number"
                              value={String(row.config.timeoutMs ?? 30000)}
                              className="font-mono text-xs"
                              onChange={e =>
                                patch(row.key, r => ({ ...r, config: { ...r.config, timeoutMs: Number(e.target.value) || 0 } }))
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
        {validateMsg && <span className="text-xs text-amber-400">{validateMsg}</span>}
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
 * 抽成一处是为了让两侧解析规则**必然一致**：值里可能出现 `=`（如 base64 的 `==`），
 * 故只按**第一个** `=` 切分；键为空的行忽略（半输入状态不该写进配置）。
 */
function KeyValueArea({ value, rows, placeholder, onChange }: {
  value: Record<string, string>
  rows: number
  placeholder?: string
  onChange: (v: Record<string, string>) => void
}) {
  return (
    <textarea
      value={Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n')}
      placeholder={placeholder}
      rows={rows}
      className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
      onChange={e => {
        const out: Record<string, string> = {}
        for (const line of e.target.value.split('\n')) {
          const i = line.indexOf('=')
          if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1)
        }
        onChange(out)
      }}
    />
  )
}
