import type { RecoveryMessage } from './core/index.ts';
import { formatRecoveryMessageContent } from './recovery-message.ts';

const MAX_MESSAGE_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 12_000;

export interface ConversationSummaryOptions {
  maxMessageChars?: number;
  maxTranscriptChars?: number;
}

export function buildConversationSummaryTranscript(
  messages: RecoveryMessage[],
  options?: ConversationSummaryOptions,
): string {
  const maxMessageChars = options?.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const maxTranscriptChars = options?.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS;

  let transcript = '';
  for (const message of messages) {
    const separator = transcript ? '\n\n' : '';
    const entry = `${message.type === 'user' ? 'User' : 'Assistant'}: ${formatRecoveryMessageContent(message, maxMessageChars)}`;
    const candidate = `${separator}${entry}`;
    const remainingChars = maxTranscriptChars - transcript.length;

    if (candidate.length <= remainingChars) {
      transcript += candidate;
      continue;
    }

    // The transcript limit is soft for one validated reference payload: omitting or
    // slicing an opaque block would lose its source data or corrupt its markers.
    transcript += message.referenceContext
      ? candidate
      : candidate.slice(0, Math.max(remainingChars, 0));
    break;
  }

  return transcript;
}

export function buildConversationSummaryPrompt(messages: RecoveryMessage[]): string | null {
  if (messages.length === 0) return null;

  const transcript = buildConversationSummaryTranscript(messages);
  if (!transcript) return null;

  return (
    'Summarize this conversation concisely. Preserve: key decisions, ongoing tasks, ' +
    `technical context, and the user's current goal. Be specific, not generic.\n\n${transcript}`
  );
}

export async function generateConversationSummary(
  messages: RecoveryMessage[],
  runMiniCompletion: (prompt: string) => Promise<string | null>,
): Promise<string | null> {
  const prompt = buildConversationSummaryPrompt(messages);
  if (!prompt) return null;
  return runMiniCompletion(prompt);
}

export function buildTransferredSessionContext(summary: string): string {
  // One wording for every handoff: a remote workspace transfer, an imported session, and a session
  // continued in a new one (Coding mode switch)
  return `<session_transfer_summary>\nThis session continues an earlier conversation from another session or workspace, which was summarized for the handoff.\nUse the summary below as prior context for the next turn.\n\n${summary}\n</session_transfer_summary>`;
}
