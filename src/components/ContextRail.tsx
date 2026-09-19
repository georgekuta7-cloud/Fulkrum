import type { Bridge } from '../hooks/useBridge'
import { money } from '../lib/tones'

/**
 * The rail that appears when the chat takes the center: closing the map must not
 * mean losing the run. Plan state, the files the run touched, and where the money
 * went stay one glance away, at reading width.
 */
export function ContextRail({ bridge }: { bridge: Bridge }) {
  const { plan, tasks, artifacts, byTask, spend } = bridge

  return (
    <aside className="context-rail">
      <div className="context-block">
        <div className="context-head">Plan {plan ? `v${plan.plan.version}` : ''}</div>
        {plan ? plan.tasks.map((planTask, index) => {
          const task = tasks.find((entry) => entry.planTaskId === planTask.id)
          const state = task?.status ?? 'queued'
          return (
            <div className="context-mini" key={planTask.id}>
              <span>{index + 1}. {planTask.title}</span>
              <span className={`context-state ${state === 'completed' ? 'ok' : state === 'failed' ? 'bad' : state === 'running' ? 'busy' : ''}`}>{state}</span>
            </div>
          )
        }) : <p className="muted tiny">No plan yet — ask the Head AI to draft one.</p>}
      </div>

      <div className="context-block">
        <div className="context-head">Files touched</div>
        {artifacts.length ? artifacts.map((artifact) => (
          <div className="context-mini" key={artifact.toolCallId}>
            <span className="mono">{artifact.path}</span>
            <span className="context-stat">
              {artifact.diff ? <><span className="add">+{artifact.diff.added}</span> <span className="del">−{artifact.diff.removed}</span></> : `${artifact.bytes} B`}
            </span>
          </div>
        )) : <p className="muted tiny">Nothing written yet.</p>}
      </div>

      <div className="context-block">
        <div className="context-head">Spend · {money(spend.costUsd, 4)}</div>
        {byTask.length ? byTask.map((entry) => (
          <div className="context-mini" key={entry.taskId ?? 'supervisor'}>
            <span>{entry.title ?? 'supervisor'}{entry.agentId ? <span className="muted"> · {entry.agentId}</span> : null}</span>
            <span className="context-stat">{money(entry.costUsd, 4)}</span>
          </div>
        )) : <p className="muted tiny">No calls yet.</p>}
      </div>
    </aside>
  )
}
