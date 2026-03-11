import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { T } from '@deltachat/jsonrpc-client'
import { runtime } from '@deltachat-desktop/runtime-interface'

import { getLogger } from '../../../../shared/logger'
import { catchUpLatestIncomingMessageForChat } from '../../bridge/seepClawBridgeEventForwarder'
import {
  BridgeSuggestionState,
  BridgeTransport,
  SeepClawBridgeClient,
} from '../../bridge/seepClawBridgeClient'
import { suggestionIdentity } from './chatSuggestionUtils'

const log = getLogger('renderer/useChatSuggestion')
const POLL_INTERVAL_MS = 1000
type SuggestionConsumption = {
  identity: string
  mode: 'hide' | 'clear'
}
const consumedSuggestionByAccountAndChat = new Map<string, SuggestionConsumption>()

function accountChatKey(accountId: number, chatId: number) {
  return `${accountId}:${chatId}`
}

function resolveBridgeChatId(target: string, accountId: number, chatId: number) {
  if (target === 'electron') {
    return `${accountId}:${chatId}`
  }
  return String(chatId)
}

export type ChatSuggestionState = BridgeSuggestionState & {
  isPolling: boolean
  isSubmittingEvent: boolean
  isDismissed: boolean
}

const defaultSuggestionState = (chatId: number): ChatSuggestionState => ({
  chatId,
  status: 'idle',
  requestId: null,
  sourceMessageId: null,
  suggestedReply: null,
  error: null,
  updatedAt: null,
  isPolling: false,
  isSubmittingEvent: false,
  isDismissed: false,
})

function isBridgeFeatureEnabled() {
  const target = runtime.getRuntimeInfo().target
  return target !== 'browser'
}

function resolveRuntimeBridgeTransport(): BridgeTransport | undefined {
  const runtimeRequestHttp = (runtime as any).requestHttp
  if (typeof runtimeRequestHttp !== 'function') {
    return undefined
  }

  return async request => {
    try {
      const response = await runtimeRequestHttp.call(runtime, request)
      if (
        response == null ||
        typeof response !== 'object' ||
        typeof response.status !== 'number' ||
        typeof response.bodyText !== 'string'
      ) {
        return null
      }
      return {
        ok: Boolean((response as any).ok),
        status: response.status,
        bodyText: response.bodyText,
      }
    } catch (_error) {
      return null
    }
  }
}

