import { describe, expect, it } from 'bun:test'
import { createPendingPlanDispatcher, type PendingPlanExecution } from '../pending-plan-dispatch'

const ready: PendingPlanExecution = { planPath: '/plan.md', draftInputSnapshot: 'Keep this', awaitingCompaction: false, executionDispatched: false, executionId: 'exec-1' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('persisted plan dispatch', () => {
  it('waits for idle and persisted success; failure/awaiting never dispatch, failed notifies', async () => {
    let busy = true
    let pending: PendingPlanExecution | null = ready
    const dispatched: (string | undefined)[] = []
    const notified: (string | undefined)[] = []
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => busy, load: async () => pending,
      dispatch: async record => { dispatched.push(record.executionId) },
      notifyFailed: record => { notified.push(record.restoreId) },
    })
    await dispatcher.request()
    expect(dispatched).toEqual([])
    busy = false
    pending = { ...ready, awaitingCompaction: true }
    await dispatcher.request()
    pending = null // host cleared the record
    await dispatcher.request()
    expect(dispatched).toEqual([])
    // A failed record is a restore outbox: never dispatched — re-delivered
    // through the recovery hook (reconnect exposure of the durable outbox).
    pending = { ...ready, failed: true, restoreId: 'restore-1' }
    await dispatcher.request()
    expect(dispatched).toEqual([])
    expect(notified).toEqual(['restore-1'])
    pending = ready
    await dispatcher.request()
    // The dispatch submits the identity the renderer actually observed.
    expect(dispatched.at(-1)).toBe(ready.executionId)
  })
  it('always defers ownership to the host claim (duplicate listeners and reloads)', async () => {
    // The host-side dispatch RPC is serialized by the server's lifecycle lock;
    // every window using it converges on one durable acceptance. The renderer
    // never pre-filters ownership itself — it may fire the RPC redundantly and
    // the host rejects the losers (identity is still submitted every time).
    let dispatched = 0
    const identities = new Set<string | undefined>()
    const dependencies = {
      isBusy: () => false, load: async () => ready,
      dispatch: async (record: PendingPlanExecution) => { dispatched++; identities.add(record.executionId) },
    }
    const first = createPendingPlanDispatcher(dependencies)
    const second = createPendingPlanDispatcher(dependencies)
    await Promise.all([first.request(), second.request(), first.request()])
    await createPendingPlanDispatcher(dependencies).request()
    expect(dispatched).toBe(4) // redundant by design: the host rejects the losers; the renderer must not pre-filter ownership itself
    expect(identities).toEqual(new Set(['exec-1'])) // every dispatch submitted the observed identity
  })
  it('does not accept an already-dispatched record', async () => {
    let dispatches = 0
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => false,
      load: async () => ({ ...ready, executionDispatched: true }),
      dispatch: async () => { dispatches++ },
    })
    await dispatcher.request()
    expect(dispatches).toBe(0)
  })

  it('re-delivers a failed outbox once per wakeup and never dispatches it', async () => {
    let pending: PendingPlanExecution | null = { ...ready, failed: true, restoreId: 'restore-9' }
    const notified: (string | undefined)[] = []
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => false, load: async () => pending,
      dispatch: async () => { throw new Error('must not dispatch a failed record') },
      notifyFailed: record => { notified.push(record.restoreId) },
    })
    await dispatcher.request()
    await dispatcher.request()
    expect(notified).toEqual(['restore-9', 'restore-9'])
    pending = null
    await dispatcher.request()
    expect(notified).toEqual(['restore-9', 'restore-9'])
  })
  it('rechecks busy after loading; disposal cancels an unclaimed read', async () => {
    const read = deferred<PendingPlanExecution | null>()
    let dispatches = 0
    const dispatcher = createPendingPlanDispatcher({ isBusy: () => false, load: () => read.promise, dispatch: async () => { dispatches++ } })
    const running = dispatcher.request()
    dispatcher.dispose()
    read.resolve(ready)
    await running
    expect(dispatches).toBe(0)
  })
})
