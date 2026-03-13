import { C } from '@deltachat/jsonrpc-client'
import { globalShortcut } from 'electron'

import { getLogger } from '../../../shared/logger.js'
import * as mainWindow from '../windows/main.js'
import {
  accountChatKey,
  AutoQueueItem,
  bridgeChatId,
  canRetryTransientFailure,
  canAdvanceQueue,
  enqueueLatestPerChat,
  nextRetryDelayMs,
  shouldEnqueueIncomingMessage,
  shouldSkipSuggestionSend,
  transitionPauseState,
} from './logic.js'
import {
  BridgeMessage,
  BridgeMessageRole,
  BridgeSuggestionState,
  MessageArrivedEventPayload,
  SeepClawBridgeClient,
} from './seep-claw-bridge-client.js'

const log = getLogger('main/auto-managed')
const POLL_INTERVAL_MS = 800
const POLL_TIMEOUT_MS = 30_000
const RECENT_MESSAGE_LIMIT = 12
const MAX_TRANSIENT_RETRIES = 5
const PAUSE_SHORTCUT = 'CommandOrControl+Shift+0'
const RESUME_SHORTCUT = 'CommandOrControl+Shift+9'

type JsonRpcRemoteLike = {
  on: (
    event: 'IncomingMsg',
    listener: (
      accountId: number,
      event: {
        chatId?: number
        chat_id?: number
        msgId?: number
        msg_id?: number
      }
    ) => void
  ) => void
  off: (
    event: 'IncomingMsg',
    listener: (
      accountId: number,
      event: {
        chatId?: number
        chat_id?: number
        msgId?: number
        msg_id?: number
      }
    ) => void
  ) => void
  rpc: {
    getMessage: (accountId: number, messageId: number) => Promise<any>
    getMessages: (
      accountId: number,
      messageIds: number[]
    ) => Promise<Record<number, any>>
    getMessageListItems: (
      accountId: number,
      chatId: number,
      flagInfoOnly: boolean,
      flagAddDayMarkers: boolean
    ) => Promise<any[]>
    getContact: (accountId: number, contactId: number) => Promise<any>
    getBasicChatInfo: (accountId: number, chatId: number) => Promise<any>
    sendMsg: (accountId: number, chatId: number, messageData: any) => Promise<number>
  }
}

type InFlightState = {
  requestId: string | null
  sourceMessageId: string | null
  startedAt: number
}

export type AutoManagedRuntimeState = {
  enabled: boolean
  paused: boolean
  queue: Array<{
    accountId: number
    chatId: number
    messageId: number
    enqueuedAt: number
    retryCount?: number
  }>
  inFlightByChat: Record<string, InFlightState | null>
  lastProcessedMessageIdByChat: Record<string, string | null>
  lastAutoAppliedRequestIdByChat: Record<string, string | null>
  lastAutoSentRequestIdByChat: Record<string, string | null>
}

function toIsoDatetime(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return new Date().toISOString()
  }
  const numeric = Number(value)
  const unixMillis = numeric > 1e12 ? numeric : numeric * 1000
  return new Date(unixMillis).toISOString()
}

function normalizeRole(message: any): BridgeMessageRole {
  if (message?.isInfo === true) {
    return 'system'
  }
  if (message?.fromId === C.DC_CONTACT_ID_SELF) {
    return 'assistant'
  }
  if (typeof message?.fromId === 'number') {
    return 'user'
  }
  return 'unknown'
}

