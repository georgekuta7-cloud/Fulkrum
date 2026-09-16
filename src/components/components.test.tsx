import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApprovalDock } from './ApprovalDock'
import { RunHeader } from './RunHeader'
import { PlanPanel } from './PlanPanel'
import { Sidebar } from './Sidebar'
import type { Bridge } from '../hooks/useBridge'

/**
 * Components take one `bridge` object, so a test states only the parts it reads.
 * Everything not listed stays undefined, which is also a check that a component does
 * not reach for something it was not given.
 */
function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    projects: [], projectId: 'p1', runs: [], runId: 'run-1', run: null, tasks: [], messages: [], toolCalls: [], events: [],
    plan: null, artifacts: [], spend: { costUsd: 0, calls: 0, unpricedCalls: 0 }, byTask: [], estimate: null, audit: null,
    providers: [], status: null, grants: [], configReport: null, usage: null, error: null, notice: null, streaming: null, approval: null,
    setError: vi.fn(), setNotice: vi.fn(), setApproval: vi.fn(),
    openProject: vi.fn(), openRun: vi.fn(), loadRuns: vi.fn(), loadStatus: vi.fn(), loadGrants: vi.fn(), loadConfig: vi.fn(), loadUsage: vi.fn(), loadProviders: vi.fn(),
    approveCall: vi.fn(), denyCall: vi.fn(), control: vi.fn(), chat: vi.fn(), draftPlan: vi.fn(), editPlan: vi.fn(),
    createProject: vi.fn(), deleteProject: vi.fn(), revertArtifact: vi.fn(), forkRun: vi.fn(), revokeRunGrant: vi.fn(),
    saveProvider: vi.fn(), addProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(),
    createGrant: vi.fn(), revokeGrant: vi.fn(), verifyAudit: vi.fn(), backupNow: vi.fn(),
    search: vi.fn(), tree: vi.fn(), fileHistory: vi.fn(), reloadRuns: vi.fn(), approveWithKeyboard: vi.fn(),
    ...overrides,
  } as unknown as Bridge
}

const pendingCall = {
  id: 'tool-9', runId: 'run-1', agentId: 'builder', name: 'workspace.write', kind: 'write', status: 'approval_required',
  input: {}, resolved: { tool: 'workspace.write', path: 'D:/ws/src/app.ts', relative: 'src/app.ts', bytes: 12, contentSha256: 'abc123def456' },
  fingerprint: 'f'.repeat(64), ruleId: 'ask.default', warnings: [], approvalScope: null, error: 'write actions require approval in selective mode.', createdAt: 1,
}

