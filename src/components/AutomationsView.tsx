import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, Chip, EmptyState, Panel, inputClass, selectClass } from './primitives'

/**
 * Everything that acts without a hand on the mouse: playbooks (approved plans
 * worth re-running), schedules (playbooks on an interval), goals (runs under
 * one shared ceiling), blueprints (team setups, previewed before they touch
 * anything). Project-scoped — without a project there is nothing to automate.
 */

function BlueprintDiff({ diff }: { diff: any }) {
  const sections: Array<{ title: string; rows: string[] }> = [
    { title: 'Routing', rows: (diff?.routing ?? []).map((e: any) => `${e.role}: ${e.from ?? 'default'} · ${e.to}`) },
    { title: 'Reasoning', rows: (diff?.reasoning ?? []).map((e: any) => `${e.role}: ${e.from ?? 'default'} · ${e.to}`) },
    { title: 'Defaults', rows: (diff?.defaults ?? []).map((e: any) => `${e.key}: ${JSON.stringify(e.from)} · ${JSON.stringify(e.to)}`) },
    { title: 'Grants', rows: (diff?.grants ?? []).map((e: any) => `${e.tool} ${e.scopeKind} ${e.scopeValue}`) },
  ]
  if (sections.every((s) => !s.rows.length)) return <p className="text-body-sm text-outline">Nothing would change — the project already matches.</p>
  return (
    <div className="flex flex-col gap-2">
      {sections.filter((s) => s.rows.length).map((s) => (
        <div key={s.title}>
          <p className="text-label-md text-outline font-semibold">{s.title}</p>
          <ul className="font-mono text-body-sm text-on-surface-variant space-y-0.5">
            {s.rows.map((row, i) => <li key={i}>{row}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function AutomationsView({ bridge }: { bridge: Bridge }) {
  const { projectId, projects, playbooks, schedules, goals, blueprints, plan } = bridge
  const [playbookName, setPlaybookName] = useState('')
  const [scheduleDraft, setScheduleDraft] = useState({ playbookId: '', every: 'every 6h', budgetUsd: '' })
  const [goalDraft, setGoalDraft] = useState({ name: '', objective: '', acceptance: '', budgetUsd: '' })
  const [preview, setPreview] = useState<{ name: string; diff: any } | null>(null)
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

  if (!projectId) {
    return <EmptyState icon="history" title="Pick a project first" body="Playbooks, schedules, goals, and blueprints all belong to a project — choose one from the header." />
  }
  const projectName = projects.find((p: any) => p.id === projectId)?.name

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-4 flex flex-col gap-4">
      <p className="text-label-md text-outline">{projectName ?? 'current project'} · schedules fire only while the bridge runs; missed intervals never burst-catch-up.</p>

      <Panel title="Playbooks" action={<span className="text-label-md text-outline">approved plans, reusable</span>}>
        {playbooks.length ? playbooks.map((pb: any) => (
          <div key={pb.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-container">
            <div className="min-w-0">
              <strong className="text-body-md text-on-surface" title={pb.name}>{pb.name}</strong>
              <p className="font-mono text-label-sm text-outline">hash {pb.contentHash.slice(0, 12)}…{pb.budgetUsd !== null ? ` · $${pb.budgetUsd} cap` : ''}</p>
            </div>
            <div className="flex gap-1.5 flex-shrink-0">
              <Button variant="primary" className="!px-2.5 !py-1 text-label-sm" onClick={() => void bridge.instantiatePlaybook(pb.id)}>run</Button>
              <Button className="!px-2.5 !py-1 text-label-sm" onClick={() => void bridge.deletePlaybook(pb.id)}>delete</Button>
            </div>
          </div>
        )) : <p className="text-body-sm text-outline">No playbooks. Save one from a run whose plan is approved, and re-running it inherits that approval.</p>}
        {plan?.plan.status === 'approved' ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (playbookName.trim()) void bridge.savePlaybook(playbookName.trim()).then(() => setPlaybookName(''))
            }}
          >
            <label className="visually-hidden" htmlFor="playbook-name">Playbook name</label>
            <input id="playbook-name" className={`${inputClass} flex-1`} placeholder="Name this approved plan" value={playbookName} onChange={(e) => setPlaybookName(e.target.value)} />
            <Button variant="primary" type="submit" disabled={!playbookName.trim()}>Save as playbook</Button>
          </form>
        ) : null}
      </Panel>

      <Panel title="Schedules" action={<span className="text-label-md text-outline">intervals that fire playbooks</span>}>
        {schedules.length ? schedules.map((s: any) => {
          const pb = playbooks.find((entry: any) => entry.id === s.playbookId)
          return (
            <div key={s.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-container">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-body-md text-on-surface truncate">{pb?.name ?? s.playbookId}</strong>
                  <Chip tone={s.enabled ? 'ok' : 'idle'}>{s.enabled ? 'live' : 'paused'}</Chip>
                </div>
                <p className="font-mono text-label-sm text-outline">every {s.everyMinutes}m · next {new Date(s.nextFireAt).toLocaleString()}{s.budgetUsd !== null ? ` · $${s.budgetUsd} cap` : ''}{s.lastRunId ? ` · last ${s.lastRunId.slice(0, 8)}` : ''}</p>
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                <Button className="!px-2.5 !py-1 text-label-sm" onClick={() => void bridge.toggleSchedule(s.id, !s.enabled)}>{s.enabled ? 'pause' : 'resume'}</Button>
                <Button className="!px-2.5 !py-1 text-label-sm" onClick={() => void bridge.deleteSchedule(s.id)}>delete</Button>
              </div>
            </div>
          )
        }) : <p className="text-body-sm text-outline">Nothing scheduled.</p>}
        {playbooks.length ? (
          <form
            className="flex gap-2 flex-wrap"
            onSubmit={(e) => {
              e.preventDefault()
              if (!scheduleDraft.playbookId) return
              void bridge.saveSchedule(scheduleDraft.playbookId, scheduleDraft.every, scheduleDraft.budgetUsd === '' ? null : Number(scheduleDraft.budgetUsd)).then(() => setScheduleDraft((c) => ({ ...c, every: 'every 6h', budgetUsd: '' })))
            }}
          >
            <label className="visually-hidden" htmlFor="sched-playbook">Playbook</label>
            <select id="sched-playbook" className={selectClass} value={scheduleDraft.playbookId} onChange={(e) => setScheduleDraft((c) => ({ ...c, playbookId: e.target.value }))}>
              <option value="">pick a playbook…</option>
              {playbooks.map((pb: any) => <option key={pb.id} value={pb.id}>{pb.name}</option>)}
            </select>
            <label className="visually-hidden" htmlFor="sched-every">Interval</label>
            <input id="sched-every" className={inputClass} value={scheduleDraft.every} placeholder="every 6h" title='An interval like "every 30m", "every 6h", or "every 1d"' onChange={(e) => setScheduleDraft((c) => ({ ...c, every: e.target.value }))} />
            <label className="visually-hidden" htmlFor="sched-cap">Budget cap</label>
            <input id="sched-cap" className={inputClass} value={scheduleDraft.budgetUsd} inputMode="decimal" placeholder="$ cap, optional" onChange={(e) => setScheduleDraft((c) => ({ ...c, budgetUsd: e.target.value }))} />
            <Button variant="primary" type="submit" disabled={!scheduleDraft.playbookId}>Schedule</Button>
          </form>
        ) : null}
      </Panel>

      <Panel title="Goals" action={<span className="text-label-md text-outline">one objective, one shared ceiling</span>}>
        {goals.length ? goals.map((goal: any) => (
          <div key={goal.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-container">
            <div className="min-w-0">
              <strong className="text-body-md text-on-surface" title={goal.name}>{goal.name}</strong>
              <p className="font-mono text-label-sm text-outline">{goal.runCount ?? 0} run(s){typeof goal.spendUsd === 'number' ? ` · $${goal.spendUsd.toFixed(4)} spent` : ''}{goal.budgetUsd !== null ? ` of $${goal.budgetUsd}` : ''}</p>
                {goal.objective ? <p className="text-body-sm text-on-surface-variant truncate" title={goal.objective}>{goal.objective}</p> : null}
            </div>
            <Button className="!px-2.5 !py-1 text-label-sm flex-shrink-0" onClick={() => void bridge.deleteGoal(goal.id)}>delete</Button>
          </div>
        )) : <p className="text-body-sm text-outline">No goals. A goal groups runs under one objective and one shared budget — refused at the door once spent.</p>}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!goalDraft.name.trim()) return
            void bridge.createGoal(goalDraft.name.trim(), goalDraft.objective, goalDraft.acceptance, goalDraft.budgetUsd === '' ? null : Number(goalDraft.budgetUsd)).then(() => setGoalDraft({ name: '', objective: '', acceptance: '', budgetUsd: '' }))
          }}
        >
          <div className="flex gap-2 flex-wrap">
            <label className="visually-hidden" htmlFor="goal-name">Goal name</label>
            <input id="goal-name" className={`${inputClass} flex-1 min-w-[160px]`} placeholder="Goal name" value={goalDraft.name} onChange={(e) => setGoalDraft((c) => ({ ...c, name: e.target.value }))} />
            <label className="visually-hidden" htmlFor="goal-cap">Ceiling</label>
            <input id="goal-cap" className={inputClass} value={goalDraft.budgetUsd} inputMode="decimal" placeholder="$ ceiling, optional" onChange={(e) => setGoalDraft((c) => ({ ...c, budgetUsd: e.target.value }))} />
            <Button variant="primary" type="submit" disabled={!goalDraft.name.trim()}>Start goal</Button>
          </div>
          <label className="visually-hidden" htmlFor="goal-objective">Objective</label>
          <input id="goal-objective" className={inputClass} placeholder="Objective — what done looks like" value={goalDraft.objective} onChange={(e) => setGoalDraft((c) => ({ ...c, objective: e.target.value }))} />
          <label className="visually-hidden" htmlFor="goal-acceptance">Acceptance</label>
          <input id="goal-acceptance" className={inputClass} placeholder="Acceptance — how done is proven" value={goalDraft.acceptance} onChange={(e) => setGoalDraft((c) => ({ ...c, acceptance: e.target.value }))} />
        </form>
      </Panel>

      <Panel title="Blueprints" action={<span className="text-label-md text-outline">team setups, previewed first</span>}>
        {blueprints.length ? blueprints.map((bp: any) => (
          <div key={`${bp.source}:${bp.name}`} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-container">
            <div className="min-w-0">
              <strong className="text-body-md text-on-surface">{bp.name}</strong>
              <p className="text-label-md text-outline">v{bp.version} · {bp.source} · {bp.description || 'no description'}</p>
            </div>
            <Button
              className="!px-2.5 !py-1 text-label-sm flex-shrink-0"
              onClick={async () => {
                const diff = await bridge.previewBlueprint({ name: bp.name })
                if (diff) setPreview({ name: bp.name, diff })
              }}
            >
              preview
            </Button>
          </div>
        )) : <p className="text-body-sm text-outline">No blueprints filed. Builtins ship with the app; point FULKRUM_BLUEPRINTS_DIR at a team folder for more.</p>}
        {preview ? (
          <div className="p-3 rounded-lg border border-primary/40 bg-surface-container flex flex-col gap-2">
            <p className="text-body-md text-on-surface"><strong>{preview.name}</strong> would change:</p>
            <BlueprintDiff diff={preview.diff} />
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={applying}
                onClick={async () => {
                  setApplying(true)
                  try {
                    const applied = await bridge.applyBlueprint({ name: preview.name })
                    if (applied) setPreview(null)
                  } finally {
                    setApplying(false)
                  }
                }}
              >
                {applying ? 'Applying…' : 'Apply'}
              </Button>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
            </div>
            <p className="text-label-md text-outline">Grants go through the normal path — a blueprint can never silently elevate.</p>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}
