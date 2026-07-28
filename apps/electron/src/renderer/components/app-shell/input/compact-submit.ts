import type { FileAttachment } from '../../../../shared/types'

export type InputSubmitHandler = (
  message: string,
  attachments?: FileAttachment[],
  skillSlugs?: string[],
  delivery?: { consumeDraft?: boolean },
) => Promise<void> | void

export function isCompactCommand(message: string): boolean {
  return /^\/compact(?:\s|$)/i.test(message.trim())
}

/**
 * Compaction is a control message, not Draft content. It must never consume
 * staged attachments or structured Project File references.
 */
export function submitCompactCommand(
  onSubmit: InputSubmitHandler,
  message = '/compact',
): Promise<void> | void {
  return onSubmit(message.trim(), undefined, undefined, {
    consumeDraft: false,
  })
}
