import { C, T } from '@deltachat/jsonrpc-client'
import { runtime } from '@deltachat-desktop/runtime-interface'

import { getLogger } from '../../../shared/logger'
import { BackendRemote } from '../backend-com'
import {
  BridgeMessage,
  BridgeTransport,
  SeepClawBridgeClient,
} from './seepClawBridgeClient'
import { getDirection } from '../utils/getDirection'

const log = getLogger('renderer/seepClawBridgeEventForwarder')
const RECENT_MESSAGE_LIMIT = 12

const lastSubmittedByAccountAndChat = new Map<string, number>()
const inFlightByAccountAndChat = new Map<string, number>()

function toIsoDatetime(value: number): string {
  if (!Number.isFinite(value)) {
    return new Date().toISOString()
  }
  const unixMillis = value > 1e12 ? value : value * 1000
  return new Date(unixMillis).toISOString()
}

function mapMessageToBridgeMessage(message: T.Message): BridgeMessage {
  const role = message.isInfo
    ? 'system'
    : getDirection({ fromId: message.fromId }) === 'incoming'
      ? 'user'
      : 'assistant'
  return {
    message_id: String(message.id),
    role,
    text: message.text || '',
    timestamp: toIsoDatetime(message.timestamp),
  }
}

async function getRecentMessages(
  accountId: number,
  chatId: number
): Promise<BridgeMessage[]> {
  const messageListItems = await BackendRemote.rpc.getMessageListItems(
    accountId,
    chatId,
    false,
    true
  )
  const recentIds = messageListItems
    .filter(item => item.kind === 'message')
    .map(item => item.msg_id)
    .slice(-RECENT_MESSAGE_LIMIT)

  if (recentIds.length === 0) {
    return []
  }

  const loadedMessages = await BackendRemote.rpc.getMessages(accountId, recentIds)
  return recentIds
    .map(id => loadedMessages[id])
    .filter(
      (
        messageLoadResult
      ): messageLoadResult is Extract<T.MessageLoadResult, { kind: 'message' }> =>
        messageLoadResult != null && messageLoadResult.kind === 'message'
    )
    .map(messageLoadResult => mapMessageToBridgeMessage(messageLoadResult))
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

const sharedBridgeClient = new SeepClawBridgeClient({
  bridgeTransport: resolveRuntimeBridgeTransport(),
})

function accountChatKey(accountId: number, chatId: number) {
  return `${accountId}:${chatId}`
}

function shouldSubmitIncomingMessage(
  accountId: number,
  chatId: number,
  messageId: number
) {
  const key = accountChatKey(accountId, chatId)
  const lastSubmittedId = lastSubmittedByAccountAndChat.get(key)
  const inFlightId = inFlightByAccountAndChat.get(key)
  if (lastSubmittedId === messageId || inFlightId === messageId) {
    return false
  }
  return true
}

function markInFlight(accountId: number, chatId: number, messageId: number) {
  const key = accountChatKey(accountId, chatId)
  inFlightByAccountAndChat.set(key, messageId)
}

function clearInFlight(accountId: number, chatId: number, messageId: number) {
  const key = accountChatKey(accountId, chatId)
  if (inFlightByAccountAndChat.get(key) === messageId) {
    inFlightByAccountAndChat.delete(key)
  }
}

function markSubmitted(accountId: number, chatId: number, messageId: number) {
  lastSubmittedByAccountAndChat.set(accountChatKey(accountId, chatId), messageId)
}

async function resolveContactDisplayName(
  accountId: number,
  fromId: number
): Promise<string | null> {
  if (fromId > C.DC_CONTACT_ID_LAST_SPECIAL) {
    try {
      const contact = await BackendRemote.rpc.getContact(accountId, fromId)
      return contact.displayName || contact.address || null
    } catch (_error) {
      return null
    }
  }
  return null
}

async function resolveChatDisplayName(
  accountId: number,
  chatId: number
): Promise<string | null> {
  try {
    const chat = await BackendRemote.rpc.getBasicChatInfo(accountId, chatId)
    return chat.name || null
  } catch (_error) {
    return null
  }
}

function isBridgeFeatureEnabled() {
  return runtime.getRuntimeInfo().target !== 'browser'
}

export async function forwardIncomingMessageToSeepBridge(params: {
  accountId: number
  chatId: number
  messageId: number
  chatNameHint?: string | null
  bridgeChatId?: string
}) {
  const { accountId, chatId, messageId, chatNameHint, bridgeChatId } = params
  if (!isBridgeFeatureEnabled()) {
    return false
  }
  if (!shouldSubmitIncomingMessage(accountId, chatId, messageId)) {
    return false
  }

  markInFlight(accountId, chatId, messageId)

  try {
    const latestMessage = await BackendRemote.rpc.getMessage(accountId, messageId)
    if (latestMessage.fromId === C.DC_CONTACT_ID_SELF) {
      return false
    }

    const contactId = String(latestMessage.fromId)
    const contactName =
      (await resolveContactDisplayName(accountId, latestMessage.fromId)) ??
      chatNameHint ??
      (await resolveChatDisplayName(accountId, chatId)) ??
      String(chatId)

    const recentMessages = await getRecentMessages(accountId, chatId)
    const success = await sharedBridgeClient.sendMessageArrivedEvent({
      chat_id: bridgeChatId ?? String(chatId),
      contact_id: contactId,
      contact_name: contactName,
      latest_message: mapMessageToBridgeMessage(latestMessage),
      recent_messages: recentMessages,
      session_summary: null,
      persona_id: null,
      metadata: {
        source: 'deltachat-desktop',
      },
    })
    if (success) {
      markSubmitted(accountId, chatId, messageId)
    } else {
      log.warn('bridge rejected message-arrived', { accountId, chatId, messageId })
    }
    return success
  } catch (error) {
    log.warn('failed to forward incoming message to seep bridge', error)
    return false
  } finally {
    clearInFlight(accountId, chatId, messageId)
  }
}

export async function catchUpLatestIncomingMessageForChat(params: {
  accountId: number
  chatId: number
  chatNameHint?: string | null
  bridgeChatId?: string
}) {
  const { accountId, chatId, chatNameHint, bridgeChatId } = params
  if (!isBridgeFeatureEnabled()) {
    return false
  }

  try {
    const messageListItems = await BackendRemote.rpc.getMessageListItems(
      accountId,
      chatId,
      false,
      true
    )
    const candidateIds = messageListItems
      .filter(item => item.kind === 'message')
      .map(item => item.msg_id)
      .slice(-RECENT_MESSAGE_LIMIT)

    if (candidateIds.length === 0) {
      return false
    }

    const loadedMessages = await BackendRemote.rpc.getMessages(accountId, candidateIds)
    for (let i = candidateIds.length - 1; i >= 0; i -= 1) {
      const candidateId = candidateIds[i]
      const result = loadedMessages[candidateId]
      if (result == null || result.kind !== 'message') {
        continue
      }
      if (result.fromId === C.DC_CONTACT_ID_SELF) {
        continue
      }
      return forwardIncomingMessageToSeepBridge({
        accountId,
        chatId,
        messageId: result.id,
        chatNameHint,
        bridgeChatId,
      })
    }

    return false
  } catch (error) {
    log.warn('failed catch-up forwarding for chat', { accountId, chatId, error })
    return false
  }
}
