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
    messages: [], tasks: [], verdicts: [], claims: [], events: [], byTask: [], runGrants: [], plan: null, approval: null, streaming: null,
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
    const bridge = fixture({ editPlan, estimate: { runId: 'r1', tasks: 2, expectedCalls: 14, basis: 'from 12 priced call(s) in this database', estimateUsd: { low: 0.02, average: 0.04, high: 0.06 }, perCall: null, ceilingUsd: null }, plan: { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'Inspect the workspace.', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Read files', instructions: 'Read the source.', acceptanceCheck: 'Cite the relevant files.', dependsOn: [] }] } })
    render(<ChatView bridge={bridge} />)
    expect(screen.getByText('Cite the relevant files.')).toBeVisible()
    expect(screen.getByText(/~14 model calls/)).toBeInTheDocument()
    expect(screen.getByText(/est\. \$0\.02–\$0\.06/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Task 1 acceptance'), { target: { value: 'Include file and line references.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(editPlan).toHaveBeenCalledWith('Inspect the workspace.', [expect.objectContaining({ acceptanceCheck: 'Include file and line references.', instructions: 'Read the source.', role: 'research', dependsOn: [] })]))
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
    await waitFor(() => expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan1', planHash: 'hash', unlimitedAcknowledged: true }))
  })

  it('approves a budgeted run without the acknowledgment', async () => {
    const control = vi.fn().mockResolvedValue({ id: 'r1' })
    render(<ChatView bridge={fixture({ control, run: { id: 'r1', projectId: 'p1', status: 'planning', budgetUsd: 5 } as Bridge['run'], plan: draftPlan })} />)
    expect(screen.queryByText(/no spending limit/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Run' }))
    await waitFor(() => expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan1', planHash: 'hash' }))
  })
})
