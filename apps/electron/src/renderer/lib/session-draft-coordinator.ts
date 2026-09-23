import type { Reference } from '@craft-agent/core'
import type {
  DraftAttachmentRef,
  SessionDraft,
  SessionDraftHydrationState,
} from '@craft-agent/shared/config'
import type { ElectronAPI } from '../../shared/types'
import type { Effect } from '../event-processor'
import { coerceInputText } from './input-text'
import {
  addSessionDraftReference,
  applyQueuedInputRestore,
  mergeAuthoritativeSessionDraftReferences,
  mergeHydratedSessionDrafts,
  restoreSessionDraftContent,
  setSessionDraftAttachments,
  setSessionDraftReferences,
  setSessionDraftText,
} from './reference-draft'

type RestoreInputEffect = Extract<Effect, { type: 'restore_input' }>

export type SessionDraftPersistence = Pick<
  ElectronAPI,
  | 'setDraftContent'
  | 'updateDraftReferences'
  | 'addDraftReference'
  | 'restoreDraftInput'
  | 'acknowledgeQueuedInputRestore'
>

interface SessionDraftCoordinatorOptions {
  persistence: SessionDraftPersistence
  getProjectId: (sessionId: string) => string | undefined
  onReferencesChanged?: (sessionId: string, references: Reference[]) => void
  onAttachmentsChanged?: (sessionId: string) => void
  onTextRestored?: (sessionId: string, text: string) => void
  warn?: (message: string, detail: Record<string, unknown>) => void
  debounceMs?: number
}

export interface DraftHydrationHandle {
  readonly workspaceId: string | null
  readonly generation: number
  readonly promise: Promise<void>
  readonly resolve: () => void
}

export interface DeferredDraftRestore {
  workspaceId: string | null
  sessionId: string
  effect: RestoreInputEffect
}

const DEFAULT_DEBOUNCE_MS = 500

export class SessionDraftCoordinator {
  private drafts = new Map<string, SessionDraft>()
  private readonly contentTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly referenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly referenceBases = new Map<string, Reference[]>()
  private readonly persistedReferences = new Map<string, Reference[]>()
  private readonly pendingReferenceBroadcasts = new Map<string, Reference[]>()
  private readonly mutationVersions = new Map<string, number>()
  private readonly mutatedSessionIds = new Set<string>()
  private readonly draftTasks = new Set<Promise<unknown>>()
  private readonly browserTasks = new Map<Promise<unknown>, AbortController>()
  private deferredRestores: DeferredDraftRestore[] = []
  private hydrationGeneration = 0
  private workspaceGeneration = 0
  private hydratedWorkspaceId: string | null = null
  private hydrationGate: DraftHydrationHandle | null = null
  private restoreAdmissionOpen = true
  private browserAdmissionOpen = true
  private readonly persistence: SessionDraftPersistence
  private readonly getProjectId: (sessionId: string) => string | undefined
  private readonly onReferencesChanged: (sessionId: string, references: Reference[]) => void
  private readonly onAttachmentsChanged: (sessionId: string) => void
  private readonly onTextRestored: (sessionId: string, text: string) => void
  private readonly warn: (message: string, detail: Record<string, unknown>) => void
  private readonly debounceMs: number

  constructor({
    persistence,
    getProjectId,
    onReferencesChanged = () => {},
    onAttachmentsChanged = () => {},
    onTextRestored = () => {},
    warn = (message, detail) => console.warn(message, detail),
    debounceMs = DEFAULT_DEBOUNCE_MS,
  }: SessionDraftCoordinatorOptions) {
    this.persistence = persistence
    this.getProjectId = getProjectId
    this.onReferencesChanged = onReferencesChanged
    this.onAttachmentsChanged = onAttachmentsChanged
    this.onTextRestored = onTextRestored
    this.warn = warn
    this.debounceMs = debounceMs
  }

  getDraft(sessionId: string): SessionDraft | undefined {
    return this.drafts.get(sessionId)
  }

  getText(sessionId: string): string {
    const draft = this.drafts.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }

