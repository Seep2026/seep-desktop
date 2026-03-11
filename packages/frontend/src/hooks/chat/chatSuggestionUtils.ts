import type { BridgeSuggestionState } from '../../bridge/seepClawBridgeClient'

export function suggestionIdentity(
  state: Pick<
    BridgeSuggestionState,
    'requestId' | 'sourceMessageId' | 'updatedAt' | 'suggestedReply'
  >
) {
  if (state.requestId && state.requestId.length > 0) {
    return `req:${state.requestId}`
  }
  if (state.sourceMessageId != null) {
    return JSON.stringify(['src', state.sourceMessageId, state.suggestedReply ?? null])
  }
  if (state.suggestedReply && state.suggestedReply.length > 0) {
    return JSON.stringify(['reply', state.suggestedReply])
  }
  if (state.updatedAt != null) {
    return `ts:${state.updatedAt}`
  }
  if (!state.suggestedReply) {
    return null
  }
  return null
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
