import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../hooks/useBridge'
import { Header } from './Header'
import { ChatView } from './ChatView'

function fixture(overrides: Partial<Bridge> = {}): Bridge {
  return {
    projectId: 'p1', projects: [{ id: 'p1', name: 'Fixture' }], projectSettings: {}, projectLoading: false,
    runId: 'r1', runLoading: false, run: { id: 'r1', projectId: 'p1', status: 'planning', budgetUsd: null },
    providers: [{ id: 'fixture', label: 'Fixture', model: 'fixture', configured: true }], status: null,
    messages: [], tasks: [], toolCalls: [], verdicts: [], claims: [], events: [], byTask: [], runGrants: [], plan: null, approval: null, streaming: null,
    spend: { costUsd: 0, calls: 0, unpricedCalls: 0 }, estimate: null,
    control: vi.fn().mockResolvedValue(null), createRun: vi.fn(), chat: vi.fn().mockResolvedValue(true),
    draftPlan: vi.fn().mockResolvedValue(true), approveCall: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as Bridge
}

describe('run lifecycle controls', () => {
  it.each(['interrupted', 'budget_exceeded', 'failed'])('offers recovery for a %s run', (status) => {
    const bridge = fixture({ run: { id: 'r1', projectId: 'p1', status, budgetUsd: null } as Bridge['run'] })
    render(<Header bridge={bridge} theme="dark" onToggleTheme={vi.fn()} onOpenSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume run' }))
    expect(bridge.control).toHaveBeenCalledWith('resume')
    if (status === 'failed') expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })
})

describe('conversation decisions', () => {
  it('does not convert browser shortcuts or editable text into approval decisions', () => {
    const approveCall = vi.fn().mockResolvedValue(true)
    const bridge = fixture({ approveCall, approval: { toolCall: { id: 'call1', runId: 'r1', agentId: 'builder', kind: 'exec', name: 'shell.exec', status: 'approval_required', input: {}, resolved: { argv: ['npm', 'test'] }, fingerprint: 'fixture-hash', ruleId: 'ask.default', warnings: [], approvalScope: null, error: null, createdAt: 1 }, rule: 'ask.default', warnings: [], preview: null } })
    render(<><ChatView bridge={bridge} /><div contentEditable suppressContentEditableWarning aria-label="Editable note">A note</div></>)
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'r', metaKey: true })
    fireEvent.keyDown(window, { key: 'a', repeat: true })
    fireEvent.keyDown(screen.getByLabelText('Editable note'), { key: 'a' })
    expect(approveCall).not.toHaveBeenCalled()
  })

  it('keeps a failed chat draft available to retry', async () => {
    render(<ChatView bridge={fixture({ chat: vi.fn().mockResolvedValue(false) })} />)
    const input = screen.getByLabelText('Direct the Head AI')
    fireEvent.change(input, { target: { value: 'Keep my work.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send (Ctrl+Enter)' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send (Ctrl+Enter)' })).toBeEnabled())
    expect(input).toHaveValue('Keep my work.')
  })

  it('makes plan instructions and acceptance criteria inspectable and editable', async () => {
    const editPlan = vi.fn().mockResolvedValue(true)
    const bridge = fixture({ editPlan, estimate: { runId: 'r1', tasks: 2, expectedCalls: 14, basis: 'from 12 priced call(s) in this database', estimateUsd: { low: 0.02, average: 0.04, high: 0.06 }, perCall: null, ceilingUsd: null }, plan: { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'Inspect the workspace.', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Read files', instructions: 'Read the source.', acceptanceCheck: 'Cite the relevant files.', check: { type: 'human', criterion: 'Cite the relevant files.' }, dependsOn: [] }] } })
    render(<ChatView bridge={bridge} />)
    expect(screen.getByText('Cite the relevant files.')).toBeVisible()
    expect(screen.getByText(/human check/)).toBeInTheDocument()
    expect(screen.getByText(/~14 model calls/)).toBeInTheDocument()
    expect(screen.getByText(/est\. \$0\.02–\$0\.06/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Task 1 criterion'), { target: { value: 'Include file and line references.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(editPlan).toHaveBeenCalledWith('Inspect the workspace.', [expect.objectContaining({ instructions: 'Read the source.', role: 'research', dependsOn: [], check: expect.objectContaining({ type: 'human', criterion: 'Include file and line references.' }) })]))
  })

  it('edits a typed command check and sends the typed shape', async () => {
    const editPlan = vi.fn().mockResolvedValue(true)
    const bridge = fixture({ editPlan, plan: { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'O', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'builder', title: 'Test it', instructions: 'Run the tests.', acceptanceCheck: 'Tests pass.', check: { type: 'human', criterion: 'Tests pass.' }, dependsOn: [] }] } })
    render(<ChatView bridge={bridge} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Task 1 check type'), { target: { value: 'command' } })
    fireEvent.change(screen.getByLabelText('Task 1 command'), { target: { value: 'npm' } })
    fireEvent.change(screen.getByLabelText('Task 1 arguments'), { target: { value: 'test --silent' } })
    fireEvent.change(screen.getByLabelText('Task 1 expected exit code'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(editPlan).toHaveBeenCalledWith('O', [expect.objectContaining({ check: { type: 'command', command: 'npm', args: ['test', '--silent'], expectExit: 0 } })]))
  })

  it('separates worker completion from the verification verdict', () => {
    const plan = { plan: { id: 'plan1', version: 1, status: 'approved', objective: 'O', contentHash: 'h', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Read files', instructions: 'I', acceptanceCheck: '', dependsOn: [] }] }
    const tasks = [{ id: 't1', agentId: 'research', title: 'Read files', status: 'completed', planTaskId: 'pt1' }]
    const { unmount } = render(<ChatView bridge={fixture({
      tasks,
      plan,
      verdicts: [{ id: 'v1', runId: 'r1', taskId: 't1', overall: 'UNKNOWN', results: [], checkedBy: null, createdAt: 1 }],
    })} />)
    expect(screen.getByText('unproven')).toBeInTheDocument()
    expect(screen.queryByText('verified')).not.toBeInTheDocument()
    unmount()

    render(<ChatView bridge={fixture({
      tasks,
      plan,
      verdicts: [{ id: 'v2', runId: 'r1', taskId: 't1', overall: 'PASS', results: [], checkedBy: null, createdAt: 1 }],
    })} />)
    expect(screen.getByText('verified')).toBeInTheDocument()
  })

  it('says when a plan cannot be priced instead of guessing', () => {
    render(<ChatView bridge={fixture({
      estimate: { runId: 'r1', tasks: 3, expectedCalls: 21, basis: 'no priced calls in this database yet', estimateUsd: null, perCall: null, ceilingUsd: null },
      plan: { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'O', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'T', instructions: 'I', acceptanceCheck: '', dependsOn: [] }] },
    })} />)
    expect(screen.getByText(/cost not estimable yet/)).toBeInTheDocument()
    expect(screen.getByText(/no priced calls in this database yet/)).toBeInTheDocument()
  })

  it('says a live-folder checkpoint was taken, and when it failed', () => {
    const baseline = { eventId: 'e1', runId: 'r1', sequence: 1, type: 'checkpoint.baseline', agentId: 'head', payload: { commit: 'abcdef1234567890', files: 12, reused: false }, createdAt: 1 }
    const { unmount } = render(<ChatView bridge={fixture({ events: [baseline] })} />)
    expect(screen.getByText(/A checkpoint of covered files was taken/)).toBeInTheDocument()
    expect(screen.getByText(/node_modules, \.git, data/)).toBeInTheDocument()
    unmount()

    const failed = { eventId: 'e2', runId: 'r1', sequence: 2, type: 'checkpoint.failed', agentId: 'head', payload: { source: 'baseline', reason: 'Host Git is not available' }, createdAt: 1 }
    render(<ChatView bridge={fixture({ events: [failed] })} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/did not start/)
    expect(screen.getByRole('alert')).toHaveTextContent(/Host Git is not available/)
  })

  it('shows the approved outcomes with their provenance, not a claims score', () => {
    const review = {
      eventId: 'e1', runId: 'r1', sequence: 9, type: 'run.review.ready', agentId: 'head', createdAt: 1,
      payload: { proof: { outcomes: { tallies: { total: 3, proven: 1, unknown: 2, failed: 0, pending: 0 }, items: [
        { id: 'o1', taskIndex: 0, type: 'command', text: 'Tests pass.', status: 'PASS', provenance: 'executed check' },
        { id: 'o2', taskIndex: 1, type: 'human', text: 'The flow is mapped.', status: 'UNKNOWN', provenance: 'model judgment' },
        { id: 'o3', taskIndex: 2, type: 'human', text: 'The report cites files.', status: 'UNKNOWN', provenance: null },
      ] } } },
    }
    render(<ChatView bridge={fixture({ events: [review] })} />)
    expect(screen.getByText('1 proven · 2 unproven')).toBeInTheDocument()
    expect(screen.getByText('executed check')).toBeInTheDocument()
    expect(screen.getByText('model judgment')).toBeInTheDocument()
    expect(screen.getByText(/never the score/)).toBeInTheDocument()
  })

  it('shows a revised plan against its previous version, and the reminder inside the run', () => {
    const revision = { previousVersion: 1, previousStatus: 'approved', added: ['Ship it'], removed: ['Old task'], changed: ['Look'] }
    const { unmount } = render(<ChatView bridge={fixture({
      plan: { plan: { id: 'plan2', version: 2, status: 'draft', objective: 'O', contentHash: 'h2', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Look', instructions: 'I', acceptanceCheck: 'C', dependsOn: [] }], revision },
    })} />)
    expect(screen.getByText(/Revised from v1 \(approved\)/)).toBeInTheDocument()
    expect(screen.getByText(/added: Ship it/)).toBeInTheDocument()
    expect(screen.getByText(/removed: Old task/)).toBeInTheDocument()
    unmount()

    render(<ChatView bridge={fixture({
      run: { id: 'r1', projectId: 'p1', status: 'review', budgetUsd: 10 } as Bridge['run'],
      plan: { plan: { id: 'plan2', version: 2, status: 'draft', objective: 'O', contentHash: 'h2', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Look', instructions: 'I', acceptanceCheck: 'C', dependsOn: [] }] },
    })} />)
    expect(screen.getByText(/a revised plan needs approval below/)).toBeInTheDocument()
  })

  it('explains a provider retry while the run is executing', () => {
    const retry = { eventId: 'e1', runId: 'r1', sequence: 1, type: 'provider.retry', agentId: 'head', payload: { providerLabel: 'Luna', reason: 'rate limited', delayMs: 12000, attempt: 2, maxAttempts: 3 }, createdAt: Date.now() }
    const { unmount } = render(<ChatView bridge={fixture({ events: [retry], run: { id: 'r1', projectId: 'p1', status: 'executing', budgetUsd: null } as Bridge['run'] })} />)
    expect(screen.getByText(/Luna rate limited; retrying in 12s \(attempt 2 of 3\)/)).toBeInTheDocument()
    unmount()

    render(<ChatView bridge={fixture({ events: [retry], run: { id: 'r1', projectId: 'p1', status: 'review', budgetUsd: null } as Bridge['run'] })} />)
    expect(screen.queryByText(/retrying in 12s/)).not.toBeInTheDocument()
  })

  it('previews the effective dispatch before approval', () => {
    render(<ChatView bridge={fixture({
      plan: {
        plan: { id: 'plan1', version: 1, status: 'draft', objective: 'O', contentHash: 'h', source: 'model' },
        tasks: [{ id: 'pt1', orderIndex: 0, role: 'builder', title: 'Build', instructions: 'I', acceptanceCheck: 'C', dependsOn: [] }],
        dispatch: { rows: [{ taskIndex: 0, title: 'Build', role: 'builder', provider: 'Solo', model: 'solo-model', group: 'sequential', callsPerTask: 4, estCost: { low: 0.01, high: 0.04 } }], sharedKey: false, providersReady: true, budgetUsd: 5 },
      },
    })} />)
    expect(screen.getByText(/Dispatch preview/)).toBeInTheDocument()
    expect(screen.getByText('Solo · solo-model')).toBeInTheDocument()
    expect(screen.getByText(/\$0\.01–\$0\.04/)).toBeInTheDocument()
    expect(screen.getByText(/hard ceiling \$5/)).toBeInTheDocument()
  })

  it('shows remaining run and daily allowance distinctly from a limit', () => {
    render(<ChatView bridge={fixture({
      run: { id: 'r1', projectId: 'p1', status: 'planning', budgetUsd: 5 } as Bridge['run'],
      spend: { costUsd: 0.04, calls: 2, unpricedCalls: 0 },
      budget: { runUsd: 5, defaultRunUsd: null, dailyUsd: 10, dailySpentUsd: 0.04 },
      plan: draftPlan,
    })} />)
    expect(screen.getByText(/Limit \$5\.00 · \$4\.9600 left/)).toBeInTheDocument()
    expect(screen.getByText(/today \$0\.0400 of \$10\.00/)).toBeInTheDocument()
  })

  it('shows each worker its last tool call', () => {    render(<ChatView bridge={fixture({
      tasks: [{ id: 't1', agentId: 'research', title: 'Read files', status: 'running' } as any],
      toolCalls: [
        { id: 'c1', agentId: 'research', name: 'workspace.read', status: 'completed', createdAt: 1 },
        { id: 'c2', agentId: 'research', name: 'workspace.write', status: 'running', createdAt: 2 },
      ] as any,
    })} />)
    expect(screen.getByText(/last: workspace\.write · running/)).toBeInTheDocument()
  })

  it('shows the estimate recorded at approval, not a later recalculation', () => {
    render(<ChatView bridge={fixture({
      estimate: { runId: 'r1', tasks: 2, expectedCalls: 14, basis: 'from 12 priced call(s) in this database', estimateUsd: { low: 0.02, average: 0.04, high: 0.06 }, perCall: null, ceilingUsd: null },
      plan: { plan: { id: 'plan1', version: 1, status: 'approved', objective: 'O', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'T', instructions: 'I', acceptanceCheck: '', dependsOn: [] }] },
      events: [{ eventId: 'e1', runId: 'r1', sequence: 1, type: 'plan.estimate', agentId: 'head', payload: { planId: 'plan1', hash: 'hash', estimate: { runId: 'r1', tasks: 2, expectedCalls: 9, basis: 'from 4 priced call(s) in this database', estimateUsd: { low: 0.01, average: 0.02, high: 0.03 }, perCall: null, ceilingUsd: null } }, createdAt: 1 }],
    })} />)
    expect(screen.getByText(/~9 model calls/)).toBeInTheDocument()
    expect(screen.getByText(/recorded at approval/)).toBeInTheDocument()
    expect(screen.queryByText(/~14 model calls/)).not.toBeInTheDocument()
  })

  const draftPlan = { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'O', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'T', instructions: 'I', acceptanceCheck: '', dependsOn: [] }] }

  it('requires an explicit acknowledgment before approving a run with no spending limit', async () => {
    const control = vi.fn().mockResolvedValue({ id: 'r1' })
    render(<ChatView bridge={fixture({ control, plan: draftPlan })} />)
    const approve = screen.getByRole('button', { name: 'Approve & Run' })
    expect(approve).toBeDisabled()
    expect(screen.getByText(/no spending limit/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/Approve without a limit/))
    expect(approve).toBeEnabled()
    fireEvent.click(approve)
    await waitFor(() => expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan1', planHash: 'hash', unlimitedAcknowledged: true, verificationSteps: 3 }))
  })

  it('shows the reviewer route and sends the chosen verifier budget', async () => {
    const control = vi.fn().mockResolvedValue({ id: 'r1' })
    render(<ChatView bridge={fixture({ control, plan: draftPlan })} />)
    expect(screen.getByText(/same as the worker’s route/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Verifier steps'), { target: { value: '7' } })
    fireEvent.click(screen.getByLabelText(/Approve without a limit/))
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Run' }))
    await waitFor(() => expect(control).toHaveBeenCalledWith('approve-plan', expect.objectContaining({ verificationSteps: 7 })))
  })

  it('approves a budgeted run without the acknowledgment', async () => {
    const control = vi.fn().mockResolvedValue({ id: 'r1' })
    render(<ChatView bridge={fixture({ control, run: { id: 'r1', projectId: 'p1', status: 'planning', budgetUsd: 5 } as Bridge['run'], plan: draftPlan })} />)
    expect(screen.queryByText(/no spending limit/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Run' }))
    await waitFor(() => expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan1', planHash: 'hash', verificationSteps: 3 }))
  })
})
