import { z } from 'zod'
import { AppError } from '../../shared/errors'

const MATERIAL_RESPONSE_SCHEMA = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    password: z.string().min(1).max(1024).optional(),
    totpSecret: z.string().min(1).max(1024).optional(),
    mailboxAccess: z.string().min(1).max(4096).optional(),
  })
  .strict()

export interface AccountPoolMaterials {
  email: string
  password?: string
  totpSecret?: string
  mailboxAccess?: string
}

export interface AccountPoolResolver {
  resolve(email: string, signal?: AbortSignal): Promise<AccountPoolMaterials>
}

export interface AccountPoolBridgeClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase()
}

function accountPoolError(code: string, message: string, statusCode = 502, cause?: unknown): AppError {
  return new AppError(code, message, { statusCode, retryable: statusCode >= 500, cause })
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw accountPoolError('ACCOUNT_POOL_PROTOCOL_ERROR', '账号池响应内容过大。')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw accountPoolError('ACCOUNT_POOL_PROTOCOL_ERROR', '账号池响应内容过大。')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

export class AccountPoolBridgeClient implements AccountPoolResolver {
  readonly #baseUrl: URL
  readonly #token: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: AccountPoolBridgeClientOptions) {
    this.#baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`)
    if (
      this.#baseUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(this.#baseUrl.hostname) ||
      this.#baseUrl.pathname !== '/' ||
      this.#baseUrl.search ||
      this.#baseUrl.hash ||
      this.#baseUrl.username ||
      this.#baseUrl.password
    ) {
      throw new Error('Account pool bridge must use a loopback HTTP URL')
    }
    this.#token = options.token.trim()
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#fetch = options.fetchImpl ?? fetch
  }

  async resolve(email: string, signal?: AbortSignal): Promise<AccountPoolMaterials> {
    const normalized = normalizedEmail(email)
    if (!normalized) throw accountPoolError('ACCOUNT_POOL_EMAIL_INVALID', '账号邮箱格式无效。', 400)
    if (Buffer.byteLength(this.#token, 'utf8') < 32) {
      throw accountPoolError('ACCOUNT_POOL_NOT_CONFIGURED', '本地账号池桥接尚未配置。', 503)
    }

    const target = new URL('internal/account-materials', this.#baseUrl)
    target.searchParams.set('email', normalized)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), this.#timeoutMs)
    timer.unref?.()
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let response: Response
    try {
      response = await this.#fetch(target, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#token}`,
        },
        redirect: 'error',
        signal: requestSignal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (signal?.aborted) throw error
      throw accountPoolError(
        timeoutController.signal.aborted ? 'ACCOUNT_POOL_TIMEOUT' : 'ACCOUNT_POOL_UNAVAILABLE',
        timeoutController.signal.aborted ? '账号池查询超时。' : '无法连接本地账号池。',
        502,
        error,
      )
    }
    clearTimeout(timer)

    if (response.status === 401 || response.status === 403) {
      throw accountPoolError('ACCOUNT_POOL_UNAUTHORIZED', '本地账号池桥接认证失败。', response.status)
    }
    if (response.status === 404) {
      throw accountPoolError('ACCOUNT_POOL_EMAIL_NOT_FOUND', '账号池中未找到该邮箱。', 404)
    }
    if (response.status === 422) {
      throw accountPoolError('ACCOUNT_POOL_MATERIALS_MISSING', '账号池中没有可用登录材料。', 422)
    }
    if (!response.ok) {
      throw accountPoolError('ACCOUNT_POOL_UNAVAILABLE', `账号池返回错误（HTTP ${response.status}）。`, 502)
    }

    let payload: unknown
    try {
      const text = await readResponseText(response, 64 * 1024)
      payload = JSON.parse(text)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw accountPoolError('ACCOUNT_POOL_PROTOCOL_ERROR', '账号池响应格式无效。', 502, error)
    }

    const parsed = MATERIAL_RESPONSE_SCHEMA.safeParse(payload)
    if (!parsed.success || (parsed.data.email && normalizedEmail(parsed.data.email) !== normalized)) {
      throw accountPoolError('ACCOUNT_POOL_PROTOCOL_ERROR', '账号池响应与请求邮箱不一致。')
    }
    if (!parsed.data.password && !parsed.data.totpSecret && !parsed.data.mailboxAccess) {
      throw accountPoolError('ACCOUNT_POOL_MATERIALS_MISSING', '账号池中没有可用登录材料。', 422)
    }
    return { ...parsed.data, email: normalized }
  }
}
