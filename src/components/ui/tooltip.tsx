import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const TooltipRoot = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md border border-default px-2.5 py-1.5',
        'text-xs font-medium',
        'animate-slide-up data-[state=closed]:animate-fade-out',
        'shadow-lg backdrop-blur-md',
        className
      )}
      style={{
        color: 'var(--tooltip-fg)',
        background: 'var(--tooltip-bg)',
        backdropFilter: 'blur(var(--popover-blur))',
        WebkitBackdropFilter: 'blur(var(--popover-blur))',
      }}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  delay?: number
  side?: 'top' | 'right' | 'bottom' | 'left'
}

function Tooltip({ content, children, delay = 300, side = 'top' }: TooltipProps) {
  return (
    <TooltipRoot delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  )
}

export { Tooltip, TooltipProvider }
