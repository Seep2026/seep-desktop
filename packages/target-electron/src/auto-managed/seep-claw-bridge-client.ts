const DEFAULT_BASE_URL = 'http://127.0.0.1:8765'

export type BridgeSuggestionStatus =
  | 'idle'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'error'

export type BridgeMessageRole = 'user' | 'assistant' | 'system' | 'unknown'

export type BridgeMessage = {
  message_id: string
  role: BridgeMessageRole
  text: string
  timestamp: string
}

export type MessageArrivedEventPayload = {
  chat_id: string
  contact_id: string
  contact_name: string
  latest_message: BridgeMessage
  recent_messages: BridgeMessage[]
  session_summary: null
  persona_id: null
  metadata: {
    source: 'deltachat-desktop'
    account_id: string
  }
}

export type BridgeSuggestionState = {
  chatId: string
  status: BridgeSuggestionStatus
  requestId: string | null
  sourceMessageId: string | null
  suggestedReply: string | null
  error: string | null
  updatedAt: string | null
}

function normalizeBaseUrl(raw: string) {
  return raw.trim().replace(/\/+$/, '')
}

function resolveBaseUrls(baseUrl?: string) {
  const primary = normalizeBaseUrl(baseUrl ?? DEFAULT_BASE_URL)
  try {
    const parsed = new URL(primary)
    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:' &&
      parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== 'localhost'
    ) {
      return [primary]
    }
    if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost'
      return [primary, normalizeBaseUrl(parsed.toString())]
    }
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
      return [primary, normalizeBaseUrl(parsed.toString())]
    }
  } catch (_error) {
    return [primary]
  }
  return [primary]
}

function parseErrorMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const error = (raw as { error?: unknown }).error
  if (typeof error === 'string') {
    return error
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') {
      return message
    }
  }
  return null
}

function normalizeSuggestionStatus(raw: unknown): BridgeSuggestionStatus {
  if (
    raw === 'idle' ||
    raw === 'queued' ||
    raw === 'generating' ||
    raw === 'ready' ||
    raw === 'stale' ||
    raw === 'error'
  ) {
    return raw
  }
  return 'idle'
}

function unwrapSuggestionEnvelope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') {
    return raw
  }
  const value = raw as {
    ok?: unknown
    suggestion?: unknown
    error?: unknown
  }
  if (value.ok === false) {
    return {
      status: 'error',
      error: parseErrorMessage(raw) ?? 'bridge returned an error',
    }
  }
  if (value.suggestion && typeof value.suggestion === 'object') {
    return value.suggestion
  }
  return raw
}

function normalizeSuggestionState(
  chatId: string,
  raw: unknown
): BridgeSuggestionState {
  const unwrapped = unwrapSuggestionEnvelope(raw)
  if (!unwrapped || typeof unwrapped !== 'object') {
    return {
      chatId,
      status: 'idle',
      requestId: null,
      sourceMessageId: null,
      suggestedReply: null,
      error: null,
      updatedAt: null,
    }
  }

  const value = unwrapped as {
    status?: unknown
    request_id?: unknown
    requestId?: unknown
    source_message_id?: unknown
    sourceMessageId?: unknown
    suggested_reply?: unknown
    suggestedReply?: unknown
    error?: unknown
    updated_at?: unknown
    updatedAt?: unknown
  }

  const suggestedReply =
    typeof value.suggestedReply === 'string'
      ? value.suggestedReply
      : typeof value.suggested_reply === 'string'
        ? value.suggested_reply
        : null
  const error =
    typeof value.error === 'string'
      ? value.error
      : parseErrorMessage(value.error) ?? null

  return {
    chatId,
    status: normalizeSuggestionStatus(
      value.status ?? (suggestedReply ? 'ready' : 'idle')
    ),
    requestId:
      typeof value.requestId === 'string'
        ? value.requestId
        : typeof value.request_id === 'string'
          ? value.request_id
          : null,
    sourceMessageId:
      typeof value.sourceMessageId === 'string'
        ? value.sourceMessageId
        : typeof value.sourceMessageId === 'number'
          ? String(value.sourceMessageId)
          : typeof value.source_message_id === 'string'
            ? value.source_message_id
            : typeof value.source_message_id === 'number'
              ? String(value.source_message_id)
              : null,
    suggestedReply,
    error,
    updatedAt:
      typeof value.updatedAt === 'string'
        ? value.updatedAt
        : typeof value.updated_at === 'string'
          ? value.updated_at
          : null,
  }
}

export class SeepClawBridgeClient {
  private readonly baseUrls: string[]
  private activeBaseUrl: string
  private readonly timeoutMs: number

  constructor(opts?: {
    baseUrl?: string
    timeoutMs?: number
  }) {
    this.baseUrls = resolveBaseUrls(opts?.baseUrl)
    this.activeBaseUrl = this.baseUrls[0]
    this.timeoutMs = opts?.timeoutMs ?? 3000
  }

  private async requestWithBaseUrl(
    baseUrl: string,
    path: string,
    init?: RequestInit
  ) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      })
    } catch (_error) {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  private async request(path: string, init?: RequestInit) {
    for (const baseUrl of this.baseUrls) {
      const response = await this.requestWithBaseUrl(baseUrl, path, init)
      if (response) {
        this.activeBaseUrl = baseUrl
        return response
      }
    }
    return null
  }

  async healthCheck() {
    const response = await this.request('/health')
    if (!response?.ok) {
      return false
    }
    return true
  }

  async sendMessageArrivedEvent(payload: MessageArrivedEventPayload) {
    const response = await this.request('/events/message-arrived', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response) {
      return {
        accepted: false,
        requestId: null,
        status: null,
      }
    }

    const rawUnknown = await response.json().catch(() => null)
    const raw = rawUnknown as
      | { request_id?: string; requestId?: string; status?: string }
      | null
    if (!response.ok) {
      return {
        accepted: false,
        requestId: null,
        status: null,
      }
    }
    return {
      accepted: true,
      requestId:
        typeof raw?.requestId === 'string'
          ? raw.requestId
          : typeof raw?.request_id === 'string'
            ? raw.request_id
            : null,
      status: typeof raw?.status === 'string' ? raw.status : null,
    }
  }

  async getSuggestion(chatId: string) {
    const response = await this.request(
      `/suggestions/${encodeURIComponent(chatId)}`
    )
    if (!response) {
      return null
    }

    const raw = await response.json().catch(() => null)
    return normalizeSuggestionState(chatId, raw)
  }

  async markSuggestionUsed(
    chatId: string,
    payload: {
      mode: 'copied' | 'inserted' | 'edited_then_sent' | 'sent_directly' | 'unknown'
      requestId?: string | null
      sourceMessageId?: string | null
    }
  ) {
    const response = await this.request(
      `/suggestions/${encodeURIComponent(chatId)}/mark-used`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          request_id: payload.requestId ?? null,
          used_at: new Date().toISOString(),
          usage: { mode: payload.mode },
          source_message_id: payload.sourceMessageId ?? null,
        }),
      }
    )
    return Boolean(response?.ok)
  }

  getActiveBaseUrl() {
    return this.activeBaseUrl
  }
}