  getAttachmentRefs(sessionId: string): DraftAttachmentRef[] {
    const attachments = this.drafts.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }

  getReferences(sessionId: string): Reference[] {
    const references = this.drafts.get(sessionId)?.references
    return Array.isArray(references) ? references : []
  }

  hasDraft(sessionId: string): boolean {
    const draft = this.drafts.get(sessionId)
    return Boolean(
      draft?.text
      || draft?.attachments?.length
      || draft?.references?.length,
    )
  }

  setDraft(sessionId: string, draft: SessionDraft | null): void {
    this.markMutation(sessionId)
    this.assignDraft(sessionId, draft)
  }

  clearSession(sessionId: string): void {
    this.clearTimer(this.contentTimers, sessionId)
    this.clearTimer(this.referenceTimers, sessionId)
    this.referenceBases.delete(sessionId)
    this.persistedReferences.delete(sessionId)
    this.pendingReferenceBroadcasts.delete(sessionId)
    this.mutationVersions.delete(sessionId)
    this.markMutation(sessionId)
    this.drafts.delete(sessionId)
  }

  updateText(sessionId: string, value: string): void {
    this.setDraft(
      sessionId,
      setSessionDraftText(this.drafts.get(sessionId), coerceInputText(value)),
    )
    this.scheduleContentPersistence(sessionId)
  }

  updateAttachments(sessionId: string, attachments: DraftAttachmentRef[]): void {
    this.setDraft(
      sessionId,
      setSessionDraftAttachments(this.drafts.get(sessionId), attachments),
    )
    this.scheduleContentPersistence(sessionId)
  }

  replaceReferences(sessionId: string, references: Reference[]): boolean {
    const projectId = this.getProjectId(sessionId)
    if (!projectId) return false
    const existing = this.drafts.get(sessionId)
    const next = setSessionDraftReferences(existing, projectId, references)
    if (!next && references.length > 0) return false
    this.setDraft(sessionId, next)
    this.scheduleReferencePersistence(sessionId, existing?.references ?? [])
    this.onReferencesChanged(sessionId, next?.references ?? [])
    return true
  }

  addReference(sessionId: string, reference: Reference): boolean {
    const projectId = this.getProjectId(sessionId)
    if (!projectId) return false
    const existing = this.drafts.get(sessionId)
    const next = addSessionDraftReference(existing, projectId, reference)
    if (!next) return false
    this.setDraft(sessionId, next)
    this.scheduleReferencePersistence(sessionId, existing?.references ?? [])
    this.onReferencesChanged(sessionId, next.references ?? [])
    return true
  }

  async addBrowserReference(
    sessionId: string,
    reference: Reference,
    requestId: string,
  ): Promise<boolean> {
    if (!this.browserAdmissionOpen) return false
    const projectId = this.getProjectId(sessionId)
    if (!projectId || projectId !== reference.projectId) return false

    return this.runDraftTask(async generation => {
      const before = this.drafts.get(sessionId)
      const confirmedBefore = this.persistedReferences.get(sessionId) ?? []
      if (!addSessionDraftReference(before, projectId, reference)) return false
      const persisted = await this.persistence.addDraftReference(
        sessionId,
        reference,
        requestId,
      )
      if (!persisted || this.workspaceGeneration !== generation) return false

      const authoritative = persisted.references ?? []
      this.persistedReferences.set(sessionId, authoritative)
      if (this.referenceBases.has(sessionId)) {
        this.referenceBases.set(sessionId, authoritative)
      }
      const latest = this.drafts.get(sessionId)
      const mergeResult = mergeAuthoritativeSessionDraftReferences(
        latest,
        projectId,
        confirmedBefore,
        authoritative,
      )
      if (!mergeResult.ok) {
        const reconciled = await this.persistence.updateDraftReferences(sessionId, {
          baseReferences: authoritative,
          nextReferences: latest?.references ?? [],
        })
        this.persistedReferences.set(sessionId, reconciled?.references ?? [])
        return false
      }

      const next: SessionDraft = mergeResult.draft ?? {
        text: latest?.text ?? '',
        ...(latest?.attachments?.length ? { attachments: latest.attachments } : {}),
        ...(authoritative.length ? { references: authoritative } : {}),
      }
      this.setDraft(sessionId, next)
      this.onReferencesChanged(sessionId, next.references ?? [])
      return true
    })
  }

