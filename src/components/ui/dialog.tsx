import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50',
      'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
      className
    )}
    style={{
      backgroundColor: 'var(--overlay-bg)',
      backdropFilter: `blur(var(--overlay-blur))`,
      WebkitBackdropFilter: `blur(var(--overlay-blur))`,
      ...style,
    }}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { size?: 'sm' | 'md' | 'lg' | 'xl' }
>(({ className, children, size = 'md', ...props }, ref) => {
  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]',
          'w-full cut cut-modal p-0',
          'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          'text-primary',
          sizes[size],
          className
        )}
        style={{
          // clip-path 会裁掉 box-shadow → 用 drop-shadow 随切角形
          filter: 'drop-shadow(var(--modal-drop))',
        }}
        {...props}
      >
        {/* ci 内层：modal 底 + 磨砂 blur（背景移出根，根只负责切角细线） */}
        <div
          className="ci flex flex-col"
          style={{
            background: 'var(--modal-bg)',
            backdropFilter: 'blur(var(--popover-blur))',
            WebkitBackdropFilter: 'blur(var(--popover-blur))',
          }}
        >
        {children}
        <DialogPrimitive.Close
          className={cn(
            'absolute right-3 top-3 z-10 rounded-md p-1',
            'text-tertiary hover:text-primary',
            'hover:bg-hover transition-colors duration-150',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = 'DialogContent'

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col gap-1 px-6 pt-6 pb-4 border-b border-subtle', className)}
    {...props}
  />
)

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold text-primary', className)}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-secondary', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'

const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-6 py-4', className)} {...props} />
)

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex items-center justify-end gap-2 px-6 py-4 border-t border-subtle bg-toolbar/50', className)}
    {...props}
  />
)

export {
  Dialog, DialogTrigger, DialogClose, DialogPortal,
  DialogOverlay, DialogContent, DialogHeader,
  DialogTitle, DialogDescription, DialogBody, DialogFooter,
}
