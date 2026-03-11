export type AutoQueueItem = {
  accountId: number
  chatId: number
  messageId: number
  enqueuedAt: number
}

export type SuggestionLike = {
  status: 'idle' | 'queued' | 'generating' | 'ready' | 'stale' | 'error'
  requestId: string | null
  sourceMessageId: string | null
}

export function accountChatKey(accountId: number, chatId: number) {
  return `${accountId}:${chatId}`
}

export function bridgeChatId(accountId: number, chatId: number) {
  return accountChatKey(accountId, chatId)
}

export function shouldEnqueueIncomingMessage(params: {
  messageId: number
  lastEnqueuedMessageId: number | null
  lastProcessedMessageId: number | null
}) {
  const { messageId, lastEnqueuedMessageId, lastProcessedMessageId } = params
  if (
    lastEnqueuedMessageId != null &&
    Number.isFinite(lastEnqueuedMessageId) &&
    messageId <= lastEnqueuedMessageId
  ) {
    return false
  }
  if (
    lastProcessedMessageId != null &&
    Number.isFinite(lastProcessedMessageId) &&
    messageId <= lastProcessedMessageId
  ) {
    return false
  }
  return true
}

export function enqueueLatestPerChat(
  queue: AutoQueueItem[],
  nextItem: AutoQueueItem
) {
  return queue
    .filter(
      item =>
        item.accountId !== nextItem.accountId || item.chatId !== nextItem.chatId
    )
    .concat(nextItem)
}

export function canAdvanceQueue(params: { enabled: boolean; paused: boolean }) {
  return params.enabled && !params.paused
}

export function transitionPauseState(
  paused: boolean,
  action: 'pause' | 'resume'
) {
  if (action === 'pause') {
    return true
  }
  if (action === 'resume') {
    return false
  }
  return paused
}

export function shouldSkipSuggestionSend(params: {
  suggestion: SuggestionLike
  lastAutoSentRequestId: string | null
  lastAutoSentSourceMessageId: string | null
}) {
  const { suggestion, lastAutoSentRequestId, lastAutoSentSourceMessageId } = params
  if (suggestion.status !== 'ready') {
    return true
  }
  if (suggestion.requestId && suggestion.requestId === lastAutoSentRequestId) {
    return true
  }
  if (
    suggestion.sourceMessageId &&
    suggestion.sourceMessageId === lastAutoSentSourceMessageId
  ) {
    return true
  }
  return false
}
