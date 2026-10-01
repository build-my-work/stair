import type { DraftAttachmentRef, SessionDraft } from './storage.ts';

export type DraftContent = Pick<SessionDraft, 'text' | 'attachments'>;

/** A window's edit relative to its last confirmed server version. */
export interface DraftContentMutation {
  id: string;
  /** Stable renderer identity and monotonic operation number survive lost replies. */
  clientId?: string;
  sequence?: number;
  baseRevision: number;
  base: DraftContent;
  /** Reference edits join consumption/recovery in the same store transaction. */
  references?: {
    baseReferences: NonNullable<SessionDraft['references']>;
    nextReferences: NonNullable<SessionDraft['references']>;
  };
}

/** Preserve both edits when a stale window cannot safely replace the server text. */
export function mergeDraftContent(current: DraftContent, base: DraftContent, next: DraftContent): DraftContent {
  let text = current.text;
  if (next.text !== base.text) {
    if (current.text === base.text) text = next.text;
    else if (base.text && next.text.startsWith(base.text) && current.text.startsWith(base.text)) {
      text = current.text + next.text.slice(base.text.length);
    } else if (next.text) {
      text = current.text ? `${current.text}\n\n${next.text}` : next.text;
    }
  }
  const attachmentKey = (attachment: DraftAttachmentRef) => JSON.stringify(attachment);
  const baseKeys = new Set((base.attachments ?? []).map(attachmentKey));
  const nextKeys = new Set((next.attachments ?? []).map(attachmentKey));
  const removed = new Set([...baseKeys].filter(key => !nextKeys.has(key)));
  const attachments = (current.attachments ?? []).filter(attachment => !removed.has(attachmentKey(attachment)));
  const keys = new Set(attachments.map(attachmentKey));
  for (const attachment of next.attachments ?? []) {
    const key = attachmentKey(attachment);
    if (!baseKeys.has(key) && !keys.has(key)) {
      attachments.push(attachment);
      keys.add(key);
    }
  }
  return { text, ...(attachments.length ? { attachments } : {}) };
}
