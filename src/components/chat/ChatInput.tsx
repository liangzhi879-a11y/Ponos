import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, StopCircle, Paperclip, Sparkles, Mic, MicOff, Command, X, Zap, Repeat, MessageSquarePlus, BrainCircuit } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@radix-ui/react-popover'
import { DoubaoPanel } from '@/components/doubao/DoubaoPanel'
import { ScheduleGuide } from './ScheduleGuide'
import { HealthMeter } from './HealthMeter'
import { HealthSuggestCard } from './HealthSuggestCard'
import { Button } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useUIStore } from '@/stores/uiStore'
import { useHealthStore } from '@/stores/healthStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useYFWCLI } from '@/hooks/useYFWCLI'
import { useTranslation } from '@/i18n/useTranslation'
import { cn, formatSize, formatShortcut, matchShortcut, generateId } from '@/lib/utils'
import { getBridgeUrl } from '@/lib/config'
import { fetchSkills, buildSkillPrompt, type SkillEntry } from '@/lib/skills'

interface Props { conversationId: string }
interface Attachment { id: string; name: string; type: 'file' | 'image'; content: string; path?: string; preview?: string }

const SLASH_COMMANDS_EN = [
  { id: 'help', label: '/help', description: 'Show help and available commands' },
  { id: 'clear', label: '/clear', description: 'Clear the conversation' },
  { id: 'compact', label: '/compact', description: 'Compact conversation context' },
  { id: 'config', label: '/config', description: 'Open settings' },
  { id: 'cost', label: '/cost', description: 'Show usage cost' },
  { id: 'doctor', label: '/doctor', description: 'Run system diagnostics' },
  { id: 'export', label: '/export', description: 'Export conversation' },
  { id: 'model', label: '/model', description: 'Switch model' },
  { id: 'theme', label: '/theme', description: 'Change theme' },
  { id: 'review', label: '/review', description: 'Review code changes' },
  { id: 'commit', label: '/commit', description: 'Generate commit message' },
  { id: 'agents', label: '/agents', description: 'Manage agents' },
  { id: 'mcp', label: '/mcp', description: 'MCP server management' },
  { id: 'memory', label: '/memory', description: 'Open memory files' },
  { id: 'init', label: '/init', description: 'Initialize project config' },
]

const SLASH_COMMANDS_ZH = [
  { id: 'help', label: '/帮助', description: '显示帮助和可用命令' },
  { id: 'clear', label: '/清空', description: '清空对话' },
  { id: 'compact', label: '/压缩', description: '压缩对话上下文' },
  { id: 'config', label: '/设置', description: '打开设置' },
  { id: 'cost', label: '/费用', description: '查看使用费用' },
  { id: 'doctor', label: '/诊断', description: '运行系统诊断' },
  { id: 'export', label: '/导出', description: '导出对话' },
  { id: 'model', label: '/模型', description: '切换模型' },
  { id: 'theme', label: '/主题', description: '更换主题' },
  { id: 'review', label: '/审查', description: '审查代码变更' },
  { id: 'commit', label: '/提交', description: '生成提交信息' },
  { id: 'agents', label: '/智能体', description: '管理智能体' },
  { id: 'mcp', label: '/mcp', description: 'MCP 服务器管理' },
  { id: 'memory', label: '/记忆', description: '打开记忆文件' },
  { id: 'init', label: '/初始化', description: '初始化项目配置' },
]

