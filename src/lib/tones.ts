/**
 * One status → tone mapping for the whole interface. It used to live in two
 * components with two different answers for the same status, so a run could be
 * amber in one panel and red in another.
 */
export const statusTone = (status: string): 'ok' | 'busy' | 'warn' | 'bad' | 'idle' => {
  if (status === 'review' || status === 'completed') return 'ok'
  if (status === 'executing' || status === 'planning') return 'busy'
  // budget_exceeded is a stop, not a failure: the run resumes once the ceiling moves.
  if (status === 'paused' || status === 'interrupted' || status === 'budget_exceeded') return 'warn'
  if (status === 'failed' || status === 'cancelled') return 'bad'
  return 'idle'
}

export const money = (value: number, digits = 4) => `$${value.toFixed(digits)}`
