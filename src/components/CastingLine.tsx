import type { Bridge } from '../hooks/useBridge'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'

/**
 * Who plays whom, on the approval surface. Casting is routing, and routing is
 * not plan content — so this line informs the approval without being part of
 * what the approval binds to. A stale route shows verbatim rather than hiding.
 */
export function CastingLine({ bridge, tasks }: { bridge: Bridge; tasks: Array<{ role: string }> }) {
  const routing = ((bridge.projectSettings ?? {}).routing as Record<string, string> | undefined) ?? {}
  const roles = [...new Set(tasks.map((task) => task.role))]
  if (!roles.length) return null
  return (
    <div className="casting-line muted tiny" title="Role → model. Change it on the graph node; casting never invalidates plan approval.">
      {roles.map((role) => `${roleLabel(role)} → ${resolveRouteDisplay(routing, bridge.providers, role) ?? 'default'}`).join(' · ')}
    </div>
  )
}
