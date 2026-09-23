import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * The only shared pieces. Three components, no variants beyond tone and size:
 * anything that needs more is a one-off, and one-offs live where they are
 * used instead of growing here.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'ghost'
}

export function Button({ variant = 'ghost', className = '', type = 'button', ...props }: ButtonProps) {
  const tones = {
    primary: 'bg-primary text-on-primary hover:opacity-90 font-medium shadow-sm',
    danger: 'text-error hover:bg-error-container/30',
    ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
  } as const
  return <button type={type} className={`px-3.5 py-1.5 rounded-lg text-label-md transition-colors disabled:opacity-40 ${tones[variant]} ${className}`} {...props} />
}

const CHIP_TONES = {
  ok: 'text-secondary bg-secondary/10',
  busy: 'text-primary bg-primary/10',
  bad: 'text-error bg-error/10',
  idle: 'text-on-surface-variant bg-surface-container',
  plan: 'text-primary bg-primary-container/30',
} as const

export function Chip({ tone = 'idle', children }: { tone?: keyof typeof CHIP_TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-label-sm ${CHIP_TONES[tone]}`}>{children}</span>
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-surface-container-low rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-label-lg font-semibold text-on-surface">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: string; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3 max-w-md px-4">
        <span className="material-symbols-outlined text-5xl text-primary" aria-hidden="true">{icon}</span>
        <h2 className="text-headline-md text-on-surface">{title}</h2>
        <p className="text-body-md text-on-surface-variant">{body}</p>
        {action}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label-sm text-outline uppercase tracking-wider">{label}</span>
      {children}
      {hint ? <span className="text-label-sm text-outline">{hint}</span> : null}
    </label>
  )
}

export const inputClass = 'bg-surface-container-lowest px-3 py-2 rounded-lg text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary'
export const selectClass = 'bg-surface-container-lowest px-3 py-1.5 rounded-lg text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary min-w-[180px]'
