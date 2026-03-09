import type { ChatSuggestionState } from '../../hooks/chat/useChatSuggestion'

export function suggestionPanelActionLabels() {
  return ['Copy', 'Regenerate', 'Dismiss', 'auto'] as const
}

export function shouldRenderSuggestionPanel(state: ChatSuggestionState) {
  if (state.isDismissed) {
    return false
  }
  return true
}

export function suggestionPanelStatusText(state: ChatSuggestionState) {
  if (state.isSubmittingEvent && state.status === 'idle') {
    return 'queued'
  }
  return state.status
}

export function suggestionPanelBodyText(state: ChatSuggestionState) {
  if (state.status === 'error' && state.error) {
    return state.error
  }
  if (state.status === 'generating' || state.status === 'queued') {
    return 'Generating suggestion...'
  }
  if (state.suggestedReply) {
    return state.suggestedReply
  }
  if (state.status === 'stale') {
    return 'Suggestion is stale.'
  }
  return 'No suggestion yet.'
}
