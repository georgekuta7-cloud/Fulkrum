import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'

export function ChatView({ bridge }: { bridge: Bridge }) {
  const [dagOpen, setDagOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<'diffs' | 'logs' | 'spend'>('diffs')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [showDeny, setShowDeny] = useState(false)
  const [denyReason, setDenyReason] = useState('')
  const [answer, setAnswer] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  const { messages, plan, approval, tasks, toolCalls, artifacts, spend, byTask, run, streaming } = bridge

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length, streaming?.text])

  useEffect(() => {
    if (!approval) return
    const isQ = approval.toolCall.kind === 'ask' || approval.toolCall.name === 'run.ask'
    if (isQ) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.key === 'a') void bridge.approveCall('once')
      else if (e.key === 'd') { setShowDeny(true); e.preventDefault() }
      else if (e.key === 'r') void bridge.approveCall('run')
      else if (e.key === 'Escape') setShowDeny(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, bridge])

  const send = async () => {
    const msg = prompt.trim()
    if (!msg || sending) return
    setPrompt(''); setSending(true)
    try { await bridge.chat(msg) } finally { setSending(false) }
  }

  const doneCount = tasks?.filter((t: any) => t.status === 'completed').length ?? 0
  const pct = tasks?.length ? Math.round((doneCount / tasks.length) * 100) : 0
  const isQ = approval?.toolCall.kind === 'ask' || approval?.toolCall.name === 'run.ask'

  return (
    <div className="flex flex-col w-full max-w-7xl mx-auto px-4 lg:px-8 py-4 relative">
      <div className="pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 w-[720px] h-[220px] bg-gradient-to-b from-primary/10 via-primary/5 to-transparent blur-3xl opacity-60" />

      {/* Pipeline Tracker */}
      <header className="relative z-10 w-full mb-6">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 p-2 bg-surface-container rounded-xl shadow-md">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-low rounded-lg overflow-x-auto min-w-0">
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center">
                <span className="material-symbols-outlined text-[13px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
              </span>
              <span className="text-label-lg text-on-surface">Head AI</span>
            </div>
            <div className="w-8 flex items-center justify-center flex-shrink-0">
              <svg className="w-full h-1" fill="none" viewBox="0 0 32 4"><line x1="0" y1="2" x2="32" y2="2" stroke="currentColor" strokeDasharray="2 3" strokeWidth="2" className="text-primary" /></svg>
            </div>
            {(tasks ?? []).map((task: any, i: number) => (
              <div key={task.id} className="contents">
                {i > 0 && (
                  <div className={`${task.status === 'running' ? 'w-8' : 'w-6'} flex items-center justify-center flex-shrink-0`}>
                    {task.status === 'running' ? (
                      <svg className="w-full h-1" fill="none" viewBox="0 0 32 4"><line x1="0" y1="2" x2="32" y2="2" stroke="currentColor" strokeWidth="2" className="text-primary animate-pulse" /></svg>
                    ) : <div className="w-full h-[1px] bg-surface-container-highest" />}
                  </div>
                )}
                {task.status === 'running' ? (
                  <div className="flex items-center gap-2 flex-shrink-0 px-2 py-0.5 rounded-full bg-primary/15 shadow-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                    </span>
                    <span className="text-label-lg font-semibold text-primary">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                    <span className="text-label-md text-on-primary-container font-mono">Step {doneCount + 1}/{tasks.length}</span>
                  </div>
                ) : task.status === 'completed' ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="w-2 h-2 rounded-full bg-tertiary" />
                    <span className="text-label-lg text-on-surface-variant">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                    <span className="text-[10px] text-tertiary font-mono bg-tertiary-container px-1 rounded">Done</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-shrink-0 opacity-40">
                    <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant" />
                    <span className="text-label-lg text-on-surface-variant">{task.agentId === 'builder' ? 'Forge' : task.agentId === 'research' ? 'Scout' : task.agentId}</span>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2 ml-auto pl-3 flex-shrink-0">
              <span className="text-[11px] font-mono text-on-surface-variant">#{plan?.plan.contentHash?.slice(0, 8) ?? '--------'}</span>
              <span className="text-[11px] font-mono text-tertiary font-medium">{pct}%</span>
              <button className="text-[11px] text-on-surface-variant hover:text-on-surface px-2 py-0.5 rounded hover:bg-surface-container-highest transition-colors flex items-center gap-1" onClick={() => setDagOpen(!dagOpen)}>
                <span>Graph</span>
                <span className="material-symbols-outlined text-sm">{dagOpen ? 'expand_less' : 'expand_more'}</span>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto p-1 bg-surface-container-low rounded-lg flex-shrink-0">
            <button className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container-highest text-on-surface text-label-lg font-medium shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              <span>Head AI</span>
            </button>
            <button className="flex items-center gap-1.5 px-2.5 py-1 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container text-label-lg transition-colors">
              <span>Scout</span>
            </button>
            <button className="flex items-center gap-1.5 px-2.5 py-1 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container text-label-lg transition-colors">
              <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
              <span>Forge</span>
            </button>
          </div>
        </div>

        {/* DAG Panel */}
        {dagOpen && (
          <div className="mt-2 p-4 bg-surface-container-low rounded-xl shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-label-sm uppercase tracking-wider font-semibold text-on-surface-variant">Execution Graph</span>
                <span className="text-[11px] font-mono text-on-surface-variant">{tasks?.length ?? 0} nodes</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {(tasks ?? []).map((task: any) => (
                <div key={task.id} className={`p-3 rounded-lg ${task.status === 'running' ? 'bg-surface-container-highest shadow-sm' : task.status === 'completed' ? 'bg-surface-container' : 'bg-surface-container opacity-40'}`}>
                  <div className="flex items-center justify-between text-label-lg mb-1">
                    <span className={`font-medium ${task.status === 'completed' ? 'text-tertiary' : task.status === 'running' ? 'text-primary' : 'text-on-surface-variant'}`}>{task.title}</span>
                    {task.status === 'completed' ? <span className="material-symbols-outlined text-sm text-tertiary">check_circle</span>
                      : task.status === 'running' ? <span className="text-[10px] font-mono text-primary animate-pulse">Running</span>
                      : <span className="text-[10px] font-mono text-on-surface-variant">Queued</span>}
                  </div>
                  <p className="text-[11px] text-on-surface-variant line-clamp-1">{task.result?.slice(0, 40) ?? task.instructions?.slice(0, 40) ?? ''}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* Chat Grid */}
      <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-6 items-start pb-36">
        <div className="lg:col-span-8 flex flex-col gap-6 transition-all duration-300">
          {messages.length === 0 && !plan && (
            <div className="flex items-center justify-center my-1">
              <span className="text-[11px] font-mono text-secondary px-2.5 py-0.5 rounded-full bg-surface-container-lowest">Give the Head AI a direction to begin.</span>
            </div>
          )}

          {messages.map((msg: any) => (
            msg.role === 'user' ? (
              <div className="flex justify-end pl-8" key={msg.id}>
                <div className="max-w-xl bg-surface-container-high rounded-2xl rounded-tr-sm px-4 py-3 shadow-sm">
                  <p className="text-body-md text-on-surface leading-relaxed">{msg.content}</p>
                  <div className="flex items-center justify-end gap-2 mt-1.5 text-[10px] text-secondary font-mono">
                    <span>{new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className="material-symbols-outlined text-xs text-tertiary">done_all</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3.5 pr-4" key={msg.id}>
                <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-primary text-lg">smart_toy</span>
                </div>
                <div className="flex-1 space-y-4 max-w-2xl min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-label-lg font-semibold text-on-surface">{msg.agentId ? (msg.agentId === 'builder' ? 'Forge' : msg.agentId) : 'Head AI'}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{msg.agentId ? 'Worker' : 'Supervisor'}</span>
                    <span className="text-[11px] text-secondary font-mono">{new Date(msg.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </div>
                  <p className="text-body-md text-on-surface leading-relaxed">{msg.content}</p>
                </div>
              </div>
            )
          ))}

          {streaming && (
            <div className="flex items-start gap-3.5 pr-4">
              <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="material-symbols-outlined text-primary text-lg">smart_toy</span>
              </div>
              <div className="flex-1 space-y-2 max-w-2xl min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-label-lg font-semibold text-on-surface">Head AI</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-container text-tertiary">writing</span>
                </div>
                <p className="text-body-md text-on-surface leading-relaxed">{streaming.text || '…'}</p>
              </div>
            </div>
          )}

          {/* Plan Card */}
          {plan && (
            <div className="flex items-start gap-3.5 pr-4">
              <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="material-symbols-outlined text-primary text-lg">checklist</span>
              </div>
              <div className="flex-1 max-w-2xl min-w-0">
                <div className="bg-surface-container rounded-xl p-4 shadow-sm hover:bg-surface-container-high transition-colors">
                  <div className="flex items-center justify-between pb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-label-lg font-semibold text-on-surface tracking-tight">Plan: {plan.plan.objective}</span>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-tertiary-container text-on-tertiary-container font-medium flex items-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-tertiary" /> {plan.plan.status}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {plan.tasks.map((task: any, i: number) => {
                      const td = tasks?.find((t: any) => t.planTaskId === task.id)
                      const state = td?.status
                      return state === 'running' ? (
                        <div className="flex items-center gap-2.5 text-label-lg" key={task.id ?? i}>
                          <span className="w-3.5 h-3.5 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                          </span>
                          <span className="font-medium text-primary">{task.agentId === 'builder' ? 'Forge' : task.agentId}: {task.title}</span>
                        </div>
                      ) : state === 'completed' ? (
                        <label className="flex items-center gap-2.5 text-label-lg text-on-surface" key={task.id ?? i}>
                          <input type="checkbox" checked disabled className="accent-primary rounded w-3.5 h-3.5" />
                          <span className="line-through text-on-surface-variant">{task.title}</span>
                        </label>
                      ) : (
                        <div className="flex items-center gap-2.5 text-label-lg text-on-surface-variant opacity-70" key={task.id ?? i}>
                          <span className="w-3.5 h-3.5 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0 text-[10px] font-mono">{i + 1}</span>
                          <span>{task.title}</span>
                        </div>
                      )
                    })}
                  </div>
                  {plan.plan.status === 'draft' && ['planning', 'review', 'interrupted'].includes(run?.status ?? '') && (
                    <div className="flex gap-2 pt-3">
                      <button className="px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary-container text-on-primary text-label-lg font-semibold tracking-tight transition-all shadow-sm flex items-center gap-1.5" onClick={() => void bridge.control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash })}>
                        <span className="material-symbols-outlined text-sm">play_arrow</span> Approve & Run
                      </button>
                      <button className="px-3 py-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container text-label-lg transition-colors" onClick={() => void bridge.draftPlan({ regenerate: true })}>Redraft</button>
                    </div>
                  )}
                </div>

                {/* Approval Card */}
                {approval && (
                  <div className="bg-surface-container-low rounded-xl p-4 shadow-md space-y-3 relative overflow-hidden mt-4">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-lg">gavel</span>
                        <span className="text-label-lg font-semibold text-on-surface">{isQ ? 'Question' : 'Approval Required'}</span>
                        <span className="text-[10px] font-mono text-on-surface-variant px-1.5 py-0.5 rounded bg-surface-container">{approval.toolCall.name}</span>
                      </div>
                    </div>
                    {isQ ? (
                      <div className="space-y-3">
                        <p className="text-body-md text-on-surface">{String(approval.toolCall.resolved?.question ?? 'The worker has a question.')}</p>
                        <div className="flex gap-2">
                          <input className="flex-1 px-3 py-1.5 bg-surface-container rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50 border border-transparent" placeholder="Answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) { void bridge.answerCall(answer.trim()); setAnswer('') } }} />
                          <button className="px-3.5 py-1.5 rounded-lg bg-primary text-on-primary text-label-lg font-semibold" disabled={!answer.trim()} onClick={() => { void bridge.answerCall(answer.trim()); setAnswer('') }}>Send</button>
                          <button className="px-3 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-label-lg transition-colors" onClick={() => void bridge.denyCall('Declined.')}>Decline</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="p-2.5 rounded-lg bg-surface-container-lowest font-mono text-label-lg text-on-surface flex items-center justify-between">
                          <span className="truncate text-on-surface-variant"><span className="text-tertiary">$</span> {approval.toolCall.resolved?.argv?.join(' ') ?? approval.toolCall.resolved?.relative ?? approval.toolCall.name}</span>
                        </div>
                        {showDeny ? (
                          <div className="flex gap-2">
                            <input className="flex-1 px-3 py-1.5 bg-surface-container rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none" autoFocus placeholder="Why not?" value={denyReason} onChange={(e) => setDenyReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { void bridge.denyCall(denyReason || 'Denied.'); setDenyReason(''); setShowDeny(false) } }} />
                            <button className="px-3.5 py-1.5 rounded-lg bg-error text-on-primary text-label-lg font-semibold" onClick={() => { void bridge.denyCall(denyReason || 'Denied.'); setDenyReason(''); setShowDeny(false) }}>Send</button>
                            <button className="px-3 py-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container text-label-lg" onClick={() => setShowDeny(false)}>Cancel</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 pt-2">
                            <button className="px-3.5 py-1.5 rounded-lg bg-primary hover:bg-primary-container text-on-primary text-label-lg font-semibold tracking-tight transition-all shadow-sm flex items-center gap-1.5" onClick={() => void bridge.approveCall('once')}>
                              <span className="material-symbols-outlined text-sm">play_arrow</span> Approve <kbd className="opacity-70">a</kbd>
                            </button>
                            <button className="px-3 py-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container text-label-lg transition-colors" onClick={() => void bridge.approveCall('run')}>For Run <kbd className="opacity-70">r</kbd></button>
                            <button className="ml-auto px-3 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-label-lg transition-colors" onClick={() => setShowDeny(true)}>Deny <kbd className="opacity-70">d</kbd></button>
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
        <div className="lg:col-span-4 sticky top-16 flex flex-col gap-4">
          <div className="bg-surface-container rounded-xl p-3 shadow-md flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-label-lg font-semibold text-on-surface tracking-tight">Active Artifacts</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant">Live</span>
              </div>
            </div>
            <div className="flex items-center p-0.5 rounded-lg bg-surface-container-low text-label-lg">
              {(['diffs', 'logs', 'spend'] as const).map((tab) => (
                <button key={tab} className={`flex-1 py-1 text-center font-medium rounded-md transition-all flex items-center justify-center gap-1 ${drawerTab === tab ? 'bg-surface-container-highest text-on-surface shadow-sm' : 'text-secondary hover:text-on-surface'}`} onClick={() => setDrawerTab(tab)}>
                  <span>{tab === 'spend' ? 'Spend' : tab === 'logs' ? 'Logs' : 'Diffs'}</span>
                  {tab === 'diffs' && artifacts?.length ? <span className="text-[10px] font-mono text-tertiary">{artifacts.length}</span> : null}
                </button>
              ))}
            </div>

            {drawerTab === 'diffs' && (
              <div className="space-y-3">
                {artifacts?.length === 0 ? (
                  <p className="text-label-lg text-on-surface-variant p-2">No files written yet.</p>
                ) : (artifacts ?? []).map((a: any) => (
                  <div key={a.toolCallId ?? a.path}>
                    <div className="flex items-center justify-between text-label-lg font-mono text-on-surface-variant">
                      <span className="truncate max-w-[200px]">{a.path}</span>
                      <span className="text-[10px] text-tertiary">{a.created ? 'created' : 'modified'}</span>
                    </div>
                    {a.diff?.hunks?.length ? (
                      <div className="rounded-lg bg-surface-container-lowest p-2.5 font-mono text-[11px] leading-relaxed overflow-x-auto space-y-1 mt-1">
                        {a.diff.hunks.slice(0, 2).map((h: any, hi: number) => (
                          <div key={hi}>
                            {h.entries?.slice(0, 6).map((e: any, ei: number) => (
                              <div key={ei} className={`${e.type === 'add' ? 'text-tertiary bg-tertiary-container/30' : e.type === 'remove' ? 'text-error bg-error-container/30' : 'text-on-surface-variant'} px-1 rounded`}>
                                {e.type === 'add' ? '+' : e.type === 'remove' ? '-' : ' '} {e.line}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-secondary mt-1">{a.bytes} B</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {drawerTab === 'logs' && (
              <div className="rounded-lg bg-surface-container-lowest p-2.5 font-mono text-[11px] space-y-1 min-h-[120px]">
                {(toolCalls ?? []).slice(-8).map((c: any) => (
                  <div key={c.id} className={c.status === 'completed' ? 'text-tertiary' : c.status === 'failed' ? 'text-error' : 'text-on-surface-variant'}>
                    {c.status === 'completed' ? '✓' : c.status === 'failed' ? '✕' : '▸'} {c.name} {c.error ? `— ${c.error.slice(0, 40)}` : ''}
                  </div>
                ))}
                {(!toolCalls || toolCalls.length === 0) && <div className="text-on-surface-variant">No tool calls yet.</div>}
              </div>
            )}

            {drawerTab === 'spend' && (
              <div className="rounded-lg bg-surface-container-lowest p-2.5 font-mono text-[11px] space-y-1.5 text-on-surface-variant min-h-[120px]">
                <div className="flex justify-between"><span>Total Spend:</span><span className="text-on-surface">${(spend?.costUsd ?? 0).toFixed(4)}</span></div>
                <div className="flex justify-between"><span>Calls:</span><span className="text-on-surface">{spend?.calls ?? 0}</span></div>
                {(byTask ?? []).map((t: any) => (
                  <div className="flex justify-between" key={t.taskId ?? 'super'}>
                    <span>{t.title || 'supervisor'}</span>
                    <span className="text-on-surface">${(t.costUsd ?? 0).toFixed(4)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-3 bg-surface-container/60 rounded-xl flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-surface-container-highest flex items-center justify-center text-primary flex-shrink-0">
              <span className="material-symbols-outlined">terminal</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-label-lg font-medium text-on-surface truncate">fulkrum bridge</div>
              <div className="text-[10px] font-mono text-secondary truncate">{run ? `run ${run.id.slice(0, 12)}` : 'no run open'}</div>
            </div>
            <span className="w-2 h-2 rounded-full bg-tertiary flex-shrink-0" />
          </div>
        </div>
      </div>

      {/* Prompt Bar */}
      <div className="fixed bottom-6 left-16 right-0 max-w-4xl mx-auto px-4 pointer-events-none z-30">
        <div className="pointer-events-auto bg-surface-container/95 backdrop-blur-xl rounded-2xl shadow-2xl p-2.5 transition-all">
          <div className="flex items-center justify-between px-2 pt-0.5 pb-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high text-label-lg font-medium text-on-surface cursor-pointer transition-colors">
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                <span className="text-[11px]">Steer:</span>
                <span className="text-[11px] text-primary font-semibold">Head AI</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-on-surface-variant">
              <span className="font-medium">{messages.length}</span>
              <span>msgs</span>
            </div>
          </div>
          <div className="relative flex items-end gap-2 px-2 pb-1">
            <textarea
              className="w-full bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none resize-none max-h-32 py-1 leading-relaxed"
              rows={1} placeholder="Direct Head AI, or describe what to build…"
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
              onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = ''; t.style.height = t.scrollHeight + 'px' }}
            />
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button className="w-8 h-8 rounded-lg bg-primary hover:bg-primary-container text-on-primary flex items-center justify-center transition-all shadow-sm disabled:opacity-40" title="Send (Ctrl+Enter)" disabled={!prompt.trim() || sending} onClick={() => void send()}>
                <span className="material-symbols-outlined">arrow_upward</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
