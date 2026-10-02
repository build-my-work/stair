import { referenceKey, type Reference } from '@craft-agent/core'
import type {
  DraftAttachmentRef,
  DraftContent,
  DraftContentMutation,
  PlanDraftConsumption,
  SessionDraft,
  SessionDraftHydrationState,
} from '@craft-agent/shared/config'
import { mergeDraftContent } from '@craft-agent/shared/config/draft-content'
import type { ElectronAPI } from '../../shared/types'
import type { Effect } from '../event-processor'
import { coerceInputText } from './input-text'
import {
  addSessionDraftReference,
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
> & Partial<Pick<ElectronAPI, 'sessionCommand'>>

interface SessionDraftCoordinatorOptions {
  persistence: SessionDraftPersistence
  getProjectId: (sessionId: string) => string | undefined
  onReferencesChanged?: (sessionId: string, references: Reference[]) => void
  onAttachmentsChanged?: (sessionId: string) => void
  onTextRestored?: (sessionId: string, text: string) => void
  onBeforeRestore?: (sessionId: string) => void
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
  private readonly contentWriterId = crypto.randomUUID()
  private contentSequence = 0
  private readonly textEditVersions = new Map<string, number>()
  private readonly confirmedContent = new Map<string, DraftContent>()
  private readonly serverRevisions = new Map<string, number>()
  private readonly contentTasks = new Map<string, Promise<unknown>>()
  private readonly pendingContentWrites = new Map<string, { content: DraftContent; mutation: DraftContentMutation; before: SessionDraft }>()
  private readonly pendingRestores = new Map<string, { content: DraftContent; mutation: DraftContentMutation; before: SessionDraft; restoreId: string; input: SessionDraft; planExecutionId?: string; messageIds?: string[] }>()
  private readonly pendingConsumptions = new Map<string, { content: DraftContent; mutation: DraftContentMutation; before: SessionDraft; textEditVersion: number; ownsConsumedPrefix: boolean; reenteredReferenceKeys: Set<string> }>()
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
  private readonly onBeforeRestore: (sessionId: string) => void
  private readonly warn: (message: string, detail: Record<string, unknown>) => void
  private readonly debounceMs: number

  constructor({
    persistence,
    getProjectId,
    onReferencesChanged = () => {},
    onAttachmentsChanged = () => {},
    onTextRestored = () => {},
    onBeforeRestore = () => {},
    warn = (message, detail) => console.warn(message, detail),
    debounceMs = DEFAULT_DEBOUNCE_MS,
  }: SessionDraftCoordinatorOptions) {
    this.persistence = persistence
    this.getProjectId = getProjectId
    this.onReferencesChanged = onReferencesChanged
    this.onAttachmentsChanged = onAttachmentsChanged
    this.onTextRestored = onTextRestored
    this.onBeforeRestore = onBeforeRestore
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
    const previousKeys = new Set(this.getReferences(sessionId).map(referenceKey))
    for (const [key, request] of this.pendingConsumptions) {
      if (!key.startsWith(`${sessionId}:`)) continue
      const capturedKeys = new Set((request.before.references ?? []).map(referenceKey))
      for (const reference of draft?.references ?? []) {
        const referenceId = referenceKey(reference)
        // Removing and adding the same quote is a new local operation. An
        // unchanged quote still belongs to the original consumption receipt.
        if (!previousKeys.has(referenceId) && capturedKeys.has(referenceId)) {
          request.reenteredReferenceKeys.add(referenceId)
        }
      }
    }
    this.markMutation(sessionId)
    this.assignDraft(sessionId, draft)
  }

  clearSession(sessionId: string): void {
    this.clearTimer(this.contentTimers, sessionId)
    this.clearTimer(this.referenceTimers, sessionId)
    this.referenceBases.delete(sessionId)
    this.persistedReferences.delete(sessionId)
    this.pendingReferenceBroadcasts.delete(sessionId)
    this.confirmedContent.delete(sessionId)
    this.serverRevisions.delete(sessionId)
    this.pendingContentWrites.delete(sessionId)
    this.textEditVersions.delete(sessionId)
    this.mutationVersions.delete(sessionId)
    this.markMutation(sessionId)
    this.drafts.delete(sessionId)
  }

  updateText(sessionId: string, value: string): void {
    const text = coerceInputText(value)
    for (const [key, request] of this.pendingConsumptions) {
      if (key.startsWith(`${sessionId}:`) && !text.startsWith(request.before.text)) request.ownsConsumedPrefix = false
    }
    if (this.getText(sessionId) !== text) {
      this.textEditVersions.set(sessionId, (this.textEditVersions.get(sessionId) ?? 0) + 1)
    }
    this.setDraft(
      sessionId,
      setSessionDraftText(this.drafts.get(sessionId), text),
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

    return this.runDraftTask(generation => this.serializeContentTask(sessionId, async () => {
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
    }))
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

    // The mounted composer may still own its last 300 ms of typing. Let it
    // publish only dirty input before deciding which disk drafts can hydrate.
    for (const sessionId of Object.keys(state.drafts)) this.onBeforeRestore(sessionId)
    const { drafts, hydratedSessionIds } = mergeHydratedSessionDrafts(
      this.drafts,
      state.drafts,
      this.mutatedSessionIds,
    )
    this.drafts = drafts
    // A dirty draft was edited against its earlier confirmed base, not against
    // the authority that just arrived. Preserve that base/version until its
    // next three-way commit; otherwise unseen restored input becomes a deletion.
    for (const sessionId of this.persistedReferences.keys()) {
      if (!this.mutatedSessionIds.has(sessionId)) this.persistedReferences.delete(sessionId)
    }
    for (const sessionId of this.confirmedContent.keys()) {
      if (!this.mutatedSessionIds.has(sessionId)) this.confirmedContent.delete(sessionId)
    }
    for (const sessionId of this.serverRevisions.keys()) {
      if (!this.mutatedSessionIds.has(sessionId)) this.serverRevisions.delete(sessionId)
    }
    for (const [sessionId, revision] of Object.entries(state.revisions ?? {})) {
      if (!this.mutatedSessionIds.has(sessionId)) this.serverRevisions.set(sessionId, revision)
    }
    for (const [sessionId, draft] of Object.entries(state.drafts)) {
      if (this.mutatedSessionIds.has(sessionId)) {
        const local = this.drafts.get(sessionId) ?? { text: '' }
        const content = mergeDraftContent(this.contentOf(draft), this.confirmedContent.get(sessionId) ?? { text: '' }, this.contentOf(local))
        const merged = mergeAuthoritativeSessionDraftReferences(
          { ...local, attachments: content.attachments }, this.getProjectId(sessionId) ?? '',
          this.persistedReferences.get(sessionId) ?? [], draft.references ?? [],
        )
        if (merged.ok) {
          this.assignDraft(sessionId, merged.draft)
          if (JSON.stringify(local.attachments ?? []) !== JSON.stringify(merged.draft?.attachments ?? [])
            || JSON.stringify(local.references ?? []) !== JSON.stringify(merged.draft?.references ?? [])) {
            hydratedSessionIds.push(sessionId)
          }
          // The edited text still has its earlier confirmed base/version.
          // Let its three-way host write incorporate unseen persisted text;
          // seeding that merged text here would apply the old prefix twice.
          this.scheduleContentPersistence(sessionId)
          this.scheduleReferencePersistence(sessionId, this.persistedReferences.get(sessionId) ?? [])
        }
        continue
      }
      this.persistedReferences.set(sessionId, draft.references ?? [])
      this.confirmedContent.set(sessionId, { text: draft.text, ...(draft.attachments?.length ? { attachments: draft.attachments } : {}) })
    }
    for (const [sessionId, authoritative] of this.pendingReferenceBroadcasts) {
      if (this.applyAuthoritativeReferences(sessionId, authoritative)) {
        if (!hydratedSessionIds.includes(sessionId)) hydratedSessionIds.push(sessionId)
      }
    }
    this.pendingReferenceBroadcasts.clear()
    for (const sessionId of hydratedSessionIds) {
      this.onReferencesChanged(sessionId, this.getReferences(sessionId))
      this.onAttachmentsChanged(sessionId)
      this.onTextRestored(sessionId, this.getText(sessionId))
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
    if (this.hydrationGate === handle) {
      this.hydrationGeneration += 1
      this.hydrationGate = null
    }
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
    const workspaceGeneration = this.workspaceGeneration
    const hydrationGeneration = this.hydrationGeneration
    return this.runDraftTask(generation => this.serializeContentTask(sessionId, async () => {
      if (!await this.waitForHydration(workspaceId, generation, hydrationGeneration)) return null
      this.onBeforeRestore(sessionId)
      const input: SessionDraft = {
        text: coerceInputText(effect.text),
        ...(effect.references?.length ? { references: effect.references } : {}),
        ...(effect.attachments?.length ? { attachments: effect.attachments } : {}),
      }
      // Finish an earlier ambiguous content RPC under its original mutation id.
      if (this.pendingContentWrites.has(sessionId) || [...this.pendingConsumptions.keys()].some(key => key.startsWith(`${sessionId}:`))) {
        await this.performContentWrite(sessionId, generation)
      }
      this.clearTimer(this.contentTimers, sessionId)
      this.clearTimer(this.referenceTimers, sessionId)
      this.referenceBases.delete(sessionId)
      let restored: SessionDraft | null
      if (effect.queuedRestoreId) {
        const key = `${sessionId}:${effect.queuedRestoreId}`
        const request = this.pendingRestores.get(key) ?? { ...this.captureContentMutation(sessionId, true), restoreId: effect.queuedRestoreId, input, planExecutionId: effect.planExecutionId, messageIds: effect.messageIds }
        this.pendingRestores.set(key, request)
        const persisted = await this.persistence.restoreDraftInput(sessionId, {
          restoreId: effect.queuedRestoreId,
          draft: input,
          local: { content: request.content, mutation: request.mutation },
          ...(effect.planExecutionId ? { planExecutionId: effect.planExecutionId } : {}),
        })
        if (this.workspaceGeneration !== generation) return null
        if (persisted.committed === false) throw new Error('Draft recovery did not commit')
        this.onBeforeRestore(sessionId)
        this.confirmContentWrite(sessionId, request.before, persisted.draft, persisted.revision)
        const authoritative = persisted.draft?.references ?? []
        const mergedReferences = mergeAuthoritativeSessionDraftReferences(
          this.drafts.get(sessionId), projectId ?? '', request.before.references ?? [], authoritative,
        )
        if (!mergedReferences.ok) throw new Error('Draft recovery exceeded reference boundaries')
        this.assignDraft(sessionId, mergedReferences.draft)
        this.persistedReferences.set(sessionId, authoritative)
        this.pendingRestores.delete(key)
        restored = this.drafts.get(sessionId) ?? { text: '' }
        // New edits made during the RPC use the returned version. Never rewrite
        // the recovered snapshot with the old pre-restore base.
        if (JSON.stringify(this.contentOf(restored)) !== JSON.stringify(this.contentOf(persisted.draft))) {
          await this.performContentWrite(sessionId, generation)
        }
        const latestRefs = this.getReferences(sessionId)
        if (JSON.stringify(latestRefs) !== JSON.stringify(authoritative)) {
          const updated = await this.persistence.updateDraftReferences(sessionId, { baseReferences: authoritative, nextReferences: latestRefs })
          this.persistedReferences.set(sessionId, updated?.references ?? [])
        }
        if (this.workspaceGeneration !== generation) return null
        if (effect.planExecutionId) {
          if (!this.persistence.sessionCommand) throw new Error('Plan recovery acknowledgement unavailable')
          await this.persistence.sessionCommand(sessionId, { type: 'clearPendingPlanExecution', executionId: effect.planExecutionId })
        } else if (effect.messageIds?.length) {
          await this.persistence.acknowledgeQueuedInputRestore(sessionId, effect.queuedRestoreId, effect.messageIds)
        }
      } else {
        const result = restoreSessionDraftContent(this.drafts.get(sessionId), projectId, input.text, input.references ?? [], input.attachments ?? [])
        if (!result.ok) throw new Error('Draft recovery exceeded reference boundaries')
        this.setDraft(sessionId, result.draft)
        this.onTextRestored(sessionId, this.getText(sessionId))
        this.onReferencesChanged(sessionId, this.getReferences(sessionId))
        this.onAttachmentsChanged(sessionId)
        this.scheduleContentPersistence(sessionId)
        this.scheduleReferencePersistence(sessionId, this.persistedReferences.get(sessionId) ?? [])
        await this.performContentWrite(sessionId, generation)
        const updated = await this.persistence.updateDraftReferences(sessionId, { baseReferences: this.persistedReferences.get(sessionId) ?? [], nextReferences: this.getReferences(sessionId) })
        this.persistedReferences.set(sessionId, updated?.references ?? [])
      }
      restored = this.drafts.get(sessionId) ?? { text: '' }
      this.onTextRestored(sessionId, restored.text)
      this.onReferencesChanged(sessionId, restored.references ?? [])
      this.onAttachmentsChanged(sessionId)
      return restored
    })).catch(error => {
      if (this.workspaceGeneration === workspaceGeneration && effect.queuedRestoreId
        && this.pendingRestores.has(`${sessionId}:${effect.queuedRestoreId}`)) {
        this.scheduleContentPersistence(sessionId)
      }
      throw error
    })
  }

  /** Reserve the exact consumption operation before the composer clears. */
  captureSubmittedDraft(sessionId: string, fields?: Pick<SessionDraft, 'attachments' | 'references'>): { content: DraftContent; mutation: DraftContentMutation } {
    this.onBeforeRestore(sessionId)
    const request = this.captureContentMutation(sessionId, true)
    const before = fields ? { ...request.before, ...fields } : request.before
    const pendingWrite = this.pendingContentWrites.get(sessionId)
    return {
      content: { text: '' },
      mutation: {
        // The base and its revision describe the last confirmed host content.
        // A just-typed replacement may not be on disk yet. Pairing that live
        // text with an older revision would preserve the previous disk text as
        // a supposedly independent edit when a reference write advances it.
        ...request.mutation,
        references: { baseReferences: before.references ?? [], nextReferences: [] },
        // The journal must retain this dependency across renderer restart.
        // The host settles its receipt atomically with consumption; replaying
        // a possibly uncommitted write could append it to another window's draft.
        ...(pendingWrite ? { pendingWrite: { content: pendingWrite.content, mutation: pendingWrite.mutation } } : {}),
      },
    }
  }

  /** Replay the journal's original consume operation, including after restart. */
  async consumeSubmittedDraft(
    workspaceId: string,
    sessionId: string,
    clientMessageId: string,
    captured: { content: DraftContent; mutation: DraftContentMutation },
  ): Promise<boolean> {
    const hydrationGeneration = this.hydrationGeneration
    return this.runDraftTask(generation => this.serializeContentTask(sessionId, async () => {
      if (!await this.waitForHydration(workspaceId, generation, hydrationGeneration)) return false
      this.onBeforeRestore(sessionId)
      const before = this.drafts.get(sessionId) ?? { text: '' }
      const confirmedBefore: SessionDraft = {
        ...(this.confirmedContent.get(sessionId) ?? { text: '' }),
        references: this.persistedReferences.get(sessionId) ?? [],
      }
      const persisted = await this.persistence.restoreDraftInput(sessionId, {
        restoreId: `consume-${clientMessageId}`, draft: { text: '' }, local: captured,
      })
      if (this.workspaceGeneration !== generation) return false
      if (persisted.committed === false) throw new Error('Input consumption did not commit')
      if (persisted.localApplied === undefined) throw new Error('Input consumption receipt is unsupported by this host')
      const settlesPendingWrite = !!captured.mutation.pendingWrite
        && this.pendingContentWrites.get(sessionId)?.mutation.id === captured.mutation.pendingWrite.mutation.id
      if (settlesPendingWrite) {
        this.pendingContentWrites.delete(sessionId)
      }
      this.onBeforeRestore(sessionId)
      // This renderer already cleared the submitted snapshot synchronously.
      // Anything present now belongs to a later edit, even if it was typed
      // before this lock/RPC began. A reloaded renderer still displays the
      // hydrated disk draft, which may include an earlier unacknowledged write.
      // Its confirmed hydration is the base; edits since hydration remain local.
      // A stale/duplicate mutation consumed nothing: use the current baseline
      // to avoid appending an edit already accepted by a newer writer sequence.
      // A duplicate ACK can be the first reply for this renderer after the
      // host consumed its pending write. That write is still in our map, so
      // the current composer remains post-clear input, not a consumed base.
      const consumedBase: SessionDraft = persisted.localApplied || settlesPendingWrite
        ? (captured.mutation.clientId === this.contentWriterId
          ? { text: '' }
          : confirmedBefore)
        : before
      this.confirmContentWrite(sessionId, consumedBase, persisted.draft, persisted.revision)
      const authoritative = persisted.draft?.references ?? []
      const merged = mergeAuthoritativeSessionDraftReferences(
        this.drafts.get(sessionId), this.getProjectId(sessionId) ?? '', consumedBase.references ?? [], authoritative,
      )
      if (!merged.ok) throw new Error('Input consumption exceeded reference boundaries')
      this.assignDraft(sessionId, merged.draft)
      this.persistedReferences.set(sessionId, authoritative)
      this.onTextRestored(sessionId, this.getText(sessionId))
      this.onReferencesChanged(sessionId, this.getReferences(sessionId))
      this.onAttachmentsChanged(sessionId)
      return true
    }))
  }

  /** Accept & Compact joins the live local edit and consumption in one host write. */
  async consumePlanDraft(
    workspaceId: string | null,
    sessionId: string,
    executionId: string,
  ): Promise<PlanDraftConsumption | null> {
    const hydrationGeneration = this.hydrationGeneration
    return this.runDraftTask(generation => this.serializeContentTask(sessionId, async () => {
      if (!await this.waitForHydration(workspaceId, generation, hydrationGeneration)) return null
      if (!this.persistence.sessionCommand) throw new Error('Plan draft consumption unavailable')
      const key = `${sessionId}:${executionId}`
      if (this.pendingContentWrites.has(sessionId)
        || [...this.pendingConsumptions.keys()].some(pendingKey => pendingKey.startsWith(`${sessionId}:`) && pendingKey !== key)) {
        await this.performContentWrite(sessionId, generation)
      }
      this.onBeforeRestore(sessionId)
      const request = this.pendingConsumptions.get(key) ?? this.captureContentMutation(sessionId, true)
      this.pendingConsumptions.set(key, request)
      this.clearTimer(this.contentTimers, sessionId)
      this.clearTimer(this.referenceTimers, sessionId)
      this.referenceBases.delete(sessionId)
      const result = await this.persistence.sessionCommand(sessionId, {
        type: 'consumePendingPlanDraft', executionId,
        local: { content: request.content, mutation: request.mutation },
      }) as PlanDraftConsumption | null
      if (!result || this.workspaceGeneration !== generation) return null
      this.onBeforeRestore(sessionId)
      this.confirmContentWrite(sessionId, request.before, result.draft, result.revision, result.receipt.text ? request : undefined)
      this.pendingConsumptions.delete(key)
      this.persistedReferences.set(sessionId, result.draft?.references ?? [])
      if (this.referenceBases.has(sessionId)) this.referenceBases.set(sessionId, result.draft?.references ?? [])
      // Apply only the host's actual consumed keys; later user additions remain.
      const reconciled = this.drafts.get(sessionId)
      // Reference reconciliation uses the same key rules as ordinary draft updates.
      const baseReferences = (request.before.references ?? []).filter(reference => !request.reenteredReferenceKeys.has(referenceKey(reference)))
      const merged = mergeAuthoritativeSessionDraftReferences(reconciled, this.getProjectId(sessionId) ?? '', baseReferences, result.draft?.references ?? [])
      if (merged.ok) this.assignDraft(sessionId, merged.draft)
      return { ...result, draft: this.drafts.get(sessionId) ?? null }
    }))
  }

  async flushContent(sessionId: string): Promise<void> {
    await this.runDraftTask(generation => this.serializeContentTask(sessionId, () => this.performContentWrite(sessionId, generation)))
  }

  private contentOf(draft: SessionDraft | null | undefined): DraftContent {
    return { text: draft?.text ?? '', ...(draft?.attachments?.length ? { attachments: draft.attachments } : {}) }
  }

  private captureContentMutation(sessionId: string, includeReferences = false) {
    const before = this.drafts.get(sessionId) ?? { text: '' }
    const mutation: DraftContentMutation = {
      id: crypto.randomUUID(),
      clientId: this.contentWriterId,
      sequence: ++this.contentSequence,
      baseRevision: this.serverRevisions.get(sessionId) ?? 0,
      base: this.confirmedContent.get(sessionId) ?? { text: '' },
      ...(includeReferences ? { references: {
        baseReferences: this.persistedReferences.get(sessionId) ?? [],
        nextReferences: before.references ?? [],
      } } : {}),
    }
    return { content: this.contentOf(before), mutation, before, textEditVersion: this.textEditVersions.get(sessionId) ?? 0, ownsConsumedPrefix: true, reenteredReferenceKeys: new Set<string>() }
  }

  private confirmContentWrite(sessionId: string, before: SessionDraft, authoritative: SessionDraft | null, revision?: number, consumption?: { textEditVersion: number; ownsConsumedPrefix: boolean }): void {
    const content = this.contentOf(authoritative)
    this.confirmedContent.set(sessionId, content)
    if (revision !== undefined) this.serverRevisions.set(sessionId, revision)
    const latest = this.drafts.get(sessionId)
    let base = this.contentOf(before)
    let next = this.contentOf(latest)
    if (consumption) {
      const edited = (this.textEditVersions.get(sessionId) ?? 0) !== consumption.textEditVersion || next.text !== base.text
      // This window no longer owns the consumed text. Only edits made after
      // the request remain its delta; a restored snapshot in another window
      // is authoritative content, even when its bytes equal our old base.
      const text = !edited ? '' : consumption.ownsConsumedPrefix && next.text !== base.text && base.text && next.text.startsWith(base.text)
        ? next.text.slice(base.text.length) : next.text
      base = { ...base, text: '' }
      next = { ...next, text }
    }
    const merged = mergeDraftContent(content, base, next)
    this.assignDraft(sessionId, { ...merged, ...(latest?.references?.length ? { references: latest.references } : {}) })
  }

  private async performContentWrite(sessionId: string, generation: number): Promise<void> {
    // Resolve an ambiguous consumption before recovery captures a new local
    // edit. Otherwise the old visible snapshot would be restored twice.
    for (const [key, request] of this.pendingConsumptions) {
      if (!key.startsWith(`${sessionId}:`)) continue
      if (!this.persistence.sessionCommand) throw new Error('Plan draft consumption unavailable')
      const result = await this.persistence.sessionCommand(sessionId, {
        type: 'consumePendingPlanDraft', executionId: key.slice(sessionId.length + 1),
        local: { content: request.content, mutation: request.mutation },
      }) as PlanDraftConsumption | null
      if (this.workspaceGeneration !== generation) return
      if (result) {
        this.onBeforeRestore(sessionId)
        this.confirmContentWrite(sessionId, request.before, result.draft, result.revision, result.receipt.text ? request : undefined)
        const baseReferences = (request.before.references ?? []).filter(reference => !request.reenteredReferenceKeys.has(referenceKey(reference)))
        const merged = mergeAuthoritativeSessionDraftReferences(this.drafts.get(sessionId), this.getProjectId(sessionId) ?? '', baseReferences, result.draft?.references ?? [])
        if (!merged.ok) throw new Error('Draft recovery exceeded reference boundaries')
        this.assignDraft(sessionId, merged.draft)
        this.persistedReferences.set(sessionId, result.draft?.references ?? [])
        if (this.referenceBases.has(sessionId)) this.referenceBases.set(sessionId, result.draft?.references ?? [])
        this.onTextRestored(sessionId, this.getText(sessionId))
      }
      this.pendingConsumptions.delete(key)
    }
    // A lost recovery response is retried under its original local mutation and
    // restore ids before any new content edit can be based on uncertain state.
    for (const [key, request] of this.pendingRestores) {
      if (!key.startsWith(`${sessionId}:`)) continue
      const recovered = await this.persistence.restoreDraftInput(sessionId, {
        restoreId: request.restoreId, draft: request.input,
        local: { content: request.content, mutation: request.mutation },
        ...(request.planExecutionId ? { planExecutionId: request.planExecutionId } : {}),
      })
      if (this.workspaceGeneration !== generation) return
      if (recovered.committed === false) throw new Error('Draft recovery did not commit')
      this.onBeforeRestore(sessionId)
      this.confirmContentWrite(sessionId, request.before, recovered.draft, recovered.revision)
      const merged = mergeAuthoritativeSessionDraftReferences(this.drafts.get(sessionId), this.getProjectId(sessionId) ?? '', request.before.references ?? [], recovered.draft?.references ?? [])
      if (!merged.ok) throw new Error('Draft recovery exceeded reference boundaries')
      this.assignDraft(sessionId, merged.draft)
      this.persistedReferences.set(sessionId, recovered.draft?.references ?? [])
      request.before = this.drafts.get(sessionId) ?? { text: '' }
      this.onTextRestored(sessionId, request.before.text)
      this.onReferencesChanged(sessionId, request.before.references ?? [])
      this.onAttachmentsChanged(sessionId)
      if (request.planExecutionId) {
        if (!this.persistence.sessionCommand) throw new Error('Plan recovery acknowledgement unavailable')
        await this.persistence.sessionCommand(sessionId, { type: 'clearPendingPlanExecution', executionId: request.planExecutionId })
      } else if (request.messageIds?.length) {
        await this.persistence.acknowledgeQueuedInputRestore(sessionId, request.restoreId, request.messageIds)
      }
      this.pendingRestores.delete(key)
    }
    while (this.workspaceGeneration === generation) {
      const request = this.pendingContentWrites.get(sessionId) ?? this.captureContentMutation(sessionId)
      this.pendingContentWrites.set(sessionId, request)
      const persisted = await this.persistence.setDraftContent(sessionId, request.content, request.mutation)
      if (this.workspaceGeneration !== generation) return
      // Older transports/mocks may omit the accepted draft. Modern versioned
      // writes return an explicit empty draft with a revision.
      const authoritative = persisted ?? request.before
      if (authoritative.text !== request.content.text) this.onBeforeRestore(sessionId)
      const previousAttachments = JSON.stringify(this.getAttachmentRefs(sessionId))
      this.confirmContentWrite(sessionId, request.before, authoritative, persisted?.revision)
      if (previousAttachments !== JSON.stringify(this.getAttachmentRefs(sessionId))) this.onAttachmentsChanged(sessionId)
      this.pendingContentWrites.delete(sessionId)
      if (authoritative.text !== request.content.text) this.onTextRestored(sessionId, this.getText(sessionId))
      if (JSON.stringify(this.contentOf(this.drafts.get(sessionId))) === JSON.stringify(this.confirmedContent.get(sessionId))) return
    }
  }

  private serializeContentTask<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.contentTasks.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(operation)
    this.contentTasks.set(sessionId, task)
    void task.finally(() => { if (this.contentTasks.get(sessionId) === task) this.contentTasks.delete(sessionId) }).catch(() => {})
    return task
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
    this.confirmedContent.clear()
    this.serverRevisions.clear()
    this.pendingContentWrites.clear()
    this.pendingRestores.clear()
    this.pendingConsumptions.clear()
    this.textEditVersions.clear()
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
        const version = this.mutationVersions.get(sessionId) ?? 0
        const task = this.flushContent(sessionId).then(() => {
          if (this.contentTimers.get(sessionId) === timer) {
            if ((this.mutationVersions.get(sessionId) ?? 0) === version) this.contentTimers.delete(sessionId)
            else scheduleWrite()
          }
        })
        void task.catch(error => {
          this.warn('[drafts] Failed to persist draft content; retrying', { sessionId, error })
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
        const task = this.runDraftTask(() => this.serializeContentTask(sessionId, async () => {
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
        }))
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
    admittedHydrationGeneration: number,
  ): Promise<boolean> {
    if (this.hydrationGeneration !== admittedHydrationGeneration) return false
    const gate = this.hydrationGate
    if (gate?.workspaceId === workspaceId) {
      await gate.promise
      if (this.hydrationGate !== gate) return false
    }
    return this.workspaceGeneration === generation && this.hydrationGeneration === admittedHydrationGeneration
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
          operations.push(this.flushContent(sessionId))
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