export function ChatInput({ conversationId }: Props) {
  const [value, setValue] = useState('')
  const [undoStack, setUndoStack] = useState<string[]>([])
  const [redoStack, setRedoStack] = useState<string[]>([])
  const _skipUndo = useRef(false)
  const _prevValueRef = useRef('')
  // Reset undo/redo stacks on conversation switch
  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
    _prevValueRef.current = ''
  }, [conversationId])
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [selectedCommandIdx, setSelectedCommandIdx] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [voiceActive, setVoiceActive] = useState(false)
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [skillsDir, setSkillsDir] = useState('~/.yfworking/skills')
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [showScheduleGuide, setShowScheduleGuide] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const voiceBaseRef = useRef('')
  const stopStreaming = useChatStore(s => s.stopStreaming)
  const pendingResend = useChatStore(s => s.pendingResend)
  const consumePendingResend = useChatStore(s => s.consumePendingResend)
  // 只取 cwd 字符串：会话消息内容（流式 token）变化时该 selector 结果不变，
  // 输入框不会跟着每 token 重渲染（重渲染会重建输入法/撤销栈等本地状态）
  const projectRoot = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.cwd || '.')
  const streamingConversations = useChatStore(s => s.streamingConversations)
  const isStreaming = !!streamingConversations[conversationId]
  const settings = useSettingsStore(s => s.settings)
  const [isDragOver, setIsDragOver] = useState(false)
  const { send, stop, interject, setEffort } = useYFWCLI()
  // 思考深度档位（对齐内核 /effort：auto 默认 = 模型原生自适应）。初始取当前
  // provider 配置的 effortLevel（设置页"推理深度"），点击循环切换并热下发内核。
  const providerEffort = settings.providers.find(p => p.id === settings.activeProvider)?.effortLevel || 'auto'
  const [effort, setEffortLocal] = useState(providerEffort || 'auto')
  const EFFORT_CYCLE = ['auto', 'off', 'low', 'medium', 'high', 'max']
  const cycleEffort = useCallback(() => {
    const next = EFFORT_CYCLE[(EFFORT_CYCLE.indexOf(effort) + 1) % EFFORT_CYCLE.length]
    setEffortLocal(next)
    setEffort(conversationId, next)
  }, [effort, conversationId, setEffort])
  const pendingAttachments = useUIStore(s => s.pendingAttachments)
  const clearPendingAttachments = useUIStore(s => s.clearPendingAttachments)
  const pendingInput = useUIStore(s => s.pendingInput)
  const pendingAutoSend = useUIStore(s => s.pendingAutoSend)
  const setPendingInput = useUIStore(s => s.setPendingInput)
  const health = useHealthStore(s => s.healthBySession[conversationId]) ?? null
  const pinnedSkills = useUIStore(s => s.pinnedSkills)
  const scheduleGuideFor = useUIStore(s => s.scheduleGuideFor)
  const setScheduleGuideFor = useUIStore(s => s.setScheduleGuideFor)
  const { t } = useTranslation()

  // Load skills for autocomplete
  useEffect(() => {
    fetchSkills(projectRoot, setSkillsDir).then(setSkills)
  }, [projectRoot])

  // Merge hardcoded commands + loaded skills
  const baseCommands = settings.language === 'zh-CN' ? SLASH_COMMANDS_ZH : SLASH_COMMANDS_EN
  const skillCommands: { id: string; label: string; description: string; isSkill: boolean }[] = skills.map(s => ({
    id: s.id,
    label: '/' + s.id,
    description: s.description,
    isSkill: true,
  }))
  const slashCommands = [
    ...baseCommands.map(c => ({ ...c, isSkill: false })),
    ...skillCommands,
  ]

  // Consume pending attachments from FileBrowser
  useEffect(() => {
    if (pendingAttachments.length > 0) {
      setAttachments(prev => [...prev, ...pendingAttachments])
      clearPendingAttachments()
    }
  }, [pendingAttachments])

  // 新建"定时任务"会话：目标会话自动弹出引导面板（一次性触发，随后清除标记）
  useEffect(() => {
    if (scheduleGuideFor === conversationId) {
      setShowScheduleGuide(true)
      setScheduleGuideFor(null)
    }
  }, [scheduleGuideFor, conversationId, setScheduleGuideFor])

  const valueRef = useRef(value)
  valueRef.current = value

  // Consume pending input from SkillsPanel
  useEffect(() => {
    if (pendingInput) {
      _skipUndo.current = true
      const currentText = valueRef.current.trim()
      if (!pendingAutoSend && currentText) {
        setValue(pendingInput + ' ' + currentText)
      } else {
        setValue(pendingInput)
      }
      const autoSend = pendingAutoSend
      setPendingInput('')
      textareaRef.current?.focus()
      if (autoSend) {
        // Small delay to let the value set, then submit
        setTimeout(() => {
          send(conversationId, pendingInput)
          _skipUndo.current = true
          setValue('')
        }, 50)
      }
    }
  }, [pendingInput])

  // Consume pending resend request (triggered by retry button)
  useEffect(() => {
    if (!pendingResend || pendingResend.conversationId !== conversationId) return
    const text = pendingResend.text
    consumePendingResend()
    if (!isStreaming) {
      send(conversationId, text)
    }
  }, [pendingResend, conversationId])

  const filteredCommands = slashCommands.filter(c =>
    c.label.toLowerCase().includes(commandFilter.toLowerCase())
  )

  // ---- Auto-resize ----
  useEffect(() => {
    const el = textareaRef.current
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px' }
  }, [value])

  // ---- Slash command detection (support hyphens in skill names) ----
  useEffect(() => {
    const match = value.match(/^\/([\w-]*)$/)
    if (match) { setShowCommands(true); setCommandFilter(match[1] || ''); setSelectedCommandIdx(0) }
    else if (value.startsWith('/') && value.includes(' ')) { setShowCommands(false) }
    else { setShowCommands(false) }
  }, [value])

  // ---- Build prompt from text + attachments + active skill ----
  const buildPrompt = useCallback(() => {
    let prompt = value.trim()

    // Prepend skill invocation if active (path logic shared with SkillsPanel quickRun)
    if (activeSkill) {
      const skillPrompt = buildSkillPrompt(skillsDir, activeSkill)
      prompt = prompt ? `${skillPrompt}\n\n---\n\n${prompt}` : skillPrompt
    }

    if (attachments.length > 0) {
      const parts: string[] = [prompt]
      const pathFiles: string[] = []
      for (const att of attachments) {
        if (att.path) {
          const fullPath = att.path.replace(/\\/g, '/')
          if (att.type === 'image') {
            parts.push(`\n@image:${fullPath}`)
          } else {
            parts.push(`\n@file:${fullPath}`)
          }
          pathFiles.push(`  ${att.type === 'image' ? 'Image' : 'File'}: ${att.name} → ${fullPath}`)
        } else if (att.type === 'file') {
          const header = `\n--- @file: ${att.name} (无绝对路径，内容已内联) ---`
          parts.push(`${header}\n${att.content}`)
        } else if (att.type === 'image') {
          parts.push(`\n@image_inline:${att.name}`)
        }
      }
      if (pathFiles.length > 0) {
        parts.push(`\n\n【附件路径索引】\n${pathFiles.join('\n')}`)
      }
      prompt = parts.join('\n')
    }
    return prompt
  }, [value, attachments, activeSkill, skillsDir])

  const handleSubmit = useCallback(() => {
    const prompt = buildPrompt()
    if (!prompt) return

    // Intercept skill slash commands: /gxtz-xxx → proper skill invocation
    // (kept for backward compatibility with skill panel's insertSkill)
    const skillMatch = prompt.match(/^\/gxtz-([\w-]+)\s*$/)
    if (skillMatch) {
      const skillId = 'gxtz-' + skillMatch[1]
      send(conversationId, buildSkillPrompt(skillsDir, skillId))
      _skipUndo.current = true
      setValue('')
      setAttachments([])
      setActiveSkill(null)
      setShowCommands(false)
      return
    }

    send(conversationId, prompt)
    _skipUndo.current = true
    setValue('')
    setAttachments([])
    setActiveSkill(null)
    setShowCommands(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [buildPrompt, streamingConversations, conversationId, send, skillsDir])

  // 紧急插话：立即打断当前生成（含子 agent），携带输入内容作为新一轮执行
  const handleInterject = useCallback(() => {
    const prompt = buildPrompt()
    if (!prompt) return
    interject(conversationId, prompt)
    _skipUndo.current = true
    setValue('')
    setAttachments([])
    setActiveSkill(null)
    setShowCommands(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [buildPrompt, conversationId, interject])

  // Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Y（或 Shift+Z）重做——两栈互推，仅 pop/push 目标互换
  // 副作用（push/setValue/setTimeout）必须在 updater 之外：StrictMode 下 updater
  // 会被双调，副作用在 updater 内会把 value 推入对面栈两次（撤销后再重做弹出重复值）。
  const handleHistory = (mode: 'undo' | 'redo') => {
    const stack = mode === 'undo' ? undoStack : redoStack
    const setStack = mode === 'undo' ? setUndoStack : setRedoStack
    const setOther = mode === 'undo' ? setRedoStack : setUndoStack
    if (stack.length === 0) return
    const restored = stack[stack.length - 1]
    setOther(r => [...r, value])
    _skipUndo.current = true
    _prevValueRef.current = restored
    setValue(restored)
    setStack(prev => prev.slice(0, -1))
    // Restore cursor to end after React re-render
    setTimeout(() => {
      const el = textareaRef.current
      if (el) { el.selectionStart = el.selectionEnd = restored.length }
    }, 0)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      handleHistory('undo')
      return
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault()
      handleHistory('redo')
      return
    }
    // 打断插话快捷键（默认 Ctrl+Enter，可在设置中自定义）：
    // 任务生成中 = 立即打断当前轮（含子 agent）并以输入内容继续；空闲时 = 等同普通发送。
    if (matchShortcut(e, settings.interjectShortcut)) {
      e.preventDefault()
      if (isStreaming) handleInterject()
      else handleSubmit()
      return
    }
    if (showCommands) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedCommandIdx(i => Math.min(i + 1, filteredCommands.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedCommandIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[selectedCommandIdx]
        if (cmd) { _skipUndo.current = true; setValue(cmd.label + ' '); setShowCommands(false); textareaRef.current?.focus() }
        return
      }
      if (e.key === 'Escape') { setShowCommands(false); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && settings.sendOnEnter) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // (handleFilePick & handleImagePick moved after addFilesFromList)
  const readBlob = (blob: Blob, mode: 'dataurl' | 'text'): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    if (mode === 'dataurl') reader.readAsDataURL(blob)
    else reader.readAsText(blob)
  })

  // ---- Paste image / file from clipboard ----
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue
        const blob = item.getAsFile()
        if (!blob) continue
        e.preventDefault()
        // Image paste
        if (item.type.startsWith('image/')) {
          const ext = item.type.split('/')[1] || 'png'
          const dataUrl = await readBlob(blob, 'dataurl')
          const base64 = dataUrl.split(',')[1]
          try {
            const res = await fetch(`${getBridgeUrl()}/save-temp-image`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: base64, ext }),
            })
            const data = await res.json()
            if (data.ok && data.path) {
              setAttachments(prev => [...prev, {
                id: Date.now().toString() + Math.random(),
                name: `pasted-image.${ext}`,
                type: 'image',
                content: data.path,
                path: data.path,
                preview: dataUrl,
              }])
              return
            }
          } catch {}
          setAttachments(prev => [...prev, {
            id: Date.now().toString() + Math.random(),
            name: `pasted-image.${ext}`,
            type: 'image',
            content: dataUrl,
            preview: dataUrl,
          }])
        } else {
          // File paste (non-image): read as text if small enough
          const name = (blob as File).name || `pasted-file`
          try {
            const text = await readBlob(blob, 'text')
            setAttachments(prev => [...prev, {
              id: Date.now().toString() + Math.random(),
              name,
              type: 'file',
              content: text,
            }])
          } catch {
            setAttachments(prev => [...prev, {
              id: Date.now().toString() + Math.random(),
              name,
              type: 'file',
              content: `[Binary file: ${name}, ${formatSize(blob.size)} — 无法读取内容]`,
            }])
          }
        }
      }
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [])

  // ---- Voice input (Web Speech API) ----
  const toggleVoice = useCallback(() => {
    if (voiceActive) {
      recognitionRef.current?.stop()
      setVoiceActive(false)
      return
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser.')
      return
    }
    const rec = new SpeechRecognition()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = settings.language === 'zh-CN' ? 'zh-CN' : 'en-US'
    voiceBaseRef.current = value
    rec.onresult = (e: any) => {
      let transcript = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript
      }
      _skipUndo.current = true
      setValue(voiceBaseRef.current + transcript)
    }
    rec.onerror = () => { setVoiceActive(false) }
    rec.onend = () => { setVoiceActive(false) }
    rec.start()
    recognitionRef.current = rec
    setVoiceActive(true)
  }, [voiceActive])

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  const activeSkillEntry = skills.find(s => s.id === activeSkill)

  const addFilesFromList = useCallback((files: FileList | File[]) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const ext = file.name.split('.').pop()?.toLowerCase() || ''
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
      const isText = ['txt', 'md', 'json', 'xml', 'csv', 'yml', 'yaml', 'toml', 'ini',
        'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less',
        'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'bat', 'ps1',
        'sql', 'env', 'cfg', 'conf', 'log'].includes(ext)
      const filePath = (file as any).path as string | undefined
      if (filePath) {
        setAttachments(prev => [...prev, {
          id: Date.now().toString() + Math.random(),
          name: file.name,
          type: isImage ? 'image' : 'file',
          content: filePath,
          path: filePath,
        }])
      } else if (isImage) {
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            id: Date.now().toString() + Math.random(),
            name: file.name,
            type: 'image',
            content: reader.result as string,
            preview: reader.result as string,
          }])
        }
        reader.readAsDataURL(file)
      } else if (isText) {
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            id: Date.now().toString() + Math.random(),
            name: file.name,
            type: 'file',
            content: (reader.result as string).slice(0, 50000),
          }])
        }
        reader.readAsText(file)
      } else {
        setAttachments(prev => [...prev, {
          id: Date.now().toString() + Math.random(),
          name: file.name,
          type: 'file',
          content: `[Binary: ${file.name}, ${formatSize(file.size)}]`,
        }])
      }
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesFromList(e.dataTransfer.files)
    }
  }, [addFilesFromList])

  const handleFilePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFilesFromList(e.target.files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [addFilesFromList])

  const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFilesFromList(e.target.files)
    if (imageInputRef.current) imageInputRef.current.value = ''
  }, [addFilesFromList])

  return (
    <div className="relative z-0 border-t bg-app">
      {/* Slash command menu */}
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-2 right-2 mb-1 bg-elevated border border rounded-lg shadow-2xl overflow-hidden animate-slide-up z-30 max-h-52 overflow-y-auto">
          {/* Section header for skills */}
          {filteredCommands.some(c => (c as any).isSkill) && (
            <div className="px-3 py-1.5 text-[10px] font-semibold text-tertiary uppercase tracking-wider border-b border-subtle">
              Skills ({filteredCommands.filter(c => (c as any).isSkill).length})
            </div>
          )}
          {filteredCommands.map((cmd, i) => {
            const isSkill = (cmd as any).isSkill
            return (
              <button
                key={cmd.id}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors',
                  i === selectedCommandIdx ? 'bg-brand-500/20 text-primary' : 'text-secondary hover:bg-input'
                )}
                onClick={() => { _skipUndo.current = true; setValue(cmd.label + ' '); setShowCommands(false); textareaRef.current?.focus() }}
              >
                {isSkill ? (
                  <Zap className="w-3.5 h-3.5 text-brand-500/80 shrink-0" />
                ) : (
                  <Command className="w-3.5 h-3.5 text-brand-500/85 shrink-0" />
                )}
                <span className="font-mono text-xs">{cmd.label}</span>
                <span className="text-tertiary text-xs ml-auto truncate max-w-[120px]">{cmd.description}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Active skill badge */}
      {activeSkillEntry && (
        <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">
          <span className="flex items-center gap-1.5 bg-brand-500/15 border border-brand-500/30 rounded-lg px-2.5 py-1 text-xs">
            <Zap className="w-3 h-3 text-brand-500" />
            <span className="font-medium text-brand-500/90">{activeSkillEntry.id}</span>
            <span className="text-[10px] text-brand-500/60">· {activeSkillEntry.version}</span>
          </span>
          <button
            onClick={() => setActiveSkill(null)}
            className="p-0.5 rounded hover:bg-elevated text-tertiary hover:text-primary transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
          <span className="text-[10px] text-tertiary ml-auto">发送时将自动注入技能启动指令</span>
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-1">
          {attachments.map(att => (
            <div key={att.id} className="relative group flex items-center gap-1.5 bg-elevated border border rounded-md px-2 py-1 text-xs text-secondary max-w-[200px]">
              {att.type === 'image' && att.preview ? (
                <img src={att.preview} alt={att.name} className="w-5 h-5 rounded object-cover" />
              ) : (
                <Paperclip className="w-3.5 h-3.5 text-tertiary shrink-0" />
              )}
              <span className="truncate">{att.name}</span>
              <button onClick={() => removeAttachment(att.id)} className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-input transition-opacity">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input bar — composer card */}
      <div className="px-3 pt-2 pb-1.5">
        <div
          className={cn(
            'relative flex items-end gap-2 rounded-xl border border bg-surface/80 px-2.5 py-1.5',
            'transition-all duration-150',
            'focus-within:border-brand-500/40 focus-within:ring-1 focus-within:ring-brand-500/25',
            'focus-within:bg-surface',
            isDragOver && 'border-brand-500/60 ring-1 ring-brand-500/40 bg-brand-500/5'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-brand-500/10 pointer-events-none">
            <span className="text-sm font-medium text-brand-500">释放以添加附件</span>
          </div>
        )}
        {/* Left toolbar */}
        <div className="flex items-center gap-0.5 pb-0.5">
          {/* 思考深度切换：点击循环 auto→off→low→medium→high→max，下一轮生效 */}
          <Tooltip content={t('chat.effort') + `（${effort}${effort === 'auto' ? ' · ' + t('chat.effortAuto') : ''}，下一轮生效）`}>
            <Button
              variant="ghost"
              size="xs"
              className={cn('text-tertiary hover:text-secondary', effort !== 'auto' && 'text-brand-500 hover:text-brand-500')}
              onClick={cycleEffort}
              aria-label="思考深度"
            >
              <BrainCircuit className={cn('w-4 h-4', effort !== 'auto' && 'text-brand-500')} />
              <span className="text-[10px] font-mono">{effort}</span>
            </Button>
          </Tooltip>
          {/* Skill picker button */}
          {skills.length > 0 && (
            <>
              <Tooltip content={activeSkill ? '切换技能' : '选择技能'}>
                <Button
                  variant="ghost"
                  size="xs"
                  className={cn('text-tertiary hover:text-secondary', activeSkill && 'text-brand-500 hover:text-brand-500')}
                  onClick={() => setShowSkillPicker(v => !v)}
                  aria-label="选择技能"
                >
                  <Zap className={cn('w-4 h-4', activeSkill && 'text-brand-500')} />
                </Button>
              </Tooltip>
            </>
          )}

          {/* 循环 / 定时任务 */}
          <Tooltip content="循环任务 / 定时任务">
            <Button
              variant="ghost"
              size="xs"
              className={cn('text-tertiary hover:text-secondary', showScheduleGuide && 'text-brand-500')}
              onClick={() => setShowScheduleGuide(v => !v)}
              aria-label="循环任务 / 定时任务"
            >
              <Repeat className="w-4 h-4" />
            </Button>
          </Tooltip>

          {/* File attachment */}
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
          <Tooltip content={t('chat.attachFile')}>
            <Button variant="ghost" size="xs" className="text-tertiary hover:text-secondary" onClick={() => fileInputRef.current?.click()} aria-label={t('chat.attachFile')}>
              <Paperclip className="w-4 h-4" />
            </Button>
          </Tooltip>

          {/* AI 绘图（替代原附加图片按钮；剪贴板粘贴图片与文件选择能力保留） */}
          <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImagePick} />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs" className="text-tertiary hover:text-secondary" aria-label={t('chat.attachImage')}>
                <Sparkles className="w-4 h-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="z-50 w-auto p-0 bg-popover backdrop-blur-xl border border-default rounded-xl shadow-xl">
              <DoubaoPanel
                onInsertImage={(att) => {
                  // 豆包生成图为 bridge 本地去水印图：path 为磁盘绝对路径（旧版/历史项兜底为图片 URL），
                  // 经 @image:<path> 发内核时 CLI 按本地文件路径解析，preview 用 bridge URL 渲染
                  setAttachments(prev => [...prev, {
                    id: generateId(), name: att.name, type: 'image' as const,
                    content: '', path: att.path, preview: att.preview || att.path,
                  }])
                }}
              />
            </PopoverContent>
          </Popover>

          {/* Voice input */}
          <Tooltip content={voiceActive ? t('chat.voiceStop') : t('chat.voiceInput')}>
            <Button
              variant="ghost"
              size="xs"
              className={cn('text-tertiary hover:text-secondary', voiceActive && 'text-error animate-pulse')}
              onClick={toggleVoice}
              aria-label={voiceActive ? t('chat.voiceStop') : t('chat.voiceInput')}
            >
              {voiceActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </Button>
          </Tooltip>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => {
            const newVal = e.target.value
            if (!_skipUndo.current) {
              setUndoStack(prev => {
                if (prev.length > 0 && prev[prev.length - 1] === newVal) return prev
                return [...prev.slice(-49), _prevValueRef.current]
              })
              setRedoStack([])
            }
            _prevValueRef.current = newVal
            _skipUndo.current = false
            setValue(newVal)
          }}
          onKeyDown={handleKeyDown}
          placeholder={activeSkill ? `输入任务描述，将使用 ${activeSkill} 技能执行...` : (voiceActive ? t('chat.thinking') : t('chat.inputPlaceholder'))}
          rows={1}
          className={cn(
            'flex-1 bg-transparent border-0 text-sm text-primary placeholder:text-tertiary',
            'resize-none focus:outline-none min-h-[28px] max-h-[160px] py-1',
            'font-sans'
          )}
          disabled={voiceActive}
        />

        {/* Send/Stop */}
        {isStreaming ? (
          <div className="flex items-center gap-1.5">
            {/* 插话按钮 = 排队插话（不打断）：与回车同效，等当前轮结束后处理；打断请用快捷键 */}
            <Tooltip content={t('chat.interjectQueue') + ' · ' + t('chat.sendHintStreaming', { shortcut: formatShortcut(settings.interjectShortcut) })}>
              <Button variant="outline" size="sm" onClick={handleSubmit} disabled={!value.trim() && attachments.length === 0 && !activeSkill} aria-label={t('chat.interject')}>
                <MessageSquarePlus className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t('chat.stop') + ' (Esc)'}>
              <Button variant="danger" size="sm" onClick={() => { stop(conversationId); stopStreaming(conversationId) }} aria-label={t('chat.stop')}>
                <StopCircle className="w-4 h-4" />
              </Button>
            </Tooltip>
          </div>
        ) : (
          <Tooltip content={t('chat.send') + ' (Enter)'}>
            <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!value.trim() && attachments.length === 0 && !activeSkill} className="rounded-lg" aria-label={t('chat.send')}>
              <Send className="w-4 h-4" />
            </Button>
          </Tooltip>
        )}
        </div>

        {/* Composer hint — reserved height so it never shifts the layout */}
        <div className="relative flex items-center gap-2 h-4 mt-1 px-1 select-none">
          {/* 血条占剩余宽度，右侧文字独立留位（shrink-0 不挤压） */}
          <div className="flex-1 min-w-0 h-full relative">
            <HealthMeter conversationId={conversationId} />
          </div>
          {health ? (
            <span className="shrink-0 text-[11px] leading-none text-tertiary/80 tabular-nums">
              {t('health.remainingPct', { pct: health.remainingPct })}
            </span>
          ) : (
            !value.trim() && attachments.length === 0 && !activeSkill && (
              <span className="shrink-0 text-[11px] leading-none text-tertiary/80">
                {isStreaming
                  ? t('chat.sendHintStreaming', { shortcut: formatShortcut(settings.interjectShortcut) })
                  : t('chat.sendHint')}
              </span>
            )
          )}
        </div>
      </div>

      {/* 循环/定时任务引导面板 */}
      {showScheduleGuide && (
        <ScheduleGuide
          conversationId={conversationId}
          mode="loop"
          onClose={() => setShowScheduleGuide(false)}
        />
      )}

      {/* 红档"重新发起会话建议"卡片：从输入框右下角向上浮出 */}
      <HealthSuggestCard
        conversationId={conversationId}
        onStopSource={() => { stop(conversationId); stopStreaming(conversationId) }}
      />

      {/* Skill picker panel — rendered after input bar, positioned above */}
      {showSkillPicker && (
        <div
          className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-popover border border rounded-xl shadow-2xl animate-slide-up z-40 overflow-hidden"
          style={{ maxHeight: '240px' }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-subtle bg-elevated">
            <span className="text-xs font-semibold text-primary">常用技能</span>
            <button onClick={() => setShowSkillPicker(false)} className="text-tertiary hover:text-primary">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: '200px' }}>
            {pinnedSkills.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-tertiary">暂无收藏的常用技能</p>
                <p className="text-[10px] text-tertiary/60 mt-1">请在左侧技能面板中点击星标收藏</p>
              </div>
            ) : (
              skills.filter(s => pinnedSkills.includes(s.id)).map(skill => (
                <button
                  key={skill.id}
                  onClick={() => { setActiveSkill(skill.id); setShowSkillPicker(false); textareaRef.current?.focus() }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    activeSkill === skill.id
                      ? 'bg-brand-500/10 text-primary'
                      : 'text-secondary hover:bg-elevated'
                  )}
                >
                  <Zap className={cn(
                    'w-3.5 h-3.5 shrink-0',
                    activeSkill === skill.id ? 'text-brand-500' : 'text-tertiary'
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium">{skill.id}</span>
                      <span className="text-[9px] text-tertiary font-mono">{skill.version}</span>
                    </div>
                    <p className="text-[10px] text-tertiary line-clamp-1 mt-0.5">{skill.description}</p>
                  </div>
                  {activeSkill === skill.id && (
                    <span className="text-[9px] text-brand-500 font-medium">已选</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
