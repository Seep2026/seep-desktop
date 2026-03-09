import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  SeepClawBridgeClient,
  normalizeSuggestionState,
  resolveSeepClawBridgeBaseUrls,
} from '../bridge/seepClawBridgeClient.js'
import {
  shouldSubmitIncomingMessage,
  suggestionIdentity,
} from '../hooks/chat/chatSuggestionUtils.js'

describe('seep-claw bridge client', () => {
  it('normalizes suggestion response from snake_case format', () => {
    const state = normalizeSuggestionState(42, {
      status: 'ready',
      request_id: 'req-1',
      source_message_id: 777,
      suggested_reply: 'hello',
      updated_at: 12345,
    })

    expect(state.chatId).to.equal(42)
    expect(state.status).to.equal('ready')
    expect(state.requestId).to.equal('req-1')
    expect(state.sourceMessageId).to.equal(777)
    expect(state.suggestedReply).to.equal('hello')
    expect(state.updatedAt).to.equal(12345)
  })

  it('maps bridge routes via the typed client methods', async () => {
    const calls: Array<{
      url: string
      method: string
      body: string | null
    }> = []

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method || 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })

      if (url.endsWith('/suggestions/11')) {
        return new Response(
          JSON.stringify({
            ok: true,
            suggestion: {
              status: 'ready',
              request_id: 'abc',
              source_message_id: '1',
              suggested_reply: 'hi',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response('{}', { status: 200 })
    }

    const client = new SeepClawBridgeClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl,
    })

    const messageArrivedOk = await client.sendMessageArrivedEvent({
      chat_id: '11',
      contact_id: '5',
      contact_name: 'Alice',
      latest_message: {
        message_id: '99',
        role: 'user',
        text: 'hi',
        timestamp: '1000',
      },
      recent_messages: [],
      session_summary: null,
      persona_id: null,
      metadata: { source: 'deltachat-desktop' },
    })
    expect(messageArrivedOk).to.equal(true)

    const suggestion = await client.getSuggestion(11)
    expect(suggestion?.status).to.equal('ready')
    expect(suggestion?.suggestedReply).to.equal('hi')

    const regenerateOk = await client.regenerateSuggestion(11)
    expect(regenerateOk).to.equal(true)

    const markIgnoredOk = await client.markSuggestionIgnored(11, {
      requestId: 'abc',
    })
    expect(markIgnoredOk).to.equal(true)

    expect(calls.map(call => `${call.method} ${call.url}`)).to.deep.equal([
      'POST http://127.0.0.1:8765/events/message-arrived',
      'GET http://127.0.0.1:8765/suggestions/11',
      'POST http://127.0.0.1:8765/suggestions/11/regenerate',
      'POST http://127.0.0.1:8765/suggestions/11/mark-ignored',
    ])
  })

  it('maps error envelope from bridge to error suggestion state', () => {
    const state = normalizeSuggestionState(8, {
      ok: false,
      error: {
        code: 'OPENCLAW_TIMEOUT',
        message: 'OpenClaw timed out',
      },
    })
    expect(state.status).to.equal('error')
    expect(state.error).to.equal('OpenClaw timed out')
  })

  it('falls back between loopback hostnames when one is unreachable', async () => {
    const calls: string[] = []

    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('http://127.0.0.1:8765')) {
        throw new TypeError('network error')
      }
      return new Response('{}', { status: 200 })
    }

    const client = new SeepClawBridgeClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl,
    })

    const healthy = await client.healthCheck()
    expect(healthy).to.equal(true)
    expect(calls).to.deep.equal([
      'http://127.0.0.1:8765/health',
      'http://localhost:8765/health',
    ])
  })

  it('resolves loopback candidates for localhost and 127.0.0.1', () => {
    expect(resolveSeepClawBridgeBaseUrls('http://127.0.0.1:8765')).to.deep.equal(
      ['http://127.0.0.1:8765', 'http://localhost:8765']
    )
    expect(resolveSeepClawBridgeBaseUrls('http://localhost:8765')).to.deep.equal(
      ['http://localhost:8765', 'http://127.0.0.1:8765']
    )
  })

  it('can use runtime bridge transport instead of renderer fetch', async () => {
    const calls: string[] = []
    const client = new SeepClawBridgeClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: async () => {
        throw new Error('fetch should not be called')
      },
      bridgeTransport: async request => {
        calls.push(`${request.method ?? 'GET'} ${request.url}`)
        return {
          ok: true,
          status: 200,
          bodyText: JSON.stringify({
            status: 'ready',
            suggested_reply: 'hello from transport',
          }),
        }
      },
    })

    const suggestion = await client.getSuggestion(99)
    expect(suggestion?.status).to.equal('ready')
    expect(suggestion?.suggestedReply).to.equal('hello from transport')
    expect(calls).to.deep.equal(['GET http://127.0.0.1:8765/suggestions/99'])
  })
})

describe('chat suggestion guards', () => {
  it('suppresses duplicate incoming message submissions per chat', () => {
    const map = new Map<number, number>()
    expect(shouldSubmitIncomingMessage(map, 1, 100)).to.equal(true)
    expect(shouldSubmitIncomingMessage(map, 1, 100)).to.equal(false)
    expect(shouldSubmitIncomingMessage(map, 1, 101)).to.equal(true)
    expect(shouldSubmitIncomingMessage(map, 2, 100)).to.equal(true)
  })

  it('builds a stable suggestion identity key', () => {
    const key = suggestionIdentity({
      requestId: 'r1',
      sourceMessageId: 5,
      updatedAt: 1000,
      suggestedReply: 'reply',
    })
    expect(key).to.be.a('string')
    expect(
      suggestionIdentity({
        requestId: null,
        sourceMessageId: null,
        updatedAt: null,
        suggestedReply: null,
      })
    ).to.equal(null)
  })
})
