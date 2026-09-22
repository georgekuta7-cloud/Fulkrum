import { Send, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { ProviderSelect } from './ProviderSelect'
import { ReasoningSelect } from './ReasoningSelect'

export function CommandBar({ bridge }: { bridge: Bridge }) {
  const { chat, draftPlan, run } = bridge
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    const message = draft.trim()
    if (!message || sending) return
    setDraft('')
    setSending(true)
    try { await chat(message) } finally { setSending(false) }
  }

  return (
    <footer className="command-bar">
      <Sparkles size={14} className="command-icon" />
      <input
        className="command-input"
        placeholder="Type a direction for the Head AI…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
        aria-label="Direction for Head AI"
      />
      <div className="command-actions">
        {run && <button className="btn btn-ghost btn-sm" onClick={() => void draftPlan()} title="Ask the Head AI to create a plan"><Sparkles size={12} /> Draft plan</button>}
        <ProviderSelect bridge={bridge} role="head" label="" />
        <ReasoningSelect bridge={bridge} role="head" label="" />
        <button className="btn btn-primary btn-sm" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send">
          <Send size={12} /> Send
        </button>
      </div>
    </footer>
  )
}
