import { describe, expect, it } from 'vitest'
import { attentionNotification, newAttentionItems } from './attentionNotify'

describe('attention notifications', () => {
  it('notifies once per new item and never repeats', () => {
    const seen = new Set<string>()
    const first = newAttentionItems([{ id: 'a', kind: 'approval', runId: 'r1', title: 'Approve write' }, { id: 'b', kind: 'budget', runId: 'r2', title: 'Budget stop' }], seen)
    expect(first.map((item) => item.id)).toEqual(['a', 'b'])
    for (const item of first) seen.add(item.id)
    expect(newAttentionItems([{ id: 'a', kind: 'approval', runId: 'r1', title: 'Approve write' }], seen)).toEqual([])
    expect(newAttentionItems([{ id: 'c', kind: 'review', runId: 'r3', title: 'Review' }], seen).map((item) => item.id)).toEqual(['c'])
  })

  it('keeps the notification generic — no titles or project names', () => {
    const note = attentionNotification({ id: 'a', kind: 'approval', runId: 'r1', title: 'Approve secret-project write' })
    expect(note.title).toBe('Fulkrum: something is waiting on you')
    expect(note.body).toBe('approval — open the app to decide.')
    expect(note.body).not.toContain('secret-project')
  })
})
