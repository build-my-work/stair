import type { ContentBadge, Reference } from '@craft-agent/core'
import type { DraftContent, DraftContentMutation, DraftAttachmentRef } from '@craft-agent/shared/config'

export interface PendingInput {
  version: 1
  workspaceId: string
  projectId: string
  sessionId: string
  clientMessageId: string
  createdAt: number
  text: string
  attachments?: DraftAttachmentRef[]
  references?: Reference[]
  skillSlugs?: string[]
  badges?: ContentBadge[]
  approvedPlanMessageId?: string
  consumption?: { content: DraftContent; mutation: DraftContentMutation }
}

const INPUT_PREFIX = 'stair.pending-input.v1:'

/** One key per request avoids read/modify/write races between renderer windows. */
export class PendingInputJournal {
  constructor(private readonly storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>) {}

  write(input: PendingInput): void {
    // setItem is synchronous: quota/private-storage failures must reach the
    // composer before it is allowed to clear any of the captured fields.
    this.storage.setItem(`${INPUT_PREFIX}${input.clientMessageId}`, JSON.stringify(input))
  }

  remove(clientMessageId: string): void {
    this.storage.removeItem(`${INPUT_PREFIX}${clientMessageId}`)
  }

  get(clientMessageId: string): PendingInput | null {
    const raw = this.storage.getItem(`${INPUT_PREFIX}${clientMessageId}`)
    if (!raw) return null
    const input = JSON.parse(raw) as PendingInput
    if (input.version !== 1 || input.clientMessageId !== clientMessageId
      || !input.workspaceId || !input.projectId || !input.sessionId
      || typeof input.text !== 'string' || (input.consumption && !input.consumption.mutation?.id)) {
      throw new Error('Pending input recovery record is invalid')
    }
    return input
  }

  list(workspaceId: string): PendingInput[] {
    const inputs: PendingInput[] = []
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index)
      if (!key?.startsWith(INPUT_PREFIX)) continue
      const input = this.get(key.slice(INPUT_PREFIX.length))
      if (input?.workspaceId === workspaceId) inputs.push(input)
    }
    return inputs.sort((left, right) => left.createdAt - right.createdAt)
  }
}

export function rollbackRejectedOptimisticUserMessage<
  T extends { id: string; role: string; isPending?: boolean },
>(messages: readonly T[], optimisticMessageId: string | null | undefined): T[] {
  if (!optimisticMessageId) return [...messages]
  return messages.filter(message => !(
    message.id === optimisticMessageId
    && message.role === 'user'
    && message.isPending === true
  ))
}
