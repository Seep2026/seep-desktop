export const DEFAULT_SEEP_CLAW_BRIDGE_BASE_URL = 'http://127.0.0.1:8765'

export type BridgeSuggestionStatus =
  | 'idle'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'error'

export type BridgeMessageRole = 'user' | 'assistant' | 'system' | 'unknown'

export interface BridgeMessage {
  message_id: string
  role: BridgeMessageRole
  text: string
  timestamp: string
}

export interface MessageArrivedEventPayload {
  chat_id: string
  contact_id: string | null
  contact_name: string | null
  latest_message: BridgeMessage
  recent_messages: BridgeMessage[]
  session_summary: null
  persona_id: null
  metadata: {
    source: 'deltachat-desktop'
  }
}

export interface BridgeSuggestionState {
  chatId: number
  status: BridgeSuggestionStatus
  requestId: string | null
  sourceMessageId: number | null
  suggestedReply: string | null
  error: string | null
  updatedAt: number | null
}

export interface BridgeFeedbackPayload {
  mode?: string
  reason?: string
  requestId?: string | null
  sourceMessageId?: string | null
}

type FetchLike = typeof fetch

export type BridgeRequest = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export type BridgeTransportResponse = {
  ok: boolean
  status: number
  bodyText: string
}

export type BridgeTransport = (
  request: BridgeRequest
) => Promise<BridgeTransportResponse | null>

const VALID_STATUSES = new Set<BridgeSuggestionStatus>([
  'idle',
  'queued',
  'generating',
  'ready',
  'stale',
  'error',
])

function readProcessEnvBridgeUrl(): string | null {
  const maybeProcess = (globalThis as any).process
  const value = maybeProcess?.env?.SEEP_CLAW_BRIDGE_URL
  if (typeof value !== 'string') {
    return null
  }
  return value
}

