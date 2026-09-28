export type AttentionNotice = { id: string; kind: string; runId: string; title: string }

/**
 * One notification per new item (P3.2), never a repeat: the seen set is the
 * caller's, so a reload does not re-notify what the person already saw.
 */
export function newAttentionItems(items: AttentionNotice[], seen: Set<string>): AttentionNotice[] {
  return items.filter((item) => !seen.has(item.id))
}

/**
 * Generic text is deliberate: a project name or task title in a system
 * notification leaks more than the person asked for.
 */
export function attentionNotification(item: AttentionNotice): { title: string; body: string } {
  return { title: 'Fulkrum: something is waiting on you', body: `${item.kind} — open the app to decide.` }
}