function messageToBridgeMessage(message: any): BridgeMessage {
  return {
    message_id: String(message?.id ?? ''),
    role: normalizeRole(message),
    text: typeof message?.text === 'string' ? message.text : '',
    timestamp: toIsoDatetime(message?.timestamp),
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class AutoManagedOrchestrator {
  private readonly bridgeClient: SeepClawBridgeClient
  private readonly jsonrpcRemote: JsonRpcRemoteLike
  private readonly lastEnqueuedMessageIdByChat = new Map<string, number>()
  private readonly lastAutoSentSourceMessageIdByChat = new Map<string, string>()
  private readonly state: AutoManagedRuntimeState = {
    enabled: true,
    paused: false,
    queue: [],
    inFlightByChat: {},
    lastProcessedMessageIdByChat: {},
    lastAutoAppliedRequestIdByChat: {},
    lastAutoSentRequestIdByChat: {},
  }
  private processing = false
  private disposed = false
  private readonly onIncomingMessage = (
    accountId: number,
    event: {
      chatId?: number
      chat_id?: number
      msgId?: number
      msg_id?: number
    }
  ) => {
    const chatId = Number(event?.chatId ?? event?.chat_id)
    const msgId = Number(event?.msgId ?? event?.msg_id)
    if (!event || !Number.isFinite(chatId) || !Number.isFinite(msgId)) {
      return
    }
    this.enqueueIncomingMessage(accountId, chatId, msgId)
  }

  constructor(params: {
    jsonrpcRemote: JsonRpcRemoteLike
    bridgeClient?: SeepClawBridgeClient
  }) {
    this.jsonrpcRemote = params.jsonrpcRemote
    this.bridgeClient = params.bridgeClient ?? new SeepClawBridgeClient()
  }

  start() {
    if (this.disposed) {
      return
    }
    this.registerGlobalShortcuts()
    this.jsonrpcRemote.on('IncomingMsg', this.onIncomingMessage)
    this.emitState()
    this.kick()
    log.info('auto-managed orchestrator started', {
      bridgeBaseUrl: this.bridgeClient.getActiveBaseUrl(),
      pauseShortcut: PAUSE_SHORTCUT,
      resumeShortcut: RESUME_SHORTCUT,
    })
  }

  stop() {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.unregisterGlobalShortcuts()
    this.jsonrpcRemote.off('IncomingMsg', this.onIncomingMessage)
    this.state.queue = []
    this.emitState()
    log.info('auto-managed orchestrator stopped')
  }

  getStateSnapshot(): AutoManagedRuntimeState {
    return {
      enabled: this.state.enabled,
      paused: this.state.paused,
      queue: this.state.queue.map(item => ({ ...item })),
      inFlightByChat: { ...this.state.inFlightByChat },
      lastProcessedMessageIdByChat: { ...this.state.lastProcessedMessageIdByChat },
      lastAutoAppliedRequestIdByChat: {
        ...this.state.lastAutoAppliedRequestIdByChat,
      },
      lastAutoSentRequestIdByChat: { ...this.state.lastAutoSentRequestIdByChat },
    }
  }

  pause(reason: 'shortcut' | 'ipc' | 'manual' = 'manual') {
    if (this.state.paused) {
      return false
    }
    this.state.paused = transitionPauseState(this.state.paused, 'pause')
    this.emitState()
    log.info('auto-managed paused', { reason })
    return true
  }

  resume(reason: 'shortcut' | 'ipc' | 'manual' = 'manual') {
    if (!this.state.paused) {
      return false
    }
    this.state.paused = transitionPauseState(this.state.paused, 'resume')
    this.emitState()
    log.info('auto-managed resumed', { reason })
    this.kick()
    return true
  }

  private registerGlobalShortcuts() {
    const pauseRegistered = globalShortcut.register(PAUSE_SHORTCUT, () => {
      this.pause('shortcut')
    })
    if (!pauseRegistered) {
      log.warn('failed to register pause shortcut', { shortcut: PAUSE_SHORTCUT })
    }

    const resumeRegistered = globalShortcut.register(RESUME_SHORTCUT, () => {
      this.resume('shortcut')
    })
    if (!resumeRegistered) {
      log.warn('failed to register resume shortcut', { shortcut: RESUME_SHORTCUT })
    }
  }

  private unregisterGlobalShortcuts() {
    globalShortcut.unregister(PAUSE_SHORTCUT)
    globalShortcut.unregister(RESUME_SHORTCUT)
  }

  private enqueueIncomingMessage(accountId: number, chatId: number, messageId: number) {
    if (!this.state.enabled || this.disposed) {
      return
    }
    const key = accountChatKey(accountId, chatId)
    const canEnqueue = shouldEnqueueIncomingMessage({
      messageId,
      lastEnqueuedMessageId: this.lastEnqueuedMessageIdByChat.get(key) ?? null,
      lastProcessedMessageId:
        this.state.lastProcessedMessageIdByChat[key] != null
          ? Number(this.state.lastProcessedMessageIdByChat[key])
          : null,
    })
    if (!canEnqueue) {
      return
    }
    this.lastEnqueuedMessageIdByChat.set(key, messageId)
    this.state.queue = enqueueLatestPerChat(this.state.queue, {
      accountId,
      chatId,
      messageId,
      enqueuedAt: Date.now(),
      retryCount: 0,
    })
    this.emitState()
    this.kick()
  }

  private kick() {
    if (
      this.processing ||
      this.disposed ||
      !canAdvanceQueue({
        enabled: this.state.enabled,
        paused: this.state.paused,
      })
    ) {
      return
    }
    this.processing = true
    void this.processLoop()
  }

  private async processLoop() {
    try {
      while (
        !this.disposed &&
        this.state.enabled &&
        !this.state.paused &&
        this.state.queue.length > 0
      ) {
        const nextItem = this.state.queue.shift()
        if (!nextItem) {
          break
        }
        this.emitState()
        const status = await this.processQueueItem(nextItem)
        if (status === 'requeue') {
          this.state.queue.unshift(nextItem)
          this.emitState()
          break
        }
      }
    } finally {
      this.processing = false
      if (!this.state.paused && this.state.queue.length > 0) {
        this.kick()
      }
    }
  }

  private async processQueueItem(item: AutoQueueItem): Promise<'done' | 'requeue'> {
    const key = accountChatKey(item.accountId, item.chatId)
    this.state.inFlightByChat[key] = {
      requestId: null,
      sourceMessageId: String(item.messageId),
      startedAt: Date.now(),
    }
    this.emitState()

    try {
      const payload = await this.buildMessageArrivedPayload(item)
      if (!payload) {
        this.markProcessed(key, item.messageId)
        return 'done'
      }
      if (this.state.paused) {
        return 'requeue'
      }

      const accepted = await this.bridgeClient.sendMessageArrivedEvent(payload)
      log.info('auto-managed bridge accepted response', {
        accountId: item.accountId,
        chatId: item.chatId,
        messageId: item.messageId,
        accepted: accepted.accepted,
        requestId: accepted.requestId,
        status: accepted.status,
      })
      if (!accepted.accepted) {
        return this.handleTransientFailure(item, key, 'bridge_not_accepted')
      }
      this.state.inFlightByChat[key] = {
        requestId: accepted.requestId,
        sourceMessageId: String(item.messageId),
        startedAt: Date.now(),
      }
      this.emitState()

      const chatBridgeId = bridgeChatId(item.accountId, item.chatId)
      const suggestion = await this.pollSuggestionUntilTerminal(
        chatBridgeId,
        key,
        accepted.requestId,
        String(item.messageId)
      )
      log.info('auto-managed suggestion terminal', {
        accountId: item.accountId,
        chatId: item.chatId,
        messageId: item.messageId,
        requestId: accepted.requestId,
        terminal:
          suggestion === 'paused'
            ? 'paused'
            : suggestion == null
              ? 'null'
              : suggestion.status,
        terminalRequestId:
          suggestion && suggestion !== 'paused' ? suggestion.requestId : null,
        terminalSourceMessageId:
          suggestion && suggestion !== 'paused' ? suggestion.sourceMessageId : null,
      })
      if (suggestion === 'paused') {
        return 'requeue'
      }
      if (!suggestion) {
        return this.handleTransientFailure(item, key, 'bridge_suggestion_unavailable')
      }

      if (suggestion.requestId) {
        this.state.lastAutoAppliedRequestIdByChat[key] = suggestion.requestId
      }

      if (
        shouldSkipSuggestionSend({
          suggestion,
          lastAutoSentRequestId: this.state.lastAutoSentRequestIdByChat[key] ?? null,
          lastAutoSentSourceMessageId:
            this.lastAutoSentSourceMessageIdByChat.get(key) ?? null,
        })
      ) {
        this.markProcessed(key, item.messageId)
        return 'done'
      }
      if (
        this.state.paused ||
        !suggestion.suggestedReply ||
        suggestion.suggestedReply.trim().length === 0
      ) {
        return this.state.paused ? 'requeue' : 'done'
      }

      await this.jsonrpcRemote.rpc.sendMsg(item.accountId, item.chatId, {
        file: null,
        filename: null,
        viewtype: null,
        html: null,
        location: null,
        overrideSenderName: null,
        quotedMessageId: null,
        quotedText: null,
        text: suggestion.suggestedReply,
      })
      log.info('auto-managed sendMsg invoked', {
        accountId: item.accountId,
        chatId: item.chatId,
        messageId: item.messageId,
        requestId: suggestion.requestId,
        sourceMessageId: suggestion.sourceMessageId,
      })

      this.state.lastAutoSentRequestIdByChat[key] = suggestion.requestId
      if (suggestion.sourceMessageId) {
        this.lastAutoSentSourceMessageIdByChat.set(key, suggestion.sourceMessageId)
      }
      void this.bridgeClient.markSuggestionUsed(chatBridgeId, {
        mode: 'sent_directly',
        requestId: suggestion.requestId,
        sourceMessageId: suggestion.sourceMessageId,
      })

      this.markProcessed(key, item.messageId)
      return 'done'
    } catch (error) {
      log.warn('failed to process auto-managed queue item', {
        accountId: item.accountId,
        chatId: item.chatId,
        messageId: item.messageId,
        error,
      })
      return this.handleTransientFailure(item, key, 'process_exception')
    } finally {
      this.state.inFlightByChat[key] = null
      this.emitState()
    }
  }

  private async handleTransientFailure(
    item: AutoQueueItem,
    accountChat: string,
    reason:
      | 'bridge_not_accepted'
      | 'bridge_suggestion_unavailable'
      | 'process_exception'
  ): Promise<'done' | 'requeue'> {
    const retryCount = Number(item.retryCount ?? 0)
    if (
      !canRetryTransientFailure({
        retryCount,
        maxRetries: MAX_TRANSIENT_RETRIES,
      })
    ) {
      log.warn('auto-managed giving up after retries', {
        accountChat,
        messageId: item.messageId,
        retryCount,
        maxRetries: MAX_TRANSIENT_RETRIES,
        reason,
      })
      this.markProcessed(accountChat, item.messageId)
      return 'done'
    }

    item.retryCount = retryCount + 1
    const delayMs = nextRetryDelayMs(item.retryCount)
    log.warn('auto-managed transient failure, scheduling retry', {
      accountChat,
      messageId: item.messageId,
      retryCount: item.retryCount,
      maxRetries: MAX_TRANSIENT_RETRIES,
      delayMs,
      reason,
    })

    await sleep(delayMs)
    return 'requeue'
  }

  private async buildMessageArrivedPayload(
    item: AutoQueueItem
  ): Promise<MessageArrivedEventPayload | null> {
    const latestMessage = await this.jsonrpcRemote.rpc.getMessage(
      item.accountId,
      item.messageId
    )
    if (!latestMessage || latestMessage.fromId === C.DC_CONTACT_ID_SELF) {
      return null
    }

    const contactId = String(latestMessage.fromId ?? '')
    const contactName = await this.resolveContactName(
      item.accountId,
      item.chatId,
      latestMessage.fromId
    )
    const recentMessages = await this.getRecentMessages(item.accountId, item.chatId)

    return {
      chat_id: bridgeChatId(item.accountId, item.chatId),
      contact_id: contactId,
      contact_name: contactName,
      latest_message: messageToBridgeMessage(latestMessage),
      recent_messages: recentMessages,
      session_summary: null,
      persona_id: null,
      metadata: {
        source: 'deltachat-desktop',
        account_id: String(item.accountId),
      },
    }
  }

  private async resolveContactName(
    accountId: number,
    chatId: number,
    fromId: number | null | undefined
  ) {
    if (
      typeof fromId === 'number' &&
      fromId > C.DC_CONTACT_ID_LAST_SPECIAL
    ) {
      try {
        const contact = await this.jsonrpcRemote.rpc.getContact(accountId, fromId)
        if (typeof contact?.displayName === 'string' && contact.displayName.length > 0) {
          return contact.displayName
        }
        if (typeof contact?.address === 'string' && contact.address.length > 0) {
          return contact.address
        }
      } catch (_error) {
        // continue
      }
    }

    try {
      const chat = await this.jsonrpcRemote.rpc.getBasicChatInfo(accountId, chatId)
      if (typeof chat?.name === 'string' && chat.name.length > 0) {
        return chat.name
      }
    } catch (_error) {
      // continue
    }

    return `chat-${chatId}`
  }

  private async getRecentMessages(accountId: number, chatId: number) {
    const messageListItems = await this.jsonrpcRemote.rpc.getMessageListItems(
      accountId,
      chatId,
      false,
      true
    )
    const recentIds = messageListItems
      .filter(item => item.kind === 'message')
      .map(item => Number(item.msg_id ?? item.msgId))
      .filter(id => Number.isFinite(id))
      .slice(-RECENT_MESSAGE_LIMIT)
    if (recentIds.length === 0) {
      return [] as BridgeMessage[]
    }

    const loadedMessages = await this.jsonrpcRemote.rpc.getMessages(
      accountId,
      recentIds
    )
    return recentIds
      .map(id => loadedMessages[id])
      .filter(message => message && message.kind === 'message')
      .map(message => messageToBridgeMessage(message))
  }

  private async pollSuggestionUntilTerminal(
    chatBridgeId: string,
    accountChat: string,
    expectedRequestId: string | null,
    expectedSourceMessageId: string | null
  ): Promise<BridgeSuggestionState | 'paused' | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    const requiresStrictMatch = expectedRequestId != null
    while (Date.now() <= deadline) {
      if (this.state.paused) {
        return 'paused'
      }
      const suggestion = await this.bridgeClient.getSuggestion(chatBridgeId)
      const matchesExpectedRequestId =
        expectedRequestId != null &&
        suggestion?.requestId != null &&
        suggestion.requestId === expectedRequestId
      const matchesExpectedSourceMessageId =
        expectedSourceMessageId != null &&
        suggestion?.sourceMessageId != null &&
        suggestion.sourceMessageId === expectedSourceMessageId
      const hasExpectation =
        expectedRequestId != null || expectedSourceMessageId != null

      if (
        suggestion &&
        suggestion.requestId &&
        (!hasExpectation ||
          !requiresStrictMatch ||
          matchesExpectedRequestId ||
          matchesExpectedSourceMessageId)
      ) {
        this.state.lastAutoAppliedRequestIdByChat[accountChat] = suggestion.requestId
      }
      if (
        suggestion &&
        hasExpectation &&
        requiresStrictMatch &&
        !matchesExpectedRequestId &&
        !matchesExpectedSourceMessageId
      ) {
        await sleep(POLL_INTERVAL_MS)
        continue
      }
      if (
        suggestion &&
        (suggestion.status === 'ready' ||
          suggestion.status === 'error' ||
          suggestion.status === 'stale')
      ) {
        return suggestion
      }
      await sleep(POLL_INTERVAL_MS)
    }
    return null
  }

  private markProcessed(accountChat: string, messageId: number) {
    this.state.lastProcessedMessageIdByChat[accountChat] = String(messageId)
    this.emitState()
  }

  private emitState() {
    mainWindow.send('auto-managed-state', this.getStateSnapshot())
  }
}
