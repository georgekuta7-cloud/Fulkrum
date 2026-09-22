export type CenterView = 'graph' | 'chat' | 'marketplace' | 'arsenal' | 'automations'
export type InspectorTab = 'plan' | 'activity' | 'artifacts' | 'files'
export type RoleName = 'research' | 'builder' | 'architect' | 'editor' | 'debug'
export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'plan' | 'idle'

export const ROLE_INFO: Record<RoleName, { label: string; icon: string; subtitle: string }> = {
  research: { label: 'Scout', icon: 'Search', subtitle: 'Read, search, analyze' },
  builder: { label: 'Forge', icon: 'Hammer', subtitle: 'Write, implement, build' },
  architect: { label: 'Architect', icon: 'Compass', subtitle: 'Design, plan, specify' },
  editor: { label: 'Editor', icon: 'Pen', subtitle: 'Refine, polish, document' },
  debug: { label: 'Debugger', icon: 'Bug', subtitle: 'Fix, trace, verify' },
}

export const ALL_ROLES: RoleName[] = ['research', 'builder', 'architect', 'editor', 'debug']

export function statusTone(status: string): Tone {
  if (status === 'review' || status === 'completed') return 'ok'
  if (status === 'executing' || status === 'planning') return 'busy'
  if (status === 'paused' || status === 'interrupted' || status === 'budget_exceeded') return 'warn'
  if (status === 'failed' || status === 'cancelled') return 'bad'
  return 'idle'
}
