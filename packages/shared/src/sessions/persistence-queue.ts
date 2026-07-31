import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  projectId?: string
  projectNoteTargetPath?: string
  projectNoteTargetRootFingerprint?: string
  projectNoteRecentTargetPaths?: string[]
  hasUnread?: boolean
  lastReadMessageId?: string
}

const HEADER_METADATA_KEYS = [
  'name',
  'labels',
  'isFlagged',
  'sessionStatus',
  'permissionMode',
  'projectId',
  'projectNoteTargetPath',
  'projectNoteTargetRootFingerprint',
  'projectNoteRecentTargetPaths',
  'hasUnread',
  'lastReadMessageId',
] as const satisfies ReadonlyArray<keyof HeaderMetadataSignature>

type HeaderMetadataKey = typeof HEADER_METADATA_KEYS[number]

const PROJECT_ROUTING_KEYS = [
  'projectId',
  'projectNoteTargetPath',
  'projectNoteTargetRootFingerprint',
  'projectNoteRecentTargetPaths',
] as const satisfies ReadonlyArray<HeaderMetadataKey>

// These fields have dedicated in-process state machines and are not reconciled
// by SessionManager's external-header handler. Keep the local value so disk and
// runtime cannot silently diverge after an unrelated metadata write.
const LOCAL_RUNTIME_METADATA_KEYS = [
  'permissionMode',
  'hasUnread',
  'lastReadMessageId',
] as const satisfies ReadonlyArray<HeaderMetadataKey>

export type SessionMetadataWriteAuthority =
  | 'project-binding'
  | 'project-binding-if-current'
  | 'project-note-routing'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
  authority?: SessionMetadataWriteAuthority
}

