import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button, Chip, EmptyState, Panel } from './primitives'
import { Nav } from './Nav'
import { Header } from './Header'
import { ChatView } from './ChatView'
import { ControlView } from './ControlView'
import { FilesView } from './FilesView'
import { StoreView } from './StoreView'
import { AutomationsView } from './AutomationsView'
import { SettingsView } from './SettingsView'
import type { Bridge } from '../hooks/useBridge'

/**
 * Every component under test ships: this file imports only what App renders.
 * A test states the parts it reads; everything else stays undefined, which is
 * also a check that a component does not reach for something it was not given.
 */
function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    projects: [{ id: 'p1', name: 'Launch plan' }],
    projectId: 'p1',
    runs: [],
    runId: 'run-1',
    run: { id: 'run-1', status: 'executing', budgetUsd: 10 },
    tasks: [],
    messages: [],
    toolCalls: [],
    events: [],
    plan: null,
    artifacts: [],
    claims: [],
    spend: { costUsd: 0.04, calls: 2, unpricedCalls: 0 },
    byTask: [],
    estimate: null,
    audit: null,
    providers: [{ id: 'grok', label: 'Grok', model: 'grok-4', configured: true }],
    status: null,
    grants: [],
    learnings: [],
    playbooks: [],
    schedules: [],
    goals: [],
    blueprints: [],
    marketplace: { enabled: true, signed: false, entries: [], fetchedAt: null, stale: false },
    arsenal: { skills: [], plugins: [] },
    registry: null,
    timeline: null,
    configReport: null,
    usage: null,
    error: null,
    notice: null,
    streaming: null,
    approval: null,
    booted: true,
    appSettings: [],
    projectSettings: {},
    setError: vi.fn(),
    setNotice: vi.fn(),
    setApproval: vi.fn(),
    openProject: vi.fn(),
    openRun: vi.fn(),
    createProject: vi.fn(),
    createRun: vi.fn().mockResolvedValue('run-2'),
    chat: vi.fn().mockResolvedValue(null),
    draftPlan: vi.fn(),
    control: vi.fn(),
    approveCall: vi.fn(),
    denyCall: vi.fn(),
    answerCall: vi.fn(),
    approveWithKeyboard: vi.fn(),
    tree: vi.fn().mockResolvedValue({ entries: [] }),
    fileHistory: vi.fn().mockResolvedValue({ calls: [] }),
    ...overrides,
  } as unknown as Bridge
}

describe('primitives', () => {
  it('renders buttons, chips, panels, and empty states with names assistive tech can use', () => {
    render(
      <Panel title="Section" action={<button type="button">go</button>}>
        <Button variant="primary">Save</Button>
        <Chip tone="ok">live</Chip>
        <EmptyState icon="hub" title="Nothing here" body="Why it is empty." />
      </Panel>,
    )
    expect(screen.getByText('Section')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
  })
})

describe('nav', () => {
  it('names six real destinations and marks the approval waiting on chat', () => {
    const onViewChange = vi.fn()
    render(<Nav view="chat" onViewChange={onViewChange} approvalWaiting />)
    for (const name of ['Chat', 'Control Room', 'Files', 'Store', 'Automations', 'Settings']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Store' }))
    expect(onViewChange).toHaveBeenCalledWith('store')
  })
})

describe('header', () => {
  it('shows spend without inventing a ceiling, and warns when no provider is keyed', () => {
    render(<Header bridge={makeBridge()} theme="dark" onToggleTheme={vi.fn()} onOpenSettings={vi.fn()} />)
    expect(screen.getByText('$0.04')).toBeInTheDocument()
    expect(screen.queryByText(/\/ \$2\.00/)).not.toBeInTheDocument()
  })

  it('offers settings when nothing can answer, and toggles the theme by name', () => {
    const onOpenSettings = vi.fn()
    const onToggleTheme = vi.fn()
    render(<Header bridge={makeBridge({ providers: [] })} theme="dark" onToggleTheme={onToggleTheme} onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /no provider key/ }))
    expect(onOpenSettings).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(onToggleTheme).toHaveBeenCalled()
  })

  it('switches projects from the menu', () => {
    const openProject = vi.fn()
    render(<Header bridge={makeBridge({ projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], openProject } as any)} theme="dark" onToggleTheme={vi.fn()} onOpenSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /one/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Two' }))
    expect(openProject).toHaveBeenCalledWith('p2')
  })
})