describe('the approval dock', () => {
  it('shows what will run, why it stopped, and what it would change', () => {
    render(<ApprovalDock bridge={makeBridge({
      approval: {
        toolCall: pendingCall as any,
        rule: 'ask.default',
        warnings: [{ field: 'content', kinds: ['openai-key'] }],
        preview: { path: 'src/app.ts', created: false, added: 2, removed: 1, hunks: [{ entries: [{ type: 'remove', line: 'old()', number: 1 }, { type: 'add', line: 'next()', number: 1 }] }] },
      },
    })} />)

    expect(screen.getByText('workspace.write')).toBeInTheDocument()
    expect(screen.getByText('ask.default')).toBeInTheDocument()
    // The path is in two places on purpose: the resolved call, and the diff's header.
    expect(screen.getByText(/write src\/app\.ts/)).toBeInTheDocument()
    expect(screen.getAllByText(/src\/app\.ts/).length).toBe(2)
    expect(screen.getByText(/shaped like a credential/)).toBeInTheDocument()
    expect(screen.getByText('old()')).toBeInTheDocument()
    expect(screen.getByText('next()')).toBeInTheDocument()
    expect(screen.getByText(/approving runs exactly this/)).toBeInTheDocument()
  })

  it('approves once on "a", and opens the deny field on "d"', async () => {
    const approveCall = vi.fn()
    const denyCall = vi.fn()
    render(<ApprovalDock bridge={makeBridge({ approval: { toolCall: pendingCall as any, rule: 'ask.default', warnings: [], preview: null }, approveCall, denyCall })} />)

    fireEvent.keyDown(window, { key: 'a' })
    expect(approveCall).toHaveBeenCalledWith('once')

    fireEvent.keyDown(window, { key: 'd' })
    const reason = await screen.findByPlaceholderText(/Why not/)
    fireEvent.change(reason, { target: { value: 'Not that file.' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    expect(denyCall).toHaveBeenCalledWith('Not that file.')
  })

  it('does not offer a standing grant for a command, because it has no scope', () => {
    render(<ApprovalDock bridge={makeBridge({
      approval: {
        toolCall: { ...pendingCall, name: 'shell.exec', kind: 'shell', resolved: { tool: 'shell.exec', argv: ['npm', 'install'], cwd: 'D:/ws' } } as any,
        rule: 'ask.shell-outside-autopilot', warnings: [], preview: null,
      },
    })} />)

    expect(screen.getByRole('button', { name: /^Always$/ })).toBeDisabled()
    expect(screen.getByText('npm install')).toBeInTheDocument()
  })
})

describe('the run header', () => {
  const run = { id: 'run-1', projectId: 'p1', status: 'executing', mode: 'plan', permissionMode: 'selective', planVersion: 1, budgetUsd: 2, createdAt: 1, updatedAt: 2 }

  it('shows the cost, and its per-task breakdown on demand', () => {
    render(<RunHeader bridge={makeBridge({
      run: run as any,
      tasks: [{ id: 't1', agentId: 'research', title: 'Look around', status: 'completed' }] as any,
      spend: { costUsd: 0.0432, calls: 7, unpricedCalls: 1 },
      byTask: [{ taskId: 't1', title: 'Look around', agentId: 'research', costUsd: 0.02, calls: 3, unpricedCalls: 0 }, { taskId: null, title: 'supervisor', agentId: 'head', costUsd: 0.0232, calls: 4, unpricedCalls: 1 }],
      estimate: { runId: 'run-1', tasks: 1, expectedCalls: 6, basis: 'from 7 priced call(s)', estimateUsd: { low: 0.01, average: 0.03, high: 0.09 }, perCall: { average: 0.006, low: 0.001, high: 0.02 }, ceilingUsd: 2 },
    })} />)

    expect(screen.getByText('$0.0432')).toBeInTheDocument()
    expect(screen.getByText(/1 unpriced/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /0\.0432/ }))
    expect(screen.getByText('Look around')).toBeInTheDocument()
    expect(screen.getByText('supervisor')).toBeInTheDocument()
    expect(screen.getByText(/lower bound/)).toBeInTheDocument()
  })
})

describe('the plan panel', () => {
  const bridgeWithPlan = (overrides: Partial<Bridge> = {}) => makeBridge({
    run: { id: 'run-1', status: 'planning' } as any,
    plan: {
      plan: { id: 'plan-1', version: 2, objective: 'Ship it', contentHash: 'hash123456789', status: 'draft', source: 'model' },
      tasks: [
        { id: 'pt1', orderIndex: 0, role: 'research', title: 'Look', instructions: 'Look around.', dependsOn: [] },
        { id: 'pt2', orderIndex: 1, role: 'builder', title: 'Write', instructions: 'Write it.', dependsOn: [0] },
      ],
    } as any,
    ...overrides,
  })

  it('renders the tasks, their roles and their dependencies', () => {
    render(<PlanPanel bridge={bridgeWithPlan()} />)
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('Look')).toBeInTheDocument()
    expect(screen.getByText(/after 1/)).toBeInTheDocument()
    expect(screen.getByText('v2 · draft')).toBeInTheDocument()
  })

  it('sends an edited plan through the same validation path as a generated one', async () => {
    const editPlan = vi.fn().mockResolvedValue(true)
    render(<PlanPanel bridge={bridgeWithPlan({ editPlan })} />)

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    const title = await screen.findByDisplayValue('Look')
    fireEvent.change(title, { target: { value: 'Look harder' } })
    fireEvent.click(screen.getByRole('button', { name: /Save plan/ }))

    expect(editPlan).toHaveBeenCalledTimes(1)
    const [objective, tasks] = editPlan.mock.calls[0]
    expect(objective).toBe('Ship it')
    expect(tasks[0].title).toBe('Look harder')
    expect(tasks[1].dependsOn).toEqual([0])
  })
})

describe('the sidebar', () => {
  it('searches, and opens the run a hit came from', async () => {
    const openRun = vi.fn()
    const search = vi.fn().mockResolvedValue({
      query: 'postgres',
      messages: [{ kind: 'message', id: '1', runId: 'run-7', role: 'user', agentId: null, snippet: '…migrate to postgres…', createdAt: 1 }],
      events: [],
      truncated: false,
    })
    render(<Sidebar bridge={makeBridge({ search, openRun, projects: [{ id: 'p1', name: 'Launch plan' }], projectId: 'p1' })} />)

    fireEvent.change(screen.getByPlaceholderText(/Search messages/), { target: { value: 'postgres' } })
    const hit = await screen.findByText(/migrate to postgres/)
    fireEvent.click(hit)
    expect(openRun).toHaveBeenCalledWith('run-7')
  })
})
