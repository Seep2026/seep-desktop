import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  suggestionPanelActionLabels,
  shouldRenderSuggestionPanel,
  suggestionPanelBodyText,
  suggestionPanelStatusText,
} from '../components/message/chatSuggestionPanelState.js'
import type { ChatSuggestionState } from '../hooks/chat/useChatSuggestion.js'

function mkState(
  patch: Partial<ChatSuggestionState> = {}
): ChatSuggestionState {
  return {
    chatId: 1,
    status: 'idle',
    requestId: null,
    sourceMessageId: null,
    suggestedReply: null,
    error: null,
    updatedAt: null,
    isPolling: false,
    isSubmittingEvent: false,
    isDismissed: false,
    ...patch,
  }
}

describe('chat suggestion panel state helpers', () => {
  it('renders for generating, ready and error states', () => {
    expect(shouldRenderSuggestionPanel(mkState({ status: 'generating' }))).to.eq(
      true
    )
    expect(
      shouldRenderSuggestionPanel(
        mkState({ status: 'ready', suggestedReply: 'draft reply' })
      )
    ).to.eq(true)
    expect(
      shouldRenderSuggestionPanel(mkState({ status: 'error', error: 'oops' }))
    ).to.eq(true)
  })

  it('renders for idle and hides only when dismissed', () => {
    expect(shouldRenderSuggestionPanel(mkState({ status: 'idle' }))).to.eq(true)
    expect(
      shouldRenderSuggestionPanel(
        mkState({ status: 'ready', suggestedReply: 'draft', isDismissed: true })
      )
    ).to.eq(false)
  })

  it('returns readable body/status labels', () => {
    expect(suggestionPanelStatusText(mkState({ status: 'ready' }))).to.eq(
      'ready'
    )
    expect(
      suggestionPanelBodyText(
        mkState({ status: 'ready', suggestedReply: 'Hello there' })
      )
    ).to.eq('Hello there')
    expect(
      suggestionPanelBodyText(mkState({ status: 'error', error: 'Bridge down' }))
    ).to.eq('Bridge down')
  })

  it('keeps action order and appends auto toggle at the end', () => {
    expect(suggestionPanelActionLabels()).to.deep.equal([
      'Copy',
      'Regenerate',
      'Dismiss',
      'auto',
    ])
  })
})
