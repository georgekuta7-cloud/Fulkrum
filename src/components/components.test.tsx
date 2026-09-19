import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApprovalDock } from './ApprovalDock'
import { TopBar } from './TopBar'
import { PlanPanel } from './PlanPanel'
import { Sidebar } from './Sidebar'
import { ChatFeed } from './ChatFeed'
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

  it('answers a worker question instead of approving it', async () => {
    const answerCall = vi.fn()
    render(<ApprovalDock bridge={makeBridge({
      approval: {
        toolCall: { ...pendingCall, name: 'run.ask', kind: 'ask', resolved: { tool: 'run.ask', question: 'Which color?', context: 'red or blue' } } as any,
        rule: 'ask.question', warnings: [], preview: null,
      },
      answerCall,
    })} />)

    expect(screen.getByText('Which color?')).toBeInTheDocument()
    // Approve buttons make no sense for a question: there is nothing to run.
    expect(screen.queryByRole('button', { name: /Approve once/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Answer/), { target: { value: 'blue' } })
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }))
    expect(answerCall).toHaveBeenCalledWith('blue')
  })

  it('edits a pending write and approves the edited bytes', async () => {
    const approveCall = vi.fn()
    render(<ApprovalDock bridge={makeBridge({
      approval: {
        toolCall: pendingCall as any,
        rule: 'ask.default',
        warnings: [],
        preview: { path: 'src/app.ts', created: false, bytes: 6, content: 'hello\n', hunks: [] },
      },
      approveCall,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    // The query is normalized but the value is not: search for the trimmed text.
    const editor = await screen.findByDisplayValue('hello')
    fireEvent.change(editor, { target: { value: 'hi\n' } })
    fireEvent.click(screen.getByRole('button', { name: /Approve edits/ }))
    expect(approveCall).toHaveBeenCalledWith('once', { path: 'src/app.ts', content: 'hi\n' })
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

describe('the top bar', () => {
  const run = { id: 'run-1', projectId: 'p1', status: 'executing', mode: 'plan', permissionMode: 'selective', planVersion: 1, budgetUsd: 2, createdAt: 1, updatedAt: 2 }
  const topBarProps = { view: 'graph' as const, onViewChange: vi.fn(), onOpenInspector: vi.fn(), onOpenSettings: vi.fn(), theme: 'dark' as const, onToggleTheme: vi.fn() }

  it('shows the cost against the ceiling, and its per-task breakdown on demand', () => {
    render(<TopBar bridge={makeBridge({
      run: run as any,
      tasks: [{ id: 't1', agentId: 'research', title: 'Look around', status: 'completed' }] as any,
      spend: { costUsd: 0.0432, calls: 7, unpricedCalls: 1 },
      byTask: [{ taskId: 't1', title: 'Look around', agentId: 'research', costUsd: 0.02, calls: 3, unpricedCalls: 0 }, { taskId: null, title: 'supervisor', agentId: 'head', costUsd: 0.0232, calls: 4, unpricedCalls: 1 }],
      estimate: { runId: 'run-1', tasks: 1, expectedCalls: 6, basis: 'from 7 priced call(s)', estimateUsd: { low: 0.01, average: 0.03, high: 0.09 }, perCall: { average: 0.006, low: 0.001, high: 0.02 }, ceilingUsd: 2 },
    })} {...topBarProps} />)

    expect(screen.getByText(/0\.0432/)).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /0\.0432/ }))
    expect(screen.getByText('Look around')).toBeInTheDocument()
    expect(screen.getByText('supervisor')).toBeInTheDocument()
    expect(screen.getByText(/lower bound/)).toBeInTheDocument()
  })

  it('flags the chat view when a decision is waiting', () => {
    render(<TopBar bridge={makeBridge({
      run: run as any,
      approval: { toolCall: pendingCall as any, rule: 'ask.default', warnings: [], preview: null },
    })} {...topBarProps} />)

    expect(screen.getByTitle('A decision is waiting')).toBeInTheDocument()
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

describe('the chat feed', () => {
  const feedBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    run: { id: 'run-1', status: 'planning' } as any,
    messages: [{ id: 1, role: 'user', agentId: null, content: 'Ship a narrow proof.', createdAt: 1, metadata: null }] as any,
    plan: {
      plan: { id: 'plan-1', version: 2, objective: 'Ship a narrow proof.', contentHash: 'hash1234567890', status: 'draft', source: 'model' },
      tasks: [
        { id: 'pt1', orderIndex: 0, role: 'research', title: 'Look', instructions: 'Look around.', dependsOn: [] },
        { id: 'pt2', orderIndex: 1, role: 'builder', title: 'Write', instructions: 'Write it.', dependsOn: [0] },
      ],
    } as any,
    events: [
      { eventId: 'e1', runId: 'run-1', sequence: 1, type: 'plan.drafted', agentId: 'head', payload: { planId: 'plan-1' }, createdAt: 2000 },
      { eventId: 'e2', runId: 'run-1', sequence: 2, type: 'task.started', agentId: 'research', payload: { taskId: 't1' }, createdAt: 3000 },
      { eventId: 'e3', runId: 'run-1', sequence: 3, type: 'task.completed', agentId: 'research', payload: { taskId: 't1' }, createdAt: 9000 },
    ] as any,
    tasks: [{ id: 't1', agentId: 'research', title: 'Look', status: 'completed', planTaskId: 'pt1', result: 'Found it.' }] as any,
    toolCalls: [
      { id: 'c1', runId: 'run-1', agentId: 'research', name: 'workspace.read', kind: 'read', status: 'completed', input: { path: 'README.md' }, resolved: null, fingerprint: null, ruleId: null, warnings: [], approvalScope: null, error: null, createdAt: 4000 },
      { id: 'c2', runId: 'run-1', agentId: 'research', name: 'workspace.write', kind: 'write', status: 'completed', input: { path: 'proof.txt' }, resolved: null, fingerprint: null, ruleId: null, warnings: [], approvalScope: null, error: null, createdAt: 5000 },
    ] as any,
    artifacts: [{ toolCallId: 'c2', agentId: 'research', path: 'proof.txt', bytes: 12, created: true, previousBytes: null, diffAvailable: true, diff: { added: 3, removed: 0, hunks: [] }, at: 5000 }] as any,
    byTask: [{ taskId: 't1', title: 'Look', agentId: 'research', costUsd: 0.01, calls: 2, unpricedCalls: 0 }],
    ...overrides,
  })

  it('narrates the plan and approves it from the chat', () => {
    const control = vi.fn()
    render(<ChatFeed bridge={feedBridge({ control })} />)

    expect(screen.getByText(/Plan v2 · Ship a narrow proof/)).toBeInTheDocument()
    expect(screen.getByText('no deps')).toBeInTheDocument()
    expect(screen.getByText('after 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }))
    expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan-1', planHash: 'hash1234567890', routing: {} })
  })

  it('shows what a worker did, with what it added and removed', () => {
    render(<ChatFeed bridge={feedBridge()} />)

    const head = screen.getByRole('button', { name: /worked for 6\.0s · 2 tool calls · \$0\.0100/ })
    // The card opens on the calls: the read, and the write with its diff stats.
    fireEvent.click(head)
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText('proof.txt')).toBeInTheDocument()
    expect(screen.getByText('+3')).toBeInTheDocument()
    expect(screen.getByText('−0')).toBeInTheDocument()
  })

  it('closes with the review card once the head has reviewed', () => {
    render(<ChatFeed bridge={feedBridge({
      events: [...feedBridge().events, { eventId: 'e4', runId: 'run-1', sequence: 4, type: 'run.review.ready', agentId: 'head', payload: { summary: 'Both findings check out.' }, createdAt: 10 }] as any,
    })} />)

    expect(screen.getByText('Run review')).toBeInTheDocument()
    expect(screen.getByText('Both findings check out.')).toBeInTheDocument()
    expect(screen.getByText(/Full report/)).toBeInTheDocument()
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
