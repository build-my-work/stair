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