  beginHydration(workspaceId: string | null): DraftHydrationHandle {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    const handle = {
      workspaceId,
      generation: this.hydrationGeneration,
      promise,
      resolve,
    }
    this.hydrationGate = handle
    return handle
  }

  hydrate(
    handle: DraftHydrationHandle,
    state: SessionDraftHydrationState,
  ): string[] | null {
    if (
      this.hydrationGate !== handle
      || this.hydrationGeneration !== handle.generation
    ) return null

    const { drafts, hydratedSessionIds } = mergeHydratedSessionDrafts(
      this.drafts,
      state.drafts,
      this.mutatedSessionIds,
    )
    this.drafts = drafts
    this.persistedReferences.clear()
    for (const [sessionId, draft] of Object.entries(state.drafts)) {
      this.persistedReferences.set(sessionId, draft.references ?? [])
    }
    for (const [sessionId, authoritative] of this.pendingReferenceBroadcasts) {
      if (this.applyAuthoritativeReferences(sessionId, authoritative)) {
        if (!hydratedSessionIds.includes(sessionId)) hydratedSessionIds.push(sessionId)
      }
    }
    this.pendingReferenceBroadcasts.clear()
    for (const sessionId of hydratedSessionIds) {
      this.onReferencesChanged(sessionId, this.getReferences(sessionId))
    }
    this.hydratedWorkspaceId = handle.workspaceId
    handle.resolve()
    return hydratedSessionIds
  }

  cancelHydration(handle: DraftHydrationHandle): void {
    if (this.hydratedWorkspaceId === handle.workspaceId) {
      this.hydratedWorkspaceId = null
    }
    this.pendingReferenceBroadcasts.clear()
    if (this.hydrationGate === handle) this.hydrationGate = null
    handle.resolve()
  }

  isHydrated(workspaceId: string | null): boolean {
    return this.hydratedWorkspaceId === workspaceId
  }

  refreshHydratedDrafts(
    workspaceId: string | null,
    state: SessionDraftHydrationState,
  ): void {
    if (!this.isHydrated(workspaceId)) return
    const sessionIds = new Set([
      ...this.persistedReferences.keys(),
      ...Object.keys(state.drafts),
    ])
    for (const sessionId of sessionIds) {
      const projectId = this.getProjectId(sessionId)
      if (!projectId) continue
      const remoteDraft = state.drafts[sessionId]
      const localDraft = this.drafts.get(sessionId)
      const authoritative = remoteDraft?.references ?? []
      const mergeResult = mergeAuthoritativeSessionDraftReferences(
        localDraft,
        projectId,
        this.persistedReferences.get(sessionId) ?? [],
        authoritative,
      )
      if (!mergeResult.ok) continue
      const next = localDraft ? mergeResult.draft : remoteDraft ?? mergeResult.draft
      this.assignDraft(sessionId, next)
      this.persistedReferences.set(sessionId, authoritative)
      this.onReferencesChanged(sessionId, next?.references ?? [])
    }
  }

  receiveAuthoritativeReferences(
    workspaceId: string | null,
    sessionId: string,
    references: Reference[],
  ): void {
    if (!this.isHydrated(workspaceId)) {
      this.pendingReferenceBroadcasts.set(sessionId, references)
      return
    }
    this.applyAuthoritativeReferences(sessionId, references)
  }

  deferRestore(
    workspaceId: string | null,
    sessionId: string,
    effect: RestoreInputEffect,
  ): boolean {
    if (this.restoreAdmissionOpen) return false
    const duplicate = Boolean(effect.queuedRestoreId) && this.deferredRestores.some(pending => (
      pending.workspaceId === workspaceId
      && pending.sessionId === sessionId
      && pending.effect.queuedRestoreId === effect.queuedRestoreId
    ))
    if (!duplicate) this.deferredRestores.push({ workspaceId, sessionId, effect })
    return true
  }

