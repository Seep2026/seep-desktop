import type { BridgeSuggestionState } from '../../bridge/seepClawBridgeClient'

export function suggestionIdentity(
  state: Pick<
    BridgeSuggestionState,
    'requestId' | 'sourceMessageId' | 'updatedAt' | 'suggestedReply'
  >
) {
  if (
    state.requestId == null &&
    state.sourceMessageId == null &&
    state.updatedAt == null &&
    !state.suggestedReply
  ) {
    return null
  }
  return JSON.stringify([
    state.requestId,
    state.sourceMessageId,
    state.updatedAt,
    state.suggestedReply,
  ])
}

export function shouldSubmitIncomingMessage(
  lastSubmittedIncomingMessageByChat: Map<number, number>,
  chatId: number,
  messageId: number
) {
  const lastMessageId = lastSubmittedIncomingMessageByChat.get(chatId)
  if (lastMessageId === messageId) {
    return false
  }
  lastSubmittedIncomingMessageByChat.set(chatId, messageId)
  return true
}
