import type { AgentId, ReasoningLevel } from '../api/types'
import type { Bridge } from '../hooks/useBridge'

const LEVELS: ReasoningLevel[] = ['minimal', 'low', 'medium', 'high']

/**
 * How hard one role thinks. The choice is a project setting that travels with
 * every call the role makes, translated on the server into whatever the model
 * natively understands — an effort word, or a thinking budget. "Provider
 * default" stores nothing, so a model that does not reason is never sent a knob.
 */
export function ReasoningSelect({ bridge, role, label }: { bridge: Bridge; role: AgentId | 'default'; label?: string }) {
  const { projects, projectId, setReasoning } = bridge
  const project = projects.find((entry) => entry.id === projectId)
  const table = project?.settings?.reasoning ?? {}
  // A role with no entry of its own falls back to the project-wide default.
  const effective = table[role] ?? (role === 'default' ? undefined : table.default)
  const value = effective ?? ''

  return (
    <label className="reasoning-select" title={`How hard ${role === 'default' ? 'every role' : role} thinks`}>
      {label ? <span className="muted tiny">{label}</span> : null}
      <select
        value={value}
        onChange={(event) => void setReasoning(role, (event.target.value || null) as ReasoningLevel | null)}
      >
        <option value="">default</option>
        {LEVELS.map((level) => (
          <option key={level} value={level}>{level}</option>
        ))}
      </select>
    </label>
  )
}
