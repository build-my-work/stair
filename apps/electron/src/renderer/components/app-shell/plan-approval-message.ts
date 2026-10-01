// The approval-message contract now lives in `@craft-agent/shared` so the
// server-owned durable dispatch and every renderer surface build byte-identical
// text. Re-exported here for existing imports.
export { buildPlanApprovalMessage, type BuildPlanApprovalMessageOptions } from '@craft-agent/shared/sessions/plan-approval'