  takeDeferredRestores(workspaceId: string | null): DeferredDraftRestore[] {
    const ready = this.deferredRestores.filter(pending => pending.workspaceId === workspaceId)
    this.deferredRestores = this.deferredRestores.filter(
      pending => pending.workspaceId !== workspaceId,
    )
    return ready
  }

  async restoreInput(
    workspaceId: string | null,
    sessionId: string,
    projectId: string | undefined,
    effect: RestoreInputEffect,
  ): Promise<SessionDraft | null> {
    return this.runDraftTask(async generation => {
      if (!await this.waitForHydration(workspaceId, generation)) return null
      const restoredInput: SessionDraft = {
        text: coerceInputText(effect.text),
        ...(effect.references?.length ? { references: effect.references } : {}),
        ...(effect.attachments?.length ? { attachments: effect.attachments } : {}),
      }
      const confirmedBefore = this.drafts.get(sessionId) ?? null
      const pendingContentTimer = this.contentTimers.get(sessionId)
      const pendingReferenceTimer = this.referenceTimers.get(sessionId)
      const pendingReferenceBase = this.referenceBases.get(sessionId)
        ?? this.persistedReferences.get(sessionId)
        ?? []

      let restoredDraft: SessionDraft | null = null
      let finalReferenceBase = confirmedBefore?.references ?? []
      try {
        if (effect.queuedRestoreId) {
          if (pendingContentTimer) {
            await this.persistence.setDraftContent(sessionId, {
              text: confirmedBefore?.text ?? '',
              ...(confirmedBefore?.attachments?.length
                ? { attachments: confirmedBefore.attachments }
                : {}),
            })
            if (this.workspaceGeneration !== generation) return null
            if (this.contentTimers.get(sessionId) === pendingContentTimer) {
              this.clearTimer(this.contentTimers, sessionId)
            }
          }
          if (pendingReferenceTimer) {
            const flushed = await this.persistence.updateDraftReferences(sessionId, {
              baseReferences: pendingReferenceBase,
              nextReferences: confirmedBefore?.references ?? [],
            })
            if (this.workspaceGeneration !== generation) return null
            const authoritative = flushed?.references ?? []
            this.persistedReferences.set(sessionId, authoritative)
            if (this.referenceTimers.get(sessionId) === pendingReferenceTimer) {
              this.clearTimer(this.referenceTimers, sessionId)
              this.referenceBases.delete(sessionId)
            } else if (this.referenceTimers.has(sessionId)) {
              this.referenceBases.set(sessionId, authoritative)
            }
          }

          const persisted = await this.persistence.restoreDraftInput(sessionId, {
            restoreId: effect.queuedRestoreId,
            draft: restoredInput,
          })
          if (this.workspaceGeneration !== generation) return null
          finalReferenceBase = persisted.draft?.references ?? []
          this.persistedReferences.set(sessionId, finalReferenceBase)
          const restoreResult = applyQueuedInputRestore(
            this.drafts.get(sessionId),
            confirmedBefore,
            persisted.draft,
            projectId,
          )
          if (!restoreResult.ok) {
            throw new Error('Queued input restoration exceeded reference boundaries')
          }
          restoredDraft = restoreResult.draft
          if (!restoredDraft) {
            throw new Error('Queued input restoration produced an empty draft')
          }
        } else {
          const restoreResult = restoreSessionDraftContent(
            confirmedBefore,
            projectId,
            restoredInput.text,
            restoredInput.references ?? [],
            restoredInput.attachments ?? [],
          )
          if (!restoreResult.ok) {
            throw new Error('Queued input restoration exceeded reference boundaries')
          }
          restoredDraft = restoreResult.draft
        }

        if (restoredDraft) {
          this.setDraft(sessionId, restoredDraft)
          this.scheduleContentPersistence(sessionId)
          this.scheduleReferencePersistence(sessionId, finalReferenceBase)
          const finalContentTimer = this.contentTimers.get(sessionId)
          const finalReferenceTimer = this.referenceTimers.get(sessionId)
          const [, persistedReferences] = await Promise.all([
            this.persistence.setDraftContent(sessionId, {
              text: restoredDraft.text,
              ...(restoredDraft.attachments?.length
                ? { attachments: restoredDraft.attachments }
                : {}),
            }),
            this.persistence.updateDraftReferences(sessionId, {
              baseReferences: finalReferenceBase,
              nextReferences: restoredDraft.references ?? [],
            }),
          ])
          const authoritative = persistedReferences?.references ?? []
          this.persistedReferences.set(sessionId, authoritative)
          if (this.contentTimers.get(sessionId) === finalContentTimer) {
            this.clearTimer(this.contentTimers, sessionId)
          }
          if (this.referenceTimers.get(sessionId) === finalReferenceTimer) {
            this.clearTimer(this.referenceTimers, sessionId)
            this.referenceBases.delete(sessionId)
          } else if (this.referenceTimers.has(sessionId)) {
            this.referenceBases.set(sessionId, authoritative)
          }
        }

        if (effect.queuedRestoreId && effect.messageIds?.length) {
          await this.persistence.acknowledgeQueuedInputRestore(
            sessionId,
            effect.queuedRestoreId,
            effect.messageIds,
          )
        }
        return restoredDraft
      } finally {
        if (restoredDraft) {
          this.onTextRestored(sessionId, this.getText(sessionId))
          this.onReferencesChanged(sessionId, this.getReferences(sessionId))
          this.onAttachmentsChanged(sessionId)
        }
      }
    })
  }

