import { useState, useMemo } from 'react'
import {
  Bot, Search, ChevronRight, Plus, Pencil, Trash2, Settings,
} from 'lucide-react'
import {
  ScrollArea, Badge, Button, Switch,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  Input, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/agentStore'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import type { Agent } from '@/lib/agents'
import { AgentAvatar } from './AgentAvatar'
import { AvatarCropDialog } from './AvatarCropDialog'

const TYPE_LABELS: Record<string, string> = {
  professional: '专业 Agent',
  builtin: '内置 Agent',
  custom: '自定义 Agent',
}

const TYPE_ORDER = ['professional', 'builtin', 'custom']

const EMPTY_AGENT: Agent = {
  id: '', name: '', description: '', whenToUse: '', type: 'custom', model: 'deepseek-v4-flash',
  systemPrompt: '', skills: [], tools: [], enabled: true,
}

export function AgentsPanel() {
  const agents = useAgentStore(s => s.agents)
  const toggleAgent = useAgentStore(s => s.toggleAgent)
  const addAgent = useAgentStore(s => s.addAgent)
  const updateAgent = useAgentStore(s => s.updateAgent)
  const deleteAgent = useAgentStore(s => s.deleteAgent)
  const resetAgent = useAgentStore(s => s.resetAgent)
  const resetAllAgents = useAgentStore(s => s.resetAllAgents)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null)
  const [form, setForm] = useState<Agent>({ ...EMPTY_AGENT })
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  // 头像编辑目标：target='store' 直接写入 agent（详情区）；target='form' 写入编辑草稿
  const [avatarFor, setAvatarFor] = useState<{ agent: Agent; target: 'store' | 'form' } | null>(null)
  const setAgentAvatar = useAgentStore(s => s.setAgentAvatar)

  const grouped = useMemo(() => {
    const filtered = filter
      ? agents.filter(a =>
          a.name.toLowerCase().includes(filter.toLowerCase()) ||
          a.description.toLowerCase().includes(filter.toLowerCase())
        )
      : agents

    const map = new Map<string, Agent[]>()
    for (const t of TYPE_ORDER) {
      map.set(t, [])
    }
    for (const a of filtered) {
      const group = map.get(a.type) || map.get('custom')!
      group.push(a)
    }
    return map
  }, [agents, filter])

  const activeCount = agents.filter(a => a.enabled).length

  const selected = agents.find(a => a.id === selectedId)

  const openAddDialog = () => {
    setEditingAgent(null)
    setForm({
      ...EMPTY_AGENT,
      id: `custom-${Date.now()}`,
    })
    setDialogOpen(true)
  }

  const openEditDialog = (agent: Agent) => {
    setEditingAgent(agent)
    setForm({ ...agent })
    setDialogOpen(true)
  }

  const handleSave = () => {
    if (!form.name.trim() || !form.description.trim()) return
    if (editingAgent) {
      updateAgent(editingAgent.id, form)
    } else {
      addAgent(form)
    }
    setDialogOpen(false)
    setEditingAgent(null)
  }

  const handleDelete = (id: string) => {
    deleteAgent(id)
    setDeleteConfirm(null)
    if (selectedId === id) setSelectedId(null)
  }

  const createAgentConversation = (agentId: string) => {
    useChatStore.getState().createConversation(undefined, agentId)
    useUIStore.getState().setSidebarTab('chats')
  }

  const renderAgentRow = (agent: Agent) => (
    <div key={agent.id} className="border-b border-default">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors',
          selectedId === agent.id ? 'bg-brand-500/15' : 'hover:bg-elevated'
        )}
        onClick={() => setSelectedId(selectedId === agent.id ? null : agent.id)}
      >
        <AgentAvatar agent={agent} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-primary truncate">{agent.name}</span>
            <Badge variant="default" className="text-[9px] shrink-0">{agent.type}</Badge>
          </div>
          <p className="text-[10px] text-tertiary truncate">{agent.description}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <Switch
            checked={agent.enabled}
            onCheckedChange={() => toggleAgent(agent.id)}
          />
          {agent.type !== 'custom' && (
            <button
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
              onClick={() => createAgentConversation(agent.id)}
              title="新建会话"
            >
              <Plus className="w-3 h-3" />
              新建
            </button>
          )}
          {agent.type === 'custom' && (
            <>
              <button
                className="p-1 rounded hover:bg-input transition-colors"
                onClick={() => openEditDialog(agent)}
                title="编辑"
              >
                <Pencil className="w-3 h-3 text-tertiary" />
              </button>
              <button
                className="p-1 rounded hover:bg-error/15 transition-colors"
                onClick={() => setDeleteConfirm(agent.id)}
                title="删除"
              >
                <Trash2 className="w-3 h-3 text-error" />
              </button>
            </>
          )}
          <ChevronRight className={cn(
            'w-3 h-3 text-tertiary transition-transform',
            selectedId === agent.id && 'rotate-90'
          )} />
        </div>
      </div>
      {deleteConfirm === agent.id && (
        <div className="px-3 py-2 bg-error/5 flex items-center gap-2">
          <span className="text-[10px] text-error flex-1">确认删除「{agent.name}」？此操作不可撤销。</span>
          <button
            className="px-2 py-0.5 rounded text-[10px] text-tertiary hover:bg-input transition-colors"
            onClick={() => setDeleteConfirm(null)}
          >
            取消
          </button>
          <button
            className="px-2 py-0.5 rounded text-[10px] font-medium text-error hover:bg-error/15 transition-colors"
            onClick={() => handleDelete(agent.id)}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b">
        <div className="flex items-center gap-2 mb-2">
          <Bot className="w-4 h-4 text-brand-500" />
          <span className="text-sm font-semibold text-primary">Agents</span>
          <Badge variant="primary">{activeCount} active</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-tertiary" />
            <input
              type="text"
              placeholder="Filter agents..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="w-full h-7 bg-elevated border border rounded-md pl-6 pr-2 text-xs text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <button
            onClick={openAddDialog}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors shrink-0"
            title="添加自定义 Agent"
          >
            <Plus className="w-3 h-3" />
            添加
          </button>
          <button
            onClick={() => setResetConfirm(true)}
            className="p-1 rounded hover:bg-input transition-colors shrink-0"
            title="重置所有 Agent 到默认状态"
          >
            <Settings className="w-3.5 h-3.5 text-tertiary" />
          </button>
        </div>
        {resetConfirm && (
          <div className="px-3 py-2 mt-2 bg-warning/5 border border-warning/20 rounded-md flex items-center gap-2">
            <span className="text-[10px] text-warning flex-1">重置所有内置和专业 Agent 为默认配置？（自定义 Agent 不受影响）</span>
            <button
              className="px-2 py-0.5 rounded text-[10px] text-tertiary hover:bg-input transition-colors"
              onClick={() => setResetConfirm(false)}
            >
              取消
            </button>
            <button
              className="px-2 py-0.5 rounded text-[10px] font-medium text-warning hover:bg-warning/15 transition-colors"
              onClick={() => {
                resetAllAgents()
                setResetConfirm(false)
              }}
            >
              确认重置
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="py-1">
          {TYPE_ORDER.map(type => {
            const list = grouped.get(type)
            if (!list || list.length === 0) return null
            return (
              <div key={type}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-tertiary uppercase tracking-wider">
                  {TYPE_LABELS[type]}
                </div>
                {list.map(renderAgentRow)}
              </div>
            )
          })}
          {agents.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-tertiary">
              No agents found
            </div>
          )}
        </div>
      </ScrollArea>

      {selected && (
        <div className="border-t bg-app p-3 animate-slide-up">
          <div className="flex items-center gap-3 mb-2">
            <AgentAvatar agent={selected} size={40} />
            <div className="flex-1 min-w-0">
              <h4 className="text-xs font-semibold text-primary">{selected.name}</h4>
              <div className="mt-1 flex items-center gap-2">
                <button
                  className="text-[10px] font-medium text-accent hover:text-accent/80 transition-colors"
                  onClick={() => setAvatarFor({ agent: selected, target: 'store' })}
                >
                  {selected.avatar ? '更换头像' : '设置头像'}
                </button>
                {selected.avatar && (
                  <button
                    className="text-[10px] text-tertiary hover:text-error transition-colors"
                    onClick={() => setAgentAvatar(selected.id, null)}
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-tertiary mb-2">{selected.description}</p>
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-tertiary">Model</span>
              <span className="text-secondary font-mono">{selected.model || 'Default'}</span>
            </div>
            {selected.tools.length > 0 && (
              <div className="flex justify-between">
                <span className="text-tertiary">Tools</span>
                <span className="text-secondary truncate max-w-[60%] text-right">{selected.tools.join(', ')}</span>
              </div>
            )}
            {selected.skills.length > 0 && (
              <div className="flex justify-between">
                <span className="text-tertiary">Skills</span>
                <span className="text-secondary truncate max-w-[60%] text-right">{selected.skills.join(', ')}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-tertiary">Status</span>
              <span className={selected.enabled ? 'text-success' : 'text-tertiary'}>
                {selected.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            {selected.type === 'custom' && (
              <div className="flex gap-2 pt-1.5">
                <button
                  className="flex-1 py-1 rounded text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
                  onClick={() => createAgentConversation(selected.id)}
                >
                  新建会话
                </button>
                <button
                  className="flex-1 py-1 rounded text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
                  onClick={() => openEditDialog(selected)}
                >
                  编辑
                </button>
                <button
                  className="flex-1 py-1 rounded text-[10px] font-medium text-error hover:bg-error/10 transition-colors"
                  onClick={() => setDeleteConfirm(selected.id)}
                >
                  删除
                </button>
              </div>
            )}
            {selected.type !== 'custom' && (
              <div className="flex gap-2 pt-1.5">
                <button
                  className="flex-1 py-1 rounded text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
                  onClick={() => createAgentConversation(selected.id)}
                >
                  新建会话
                </button>
                <button
                  className="flex-1 py-1 rounded text-[10px] font-medium text-tertiary hover:bg-input transition-colors"
                  onClick={() => {
                    resetAgent(selected.id)
                    setSelectedId(null)
                  }}
                >
                  重置为默认
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingAgent(null) }}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{editingAgent ? '编辑 Agent' : '添加自定义 Agent'}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <AgentAvatar agent={form} size={44} />
                <div className="flex flex-col gap-1">
                  <button
                    className="text-[11px] font-medium text-accent hover:text-accent/80 transition-colors text-left"
                    onClick={() => setAvatarFor({ agent: form, target: 'form' })}
                  >
                    {form.avatar ? '更换头像' : '上传头像'}
                  </button>
                  {form.avatar && (
                    <button
                      className="text-[11px] text-tertiary hover:text-error transition-colors text-left"
                      onClick={() => setForm(p => ({ ...p, avatar: undefined }))}
                    >
                      移除头像（恢复默认 Logo）
                    </button>
                  )}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">名称</label>
                <Input
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="Agent 名称"
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">描述</label>
                <Input
                  value={form.description}
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="简要描述 Agent 的功能"
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">
                  优势场景（主 agent 分发任务时据此路由，留空用描述）
                </label>
                <Textarea
                  value={form.whenToUse || ''}
                  onChange={e => setForm(p => ({ ...p, whenToUse: e.target.value }))}
                  placeholder="例如：当任务涉及撰写申报材料正文时使用，擅长专业正式、数据可溯源的成文写作"
                  className="min-h-[56px] text-xs resize-y"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">模型</label>
                <Input
                  value={form.model}
                  onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
                  placeholder="deepseek-v4-flash"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">
                  系统提示词 (System Prompt)
                </label>
                <Textarea
                  value={form.systemPrompt}
                  onChange={e => setForm(p => ({ ...p, systemPrompt: e.target.value }))}
                  placeholder="定义 Agent 的行为规则和角色..."
                  className="min-h-[100px] text-xs font-mono resize-y"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">关联技能 (逗号分隔)</label>
                <Input
                  value={form.skills.join(', ')}
                  onChange={e => setForm(p => ({ ...p, skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                  placeholder="gxtz-rd-report, gxtz-core-tables"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-secondary mb-1">工具 (逗号分隔)</label>
                <Input
                  value={form.tools.join(', ')}
                  onChange={e => setForm(p => ({ ...p, tools: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                  placeholder="Read, Write, Bash, WebFetch"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium text-secondary">默认启用</label>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={v => setForm(p => ({ ...p, enabled: v }))}
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setDialogOpen(false); setEditingAgent(null) }}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={!form.name.trim() || !form.description.trim()}>
              {editingAgent ? '保存修改' : '添加 Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 头像裁剪弹窗 */}
      {avatarFor && (
        <AvatarCropDialog
          title={`设置「${avatarFor.agent.name}」的头像`}
          onConfirm={(dataUrl) => {
            if (avatarFor.target === 'store') {
              setAgentAvatar(avatarFor.agent.id, dataUrl)
            } else {
              setForm(p => ({ ...p, avatar: dataUrl }))
            }
            setAvatarFor(null)
          }}
          onCancel={() => setAvatarFor(null)}
        />
      )}
    </div>
  )
}
