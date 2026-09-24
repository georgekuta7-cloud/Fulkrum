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
    messages: [], tasks: [], claims: [], events: [], byTask: [], runGrants: [], plan: null, approval: null, streaming: null,
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
    const bridge = fixture({ editPlan, plan: { plan: { id: 'plan1', version: 1, status: 'draft', objective: 'Inspect the workspace.', contentHash: 'hash', source: 'model' }, tasks: [{ id: 'pt1', orderIndex: 0, role: 'research', title: 'Read files', instructions: 'Read the source.', acceptanceCheck: 'Cite the relevant files.', dependsOn: [] }] } })
    render(<ChatView bridge={bridge} />)
    expect(screen.getByText('Cite the relevant files.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Task 1 acceptance'), { target: { value: 'Include file and line references.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(editPlan).toHaveBeenCalledWith('Inspect the workspace.', [expect.objectContaining({ acceptanceCheck: 'Include file and line references.', instructions: 'Read the source.', role: 'research', dependsOn: [] })]))
  })
})