function readStorageBridgeUrl(): string | null {
  const maybeLocalStorage = (globalThis as any).localStorage
  if (!maybeLocalStorage || typeof maybeLocalStorage.getItem !== 'function') {
    return null
  }
  const value = maybeLocalStorage.getItem('seep_claw_bridge_base_url')
  if (typeof value !== 'string') {
    return null
  }
  return value
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function deduplicateUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const url of urls) {
    const normalized = normalizeBaseUrl(url)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function resolveSeepClawBridgeBaseUrl(): string {
  const raw =
    readStorageBridgeUrl() ??
    readProcessEnvBridgeUrl() ??
    DEFAULT_SEEP_CLAW_BRIDGE_BASE_URL
  return normalizeBaseUrl(raw)
}

export function resolveSeepClawBridgeBaseUrls(baseUrl?: string): string[] {
  const primary = normalizeBaseUrl(baseUrl ?? resolveSeepClawBridgeBaseUrl())
  const candidates = [primary]

  try {
    const parsed = new URL(primary)
    const isLoopback =
      parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'

    if (isLoopback && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      parsed.hostname =
        parsed.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
      candidates.push(parsed.toString())
    }
  } catch (_error) {
    // invalid URL; keep primary only
  }

  return deduplicateUrls(candidates)
}

function normalizeHeaders(
  headers: RequestInit['headers']
): Record<string, string> | undefined {
  if (!headers) {
    return undefined
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return headers as Record<string, string>
}

function bridgeErrorMessage(raw: any): string | null {
  if (typeof raw?.error?.message === 'string') {
    return raw.error.message
  }
  if (typeof raw?.error === 'string') {
    return raw.error
  }
  return null
}

function unwrapSuggestionEnvelope(raw: any): any {
  if (raw == null || typeof raw !== 'object') {
    return raw
  }
  if (raw.ok === false) {
    return {
      status: 'error',
      error: bridgeErrorMessage(raw) ?? 'bridge returned error',
    }
  }
  if (raw.suggestion && typeof raw.suggestion === 'object') {
    return raw.suggestion
  }
  return raw
}

export function normalizeSuggestionState(
  chatId: number,
  raw: any
): BridgeSuggestionState {
  const unwrappedRaw = unwrapSuggestionEnvelope(raw)
  if (unwrappedRaw == null || typeof unwrappedRaw !== 'object') {
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

  const statusFromRaw = unwrappedRaw.status
  const status: BridgeSuggestionStatus = VALID_STATUSES.has(statusFromRaw)
    ? statusFromRaw
    : unwrappedRaw.suggested_reply ||
        unwrappedRaw.suggestedReply ||
        unwrappedRaw.reply
      ? 'ready'
      : 'idle'

  const requestId =
    typeof unwrappedRaw.requestId === 'string'
      ? unwrappedRaw.requestId
      : typeof unwrappedRaw.request_id === 'string'
        ? unwrappedRaw.request_id
        : null

  const sourceMessageIdFromRaw =
    typeof unwrappedRaw.sourceMessageId === 'number'
      ? unwrappedRaw.sourceMessageId
      : typeof unwrappedRaw.source_message_id === 'number'
        ? unwrappedRaw.source_message_id
        : typeof unwrappedRaw.sourceMessageId === 'string'
          ? Number.parseInt(unwrappedRaw.sourceMessageId, 10)
          : typeof unwrappedRaw.source_message_id === 'string'
            ? Number.parseInt(unwrappedRaw.source_message_id, 10)
            : Number.NaN

  const sourceMessageId =
    Number.isFinite(sourceMessageIdFromRaw) ? sourceMessageIdFromRaw : null

  const suggestedReply =
    typeof unwrappedRaw.suggestedReply === 'string'
      ? unwrappedRaw.suggestedReply
      : typeof unwrappedRaw.suggested_reply === 'string'
        ? unwrappedRaw.suggested_reply
        : typeof unwrappedRaw.reply === 'string'
          ? unwrappedRaw.reply
          : typeof unwrappedRaw.suggestion === 'string'
            ? unwrappedRaw.suggestion
            : typeof unwrappedRaw.suggestion?.text === 'string'
              ? unwrappedRaw.suggestion.text
              : null

  const error =
    typeof unwrappedRaw.error === 'string'
      ? unwrappedRaw.error
      : typeof unwrappedRaw.error?.message === 'string'
        ? unwrappedRaw.error.message
        : null

  const updatedAt =
    typeof unwrappedRaw.updatedAt === 'number'
      ? unwrappedRaw.updatedAt
      : typeof unwrappedRaw.updated_at === 'number'
        ? unwrappedRaw.updated_at
        : typeof unwrappedRaw.updatedAt === 'string'
          ? Date.parse(unwrappedRaw.updatedAt)
          : typeof unwrappedRaw.updated_at === 'string'
            ? Date.parse(unwrappedRaw.updated_at)
            : Number.NaN

  return {
    chatId,
    status,
    requestId,
    sourceMessageId,
    suggestedReply,
    error,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  }
}

export class SeepClawBridgeClient {
  private readonly baseUrls: string[]
  private activeBaseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly bridgeTransport?: BridgeTransport
  private readonly requestTimeoutMs: number

  constructor(opts?: {
    baseUrl?: string
    fetchImpl?: FetchLike
    bridgeTransport?: BridgeTransport
    requestTimeoutMs?: number
  }) {
    this.baseUrls = resolveSeepClawBridgeBaseUrls(opts?.baseUrl)
    this.activeBaseUrl = this.baseUrls[0]
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.bridgeTransport = opts?.bridgeTransport
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 3000
  }

  private async requestWithBaseUrl(
    baseUrl: string,
    path: string,
    init?: RequestInit
  ): Promise<Response | null> {
    const url = `${baseUrl}${path}`
    const method = init?.method
    const headers = normalizeHeaders(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : undefined

    if (this.bridgeTransport) {
      const transportResponse = await this.bridgeTransport({
        url,
        method,
        headers,
        body,
        timeoutMs: this.requestTimeoutMs,
      })
      if (!transportResponse) {
        return null
      }
      return new Response(transportResponse.bodyText, {
        status: transportResponse.status,
      })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      })
    } catch (_error) {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Response | null> {
    const candidates = deduplicateUrls([
      this.activeBaseUrl,
      ...this.baseUrls,
    ])
    for (const baseUrl of candidates) {
      const response = await this.requestWithBaseUrl(baseUrl, path, init)
      if (response) {
        this.activeBaseUrl = baseUrl
        return response
      }
    }
    return null
  }

  async healthCheck(): Promise<boolean> {
    const response = await this.request('/health')
    if (!response) {
      return false
    }
    return response.ok
  }

  async sendMessageArrivedEvent(
    payload: MessageArrivedEventPayload
  ): Promise<boolean> {
    const response = await this.request('/events/message-arrived', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return Boolean(response?.ok)
  }

  async getSuggestion(chatId: number): Promise<BridgeSuggestionState | null> {
    const response = await this.request(`/suggestions/${chatId}`)
    if (!response) {
      return null
    }
    if (response.status === 404) {
      return normalizeSuggestionState(chatId, null)
    }
    if (!response.ok) {
      return normalizeSuggestionState(chatId, {
        status: 'error',
        error: `bridge returned ${response.status}`,
      })
    }
    let data: any = null
    try {
      data = await response.json()
    } catch (_error) {
      data = {
        status: 'error',
        error: 'invalid JSON response from bridge',
      }
    }
    return normalizeSuggestionState(chatId, data)
  }

  async regenerateSuggestion(chatId: number): Promise<boolean> {
    const response = await this.request(`/suggestions/${chatId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return Boolean(response?.ok)
  }

  async markSuggestionIgnored(
    chatId: number,
    payload: BridgeFeedbackPayload
  ): Promise<boolean> {
    const body = {
      request_id: payload.requestId ?? null,
      source_message_id: payload.sourceMessageId ?? null,
      ignored_at: new Date().toISOString(),
      reason: payload.reason ?? null,
      requestId: payload.requestId ?? null,
      sourceMessageId: payload.sourceMessageId ?? null,
    }
    const response = await this.request(`/suggestions/${chatId}/mark-ignored`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return Boolean(response?.ok)
  }

  async markSuggestionUsed(
    chatId: number,
    payload: BridgeFeedbackPayload
  ): Promise<boolean> {
    const body = {
      request_id: payload.requestId ?? null,
      source_message_id: payload.sourceMessageId ?? null,
      used_at: new Date().toISOString(),
      usage: payload.mode ? { mode: payload.mode } : undefined,
      requestId: payload.requestId ?? null,
      sourceMessageId: payload.sourceMessageId ?? null,
      mode: payload.mode,
    }
    const response = await this.request(`/suggestions/${chatId}/mark-used`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return Boolean(response?.ok)
  }
}

let sharedClient: SeepClawBridgeClient | null = null

export function getSeepClawBridgeClient() {
  if (!sharedClient) {
    sharedClient = new SeepClawBridgeClient()
  }
  return sharedClient
}
