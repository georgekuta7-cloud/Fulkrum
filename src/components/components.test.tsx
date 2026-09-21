import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ApprovalDock } from './ApprovalDock'
import { TopBar } from './TopBar'
import { PlanPanel } from './PlanPanel'
import { Sidebar } from './Sidebar'
import { ChatFeed } from './ChatFeed'
import { CastingLine } from './CastingLine'
import { TimelinePanel } from './TimelinePanel'
import { ActivityPanel } from './ActivityPanel'
import { MarketplacePanel } from './MarketplacePanel'
import { ArsenalPanel } from './ArsenalPanel'
import { AutomationsPanel } from './AutomationsPanel'
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
    providers: [], status: null, grants: [], configReport: null, usage: null, error: null, notice: null, streaming: null, approval: null, projectSettings: {}, claims: [],
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

  it('windows a long feed and opens history on request', () => {
    const messages = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1, role: index % 2 ? 'assistant' : 'user', agentId: null,
      content: `Message number ${index + 1}.`, createdAt: index + 1, metadata: null,
    }))
    render(<ChatFeed bridge={feedBridge({ messages: messages as any, plan: null, tasks: [], events: [] as any })} />)

    expect(screen.queryByText('Message number 1.')).not.toBeInTheDocument()
    expect(screen.getByText('Message number 150.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show 50 earlier/ }))
    expect(screen.getByText('Message number 1.')).toBeInTheDocument()
  })

  it('lists the run claims on the review card, with what each one proved', () => {
    render(<ChatFeed bridge={feedBridge({
      events: [...feedBridge().events, { eventId: 'e4', runId: 'run-1', sequence: 4, type: 'run.review.ready', agentId: 'head', payload: { summary: 'Checked.' }, createdAt: 10 }] as any,
      claims: [
        { id: 'claim-1', runId: 'run-1', taskId: 't1', kind: 'finding', summary: 'The flow completes.', path: 'README.md', startLine: 1, endLine: null, sha256: null, evidenceId: 'ev-1', verdict: 'PASS', createdAt: 6 },
        { id: 'claim-2', runId: 'run-1', taskId: 't1', kind: 'test', summary: 'npm test (exit 0)', path: null, startLine: null, endLine: null, sha256: null, evidenceId: null, verdict: null, createdAt: 7 },
      ] as any,
    })} />)

    expect(screen.getByText(/1\/2 claims proven/)).toBeInTheDocument()
    expect(screen.getByText('The flow completes.')).toBeInTheDocument()
    expect(screen.getByText('npm test (exit 0)')).toBeInTheDocument()
  })
})