describe('chat', () => {
  const chatBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    messages: [
      { id: 1, role: 'user', agentId: null, content: 'Ship it.', createdAt: 1, metadata: null },
      { id: 2, role: 'assistant', agentId: 'head', content: 'On it.', createdAt: 2, metadata: null },
    ],
    ...overrides,
  })

  it('narrates messages, approves a plan, and sends a direction', async () => {
    const chat = vi.fn().mockResolvedValue(null)
    const control = vi.fn()
    render(<ChatView bridge={chatBridge({
      run: { id: 'run-1', status: 'planning', budgetUsd: 10 } as any,
      plan: { plan: { id: 'plan-1', version: 2, objective: 'Ship it.', contentHash: 'hash123', status: 'draft' }, tasks: [{ id: 'pt1', title: 'Look', instructions: 'x', dependsOn: [] }] } as any,
      chat, control,
    })} />)
    expect(screen.getByText('Ship it.')).toBeInTheDocument()
    expect(screen.getByText('On it.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Run' }))
    expect(control).toHaveBeenCalledWith('approve-plan', { planId: 'plan-1', planHash: 'hash123' })
    fireEvent.change(screen.getByLabelText('Direct the Head AI'), { target: { value: 'go faster' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send (Ctrl+Enter)' }))
    expect(chat).toHaveBeenCalledWith('go faster')
  })

  it('decides parked calls with buttons and keys, and answers questions', async () => {
    const approveCall = vi.fn()
    const denyCall = vi.fn()
    const answerCall = vi.fn()
    const call = { id: 'c1', runId: 'run-1', agentId: 'builder', name: 'shell.exec', kind: 'exec', status: 'approval_required', input: {}, resolved: { argv: ['npm', 'test'] }, fingerprint: null, ruleId: null, warnings: [], approvalScope: null, error: null, createdAt: 1 }
    const { rerender } = render(<ChatView bridge={chatBridge({ approval: { toolCall: call, rule: 'ask.default', warnings: [], preview: null } as any, approveCall, denyCall })} />)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(approveCall).toHaveBeenCalledWith('once')
    fireEvent.keyDown(window, { key: 'r' })
    expect(approveCall).toHaveBeenCalledWith('run')

    rerender(<ChatView bridge={chatBridge({
      approval: { toolCall: { ...call, kind: 'ask', name: 'run.ask', resolved: { question: 'JWT or sessions?' } }, rule: null, warnings: [], preview: null } as any,
      answerCall, denyCall,
    })} />)
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'JWT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(answerCall).toHaveBeenCalledWith('JWT')
  })

  it('shows proof with the proven fraction, and a failed run with a way out', () => {
    const createRun = vi.fn().mockResolvedValue('run-9')
    render(<ChatView bridge={chatBridge({
      run: { id: 'run-1', status: 'failed', budgetUsd: null } as any,
      claims: [
        { id: 'c1', runId: 'run-1', taskId: 't1', kind: 'test', summary: 'npm test (exit 0)', path: null, startLine: null, sha256: null, evidenceId: 'e1', verdict: 'PASS', createdAt: 1 },
        { id: 'c2', runId: 'run-1', taskId: 't1', kind: 'finding', summary: 'A guess.', path: null, startLine: null, sha256: null, evidenceId: null, verdict: null, createdAt: 2 },
      ] as any,
      createRun,
    })} />)
    expect(screen.getByText('This run is failed')).toBeInTheDocument()
    expect(screen.getByText('npm test (exit 0)')).toBeInTheDocument()
    expect(screen.getByText('1/2 proven')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start a new run' }))
    expect(createRun).toHaveBeenCalled()
  })

  it('says plainly when no provider can answer', () => {
    render(<ChatView bridge={chatBridge({ providers: [] })} />)
    expect(screen.getByText(/No provider has a key/)).toBeInTheDocument()
  })
})

describe('control room', () => {
  const roomBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    plan: {
      plan: { id: 'plan-1', version: 1, objective: 'Ship it.', contentHash: 'h', status: 'approved' },
      tasks: [
        { id: 'pt1', orderIndex: 0, role: 'research', title: 'Look', instructions: 'x', dependsOn: [] },
        { id: 'pt2', orderIndex: 1, role: 'builder', title: 'Write', instructions: 'y', dependsOn: [0] },
      ],
    } as any,
    tasks: [
      { id: 't1', agentId: 'research', title: 'Look', status: 'completed', planTaskId: 'pt1' } as any,
      { id: 't2', agentId: 'builder', title: 'Write', status: 'running', planTaskId: 'pt2', stepCount: 3 } as any,
    ],
    toolCalls: [] as any,
    byTask: [{ taskId: 't1', title: 'Look', agentId: 'research', costUsd: 0.04, calls: 2, unpricedCalls: 0 }],
    claims: [{ id: 'c1', runId: 'run-1', taskId: 't1', kind: 'finding', summary: 'Done.', path: null, startLine: null, sha256: null, evidenceId: 'e1', verdict: 'PASS', createdAt: 1 }] as any,
    projectSettings: { routing: { research: 'Grok' } },
    ...overrides,
  })

  it('maps the dispatch, names the live worker, and counts proof', () => {
    render(<ControlView bridge={roomBridge()} onOpenChat={vi.fn()} />)
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Head AI')).toBeInTheDocument()
    expect(screen.getAllByText('Forge').length).toBeGreaterThanOrEqual(1)
    // The Scout node's cast line resolves the route through the provider list.
    expect(screen.getByText('Grok · grok-4')).toBeInTheDocument()
    expect(screen.getByText('1/1')).toBeInTheDocument()
  })

  it('banners a waiting decision toward the chat, and handles no run', () => {
    const onOpenChat = vi.fn()
    render(<ControlView bridge={roomBridge({
      approval: { toolCall: { id: 'c1', name: 'shell.exec', status: 'approval_required' }, rule: null, warnings: [], preview: null } as any,
    })} onOpenChat={onOpenChat} />)
    fireEvent.click(screen.getByRole('button', { name: /open chat/ }))
    expect(onOpenChat).toHaveBeenCalled()

    render(<ControlView bridge={roomBridge({ run: null, runId: null })} onOpenChat={vi.fn()} />)
    expect(screen.getByText('No run open')).toBeInTheDocument()
  })
})

