/**
 * Reconcile runs left behind by a previous process.
 *
 * Active runs live in memory while they work, so a crash or restart used to leave rows
 * stuck in `executing` forever: the UI showed a live run that would never progress, and
 * its pending approval could never resolve. A lease makes "abandoned" a detectable fact
 * rather than a guess.
 *
 * @param {{ store: any, log?: (message: string) => void, abandonWaiters?: (reason: string) => string[] }} options
 */
export function reconcileInterruptedRuns({ store, log = () => {}, abandonWaiters = null }) {
  // A fresh process has no in-memory waiters — the map died with the old one. The
  // hook exists so a host that somehow still holds waiters (a hot reload, an embedded
  // boot) can clear them the same way a cancel does.
  if (abandonWaiters) abandonWaiters('The API bridge restarted while this call awaited approval.')
  const stranded = store.listStrandedRuns()
  const interrupted = []

  for (const run of stranded) {
    const reason = `The API bridge stopped while this run was ${run.status}. It was interrupted, not completed.`
    // One unit: a run marked interrupted with its tool calls and tasks still
    // claiming to be running is a state nothing can explain afterwards.
    store.transaction(() => {
      // Where the run was, so the resume guard can tell "was executing an approved
      // plan" from "was planning one": only the former is resumable.
      store.updateRun(run.id, { status: 'interrupted', interruptedFrom: run.status })
      store.markRunInterrupted(run.id, reason)

      // A tool call mid-flight has an unknown outcome: it may or may not have
      // happened. Record that honestly instead of guessing either way.
      for (const call of store.listToolCalls(run.id)) {
        if (call.status === 'running' || call.status === 'intent') {
          store.updateToolCall(call.id, { status: 'interrupted', error: 'The bridge stopped while this call was in flight; its outcome is unknown.' })
        } else if (call.status === 'approval_required') {
          // The worker waiting on this is gone, so the approval can never resume
          // it. The run has to restart the step and ask again.
          store.updateToolCall(call.id, { status: 'interrupted', error: 'The bridge stopped while this call awaited approval. Resume the run to ask again.' })
        }
      }

      for (const task of store.listTasks(run.id)) {
        if (task.status === 'running') {
          // Its turns are on disk, so resuming continues this task from its last
          // step rather than starting it over.
          const turns = store.countTaskTurns(task.id)
          store.updateTask(task.id, { status: 'interrupted', result: turns > 0 ? `Interrupted by a restart after ${turns} turn(s). Resume the run to continue this task where it stopped.` : 'Interrupted by a restart. Resume the run to continue.' })
        }
      }

      store.appendEvent({ runId: run.id, type: 'run.interrupted', agentId: 'head', payload: { reason, previousStatus: run.status } })
    })
    interrupted.push({ runId: run.id, previousStatus: run.status })
    log(`interrupted run ${run.id} (was ${run.status})`)
  }

  return { scanned: stranded.length, interrupted }
}
