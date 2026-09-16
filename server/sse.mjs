/**
 * Server-sent events, both directions.
 *
 * `createSseParser` turns a byte stream into frames as they arrive — a frame can
 * be split across chunks, and a chunk can hold several — which is what the three
 * provider protocols stream in. `formatSseFrame` writes the shape the browser's
 * EventSource expects, including the `id:` line it sends back as `Last-Event-ID`
 * on a reconnect.
 */

/** @param {string} text */
const normalizeNewlines = (text) => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

export function createSseParser() {
  let buffer = ''
  return {
    /**
     * Feed a chunk and get back every complete frame it finished.
     * @param {string} chunk
     * @returns {Array<{ event: string, data: string, id: string | null }>}
     */
    push(chunk) {
      buffer += normalizeNewlines(String(chunk ?? ''))
      const frames = []
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const raw = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const frame = { event: 'message', data: '', id: null }
        for (const line of raw.split('\n')) {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') frame.event = value
          else if (field === 'data') frame.data += (frame.data ? '\n' : '') + value
          else if (field === 'id') frame.id = value
        }
        frames.push(frame)
        separator = buffer.indexOf('\n\n')
      }
      return frames
    },
    /** Anything left that never got its blank line, for a stream that ended early. */
    flush() {
      const rest = buffer
      buffer = ''
      return rest
    },
  }
}

/** @param {{ event?: string, data?: string, id?: string | number | null, comment?: string }} frame */
export function formatSseFrame({ event, data, id = null, comment = null }) {
  const lines = []
  if (comment) lines.push(`: ${comment}`)
  if (id !== null && id !== undefined) lines.push(`id: ${id}`)
  if (event) lines.push(`event: ${event}`)
  if (data !== undefined && data !== null) {
    for (const line of String(data).split('\n')) lines.push(`data: ${line}`)
  }
  return `${lines.join('\n')}\n\n`
}
