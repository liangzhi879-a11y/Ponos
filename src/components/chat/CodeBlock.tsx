import { useState } from 'react'
import { Check, Copy, FileCode } from 'lucide-react'
import { Button } from '@/components/ui'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  code: string
  language?: string
  filename?: string
}

export function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-3 rounded-lg border border overflow-hidden bg-modal max-w-full min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-elevated border-b">
        <div className="flex items-center gap-2 text-xs text-tertiary">
          <FileCode className="w-3.5 h-3.5" />
          <span className="font-mono text-[11px] uppercase tracking-wider">
            {filename || language || 'code'}
          </span>
        </div>
        <Tooltip content={copied ? 'Copied!' : 'Copy code'}>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleCopy}
            className="text-tertiary hover:text-secondary"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success/80" /> : <Copy className="w-3.5 h-3.5" />}
          </Button>
        </Tooltip>
      </div>

      {/* Code content — bg-code + code-text guarantee contrast in both themes */}
      <div className="overflow-x-auto bg-code">
        <pre className={cn('p-4 text-[13px] leading-relaxed font-mono text-code-text', language && `language-${language}`)}>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}
