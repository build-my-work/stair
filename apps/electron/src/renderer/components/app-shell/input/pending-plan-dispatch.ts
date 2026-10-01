export interface PendingPlanExecution {
  planPath: string
  draftInputSnapshot?: string
  draftReferencesSnapshot?: import('@craft-agent/core').Reference[]
  awaitingCompaction: boolean
  executionDispatched: boolean
  /** Stable record identity; the host rejects commands carrying any other (or no) identity. */
  executionId?: string
  /** Durable idempotency key of the failed-compaction draft restore outbox. */
  restoreId?: string
  /** Terminal non-executable state after a failed/cancelled compaction. */
  failed?: boolean
}

interface Dependencies {
  isBusy: () => boolean
  load: () => Promise<PendingPlanExecution | null>
  /**
   * Host-owned dispatch: the server performs the entire handoff — readiness
   * and ownership recheck on the identity THIS renderer observed, durable
   * acceptance (queued approval user message persisted atomically with the
   * claim) and the model-turn kickoff — in one RPC. A notification is only a
   * wakeup; persisted readiness and the host's atomic claim authorize
   * execution, never event text or a timeout. Any window using the same RPC
   * is serialized by the host's lifecycle lock, and a stale identity is
   * rejected by the host.
   */
  dispatch: (pending: PendingPlanExecution) => Promise<unknown>
  /**
   * A failed record is a durable restore outbox: it is never dispatched, and
   * recovery is re-delivered through this hook (live wire event or reconnect
   * exposure via this load) so the owning surface can drive the ordered
   * coordinator restore and the scoped ACK.
   */
  notifyFailed?: (pending: PendingPlanExecution) => void
}

/** One dispatcher for both live completion and reload recovery. */
export function createPendingPlanDispatcher(deps: Dependencies) {
  let disposed = false
  let running: Promise<void> | undefined
  let requested = false
  const drain = async () => {
    do {
      requested = false
      if (disposed) return
      const pending = await deps.load()
      if (disposed) return
      if (pending?.failed) {
        // Outbox re-delivery runs BEFORE any busy/awaiting gate: a cancelled
        // record is still `awaitingCompaction` and recovery must reach the
        // user even while the session processes. Never dispatched.
        deps.notifyFailed?.(pending)
        continue
      }
      if (deps.isBusy()) return
      if (!pending || pending.awaitingCompaction || pending.executionDispatched) continue
      // Benign rejections (another window won, not ready, busy, stale
      // identity) need no retry here: the idle-transition and
      // compaction-completion wakeups re-run.
      await deps.dispatch(pending)
    } while (requested && !disposed)
  }
  return {
    request(): Promise<void> {
      if (disposed) return Promise.resolve()
      requested = true
      if (!running) running = drain().finally(() => { running = undefined })
      return running
    },
    dispose() { disposed = true },
  }
}
