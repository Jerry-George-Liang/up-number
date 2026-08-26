import { chmod, mkdir } from 'node:fs/promises'
import { basename, dirname, parse, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { z } from 'zod'
import { AppError } from '../../shared/errors'

const MAX_RESPONSE_BYTES = 1024 * 1024
const BROWSER_START_TIMEOUT_MS = 30_000

const browserResponseSchema = z
  .object({
    ok: z.boolean(),
    status: z.number().int().min(0).max(599),
    url: z.string().max(4096),
    contentType: z.string().max(1024),
    body: z.string().max(MAX_RESPONSE_BYTES),
    redirected: z.boolean(),
    type: z.string().max(64),
  })
  .strict()

export interface AccountPoolBrowserResponse {
  ok: boolean
  status: number
  url: string
  contentType: string
  body: string
  redirected: boolean
  type: string
}

export interface AccountPoolBrowserSession {
  readonly activeOrigin: string | null
  open(origin: string, options?: { foreground?: boolean }): Promise<void>
  requireExisting?(origin: string): void
  request(target: URL, signal?: AbortSignal): Promise<AccountPoolBrowserResponse>
  close(): Promise<void>
}

type LaunchPersistentContext = typeof chromium.launchPersistentContext

export interface PersistentAccountPoolBrowserSessionOptions {
  profileDir: string
  timeoutMs?: number
  launchPersistentContext?: LaunchPersistentContext
}

function validateProfileDir(value: string): string {
  const profileDir = resolve(value)
  const root = parse(profileDir).root
  if (basename(profileDir) !== 'account-pool-profile' || dirname(profileDir) === root) {
    throw new Error('Account pool browser profile path is not allowed')
  }
  return profileDir
}

function pageOrigin(page: Page): string | null {
  try {
    return new URL(page.url()).origin
  } catch {
    return null
  }
}

function cancelledError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export class PersistentAccountPoolBrowserSession implements AccountPoolBrowserSession {
  readonly #profileDir: string
  readonly #timeoutMs: number
  readonly #launchPersistentContext: LaunchPersistentContext
  #context: BrowserContext | null = null
  #page: Page | null = null
  #origin: string | null = null
  #headless = false
  #opening: Promise<Page> | null = null

  constructor(options: PersistentAccountPoolBrowserSessionOptions) {
    this.#profileDir = validateProfileDir(options.profileDir)
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#launchPersistentContext = options.launchPersistentContext
      ?? ((...args) => chromium.launchPersistentContext(...args))
  }

  get activeOrigin(): string | null {
    return this.#page && !this.#page.isClosed() ? this.#origin : null
  }

  requireExisting(origin: string): void {
    if (this.activeOrigin !== origin) {
      throw new AppError(
        'ACCOUNT_POOL_BROWSER_NOT_CONNECTED',
        '当前没有可复用的号池网页会话，请点击“连接”建立一次会话。',
        { statusCode: 409 },
      )
    }
  }

  async open(origin: string, options: { foreground?: boolean } = {}): Promise<void> {
    const foreground = options.foreground !== false
    if (this.activeOrigin === origin && this.#page) {
      if (foreground && this.#headless) {
        await this.close()
      } else {
        if (foreground) await this.#page.bringToFront()
        return
      }
    }

    if (this.#opening) {
      await this.#opening.catch(() => undefined)
      if (this.activeOrigin === origin && this.#page) {
        if (foreground && this.#headless) {
          await this.close()
        } else {
          if (foreground) await this.#page.bringToFront()
          return
        }
      }
    }

    if (this.#context) await this.close()
    this.#opening = this.#start(origin, foreground).finally(() => {
      this.#opening = null
    })
    await this.#opening
  }

  async request(target: URL, signal?: AbortSignal): Promise<AccountPoolBrowserResponse> {
    if (signal?.aborted) throw cancelledError(signal)
    await this.open(target.origin, { foreground: false })
    const page = this.#page
    if (!page || page.isClosed()) {
      throw new AppError('ACCOUNT_POOL_BROWSER_CLOSED', '号池浏览器已经关闭，请重新打开并检查状态。', {
        statusCode: 409,
      })
    }
    if (pageOrigin(page) !== target.origin) {
      await page.bringToFront()
      throw new AppError(
        'ACCOUNT_POOL_PAGE_NOT_READY',
        '请先在号池浏览器中完成免密登录，再重新检查网页状态。',
        { statusCode: 409 },
      )
    }

    const evaluate = page.evaluate(
      async ({ url, timeoutMs, maxBytes }) => {
        const timeout = new AbortController()
        const timer = globalThis.setTimeout(() => timeout.abort(), timeoutMs)
        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            redirect: 'manual',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: timeout.signal,
          })
          const body = await response.text()
          if (new TextEncoder().encode(body).byteLength > maxBytes) {
            throw new Error('ACCOUNT_POOL_RESPONSE_TOO_LARGE')
          }
          return {
            ok: response.ok,
            status: response.status,
            url: response.url,
            contentType: response.headers.get('content-type') ?? '',
            body,
            redirected: response.redirected,
            type: response.type,
          }
        } finally {
          globalThis.clearTimeout(timer)
        }
      },
      { url: target.href, timeoutMs: this.#timeoutMs, maxBytes: MAX_RESPONSE_BYTES },
    )

    let abortListener: (() => void) | undefined
    try {
      const raw = signal
        ? await Promise.race([
            evaluate,
            new Promise<never>((_resolve, reject) => {
              abortListener = () => reject(cancelledError(signal))
              signal.addEventListener('abort', abortListener, { once: true })
            }),
          ])
        : await evaluate
      if (signal?.aborted) throw cancelledError(signal)
      const parsed = browserResponseSchema.safeParse(raw)
      if (!parsed.success) {
        throw new AppError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池网页返回了无效响应。', { statusCode: 502 })
      }
      const response = parsed.data
      let responseOrigin: string
      try {
        responseOrigin = new URL(response.url || target.href).origin
      } catch {
        throw new AppError('ACCOUNT_POOL_PROTOCOL_ERROR', '号池网页返回了无效地址。', { statusCode: 502 })
      }
      if (
        response.redirected ||
        response.type === 'opaqueredirect' ||
        response.status === 0 ||
        responseOrigin !== target.origin
      ) {
        throw new AppError('ACCOUNT_POOL_ORIGIN_REJECTED', '号池接口响应离开了当前网页，已停止读取。', {
          statusCode: 502,
        })
      }
      return response
    } catch (error) {
      if (error instanceof AppError || signal?.aborted) throw error
      throw new AppError('ACCOUNT_POOL_BROWSER_REQUEST_FAILED', '无法通过号池网页读取数据。', {
        statusCode: 502,
        retryable: true,
        cause: error,
      })
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener)
    }
  }

  async close(): Promise<void> {
    if (this.#opening) await this.#opening.catch(() => undefined)
    const context = this.#context
    this.#context = null
    this.#page = null
    this.#origin = null
    this.#headless = false
    await context?.close().catch(() => undefined)
  }

  async #start(origin: string, foreground: boolean): Promise<Page> {
    await mkdir(this.#profileDir, { recursive: true, mode: 0o700 })
    await chmod(this.#profileDir, 0o700)
    let context: BrowserContext | null = null
    try {
      context = await this.#launchPersistentContext(this.#profileDir, {
        headless: !foreground,
        channel: 'chrome',
        acceptDownloads: false,
        chromiumSandbox: true,
        timeout: BROWSER_START_TIMEOUT_MS,
      })
      const page = context.pages().find((candidate) => pageOrigin(candidate) === origin)
        ?? context.pages()[0]
        ?? await context.newPage()
      if (pageOrigin(page) !== origin) {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: BROWSER_START_TIMEOUT_MS })
      }
      this.#context = context
      this.#page = page
      this.#origin = origin
      this.#headless = !foreground
      context.once('close', () => {
        if (this.#context !== context) return
        this.#context = null
        this.#page = null
        this.#origin = null
        this.#headless = false
      })
      if (foreground) await page.bringToFront()
      return page
    } catch (error) {
      await context?.close().catch(() => undefined)
      this.#context = null
      this.#page = null
      this.#origin = null
      this.#headless = false
      throw new AppError('ACCOUNT_POOL_BROWSER_START_FAILED', '无法打开号池专用 Chrome。', {
        statusCode: 502,
        retryable: true,
        cause: error,
      })
    }
  }
}
