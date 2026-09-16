import { Activity, Bot, Eye, Radio, Sparkles } from 'lucide-react'
import { ArtifactsPanel, type Artifact, type Grant } from './ArtifactsPanel'

type FeedItem = {
  id: string
  kind: string
  title: string
  detail: string
  stamp: string
  tag: string
}

const speakerFor = (kind: string) => (kind === 'head' ? 'Head AI' : kind === 'research' ? 'Scout' : kind === 'builder' ? 'Forge' : 'You')
const iconFor = (kind: string) => (kind === 'head' ? Sparkles : kind === 'research' ? Eye : kind === 'builder' ? Bot : Radio)

/**
 * The left panel: what the team is doing, or what it changed. Both views are the
 * same tab strip so the switch does not move anything else on the page.
 */
export function ActivityFeed({
  activity,
  artifacts,
  grants,
  panelTab,
  onSelectTab,
  onRevokeGrant,
}: {
  activity: FeedItem[]
  artifacts: Artifact[]
  grants: Grant[]
  panelTab: 'feed' | 'artifacts'
  onSelectTab: (tab: 'feed' | 'artifacts') => void
  onRevokeGrant: (toolName: string) => void
}) {
  return (
    <section className="panel activity-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Live coordination</p>
          <div className="panel-tabs">
            <button type="button" className={panelTab === 'feed' ? 'active' : ''} onClick={() => onSelectTab('feed')}>
              Team feed
            </button>
            <button type="button" className={panelTab === 'artifacts' ? 'active' : ''} onClick={() => onSelectTab('artifacts')}>
              Artifacts{artifacts.length ? ` (${artifacts.length})` : ''}
            </button>
          </div>
        </div>
        <span className="event-counter">
          <Radio size={13} />
          {activity.length} events
        </span>
      </header>

      {panelTab === 'artifacts' ? (
        <ArtifactsPanel artifacts={artifacts} grants={grants} onRevoke={onRevokeGrant} isLoading={false} />
      ) : (
        <div className="activity-list">
          {activity.length === 0 ? <p className="empty-note">Nothing has happened yet. Send a direction to the Head AI, then approve the plan to let Scout and Forge work.</p> : null}
          {activity.map((item) => {
            const Icon = iconFor(item.kind)
            return (
              <article className={`activity-item ${item.kind}`} key={item.id}>
                <div className="activity-icon">
                  <Icon size={16} />
                </div>
                <div className="activity-body">
                  <div className="activity-title">
                    <strong>{item.title}</strong>
                    <span className="activity-tag">{item.tag}</span>
                  </div>
                  <p>{item.detail}</p>
                  <div className="activity-footer">
                    <span>{speakerFor(item.kind)}</span>
                    <span>{item.stamp}</span>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <footer className="activity-note">
        <Activity size={14} />
        <span>Everything the agents do appears here before it becomes part of the final result.</span>
      </footer>
    </section>
  )
}
