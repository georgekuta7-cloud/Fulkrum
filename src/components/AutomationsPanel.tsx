import { useEffect, useState } from 'react'
import { CalendarClock, History } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

/**
 * Everything that acts without a hand on the mouse: playbooks (approved plans
 * worth re-running), schedules (playbooks on an interval), goals (runs under
 * one shared ceiling), blueprints (team setups, previewed before they touch
 * anything). One place, project-scoped — the drawer used to bury these next
 * to provider keys, where nobody scheduling real work would look.
 */

export function BlueprintDiff({ diff }: { diff: any }) {
  const sections: Array<{ title: string; rows: string[] }> = [
    {
      title: 'Routing',
      rows: (diff?.routing ?? []).map((entry: any) => `${entry.role}: ${entry.from ?? 'default'} → ${entry.to}`),
    },
    {
      title: 'Reasoning',
      rows: (diff?.reasoning ?? []).map((entry: any) => `${entry.role}: ${entry.from ?? 'default'} → ${entry.to}`),
    },
    {
      title: 'Defaults',
      rows: (diff?.defaults ?? []).map((entry: any) => `${entry.key}: ${JSON.stringify(entry.from)} → ${JSON.stringify(entry.to)}`),
    },
    {
      title: 'Grants',
      rows: (diff?.grants ?? []).map((entry: any) => `${entry.tool} ${entry.scopeKind} ${entry.scopeValue}`),
    },
  ]
  if (sections.every((section) => section.rows.length === 0)) {
    return <p className="muted">Nothing would change — the project already matches.</p>
  }
  return (
    <div>
      {sections.filter((section) => section.rows.length).map((section) => (
        <div key={section.title}>
          <p className="muted tiny"><strong>{section.title}</strong></p>
          <ul className="kv">
            {section.rows.map((row, index) => <li key={index}><span>{row}</span></li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="auto-group">
      <div className="auto-group-head">
        <h3>{title}</h3>
        {note ? <span className="muted tiny">{note}</span> : null}
      </div>
      {children}
    </section>
  )
}

export function AutomationsPanel({ bridge }: { bridge: Bridge }) {
  const { projectId, projects, playbooks, schedules, goals, blueprints, plan } = bridge
  const [playbookName, setPlaybookName] = useState('')
  const [scheduleDraft, setScheduleDraft] = useState({ playbookId: '', every: 'every 6h', budgetUsd: '' })
  const [goalDraft, setGoalDraft] = useState({ name: '', objective: '', acceptance: '', budgetUsd: '' })
  const [blueprintPreview, setBlueprintPreview] = useState<{ name: string; diff: any } | null>(null)
  const [applying, setApplying] = useState(false)

  const { loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadBlueprintsFor } = bridge
  useEffect(() => {
    void loadBlueprintsFor()
    if (projectId) {
      void loadPlaybooksFor(projectId)
      void loadSchedulesFor(projectId)
      void loadGoalsFor(projectId)
    }
  }, [projectId, loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadBlueprintsFor])

  const projectName = projects.find((project) => project.id === projectId)?.name

  if (!projectId) {
    return (
      <section className="panel market">
        <div className="panel-empty">
          <h2>Pick a project first</h2>
          <p className="muted">Playbooks, schedules, goals, and blueprints all belong to a project — choose one in the sidebar.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="panel market">
      <div className="market-toolbar">
        <h2><History size={15} /> Automations</h2>
        <span className="muted tiny">{projectName ?? 'current project'}</span>
      </div>

      <Group title="Playbooks" note="approved plans, reusable">
        {playbooks.length ? (
          <ul className="market-grid">
            {playbooks.map((playbook) => (
              <li key={playbook.id} className="market-card">
                <div className="market-card-head">
                  <strong>{playbook.name}</strong>
                  <span className="muted tiny">hash {playbook.contentHash.slice(0, 12)}…{playbook.budgetUsd !== null ? ` · $${playbook.budgetUsd} cap` : ''}</span>
                </div>
                <div className="deny-row">
                  <button type="button" className="tiny-button primary" onClick={() => void bridge.instantiatePlaybook(playbook.id)}>run</button>
                  <button type="button" className="tiny-button" onClick={() => void bridge.deletePlaybook(playbook.id)}>delete</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No playbooks. Save one from a run whose plan is approved, and re-running it inherits that approval.</p>}
        {plan?.plan.status === 'approved' ? (
          <form
            className="deny-row"
            onSubmit={(event) => {
              event.preventDefault()
              if (playbookName.trim()) {
                void bridge.savePlaybook(playbookName.trim()).then(() => setPlaybookName(''))
              }
            }}
          >
            <input value={playbookName} placeholder="Name this approved plan" onChange={(event) => setPlaybookName(event.target.value)} aria-label="Playbook name" />
            <button type="submit" className="primary" disabled={!playbookName.trim()}>Save as playbook</button>
          </form>
        ) : null}
      </Group>

      <Group title="Schedules" note="fire while the bridge runs — never when it is stopped">
        {schedules.length ? (
          <ul className="market-grid">
            {schedules.map((schedule) => {
              const playbook = playbooks.find((entry) => entry.id === schedule.playbookId)
              return (
                <li key={schedule.id} className="market-card">
                  <div className="market-card-head">
                    <strong>{playbook?.name ?? schedule.playbookId}</strong>
                    {schedule.enabled ? <span className="status-chip ok">live</span> : <span className="status-chip">paused</span>}
                  </div>
                  <p className="muted tiny">every {schedule.everyMinutes}m · next {new Date(schedule.nextFireAt).toLocaleString()}{schedule.budgetUsd !== null ? ` · $${schedule.budgetUsd} cap` : ''}{schedule.lastRunId ? ` · last ${schedule.lastRunId.slice(0, 8)}` : ''}</p>
                  <div className="deny-row">
                    <button type="button" className="tiny-button" onClick={() => void bridge.toggleSchedule(schedule.id, !schedule.enabled)}>{schedule.enabled ? 'pause' : 'resume'}</button>
                    <button type="button" className="tiny-button" onClick={() => void bridge.deleteSchedule(schedule.id)}>delete</button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : <p className="muted">Nothing scheduled. A schedule runs a playbook on an interval — missed intervals never burst-catch-up.</p>}
        {playbooks.length ? (
          <form
            className="deny-row"
            onSubmit={(event) => {
              event.preventDefault()
              if (!scheduleDraft.playbookId) return
              void bridge.saveSchedule(scheduleDraft.playbookId, scheduleDraft.every, scheduleDraft.budgetUsd === '' ? null : Number(scheduleDraft.budgetUsd)).then(() => {
                setScheduleDraft((current) => ({ ...current, every: 'every 6h', budgetUsd: '' }))
              })
            }}
          >
            <select value={scheduleDraft.playbookId} onChange={(event) => setScheduleDraft((current) => ({ ...current, playbookId: event.target.value }))} aria-label="Playbook to schedule">
              <option value="">pick a playbook…</option>
              {playbooks.map((playbook) => <option key={playbook.id} value={playbook.id}>{playbook.name}</option>)}
            </select>
            <input value={scheduleDraft.every} placeholder="every 6h" title='An interval like "every 30m", "every 6h", or "every 1d"' onChange={(event) => setScheduleDraft((current) => ({ ...current, every: event.target.value }))} aria-label="Interval" />
            <input value={scheduleDraft.budgetUsd} inputMode="decimal" placeholder="$ cap, optional" onChange={(event) => setScheduleDraft((current) => ({ ...current, budgetUsd: event.target.value }))} aria-label="Budget cap" />
            <button type="submit" className="primary" disabled={!scheduleDraft.playbookId}>Schedule</button>
          </form>
        ) : null}
      </Group>

      <Group title="Goals" note="one objective, one shared ceiling">
        {goals.length ? (
          <ul className="market-grid">
            {goals.map((goal) => (
              <li key={goal.id} className="market-card">
                <div className="market-card-head">
                  <strong>{goal.name}</strong>
                  <span className="muted tiny">{goal.runCount ?? 0} run(s){typeof goal.spendUsd === 'number' ? ` · $${goal.spendUsd.toFixed(4)} spent` : ''}{goal.budgetUsd !== null ? ` of $${goal.budgetUsd}` : ''}</span>
                </div>
                {goal.objective ? <p className="muted tiny">{goal.objective}</p> : null}
                <div className="deny-row">
                  <button type="button" className="tiny-button" onClick={() => void bridge.deleteGoal(goal.id)}>delete</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No goals. A goal groups runs under one objective and one shared budget — refused at the door once spent.</p>}
        <form
          className="deny-row"
          onSubmit={(event) => {
            event.preventDefault()
            if (!goalDraft.name.trim()) return
            void bridge.createGoal(goalDraft.name.trim(), goalDraft.objective, goalDraft.acceptance, goalDraft.budgetUsd === '' ? null : Number(goalDraft.budgetUsd)).then(() => {
              setGoalDraft({ name: '', objective: '', acceptance: '', budgetUsd: '' })
            })
          }}
        >
          <input value={goalDraft.name} placeholder="Goal name" onChange={(event) => setGoalDraft((current) => ({ ...current, name: event.target.value }))} aria-label="Goal name" />
          <input value={goalDraft.budgetUsd} inputMode="decimal" placeholder="$ ceiling, optional" onChange={(event) => setGoalDraft((current) => ({ ...current, budgetUsd: event.target.value }))} aria-label="Goal ceiling" />
          <button type="submit" className="primary" disabled={!goalDraft.name.trim()}>Start goal</button>
        </form>
        <input value={goalDraft.objective} placeholder="Objective — what done looks like" onChange={(event) => setGoalDraft((current) => ({ ...current, objective: event.target.value }))} aria-label="Goal objective" style={{ marginTop: 6, width: '100%' }} />
        <input value={goalDraft.acceptance} placeholder="Acceptance — how done is proven" onChange={(event) => setGoalDraft((current) => ({ ...current, acceptance: event.target.value }))} aria-label="Goal acceptance" style={{ marginTop: 6, width: '100%' }} />
      </Group>

      <Group title="Blueprints" note="team setups, previewed before they touch anything">
        {blueprints.length ? (
          <ul className="market-grid">
            {blueprints.map((blueprint) => (
              <li key={`${blueprint.source}:${blueprint.name}`} className="market-card">
                <div className="market-card-head">
                  <strong>{blueprint.name}</strong>
                  <span className="muted tiny">v{blueprint.version} · {blueprint.source}</span>
                </div>
                <p className="muted tiny">{blueprint.description || 'No description.'}</p>
                <div className="deny-row">
                  <button
                    type="button"
                    className="tiny-button"
                    onClick={async () => {
                      const diff = await bridge.previewBlueprint({ name: blueprint.name })
                      if (diff) setBlueprintPreview({ name: blueprint.name, diff })
                    }}
                  >
                    preview
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted"><CalendarClock size={12} /> No blueprints filed. Builtins ship with the app; point FULKRUM_BLUEPRINTS_DIR at a team folder for more.</p>}
        {blueprintPreview ? (
          <div className="market-card">
            <p><strong>{blueprintPreview.name}</strong> would change:</p>
            <BlueprintDiff diff={blueprintPreview.diff} />
            <div className="deny-row">
              <button
                type="button"
                className="primary"
                disabled={applying}
                onClick={async () => {
                  setApplying(true)
                  try {
                    const applied = await bridge.applyBlueprint({ name: blueprintPreview.name })
                    if (applied) setBlueprintPreview(null)
                  } finally {
                    setApplying(false)
                  }
                }}
              >
                {applying ? 'Applying…' : 'Apply'}
              </button>
              <button type="button" onClick={() => setBlueprintPreview(null)}>Cancel</button>
            </div>
            <p className="muted tiny">Grants go through the normal path — a blueprint can never silently elevate.</p>
          </div>
        ) : null}
      </Group>
    </section>
  )
}