export function useChatSuggestion(accountId: number, chat: T.FullChat) {
  const [state, setState] = useState<ChatSuggestionState>(() =>
    defaultSuggestionState(chat.id)
  )

  const client = useMemo(
    () =>
      new SeepClawBridgeClient({
        bridgeTransport: resolveRuntimeBridgeTransport(),
      }),
    []
  )
  const runtimeTarget = runtime.getRuntimeInfo().target
  const bridgeFeatureEnabled = isBridgeFeatureEnabled()
  const bridgeChatId = resolveBridgeChatId(runtimeTarget, accountId, chat.id)

  const activeChatIdRef = useRef(chat.id)
  const inFlightPollRef = useRef(false)
  const dismissedIdentityRef = useRef<string | null>(null)
  const accountChat = accountChatKey(accountId, chat.id)

  useEffect(() => {
    activeChatIdRef.current = chat.id
    dismissedIdentityRef.current = null
    setState(defaultSuggestionState(chat.id))
  }, [chat.id])

  const updateSuggestionState = useCallback(
    (
      next: BridgeSuggestionState,
      extras?: Partial<Pick<ChatSuggestionState, 'isPolling' | 'isSubmittingEvent'>>
    ) => {
      setState(prev => {
        const identity = suggestionIdentity(next)
        const consumedSuggestion =
          consumedSuggestionByAccountAndChat.get(accountChat) ?? null
        if (
          identity != null &&
          consumedSuggestion != null &&
          consumedSuggestion.identity === identity
        ) {
          if (consumedSuggestion.mode === 'hide') {
            return {
              ...prev,
              ...next,
              isPolling: extras?.isPolling ?? prev.isPolling,
              isSubmittingEvent: extras?.isSubmittingEvent ?? prev.isSubmittingEvent,
              isDismissed: true,
            }
          }
          return {
            ...defaultSuggestionState(prev.chatId),
            isPolling: extras?.isPolling ?? prev.isPolling,
            isSubmittingEvent: extras?.isSubmittingEvent ?? prev.isSubmittingEvent,
            isDismissed: false,
          }
        }
        return {
          ...prev,
          ...next,
          isPolling: extras?.isPolling ?? prev.isPolling,
          isSubmittingEvent: extras?.isSubmittingEvent ?? prev.isSubmittingEvent,
          isDismissed:
            (dismissedIdentityRef.current != null &&
              dismissedIdentityRef.current === identity),
        }
      })
    },
    [accountChat]
  )

  const pollSuggestionOnce = useCallback(async () => {
    if (!bridgeFeatureEnabled || inFlightPollRef.current) {
      return
    }
    inFlightPollRef.current = true
    setState(prev => ({ ...prev, isPolling: true }))

    const chatId = activeChatIdRef.current
    const suggestion = await client.getSuggestion(chatId, bridgeChatId)

    inFlightPollRef.current = false

    if (activeChatIdRef.current !== chatId) {
      return
    }

    if (suggestion == null) {
      setState(prev => ({
        ...prev,
        isPolling: false,
        status: 'error',
        error: 'Bridge unavailable',
      }))
      return
    }

    updateSuggestionState(suggestion, { isPolling: false })
  }, [bridgeChatId, bridgeFeatureEnabled, client, updateSuggestionState])

  useEffect(() => {
    if (!bridgeFeatureEnabled || runtimeTarget === 'electron') {
      return
    }
    void pollSuggestionOnce()
    const interval = setInterval(() => {
      void pollSuggestionOnce()
    }, POLL_INTERVAL_MS)
    return () => {
      clearInterval(interval)
    }
  }, [bridgeFeatureEnabled, pollSuggestionOnce])

  useEffect(() => {
    if (!bridgeFeatureEnabled) {
      return
    }

    let isCancelled = false
    const runCatchUp = async () => {
      setState(prev => ({ ...prev, isSubmittingEvent: true }))
      const forwarded = await catchUpLatestIncomingMessageForChat({
        accountId,
        chatId: chat.id,
        chatNameHint: chat.name,
      })
      if (isCancelled) {
        return
      }
      setState(prev => ({ ...prev, isSubmittingEvent: false }))
      if (forwarded) {
        void pollSuggestionOnce()
      }
    }

    void runCatchUp()

    return () => {
      isCancelled = true
    }
  }, [
    accountId,
    bridgeFeatureEnabled,
    chat.id,
    chat.name,
    pollSuggestionOnce,
    runtimeTarget,
  ])

  const copySuggestion = useCallback(async () => {
    if (!state.suggestedReply) {
      return false
    }
    try {
      await runtime.writeClipboardText(state.suggestedReply)
    } catch (error) {
      log.warn('failed to copy suggestion text', error)
      return false
    }
    void client.markSuggestionUsed(chat.id, {
      mode: 'copied',
      requestId: state.requestId,
      sourceMessageId:
        state.sourceMessageId != null ? String(state.sourceMessageId) : null,
    }, bridgeChatId)
    return true
  }, [
    bridgeChatId,
    chat.id,
    client,
    state.requestId,
    state.sourceMessageId,
    state.suggestedReply,
  ])

  const markSuggestionUsed = useCallback(
    async (mode: string) => {
      return client.markSuggestionUsed(chat.id, {
        mode,
        requestId: state.requestId,
        sourceMessageId:
          state.sourceMessageId != null ? String(state.sourceMessageId) : null,
      }, bridgeChatId)
    },
    [bridgeChatId, chat.id, client, state.requestId, state.sourceMessageId]
  )

  const regenerateSuggestion = useCallback(async () => {
    dismissedIdentityRef.current = null
    consumedSuggestionByAccountAndChat.delete(accountChat)
    const success = await client.regenerateSuggestion(chat.id, bridgeChatId)
    if (!success) {
      setState(prev => ({
        ...prev,
        status: 'error',
        error: 'Failed to regenerate suggestion',
      }))
      return false
    }
    setState(prev => ({ ...prev, status: 'queued', error: null, isDismissed: false }))
    return true
  }, [accountChat, bridgeChatId, chat.id, client])

  const dismissSuggestion = useCallback(async () => {
    const identity = suggestionIdentity(state)
    dismissedIdentityRef.current = identity
    if (identity != null) {
      consumedSuggestionByAccountAndChat.set(accountChat, {
        identity,
        mode: 'hide',
      })
    }
    setState(prev => ({ ...prev, isDismissed: true }))
    void client.markSuggestionIgnored(chat.id, {
      requestId: state.requestId,
      sourceMessageId:
        state.sourceMessageId != null ? String(state.sourceMessageId) : null,
    }, bridgeChatId)
  }, [accountChat, bridgeChatId, chat.id, client, state])

  const clearSuggestionAfterSend = useCallback(
    (forcedIdentity?: string | null) => {
      const identity = forcedIdentity ?? suggestionIdentity(state)
      dismissedIdentityRef.current = identity
      if (identity != null) {
        consumedSuggestionByAccountAndChat.set(accountChat, {
          identity,
          mode: 'clear',
        })
      }
      setState(prev => ({
        ...defaultSuggestionState(prev.chatId),
        isDismissed: false,
      }))
    },
    [accountChat, state]
  )

  const clearConsumedSuggestionIdentity = useCallback(() => {
    consumedSuggestionByAccountAndChat.delete(accountChat)
    setState(prev => ({
      ...defaultSuggestionState(prev.chatId),
      isDismissed: false,
    }))
  }, [accountChat])

  return {
    suggestionState: state,
    bridgeFeatureEnabled,
    actions: {
      copySuggestion,
      regenerateSuggestion,
      dismissSuggestion,
      markSuggestionUsed,
      clearSuggestionAfterSend,
      clearConsumedSuggestionIdentity,
      pollSuggestionOnce,
    },
  }
}
