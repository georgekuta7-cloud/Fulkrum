import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'

export function ChatView({ bridge }: { bridge: Bridge }) {
  const [dagOpen, setDagOpen] = useState(false)
  const [telemOpen, setTelemOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<'diffs' | 'logs' | 'security'>('diffs')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [denyReason, setDenyReason] = useState('')
  const [showDeny, setShowDeny] = useState(false)
  const [answer, setAnswer] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  const { messages, plan, approval, tasks, toolCalls, artifacts, spend, byTask, run, streaming, providers, projectSettings } = bridge

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length, streaming?.text])

  // Keyboard: a=approve, d=deny, r=approve for run
  useEffect(() => {
    if (!approval) return
    const isQuestion = approval.toolCall.kind === 'ask' || approval.toolCall.name === 'run.ask'
    if (isQuestion) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'a') void bridge.approveCall('once')
      else if (event.key === 'd') { setShowDeny(true); event.preventDefault() }
      else if (event.key === 'r') void bridge.approveCall('run')
      else if (event.key === 'Escape') setShowDeny(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, bridge])

  const send = async () => {
    const message = prompt.trim()
    if (!message || sending) return
    setPrompt('')
    setSending(true)
    try { await bridge.chat(message) } finally { setSending(false) }
  }

  const doneCount = tasks?.filter((t: any) => t.status === 'completed').length ?? 0
  const pct = tasks?.length ? Math.round((doneCount / tasks.length) * 100) : 0
  const isQuestion = approval?.toolCall.kind === 'ask' || approval?.toolCall.name === 'run.ask'

  return (
    <div className="m3-chat-wrap">
      <div className="m3-ambient" />

      {/* Pipeline Tracker */}
      <header className="m3-pipeline-header">
        <div className="m3-pipeline-bar">
          <div className="m3-pipeline-pills">
            <div className="m3-pipe-node">
              <span className="m3-pipe-check"><span className="material-symbols-outlined">check</span></span>
              <span className="m3-pipe-label">Head AI</span>
            </div>
            <div className="m3-pipe-link">
              <svg viewBox="0 0 32 4" fill="none"><line x1="0" y1="2" x2="32" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="2 3" style={{ color: 'var(--primary)' }} /></svg>
            </div>
            {(tasks?.length ? tasks : []).map((task: any, i: number) => (
              <div key={task.id} style={{ display: 'contents' }}>
                {i > 0 && (
                  <div className={task.status === 'running' ? 'm3-pipe-link' : 'm3-pipe-link-dim'}>
                    {task.status === 'running' ? (
                      <svg viewBox="0 0 32 4" fill="none"><line x1="0" y1="2" x2="32" y2="2" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--primary)', animation: 'pulse 2s infinite' }} /></svg>
                    ) : <div />}
                  </div>
                )}
                {task.status === 'running' ? (
                  <div className="m3-pipe-node active">
                    <span className="m3-pipe-dot-ping" />
                    <span className="m3-pipe-label-active">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'debug' ? 'Debugger' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                    <span className="m3-pipe-step">Step {doneCount + 1}/{tasks.length}</span>
                  </div>
                ) : task.status === 'completed' ? (
                  <div className="m3-pipe-node">
                    <span className="m3-pipe-dot" />
                    <span className="m3-pipe-label-dim">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'debug' ? 'Debugger' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                    <span className="m3-pipe-badge">Done</span>
                  </div>
                ) : (
                  <div className="m3-pipe-node dim">
                    <span className="m3-pipe-dot-sm" style={{ background: 'var(--primary-fixed)' }} />
                    <span className="m3-pipe-label-dim">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'debug' ? 'Debugger' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="m3-pipeline-meta">
            <span className="m3-pipe-hash">#{plan?.plan.contentHash?.slice(0, 8) ?? '--------'}</span>
            <span className="m3-pipe-pct">{pct}%</span>
            <button className="m3-pipe-toggle" onClick={() => setDagOpen(!dagOpen)} type="button">
              <span>Graph</span>
              <span className="material-symbols-outlined">{dagOpen ? 'expand_less' : 'expand_more'}</span>
            </button>
          </div>
          <div className="m3-agent-dock">
            <button className="m3-agent-chip active" type="button">
              <span className="m3-agent-chip-dot" />
              <span>Head AI</span>
              <span className="m3-agent-chip-model">{(projectSettings?.routing as any)?.head ?? providers.find((p: any) => p.configured)?.label ?? 'default'}</span>
            </button>
            {['research', 'builder', 'debug'].map((role) => (
              <button className="m3-agent-chip" key={role} type="button">
                <span className={`m3-agent-chip-dot ${role === 'builder' ? 'green' : ''}`} />
                <span>{role === 'research' ? 'Scout' : role === 'builder' ? 'Forge' : 'Debugger'}</span>
                <span className="m3-agent-chip-model">{(projectSettings?.routing as any)?.[role] ?? 'default'}</span>
              </button>
            ))}
          </div>
        </div>

        {/* DAG Panel */}
        <div className={`m3-dag-panel ${dagOpen ? '' : 'hidden'}`}>
          <div className="m3-dag-header">
            <div className="m3-dag-title-group">
              <span className="m3-dag-title">Execution Graph</span>
              <span className="m3-dag-count">{tasks?.length || 0} nodes</span>
            </div>
            <span className="m3-dag-sandbox">
              <span className="m3-status-dot" style={{ width: 6, height: 6 }} /> Sandboxed
            </span>
          </div>
          <div className="m3-dag-grid">
            {(tasks ?? []).map((task: any) => (
              <div key={task.id} className={`m3-dag-card ${task.status === 'running' ? 'active' : task.status !== 'completed' ? 'dim' : ''}`}>
                <div className="m3-dag-card-head">
                  <span className={task.status === 'completed' ? 'tertiary' : task.status === 'running' ? 'primary' : 'muted'}>{task.title}</span>
                  {task.status === 'completed' ? <span className="material-symbols-outlined" style={{ color: 'var(--tertiary)' }}>check_circle</span>
                    : task.status === 'running' ? <span className="m3-dag-card-status running">Running</span>
                    : <span className="m3-dag-card-status queued">Queued</span>}
                </div>
                <p className="m3-dag-card-desc">{task.result?.slice(0, 50) ?? task.instructions?.slice(0, 50) ?? ''}</p>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Chat Grid */}
      <div className="m3-chat-grid">
        <div className="m3-chat-stream">
          {messages.length === 0 && !plan && (
            <div className="m3-timestamp"><span>Give the Head AI a direction to begin.</span></div>
          )}

          {messages.map((msg: any) => (
            msg.role === 'user' ? (
              <div className="m3-msg-user" key={msg.id}>
                <div className="m3-msg-user-bubble">
                  <p>{msg.content}</p>
                  <div className="m3-msg-user-meta">
                    <span>{new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="material-symbols-outlined">done_all</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="m3-msg-agent" key={msg.id}>
                <div className="m3-msg-avatar"><span className="material-symbols-outlined">smart_toy</span></div>
                <div className="m3-msg-body">
                  <div className="m3-msg-head">
                    <span className="m3-msg-name">{msg.agentId ? (msg.agentId === 'builder' ? 'Forge' : msg.agentId === 'research' ? 'Scout' : msg.agentId) : 'Head AI'}</span>
                    <span className="m3-msg-role">{msg.agentId ? 'Worker' : 'Supervisor'}</span>
                    <span className="m3-msg-time">{new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </div>
                  <p className="m3-msg-text">{msg.content}</p>
                </div>
              </div>
            )
          ))}

          {/* Streaming */}
          {streaming && (
            <div className="m3-msg-agent">
              <div className="m3-msg-avatar"><span className="material-symbols-outlined">smart_toy</span></div>
              <div className="m3-msg-body">
                <div className="m3-msg-head">
                  <span className="m3-msg-name">Head AI</span>
                  <span className="m3-msg-role">writing</span>
                </div>
                <p className="m3-msg-text">{streaming.text || '…'}</p>
              </div>
            </div>
          )}

          {/* Plan Card */}
          {plan && (
            <div className="m3-msg-agent">
              <div className="m3-msg-avatar"><span className="material-symbols-outlined">smart_toy</span></div>
              <div className="m3-msg-body">
                <div className="m3-plan-card">
                  <div className="m3-plan-head">
                    <div className="m3-plan-head-left">
                      <span className="material-symbols-outlined">checklist</span>
                      <span className="m3-plan-title">Plan: {plan.plan.objective}</span>
                    </div>
                    <span className="m3-plan-badge">
                      <span className="m3-plan-badge-dot" /> {plan.plan.status}
                    </span>
                  </div>
                  <div className="m3-plan-tasks">
                    {plan.tasks.map((task: any, i: number) => {
                      const taskData = tasks?.find((t: any) => t.planTaskId === task.id)
                      const state = taskData?.status
                      return state === 'running' ? (
                        <div className="m3-plan-task-active" key={task.id ?? i}>
                          <span className="pulse-dot" />
                          <span><strong>{task.agentId === 'builder' ? 'Forge' : task.agentId}: </strong>{task.title}</span>
                        </div>
                      ) : state === 'completed' ? (
                        <label className="m3-plan-task done" key={task.id ?? i}>
                          <input type="checkbox" checked disabled />
                          <span>{task.title}</span>
                        </label>
                      ) : (
                        <div className="m3-plan-task-queued" key={task.id ?? i}>
                          <span className="num">{i + 1}</span>
                          <span>{task.title}</span>
                        </div>
                      )
                    })}
                  </div>
                  {plan.plan.status === 'draft' && ['planning', 'review', 'interrupted'].includes(run?.status ?? '') && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button className="m3-btn-primary" onClick={() => void bridge.control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash })} type="button">
                        <span className="material-symbols-outlined">play_arrow</span> Approve & Run
                      </button>
                      <button className="m3-btn-ghost" onClick={() => void bridge.draftPlan({ regenerate: true })} type="button">Redraft</button>
                    </div>
                  )}
                </div>

                {/* Approval Card */}
                {approval && (
                  <div className="m3-approval-card">
                    <div className="m3-approval-head">
                      <div className="m3-approval-head-left">
                        <span className="material-symbols-outlined">gavel</span>
                        <span className="m3-approval-title">{isQuestion ? 'Question' : 'Approval Required'}</span>
                        <span className="m3-approval-tool">{approval.toolCall.name}</span>
                      </div>
                    </div>
                    {isQuestion ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <p className="m3-msg-text">{String(approval.toolCall.resolved?.question ?? 'The worker has a question.')}</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input className="m3-input" style={{ flex: 1, marginBottom: 0 }} placeholder="Answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) { void bridge.answerCall(answer.trim()); setAnswer('') } }} />
                          <button className="m3-btn-primary" disabled={!answer.trim()} onClick={() => { void bridge.answerCall(answer.trim()); setAnswer('') }} type="button">Send</button>
                          <button className="m3-btn-danger" onClick={() => void bridge.denyCall('Declined by the user.')} type="button">Decline</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="m3-approval-cmd">
                          <span className="m3-approval-cmd-text">
                            <span className="prompt">$ </span>
                            {approval.toolCall.resolved?.argv?.join(' ') ?? approval.toolCall.resolved?.relative ?? approval.toolCall.name}
                          </span>
                        </div>
                        {showDeny ? (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input className="m3-input" style={{ flex: 1, marginBottom: 0 }} autoFocus placeholder="Why not?" value={denyReason} onChange={(e) => setDenyReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { void bridge.denyCall(denyReason || 'Denied by the user.'); setDenyReason(''); setShowDeny(false) } }} />
                            <button className="m3-btn-primary" onClick={() => { void bridge.denyCall(denyReason || 'Denied by the user.'); setDenyReason(''); setShowDeny(false) }} type="button">Send</button>
                            <button className="m3-btn-ghost" onClick={() => setShowDeny(false)} type="button">Cancel</button>
                          </div>
                        ) : (
                          <div className="m3-approval-btns">
                            <button className="m3-btn-primary" onClick={() => void bridge.approveCall('once')} type="button">
                              <span className="material-symbols-outlined">play_arrow</span> Approve <kbd style={{ opacity: 0.7 }}>a</kbd>
                            </button>
                            <button className="m3-btn-ghost" onClick={() => void bridge.approveCall('run')} type="button">For Run <kbd style={{ opacity: 0.7 }}>r</kbd></button>
                            <button className="m3-btn-danger" onClick={() => setShowDeny(true)} type="button">Deny <kbd style={{ opacity: 0.7 }}>d</kbd></button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Side Drawer */}
        <div className="m3-side-drawer">
          <div className="m3-drawer-card">
            <div className="m3-drawer-head">
              <div className="m3-drawer-head-left">
                <span className="m3-drawer-title">Active Artifacts</span>
                <span className="m3-drawer-live">Live</span>
              </div>
            </div>
            <div className="m3-tabs">
              <button className={`m3-tab ${drawerTab === 'diffs' ? 'active' : ''}`} onClick={() => setDrawerTab('diffs')} type="button">
                <span>Diffs</span>
                {artifacts?.length ? <span className="m3-tab-badge">{artifacts.length}</span> : null}
              </button>
              <button className={`m3-tab ${drawerTab === 'logs' ? 'active' : ''}`} onClick={() => setDrawerTab('logs')} type="button">
                <span>Logs</span>
              </button>
              <button className={`m3-tab ${drawerTab === 'security' ? 'active' : ''}`} onClick={() => setDrawerTab('security')} type="button">
                <span>Spend</span>
              </button>
            </div>

            {drawerTab === 'diffs' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {artifacts?.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--on-surface-variant)', padding: 8 }}>No files written yet.</p>
                ) : (artifacts ?? []).map((a: any) => (
                  <div key={a.toolCallId ?? a.path}>
                    <div className="m3-diff-file">
                      <span className="m3-diff-file-name">{a.path}</span>
                      <span className="m3-diff-tag">{a.created ? 'created' : 'modified'}</span>
                    </div>
                    {a.diff?.hunks?.length ? (
                      <div className="m3-diff-block" style={{ marginTop: 4 }}>
                        {a.diff.hunks.slice(0, 2).map((hunk: any, hi: number) => (
                          <div key={hi}>
                            <div className="m3-diff-hunk">@@ {hunk.header ?? ''}</div>
                            {hunk.entries?.slice(0, 6).map((entry: any, ei: number) => (
                              <div key={ei} className={entry.type === 'add' ? 'm3-diff-line-add' : entry.type === 'remove' ? 'm3-diff-line-del' : ''}>
                                {entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' '} {entry.line}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--secondary)', marginTop: 4, fontFamily: 'var(--font)' }}>{a.bytes} B</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {drawerTab === 'logs' && (
              <div className="m3-diff-block" style={{ minHeight: 120 }}>
                {(toolCalls ?? []).slice(-8).map((call: any) => (
                  <div key={call.id} style={{ color: call.status === 'completed' ? 'var(--tertiary)' : call.status === 'failed' ? 'var(--error)' : 'var(--on-surface-variant)' }}>
                    {call.status === 'completed' ? '✓' : call.status === 'failed' ? '✕' : '▸'} {call.name} {call.error ? `— ${call.error.slice(0, 40)}` : ''}
                  </div>
                ))}
                {(!toolCalls || toolCalls.length === 0) && <div style={{ color: 'var(--on-surface-variant)' }}>No tool calls yet.</div>}
              </div>
            )}

            {drawerTab === 'security' && (
              <div className="m3-diff-block" style={{ minHeight: 120 }}>
                <div className="m3-telem-row"><span>Total Spend:</span><span>${(spend?.costUsd ?? 0).toFixed(4)}</span></div>
                <div className="m3-telem-row"><span>Calls:</span><span>{spend?.calls ?? 0}</span></div>
                {(byTask ?? []).map((t: any) => (
                  <div className="m3-telem-row" key={t.taskId ?? 'super'}>
                    <span>{t.title || 'supervisor'}</span>
                    <span>${(t.costUsd ?? 0).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}

            <div>
              <button className="m3-telem-toggle" onClick={() => setTelemOpen(!telemOpen)} type="button">
                <span className="m3-telem-toggle-left">
                  <span className="material-symbols-outlined">speed</span>
                  <span>System Telemetry</span>
                </span>
                <span className="material-symbols-outlined">{telemOpen ? 'expand_less' : 'expand_more'}</span>
              </button>
              <div className={`m3-telem-details ${telemOpen ? '' : 'hidden'}`}>
                <div className="m3-telem-row"><span>Status:</span><span>{run?.status ?? 'idle'}</span></div>
                <div className="m3-telem-row"><span>Tasks:</span><span>{doneCount}/{tasks?.length ?? 0}</span></div>
                <div className="m3-telem-row"><span>Plan Hash:</span><span className="hash">{plan?.plan.contentHash?.slice(0, 16) ?? '—'}</span></div>
              </div>
            </div>
          </div>

          <div className="m3-daemon-card">
            <div className="m3-daemon-icon"><span className="material-symbols-outlined">terminal</span></div>
            <div className="m3-daemon-info">
              <div className="m3-daemon-name">fulkrum bridge</div>
              <div className="m3-daemon-meta">{run ? `run ${run.id.slice(0, 12)}` : 'no run open'}</div>
            </div>
            <span className="m3-daemon-dot" />
          </div>
        </div>
      </div>

      {/* Prompt Bar */}
      <div className="m3-prompt-wrap">
        <div className="m3-prompt">
          <div className="m3-prompt-top">
            <div className="m3-prompt-top-left">
              <div className="m3-steer">
                <span className="m3-steer-dot" />
                <span className="m3-steer-label">Steer:</span>
                <span className="m3-steer-value">Head AI</span>
              </div>
            </div>
            <div className="m3-token-count">
              <span className="val">{messages.length}</span>
              <span className="sep">msgs</span>
            </div>
          </div>
          <div className="m3-prompt-input-row">
            <textarea
              rows={1}
              placeholder="Direct Head AI, or describe what to build…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
              onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = ''; t.style.height = t.scrollHeight + 'px' }}
            />
            <div className="m3-prompt-actions">
              <button className="m3-send-btn" title="Send (Ctrl+Enter)" disabled={!prompt.trim() || sending} onClick={() => void send()} type="button">
                <span className="material-symbols-outlined">arrow_upward</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
