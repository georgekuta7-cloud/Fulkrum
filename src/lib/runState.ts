export const PLAN_ROLES = ['research', 'builder', 'architect', 'editor', 'debug'] as const
export const canDraftPlan = (status: string) => ['planning', 'review', 'interrupted'].includes(status)
export const canResumeRun = (status: string) => ['paused', 'interrupted', 'budget_exceeded', 'failed'].includes(status)
export const canPauseRun = (status: string) => ['planning', 'executing', 'budget_exceeded'].includes(status)
export const canCancelRun = (status: string) => ['planning', 'executing', 'paused', 'review', 'interrupted', 'budget_exceeded'].includes(status)
export const canChatInRun = (status: string) => !['cancelled', 'completed', 'failed'].includes(status)
