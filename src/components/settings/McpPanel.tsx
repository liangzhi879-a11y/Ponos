// src/components/settings/McpPanel.tsx —— 设置 → MCP 服务器（P1-5 扩展：GUI 配置界面）
//
// 设计要点（为什么这么做）：
//   ① **文件是唯一真源**：本页面只通过桥的 /mcp 路由读写 <configDir>/mcp.json，
//      与内核 loadMcpServers 读的是同一个文件，所以"界面里看到的"就是"内核将加载的"。
//   ② **不静默失败**：读/写/测试的任何错误都就地显示（含后端原文），
//      否则用户会误以为"保存成功了"或"配置丢了"。
//   ③ **连接测试是可选步骤**：测试失败不阻止保存——用户可能先存好再装依赖。
//   ④ 校验只拦"必然无效"的输入（名称空/重复、命令空），其余交给内核侧归一化（单一真源）。
import { useCallback, useEffect, useState } from 'react'
import { Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import {
  getMcpConfig,
  saveMcpConfig,
  testMcpServer,
  type McpServerConfig,
} from '@/lib/mcpApi'

type Row = {
  /** 稳定 key：重命名时不能丢焦点 */
  key: string
  name: string
  config: McpServerConfig
}

let seq = 0
const nextKey = () => `row-${++seq}`

const emptyConfig = (): McpServerConfig => ({ command: '', args: [], env: {}, timeoutMs: 30000 })

/** 配置对象 → 行模型（args 一行一个，env 一行一个 KEY=VALUE，便于编辑） */
function toRows(servers: Record<string, McpServerConfig>): Row[] {
  return Object.entries(servers).map(([name, cfg]) => ({
    key: nextKey(),
    name,
    config: {
      command: cfg.command ?? '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      cwd: cfg.cwd ?? undefined,
      timeoutMs: cfg.timeoutMs,
    },
  }))
}

/** 行模型 → 配置对象（空 cwd 不下发，避免写入无意义键） */
function toServers(rows: Row[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    const cfg: McpServerConfig = {
      command: r.config.command.trim(),
      args: r.config.args,
      env: r.config.env,
    }
    if (r.config.cwd && r.config.cwd.trim()) cfg.cwd = r.config.cwd.trim()
    if (r.config.timeoutMs && r.config.timeoutMs > 0) cfg.timeoutMs = r.config.timeoutMs
    out[name] = cfg
  }
  return out
}

export function McpPanel() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [configPath, setConfigPath] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  // 每个服务器最近一次连接测试结果（按行 key 存）
  const [tests, setTests] = useState<Record<string, { running?: boolean; ok?: boolean; text?: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const r = await getMcpConfig()
    setRows(toRows(r.servers))
    setConfigPath(r.configPath || '')
    if (!r.ok) setError(r.error || t('settings.mcpLoadFailed'))
    setLoading(false)
  }, [t])

  useEffect(() => { void load() }, [load])

  const patch = (key: string, fn: (r: Row) => Row) =>
    setRows(prev => prev.map(r => (r.key === key ? fn(r) : r)))

  const addRow = () => {
    setRows(prev => [...prev, { key: nextKey(), name: '', config: emptyConfig() }])
    setNotice('')
  }

  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key))

  // 校验：只拦必然无效的（名称空/重复、命令空）
  const names = rows.map(r => r.name.trim()).filter(Boolean)
  const dupName = names.find((n, i) => names.indexOf(n) !== i)
  const invalidRow = rows.find(r => !r.name.trim() || !r.config.command.trim())
  const validateMsg = dupName
    ? t('settings.mcpErrDupName', { name: dupName })
    : invalidRow
      ? t('settings.mcpErrRequired')
      : ''
  const canSave = rows.length === 0 || !validateMsg

  const onSave = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    const r = await saveMcpConfig(toServers(rows))
    if (r.ok) {
      setRows(toRows(r.servers))
      setNotice(t('settings.mcpSaved'))
    } else {
      setError(r.error || t('settings.mcpSaveFailed'))
    }
    setSaving(false)
  }

  const onTest = async (row: Row) => {
    setTests(prev => ({ ...prev, [row.key]: { running: true } }))
    const r = await testMcpServer({ ...row.config, command: row.config.command.trim() })
    setTests(prev => ({
      ...prev,
      [row.key]: r.ok
        ? { ok: true, text: `${r.tools?.length ?? 0} tools${r.tools?.length ? ': ' + r.tools.map(x => x.name).join(', ') : ''}` }
        : { ok: false, text: r.error || t('settings.mcpTestFailed') },
    }))
  }

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
        <div className="space-y-4">
          {rows.map(row => {
            const test = tests[row.key]
            return (
              <div key={row.key} className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center gap-2">
                  <Input
                    value={row.name}
                    placeholder={t('settings.mcpNamePlaceholder')}
                    className="max-w-[220px]"
                    onChange={e => patch(row.key, r => ({ ...r, name: e.target.value }))}
                  />
                  <div className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!row.config.command.trim() || test?.running}
                    onClick={() => void onTest(row)}
                  >
                    <Plug className="w-4 h-4" />
                    {test?.running ? t('settings.mcpTesting') : t('settings.mcpTest')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeRow(row.key)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs text-secondary">{t('settings.mcpCommand')}</span>
                  <Input
                    value={row.config.command}
                    placeholder="npx"
                    className="font-mono text-xs"
                    onChange={e => patch(row.key, r => ({ ...r, config: { ...r.config, command: e.target.value } }))}
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-secondary">{t('settings.mcpArgs')}</span>
                  <textarea
                    value={row.config.args.join('\n')}
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
                    <textarea
                      value={Object.entries(row.config.env).map(([k, v]) => `${k}=${v}`).join('\n')}
                      placeholder="API_KEY=xxx"
                      rows={2}
                      className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-brand-500"
                      onChange={e => {
                        const env: Record<string, string> = {}
                        for (const line of e.target.value.split('\n')) {
                          const i = line.indexOf('=')
                          if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1)
                        }
                        patch(row.key, r => ({ ...r, config: { ...r.config, env } }))
                      }}
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

                {test?.text && (
                  <p className={`text-xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {test.ok ? t('settings.mcpTestOk') : t('settings.mcpTestBad')}: {test.text}
                  </p>
                )}
              </div>
            )
          })}
        </div>
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
