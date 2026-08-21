import type { Message } from '@craft-agent/core'
import type { RecoveryMessage } from '@craft-agent/shared/agent'

import { formatReferencesForModel } from './message-references.ts'

export function buildRecoveryMessages(
  messages: readonly Message[],
  limit?: number,
): RecoveryMessage[] {
  const relevantMessages = messages
    .filter((message): message is Message & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .filter(message => !message.isIntermediate)
  const boundedMessages = limit === undefined
    ? relevantMessages
    : relevantMessages.slice(Math.max(relevantMessages.length - limit, 0))

  return boundedMessages.map((message) => {
    const referenceContext = message.role === 'user' && message.references?.length
      ? formatReferencesForModel('', message.references)
      : undefined

    return {
      type: message.role,
      content: message.content,
      ...(referenceContext ? { referenceContext } : {}),
    }
  })
}
