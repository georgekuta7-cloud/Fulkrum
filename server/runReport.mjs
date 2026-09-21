import { buildArtifacts } from './artifacts.mjs'

/**
 * A run, written up for a person.
 *
 * The point of the report is that a run can be reviewed without opening the
 * database: what was asked for, what was planned, what each worker did, what
 * changed on disk, what it cost, and whether the log still verifies. The Markdown
 * is the readable form; the JSON is the same facts, for anything downstream.
 */

const stamp = (value) => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '—')
const money = (value) => (value === null || value === undefined ? 'unpriced' : `$${Number(value).toFixed(4)}`)
const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')

export function buildRunReport({ store, runId }) {
  const snapshot = store.getRunSnapshot(runId)
  if (!snapshot) return null

  const { run, messages, tasks, toolCalls } = snapshot
  const plan = (run.planId ? store.getPlan(run.planId) : null) ?? store.getLatestPlanForRun(runId)
  const trace = store.getRunTrace(runId)
  const audit = store.verifyEventChain(runId)
  const artifacts = buildArtifacts(store, runId)
  const grants = store.listApprovalGrants(runId)
  const direction = [...messages].reverse().find((message) => message.role === 'user')?.content ?? plan?.plan.objective ?? ''

  return {
    run: {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      mode: run.mode,
      permissionMode: run.permissionMode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      interruptionReason: run.interruptionReason,
      direction,
    },
    plan: plan
      ? { id: plan.plan.id, version: plan.plan.version, objective: plan.plan.objective, status: plan.plan.status, source: plan.plan.source, contentHash: plan.plan.contentHash, tasks: plan.tasks }
      : null,
    tasks: tasks.map((task) => ({ id: task.id, agentId: task.agentId, title: task.title, status: task.status, steps: task.stepCount, attempt: task.attempt ?? 1, result: task.result ?? null, verification: store.getTaskVerdict(task.id)?.overall ?? null })),
    toolCalls: toolCalls.map((call) => ({ id: call.id, agentId: call.agentId, name: call.name, kind: call.kind, status: call.status, approvedAt: call.approvedAt, approvalScope: call.approvalScope, fingerprint: call.fingerprint, error: call.error ?? null, at: call.createdAt })),
    grants: grants.map((grant) => ({ toolName: grant.toolName, grantedAt: grant.grantedAt })),
    artifacts: artifacts.map((artifact) => ({ path: artifact.path, created: artifact.created, bytes: artifact.bytes, added: artifact.diff?.added ?? null, removed: artifact.diff?.removed ?? null, at: artifact.at })),
    spend: { ...trace.spend, budgetUsd: run.budgetUsd, budgetExceededAt: run.budgetExceededAt },
    calls: trace.calls.map((call) => ({ role: call.role, provider: call.provider, model: call.model, status: call.status, inputTokens: call.inputTokens, outputTokens: call.outputTokens, costUsd: call.costUsd, priced: call.priced, latencyMs: call.latencyMs })),
    audit: { ok: audit.ok, eventsChecked: audit.checked, unverifiable: audit.unverifiable, truncated: audit.truncated, brokenAt: audit.brokenAt, checkpointSequence: audit.checkpoint?.sequence ?? null, anchorSequence: audit.anchor?.sequence ?? null, checkpointMissing: audit.checkpointMissing },
    messages: messages.length,
  }
}

/**
 * A goal, written up: the objective, the member runs with what each cost and
 * whether its chain still verifies, and the shared budget against the total.
 * Member chains are listed, never merged — per-run chains stay load-bearing.
 */
export function buildGoalReport({ store, goalId }) {
  const goal = store.getGoal(goalId)
  if (!goal) return null
  const runs = store.listGoalRuns(goalId).map((run) => {
    const spend = store.spendForRun(run.id)
    const audit = store.verifyEventChain(run.id)
    return { id: run.id, status: run.status, costUsd: spend.costUsd, calls: spend.calls, unpricedCalls: spend.unpricedCalls, auditOk: audit.ok, createdAt: run.createdAt, updatedAt: run.updatedAt }
  })
  const total = runs.reduce((sum, run) => sum + run.costUsd, 0)
  return {
    goal: { id: goal.id, name: goal.name, objective: goal.objective, acceptance: goal.acceptance, status: goal.status, createdAt: goal.createdAt },
    runs,
    spend: { totalCostUsd: total, budgetUsd: goal.budgetUsd, remainingUsd: goal.budgetUsd === null ? null : goal.budgetUsd - total },
  }
}

