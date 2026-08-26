import { z } from 'zod'
import { AppError } from '../../shared/errors'
import type { AccountPoolMaterials, AccountPoolResolver } from './bridge-client'
import {
  PersistentAccountPoolBrowserSession,
  type AccountPoolBrowserResponse,
  type AccountPoolBrowserSession,
} from './browser-session'

const SETTING_ORIGIN = 'account_pool_portal_origin'
const MAX_CONFIG_RESPONSE_BYTES = 64 * 1024
const MAX_RECORD_RESPONSE_BYTES = 256 * 1024
const MAX_REMOTE_RECORDS = 10_000
const RECORD_PAGE_SIZE = 100
const RATE_LIMIT_RETRY_DELAYS_MS = [500, 4_500, 15_000, 40_000] as const
const SECRET_READ_INTERVAL_MS = 3_100

const authConfigSchema = z
  .object({
    ssoEnabled: z.boolean(),
    navigatorSsoEnabled: z.boolean(),
    passwordLoginEnabled: z.boolean(),
  })
  .passthrough()

const authenticatedUserSchema = z
  .object({
    user: z
      .object({
        id: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough()

const recordSummarySchema = z
  .object({
    id: z.number().int().positive(),
    // The pool contains legacy addresses that its own API accepts but Zod's
    // RFC-oriented email validator rejects. Exact matching below still
    // normalizes the requested value, so one legacy row must not invalidate
    // the entire response page.
    email: z.string().trim().min(1).max(320),
    hasPassword: z.boolean().optional(),
    hasVerification: z.boolean().optional(),
    hasEmailToken: z.boolean().optional(),
  })
  .passthrough()

const recordPageSchema = z
  .object({
    items: z.array(recordSummarySchema).max(RECORD_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  })
  .passthrough()

const secretResponseSchema = z.object({ value: z.string() }).passthrough()

export interface AccountPoolPortalStatus {
  configured: boolean
  connected: boolean
  origin: string | null
  lastCheckedAt: string | null
  lastError: { code: string; message: string } | null
}

export interface AccountPoolPortalSettings {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

export interface AccountPoolPortalServiceOptions {
  settings: AccountPoolPortalSettings
  browserSession?: AccountPoolBrowserSession
  profileDir?: string
  timeoutMs?: number
}

export interface AccountPoolPortalConnectInput {
  origin: string
  foreground?: boolean
  reuseOnly?: boolean
}

export interface AccountPoolMailboxOriginAudit {
  totalRecords: number
  recordsWithMailboxAccess: number
  invalidAccessValues: number
  readFailures: number
  origins: Array<{ origin: string; count: number; pathTemplates: string[] }>
}

export interface AccountPoolMailboxOriginInspection {
  email: string
  hasMailboxAccess: boolean
  validAccessUrl: boolean
  origin: string | null
  pathTemplate: string | null
  queryParameterNames: string[]
}

function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new AppError('ACCOUNT_POOL_ORIGIN_INVALID', '号池地址无效。', { statusCode: 400 })
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new AppError('ACCOUNT_POOL_ORIGIN_INVALID', '号池地址必须是独立的 HTTP 或 HTTPS 站点根地址。', {
      statusCode: 400,
    })
  }
  return url.origin
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase()
}

function mailboxPathTemplate(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length === 0) return '/'
  const publicPrefixes = new Set(['api', 'code', 'console', 'icloud', 'mailbox', 'messages', 'p', 'quick-mail', 's'])
  return `/${segments.map((segment, index) => index === 0 && publicPrefixes.has(segment) ? segment : '<value>').join('/')}`
}

function portalError(code: string, message: string, statusCode = 502, cause?: unknown): AppError {
  return new AppError(code, message, { statusCode, retryable: statusCode >= 500, cause })
}

function readResponseJson(response: AccountPoolBrowserResponse, maxBytes: number): unknown {
  if (!/application\/json/i.test(response.contentType)) {
    throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池网页没有返回 JSON。')
  }
  if (Buffer.byteLength(response.body, 'utf8') > maxBytes) {
    throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池响应内容过大。')
  }
  if (!response.body.trim()) return null
  try {
    return JSON.parse(response.body)
  } catch (error) {
    throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池返回了无效响应。', 502, error)
  }
}

function waitsForBrowserLogin(error: AppError): boolean {
  return (
    error.statusCode === 401 ||
    error.statusCode === 403 ||
    error.code === 'ACCOUNT_POOL_PAGE_NOT_READY' ||
    error.code === 'ACCOUNT_POOL_BROWSER_CLOSED'
  )
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 }))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class AccountPoolPortalService implements AccountPoolResolver {
  readonly #settings: AccountPoolPortalSettings
  readonly #browser: AccountPoolBrowserSession
  #origin: string | null = null
  #connected = false
  #lastCheckedAt: string | null = null
  #lastError: AccountPoolPortalStatus['lastError'] = null
  readonly #lastSecretReadAt = new Map<string, number>()

  constructor(options: AccountPoolPortalServiceOptions) {
    this.#settings = options.settings
    if (!options.browserSession && !options.profileDir) {
      throw new Error('Account pool browser profile is required')
    }
    this.#browser = options.browserSession ?? new PersistentAccountPoolBrowserSession({
      profileDir: options.profileDir!,
      timeoutMs: options.timeoutMs,
    })
  }

  restore(): void {
    const value = this.#settings.getSetting(SETTING_ORIGIN)
    if (!value) return
    try {
      this.#origin = normalizeOrigin(value)
    } catch {
      this.#settings.deleteSetting(SETTING_ORIGIN)
    }
  }

  async restoreSession(): Promise<void> {
    const origin = this.#origin
    if (!origin) return
    try {
      await this.#browser.open(origin, { foreground: false })
      await this.#verifyPortal(origin)
      await this.#verifySession(origin)
      this.#markConnected()
    } catch (error) {
      this.#markFailure(this.#normalizeRequestError(error))
    }
  }

  status(): AccountPoolPortalStatus {
    return {
      configured: Boolean(this.#origin),
      connected: this.#connected,
      origin: this.#origin,
      lastCheckedAt: this.#lastCheckedAt,
      lastError: this.#lastError ? { ...this.#lastError } : null,
    }
  }

  async connect(input: AccountPoolPortalConnectInput): Promise<AccountPoolPortalStatus> {
    const origin = normalizeOrigin(input.origin)
    const previousOrigin = this.#origin
    try {
      if (input.reuseOnly) {
        if (this.#browser.requireExisting) this.#browser.requireExisting(origin)
        else if (this.#browser.activeOrigin !== origin) {
          throw portalError(
            'ACCOUNT_POOL_BROWSER_NOT_CONNECTED',
            '当前没有可复用的号池网页会话，请点击“连接”建立一次会话。',
            409,
          )
        }
      }
      else await this.#browser.open(origin, { foreground: input.foreground !== false })
      await this.#verifyPortal(origin)
      this.#settings.setSetting(SETTING_ORIGIN, origin)
      this.#origin = origin
      try {
        await this.#verifySession(origin)
        this.#markConnected()
      } catch (error) {
        const appError = this.#normalizeRequestError(error)
        this.#markFailure(appError)
        if (!waitsForBrowserLogin(appError)) throw appError
      }
      return this.status()
    } catch (error) {
      const appError = this.#normalizeRequestError(error)
      if (this.#origin !== origin) {
        this.#origin = previousOrigin
        if (previousOrigin) this.#settings.setSetting(SETTING_ORIGIN, previousOrigin)
        else this.#settings.deleteSetting(SETTING_ORIGIN)
      }
      this.#markFailure(appError)
      throw appError
    }
  }

  async disconnect(): Promise<void> {
    await this.#browser.close()
    this.#settings.deleteSetting(SETTING_ORIGIN)
    this.#origin = null
    this.#connected = false
    this.#lastCheckedAt = null
    this.#lastError = null
  }

  async shutdown(): Promise<void> {
    await this.#browser.close()
  }

  async resolve(email: string, signal?: AbortSignal): Promise<AccountPoolMaterials> {
    const origin = this.#origin
    if (!origin) {
      throw portalError('ACCOUNT_POOL_NOT_CONFIGURED', '纯号池系统尚未配置。', 503)
    }
    const requestedEmail = normalizedEmail(email)
    if (!requestedEmail) {
      throw portalError('ACCOUNT_POOL_EMAIL_INVALID', '账号邮箱格式无效。', 400)
    }

    try {
      await this.#browser.open(origin, { foreground: false })
      await this.#verifySession(origin, signal)
      const record = await this.#findExactRecord(origin, requestedEmail, signal)
      const [password, totpSecret, mailboxAccess] = await Promise.all([
        record.hasPassword === false
          ? Promise.resolve('')
          : this.#readSecret(origin, record.id, 'password', 1024, signal),
        record.hasVerification === false
          ? Promise.resolve('')
          : this.#readSecret(origin, record.id, 'verification', 1024, signal),
        record.hasEmailToken === false
          ? Promise.resolve('')
          : this.#readSecret(origin, record.id, 'emailToken', 4096, signal),
      ])
      if (!password && !totpSecret && !mailboxAccess) {
        throw portalError('ACCOUNT_POOL_MATERIALS_MISSING', '账号池中没有可用登录材料。', 422)
      }
      this.#markConnected()
      return {
        email: requestedEmail,
        ...(password ? { password } : {}),
        ...(totpSecret ? { totpSecret } : {}),
        ...(mailboxAccess ? { mailboxAccess } : {}),
      }
    } catch (error) {
      const appError = this.#normalizeRequestError(error, signal)
      this.#markFailure(appError)
      throw appError
    }
  }

  async auditMailboxOrigins(signal?: AbortSignal): Promise<AccountPoolMailboxOriginAudit> {
    const origin = this.#origin
    if (!origin) throw portalError('ACCOUNT_POOL_NOT_CONFIGURED', '纯号池系统尚未配置。', 503)
    await this.#browser.open(origin, { foreground: false })
    await this.#verifySession(origin, signal)

    const records: z.infer<typeof recordSummarySchema>[] = []
    let page = 1
    let total: number
    do {
      const target = new URL('/api/records', origin)
      target.searchParams.set('page', String(page))
      target.searchParams.set('limit', String(RECORD_PAGE_SIZE))
      const response = await this.#request(target, signal)
      const payload = readResponseJson(response, MAX_RECORD_RESPONSE_BYTES)
      this.#throwForDataResponse(response)
      const parsed = recordPageSchema.safeParse(payload)
      if (!parsed.success || parsed.data.page !== page || parsed.data.limit !== RECORD_PAGE_SIZE) {
        throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池账号列表响应格式无效。')
      }
      total = parsed.data.total
      if (total > MAX_REMOTE_RECORDS) {
        throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池记录数量超过安全审计上限。')
      }
      records.push(...parsed.data.items)
      page += 1
    } while (records.length < total)

    const aggregate = new Map<string, { count: number; paths: Set<string> }>()
    let recordsWithMailboxAccess = 0
    let invalidAccessValues = 0
    let readFailures = 0
    const candidates = records.filter((record) => record.hasEmailToken !== false)
    for (let offset = 0; offset < candidates.length; offset += 8) {
      const batch = candidates.slice(offset, offset + 8)
      await Promise.all(batch.map(async (record) => {
        try {
          const value = await this.#readSecret(origin, record.id, 'emailToken', 4096, signal)
          if (!value) return
          recordsWithMailboxAccess += 1
          let url: URL
          try {
            url = new URL(value.trim())
          } catch {
            invalidAccessValues += 1
            return
          }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            invalidAccessValues += 1
            return
          }
          const current = aggregate.get(url.origin) ?? { count: 0, paths: new Set<string>() }
          current.count += 1
          current.paths.add(mailboxPathTemplate(url))
          aggregate.set(url.origin, current)
        } catch (error) {
          if (signal?.aborted) throw error
          readFailures += 1
        }
      }))
    }

    return {
      totalRecords: total,
      recordsWithMailboxAccess,
      invalidAccessValues,
      readFailures,
      origins: [...aggregate.entries()]
        .map(([mailboxOrigin, value]) => ({
          origin: mailboxOrigin,
          count: value.count,
          pathTemplates: [...value.paths].sort(),
        }))
        .sort((left, right) => right.count - left.count || left.origin.localeCompare(right.origin)),
    }
  }

  async inspectMailboxOrigin(email: string, signal?: AbortSignal): Promise<AccountPoolMailboxOriginInspection> {
    const origin = this.#origin
    if (!origin) throw portalError('ACCOUNT_POOL_NOT_CONFIGURED', '纯号池系统尚未配置。', 503)
    const requestedEmail = normalizedEmail(email)
    if (!requestedEmail) throw portalError('ACCOUNT_POOL_EMAIL_INVALID', '账号邮箱格式无效。', 400)
    await this.#browser.open(origin, { foreground: false })
    await this.#verifySession(origin, signal)
    const record = await this.#findExactRecord(origin, requestedEmail, signal)
    if (record.hasEmailToken === false) {
      return {
        email: requestedEmail,
        hasMailboxAccess: false,
        validAccessUrl: false,
        origin: null,
        pathTemplate: null,
        queryParameterNames: [],
      }
    }
    const value = await this.#readSecret(origin, record.id, 'emailToken', 4096, signal)
    let accessUrl: URL
    try {
      accessUrl = new URL(value.trim())
    } catch {
      return {
        email: requestedEmail,
        hasMailboxAccess: Boolean(value),
        validAccessUrl: false,
        origin: null,
        pathTemplate: null,
        queryParameterNames: [],
      }
    }
    const validAccessUrl =
      ['http:', 'https:'].includes(accessUrl.protocol) && !accessUrl.username && !accessUrl.password
    return {
      email: requestedEmail,
      hasMailboxAccess: Boolean(value),
      validAccessUrl,
      origin: validAccessUrl ? accessUrl.origin : null,
      pathTemplate: validAccessUrl ? mailboxPathTemplate(accessUrl) : null,
      queryParameterNames: validAccessUrl ? [...new Set(accessUrl.searchParams.keys())].sort() : [],
    }
  }

  async #verifyPortal(origin: string): Promise<void> {
    const response = await this.#request(new URL('/api/auth/config', origin))
    const payload = readResponseJson(response, MAX_CONFIG_RESPONSE_BYTES)
    if (!response.ok) {
      throw portalError(
        response.status === 404 ? 'ACCOUNT_POOL_NOT_SUPPORTED' : 'ACCOUNT_POOL_UNAVAILABLE',
        response.status === 404
          ? '该地址不是可连接的号池系统。'
          : `号池系统返回错误（HTTP ${response.status}）。`,
        response.status === 404 ? 400 : 502,
      )
    }
    if (!authConfigSchema.safeParse(payload).success) {
      throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池系统返回了无效的登录配置。')
    }
  }

  async #verifySession(origin: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#request(new URL('/api/me', origin), signal)
    const payload = readResponseJson(response, MAX_CONFIG_RESPONSE_BYTES)
    if (response.status === 401 || response.status === 403) {
      throw portalError('ACCOUNT_POOL_LOGIN_REQUIRED', '号池网页尚未登录，请在打开的窗口完成免密登录。', 401)
    }
    if (!response.ok) {
      throw portalError('ACCOUNT_POOL_UNAVAILABLE', `号池网页状态检查失败（HTTP ${response.status}）。`)
    }
    if (!authenticatedUserSchema.safeParse(payload).success) {
      throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池网页登录状态响应格式无效。')
    }
  }

  async #findExactRecord(
    origin: string,
    email: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof recordSummarySchema>> {
    const exact: z.infer<typeof recordSummarySchema>[] = []
    let page = 1
    let total: number
    do {
      const target = new URL('/api/records', origin)
      target.searchParams.set('q', email)
      target.searchParams.set('page', String(page))
      target.searchParams.set('limit', String(RECORD_PAGE_SIZE))
      const response = await this.#request(target, signal)
      const payload = readResponseJson(response, MAX_RECORD_RESPONSE_BYTES)
      this.#throwForDataResponse(response)
      const parsed = recordPageSchema.safeParse(payload)
      if (!parsed.success || parsed.data.page !== page || parsed.data.limit !== RECORD_PAGE_SIZE) {
        throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池账号列表响应格式无效。')
      }
      total = parsed.data.total
      if (total > MAX_REMOTE_RECORDS) {
        throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池账号查询结果过多，无法安全确定唯一记录。')
      }
      exact.push(...parsed.data.items.filter((item) => normalizedEmail(item.email) === email))
      if (exact.length > 1 || parsed.data.items.length === 0) break
      page += 1
    } while ((page - 1) * RECORD_PAGE_SIZE < total)

    if (exact.length === 0) {
      throw portalError('ACCOUNT_POOL_EMAIL_NOT_FOUND', '账号池中未找到该邮箱。', 404)
    }
    if (exact.length !== 1) {
      throw portalError('ACCOUNT_POOL_EMAIL_NOT_UNIQUE', '账号池中该邮箱记录不唯一。', 409)
    }
    return exact[0]!
  }

  async #readSecret(
    origin: string,
    recordId: number,
    field: 'password' | 'verification' | 'emailToken',
    maxLength: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const lastReadAt = this.#lastSecretReadAt.get(field) ?? 0
    const waitMs = SECRET_READ_INTERVAL_MS - (Date.now() - lastReadAt)
    if (waitMs > 0) await waitForRetry(waitMs, signal)
    const target = new URL(`/api/records/${recordId}/secret`, origin)
    target.searchParams.set('field', field)
    this.#lastSecretReadAt.set(field, Date.now())
    const response = await this.#request(target, signal)
    const payload = readResponseJson(response, MAX_RECORD_RESPONSE_BYTES)
    this.#throwForDataResponse(response)
    const parsed = secretResponseSchema.safeParse(payload)
    if (!parsed.success || parsed.data.value.length > maxLength) {
      throw portalError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池登录材料响应格式无效。')
    }
    return parsed.data.value
  }

  #throwForDataResponse(response: AccountPoolBrowserResponse): void {
    if (response.status === 401 || response.status === 403) {
      throw portalError('ACCOUNT_POOL_LOGIN_REQUIRED', '号池网页登录已失效，请重新打开并登录。', 401)
    }
    if (response.status === 404) {
      throw portalError('ACCOUNT_POOL_EMAIL_NOT_FOUND', '账号池中未找到该邮箱。', 404)
    }
    if (response.status === 429) {
      throw portalError('ACCOUNT_POOL_RATE_LIMITED', '号池读取请求过多，请稍后重试。', 429)
    }
    if (!response.ok) {
      throw portalError('ACCOUNT_POOL_UNAVAILABLE', `号池读取返回错误（HTTP ${response.status}）。`)
    }
  }

  async #request(target: URL, signal?: AbortSignal): Promise<AccountPoolBrowserResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.#browser.request(target, signal)
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt]
        if (response.status !== 429 || delay === undefined) return response
        await waitForRetry(delay, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        throw this.#normalizeRequestError(error, signal)
      }
    }
  }

  #normalizeRequestError(error: unknown, signal?: AbortSignal): AppError {
    if (error instanceof AppError) return error
    return portalError(
      signal?.aborted ? 'TASK_CANCELLED' : 'ACCOUNT_POOL_UNAVAILABLE',
      signal?.aborted ? '任务已取消。' : '无法连接号池网页。',
      signal?.aborted ? 409 : 502,
      error,
    )
  }

  #markConnected(): void {
    this.#connected = true
    this.#lastCheckedAt = new Date().toISOString()
    this.#lastError = null
  }

  #markFailure(error: AppError): void {
    this.#connected = false
    this.#lastCheckedAt = new Date().toISOString()
    this.#lastError = { code: error.code, message: error.message }
  }
}
