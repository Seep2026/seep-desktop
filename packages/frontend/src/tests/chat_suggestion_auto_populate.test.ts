import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  hasMeaningfulDraftContent,
  resolveAutoPopulateDecision,
  resolveAutoSendDecision,
} from '../hooks/chat/chatSuggestionAutoPopulate.js'
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

describe('chat suggestion auto-populate decisions', () => {
  it('auto-populates when auto is on, suggestion is ready, chat matches and draft is empty', () => {
    const decision = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-1',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    expect(decision.shouldApply).to.equal(true)
    expect(decision.suggestionText).to.equal('Suggested reply')
    expect(decision.handledReadySuggestionIdentity).to.be.a('string')
  })

  it('does not auto-populate when auto is off', () => {
    const decision = resolveAutoPopulateDecision({
      autoEnabled: false,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-1',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    expect(decision.shouldApply).to.equal(false)
    expect(decision.handledReadySuggestionIdentity).to.equal(null)
  })

  it('does not auto-populate stale or non-ready suggestions', () => {
    const stale = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'stale',
        requestId: 'req-stale',
        suggestedReply: 'old',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })
    const generating = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'generating',
        requestId: 'req-gen',
        suggestedReply: null,
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    expect(stale.shouldApply).to.equal(false)
    expect(generating.shouldApply).to.equal(false)
  })

  it('does not auto-populate when suggestion belongs to a different chat', () => {
    const decision = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        chatId: 2,
        status: 'ready',
        requestId: 'req-2',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    expect(decision.shouldApply).to.equal(false)
    expect(decision.handledReadySuggestionIdentity).to.equal(null)
  })

  it('does not auto-populate when composer already has user draft text', () => {
    const decision = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-1',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: 'Already typing...',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    expect(decision.shouldApply).to.equal(false)
    expect(decision.handledReadySuggestionIdentity).to.be.a('string')
  })

  it('does not re-apply the same ready suggestion repeatedly', () => {
    const first = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-repeat',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: null,
    })

    const second = resolveAutoPopulateDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-repeat',
        suggestedReply: 'Suggested reply',
      }),
      draftState: {
        text: '',
        file: null,
        quote: null,
      },
      lastHandledSuggestionIdentity: first.handledReadySuggestionIdentity,
    })

    expect(first.shouldApply).to.equal(true)
    expect(second.shouldApply).to.equal(false)
    expect(second.handledReadySuggestionIdentity).to.equal(null)
  })

  it('treats text/file/quote as meaningful draft content', () => {
    expect(
      hasMeaningfulDraftContent({
        text: '   ',
        file: null,
        quote: null,
      })
    ).to.equal(false)

    expect(
      hasMeaningfulDraftContent({
        text: 'hello',
        file: null,
        quote: null,
      })
    ).to.equal(true)
    expect(
      hasMeaningfulDraftContent({
        text: '',
        file: '/tmp/file.txt',
        quote: null,
      })
    ).to.equal(true)
    expect(
      hasMeaningfulDraftContent({
        text: '',
        file: null,
        quote: { kind: 'WithMessage', messageId: 1 },
      })
    ).to.equal(true)
  })
})

describe('chat suggestion auto-send decisions', () => {
  const readyState = mkState({
    status: 'ready',
    requestId: 'req-send',
    suggestedReply: 'send this',
  })

  it('does not auto-send when auto is off', () => {
    const decision = resolveAutoSendDecision({
      autoEnabled: false,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'send this', file: null, quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: 'req:req-send',
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    expect(decision.shouldSend).to.equal(false)
  })

  it('does not auto-send for stale/non-ready or chat mismatch', () => {
    const stale = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'stale',
        requestId: 'req-send',
        suggestedReply: 'send this',
      }),
      draftState: { text: 'send this', file: null, quote: null },
      autoPopulatedSuggestion: null,
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    const chatMismatch = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        chatId: 2,
        status: 'ready',
        requestId: 'req-send',
        suggestedReply: 'send this',
      }),
      draftState: { text: 'send this', file: null, quote: null },
      autoPopulatedSuggestion: null,
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    expect(stale.shouldSend).to.equal(false)
    expect(chatMismatch.shouldSend).to.equal(false)
  })

  it('does not auto-send if already auto-sent', () => {
    const identity = 'req:req-send'
    const decision = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'send this', file: null, quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: identity,
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: identity,
      lastAutoSentSourceMessageId: null,
    })
    expect(decision.shouldSend).to.equal(false)
  })

  it('does not auto-send if composer diverged from auto-populated suggestion text', () => {
    const decision = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'user edited text', file: null, quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: 'req:req-send',
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    expect(decision.shouldSend).to.equal(false)
  })

  it('does not auto-send when draft has file or quote', () => {
    const withFile = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'send this', file: '/tmp/f', quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: 'req:req-send',
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    const withQuote = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'send this', file: null, quote: { kind: 'WithMessage' } },
      autoPopulatedSuggestion: {
        suggestionIdentity: 'req:req-send',
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    expect(withFile.shouldSend).to.equal(false)
    expect(withQuote.shouldSend).to.equal(false)
  })

  it('auto-sends once when all safety conditions are satisfied', () => {
    const identity = 'req:req-send'
    const decision = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: readyState,
      draftState: { text: 'send this', file: null, quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: identity,
        suggestionText: 'send this',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: null,
    })
    expect(decision.shouldSend).to.equal(true)
    expect(decision.suggestionIdentity).to.equal(identity)
  })

  it('does not auto-send when source message id was already auto-sent', () => {
    const decision = resolveAutoSendDecision({
      autoEnabled: true,
      currentChatId: 1,
      suggestionState: mkState({
        status: 'ready',
        requestId: 'req-send-2',
        sourceMessageId: 1001,
        suggestedReply: 'send this again',
      }),
      draftState: { text: 'send this again', file: null, quote: null },
      autoPopulatedSuggestion: {
        suggestionIdentity: 'req:req-send-2',
        suggestionText: 'send this again',
      },
      lastAutoSentSuggestionIdentity: null,
      lastAutoSentSourceMessageId: 1001,
    })
    expect(decision.shouldSend).to.equal(false)
  })
})
