/**
 * Approval gate: parked tool calls waiting for a human decision.
 *
 * A consequential call parks the agent on a promise that the approval endpoint
 * resolves, so approving continues the same turn instead of executing a side
 * effect nothing consumes.
 */
export function createApprovalGate({ store }) {
  const approvalWaiters = new Map()
  const pendingAnswers = new Map()

  const approve = async (toolCallId, executeResolvedTool) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending) return { handled: false }
    approvalWaiters.delete(toolCallId)
    const result = await executeResolvedTool({ ...pending, approved: true })
    pending.resolve(result)
    return { handled: true, result }
  }

  const deny = (toolCallId, reason) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending) return { handled: false }
    approvalWaiters.delete(toolCallId)
    if (pending.nonBlocking && pending.task?.id) {
      const queued = pendingAnswers.get(pending.task.id) ?? []
      queued.push({ toolCallId, answer: `Your question was declined: ${reason}. Proceed without it.` })
      pendingAnswers.set(pending.task.id, queued)
    }
    pending.resolve({ ok: false, denied: true, error: reason })
    return { handled: true }
  }

  const answer = (toolCallId, text) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending || pending.toolCall?.name !== 'run.ask') return { handled: false }
    approvalWaiters.delete(toolCallId)
    const output = { answer: text }
    store.updateToolCall(toolCallId, { status: 'completed', output })
    store.appendEvent({ runId: pending.runId, type: 'tool.completed', agentId: pending.task?.agentId ?? 'head', payload: { toolCallId, name: 'run.ask', ...store.summarizeOutput(output), answered: true } })
    if (pending.spanId) store.endSpan(pending.spanId, { status: 'ok', attributes: { 'fulkrum.answered': true } })
    if (pending.nonBlocking && pending.task?.id) {
      const queued = pendingAnswers.get(pending.task.id) ?? []
      queued.push({ toolCallId, answer: text })
      pendingAnswers.set(pending.task.id, queued)
    }
    pending.resolve({ ok: true, output })
    return { handled: true }
  }

  const abandonAll = (reason, runId = null) => {
    const abandoned = []
    for (const [toolCallId, pending] of approvalWaiters) {
      if (runId !== null && pending.runId !== runId) continue
      approvalWaiters.delete(toolCallId)
      try {
        store.updateToolCall(toolCallId, { status: 'interrupted', error: reason })
        store.appendEvent({ runId: pending.runId, type: 'tool.denied', agentId: pending.task?.agentId ?? 'head', payload: { toolCallId, name: pending.toolCall?.name ?? 'unknown', reason, rule: 'deny.run-ended' } })
      } catch {
        // The store may already be closing; the worker still gets its answer.
      }
      pending.resolve({ ok: false, denied: true, error: reason })
      abandoned.push(toolCallId)
    }
    return abandoned
  }

  const drainAnswers = (taskId) => {
    const queued = pendingAnswers.get(taskId)
    if (!queued?.length) return []
    pendingAnswers.delete(taskId)
    return queued.map((entry) => ({ id: entry.toolCallId, name: 'run.ask', content: entry.answer }))
  }

  const hasOpenQuestion = (taskId) =>
    [...approvalWaiters.values()].some((w) => w.toolCall?.name === 'run.ask' && w.task?.id === taskId && w.nonBlocking)

  return { approvalWaiters, pendingAnswers, approve, deny, answer, abandonAll, drainAnswers, hasOpenQuestion }
}