describe('the activity panel', () => {
  it('windows a long event log and opens history on request', () => {
    const events = Array.from({ length: 350 }, (_, index) => ({
      eventId: `e${index}`, runId: 'run-1', sequence: index + 1, type: 'tool.completed',
      agentId: 'builder', payload: {}, createdAt: index + 1,
    }))
    render(<ActivityPanel bridge={makeBridge({ runId: 'run-1', events: events as any, tasks: [], streaming: null, timeline: null })} />)

    expect(screen.getByText('350 event(s)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show 50 earlier/ }))
    expect(screen.queryByRole('button', { name: /Show .* earlier/ })).not.toBeInTheDocument()
  })
})

describe('the casting line', () => {
  const tasks = [
    { role: 'research', title: 'Look', instructions: 'Look.', dependsOn: [] },
    { role: 'builder', title: 'Write', instructions: 'Write.', dependsOn: [0] },
  ] as any

  it('names who plays each role, defaulting openly', () => {
    render(<CastingLine bridge={makeBridge({
      projectSettings: { routing: { research: 'Grok' } },
      providers: [
        { id: 'grok', label: 'Grok', model: 'grok-4' },
        { id: 'openai', label: 'OpenAI', model: 'gpt-5' },
      ] as any,
    })} tasks={tasks} />)

    expect(screen.getByText(/Scout → Grok · grok-4/)).toBeInTheDocument()
    expect(screen.getByText(/Forge → default/)).toBeInTheDocument()
  })
})

describe('the timeline panel', () => {
  const timelineBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    timeline: {
      seq: 12,
      files: [
        { path: 'notes.txt', content: 'v1\n', truncated: false, unknown: null },
        { path: 'gone.txt', content: null, truncated: false, unknown: 'deleted since' },
      ],
      gaps: ['gone.txt'],
    },
    ...overrides,
  })

  it('shows files as of the index, gaps by name, and restores on demand', () => {
    const restoreTimelineFile = vi.fn()
    render(<TimelinePanel bridge={timelineBridge({ restoreTimelineFile })} maxSeq={20} onClose={vi.fn()} />)

    expect(screen.getByText(/event 12 of 20/)).toBeInTheDocument()
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText(/unknown — deleted since/)).toBeInTheDocument()
    expect(screen.getByText(/Gaps the records cannot prove/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(restoreTimelineFile).toHaveBeenCalledWith('notes.txt')
  })

  it('says plainly when nothing was written yet', () => {
    render(<TimelinePanel bridge={timelineBridge({ timeline: { seq: 1, files: [], gaps: [] } })} maxSeq={20} onClose={vi.fn()} />)
    expect(screen.getByText(/No files written up to event 1/)).toBeInTheDocument()
  })
})

const storeBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
  marketplace: { enabled: true, signed: false, fetchedAt: null, stale: true, entries: [] },
  arsenal: { skills: [], plugins: [] },
  registry: null,
  loadMarketplaceState: vi.fn(), loadArsenalState: vi.fn(), refreshMarketplace: vi.fn(),
  installMarketplaceEntry: vi.fn(), uninstallMarketplaceEntry: vi.fn(),
  browseRegistry: vi.fn(), clearRegistry: vi.fn(), importMarketplaceSkill: vi.fn(),
  ...overrides,
})

describe('the marketplace', () => {
  const entries = [
    { kind: 'skill', id: 'pdf-processing', version: '2.1.0', sha256: 'a'.repeat(64), url: null, description: 'Reads PDFs.', trust: 'community', author: 'example-org', findings: [{ severity: 'medium', signal: 'reaches the network' }] },
    { kind: 'skill', id: 'tdd-autopilot', version: '1.0.0', sha256: 'b'.repeat(64), url: 'https://index.example/tdd.md', description: 'Red-green-refactor.', trust: 'verified' },
  ]

  it('shows trust side by side, flags scan notes, and installs on click', async () => {
    const installMarketplaceEntry = vi.fn()
    render(<MarketplacePanel bridge={storeBridge({
      marketplace: { enabled: true, signed: false, fetchedAt: null, stale: false, entries: entries as any },
      installMarketplaceEntry,
    })} />)

    expect(screen.getByText('pdf-processing')).toBeInTheDocument()
    expect(screen.getByTitle('Signed by the registry index')).toBeInTheDocument()
    expect(screen.getByTitle(/hash-pinned, not registry-signed/)).toBeInTheDocument()
    expect(screen.getByText(/reaches the network/)).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /Install/ })[0])
    expect(installMarketplaceEntry).toHaveBeenCalledWith('pdf-processing')
  })

  it('filters by search and trust, and stages an import from a URL', async () => {
    const importMarketplaceSkill = vi.fn()
    render(<MarketplacePanel bridge={storeBridge({
      marketplace: { enabled: true, signed: false, fetchedAt: null, stale: false, entries: entries as any },
      importMarketplaceSkill,
    })} />)

    fireEvent.change(screen.getByLabelText('Search marketplace'), { target: { value: 'tdd' } })
    expect(screen.queryByText('pdf-processing')).not.toBeInTheDocument()
    expect(screen.getByText('tdd-autopilot')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Verified' }))
    expect(screen.getByText('tdd-autopilot')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Skill URL to import'), { target: { value: 'https://example.com/skill.md' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }))
    expect(importMarketplaceSkill).toHaveBeenCalledWith({ url: 'https://example.com/skill.md' })
  })
})

