import { AppError } from '../../shared/errors'

export interface BackendRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string
  admin?: boolean
  signal?: AbortSignal
}

const BACKEND_REQUEST_TIMEOUT_MS = 30_000

function requestSignal(parent?: AbortSignal): {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
} {
  const timeoutController = new AbortController()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    timeoutController.abort()
  }, BACKEND_REQUEST_TIMEOUT_MS)
  timer.unref()
  return {
    signal: parent ? AbortSignal.any([parent, timeoutController.signal]) : timeoutController.signal,
    timedOut: () => didTimeOut,
    dispose: () => clearTimeout(timer),
  }
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  if (typeof record.code !== 'number') return payload
  if (record.code === 0) return record.data
  throw new AppError(
    typeof record.code === 'string' ? record.code : `BACKEND_${record.code}`,
    String(record.message || record.detail || '后台请求失败。'),
  )
}

export class BackendTransport {
  readonly #baseUrl: URL
  readonly #fetch: typeof fetch

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#baseUrl = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    this.#fetch = fetchImpl
  }

  async request<T>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    const normalizedPath = path.replace(/^\/+/, '')
    const url = new URL(normalizedPath, this.#baseUrl)
    if (url.origin !== this.#baseUrl.origin) {
      throw new AppError('BACKEND_ORIGIN_INVALID', '后台请求目标不受信任。')
    }

    const headers = new Headers({ Accept: 'application/json' })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
    if (options.admin) headers.set('X-Admin-UI-Request', '1')

    const method = options.method ?? 'GET'
    const maxAttempts = method === 'GET' ? 2 : 1
    let response: Response | undefined
    let networkError: unknown
    let timedOut = false
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptSignal = requestSignal(options.signal)
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          redirect: 'manual',
          signal: attemptSignal.signal,
        })
        break
      } catch (error) {
        networkError = error
        timedOut = attemptSignal.timedOut()
        if (options.signal?.aborted) break
        if (timedOut) break
      } finally {
        attemptSignal.dispose()
      }
    }
    if (!response) {
      if (timedOut) {
        throw new AppError('BACKEND_TIMEOUT', '后台请求超过 30 秒，请检查网络后重试。', {
          statusCode: 504,
          retryable: true,
          cause: networkError,
        })
      }
      throw new AppError('BACKEND_NETWORK_ERROR', '无法连接后台服务。', {
        statusCode: 502,
        retryable: true,
        cause: networkError,
      })
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AppError('BACKEND_REDIRECT_REJECTED', '后台返回了不受信任的重定向。', { statusCode: 502 })
    }

    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json') ? await response.json() : await response.text()
    if (!response.ok) {
      const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      const message = String(record.message || record.detail || `后台请求失败（HTTP ${response.status}）。`)
      if (response.status === 401) throw new AppError('BACKEND_UNAUTHORIZED', message, { statusCode: 401 })
      if (response.status === 403) throw new AppError('BACKEND_FORBIDDEN', message, { statusCode: 403 })
      if (response.status === 423) {
        throw new AppError('ADMIN_COMPLIANCE_REQUIRED', '请先在后台完成管理员合规确认。', { statusCode: 423 })
      }
      const backendCode =
        (typeof record.error === 'string' && record.error) ||
        (typeof record.code === 'string' && record.code) ||
        `BACKEND_HTTP_${response.status}`
      throw new AppError(backendCode, message, {
        statusCode: response.status,
        retryable: response.status >= 500,
        details: { backendStatus: response.status },
      })
    }

    return unwrapPayload(payload) as T
  }
}

export interface AccessTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>
}

export interface BackendRequester {
  request<T>(path: string, options?: Omit<BackendRequestOptions, 'token'>): Promise<T>
}

export class AuthorizedBackendClient implements BackendRequester {
  constructor(
    private readonly transport: BackendTransport,
    private readonly session: AccessTokenProvider,
  ) {}

  async request<T>(path: string, options: Omit<BackendRequestOptions, 'token'> = {}): Promise<T> {
    const token = await this.session.getAccessToken()
    try {
      return await this.transport.request<T>(path, { ...options, token, admin: options.admin ?? true })
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'BACKEND_UNAUTHORIZED') throw error
      const refreshed = await this.session.getAccessToken(true)
      return this.transport.request<T>(path, { ...options, token: refreshed, admin: options.admin ?? true })
    }
  }
}
