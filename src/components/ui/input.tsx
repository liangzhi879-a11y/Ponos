import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  error?: string
  label?: string
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, leftIcon, rightIcon, error, label, id, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={id} className="block text-xs font-medium text-secondary mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none">
              {leftIcon}
            </div>
          )}
          <input
            type={type}
            id={id}
            className={cn(
              'flex h-9 w-full rounded-md border bg-input px-3 py-2 text-sm text-primary',
              'placeholder:text-tertiary',
              'focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'transition-colors duration-150',
              error ? 'border-error/50 focus:ring-error' : 'border',
              leftIcon && 'pl-9',
              rightIcon && 'pr-9',
              className
            )}
            ref={ref}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary">
              {rightIcon}
            </div>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-error">{error}</p>}
      </div>
    )
  }
)
Input.displayName = 'Input'

export { Input }