describe('the arsenal', () => {
  it('lists installed skills and plugins, and uninstalls on click', () => {
    const uninstallMarketplaceEntry = vi.fn()
    render(<ArsenalPanel bridge={storeBridge({
      arsenal: {
        skills: [{ kind: 'skill', id: 'pdf-processing', version: null, description: 'Hand-placed.', updateAvailable: false }],
        plugins: [{ kind: 'plugin', id: 'ocr', tool: 'plugin.ocr', version: '1.0.0', description: 'Reads images.', updateAvailable: true }],
      },
      uninstallMarketplaceEntry,
    })} />)

    expect(screen.getByText('pdf-processing')).toBeInTheDocument()
    expect(screen.getByText('local-only')).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /Uninstall/ })[0])
    expect(uninstallMarketplaceEntry).toHaveBeenCalledWith('pdf-processing')
  })

  it('says plainly when nothing is installed yet', () => {
    render(<ArsenalPanel bridge={storeBridge()} />)
    expect(screen.getByText('Nothing installed yet')).toBeInTheDocument()
  })
})

const automationsBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
  projects: [{ id: 'p1', name: 'Launch plan' }],
  projectId: 'p1',
  playbooks: [],
  schedules: [],
  goals: [],
  blueprints: [],
  plan: null,
  loadPlaybooksFor: vi.fn(), loadSchedulesFor: vi.fn(), loadGoalsFor: vi.fn(), loadBlueprintsFor: vi.fn(),
  savePlaybook: vi.fn().mockResolvedValue(null), instantiatePlaybook: vi.fn(), deletePlaybook: vi.fn(),
  saveSchedule: vi.fn().mockResolvedValue(null), toggleSchedule: vi.fn(), deleteSchedule: vi.fn(),
  createGoal: vi.fn().mockResolvedValue(null), deleteGoal: vi.fn(),
  previewBlueprint: vi.fn(), applyBlueprint: vi.fn(),
  ...overrides,
})

describe('automations', () => {
  it('asks for a project before showing anything project-scoped', () => {
    render(<AutomationsPanel bridge={automationsBridge({ projectId: null })} />)
    expect(screen.getByText('Pick a project first')).toBeInTheDocument()
  })

  it('runs and deletes playbooks, pauses schedules, and starts goals', () => {
    const instantiatePlaybook = vi.fn()
    const toggleSchedule = vi.fn()
    const createGoal = vi.fn().mockResolvedValue(null)
    render(<AutomationsPanel bridge={automationsBridge({
      playbooks: [{ id: 'pb1', projectId: 'p1', name: 'Deploy', contentHash: 'abc123def456', budgetUsd: 5, approvedAt: 1, createdAt: 1 }],
      schedules: [{ id: 's1', projectId: 'p1', playbookId: 'pb1', everyMinutes: 360, budgetUsd: null, enabled: true, nextFireAt: Date.now() + 3600000, lastRunId: null, createdAt: 1 }],
      goals: [],
      blueprints: [],
      instantiatePlaybook, toggleSchedule, createGoal,
    })} />)

    // Playbook card, its schedule card, and the schedule form's playbook option.
    expect(screen.getAllByText('Deploy').length).toBe(3)
    fireEvent.click(screen.getAllByRole('button', { name: 'run' })[0])
    expect(instantiatePlaybook).toHaveBeenCalledWith('pb1')

    fireEvent.click(screen.getByRole('button', { name: 'pause' }))
    expect(toggleSchedule).toHaveBeenCalledWith('s1', false)

    fireEvent.change(screen.getByLabelText('Goal name'), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    expect(createGoal).toHaveBeenCalledWith('Ship it', '', '', null)
  })

  it('previews a blueprint diff before applying', async () => {
    const previewBlueprint = vi.fn().mockResolvedValue({ routing: [{ role: 'builder', from: null, to: 'Grok' }], reasoning: [], defaults: [], grants: [] })
    const applyBlueprint = vi.fn().mockResolvedValue(true)
    render(<AutomationsPanel bridge={automationsBridge({
      blueprints: [{ name: 'scout-heavy', version: '1.0.0', description: 'Scout hard.', source: 'builtin' }],
      previewBlueprint, applyBlueprint,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: 'preview' }))
    expect(previewBlueprint).toHaveBeenCalledWith({ name: 'scout-heavy' })
    const change = await screen.findByText(/would change/)
    expect(change).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(applyBlueprint).toHaveBeenCalledWith({ name: 'scout-heavy' })
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
