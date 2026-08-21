import type { RecoveryMessage } from './core/types.ts';

const TRUNCATION_SUFFIX = '...[truncated]';

export function formatRecoveryMessageContent(
  message: RecoveryMessage,
  maxContentChars: number,
): string {
  const content = message.content.length > maxContentChars
    ? message.content.slice(0, maxContentChars) + TRUNCATION_SUFFIX
    : message.content;

  if (!message.referenceContext) return content;
  return content ? `${content}\n\n${message.referenceContext}` : message.referenceContext;
}
