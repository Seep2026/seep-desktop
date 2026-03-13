import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  accountChatKey,
  bridgeChatId,
  canRetryTransientFailure,
  canAdvanceQueue,
  enqueueLatestPerChat,
  nextRetryDelayMs,
  shouldEnqueueIncomingMessage,
  shouldSkipSuggestionSend,
  transitionPauseState,
} from '../../../target-electron/src/auto-managed/logic.js'

describe('auto-managed logic helpers', () => {
  it('builds stable chat keys with account isolation', () => {
    expect(accountChatKey(1, 42)).to.equal('1:42')
    expect(bridgeChatId(1, 42)).to.equal('1:42')
    expect(accountChatKey(2, 42)).to.not.equal(accountChatKey(1, 42))
  })

  it('suppresses enqueue for already enqueued or already processed message ids', () => {
    expect(
      shouldEnqueueIncomingMessage({
        messageId: 100,
        lastEnqueuedMessageId: 100,
        lastProcessedMessageId: null,
      })
    ).to.equal(false)
    expect(
      shouldEnqueueIncomingMessage({
        messageId: 100,
        lastEnqueuedMessageId: null,
        lastProcessedMessageId: 100,
      })
    ).to.equal(false)
    expect(
      shouldEnqueueIncomingMessage({
        messageId: 101,
        lastEnqueuedMessageId: 100,
        lastProcessedMessageId: 100,
      })
    ).to.equal(true)
  })

  it('keeps only the newest queue item for the same account/chat', () => {
    const next = enqueueLatestPerChat(
      [
        { accountId: 1, chatId: 10, messageId: 1, enqueuedAt: 1 },
        { accountId: 1, chatId: 11, messageId: 9, enqueuedAt: 2 },
      ],
      { accountId: 1, chatId: 10, messageId: 2, enqueuedAt: 3 }
    )

    expect(next).to.deep.equal([
      { accountId: 1, chatId: 11, messageId: 9, enqueuedAt: 2 },
      { accountId: 1, chatId: 10, messageId: 2, enqueuedAt: 3 },
    ])
  })

  it('stops queue advancement when paused and resumes when unpaused', () => {
    expect(canAdvanceQueue({ enabled: true, paused: false })).to.equal(true)
    expect(canAdvanceQueue({ enabled: true, paused: true })).to.equal(false)
    expect(canAdvanceQueue({ enabled: false, paused: false })).to.equal(false)
  })

  it('transitions pause state deterministically', () => {
    expect(transitionPauseState(false, 'pause')).to.equal(true)
    expect(transitionPauseState(true, 'resume')).to.equal(false)
  })

  it('skips sending stale or duplicate-ready suggestions', () => {
    expect(
      shouldSkipSuggestionSend({
        suggestion: {
          status: 'stale',
          requestId: 'req-1',
          sourceMessageId: 'm-1',
        },
        lastAutoSentRequestId: null,
        lastAutoSentSourceMessageId: null,
      })
    ).to.equal(true)

    expect(
      shouldSkipSuggestionSend({
        suggestion: {
          status: 'ready',
          requestId: 'req-1',
          sourceMessageId: 'm-1',
        },
        lastAutoSentRequestId: 'req-1',
        lastAutoSentSourceMessageId: null,
      })
    ).to.equal(true)

    expect(
      shouldSkipSuggestionSend({
        suggestion: {
          status: 'ready',
          requestId: 'req-2',
          sourceMessageId: 'm-9',
        },
        lastAutoSentRequestId: null,
        lastAutoSentSourceMessageId: 'm-9',
      })
    ).to.equal(true)

    expect(
      shouldSkipSuggestionSend({
        suggestion: {
          status: 'ready',
          requestId: 'req-2',
          sourceMessageId: 'm-10',
        },
        lastAutoSentRequestId: 'req-1',
        lastAutoSentSourceMessageId: 'm-9',
      })
    ).to.equal(false)
  })

  it('retries transient bridge failures only up to configured limit', () => {
    expect(
      canRetryTransientFailure({
        retryCount: 0,
        maxRetries: 5,
      })
    ).to.equal(true)
    expect(
      canRetryTransientFailure({
        retryCount: 4,
        maxRetries: 5,
      })
    ).to.equal(true)
    expect(
      canRetryTransientFailure({
        retryCount: 5,
        maxRetries: 5,
      })
    ).to.equal(false)
  })

  it('uses bounded exponential backoff delays for retries', () => {
    expect(nextRetryDelayMs(1)).to.equal(1000)
    expect(nextRetryDelayMs(2)).to.equal(2000)
    expect(nextRetryDelayMs(3)).to.equal(4000)
    expect(nextRetryDelayMs(4)).to.equal(8000)
    expect(nextRetryDelayMs(5)).to.equal(10000)
    expect(nextRetryDelayMs(6)).to.equal(10000)
  })
})
