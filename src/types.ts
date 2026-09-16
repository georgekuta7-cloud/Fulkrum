/**
 * Domain unions shared across components.
 *
 * They live here rather than in App because they are part of the interface
 * contract between the API and the UI: a mode the server rejects, or a role the
 * policy table does not know, would otherwise drift between files.
 */
export type Mode = 'plan' | 'execute' | 'review'
export type PermissionMode = 'guided' | 'selective' | 'autopilot'
export type AgentId = 'head' | 'research' | 'builder'
export type AgentTone = 'orange' | 'teal' | 'blue'