function getHeaderMetadata(
  header: HeaderMetadataSignature,
): HeaderMetadataSignature {
  return {
    name: header.name,
    labels: header.labels ? [...header.labels] : undefined,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    projectId: header.projectId,
    projectNoteTargetPath: header.projectNoteTargetPath,
    projectNoteTargetRootFingerprint: header.projectNoteTargetRootFingerprint,
    projectNoteRecentTargetPaths: header.projectNoteRecentTargetPaths
      ? [...header.projectNoteRecentTargetPaths]
      : undefined,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
}

function getHeaderMetadataSignature(header: HeaderMetadataSignature): string {
  return JSON.stringify(getHeaderMetadata(header))
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    projectId: diskHeader.projectId,
    projectNoteTargetPath: diskHeader.projectNoteTargetPath,
    projectNoteTargetRootFingerprint:
      diskHeader.projectNoteTargetRootFingerprint,
    projectNoteRecentTargetPaths: diskHeader.projectNoteRecentTargetPaths,
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
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private lastObservedHeaderMetadata =
    new Map<string, HeaderMetadataSignature>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(
    session: StoredSession,
    authority?: SessionMetadataWriteAuthority,
  ): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void this.flush(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, {
      data: session,
      timer,
      authority: authority === 'project-binding'
        || existing?.authority === 'project-binding'
        ? 'project-binding'
        : authority ?? existing?.authority,
    })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(
    sessionId: string,
    data: StoredSession,
    authority?: SessionMetadataWriteAuthority,
  ): Promise<{
    localHeader: SessionHeader
    persistedHeader: SessionHeader
  } | null> {
    try {
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
      const baseline = this.lastObservedHeaderMetadata.get(sessionId)
      const previousSig = baseline
        ? getHeaderMetadataSignature(baseline)
        : undefined
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch =
        !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange =
        !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      let header = localHeader
      if (hasExternalMetadataChange && diskHeader && baseline) {
        header = { ...localHeader }
        const diskProjectChanged =
          diskHeader.projectId !== baseline.projectId
        const preserveLocalRouting =
          authority === 'project-binding'
          || (
            (
              authority === 'project-binding-if-current'
              // This authority is reserved for invalidation after the canonical
              // Project root changes, so every route under that Project is stale.
              || authority === 'project-note-routing'
            )
            && !diskProjectChanged
          )
        const routingChangedOnDisk = PROJECT_ROUTING_KEYS.some(key =>
          JSON.stringify(diskHeader[key])
          !== JSON.stringify(baseline[key]))

        for (const key of HEADER_METADATA_KEYS) {
          if (PROJECT_ROUTING_KEYS.includes(
            key as typeof PROJECT_ROUTING_KEYS[number],
          )) {
            if (routingChangedOnDisk && !preserveLocalRouting) {
              ;(header as unknown as Record<string, unknown>)[key] =
                diskHeader[key]
            }
            continue
          }
          if (LOCAL_RUNTIME_METADATA_KEYS.includes(
            key as typeof LOCAL_RUNTIME_METADATA_KEYS[number],
          )) {
            continue
          }
          if (
            JSON.stringify(diskHeader[key])
            !== JSON.stringify(baseline[key])
          ) {
            ;(header as unknown as Record<string, unknown>)[key] =
              diskHeader[key]
          }
        }
      }

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

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      await rename(tmpFile, filePath)
      this.lastObservedHeaderMetadata.set(
        sessionId,
        getHeaderMetadata(header),
      )
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
      return {
        localHeader,
        persistedHeader: header,
      }
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
      return null
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    while (true) {
      const pending = this.pending.get(sessionId)
      if (pending) clearTimeout(pending.timer)

      let activeWrite = this.writeInProgress.get(sessionId)
      if (!activeWrite && pending) {
        let drainPromise: Promise<void>
        drainPromise = Promise.resolve()
          .then(async () => {
            while (true) {
              const next = this.pending.get(sessionId)
              if (!next) return

              clearTimeout(next.timer)
              this.pending.delete(sessionId)
              const result = await this.write(
                sessionId,
                next.data,
                next.authority,
              )
              const queuedAfterWrite = this.pending.get(sessionId)
              if (!result || !queuedAfterWrite) continue

              const queuedHeader = createSessionHeader(queuedAfterWrite.data)
              const nextData = { ...queuedAfterWrite.data }
              const localRouting = PROJECT_ROUTING_KEYS.map(
                key => result.localHeader[key],
              )
              const queuedRouting = PROJECT_ROUTING_KEYS.map(
                key => queuedHeader[key],
              )
              const externalScopeChanged =
                result.persistedHeader.projectId
                  !== result.localHeader.projectId
                || result.persistedHeader.projectNoteTargetRootFingerprint
                  !== result.localHeader.projectNoteTargetRootFingerprint
              const queuedScopeIsStale =
                queuedHeader.projectId === result.localHeader.projectId
                && queuedHeader.projectNoteTargetRootFingerprint
                  === result.localHeader.projectNoteTargetRootFingerprint
              if (
                JSON.stringify(queuedRouting) === JSON.stringify(localRouting)
                || (
                  externalScopeChanged
                  && queuedScopeIsStale
                )
              ) {
                for (const key of PROJECT_ROUTING_KEYS) {
                  ;(nextData as unknown as Record<string, unknown>)[key] =
                    result.persistedHeader[key]
                }
              }
              for (const key of HEADER_METADATA_KEYS) {
                if (PROJECT_ROUTING_KEYS.includes(
                  key as typeof PROJECT_ROUTING_KEYS[number],
                )) {
                  continue
                }
                if (
                  JSON.stringify(queuedHeader[key])
                    === JSON.stringify(result.localHeader[key])
                  && JSON.stringify(result.persistedHeader[key])
                    !== JSON.stringify(result.localHeader[key])
                ) {
                  ;(nextData as unknown as Record<string, unknown>)[key] =
                    result.persistedHeader[key]
                }
              }
              queuedAfterWrite.data = nextData
            }
          })
          .finally(() => {
            if (this.writeInProgress.get(sessionId) === drainPromise) {
              this.writeInProgress.delete(sessionId)
            }
          })
        this.writeInProgress.set(sessionId, drainPromise)
        activeWrite = drainPromise
      }

      if (!activeWrite) return
      await activeWrite

      if (
        !this.pending.has(sessionId)
        && !this.writeInProgress.has(sessionId)
      ) {
        return
      }
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
    this.lastObservedHeaderMetadata.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
    ])
    await Promise.all([...sessionIds].map(id => this.flush(id)))
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
   * Record the header version that was loaded into memory. This gives the
   * first local write a baseline for detecting metadata changed by another
   * process after startup.
   */
  observeHeader(header: HeaderMetadataSignature & { id: string }): void {
    const metadata = getHeaderMetadata(header)
    this.lastWrittenHeaderSignature.set(
      header.id,
      getHeaderMetadataSignature(metadata),
    )
    this.lastObservedHeaderMetadata.set(header.id, metadata)
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
