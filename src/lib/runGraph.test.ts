import { describe, expect, it } from 'vitest'
import { buildGraph, taskLayers } from './runGraph'
import type { Plan, Run, Task, ToolCall } from '../api/types'

const run = (status: string): Run => ({
  id: 'run-1',
  projectId: 'project-1',
  status,
  mode: 'plan',
  permissionMode: 'selective',
  planVersion: 1,
  budgetUsd: null,
  createdAt: 0,
  updatedAt: 0,
})

const plan = (status = 'approved'): Plan => ({
  plan: { id: 'plan-1', version: 2, objective: 'Ship a narrow proof.', contentHash: 'abc', status, source: 'model' },
  tasks: [
    { id: 'pt-1', orderIndex: 0, role: 'research', title: 'Look around', instructions: 'Report.', dependsOn: [] },
    { id: 'pt-2', orderIndex: 1, role: 'builder', title: 'Write the proof', instructions: 'Write proof.txt.', dependsOn: [0] },
  ],
})

const tasks: Task[] = [
  { id: 'task-1', agentId: 'research', title: 'Look around', status: 'completed', planTaskId: 'pt-1' },
  { id: 'task-2', agentId: 'builder', title: 'Write the proof', status: 'running', planTaskId: 'pt-2', stepCount: 2 },
]

const noCalls: ToolCall[] = []

describe('taskLayers', () => {
  it('orders tasks by dependency depth', () => {
    expect(taskLayers([{ dependsOn: [] }, { dependsOn: [0] }, { dependsOn: [1] }, { dependsOn: [0] }])).toEqual([0, 1, 2, 1])
    expect(taskLayers([])).toEqual([])
  })
})

describe('buildGraph', () => {
  it('is empty without a run', () => {
    expect(buildGraph({ run: null, plan: null, tasks: [], toolCalls: [], byTask: [] })).toEqual({ nodes: [], edges: [] })
  })

  it('lays out you, the head, and one node per plan task', () => {
    const { nodes, edges } = buildGraph({ run: run('executing'), plan: plan(), tasks, toolCalls: noCalls, byTask: [] })
    expect(nodes.map((node) => node.id)).toEqual(['you', 'head', 'task-1', 'task-2'])
    expect(nodes.find((node) => node.id === 'task-1')?.state).toBe('done')
    expect(nodes.find((node) => node.id === 'task-2')?.state).toBe('working')
    // The dependency becomes a handoff edge between the two task nodes.
    expect(edges.some((edge) => edge.from === 'task-1' && edge.to === 'task-2' && edge.label === 'handoff')).toBe(true)
    // And every task reports back to the head for verification.
    expect(edges.filter((edge) => edge.to === 'head' && edge.label === 'verify').length).toBe(2)
  })

  it('marks the task whose tool call is parked as waiting, and its verify edge as waiting too', () => {
    const parked: ToolCall[] = [{
      id: 'call-1', runId: 'run-1', agentId: 'builder', name: 'workspace.write', kind: 'write', status: 'approval_required',
      input: { path: 'proof.txt' }, resolved: null, fingerprint: null, ruleId: null, warnings: [], approvalScope: null, error: null, createdAt: 0,
    }]
    const { nodes, edges } = buildGraph({ run: run('executing'), plan: plan(), tasks, toolCalls: parked, byTask: [] })
    expect(nodes.find((node) => node.id === 'task-2')?.state).toBe('waiting')
    expect(edges.find((edge) => edge.from === 'task-2' && edge.to === 'head')?.tone).toBe('wait')
  })

  it('puts dependent tasks in deeper layers and spreads siblings', () => {
    const { nodes } = buildGraph({ run: run('executing'), plan: plan(), tasks, toolCalls: noCalls, byTask: [] })
    const scout = nodes.find((node) => node.id === 'task-1')
    const forge = nodes.find((node) => node.id === 'task-2')
    expect(scout && forge && scout.y < forge.y).toBe(true)
    // Two tasks in different layers share the center line.
    expect(scout?.x).toBe(50)
    expect(forge?.x).toBe(50)
  })

  it('carries per-task cost onto the node', () => {
    const { nodes } = buildGraph({
      run: run('executing'),
      plan: plan(),
      tasks,
      toolCalls: noCalls,
      byTask: [{ taskId: 'task-1', agentId: 'research', costUsd: 0.01 }],
    })
    expect(nodes.find((node) => node.id === 'task-1')?.costUsd).toBe(0.01)
  })
})
