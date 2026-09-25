import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, inputClass } from './primitives'
import { Icon } from './Icon'

export function ProjectMenu({ bridge, onOpenChat }: { bridge: Bridge; onOpenChat: () => void }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const project = bridge.projects.find((entry) => entry.id === bridge.projectId)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    window.addEventListener('mousedown', outside)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape) }
  }, [open])

  return (
    <div className="relative min-w-0" ref={wrap}>
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls="project-menu"
        className="flex items-center gap-1 sm:gap-1.5 px-2 py-1.5 rounded-lg bg-surface-container text-label-md min-w-0 max-w-full hover:bg-surface-container-high"
        onClick={() => setOpen((current) => !current)}>
        <Icon name="folder_open" className="text-primary text-sm hidden sm:inline-block" />
        <span className="truncate max-w-24 sm:max-w-[180px]">{project?.name ?? 'No project'}</span>
        <Icon name="expand_more" className="text-sm text-outline" />
      </button>
      {open ? (
        <div id="project-menu" role="dialog" aria-label="Projects and runs"
          className="fixed left-2 top-14 sm:absolute sm:left-0 sm:top-full mt-1.5 w-80 max-w-[calc(100vw-1rem)] bg-surface-container-high rounded-lg border border-outline-variant/60 p-2 shadow-panel z-50 space-y-3">
          <div role="menu" aria-label="Choose project" className="max-h-56 overflow-y-auto"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
              if (!buttons.length) return
              event.preventDefault()
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              buttons[next]?.focus()
            }}>
            {bridge.projects.map((entry) => (
              <button key={entry.id} role="menuitem" type="button"
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-body-md text-left hover:bg-surface-container ${entry.id === bridge.projectId ? 'text-primary' : 'text-on-surface-variant'}`}
                onClick={() => { setOpen(false); onOpenChat(); void bridge.openProject(entry.id) }}>
                <span className="truncate">{entry.name}</span>
                {entry.id === bridge.projectId ? <Icon name="check" className="text-secondary text-sm" /> : null}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-outline-variant/40 pt-2">
            <Button disabled={!bridge.projectId || bridge.projectLoading} onClick={() => { bridge.closeRun(); setOpen(false); onOpenChat() }}>Run history</Button>
            <Button variant="primary" disabled={!bridge.projectId || bridge.projectLoading || busy} onClick={async () => {
              setBusy(true)
              try { if (await bridge.createRun()) { setOpen(false); onOpenChat() } } finally { setBusy(false) }
            }}>New run</Button>
            <Button onClick={() => setCreating((current) => !current)} aria-expanded={creating}>New project</Button>
          </div>
          {creating ? (
            <form className="flex flex-col gap-2" onSubmit={async (event) => {
              event.preventDefault()
              if (busy || name.trim().length < 2) return
              setBusy(true)
              try {
                if (await bridge.createProject(name.trim())) { setName(''); setCreating(false); setOpen(false); onOpenChat() }
              } finally { setBusy(false) }
            }}>
              <label htmlFor="new-project-name" className="text-label-md">New project name</label>
              <input id="new-project-name" className={inputClass} autoFocus required minLength={2} maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
              <Button variant="primary" type="submit" disabled={busy || name.trim().length < 2}>{busy ? 'Creating…' : 'Create project'}</Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
