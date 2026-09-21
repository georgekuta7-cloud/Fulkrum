import { instantiatePlaybookRun } from './playbooks.mjs'

/**
 * Schedules: intervals that fire playbooks. Best-effort by design — the loop
 * runs while the bridge runs (there is no daemon), ticks once a minute, and
 * never lets one broken schedule wedge the rest: every fire advances
 * next_fire_at whether it succeeded or not, and every outcome is a
 * maintenance record, not a silent skip.
 *
 * No catch-up, deliberately: a bridge down for a week fires once per schedule
 * at restart, then reschedules a full interval out. Bursting through missed
 * intervals would spend unattended money against a human who is not watching.
 * next_fire_at always advances from the tick's clock, never from the due time.
 *
 * A fired schedule runs the same instantiate path as a clicked button, so the
 * hash check, the inherited approval, and the budget all behave identically.
 * A playbook that drifted since scheduling refuses at fire time with its
 * reason recorded, rather than running on a stale yes.
 */

/** `every 30m`, `every 6h`, `every 1d`. Intervals only: full cron grammar has
 * no provability payoff, and a next_fire_at timestamp audits better anyway. */
export function parseInterval(text) {
  const match = /^\s*every\s+(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:our)?s?|d(?:ay)?s?)\s*$/i.exec(String(text ?? ''))
  if (!match) return null
  const amount = Number(match[1])
  const minutes = match[2][0].toLowerCase() === 'm' ? amount : match[2][0].toLowerCase() === 'h' ? amount * 60 : amount * 1440
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) return null
  return Math.floor(minutes)
}

export function createScheduler({ store, orchestrator, workspaceRoot = null, intervalMs = 60_000, clock = () => Date.now() }) {
  const tick = async () => {
    const now = clock()
    for (const schedule of store.listDueSchedules(now)) {
      const playbook = store.getPlaybook(schedule.playbookId)
      const label = playbook ? `"${playbook.name}"` : schedule.playbookId
      try {
        const { run } = instantiatePlaybookRun({
          store,
          orchestrator,
          projectId: schedule.projectId,
          playbookId: schedule.playbookId,
          permissionMode: 'autopilot',
          routing: store.getProject(schedule.projectId)?.project?.settings?.routing ?? {},
          budgetUsd: schedule.budgetUsd ?? undefined,
          workspaceRoot,
        })
        store.markScheduleFired(schedule.id, { runId: run.id, now })
        store.recordMaintenance({ kind: 'schedule', ok: true, summary: `Ran playbook ${label} as run ${run.id}.`, payload: { scheduleId: schedule.id, runId: run.id } })
      } catch (error) {
        store.markScheduleFired(schedule.id, { runId: null, now })
        store.recordMaintenance({ kind: 'schedule', ok: false, summary: `Schedule for playbook ${label} did not fire: ${error instanceof Error ? error.message : 'unknown error'}`, payload: { scheduleId: schedule.id } })
      }
    }
  }

  let timer = null
  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        tick().catch((error) => {
          try {
            store.recordMaintenance({ kind: 'schedule', ok: false, summary: `Scheduler tick failed: ${error instanceof Error ? error.message : 'unknown error'}` })
          } catch {
            // A dead store must not kill the loop that reports it.
          }
        })
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
