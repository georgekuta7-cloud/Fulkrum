import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { canCancelRun, canPauseRun, canResumeRun } from '../lib/runState'
import { Icon, type IconName } from './Icon'

export function RunControls({ bridge }: { bridge: Bridge }) {
  const [busy, setBusy] = useState(false)
  const run = bridge.run
  if (!run) return null
  const controls: Array<{ action: string; label: string; icon: IconName }> = []
  if (canResumeRun(run.status)) controls.push({ action: 'resume', label: 'Resume run', icon: 'play_arrow' })
  else if (canPauseRun(run.status)) controls.push({ action: 'pause', label: 'Pause run', icon: 'pause' })
  if (canCancelRun(run.status)) controls.push({ action: 'cancel', label: 'Stop run', icon: 'stop' })
  if (!controls.length) return null
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Run controls">
      {controls.map(({ action, label, icon }) => (
        <button key={action} type="button" aria-label={label} title={label}
          disabled={busy || bridge.projectLoading || bridge.runLoading}
          className={`w-7 h-8 sm:w-8 rounded-lg flex items-center justify-center disabled:opacity-40 hover:bg-surface-container-high ${action === 'cancel' ? 'text-error' : 'text-on-surface-variant'}`}
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try { await bridge.control(action) } finally { setBusy(false) }
          }}>
          <Icon name={icon} className="text-xl" />
        </button>
      ))}
    </div>
  )
}
