import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import { ChatFeed } from './ChatFeed'
import { ReasoningSelect } from './ReasoningSelect'
import { ProviderSelect } from './ProviderSelect'

/**
 * The conversation with the Head AI.
 *
 * It is the supervisor, so this panel is where a direction is given and a plan is
 * asked for. A reply in flight streams into the placeholder below the transcript
 * rather than into the transcript itself: the record is the recorded message, and
 * text that has not landed yet is not part of it.
 */

export function ChatPanel({ bridge, centered = false }: { bridge: Bridge; centered?: boolean }) {
  const { messages, streaming, chat, providers, draftPlan, run } = bridge
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, streaming?.text, bridge.events.length])

  const ready = providers.some((provider) => provider.configured)

  const send = async () => {
    const message = draft.trim()
    if (!message || sending) return
    setDraft('')
    setSending(true)
    try {
      await chat(message)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={`chat-panel ${centered ? 'centered' : ''}`}>
      <div className="panel-bar">
        <Sparkles size={13} />
        <strong>Head AI</strong>
        <ProviderSelect bridge={bridge} role="head" label="using" />
        <ReasoningSelect bridge={bridge} role="head" label="thinks" />
        <span className="muted tiny">{ready ? 'live' : 'no provider key — add one in settings'}</span>
      </div>

      <div className="chat-transcript">
        <ChatFeed bridge={bridge} />
        <div ref={endRef} />
      </div>

      <div className="chat-input">
        <textarea
          rows={2}
          value={draft}
          placeholder="Direct the Head AI…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="chat-actions">
          <button type="button" className="primary" onClick={() => void send()} disabled={!draft.trim() || sending}>
            <Send size={13} /> Send <kbd>ctrl+↵</kbd>
          </button>
          {run ? (
            <button type="button" onClick={() => void draftPlan()} title="Ask the Head AI to turn the direction so far into a plan">
              Draft plan
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
