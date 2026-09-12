import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, StopCircle, Paperclip, ImagePlus, Mic, MicOff, Command, X, Zap, Repeat, MessageCirclePlus } from 'lucide-react'
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
import { getBridgeUrl, getDefaultHome } from '@/lib/config'
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
  const projectRoot = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId)?.cwd || getDefaultHome())
  const streamingConversations = useChatStore(s => s.streamingConversations)
  const isStreaming = !!streamingConversations[conversationId]
  // 2026-09-10 主标签化：chat 会话为纯聊受限形态——技能选择/定时任务等
  // 任务型输入功能随之隐藏（同步欢迎页移除目录选择的收敛语义）
  const isChatMode = useChatStore(s => s.conversations.find(c => c.id === conversationId)?.mode === 'chat')
  const settings = useSettingsStore(s => s.settings)
  const [isDragOver, setIsDragOver] = useState(false)
  const { send, stop, interject, applyAnchor } = useYFWCLI()
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
        <div className="absolute bottom-full left-2 right-2 mb-1 cut-sm animate-slide-up z-30" style={{ filter: 'drop-shadow(var(--modal-drop))' }}>
          <div className="ci overflow-y-auto" style={{ maxHeight: '13rem', background: 'var(--bg-elevated)' }}>
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

      {/* 失真"证据 + 两级动作"卡片：输入框上方正常流式排版（2026-09-10 修复：
          卡片改 in-flow 右对齐，挂载于输入条之前——绝不再叠住发送键）
          触发已换轴：只有上下文失真红档才弹（压力档只作血条仪表） */}
      <HealthSuggestCard
        conversationId={conversationId}
        onStopSource={() => { stop(conversationId); stopStreaming(conversationId) }}
        onAnchorApplied={(ids) => applyAnchor(conversationId, ids)}
      />

      {/* Input bar — composer card（设计语言：单对角切角框 + 聚焦热边 .focusable） */}
      <div className="px-3 pt-2 pb-1.5">
        <div
          className={cn(
            'relative cut focusable transition-all duration-150',
            isDragOver && 'hot'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
        <div className="ci flex items-end gap-2 w-full px-2.5 py-1.5">
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand-500/10 pointer-events-none">
            <span className="text-sm font-medium text-brand-500">释放以添加附件</span>
          </div>
        )}
        {/* Left toolbar */}
        <div className="flex items-center gap-0.5 pb-0.5">
          {/* Skill picker button（chat 纯聊形态隐藏：技能属任务型功能，2026-09-10） */}
          {!isChatMode && skills.length > 0 && (
            <>
              <Tooltip content={activeSkill ? '切换技能' : '选择技能'}>
                <Button
                  variant="ghost"
                  size="xs"
                  className={cn('text-tertiary hover:text-secondary', activeSkill && 'text-brand-500 hover:text-brand-500')}
                  onClick={() => setShowSkillPicker(v => !v)}
                  aria-label="选择技能"
                >
                  <Zap className={cn('w-3.5 h-3.5', activeSkill && 'text-brand-500')} />
                </Button>
              </Tooltip>
            </>
          )}

          {/* 循环 / 定时任务（chat 纯聊形态隐藏：定时任务=任务型功能，2026-09-10） */}
          {!isChatMode && (
            <Tooltip content="循环任务 / 定时任务">
              <Button
                variant="ghost"
                size="xs"
                className={cn('text-tertiary hover:text-secondary', showScheduleGuide && 'text-brand-500')}
                onClick={() => setShowScheduleGuide(v => !v)}
                aria-label="循环任务 / 定时任务"
              >
                <Repeat className="w-3.5 h-3.5" />
              </Button>
            </Tooltip>
          )}

          {/* File attachment */}
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
          <Tooltip content={t('chat.attachFile')}>
            <Button variant="ghost" size="xs" className="text-tertiary hover:text-secondary" onClick={() => fileInputRef.current?.click()} aria-label={t('chat.attachFile')}>
              <Paperclip className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>

          {/* 附加图片（2026-09-10：豆包生图功能已全面移除，恢复普通本地图片选择） */}
          <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleImagePick} />
          <Tooltip content={t('chat.attachImage')}>
            <Button variant="ghost" size="xs" className="text-tertiary hover:text-secondary" onClick={() => imageInputRef.current?.click()} aria-label={t('chat.attachImage')}>
              <ImagePlus className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>

          {/* Voice input */}
          <Tooltip content={voiceActive ? t('chat.voiceStop') : t('chat.voiceInput')}>
            <Button
              variant="ghost"
              size="xs"
              className={cn('text-tertiary hover:text-secondary', voiceActive && 'text-error animate-pulse')}
              onClick={toggleVoice}
              aria-label={voiceActive ? t('chat.voiceStop') : t('chat.voiceInput')}
            >
              {voiceActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
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
            'flex-1 bg-transparent border-0 text-[13px] text-primary placeholder:text-tertiary',
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
                {/* 排队插话=MessageCirclePlus（圆泡+加，圆/方区分）；MessageSquarePlus 已保留给「新建对话」（ChatListPanel/PanelToolbar/CommandPalette），勿跨义复用（§8.2 Task 15 裁决） */}
                <MessageCirclePlus className="w-3.5 h-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content={t('chat.stop') + ' (Esc)'}>
              <Button variant="danger" size="sm" onClick={() => { stop(conversationId); stopStreaming(conversationId) }} aria-label={t('chat.stop')}>
                <StopCircle className="w-3.5 h-3.5" />
              </Button>
            </Tooltip>
          </div>
        ) : (
          <Tooltip content={t('chat.send') + ' (Enter)'}>
            {/* 发送钮 = cut-btn 切角细线框 + 品牌渐变内层（设计语言：主 CTA） */}
            <button
              onClick={handleSubmit}
              disabled={!value.trim() && attachments.length === 0 && !activeSkill}
              className="cut-btn h-8 w-8 shrink-0 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={t('chat.send')}
            >
              <span className="ci grad-brand flex items-center justify-center w-full h-full text-white">
                <Send className="w-3.5 h-3.5" />
              </span>
            </button>
          </Tooltip>
        )}
        </div>
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

      {/* Skill picker panel — rendered after input bar, positioned above */}
      {showSkillPicker && (
        <div
          className="absolute bottom-full left-0 right-0 mb-1 mx-3 cut-sm animate-slide-up z-40"
          style={{ filter: 'drop-shadow(var(--modal-drop))' }}
        >
          <div className="ci overflow-hidden" style={{ maxHeight: '240px', background: 'var(--popover-bg)' }}>
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
        </div>
      )}
    </div>
  )
}
