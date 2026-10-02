import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 *
 * Error policy is deliberate: ordinary debounced writes are best-effort
 * (logged, never rejected — a transient IO failure must not take down event
 * processing), but callers that depend on durability (pending-plan claim,
 * handoff, and app shutdown) flush with `{ strict: true }`, which surfaces the
 * failure of the session's last write so the caller can keep its state
 * retryable instead of reporting success that disk never saw.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private writeErrors = new Map<string, { error: unknown; data: StoredSession }>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void this.write(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   *
   * All writes for one session — debounced or strict — are serialized through
   * `writeInProgress` so nothing interleaves on the shared .tmp file, even when
   * a strict flush races the debounce timer taking the pending entry.
   */
  private async write(sessionId: string, strict = false): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)
    clearTimeout(entry.timer)

    const previous = this.writeInProgress.get(sessionId)
    const run = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => this.performWrite(sessionId, entry))
    this.writeInProgress.set(sessionId, run)
    try {
      await run
    } catch (error) {
      if (!strict) {
        console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
        return
      }
      throw error
    } finally {
      if (this.writeInProgress.get(sessionId) === run) {
        this.writeInProgress.delete(sessionId)
      }
    }
  }

  private async performWrite(sessionId: string, entry: PendingWrite): Promise<void> {
    // Signature as it was before this attempt — restored on failure so a
    // failed write never makes the NEXT write mis-detect external metadata
    // changes against a signature that never reached disk.
    const priorSignature = this.lastWrittenHeaderSignature.get(sessionId)
    // Fixed temp name: writes for one session are serialized through
    // `writeInProgress`, so no two writers ever share this path.
    let tmpFile: string | undefined
    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g., generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Update signature BEFORE the write so that fs.watch events fired
      // during the rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions. Rolled back in the
      // catch below when the write never happened.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      // Atomic replacement: write the temp file, then `rename` over the
      // target — rename REPLACES the destination atomically (libuv uses
      // MoveFileEx(REPLACE_EXISTING) on Windows), so a failure at any point
      // leaves the previous valid session.jsonl untouched. The old
      // unlink-first dance destroyed the prior file when the rename failed,
      // which the durable atomic-handoff contract cannot tolerate.
      tmpFile = filePath + '.tmp'

      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await rename(tmpFile, filePath)
      tmpFile = undefined
      this.writeErrors.delete(sessionId)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      // Roll the self-write signature back: this attempt never reached disk.
      if (priorSignature === undefined) {
        this.lastWrittenHeaderSignature.delete(sessionId)
      } else {
        this.lastWrittenHeaderSignature.set(sessionId, priorSignature)
      }
      if (tmpFile !== undefined) {
        try { await unlink(tmpFile) } catch { /* temp already gone */ }
      }
      // Recorded even for best-effort callers: a strict flush that chained
      // behind this write (or arrived while it was in flight) must learn that
      // the session's newest persisted state is not on disk. STICKY until a
      // write actually succeeds or the session is explicitly cancelled —
      // never deleted merely because it was reported.
      this.writeErrors.set(sessionId, { error, data: entry.data })
      throw error
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   *
   * `{ strict: true }` rejects when the session's last known write failed —
   * including a failure of an in-flight best-effort write that had already
   * taken the pending entry — so durability-dependent callers never mistake a
   * swallowed IO error for success. Plain flush keeps the historical
   * best-effort contract.
   */
  async flush(sessionId: string, options?: { strict?: boolean }): Promise<void> {
    const strict = options?.strict === true
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      await this.write(sessionId, strict)
    } else {
      // No pending entry: our data may already be in the write that is in
      // progress — await it before judging durability. A plain flush keeps the
      // documented no-reject contract even when that in-flight write fails
      // (the failure stays recorded for strict callers).
      const inProgress = this.writeInProgress.get(sessionId)
      if (inProgress) {
        await (strict ? inProgress : inProgress.catch(() => {}))
      }
    }
    if (strict) await this.assertLastWriteSucceeded(sessionId)
  }

  /**
   * The last write failure is STICKY: it keeps rejecting strict flushes until
   * a write actually succeeds (performWrite clears it) or the session's queue
   * state is explicitly cancelled. Reporting never consumes it — otherwise a
   * caller that checked durability twice would see a false success the second
   * time while disk still never received the data.
   */
  private async assertLastWriteSucceeded(sessionId: string): Promise<void> {
    const failure = this.writeErrors.get(sessionId)
    if (failure) {
      throw failure.error
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   * Explicit cancellation also drops the sticky failure marker: the session's
   * queue state is being discarded, so there is nothing left to report.
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.writeErrors.delete(sessionId)
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Strict shutdown also retries failed snapshots
   * whose debounced writes already left the pending queue. A newer pending or
   * in-flight write always wins over the older failed snapshot.
   */
  async flushAll(options?: { strict?: boolean }): Promise<void> {
    if (options?.strict) {
      for (const [id, failure] of this.writeErrors) {
        if (!this.pending.has(id) && !this.writeInProgress.has(id)) {
          this.enqueue(failure.data)
        }
      }
    }
    const sessionIds = [...new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
      ...(options?.strict ? this.writeErrors.keys() : []),
    ])]
    await Promise.all(sessionIds.map(id => this.flush(id, options)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
