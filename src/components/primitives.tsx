import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * The only shared pieces. Three components, no variants beyond tone:
 * anything that needs more is a one-off, and one-offs live where they are
 * used instead of growing here.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost'
}

export function Button({ variant = 'ghost', className = '', type = 'button', ...props }: ButtonProps) {
  const tones = {
    primary: 'bg-primary text-on-primary font-medium shadow-sm hover:shadow-glow-primary',
    danger: 'text-error border border-outline-variant/40 hover:bg-error-container/30 hover:border-error/40',
    ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
  } as const
  return <button type={type} className={`inline-flex items-center justify-center gap-1.5 min-h-8 px-3.5 py-1.5 rounded-lg text-label-md transition-colors disabled:opacity-40 ${tones[variant]} ${className}`} {...props} />
}

const CHIP_TONES = {
  ok: 'text-secondary bg-secondary/10',
  busy: 'text-primary bg-primary/10',
  bad: 'text-error bg-error/10',
  idle: 'text-on-surface-variant bg-surface-container',
  plan: 'text-primary bg-primary-container/30',
} as const

export function Chip({ tone = 'idle', children }: { tone?: keyof typeof CHIP_TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 min-h-5 px-1.5 py-0.5 rounded-[4px] font-mono text-label-sm uppercase ${CHIP_TONES[tone]}`}>{children}</span>
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-surface-container-low rounded-lg border border-outline-variant/40 p-4 flex flex-col gap-3 min-w-0" aria-label={title}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-mono uppercase text-label-sm text-on-surface-variant">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3 max-w-md px-4">
        <Icon name={icon} className="text-5xl text-primary" />
        <h2 className="text-headline-md text-on-surface">{title}</h2>
        <p className="text-body-md text-on-surface-variant">{body}</p>
        {action}
      </div>
    </div>
  )
}

export const inputClass = 'min-w-0 max-w-full bg-surface-container-lowest border border-outline-variant/60 px-3 py-2 rounded-lg text-body-md text-on-surface placeholder:text-outline hover:border-outline-variant focus:outline-none focus:ring-1 focus:ring-primary focus:border-transparent'
export const selectClass = 'max-w-full min-h-8 bg-surface-container-lowest border border-outline-variant/60 px-3 py-1.5 rounded-lg text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary focus:border-transparent min-w-[180px]'