describe('files', () => {
  it('lists artifacts with diffs, reverts, and an empty state', async () => {
    const revertArtifact = vi.fn().mockResolvedValue(null)
    render(<FilesView bridge={makeBridge({
      artifacts: [{ toolCallId: 'c2', agentId: 'research', path: 'proof.txt', bytes: 12, created: true, diff: { added: 3, removed: 0, hunks: [{ entries: [{ type: 'add', line: 'next()' }] }] } }] as any,
      revertArtifact,
    })} />)
    expect(screen.getByText('proof.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByText('proof.txt'))
    expect(screen.getByText('+3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /revert/i }))
    expect(revertArtifact).toHaveBeenCalledWith('c2')
  })

  it('scrubs file history through the timeline', async () => {
    render(<FilesView bridge={makeBridge({
      events: [{ sequence: 1 }, { sequence: 2 }] as any,
      timeline: { seq: 2, files: [{ path: 'notes.txt', content: 'hi', truncated: false, unknown: null }], gaps: [] },
      loadTimeline: vi.fn(), clearTimeline: vi.fn(), restoreTimelineFile: vi.fn(),
    })} />)
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('event 2/2')).toBeInTheDocument()
  })

  it('says plainly when nothing was written and when no run is open', () => {
    render(<FilesView bridge={makeBridge()} />)
    expect(screen.getByText(/has not written any files/)).toBeInTheDocument()
    render(<FilesView bridge={makeBridge({ run: null, runId: null })} />)
    expect(screen.getByText('No run open')).toBeInTheDocument()
  })
})

describe('store', () => {
  const storeBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    marketplace: {
      enabled: true, signed: false, fetchedAt: null, stale: false,
      entries: [
        { kind: 'skill', id: 'pdf-processing', version: '2.1.0', sha256: 'a'.repeat(64), url: null, description: 'Reads PDFs.', trust: 'community', author: 'example-org', findings: [{ severity: 'medium', signal: 'reaches the network' }] },
        { kind: 'skill', id: 'tdd-autopilot', version: '1.0.0', sha256: 'b'.repeat(64), url: 'https://index.example/tdd.md', description: 'Red-green-refactor.', trust: 'verified' },
      ],
    } as any,
    installMarketplaceEntry: vi.fn(),
    uninstallMarketplaceEntry: vi.fn(),
    refreshMarketplace: vi.fn(),
    importMarketplaceSkill: vi.fn(),
    browseRegistry: vi.fn(),
    clearRegistry: vi.fn(),
    loadMarketplaceState: vi.fn(),
    loadArsenalState: vi.fn(),
    ...overrides,
  })

  it('shows trust side by side, flags scans, and installs', async () => {
    const installMarketplaceEntry = vi.fn()
    render(<StoreView bridge={storeBridge({ installMarketplaceEntry })} />)
    expect(screen.getByText('pdf-processing')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
    expect(screen.getByText('Community')).toBeInTheDocument()
    expect(screen.getByText(/reaches the network/)).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /install/i })[0])
    expect(installMarketplaceEntry).toHaveBeenCalledWith('pdf-processing')
  })

  it('filters by trust, stages imports, and lists the arsenal', async () => {
    const importMarketplaceSkill = vi.fn()
    const uninstallMarketplaceEntry = vi.fn()
    render(<StoreView bridge={storeBridge({
      importMarketplaceSkill, uninstallMarketplaceEntry,
      arsenal: {
        skills: [{ kind: 'skill', id: 'pdf-processing', version: null, description: 'Hand-placed.', updateAvailable: false }],
        plugins: [{ kind: 'plugin', id: 'ocr', tool: 'plugin.ocr', version: '1.0.0', description: 'Reads images.', updateAvailable: true }],
      } as any,
    })} />)
    fireEvent.click(screen.getByRole('tab', { name: 'verified' }))
    // The marketplace card filters out; the arsenal row stays — same id, two homes.
    expect(screen.getAllByText('pdf-processing').length).toBe(1)
    expect(screen.queryByText('Reads PDFs.')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Skill URL'), { target: { value: 'https://example.com/skill.md' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }))
    expect(importMarketplaceSkill).toHaveBeenCalledWith({ url: 'https://example.com/skill.md' })
    expect(screen.getByText('local-only')).toBeInTheDocument()
    expect(screen.getByText('update')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(uninstallMarketplaceEntry).toHaveBeenCalledWith('pdf-processing')
  })
})

describe('automations', () => {
  const autoBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    playbooks: [{ id: 'pb1', projectId: 'p1', name: 'Deploy', contentHash: 'abc123def456', budgetUsd: 5, approvedAt: 1, createdAt: 1 }],
    schedules: [{ id: 's1', projectId: 'p1', playbookId: 'pb1', everyMinutes: 360, budgetUsd: null, enabled: true, nextFireAt: Date.now() + 3600000, lastRunId: null, createdAt: 1 }],
    goals: [],
    blueprints: [{ name: 'scout-heavy', version: '1.0.0', description: 'Scout hard.', source: 'builtin' }],
    plan: null,
    loadPlaybooksFor: vi.fn(), loadSchedulesFor: vi.fn(), loadGoalsFor: vi.fn(), loadBlueprintsFor: vi.fn(),
    savePlaybook: vi.fn(), instantiatePlaybook: vi.fn(), deletePlaybook: vi.fn(),
    saveSchedule: vi.fn().mockResolvedValue(null), toggleSchedule: vi.fn(), deleteSchedule: vi.fn(),
    createGoal: vi.fn().mockResolvedValue(null), deleteGoal: vi.fn(),
    previewBlueprint: vi.fn().mockResolvedValue({ routing: [{ role: 'builder', from: null, to: 'Grok' }], reasoning: [], defaults: [], grants: [] }),
    applyBlueprint: vi.fn().mockResolvedValue(true),
    ...overrides,
  })

  it('asks for a project first', () => {
    render(<AutomationsView bridge={autoBridge({ projectId: null })} />)
    expect(screen.getByText('Pick a project first')).toBeInTheDocument()
  })

  it('runs playbooks, pauses schedules, starts goals, and previews blueprints', async () => {
    const instantiatePlaybook = vi.fn()
    const toggleSchedule = vi.fn()
    const createGoal = vi.fn().mockResolvedValue(null)
    const previewBlueprint = vi.fn().mockResolvedValue({ routing: [], reasoning: [], defaults: [], grants: [] })
    const applyBlueprint = vi.fn().mockResolvedValue(true)
    render(<AutomationsView bridge={autoBridge({ instantiatePlaybook, toggleSchedule, createGoal, previewBlueprint, applyBlueprint })} />)
    // Playbook card, its schedule card, and the schedule form option.
    expect(screen.getAllByText('Deploy').length).toBe(3)
    fireEvent.click(screen.getAllByRole('button', { name: 'run' })[0])
    expect(instantiatePlaybook).toHaveBeenCalledWith('pb1')
    fireEvent.click(screen.getByRole('button', { name: 'pause' }))
    expect(toggleSchedule).toHaveBeenCalledWith('s1', false)
    fireEvent.change(screen.getByLabelText('Goal name'), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    expect(createGoal).toHaveBeenCalledWith('Ship it', '', '', null)
    fireEvent.click(screen.getByRole('button', { name: 'preview' }))
    expect(previewBlueprint).toHaveBeenCalledWith({ name: 'scout-heavy' })
    const apply = await screen.findByRole('button', { name: 'Apply' })
    fireEvent.click(apply)
    expect(applyBlueprint).toHaveBeenCalledWith({ name: 'scout-heavy' })
  })
})

