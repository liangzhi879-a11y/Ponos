// src/components/mcp/McpView.tsx —— MCP 顶层面板（第八 rail，2026-09-16）。
//
// 顶部状态条是**内核真值**（内核就绪后上报 → 桥缓存 → GET /mcp/status 取回；
// 面板打开期间由 system/mcp_status 事件推送更新），而每张卡片里的「连接测试」只是
// **面板自己发起的探测**。两者含义不同，界面上必须分开写：
//   探测通过 = "这台服务器此刻连得上"；内核状态 = "内核已把它接进 AI 的工具表"。
// 混在一起正是用户"添加成功却找不到调用入口"的来源——保存了、测试也是绿的，
// 但工具根本没进模型可调用的集合（内核只在启动段构建一次工具表）。
//
// 三块结构：
//   ① 状态条：内核已接入 N 台 / M 个工具、失败清单、已关闭清单、配置比内核新（下一条消息生效）
//   ② 工具清单：真实全名（mcp__<服务器>__<工具>），可直接复制去对话里核对
//   ③ 配置编辑器（McpConfigEditor）：服务器卡片 + 授权四档 + 连接测试 + 保存
import { useEffect } from 'react'
import { Plug, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n/useTranslation'
import { useMcpStore, stalenessOf, kernelSummary } from '@/stores/mcpStore'
import { McpConfigEditor } from '@/components/mcp/McpConfigEditor'

export function McpView() {
  const { t } = useTranslation()
  // 逐字段订阅（本仓库纪律：不许整店订阅——流式期每帧都在写别的 store，
  // 但本面板只关心这三个字段，整店订阅会让流式期每帧重渲染整棵树）
  const status = useMcpStore(s => s.status)
  const loading = useMcpStore(s => s.loading)
  const load = useMcpStore(s => s.load)

  // 挂载时拉一次：内核可能在面板打开前就已上报（事件早错过了，但**桥侧有缓存**）。
  // 此后靠 mcp_status 事件推送更新，**不轮询**：轮询是"定期问"，而内核本来就会推，
  // 既多余又会在用户什么都没做时反复发请求。
  // 依赖只有 load（zustand 的 action 引用稳定）：`t` 绝不能进依赖数组——它每次渲染都是新函数，
  // 会让本 effect 每帧重跑（本仓库有静态守卫 src/lib/hooksDeps.test.ts 拦这种写法）。
  useEffect(() => { void load() }, [load])

  const stale = stalenessOf(status)
  const snap = status?.kernel ?? null
  const sum = snap ? kernelSummary(snap) : null

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* ---- 页头 + 内核真实接入状态（全局真值）---- */}
      <div className="shrink-0 border-b border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <Plug className="w-[18px] h-[18px] text-brand-500" />
          <h2 className="text-xs font-semibold text-primary">{t('settings.mcpTitle')}</h2>
          <span className="text-[10px] text-tertiary">{t('settings.mcpDesc')}</span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} />
            {loading ? t('settings.mcpLoading') : t('settings.mcpRefresh')}
          </Button>
        </div>

        <div className="mt-2 space-y-1 text-xs">
          {/* 内核从未上报 ≠ 已生效：必须分开说，否则界面会谎称"已接入 0 个工具" */}
          {stale === 'unknown' && (
            <div className="text-tertiary">{t('settings.mcpKernelNever')}</div>
          )}
          {stale !== 'unknown' && sum && (
            <div className="text-emerald-500">
              {t('settings.mcpKernelOk', { servers: sum.totalServers, tools: sum.totalTools })}
            </div>
          )}
          {/* 待生效提示：签名不一致 = 磁盘配置比内核用的那份新（下一条消息时内核会重放） */}
          {stale === 'stale' && (
            <div className="text-amber-400">{t('settings.mcpStaleHint')}</div>
          )}
          {sum?.failedNames.map(n => (
            <div key={n} className="text-red-400">
              {t('settings.mcpFailedOne', { name: n, reason: snap?.failed?.[n] || '' })}
            </div>
          ))}
          {!!sum?.disabledNames.length && (
            <div className="text-tertiary">{t('settings.mcpDisabledOne', { names: sum.disabledNames.join('、') })}</div>
          )}
          {/* 磁盘配置读不出来（桥返回 ok:false + 原因）：显示原因，编辑器侧同时禁用保存 */}
          {status?.error && <div className="text-red-400">{status.error}</div>}
        </div>
      </div>

      {/* ---- 工具清单：真实全名，可复制去对话里用 ---- */}
      {snap && sum && sum.totalTools > 0 && (
        <div className="shrink-0 border-b border-subtle px-4 py-3">
          <div className="text-xs font-medium text-primary">{t('settings.mcpToolsList')}</div>
          <div className="mt-1 space-y-1">
            {Object.entries(snap.servers).map(([name, s]) => (
              <div key={name} className="text-xs">
                <span className="text-tertiary">{name}</span>
                {/* 该服务器的授权意图（public/bound/private）：工具清单看的是"台子上有什么"，
                    授权是另一维——两列并排显示，用户才知道"有工具"与"谁能用"不是一回事 */}
                <span className="ml-1 rounded bg-elevated px-1 text-[10px] text-secondary">{s.expose}</span>
                <span className="ml-2 font-mono text-secondary">{s.tools.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- 配置编辑器（含授权四档）---- */}
      <div className="min-h-0 flex-1 overflow-auto">
        <McpConfigEditor />
      </div>
    </div>
  )
}
