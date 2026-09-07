import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  cn(
    'glass-btn inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium',
    'transition-all duration-150 select-none no-drag',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        primary:
          'bg-brand-500 text-inverse hover:bg-brand-600 active:bg-brand-700 shadow-sm',
        secondary:
          'bg-elevated text-primary border border hover:bg-hover active:bg-active',
        ghost:
          'text-secondary hover:text-primary hover:bg-hover active:bg-active',
        danger:
          'bg-error/15 text-error hover:bg-error/25 active:bg-error/30 border border-error/30',
        success:
          'bg-success/15 text-success hover:bg-success/25 border border-success/30',
        outline:
          'border border text-secondary hover:text-primary hover:bg-hover active:bg-active',
        link:
          'text-brand-500 hover:text-brand-600 underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-7 rounded px-2 text-xs gap-1',
        sm: 'h-8 rounded-md px-3 text-xs gap-1.5',
        md: 'h-9 rounded-md px-4 text-sm gap-2',
        lg: 'h-10 rounded-md px-5 text-sm gap-2',
        xl: 'h-12 rounded-lg px-6 text-base gap-2.5',
        icon: 'h-8 w-8 rounded-md p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, leftIcon, rightIcon, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : leftIcon}
        {children}
        {rightIcon}
      </Comp>
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
