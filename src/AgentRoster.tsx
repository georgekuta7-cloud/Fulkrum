import { ArrowUpRight, Bot, MoreHorizontal, Settings2 } from 'lucide-react'

export type RosterAgent = {
  id: string
  name: string
  role: string
  description: string
  status: string
  tone: string
  avatar: string
}

/**
 * The crew, and which one a message is addressed to. Status here is derived from
 * the run rather than stored on the agent, so it cannot drift from reality.
 */
export function AgentRoster({
  agents,
  routing,
  selectedAgent,
  onSelectAgent,
  approved,
  isPaused,
  onEditRouting,
}: {
  agents: RosterAgent[]
  routing: Record<string, string>
  selectedAgent: string
  onSelectAgent: (agentId: string) => void
  approved: boolean
  isPaused: boolean
  onEditRouting: () => void
}) {
  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[0]
  const statusFor = (agent: RosterAgent) => (isPaused ? 'Paused' : approved ? (agent.id === 'head' ? 'Overseeing' : 'Working') : agent.status)

  return (
    <>
      <section className="agents-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Active crew</p>
            <h2>Three minds, one outcome</h2>
          </div>
          <button className="text-action" type="button" onClick={onEditRouting}>
            <Settings2 size={16} /> Edit routing
          </button>
        </div>
        <div className="agents-grid">
          {agents.map((agent) => {
            const status = statusFor(agent)
            return (
              <button key={agent.id} className={`agent-card ${agent.tone} ${selectedAgent === agent.id ? 'selected' : ''}`} type="button" onClick={() => onSelectAgent(agent.id)}>
                <div className="agent-card-top">
                  <span className="agent-avatar">{agent.avatar}</span>
                  <span className={`agent-status ${status === 'Ready' ? 'ready' : status === 'Paused' ? 'paused' : ''}`}>
                    <span></span>
                    {status}
                  </span>
                  <MoreHorizontal size={16} />
                </div>
                <div className="agent-card-body">
                  <strong>{agent.name}</strong>
                  <span>{agent.role}</span>
                  <p>{agent.description}</p>
                </div>
                <div className="agent-card-footer">
                  <span className="model-label">
                    <Bot size={14} />
                    {routing[agent.id]}
                  </span>
                  <ArrowUpRight size={15} />
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <div className="focus-strip">
        <span className="focus-icon">
          <Bot size={16} />
        </span>
        <span>
          <strong>{selected.name} selected</strong>
          <small>
            {selected.id === 'head'
              ? 'You are speaking to the Head AI. It sees the full team context.'
              : `${selected.name} is visible to Head AI and can contribute to the shared task room.`}
          </small>
        </span>
        <span className="focus-spacer"></span>
        <span className="focus-model">{routing[selected.id]}</span>
      </div>
    </>
  )
}