  runBrowserSelectionTask<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.browserAdmissionOpen) {
      return Promise.reject(
        new Error('Browser selection is unavailable while switching Workspace'),
      )
    }
    const controller = new AbortController()
    let task: Promise<T>
    try {
      task = Promise.resolve(operation(controller.signal))
    } catch (error) {
      task = Promise.reject(error)
    }
    this.browserTasks.set(task, controller)
    void task.finally(() => {
      this.browserTasks.delete(task)
    }).catch(() => {})
    return task
  }

  beginWorkspaceTransition(): void {
    this.restoreAdmissionOpen = false
    this.browserAdmissionOpen = false
    for (const controller of this.browserTasks.values()) controller.abort()
    this.hydrationGate?.resolve()
  }

  rollbackWorkspaceTransition(): void {
    this.restoreAdmissionOpen = true
    this.browserAdmissionOpen = true
  }

  openAdmissions(): void {
    this.restoreAdmissionOpen = true
    this.browserAdmissionOpen = true
  }

  async flushForWorkspaceSwitch(workspaceId: string | null): Promise<void> {
    while (true) {
      const deferred = this.takeDeferredRestores(workspaceId)
      if (deferred.length > 0) {
        const results = await Promise.allSettled(deferred.map(pending => this.restoreInput(
          workspaceId,
          pending.sessionId,
          this.getProjectId(pending.sessionId),
          pending.effect,
        )))
        const failed = deferred.filter((_, index) => results[index]?.status === 'rejected')
        if (failed.length > 0) {
          this.deferredRestores.unshift(...failed)
          const failure = results.find(result => result.status === 'rejected')
          throw failure?.status === 'rejected' ? failure.reason : new Error('Draft restore failed')
        }
      }
      await this.waitForTasks()
      await this.flushPendingTimers()
      await this.waitForTasks()
      if (
        !this.deferredRestores.some(pending => pending.workspaceId === workspaceId)
        && this.draftTasks.size === 0
        && this.browserTasks.size === 0
        && this.contentTimers.size === 0
        && this.referenceTimers.size === 0
      ) return
    }
  }

  finishWorkspaceTransition(): void {
    this.workspaceGeneration += 1
  }

  resetForWorkspace(): void {
    this.hydrationGeneration += 1
    this.contentTimers.forEach(clearTimeout)
    this.contentTimers.clear()
    this.referenceTimers.forEach(clearTimeout)
    this.referenceTimers.clear()
    this.referenceBases.clear()
    this.persistedReferences.clear()
    this.pendingReferenceBroadcasts.clear()
    this.mutationVersions.clear()
    this.drafts.clear()
    this.mutatedSessionIds.clear()
    this.hydratedWorkspaceId = null
    this.hydrationGate = null
  }

  dispose(): void {
    this.beginWorkspaceTransition()
    this.contentTimers.forEach(clearTimeout)
    this.contentTimers.clear()
    this.referenceTimers.forEach(clearTimeout)
    this.referenceTimers.clear()
    this.referenceBases.clear()
  }

  private markMutation(sessionId: string): void {
    this.mutatedSessionIds.add(sessionId)
    this.mutationVersions.set(
      sessionId,
      (this.mutationVersions.get(sessionId) ?? 0) + 1,
    )
  }

  private assignDraft(sessionId: string, draft: SessionDraft | null | undefined): void {
    if (draft) this.drafts.set(sessionId, draft)
    else this.drafts.delete(sessionId)
  }

  private clearTimer(
    timers: Map<string, ReturnType<typeof setTimeout>>,
    sessionId: string,
  ): void {
    const timer = timers.get(sessionId)
    if (timer) clearTimeout(timer)
    timers.delete(sessionId)
  }

  private scheduleContentPersistence(sessionId: string): void {
    this.clearTimer(this.contentTimers, sessionId)
    const scheduleWrite = () => {
      const timer = setTimeout(() => {
        const task = this.runDraftTask(async () => {
          const draft = this.drafts.get(sessionId) ?? { text: '' }
          await this.persistence.setDraftContent(sessionId, {
            text: draft.text,
            ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
          })
          if (this.contentTimers.get(sessionId) === timer) {
            this.contentTimers.delete(sessionId)
          }
        })
        void task.catch(error => {
          this.warn('[drafts] Failed to persist draft content; retrying', {
            sessionId,
            error,
          })
          if (this.contentTimers.get(sessionId) === timer) scheduleWrite()
        })
      }, this.debounceMs)
      this.contentTimers.set(sessionId, timer)
    }
    scheduleWrite()
  }

  private scheduleReferencePersistence(
    sessionId: string,
    baseReferences: Reference[],
  ): void {
    if (!this.referenceBases.has(sessionId)) {
      this.referenceBases.set(
        sessionId,
        this.persistedReferences.get(sessionId) ?? baseReferences,
      )
    }
    this.clearTimer(this.referenceTimers, sessionId)
    const scheduleWrite = () => {
      const timer = setTimeout(() => {
        const task = this.runDraftTask(async () => {
          const base = this.referenceBases.get(sessionId) ?? []
          const persisted = await this.persistence.updateDraftReferences(sessionId, {
            baseReferences: base,
            nextReferences: this.getReferences(sessionId),
          })
          const authoritative = persisted?.references ?? []
          if (this.referenceTimers.get(sessionId) === timer) {
            this.referenceTimers.delete(sessionId)
            this.referenceBases.delete(sessionId)
          } else if (this.referenceTimers.has(sessionId)) {
            this.referenceBases.set(sessionId, authoritative)
          }

          const projectId = this.getProjectId(sessionId)
          if (!projectId) return
          this.persistedReferences.set(sessionId, authoritative)
          const mergeResult = mergeAuthoritativeSessionDraftReferences(
            this.drafts.get(sessionId),
            projectId,
            base,
            authoritative,
          )
          if (!mergeResult.ok) {
            const reconciled = await this.persistence.updateDraftReferences(sessionId, {
              baseReferences: authoritative,
              nextReferences: this.getReferences(sessionId),
            })
            this.persistedReferences.set(sessionId, reconciled?.references ?? [])
            return
          }
          this.assignDraft(sessionId, mergeResult.draft)
          this.onReferencesChanged(sessionId, mergeResult.draft?.references ?? [])
        })
        void task.catch(error => {
          this.warn('[drafts] Failed to persist draft references; retrying', {
            sessionId,
            error,
          })
          if (this.referenceTimers.get(sessionId) === timer) scheduleWrite()
        })
      }, this.debounceMs)
      this.referenceTimers.set(sessionId, timer)
    }
    scheduleWrite()
  }

  private applyAuthoritativeReferences(
    sessionId: string,
    authoritative: Reference[],
  ): boolean {
    const projectId = this.getProjectId(sessionId)
    if (!projectId || authoritative.some(reference => reference.projectId !== projectId)) {
      return false
    }
    const mergeResult = mergeAuthoritativeSessionDraftReferences(
      this.drafts.get(sessionId),
      projectId,
      this.persistedReferences.get(sessionId) ?? [],
      authoritative,
    )
    this.persistedReferences.set(sessionId, authoritative)
    if (this.referenceBases.has(sessionId)) {
      this.referenceBases.set(sessionId, authoritative)
    }
    if (!mergeResult.ok) {
      void this.runDraftTask(async () => {
        const reconciled = await this.persistence.updateDraftReferences(sessionId, {
          baseReferences: authoritative,
          nextReferences: this.getReferences(sessionId),
        })
        this.persistedReferences.set(sessionId, reconciled?.references ?? [])
      }).catch(error => {
        this.warn('[drafts] Failed to resolve broadcast reference limit', {
          sessionId,
          error,
        })
      })
      return false
    }
    this.assignDraft(sessionId, mergeResult.draft)
    this.onReferencesChanged(sessionId, mergeResult.draft?.references ?? [])
    return true
  }

  private runDraftTask<T>(
    operation: (generation: number) => Promise<T>,
  ): Promise<T> {
    const generation = this.workspaceGeneration
    let task: Promise<T>
    try {
      task = Promise.resolve(operation(generation))
    } catch (error) {
      task = Promise.reject(error)
    }
    this.draftTasks.add(task)
    void task.finally(() => {
      this.draftTasks.delete(task)
    }).catch(() => {})
    return task
  }

  private async waitForHydration(
    workspaceId: string | null,
    generation: number,
  ): Promise<boolean> {
    const gate = this.hydrationGate
    if (gate?.workspaceId === workspaceId) {
      await gate.promise
      if (this.hydrationGate !== gate) return false
    }
    return this.workspaceGeneration === generation
  }

  private async waitForTasks(): Promise<void> {
    while (this.draftTasks.size > 0 || this.browserTasks.size > 0) {
      await Promise.allSettled([
        ...this.draftTasks,
        ...this.browserTasks.keys(),
      ])
    }
  }

  private async flushPendingTimers(): Promise<void> {
    while (true) {
      const sessionIds = new Set([
        ...this.contentTimers.keys(),
        ...this.referenceTimers.keys(),
      ])
      if (sessionIds.size === 0) return
      const versions = new Map([...sessionIds].map(sessionId => (
        [sessionId, this.mutationVersions.get(sessionId) ?? 0] as const
      )))

      await Promise.all([...sessionIds].map(async sessionId => {
        const draft = this.drafts.get(sessionId) ?? { text: '' }
        const operations: Promise<unknown>[] = []
        if (this.contentTimers.has(sessionId)) {
          operations.push(this.persistence.setDraftContent(sessionId, {
            text: draft.text,
            ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
          }))
        }
        if (this.referenceTimers.has(sessionId)) {
          operations.push(this.persistence.updateDraftReferences(sessionId, {
            baseReferences: this.referenceBases.get(sessionId)
              ?? this.persistedReferences.get(sessionId)
              ?? [],
            nextReferences: draft.references ?? [],
          }).then(persisted => {
            this.persistedReferences.set(sessionId, persisted?.references ?? [])
          }))
        }
        await Promise.all(operations)
      }))

      const stable = [...versions].every(([sessionId, version]) => (
        (this.mutationVersions.get(sessionId) ?? 0) === version
      ))
      if (!stable) continue
      for (const sessionId of sessionIds) {
        this.clearTimer(this.contentTimers, sessionId)
        this.clearTimer(this.referenceTimers, sessionId)
        this.referenceBases.delete(sessionId)
      }
      return
    }
  }
}