describe('settings', () => {
  const settingsBridge = (overrides: Partial<Bridge> = {}) => makeBridge({
    status: {
      schemaVersion: 22,
      storage: { databaseBytes: 1024, walBytes: 0, totalBytes: 1024 },
      backups: { count: 1, newestAgeMs: 60000, newestPath: null },
      anchor: { file: 'audit-heads.log', count: 7 },
      lastVerify: { ok: true, summary: 'intact', createdAt: 1 },
      lastBackup: null,
      maintenance: [],
      execution: { available: false, reason: 'No engine', hint: 'Install Docker.' },
      providers: [],
      retention: { toolOutputDays: 7, source: null },
    } as any,
    appSettings: [
      { name: 'FULKRUM_RUN_BUDGET_USD', group: 'budgets', kind: 'money', description: 'Per-run ceiling.', choices: null, default: 0, value: 5, source: 'db', restartRequired: false, problem: null },
      { name: 'FULKRUM_DAILY_BUDGET_USD', group: 'budgets', kind: 'money', description: 'Daily ceiling.', choices: null, default: 0, value: 0, source: 'db', restartRequired: false, problem: null },
    ] as any,
    usage: { since: 0, days: 30, totals: { costUsd: 0.04, calls: 2, unpricedCalls: 0 }, byDay: [], byModel: [], byProvider: [{ key: 'grok', costUsd: 0.04, calls: 2, unpricedCalls: 0 }], byRole: [] } as any,
    learnings: [{ id: 'l1', projectId: 'p1', fact: 'Always pin.', sourceRunId: null, createdAt: 1 }] as any,
    blueprints: [],
    loadProviders: vi.fn(), loadStatus: vi.fn(), loadSettings: vi.fn(), loadUsage: vi.fn(), loadLearnings: vi.fn(), loadGrants: vi.fn(),
    testProvider: vi.fn(), saveProvider: vi.fn(), addProvider: vi.fn(), removeProvider: vi.fn(),
    saveRouting: vi.fn(), saveSetting: vi.fn(), deleteLearning: vi.fn(), verifyAudit: vi.fn(), backupNow: vi.fn(),
    ...overrides,
  })

  it('shows providers, probes them, and registers new ones', async () => {
    const testProvider = vi.fn().mockResolvedValue({ result: { reachable: true, latencyMs: 42, models: ['a', 'b'] } })
    const addProvider = vi.fn()
    render(<SettingsView bridge={settingsBridge({ testProvider, addProvider })} />)
    expect(screen.getByText('Grok')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test Endpoint' }))
    expect(await screen.findByText(/ok · 42ms/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Local' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://127.0.0.1:11434/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(addProvider).toHaveBeenCalledWith(expect.objectContaining({ label: 'Local' }))
  })

  it('casts roles, writes budgets, forgets learnings, and verifies the chain', async () => {
    const saveRouting = vi.fn()
    const saveSetting = vi.fn()
    const deleteLearning = vi.fn()
    const verifyAudit = vi.fn()
    render(<SettingsView bridge={settingsBridge({ saveRouting, saveSetting, deleteLearning, verifyAudit })} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Casting' }))
    fireEvent.change(screen.getByLabelText('Casting for Scout'), { target: { value: 'Grok' } })
    expect(saveRouting).toHaveBeenCalledWith('research', 'Grok')
    fireEvent.click(screen.getByRole('tab', { name: 'Budgets' }))
    const [runBudget] = screen.getAllByLabelText('Per-run ceiling')
    fireEvent.change(runBudget, { target: { value: '7' } })
    fireEvent.blur(runBudget)
    expect(saveSetting).toHaveBeenCalledWith('FULKRUM_RUN_BUDGET_USD', 7)
    fireEvent.click(screen.getByRole('tab', { name: 'Learnings' }))
    fireEvent.click(screen.getByRole('button', { name: 'forget' }))
    expect(deleteLearning).toHaveBeenCalledWith('l1')
    fireEvent.click(screen.getByRole('button', { name: 'Verify chain' }))
    expect(verifyAudit).toHaveBeenCalled()
  })
})
