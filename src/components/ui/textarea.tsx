import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string
  label?: string
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, label, id, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={id} className="block text-xs font-medium text-secondary mb-1.5">
            {label}
          </label>
        )}
        <textarea
          id={id}
          className={cn(
            'flex min-h-[80px] w-full rounded-md border bg-input px-3 py-2 text-sm text-primary',
            'placeholder:text-tertiary',
            'focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'transition-colors duration-150 resize-y',
            error ? 'border-error/50 focus:ring-error' : 'border',
            className
          )}
          ref={ref}
          {...props}
        />
        {error && <p className="mt-1 text-xs text-error">{error}</p>}
      </div>
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
