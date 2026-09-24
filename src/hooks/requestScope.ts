/** A selection owns its requests, including when A → B → A reuses the same id. */
export function createRequestScope() {
  let id: string | null = null
  let controller = new AbortController()
  return {
    get id() { return id },
    select(next: string | null) {
      controller.abort()
      controller = new AbortController()
      id = next
    },
    capture(expected: string | null = id) {
      const selected = controller
      return {
        signal: selected.signal,
        isCurrent: () => !selected.signal.aborted && selected === controller && expected === id,
      }
    },
  }
}
