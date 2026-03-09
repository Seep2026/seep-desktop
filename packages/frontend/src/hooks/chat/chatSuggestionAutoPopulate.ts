import { suggestionIdentity } from './chatSuggestionUtils.js'
import type { ChatSuggestionState } from './useChatSuggestion.js'

export type DraftLikeState = {
  text: string
  file: string | null
  quote: unknown | null
}

type ResolveAutoPopulateDecisionParams = {
  autoEnabled: boolean
  currentChatId: number
  suggestionState: ChatSuggestionState
  draftState: DraftLikeState
  lastHandledSuggestionIdentity: string | null
}

export type AutoPopulateDecision = {
  shouldApply: boolean
  handledReadySuggestionIdentity: string | null
  suggestionText: string | null
}

export function hasMeaningfulDraftContent(draftState: DraftLikeState) {
  return (
    draftState.text.trim().length > 0 ||
    Boolean(draftState.file) ||
    draftState.quote != null
  )
}

export function resolveAutoPopulateDecision({
  autoEnabled,
  currentChatId,
  suggestionState,
  draftState,
  lastHandledSuggestionIdentity,
}: ResolveAutoPopulateDecisionParams): AutoPopulateDecision {
  if (!autoEnabled) {
    return {
      shouldApply: false,
      handledReadySuggestionIdentity: null,
      suggestionText: null,
    }
  }

  if (suggestionState.status !== 'ready') {
    return {
      shouldApply: false,
      handledReadySuggestionIdentity: null,
      suggestionText: null,
    }
  }

  if (suggestionState.chatId !== currentChatId) {
    return {
      shouldApply: false,
      handledReadySuggestionIdentity: null,
      suggestionText: null,
    }
  }

  const identity = suggestionIdentity(suggestionState)
  if (identity == null || identity === lastHandledSuggestionIdentity) {
    return {
      shouldApply: false,
      handledReadySuggestionIdentity: null,
      suggestionText: null,
    }
  }

  const suggestionText = suggestionState.suggestedReply ?? ''
  if (
    suggestionState.isDismissed ||
    suggestionText.trim().length === 0 ||
    hasMeaningfulDraftContent(draftState)
  ) {
    return {
      shouldApply: false,
      handledReadySuggestionIdentity: identity,
      suggestionText: null,
    }
  }

  return {
    shouldApply: true,
    handledReadySuggestionIdentity: identity,
    suggestionText,
  }
}