/** The report as Markdown: the form a person reads. */
export function reportToMarkdown(report) {
  const lines = []
  lines.push(`# ${report.plan?.objective ?? report.run.direction ?? 'Run report'}`)
  lines.push('')
  lines.push(`- **Run:** \`${report.run.id}\` (${report.run.status})`)
  lines.push(`- **Mode:** ${report.run.mode} · **Permissions:** ${report.run.permissionMode}`)
  lines.push(`- **Started:** ${stamp(report.run.createdAt)} · **Last change:** ${stamp(report.run.updatedAt)}`)
  lines.push(`- **Spend:** ${money(report.spend.costUsd)} across ${report.spend.calls} call(s)${report.spend.unpricedCalls ? ` (${report.spend.unpricedCalls} unpriced, so this is a lower bound)` : ''}${report.spend.budgetUsd ? ` · ceiling ${money(report.spend.budgetUsd)}` : ''}`)
  if (report.run.interruptionReason) lines.push(`- **Interrupted:** ${report.run.interruptionReason}`)
  lines.push('')

  if (report.run.direction) {
    lines.push('## What was asked')
    lines.push('')
    lines.push(`> ${report.run.direction.replaceAll('\n', '\n> ')}`)
    lines.push('')
  }

  if (report.plan) {
    lines.push(`## Plan v${report.plan.version} (${report.plan.status}, ${report.plan.source})`)
    lines.push('')
    report.plan.tasks.forEach((task, index) => {
      const depends = task.dependsOn?.length ? ` · after ${task.dependsOn.map((index) => index + 1).join(', ')}` : ''
      lines.push(`${index + 1}. **${cell(task.title)}** — ${task.role}${depends}`)
      if (task.acceptanceCheck) lines.push(`   - acceptance: ${cell(task.acceptanceCheck)}`)
    })
    lines.push('')
  }

  lines.push('## What the workers did')
  lines.push('')
  if (!report.tasks.length) lines.push('_No tasks were materialized._')
  for (const task of report.tasks) {
    lines.push(`### ${cell(task.title)} — ${task.agentId} (${task.status}, ${task.steps} step(s))`)
    lines.push('')
    lines.push(task.result ? task.result.trim() : '_No summary recorded._')
    lines.push('')
  }

  lines.push('## Files changed')
  lines.push('')
  if (!report.artifacts.length) lines.push('_Nothing was written._')
  else {
    lines.push('| path | change | lines |')
    lines.push('| --- | --- | --- |')
    for (const artifact of report.artifacts) {
      const change = artifact.created ? 'created' : 'modified'
      const delta = artifact.added === null ? `(+${artifact.bytes} bytes, no diff)` : `+${artifact.added} / -${artifact.removed}`
      lines.push(`| ${cell(artifact.path)} | ${change} | ${delta} |`)
    }
  }
  lines.push('')

  lines.push('## Tool calls')
  lines.push('')
  if (!report.toolCalls.length) lines.push('_None._')
  else {
    lines.push('| tool | status | approval | note |')
    lines.push('| --- | --- | --- | --- |')
    for (const call of report.toolCalls) {
      const approval = call.approvedAt ? (call.approvalScope === 'run' ? 'for the run' : 'once') : '—'
      lines.push(`| ${cell(call.name)} | ${call.status} | ${approval} | ${cell(call.error ?? '')} |`)
    }
  }
  lines.push('')
  if (report.grants.length) {
    lines.push(`_Standing approvals for this run: ${report.grants.map((grant) => `\`${grant.toolName}\``).join(', ')}_`)
    lines.push('')
  }

  lines.push('## Cost by model')
  lines.push('')
  if (!report.calls.length) lines.push('_No model calls._')
  else {
    lines.push('| role | model | tokens in/out | cost |')
    lines.push('| --- | --- | --- | --- |')
    for (const call of report.calls) {
      lines.push(`| ${cell(call.role)} | ${cell(call.model)} | ${call.inputTokens}/${call.outputTokens} | ${call.priced ? money(call.costUsd) : 'unpriced'} |`)
    }
  }
  lines.push('')

  lines.push('## Audit')
  lines.push('')
  lines.push(`- Chain: ${report.audit.ok ? 'intact' : '**a problem was found**'} — ${report.audit.eventsChecked} event(s) verified${report.audit.unverifiable ? `, ${report.audit.unverifiable} predate chaining` : ''}`)
  if (report.audit.checkpointSequence) lines.push(`- Anchored at sequence ${report.audit.checkpointSequence}${report.audit.anchorSequence ? ` (and ${report.audit.anchorSequence} in the anchor file)` : ''}`)
  if (report.audit.truncated) lines.push('- **The chain is shorter than an anchor recorded: the tail was removed, or this file was restored from a backup.**')
  if (report.audit.checkpointMissing) lines.push('- **An anchor exists with no checkpoint row to match it: the row was deleted.**')
  if (report.audit.brokenAt) lines.push(`- **A chained event at sequence ${report.audit.brokenAt} no longer matches its hash.**`)
  lines.push('')
  lines.push(`_${report.messages} message(s) in this run. Generated by Fulkrum._`)
  lines.push('')
  return lines.join('\n')
}
