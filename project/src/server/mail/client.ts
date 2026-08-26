import { execFile } from 'node:child_process'
import { load } from 'cheerio'
import { AppError } from '../../shared/errors'
import { normalizeApi798Response, normalizeFirstMailHtml, normalizeMailboxResponse, type MailMessage } from './normalize'
import { BUILT_IN_PATH_MAILBOX_ORIGINS } from './settings'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'

const MAILBOX_ENDPOINT = 'https://icloud.thefindnet.xyz/api/mail.php'
const MAILBOX_ORIGIN = 'https://icloud.thefindnet.xyz'
const MAILBOX_PATH = '/api/mail.php'
const MAILBOX_QUERY_KEYS = new Set(['mail', 'pwd', 'limit'])
const PATH_MAILBOX_PREFIX = '/s/'
const PATH_MAILBOX_TOKEN = /^[A-Za-z0-9_-]{16,1024}$/
const PATH_MAILBOX_QUERY_KEYS = new Set(['email'])
const ICLOUD_API_ORIGIN = 'https://icloud-api.top'
const ICLOUD_API_SHOW_PREFIX = '/show/'
const BLOG_TX_ORIGIN = 'https://blog.tx.sb'
const BLOG_TX_FIRSTMAIL_PATH = '/fx.php'
const BLOG_TX_FIRSTMAIL_QUERY_KEYS = new Set(['mail', 'pwd', 'limit'])
const BLOG_TX_FIRSTMAIL_LIMIT = /^(?:[1-9]|[1-4]\d|50)$/
const CLOUD_MAILBOX_ORIGIN = 'https://icloud.olo.lat'
const CLOUD_MAILBOX_PREFIX = '/p/'
const ASSURIVO_ORIGINS = new Set(['https://assurivo.com', 'https://icloud.biubiu007.com'])
const ASSURIVO_WEB_PATH = '/console/open.php'
const ASSURIVO_FEED_PATH = '/console/feed.php'
const ASSURIVO_QUERY_KEYS = new Set(['mail', 'pwd', 'limit'])
const ASSURIVO_LIMIT = /^(?:[1-9]|1\d|20)$/
const AI1998_ORIGIN = 'https://mail.ai1998.xyz'
const AI1998_PREFIX = '/messages/'
const AI1998_QUERY_KEYS = new Set(['recipient'])
const GPTMAIL_ORIGINS = new Set(['https://gptmail.wanmail.beer', 'https://li1329.asia'])
const GPTMAIL_PREFIX = '/api/v1/public/inboxes/'
const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAILOTP_ORIGIN = 'https://mailotp.xyhelper.ai'
const MAILOTP_PATH = '/api/code'
const MAILOTP_TOKEN = /^[A-Za-z0-9._~-]{1,2048}$/
const CHINA_AGARWOOD_ORIGIN = 'https://inbox.chinaagarwood.com'
const CHINA_AGARWOOD_PATH = '/code'
const CHINA_AGARWOOD_TOKEN = /^icm_[A-Za-z0-9_-]{8,2048}$/
const YISEN_MAIL_ORIGIN = 'https://mail.yisen.uk'
const YISEN_MAIL_PATH = '/api/mails'
const YISEN_MAIL_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAIL_776867_ORIGIN = 'https://mail.776867.xyz'
const MAIL_776867_PREFIX = '/icloud/p/'
const MAIL_776867_ACCESS_ID = /^[A-Za-z0-9]{16,128}$/
const FLYSMS_ORIGIN = 'https://flysms.xyz'
const FLYSMS_PATH = '/icloud/pickup'
const FLYSMS_TOKEN = /^tok_[A-Za-z0-9_-]{1,2048}$/
const DESK360_ORIGIN = 'https://redeem.360desk.net'
const DESK360_PAGE_PATH = '/quick-mail'
const DESK360_API_PATH = '/quick-mail/api/recent'
const MAILCAT_ORIGIN = 'https://191006.xyz'
const MAILCAT_PREFIX = '/mailbox/'
const MAILCAT_TOKEN = /^[A-Za-z0-9_-]{16,1024}$/
const MAILCOM_CODE_ORIGINS = new Set(['https://email.lzg666.icu'])
const FIXED_HTTP_MAILCOM_CODE_ORIGIN = 'http://120.27.135.141'
const MAILCOM_CODE_PREFIX = '/code/'
const AI100_ORIGIN = 'https://ai100.my'
const AI100_CODE_PREFIX = '/mail/code/'
const MAILCOM_CODE_TOKEN = /^[A-Za-z0-9_-]{16,1024}$/
const AIGATEWAY_ORIGIN = 'https://aigateway.online'
const AIGATEWAY_PREFIX = '/api/v1/mail-pickup/'
const AIGATEWAY_TOKEN = /^[A-Za-z0-9_-]{16,1024}$/
const CLOUDFLARE_OTP_TOKEN = /^[A-Za-z0-9_-]{24,256}$/
const CLOUDFLARE_CODE_POLL_TIMEOUT = '5'
const MCZERO_ORIGIN = 'https://mail.mczero.top'
const API798_ORIGIN = 'https://api798.com'
const API798_PATH = '/latest'
const API798_QUERY_KEYS = new Set(['email', 'auth_code'])
const API798_AUTH_CODE = /^[A-Za-z0-9._~-]{1,256}$/
const WEBMAIL503_ORIGIN = 'https://webmail.503.me'
const WEBMAIL503_PATH = '/webmail'
const WEBMAIL503_QUERY_KEYS = new Set(['mail', 'pwd', 'limit', 'format'])
const O6F4_ORIGIN = 'https://o6f4.my'
const O6F4_QUERY_KEYS = new Set(['email', 'pos', 'sign'])
const O6F4_POSITION = /^\d{1,20}$/
const O6F4_SIGNATURE = /^[A-Za-z0-9._~-]{8,1024}$/
const AISVIP_ORIGIN = 'https://main.aisvip.shop'
const AISVIP_PREFIX = '/c/'
const AISVIP_ID = /^\d{1,20}$/
const AISVIP_TOKEN = /^[A-Za-z0-9_-]{16,1024}$/
const AISVIP_REQUEST_ATTEMPTS = 2
const BOMYI_ORIGIN = 'https://mail.bomyi.com'
const BOMYI_SHARED_PREFIX = '/api/shared/'
const BOMYI_SHARE_ID = /^share-hloolmail-[A-Za-z0-9_-]{16,1024}$/
const BOMYI_SHARE_KEY = /^sharekey-hloolmail-[A-Za-z0-9_-]{16,1024}$/
const MAX_PATH_MAILBOX_REDIRECTS = 3

const aisvipLatestCodeSchema = z
  .object({
    ok: z.boolean(),
    status: z.string().optional(),
    code: z.union([z.string(), z.number()]).nullish(),
    sender: z.string().nullish(),
    subject: z.string().nullish(),
    mail_time: z.union([z.string(), z.number()]).nullish(),
    checked_at: z.union([z.string(), z.number()]).nullish(),
    error: z.string().optional(),
  })
  .passthrough()

const bomyiMessageSchema = z
  .object({
    id: z.string().min(1).max(500),
    recipient: z.string().trim().email(),
    from_address: z.string().max(20_000).nullable().optional(),
    from_name: z.string().max(20_000).nullable().optional(),
    subject: z.string().max(20_000),
    verification_code: z.string().max(100).nullable().optional(),
    preview: z.string().max(500_000).nullable().optional(),
    created_at: z.string().max(100),
  })
  .passthrough()

const bomyiResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.array(bomyiMessageSchema).max(100).optional(),
    error: z.unknown().nullable().optional(),
  })
  .passthrough()

const cloudMailboxMetaSchema = z
  .object({
    filterEmail: z.string().trim().email(),
    codeRequired: z.boolean(),
    authorized: z.boolean(),
  })
  .passthrough()

const cloudMailboxSyncSchema = z.object({ status: z.string().min(1) }).passthrough()

const cloudMailboxMessageSummarySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    from: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    receivedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  })
  .passthrough()

const cloudMailboxMessagesSchema = z
  .object({ messages: z.array(cloudMailboxMessageSummarySchema) })
  .passthrough()

const cloudMailboxMessageDetailSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    from: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    body: z.string(),
    receivedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))).optional(),
  })
  .passthrough()

const gptMailResponseSchema = z
  .object({
    data: z
      .object({
        address: z.string().trim().email(),
        subject: z.string().max(20_000).nullable(),
        snippet: z.string().max(100_000).nullable(),
        sent_at: z.string().max(100).nullable(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough()

const mailOtpResponseSchema = z
  .object({
    success: z.boolean(),
    code: z.string().max(100).optional(),
    count: z.number().int().nonnegative().optional(),
    error: z.string().max(500).optional(),
  })
  .passthrough()

const chinaAgarwoodResponseSchema = z.array(z.object({
  otp: z.union([z.string(), z.number()]),
  time: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
}).passthrough()).max(500)

const yisenMailResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  results: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    address: z.string().trim().email(),
    source: z.string().max(20_000).nullable().optional(),
    raw: z.string().max(2_000_000),
    created_at: z.string().refine((value) => !Number.isNaN(Date.parse(`${value.replace(' ', 'T')}Z`))),
  }).passthrough()).max(100),
}).passthrough()

const mail776867MessageSchema = z
  .object({
    uid: z.union([z.string(), z.number()]).optional(),
    sender: z.string().max(20_000).nullable().optional(),
    subject: z.string().max(20_000).nullable().optional(),
    received_at: z.string().max(100).nullable().optional(),
    body_text: z.string().max(500_000).nullable().optional(),
    body_html: z.string().max(500_000).nullable().optional(),
    body_preview: z.string().max(100_000).nullable().optional(),
    code: z.string().max(100).nullable().optional(),
  })
  .passthrough()

const mail776867ResponseSchema = z
  .object({
    ok: z.boolean(),
    email: z.string().trim().email().optional(),
    messages: z.array(mail776867MessageSchema).max(500).optional(),
    error: z.string().max(500).optional(),
  })
  .passthrough()

const flySmsMessageSchema = z
  .object({
    mailbox: z.string().trim().email(),
    uid: z.union([z.string(), z.number()]).optional(),
    subject: z.string().max(20_000).nullable().optional(),
    from: z.string().max(20_000).nullable().optional(),
    date: z.string().max(100).nullable().optional(),
    sentAt: z.string().max(100).nullable().optional(),
    mailboxReceivedAt: z.string().max(100).nullable().optional(),
    ingestedAt: z.string().max(100).nullable().optional(),
    text: z.string().max(500_000).nullable().optional(),
    html: z.string().max(500_000).nullable().optional(),
  })
  .passthrough()

const flySmsResponseSchema = z
  .object({
    email: z.string().trim().email(),
    message: flySmsMessageSchema.nullable(),
  })
  .passthrough()

const flySmsErrorSchema = z
  .object({
    code: z.string().max(100),
    error: z.string().max(500).optional(),
  })
  .passthrough()

const desk360MessageSchema = z
  .object({
    from: z.string().max(20_000).nullable().optional(),
    subject: z.string().max(20_000).nullable().optional(),
    folder: z.string().max(500).nullable().optional(),
    received_at: z.string().max(100).refine((value) => !Number.isNaN(Date.parse(value))),
    preview: z.string().max(100_000).nullable().optional(),
  })
  .passthrough()

const desk360ResponseSchema = z
  .object({
    email: z.string().trim().email(),
    count: z.number().int().nonnegative(),
    window_minutes: z.number().int().positive().max(60),
    messages: z.array(desk360MessageSchema).max(500),
  })
  .passthrough()

const webmail503MailSchema = z
  .object({
    uid: z.union([z.string().max(500), z.number()]).optional(),
    from: z.string().max(20_000),
    subject: z.string().max(20_000),
    date: z.string().max(100).optional(),
    code: z.string().max(100).optional(),
    codes: z.array(z.string().max(100)).max(20).optional(),
  })
  .passthrough()

const webmail503ResponseSchema = z
  .object({
    success: z.boolean(),
    email: z.string().trim().email(),
    count: z.number().int().nonnegative(),
    code: z.string().max(100).optional(),
    codes: z.array(z.string().max(100)).max(20).optional(),
    mails: z.array(webmail503MailSchema).max(100),
  })
  .passthrough()

const mcZeroMessageSchema = z
  .object({
    id: z.union([z.string().min(1).max(500), z.number()]),
    date: z.string().max(100).optional(),
    received_at: z.union([z.string().max(100), z.number()]).optional(),
    from: z.string().max(20_000),
    subject: z.string().max(20_000),
    codes: z.array(z.string().regex(/^\d{6}$/)).max(20),
    preview: z.string().max(500_000),
  })
  .passthrough()

const mcZeroResponseSchema = z
  .object({
    state: z.enum(['ready', 'empty', 'syncing', 'error']),
    message_id: z.union([z.string().max(500), z.number()]).nullish(),
    message: mcZeroMessageSchema.nullish(),
    notice: z.string().max(500).optional(),
    updated_at: z.union([z.string().max(100), z.number()]).optional(),
    mode: z.string().max(100).optional(),
    mode_label: z.string().max(100).optional(),
    latest_latency_seconds: z.number().nonnegative().nullable().optional(),
  })
  .passthrough()

const mailComCodeResponseSchema = z
  .object({
    email: z.string().trim().email(),
    code: z.string().regex(/^\d{6}$/).nullable(),
    mail: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough()

const dedicatedOtpMessageSchema = z
  .object({
    id: z.union([z.string().max(500), z.number()]).optional(),
    uid: z.union([z.string().max(500), z.number()]).optional(),
    from: z.string().max(20_000).nullable().optional(),
    sender: z.string().max(20_000).nullable().optional(),
    subject: z.string().max(20_000).nullable().optional(),
    preview: z.string().max(100_000).nullable().optional(),
    text: z.string().max(500_000).nullable().optional(),
    body: z.string().max(500_000).nullable().optional(),
    html: z.string().max(500_000).nullable().optional(),
    code: z.union([z.literal(''), z.string().regex(/^\d{6}$/)]).nullable().optional(),
    received_at: z.string().max(100).nullable().optional(),
    receivedAt: z.string().max(100).nullable().optional(),
    date: z.string().max(100).nullable().optional(),
  })
  .passthrough()

const aigatewayPickupResponseSchema = z
  .object({
    email: z.string().trim().email().optional(),
    address: z.string().trim().email().optional(),
    mailbox: z.union([z.string().trim().email(), z.object({ email: z.string().trim().email() }).passthrough()]).optional(),
    messages: z.array(dedicatedOtpMessageSchema).max(500).optional(),
    data: z.object({
      email: z.string().trim().email().optional(),
      address: z.string().trim().email().optional(),
      mailbox: z.union([z.string().trim().email(), z.object({ email: z.string().trim().email() }).passthrough()]).optional(),
      messages: z.array(dedicatedOtpMessageSchema).max(500),
    }).passthrough().optional(),
  })
  .passthrough()

const cloudflareOtpResponseSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(['waiting', 'ready']).optional(),
    email: z.string().trim().email().optional(),
    code: z.string().regex(/^\d{6}$/).nullable().optional(),
    received_at: z.string().max(100).nullable().optional(),
    messages: z.array(dedicatedOtpMessageSchema).max(100).optional(),
    error: z.string().max(500).optional(),
  })
  .passthrough()

export interface MailboxClientOptions {
  requestTimeoutMs?: number
  maxResponseBytes?: number
  systemHttpsProxyResolver?: () => Promise<string | null>
  proxyFetch?: MailboxProxyFetch
  trustedPathOrigins?: () => readonly string[]
}

export type MailboxProxyFetch = (
  url: URL,
  init: RequestInit,
  proxyUrl: string,
  maxResponseBytes: number,
) => Promise<Response>

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function invalidAccessUrl(reason: string): AppError {
  return new AppError('MAIL_ACCESS_URL_INVALID', `邮箱接口链接无效：${reason}。`)
}

function normalizeCopiedAccessUrl(input: string): string {
  let value = input.trim()
  const wrappers: Array<readonly [string, string]> = [
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]
  for (const [open, close] of wrappers) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      value = value.slice(open.length, -close.length).trim()
      break
    }
  }
  return value.replace(/&amp;/gi, '&')
}

function normalizeMailboxPath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
}

function parseGenericMailboxUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.protocol !== 'https:' || suppliedUrl.username || suppliedUrl.password) {
    throw invalidAccessUrl('通用邮箱链接必须使用 HTTPS 且不能包含基础认证信息')
  }
  const hostname = suppliedUrl.hostname.toLowerCase()
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname === '::1' || hostname.startsWith('127.') || hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw invalidAccessUrl('通用邮箱链接不能指向本机或内网地址')
  }
  if (suppliedUrl.toString().length > 4096) throw invalidAccessUrl('链接过长')
  for (const key of ['email', 'mail', 'login', 'address', 'recipient']) {
    const values = suppliedUrl.searchParams.getAll(key)
    if (values.length === 1 && values[0]?.includes('@')) requireMatchingEmail(values[0], email)
  }
  suppliedUrl.pathname = normalizeMailboxPath(suppliedUrl.pathname)
  return suppliedUrl.toString()
}

function effectivePathOrigins(origins: readonly string[] = BUILT_IN_PATH_MAILBOX_ORIGINS): ReadonlySet<string> {
  return new Set([...BUILT_IN_PATH_MAILBOX_ORIGINS, ...origins])
}

export function parseLoopbackMacOsHttpsProxy(output: string): string | null {
  const settings = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/)
    if (match?.[1] && match[2] !== undefined) settings.set(match[1], match[2])
  }
  if (settings.get('HTTPSEnable') !== '1') return null

  const host = settings.get('HTTPSProxy')?.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
  const port = Number(settings.get('HTTPSPort'))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null

  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}

function resolveLoopbackMacOsHttpsProxy(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/scutil',
      ['--proxy'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 65_536 },
      (error, stdout) => resolve(error ? null : parseLoopbackMacOsHttpsProxy(stdout)),
    )
  })
}

function parsePathMailboxUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(PATH_MAILBOX_PREFIX)) throw invalidAccessUrl('接口路径不正确')

  const segments = pathname.slice(PATH_MAILBOX_PREFIX.length).split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) throw invalidAccessUrl('接口路径不正确')
  if (!PATH_MAILBOX_TOKEN.test(segments[0])) throw invalidAccessUrl('访问凭据格式不正确')

  let pathEmail: string
  try {
    pathEmail = decodeURIComponent(segments[1])
  } catch {
    throw invalidAccessUrl('邮箱路径无法识别')
  }
  if (/[\\/\0]/.test(pathEmail)) throw invalidAccessUrl('邮箱路径无法识别')
  if (pathEmail.toLowerCase() !== email.toLowerCase()) {
    throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
  }

  const queryKeys = [...suppliedUrl.searchParams.keys()]
  if (queryKeys.some((key) => !PATH_MAILBOX_QUERY_KEYS.has(key))) {
    throw invalidAccessUrl('包含不支持的参数')
  }
  const queryEmails = suppliedUrl.searchParams.getAll('email')
  const queryEmail = queryEmails[0]
  if (
    queryEmails.length > 1 ||
    (queryEmails.length === 1 && (!queryEmail || queryEmail !== queryEmail.trim()))
  ) {
    throw invalidAccessUrl('email 参数必须唯一且非空')
  }
  if (queryEmail && queryEmail.toLowerCase() !== pathEmail.toLowerCase()) {
    throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
  }
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseIcloudApiShowUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== ICLOUD_API_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }

  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(ICLOUD_API_SHOW_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const segments = pathname.slice(ICLOUD_API_SHOW_PREFIX.length).split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) throw invalidAccessUrl('接口路径不正确')
  if (!PATH_MAILBOX_TOKEN.test(segments[0])) throw invalidAccessUrl('访问凭据格式不正确')

  const pathEmail = decodeMailboxPathEmail(segments[1])
  requireMatchingEmail(pathEmail, email)
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseBlogTxFirstMailUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== BLOG_TX_ORIGIN || suppliedUrl.pathname !== BLOG_TX_FIRSTMAIL_PATH) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !BLOG_TX_FIRSTMAIL_QUERY_KEYS.has(key))) {
    throw invalidAccessUrl('包含不支持的参数')
  }
  const mails = suppliedUrl.searchParams.getAll('mail')
  const passwords = suppliedUrl.searchParams.getAll('pwd')
  const limits = suppliedUrl.searchParams.getAll('limit')
  if (mails.length !== 1 || !mails[0]?.trim()) throw invalidAccessUrl('缺少唯一的 mail 参数')
  if (passwords.length !== 1 || !passwords[0]) throw invalidAccessUrl('缺少唯一的 pwd 参数')
  if (limits.length > 1 || (limits.length === 1 && !BLOG_TX_FIRSTMAIL_LIMIT.test(limits[0] ?? ''))) {
    throw invalidAccessUrl('limit 参数必须为 1 到 50 的整数')
  }
  requireMatchingEmail(mails[0], email)

  const normalized = new URL(BLOG_TX_FIRSTMAIL_PATH, BLOG_TX_ORIGIN)
  normalized.searchParams.set('mail', mails[0].trim())
  normalized.searchParams.set('pwd', passwords[0])
  normalized.searchParams.set('limit', '1')
  return normalized.toString()
}

function parseCloudMailboxUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== CLOUD_MAILBOX_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }

  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(CLOUD_MAILBOX_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const segments = pathname.slice(CLOUD_MAILBOX_PREFIX.length).split('/')
  if (segments.length !== 1 || !segments[0] || !PATH_MAILBOX_TOKEN.test(segments[0])) {
    throw invalidAccessUrl('访问凭据格式不正确')
  }
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseAssurivoMailboxUrl(email: string, suppliedUrl: URL): string {
  if (!ASSURIVO_ORIGINS.has(suppliedUrl.origin)) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  if (suppliedUrl.pathname !== ASSURIVO_WEB_PATH && suppliedUrl.pathname !== ASSURIVO_FEED_PATH) {
    throw invalidAccessUrl('接口路径不正确')
  }

  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !ASSURIVO_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')

  const mails = suppliedUrl.searchParams.getAll('mail')
  const passwords = suppliedUrl.searchParams.getAll('pwd')
  const limits = suppliedUrl.searchParams.getAll('limit')
  if (mails.length !== 1 || !mails[0]?.trim()) throw invalidAccessUrl('缺少唯一的 mail 参数')
  if (passwords.length !== 1 || !passwords[0]?.trim()) throw invalidAccessUrl('缺少唯一的 pwd 参数')
  if (limits.length > 1 || (limits.length === 1 && !ASSURIVO_LIMIT.test(limits[0] ?? ''))) {
    throw invalidAccessUrl('limit 参数必须为 1 到 20 的整数')
  }
  const linkedEmail = mails[0].trim()
  if (!emailsMatchForAssurivo(linkedEmail, email)) {
    throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
  }

  const feedUrl = new URL(ASSURIVO_FEED_PATH, suppliedUrl.origin)
  const requestEmail = linkedEmail.toLowerCase() === email.trim().toLowerCase() ? email.trim() : linkedEmail
  feedUrl.searchParams.set('mail', requestEmail)
  feedUrl.searchParams.set('pwd', passwords[0])
  feedUrl.searchParams.set('limit', '1')
  return feedUrl.toString()
}

function emailsMatchForAssurivo(linkedEmail: string, accountEmail: string): boolean {
  const linked = linkedEmail.trim().toLowerCase()
  const account = accountEmail.trim().toLowerCase()
  if (linked === account) return true
  const match = /^([^+@]+)\+[^@]+@icloud\.com$/.exec(account)
  return match !== null && linked === `${match[1]}@icloud.com`
}

function decodeMailboxPathEmail(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw invalidAccessUrl('邮箱路径无法识别')
  }
  if (/[\\/\0]/.test(decoded) || decoded.length > 320) throw invalidAccessUrl('邮箱路径无法识别')
  return decoded
}

function requireMatchingEmail(actual: string, expected: string): void {
  if (actual.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
  }
}

function parseAi1998MailboxUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== AI1998_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(AI1998_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const segments = pathname.slice(AI1998_PREFIX.length).split('/')
  if (segments.length !== 2 || !PATH_MAILBOX_TOKEN.test(segments[0] ?? '')) {
    throw invalidAccessUrl('访问凭据格式不正确')
  }
  const pathEmail = decodeMailboxPathEmail(segments[1] ?? '')
  requireMatchingEmail(pathEmail, email)

  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !AI1998_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')
  const recipients = suppliedUrl.searchParams.getAll('recipient')
  if (recipients.length > 1 || (recipients.length === 1 && !recipients[0]?.trim())) {
    throw invalidAccessUrl('recipient 参数必须唯一且非空')
  }
  if (recipients[0]) requireMatchingEmail(recipients[0], pathEmail)
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseGptMailUrl(suppliedUrl: URL): string {
  if (!GPTMAIL_ORIGINS.has(suppliedUrl.origin)) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(GPTMAIL_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const token = pathname.slice(GPTMAIL_PREFIX.length)
  if (!UUID_TOKEN.test(token)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseMailOtpUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== MAILOTP_ORIGIN || suppliedUrl.pathname !== MAILOTP_PATH) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  const tokens = suppliedUrl.searchParams.getAll('token')
  if (keys.some((key) => key !== 'token') || tokens.length !== 1 || !MAILOTP_TOKEN.test(tokens[0] ?? '')) {
    throw invalidAccessUrl('token 参数必须唯一且格式正确')
  }
  return suppliedUrl.toString()
}

function parseChinaAgarwoodUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== CHINA_AGARWOOD_ORIGIN || suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('接口域名或链接内容不正确')
  }
  if (normalizeMailboxPath(suppliedUrl.pathname) !== CHINA_AGARWOOD_PATH) {
    throw invalidAccessUrl('接口路径不正确')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  const tokens = suppliedUrl.searchParams.getAll('token')
  if (keys.some((key) => key !== 'token') || tokens.length !== 1 || !CHINA_AGARWOOD_TOKEN.test(tokens[0] ?? '')) {
    throw invalidAccessUrl('token 参数必须唯一且格式正确')
  }
  suppliedUrl.pathname = CHINA_AGARWOOD_PATH
  return suppliedUrl.toString()
}

function parseYisenMailUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== YISEN_MAIL_ORIGIN || suppliedUrl.username || suppliedUrl.password) {
    throw invalidAccessUrl('接口域名或链接内容不正确')
  }
  if (normalizeMailboxPath(suppliedUrl.pathname) !== YISEN_MAIL_PATH) throw invalidAccessUrl('接口路径不正确')
  const keys = [...suppliedUrl.searchParams.keys()]
  const logins = suppliedUrl.searchParams.getAll('login')
  const limits = suppliedUrl.searchParams.getAll('limit')
  const offsets = suppliedUrl.searchParams.getAll('offset')
  const fragment = new URLSearchParams(suppliedUrl.hash.slice(1))
  const tokens = fragment.getAll('jwt')
  if (
    keys.some((key) => !['login', 'limit', 'offset'].includes(key)) ||
    logins.length !== 1 || limits.length !== 1 || offsets.length !== 1 ||
    limits[0] !== '40' || offsets[0] !== '0' ||
    [...fragment.keys()].some((key) => key !== 'jwt') || tokens.length !== 1 ||
    !YISEN_MAIL_JWT.test(tokens[0] ?? '')
  ) {
    throw invalidAccessUrl('邮箱、分页参数或 JWT 格式不正确')
  }
  requireMatchingEmail(logins[0]!, email)
  suppliedUrl.pathname = YISEN_MAIL_PATH
  suppliedUrl.hash = new URLSearchParams({ jwt: tokens[0]! }).toString()
  return suppliedUrl.toString()
}

function parseMail776867Url(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== MAIL_776867_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(MAIL_776867_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const accessId = pathname.slice(MAIL_776867_PREFIX.length)
  if (!MAIL_776867_ACCESS_ID.test(accessId)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseFlySmsUrl(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== FLYSMS_ORIGIN || normalizeMailboxPath(suppliedUrl.pathname) !== FLYSMS_PATH) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || !suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const fragment = new URLSearchParams(suppliedUrl.hash.slice(1))
  const keys = [...fragment.keys()]
  const emails = fragment.getAll('email')
  const tokens = fragment.getAll('key')
  if (keys.some((key) => key !== 'email' && key !== 'key') || emails.length !== 1 || tokens.length !== 1) {
    throw invalidAccessUrl('片段参数必须仅包含唯一的 email 和 key')
  }
  if (!emails[0]?.trim() || !FLYSMS_TOKEN.test(tokens[0] ?? '')) {
    throw invalidAccessUrl('片段参数格式不正确')
  }
  const token = tokens[0]
  if (!token) throw invalidAccessUrl('片段参数格式不正确')
  requireMatchingEmail(emails[0], email)
  suppliedUrl.pathname = FLYSMS_PATH
  suppliedUrl.hash = new URLSearchParams({ email: email.trim(), key: token }).toString()
  return suppliedUrl.toString()
}

function parseDesk360Url(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== DESK360_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  if (normalizeMailboxPath(suppliedUrl.pathname) !== DESK360_PAGE_PATH) {
    throw invalidAccessUrl('接口路径不正确')
  }
  suppliedUrl.pathname = `${DESK360_PAGE_PATH}/`
  return suppliedUrl.toString()
}

function parseMailcatUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== MAILCAT_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(MAILCAT_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const token = pathname.slice(MAILCAT_PREFIX.length)
  if (!MAILCAT_TOKEN.test(token)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseAisvipUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== AISVIP_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(AISVIP_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const id = pathname.slice(AISVIP_PREFIX.length)
  if (!AISVIP_ID.test(id)) throw invalidAccessUrl('接口路径不正确')

  const keys = [...suppliedUrl.searchParams.keys()]
  const tokens = suppliedUrl.searchParams.getAll('token')
  if (keys.some((key) => key !== 'token') || tokens.length !== 1 || !AISVIP_TOKEN.test(tokens[0] ?? '')) {
    throw invalidAccessUrl('token 参数必须唯一且格式正确')
  }
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseBomyiUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== BOMYI_ORIGIN || suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('接口域名或链接内容不正确')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(BOMYI_SHARED_PREFIX) || !pathname.endsWith('/messages')) {
    throw invalidAccessUrl('接口路径不正确')
  }
  const shareId = pathname.slice(BOMYI_SHARED_PREFIX.length, -'/messages'.length)
  if (!BOMYI_SHARE_ID.test(shareId)) throw invalidAccessUrl('共享邮箱标识格式不正确')
  const keys = [...suppliedUrl.searchParams.keys()]
  const shareKeys = suppliedUrl.searchParams.getAll('key')
  const limits = suppliedUrl.searchParams.getAll('limit')
  if (
    keys.some((key) => key !== 'key' && key !== 'limit') ||
    shareKeys.length !== 1 ||
    !BOMYI_SHARE_KEY.test(shareKeys[0] ?? '') ||
    limits.length !== 1 ||
    limits[0] !== '1'
  ) {
    throw invalidAccessUrl('必须包含唯一且格式正确的 key，并将 limit 设为 1')
  }
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseMailComCodeUrl(suppliedUrl: URL): string {
  if (!isMailComCodeOrigin(suppliedUrl)) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(MAILCOM_CODE_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const token = pathname.slice(MAILCOM_CODE_PREFIX.length)
  if (!MAILCOM_CODE_TOKEN.test(token)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseAi100CodeUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== AI100_ORIGIN) throw invalidAccessUrl('接口域名不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(AI100_CODE_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const token = pathname.slice(AI100_CODE_PREFIX.length)
  if (!MAILCOM_CODE_TOKEN.test(token)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseAigatewayPickupUrl(suppliedUrl: URL): string {
  if (suppliedUrl.origin !== AIGATEWAY_ORIGIN || suppliedUrl.username || suppliedUrl.password) {
    throw invalidAccessUrl('接口域名不正确')
  }
  if (suppliedUrl.search || suppliedUrl.hash) throw invalidAccessUrl('包含不支持的链接内容')
  const pathname = normalizeMailboxPath(suppliedUrl.pathname)
  if (!pathname.startsWith(AIGATEWAY_PREFIX)) throw invalidAccessUrl('接口路径不正确')
  const token = pathname.slice(AIGATEWAY_PREFIX.length)
  if (!AIGATEWAY_TOKEN.test(token)) throw invalidAccessUrl('访问凭据格式不正确')
  suppliedUrl.pathname = pathname
  return suppliedUrl.toString()
}

function parseApi798Url(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.hostname.toLowerCase() !== 'api798.com' || suppliedUrl.port) {
    throw invalidAccessUrl('接口域名不正确')
  }
  suppliedUrl.protocol = 'https:'
  if (suppliedUrl.origin !== API798_ORIGIN || suppliedUrl.pathname !== API798_PATH) {
    throw invalidAccessUrl('接口路径不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !API798_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')
  const emails = suppliedUrl.searchParams.getAll('email')
  const authCodes = suppliedUrl.searchParams.getAll('auth_code')
  if (emails.length !== 1 || authCodes.length !== 1 || !API798_AUTH_CODE.test(authCodes[0] ?? '')) {
    throw invalidAccessUrl('必须包含唯一且格式正确的 email 和 auth_code')
  }
  const suppliedEmail = emails[0]!
  const authCode = authCodes[0]!
  requireMatchingEmail(suppliedEmail, email)
  suppliedUrl.search = new URLSearchParams({ email: email.trim(), auth_code: authCode }).toString()
  return suppliedUrl.toString()
}

function parseWebmail503Url(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== WEBMAIL503_ORIGIN || suppliedUrl.pathname !== WEBMAIL503_PATH) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !WEBMAIL503_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')
  const mails = suppliedUrl.searchParams.getAll('mail')
  const passwords = suppliedUrl.searchParams.getAll('pwd')
  const limits = suppliedUrl.searchParams.getAll('limit')
  const formats = suppliedUrl.searchParams.getAll('format')
  if (mails.length !== 1 || !mails[0]?.trim()) throw invalidAccessUrl('缺少唯一的 mail 参数')
  if (passwords.length !== 1 || !passwords[0]?.trim()) throw invalidAccessUrl('缺少唯一的 pwd 参数')
  if (limits.length !== 1 || limits[0] !== '1') throw invalidAccessUrl('limit 参数必须为 1')
  if (formats.length > 1) throw invalidAccessUrl('format 参数不能重复')
  requireMatchingEmail(mails[0], email)
  const normalized = new URL(WEBMAIL503_PATH, WEBMAIL503_ORIGIN)
  normalized.searchParams.set('mail', email.trim())
  normalized.searchParams.set('pwd', passwords[0])
  normalized.searchParams.set('limit', '1')
  normalized.searchParams.set('format', 'json')
  return normalized.toString()
}

function parseO6f4Url(email: string, suppliedUrl: URL): string {
  if (suppliedUrl.origin !== O6F4_ORIGIN || suppliedUrl.pathname !== '/') {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }
  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !O6F4_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')
  const emails = suppliedUrl.searchParams.getAll('email')
  const positions = suppliedUrl.searchParams.getAll('pos')
  const signatures = suppliedUrl.searchParams.getAll('sign')
  if (
    emails.length !== 1 ||
    positions.length !== 1 ||
    signatures.length !== 1 ||
    !O6F4_POSITION.test(positions[0] ?? '') ||
    !O6F4_SIGNATURE.test(signatures[0] ?? '')
  ) {
    throw invalidAccessUrl('必须包含唯一且格式正确的 email、pos 和 sign 参数')
  }
  requireMatchingEmail(emails[0]!, email)
  const normalized = new URL('/', O6F4_ORIGIN)
  normalized.searchParams.set('email', email.trim())
  normalized.searchParams.set('pos', positions[0]!)
  normalized.searchParams.set('sign', signatures[0]!)
  return normalized.toString()
}

function isCloudflareOtpLink(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && url.hostname.endsWith('.trycloudflare.com') && url.pathname === '/'
}

function isCloudflareMailboxLink(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && url.hostname.endsWith('.trycloudflare.com') &&
    /^\/mailbox\/[A-Za-z0-9_-]{16,1024}\/?$/.test(url.pathname)
}

function isCloudflareCodeEmailLink(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && url.hostname.endsWith('.trycloudflare.com') &&
    /^\/code\/[^/]*(?:@|%40)[^/]+\/?$/i.test(url.pathname)
}

function parseCloudflareCodeEmailUrl(email: string, suppliedUrl: URL): string {
  if (!isCloudflareCodeEmailLink(suppliedUrl) || suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  let pathEmail = ''
  try {
    pathEmail = decodeURIComponent(normalizeMailboxPath(suppliedUrl.pathname).slice('/code/'.length))
  } catch {
    throw invalidAccessUrl('邮箱路径无法识别')
  }
  requireMatchingEmail(pathEmail, email)
  const timeouts = suppliedUrl.searchParams.getAll('timeout')
  if ([...suppliedUrl.searchParams.keys()].some((key) => key !== 'timeout') || timeouts.length > 1 ||
      (timeouts.length === 1 && !/^\d{1,4}$/.test(timeouts[0]!))) {
    throw invalidAccessUrl('timeout 参数格式不正确')
  }
  suppliedUrl.pathname = `/code/${encodeURIComponent(email.trim())}`
  suppliedUrl.searchParams.set('timeout', CLOUDFLARE_CODE_POLL_TIMEOUT)
  return suppliedUrl.toString()
}

function parseCloudflareMailboxUrl(suppliedUrl: URL): string {
  if (!isCloudflareMailboxLink(suppliedUrl) || suppliedUrl.username || suppliedUrl.password || suppliedUrl.search || suppliedUrl.hash) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  suppliedUrl.pathname = normalizeMailboxPath(suppliedUrl.pathname)
  return suppliedUrl.toString()
}

function parseCloudflareOtpUrl(suppliedUrl: URL): string {
  if (!isCloudflareOtpLink(suppliedUrl) || suppliedUrl.username || suppliedUrl.password || suppliedUrl.search) {
    throw invalidAccessUrl('接口路径或域名不正确')
  }
  const fragment = new URLSearchParams(suppliedUrl.hash.slice(1))
  const keys = [...fragment.keys()]
  const tokens = fragment.getAll('otp')
  if (keys.some((key) => key !== 'otp') || tokens.length !== 1 || !CLOUDFLARE_OTP_TOKEN.test(tokens[0] ?? '')) {
    throw invalidAccessUrl('片段参数必须仅包含唯一且格式正确的 otp')
  }
  suppliedUrl.hash = new URLSearchParams({ otp: tokens[0]! }).toString()
  return suppliedUrl.toString()
}

function isMailComCodeOrigin(url: URL): boolean {
  return (
    MAILCOM_CODE_ORIGINS.has(url.origin) ||
    url.origin === FIXED_HTTP_MAILCOM_CODE_ORIGIN ||
    url.origin === AI100_ORIGIN ||
    (url.protocol === 'https:' && !url.port && url.hostname.endsWith('.trycloudflare.com'))
  )
}

function decodeCloudflareEmail(value: string): string | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value) || value.length < 4) return null
  const key = Number.parseInt(value.slice(0, 2), 16)
  let decoded = ''
  for (let index = 2; index < value.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(value.slice(index, index + 2), 16) ^ key)
  }
  return decoded
}

function normalizeMailcatHtml(email: string, body: string): MailMessage[] {
  const $ = load(body)
  const mailbox = $('.mailbox')
  const encodedEmail = mailbox.find('[data-cfemail]').first().attr('data-cfemail') ?? $('[data-cfemail]').first().attr('data-cfemail')
  const pageEmail = encodedEmail ? decodeCloudflareEmail(encodedEmail) : null
  if (!pageEmail) {
    throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取件页面缺少可核对的邮箱身份。', { statusCode: 502 })
  }
  requireMatchingEmail(pageEmail, email)

  const text = $('body').text().replace(/\s+/g, ' ').trim()
  if ($('.box').length === 1 && /暂无邮件/.test(text) && /还没有收到邮件/.test(text)) return []
  const subject = $('.subject')
  const content = $('.content')
  if (mailbox.length === 1 && subject.length === 1 && content.length === 1) {
    const subjectText = subject.text().replace(/\s+/g, ' ').trim()
    if (!/\b(?:openai|chatgpt)\b/i.test(subjectText)) return []
    const contentHtml = content.html()?.trim()
    if (!contentHtml) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱最新邮件正文为空。', { statusCode: 502 })
    }
    return normalizeMailboxResponse(
      'application/json',
      JSON.stringify({
        messages: [{
          from: 'OpenAI',
          subject: subjectText,
          html: contentHtml,
        }],
      }),
    )
  }
  return normalizeMailboxResponse('text/html', body)
}

function normalizeBlogTxFirstMailHtml(email: string, body: string): MailMessage[] {
  const $ = load(body)
  const pageText = $('body').text().replace(/\s+/g, ' ').trim()
  if (/连接邮箱失败|Authentication failed|AUTHENTICATIONFAILED/i.test(pageText)) {
    throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱账号或取件密码无效。', { statusCode: 401 })
  }

  const title = $('title').first().text().trim()
  const titleMatch = title.match(/^(.+?)\s*-\s*邮件查看$/)
  if (!titleMatch?.[1]) {
    throw new AppError('MAIL_PAGE_UNRECOGNIZED', '邮箱页面用途或邮件结构无法确认。', { statusCode: 502 })
  }
  requireMatchingEmail(titleMatch[1], email)
  if (/收件箱暂无邮件/.test(pageText) && /FirstMail\s*查看器|邮件列表/.test(pageText)) return []

  if ($('iframe[srcdoc]').length > 0) return normalizeFirstMailHtml(body)
  const messages = normalizeMailboxResponse('text/html', body, 'path_page')
  return messages.filter((message) => /\b(?:openai|chatgpt)\b/i.test(`${message.sender} ${message.subject} ${message.text}`))
}

function normalizeIcloudApiShowHtml(body: string): MailMessage[] {
  const $ = load(body)
  const container = $('.cnt').first()
  if (container.length === 0) {
    throw new AppError('MAIL_RESPONSE_INVALID', 'icloud-api.top 邮箱 HTML 不包含受支持的邮件结构。', {
      statusCode: 502,
    })
  }
  if ($('.card', container).length === 0 && /^0\s*封$/.test(container.text().replace(/\s+/g, ' ').trim())) {
    return []
  }

  const messages = $('.card', container)
    .toArray()
    .map((element, index) => {
      const card = $(element)
      const sender = card.find('.fr').first().text()
      const subject = card.find('.su').first().text()
      const receivedAt = card.find('.dt').first().text()
      const text = card.find('.bd').first().text()
      if (![sender, subject, receivedAt, text].every((value) => value.trim())) {
        throw new AppError('MAIL_RESPONSE_INVALID', 'icloud-api.top 邮箱 HTML 邮件结构不完整。', {
          statusCode: 502,
        })
      }
      return {
        id: `icloud-api-${index}`,
        from: sender,
        subject,
        text,
        received_at: receivedAt,
      }
    })

  if (messages.length === 0) {
    throw new AppError('MAIL_RESPONSE_INVALID', 'icloud-api.top 邮箱 HTML 不包含受支持的邮件结构。', {
      statusCode: 502,
    })
  }

  return normalizeMailboxResponse('application/json', JSON.stringify({ messages }))
}

export function normalizeMailboxAccessInput(
  email: string,
  input: string,
  trustedPathOrigins: readonly string[] = BUILT_IN_PATH_MAILBOX_ORIGINS,
): string {
  const candidate = normalizeCopiedAccessUrl(input)
  if (!/^https?:\/\//i.test(candidate)) return input

  let suppliedUrl: URL
  try {
    suppliedUrl = new URL(candidate)
  } catch {
    throw invalidAccessUrl('无法识别链接')
  }

  if (suppliedUrl.hostname.toLowerCase() === 'api798.com') return parseApi798Url(email, suppliedUrl)
  if (suppliedUrl.origin === FIXED_HTTP_MAILCOM_CODE_ORIGIN) return parseMailComCodeUrl(suppliedUrl)

  if (suppliedUrl.protocol !== 'https:') throw invalidAccessUrl('必须使用 HTTPS')
  if (suppliedUrl.origin === WEBMAIL503_ORIGIN && suppliedUrl.pathname === WEBMAIL503_PATH) {
    return parseWebmail503Url(email, suppliedUrl)
  }
  if (suppliedUrl.origin === O6F4_ORIGIN) return parseO6f4Url(email, suppliedUrl)
  if (suppliedUrl.origin === BLOG_TX_ORIGIN && suppliedUrl.pathname === BLOG_TX_FIRSTMAIL_PATH) {
    return parseBlogTxFirstMailUrl(email, suppliedUrl)
  }
  if (
    suppliedUrl.origin === ICLOUD_API_ORIGIN &&
    normalizeMailboxPath(suppliedUrl.pathname).startsWith(ICLOUD_API_SHOW_PREFIX)
  ) {
    return parseIcloudApiShowUrl(email, suppliedUrl)
  }
  if (suppliedUrl.origin === CLOUD_MAILBOX_ORIGIN) return parseCloudMailboxUrl(suppliedUrl)
  if (ASSURIVO_ORIGINS.has(suppliedUrl.origin)) return parseAssurivoMailboxUrl(email, suppliedUrl)
  if (suppliedUrl.origin === AI1998_ORIGIN) return parseAi1998MailboxUrl(email, suppliedUrl)
  if (GPTMAIL_ORIGINS.has(suppliedUrl.origin)) return parseGptMailUrl(suppliedUrl)
  if (suppliedUrl.origin === MAILOTP_ORIGIN) return parseMailOtpUrl(suppliedUrl)
  if (suppliedUrl.origin === CHINA_AGARWOOD_ORIGIN) return parseChinaAgarwoodUrl(suppliedUrl)
  if (suppliedUrl.origin === YISEN_MAIL_ORIGIN) return parseYisenMailUrl(email, suppliedUrl)
  if (suppliedUrl.origin === MAIL_776867_ORIGIN) return parseMail776867Url(suppliedUrl)
  if (suppliedUrl.origin === FLYSMS_ORIGIN) return parseFlySmsUrl(email, suppliedUrl)
  if (suppliedUrl.origin === DESK360_ORIGIN) return parseDesk360Url(suppliedUrl)
  if (suppliedUrl.origin === MAILCAT_ORIGIN) return parseMailcatUrl(suppliedUrl)
  if (suppliedUrl.origin === AISVIP_ORIGIN) return parseAisvipUrl(suppliedUrl)
  if (suppliedUrl.origin === BOMYI_ORIGIN) return parseBomyiUrl(suppliedUrl)
  if (suppliedUrl.origin === AIGATEWAY_ORIGIN) return parseAigatewayPickupUrl(suppliedUrl)
  if (suppliedUrl.origin === AI100_ORIGIN) return parseAi100CodeUrl(suppliedUrl)
  if (isCloudflareMailboxLink(suppliedUrl)) return parseCloudflareMailboxUrl(suppliedUrl)
  if (isCloudflareCodeEmailLink(suppliedUrl)) return parseCloudflareCodeEmailUrl(email, suppliedUrl)
  if (isCloudflareOtpLink(suppliedUrl)) return parseCloudflareOtpUrl(suppliedUrl)
  if (isMailComCodeOrigin(suppliedUrl)) return parseMailComCodeUrl(suppliedUrl)
  if (suppliedUrl.origin !== MAILBOX_ORIGIN) {
    if (effectivePathOrigins(trustedPathOrigins).has(suppliedUrl.origin)) {
      return parsePathMailboxUrl(email, suppliedUrl)
    }
    return parseGenericMailboxUrl(email, suppliedUrl)
  }
  if (normalizeMailboxPath(suppliedUrl.pathname) !== MAILBOX_PATH) throw invalidAccessUrl('接口路径不正确')
  if (suppliedUrl.username || suppliedUrl.password || suppliedUrl.hash) {
    throw invalidAccessUrl('包含不支持的链接内容')
  }

  const keys = [...suppliedUrl.searchParams.keys()]
  if (keys.some((key) => !MAILBOX_QUERY_KEYS.has(key))) throw invalidAccessUrl('包含不支持的参数')

  const mails = suppliedUrl.searchParams.getAll('mail')
  const passwords = suppliedUrl.searchParams.getAll('pwd')
  const limits = suppliedUrl.searchParams.getAll('limit')
  if (mails.length !== 1 || !mails[0]) throw invalidAccessUrl('缺少唯一的 mail 参数')
  if (passwords.length !== 1 || !passwords[0]) throw invalidAccessUrl('缺少唯一的 pwd 参数')
  if (limits.length > 1 || (limits.length === 1 && limits[0] !== '5')) {
    throw invalidAccessUrl('limit 参数必须为 5')
  }
  if (mails[0].toLowerCase() !== email.toLowerCase()) {
    throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
  }
  return passwords[0]
}

// Kept for existing callers; the normalized value may now be a fixed path-style access URL.
export const mailboxPasswordFromInput = normalizeMailboxAccessInput

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError('MAIL_RESPONSE_TOO_LARGE', '邮箱接口响应超过大小限制。', { statusCode: 502 })
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let body = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new AppError('MAIL_RESPONSE_TOO_LARGE', '邮箱接口响应超过大小限制。', { statusCode: 502 })
    }
    body += decoder.decode(value, { stream: true })
  }
  return body + decoder.decode()
}

async function fetchThroughProxy(
  url: URL,
  init: RequestInit,
  proxyUrl: string,
  maxResponseBytes: number,
): Promise<Response> {
  const dispatcher = new ProxyAgent(proxyUrl)
  try {
    const response = await undiciFetch(url, {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])
    const body = await readBoundedBody(response as unknown as Response, maxResponseBytes)
    const headers = new Headers()
    for (const name of ['content-type', 'location', 'retry-after']) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    const bodyAllowed = response.status !== 204 && response.status !== 205 && response.status !== 304
    return new Response(bodyAllowed ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } finally {
    await dispatcher.close().catch(() => undefined)
  }
}

function throwMailboxRequestFailure(error: unknown, signal: AbortSignal | undefined, timeoutSignal: AbortSignal): never {
  if (signal?.aborted) {
    throw new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409, cause: error })
  }
  if (timeoutSignal.aborted) {
    throw new AppError('MAIL_REQUEST_TIMEOUT', '邮箱接口单次请求超时。', {
      statusCode: 504,
      retryable: true,
      cause: error,
    })
  }
  throw new AppError('MAIL_NETWORK_ERROR', '无法连接邮箱接口。', {
    statusCode: 502,
    retryable: true,
    cause: error,
  })
}

function collectNetworkErrorCodes(
  error: unknown,
  codes = new Set<string>(),
  seen = new Set<unknown>(),
): Set<string> {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || seen.has(error)) return codes
  seen.add(error)
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown }
  if (typeof record.code === 'string') codes.add(record.code.toUpperCase())
  if (record.cause !== undefined) collectNetworkErrorCodes(record.cause, codes, seen)
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) collectNetworkErrorCodes(nested, codes, seen)
  }
  return codes
}

function throwPathMailboxRequestFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  proxyFallbackFailed = false,
  url?: URL,
  directError?: unknown,
): never {
  if (signal?.aborted) {
    throw new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409, cause: error })
  }
  if (timeoutSignal.aborted) {
    throw new AppError('MAIL_REQUEST_TIMEOUT', '邮箱接口单次请求超时。', {
      statusCode: 504,
      retryable: true,
      cause: error,
    })
  }
  const codes = collectNetworkErrorCodes(error)
  const directCodes = collectNetworkErrorCodes(directError)
  const temporaryCloudflareTunnel = url?.hostname.endsWith('.trycloudflare.com') === true
  const directDnsFailure = [...directCodes].some((code) =>
    ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'EAI_FAIL'].includes(code),
  )
  if (proxyFallbackFailed && temporaryCloudflareTunnel && directDnsFailure) {
    throw new AppError(
      'MAIL_ACCESS_URL_EXPIRED',
      '临时邮箱接码域名已经失效，请更新该邮箱的接码链接。',
      { statusCode: 410, retryable: false, cause: error },
    )
  }
  if (proxyFallbackFailed) {
    throw new AppError('MAIL_PROXY_FALLBACK_FAILED', '邮箱接口直连失败，本机 HTTPS 代理重试也失败。', {
      statusCode: 502,
      retryable: true,
      cause: error,
    })
  }

  if (
    [...codes].some((code) =>
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code),
    )
  ) {
    throw new AppError('MAIL_REQUEST_TIMEOUT', '邮箱接口单次请求超时。', {
      statusCode: 504,
      retryable: true,
      cause: error,
    })
  }
  if (
    [...codes].some((code) =>
      ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'EAI_FAIL'].includes(code),
    )
  ) {
    throw new AppError('MAIL_DNS_ERROR', '邮箱域名当前无法解析。', {
      statusCode: 502,
      retryable: true,
      cause: error,
    })
  }
  if (
    [...codes].some(
      (code) =>
        code.startsWith('ERR_SSL_') ||
        code.startsWith('ERR_TLS_') ||
        code.includes('CERT') ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
    )
  ) {
    throw new AppError('MAIL_TLS_ERROR', '邮箱接口 TLS 握手或证书校验失败。', {
      statusCode: 502,
      retryable: true,
      cause: error,
    })
  }
  if (
    [...codes].some((code) =>
      ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET'].includes(code),
    )
  ) {
    throw new AppError('MAIL_CONNECTION_ERROR', '邮箱接口连接被拒绝、重置或不可达。', {
      statusCode: 502,
      retryable: true,
      cause: error,
    })
  }
  throw new AppError('MAIL_NETWORK_ERROR', '无法连接邮箱接口。', {
    statusCode: 502,
    retryable: true,
    cause: error,
  })
}

export type MailboxOrdering = 'newest_first' | 'unknown'

export interface MailboxSnapshot {
  messages: MailMessage[]
  ordering: MailboxOrdering
}

export interface MailboxSource {
  listMessages(
    email: string,
    mailboxPassword: string,
    signal?: AbortSignal,
    trustedPathOrigins?: readonly string[],
  ): Promise<MailboxSnapshot>
}

export class MailboxClient implements MailboxSource {
  readonly #fetch: typeof fetch
  readonly #requestTimeoutMs: number
  readonly #maxResponseBytes: number
  readonly #systemHttpsProxyResolver: () => Promise<string | null>
  readonly #proxyFetch: MailboxProxyFetch
  readonly #trustedPathOrigins: () => readonly string[]

  constructor(fetchImpl: typeof fetch = fetch, options: MailboxClientOptions = {}) {
    this.#fetch = fetchImpl
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576
    this.#systemHttpsProxyResolver = options.systemHttpsProxyResolver ?? resolveLoopbackMacOsHttpsProxy
    this.#proxyFetch = options.proxyFetch ?? fetchThroughProxy
    this.#trustedPathOrigins = options.trustedPathOrigins ?? (() => BUILT_IN_PATH_MAILBOX_ORIGINS)
  }

  async #fetchPathMailboxHop(
    url: URL,
    signal: AbortSignal | undefined,
    activeProxyUrl: string | null,
    requestInit: RequestInit = { method: 'GET' },
    requestTimeoutMs = this.#requestTimeoutMs,
  ): Promise<{ response: Response; proxyUrl: string | null }> {
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const init: RequestInit = { ...requestInit, redirect: 'manual', signal: requestSignal }

    if (activeProxyUrl) {
      try {
        return {
          response: await this.#proxyFetch(url, init, activeProxyUrl, this.#maxResponseBytes),
          proxyUrl: activeProxyUrl,
        }
      } catch (error) {
        throwPathMailboxRequestFailure(error, signal, timeoutSignal, true, url)
      }
    }

    try {
      return { response: await this.#fetch(url, init), proxyUrl: null }
    } catch (directError) {
      if (signal?.aborted || timeoutSignal.aborted) {
        throwPathMailboxRequestFailure(directError, signal, timeoutSignal)
      }

      let proxyUrl: string | null
      try {
        proxyUrl = await this.#systemHttpsProxyResolver()
      } catch (proxyResolutionError) {
        throwPathMailboxRequestFailure(
          new AggregateError([directError, proxyResolutionError]),
          signal,
          timeoutSignal,
          true,
          url,
          directError,
        )
      }
      if (!proxyUrl) throwPathMailboxRequestFailure(directError, signal, timeoutSignal)

      try {
        return {
          response: await this.#proxyFetch(url, init, proxyUrl, this.#maxResponseBytes),
          proxyUrl,
        }
      } catch (proxyError) {
        throwPathMailboxRequestFailure(
          new AggregateError([directError, proxyError]),
          signal,
          timeoutSignal,
          true,
          url,
          directError,
        )
      }
    }
  }

  async #requestPathMailbox(
    email: string,
    initialUrl: URL,
    signal?: AbortSignal,
    redirectValidator: (email: string, url: URL) => string = parsePathMailboxUrl,
  ): Promise<Response> {
    const initialOrigin = initialUrl.origin
    let currentUrl = initialUrl
    let activeProxyUrl: string | null = null

    for (let redirects = 0; ; redirects += 1) {
      const hop = await this.#fetchPathMailboxHop(currentUrl, signal, activeProxyUrl)
      activeProxyUrl = hop.proxyUrl
      if (hop.response.status < 300 || hop.response.status >= 400) return hop.response

      await hop.response.body?.cancel().catch(() => undefined)
      if (redirects >= MAX_PATH_MAILBOX_REDIRECTS) {
        throw new AppError('MAIL_REDIRECT_LIMIT_EXCEEDED', '邮箱接口同源重定向次数过多。', {
          statusCode: 502,
        })
      }
      const location = hop.response.headers.get('location')
      if (!location) {
        throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了无法识别的重定向。', {
          statusCode: 502,
        })
      }

      let redirected: URL
      try {
        redirected = new URL(location, currentUrl)
      } catch {
        throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了无法识别的重定向。', {
          statusCode: 502,
        })
      }
      if (redirected.origin !== initialOrigin) {
        throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了跨域或协议变化的重定向。', {
          statusCode: 502,
        })
      }
      currentUrl = new URL(redirectValidator(email, redirected))
    }
  }

  async #requestCloudMailboxJson(
    url: URL,
    init: RequestInit,
    signal?: AbortSignal,
    classifyError?: (status: number, body: string) => AppError | null,
  ): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const hop = await this.#fetchPathMailboxHop(url, signal, null, { ...init, headers })
    const response = hop.response

    if (response.status >= 300 && response.status < 400) {
      throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了不受信任的重定向。', { statusCode: 502 })
    }
    if (!response.ok && classifyError) {
      const body = await readBoundedBody(response, this.#maxResponseBytes)
      const classified = classifyError(response.status, body)
      if (classified) throw classified
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接需要有效访问授权。', { statusCode: 401 })
    }
    if (response.status === 404) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
    }
    if (response.status === 429) {
      throw new AppError('MAIL_RATE_LIMITED', '邮箱接口请求过于频繁。', {
        statusCode: 429,
        retryable: true,
        details: { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) ?? 3000 },
      })
    }
    if (!response.ok) {
      throw new AppError('MAIL_HTTP_ERROR', `邮箱接口暂时不可用（HTTP ${response.status}）。`, {
        statusCode: 502,
        retryable: response.status >= 500,
      })
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
    }

    const body = await readBoundedBody(response, this.#maxResponseBytes)
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回的 JSON 无法解析。', {
        statusCode: 502,
        cause: error,
      })
    }
  }

  async #listCloudMailboxMessages(
    email: string,
    accessUrl: URL,
    signal?: AbortSignal,
  ): Promise<MailboxSnapshot> {
    const token = accessUrl.pathname.slice(CLOUD_MAILBOX_PREFIX.length)
    const apiBase = new URL(`/api/public/${encodeURIComponent(token)}/`, CLOUD_MAILBOX_ORIGIN)

    const metaResult = cloudMailboxMetaSchema.safeParse(
      await this.#requestCloudMailboxJson(new URL('meta', apiBase), { method: 'GET' }, signal),
    )
    if (!metaResult.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口元数据结构发生变化。', { statusCode: 502 })
    }
    if (metaResult.data.filterEmail.toLowerCase() !== email.toLowerCase()) {
      throw new AppError('MAIL_ACCESS_URL_EMAIL_MISMATCH', '邮箱接口链接中的邮箱与账号邮箱不一致。')
    }
    if (metaResult.data.codeRequired && !metaResult.data.authorized) {
      throw new AppError(
        'MAIL_ACCESS_CODE_REQUIRED',
        '该邮箱取件链接需要访问码，当前任务只支持无需访问码的分享链接。',
        { statusCode: 409 },
      )
    }

    const syncResult = cloudMailboxSyncSchema.safeParse(
      await this.#requestCloudMailboxJson(new URL('sync', apiBase), { method: 'POST' }, signal),
    )
    if (!syncResult.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱同步接口结构发生变化。', { statusCode: 502 })
    }

    const messagesResult = cloudMailboxMessagesSchema.safeParse(
      await this.#requestCloudMailboxJson(new URL('messages', apiBase), { method: 'GET' }, signal),
    )
    if (!messagesResult.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱邮件列表结构发生变化。', { statusCode: 502 })
    }

    const summaries = [...messagesResult.data.messages]
      .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
      .slice(0, 5)
    const details = await Promise.all(
      summaries.map(async (summary) => {
        const id = String(summary.id)
        const detailResult = cloudMailboxMessageDetailSchema.safeParse(
          await this.#requestCloudMailboxJson(
            new URL(`messages/${encodeURIComponent(id)}`, apiBase),
            { method: 'GET' },
            signal,
          ),
        )
        if (!detailResult.success || (detailResult.data.id !== undefined && String(detailResult.data.id) !== id)) {
          throw new AppError('MAIL_RESPONSE_INVALID', '邮箱邮件详情结构发生变化。', { statusCode: 502 })
        }
        return {
          id,
          from: detailResult.data.from ?? summary.from ?? '',
          subject: detailResult.data.subject ?? summary.subject ?? '',
          body: detailResult.data.body,
          receivedAt: detailResult.data.receivedAt ?? summary.receivedAt,
        }
      }),
    )

    const messages = normalizeMailboxResponse('application/json', JSON.stringify({ messages: details }))
      .sort((left, right) => Date.parse(right.receivedAt ?? '') - Date.parse(left.receivedAt ?? ''))
    return {
      messages,
      ordering: 'newest_first',
    }
  }

  async #listAisvipMessages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const linkId = accessUrl.pathname.slice(AISVIP_PREFIX.length)
    const apiUrl = new URL(`/api/public/latest-code/${encodeURIComponent(linkId)}`, AISVIP_ORIGIN)
    apiUrl.searchParams.set('token', accessUrl.searchParams.get('token')!)
    let payload: unknown
    for (let attempt = 1; ; attempt += 1) {
      try {
        payload = await this.#requestCloudMailboxJson(apiUrl, { method: 'GET' }, signal)
        break
      } catch (error) {
        if (!(error instanceof AppError) || !error.retryable || attempt >= AISVIP_REQUEST_ATTEMPTS) throw error
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500)
          timer.unref?.()
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          }, { once: true })
        })
      }
    }
    const parsed = aisvipLatestCodeSchema.safeParse(payload)
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取码接口响应结构发生变化。', { statusCode: 502 })
    }
    if (!parsed.data.ok) {
      throw new AppError('MAIL_HTTP_ERROR', parsed.data.error || '邮箱取码接口暂时不可用。', {
        statusCode: 502,
        retryable: parsed.data.status !== 'unauthorized',
      })
    }
    const code = String(parsed.data.code ?? '').trim()
    if (!code) return { messages: [], ordering: 'newest_first' }
    if (!/^\d{6}$/.test(code)) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取码接口返回了无效验证码。', { statusCode: 502 })
    }
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: [{
            id: parsed.data.checked_at == null ? undefined : String(parsed.data.checked_at),
            sender: parsed.data.sender || 'OpenAI',
            subject: parsed.data.subject || 'OpenAI verification code',
            text: code,
            received_at: parsed.data.mail_time ?? parsed.data.checked_at ?? undefined,
          }],
        }),
      ),
      ordering: 'newest_first',
    }
  }

  async #listBomyiMessages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const parsed = bomyiResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'mail.bomyi.com 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    if (!parsed.data.success) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', 'mail.bomyi.com 共享邮箱链接无效或已经失效。', {
        statusCode: 401,
      })
    }
    const messages = parsed.data.data ?? []
    for (const message of messages) requireMatchingEmail(message.recipient, email)
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: messages.map((message) => ({
            id: message.id,
            from: message.from_address || message.from_name || 'OpenAI',
            subject: message.subject,
            text: `${message.preview ?? ''}\n${message.verification_code ?? ''}`,
            received_at: message.created_at,
          })),
        }),
      ),
      ordering: 'newest_first',
    }
  }

  async #listGptMailMessages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const parsed = gptMailResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    if (parsed.data.data === null) return { messages: [], ordering: 'unknown' }
    const message = parsed.data.data
    requireMatchingEmail(message.address, email)
    if (!message.subject?.trim() && !message.snippet?.trim() && message.sent_at === null) {
      return { messages: [], ordering: 'unknown' }
    }
    if (message.sent_at !== null && Number.isNaN(Date.parse(message.sent_at))) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了无效的邮件时间。', { statusCode: 502 })
    }
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: [
            {
              from: 'OpenAI',
              subject: message.subject ?? '',
              text: message.snippet ?? '',
              received_at: message.sent_at ?? undefined,
            },
          ],
        }),
      ),
      ordering: 'unknown',
    }
  }

  async #listMailOtpMessages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const parsed = mailOtpResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱验证码接口响应结构发生变化。', { statusCode: 502 })
    }
    if (!parsed.data.success) {
      const error = parsed.data.error?.trim() ?? ''
      if (/^(?:未找到收件人为.+的邮件|暂无邮件|暂未收到邮件)$/.test(error)) {
        return { messages: [], ordering: 'newest_first' }
      }
      if (/(?:token|令牌|凭证)/i.test(error) && /(?:无效|错误|缺少|过期|invalid|missing|expired)/i.test(error)) {
        throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件 Token 无效或已经失效。', { statusCode: 401 })
      }
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱验证码接口返回了无法确认的失败状态。', {
        statusCode: 502,
      })
    }

    const code = parsed.data.code?.trim() ?? ''
    if (!code && (parsed.data.count ?? 0) === 0) return { messages: [], ordering: 'newest_first' }
    if (!/^\d{6}$/.test(code)) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱验证码接口没有返回唯一六位验证码。', {
        statusCode: 502,
      })
    }
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({ messages: [{ from: 'OpenAI', subject: 'ChatGPT 登录验证码', text: code }] }),
      ),
      ordering: 'newest_first',
    }
  }

  async #listChinaAgarwoodMessages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const parsed = chinaAgarwoodResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱验证码接口响应结构发生变化。', { statusCode: 502 })
    }
    const messages = parsed.data
      .filter((entry) => /^\d{6}$/.test(String(entry.otp)))
      .map((entry) => ({
        from: 'OpenAI',
        subject: '登录验证码',
        text: String(entry.otp),
        received_at: entry.time,
      }))
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages })),
      ordering: 'newest_first',
    }
  }

  async #listYisenMailMessages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const requestUrl = new URL(accessUrl.toString())
    const fragment = new URLSearchParams(requestUrl.hash.slice(1))
    const token = fragment.get('jwt')!
    requestUrl.hash = ''
    const parsed = yisenMailResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(requestUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, signal),
    )
    if (!parsed.success || parsed.data.count < parsed.data.results.length) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'mail.yisen.uk 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    const messages = parsed.data.results.map((message) => {
      requireMatchingEmail(message.address, email)
      return {
        id: String(message.id),
        from: message.source ?? '',
        subject: '',
        text: message.raw,
        received_at: `${message.created_at.replace(' ', 'T')}Z`,
      }
    })
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages })),
      ordering: 'newest_first',
    }
  }

  async #listCloudflareMailboxMessages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const hop = await this.#fetchPathMailboxHop(accessUrl, signal, null, {
      method: 'GET',
      headers: { Accept: 'application/json, text/html;q=0.9, text/plain;q=0.8' },
    })
    const response = hop.response
    if (response.status >= 300 && response.status < 400) {
      throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了不受信任的重定向。', { statusCode: 502 })
    }
    if ([401, 403, 404, 410].includes(response.status)) {
      throw new AppError('MAIL_ACCESS_URL_EXPIRED', '临时邮箱接码链接已经失效。', { statusCode: 401 })
    }
    if (response.status === 400 && isCloudflareCodeEmailLink(accessUrl)) {
      const body = await readBoundedBody(response, this.#maxResponseBytes)
      try {
        const payload = JSON.parse(body) as { ok?: unknown; error?: unknown }
        if (
          payload.ok === false &&
          typeof payload.error === 'string' &&
          /^(?:没有找到该邮箱|未找到该邮箱|暂无邮件|暂未收到邮件)$/.test(payload.error.trim())
        ) {
          return { messages: [], ordering: 'newest_first' }
        }
      } catch {
        // Unknown 400 responses retain the HTTP error below.
      }
      throw new AppError('MAIL_HTTP_ERROR', '邮箱接口暂时不可用（HTTP 400）。', {
        statusCode: 502,
        retryable: false,
      })
    }
    if (!response.ok) {
      throw new AppError('MAIL_HTTP_ERROR', `邮箱接口暂时不可用（HTTP ${response.status}）。`, {
        statusCode: 502,
        retryable: response.status >= 500,
      })
    }
    const body = await readBoundedBody(response, this.#maxResponseBytes)
    return {
      messages: normalizeMailboxResponse(response.headers.get('content-type') ?? 'text/plain', body),
      ordering: 'newest_first',
    }
  }

  async #listMcZeroMessages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const requestUrl = new URL(accessUrl.toString())
    requestUrl.searchParams.set('format', 'json')
    const parsed = mcZeroResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(requestUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'mail.mczero.top 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    if (parsed.data.state === 'error') {
      throw new AppError('MAIL_HTTP_ERROR', 'mail.mczero.top 邮箱同步暂时失败。', {
        statusCode: 502,
        retryable: true,
      })
    }
    const message = parsed.data.message
    if (!message) {
      if (parsed.data.state === 'empty' || parsed.data.state === 'syncing') {
        return { messages: [], ordering: 'newest_first' }
      }
      throw new AppError('MAIL_RESPONSE_INVALID', 'mail.mczero.top 邮箱接口缺少邮件内容。', { statusCode: 502 })
    }
    if (parsed.data.message_id != null && String(parsed.data.message_id) !== String(message.id)) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'mail.mczero.top 邮箱接口邮件标识不一致。', { statusCode: 502 })
    }

    const previewWithCodes = [
      message.preview,
      message.codes.length ? `<p>${message.codes.join(' ')}</p>` : '',
    ]
      .filter(Boolean)
      .join('\n')
    const messages = normalizeMailboxResponse(
      'application/json',
      JSON.stringify({
        messages: [
          {
            id: String(message.id),
            from: message.from,
            subject: message.subject,
            html_body: previewWithCodes,
            received_at: message.received_at ?? message.date,
          },
        ],
      }),
    )
    return { messages, ordering: 'newest_first' }
  }

  async #list776867Messages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const accessId = accessUrl.pathname.slice(MAIL_776867_PREFIX.length)
    const parsed = mail776867ResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(
        new URL('/api/pickup', MAIL_776867_ORIGIN),
        { method: 'POST', body: JSON.stringify({ access_id: accessId, sync: false }) },
        signal,
      ),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取件接口响应结构发生变化。', { statusCode: 502 })
    }
    if (!parsed.data.ok) {
      const error = parsed.data.error ?? ''
      if (/(?:token|access|凭证|访问)/i.test(error) && /(?:无效|错误|缺少|过期|invalid|missing|expired)/i.test(error)) {
        throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
      }
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取件接口返回了无法确认的失败状态。', {
        statusCode: 502,
      })
    }
    if (!parsed.data.email) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取件接口缺少邮箱身份。', { statusCode: 502 })
    }
    requireMatchingEmail(parsed.data.email, email)

    const messages = [...(parsed.data.messages ?? [])]
      .sort((left, right) => {
        const leftTime = left.received_at ? Date.parse(left.received_at) : Number.NaN
        const rightTime = right.received_at ? Date.parse(right.received_at) : Number.NaN
        if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0
        if (Number.isNaN(leftTime)) return 1
        if (Number.isNaN(rightTime)) return -1
        return rightTime - leftTime
      })
      .slice(0, 5)
      .map((message) => ({
        id: message.uid,
        from: message.sender ?? '',
        subject: message.subject ?? '',
        text: [message.body_text, message.body_preview, message.code]
          .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
          .join('\n'),
        html: message.body_html ?? undefined,
        received_at: message.received_at ?? undefined,
      }))
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages })),
      ordering: 'unknown',
    }
  }

  async #listFlySmsMessages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const fragment = new URLSearchParams(accessUrl.hash.slice(1))
    const token = fragment.get('key') ?? ''
    const parsed = flySmsResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(
        new URL('/icloud/api/pickup/messages/latest', FLYSMS_ORIGIN),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Mailbox-Email': email,
          },
        },
        signal,
        (status, body) => {
          if (status !== 403) return null
          try {
            const error = flySmsErrorSchema.safeParse(JSON.parse(body))
            if (error.success && error.data.code === 'ACCOUNT_EXPIRED') {
              return new AppError('MAILBOX_ACCOUNT_EXPIRED', '邮箱接码服务已确认该邮箱过期。', {
                statusCode: 409,
                retryable: false,
              })
            }
          } catch {
            // Unknown error bodies retain the generic authentication failure.
          }
          return null
        },
      ),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱取件接口响应结构发生变化。', { statusCode: 502 })
    }
    requireMatchingEmail(parsed.data.email, email)
    if (parsed.data.message === null) return { messages: [], ordering: 'newest_first' }
    requireMatchingEmail(parsed.data.message.mailbox, email)
    const message = parsed.data.message
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: [
            {
              id: message.uid,
              from: message.from ?? '',
              subject: message.subject ?? '',
              text: message.text ?? '',
              html: message.html ?? undefined,
              received_at:
                message.mailboxReceivedAt ?? message.ingestedAt ?? message.sentAt ?? message.date ?? undefined,
            },
          ],
        }),
      ),
      ordering: 'newest_first',
    }
  }

  async #listDesk360Messages(email: string, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const parsed = desk360ResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(
        new URL(DESK360_API_PATH, DESK360_ORIGIN),
        { method: 'POST', body: JSON.stringify({ email, minutes: 60 }) },
        signal,
      ),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '360Desk 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    requireMatchingEmail(parsed.data.email, email)
    if (parsed.data.count < parsed.data.messages.length) {
      throw new AppError('MAIL_RESPONSE_INVALID', '360Desk 邮箱接口邮件数量无效。', { statusCode: 502 })
    }
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: parsed.data.messages.slice(0, 20).map((message) => ({
            from: message.from ?? '',
            subject: message.subject ?? '',
            text: message.preview ?? '',
            received_at: message.received_at,
          })),
        }),
      ),
      ordering: 'unknown',
    }
  }

  async #listAigatewayPickupMessages(
    email: string,
    accessUrl: URL,
    signal?: AbortSignal,
  ): Promise<MailboxSnapshot> {
    const parsed = aigatewayPickupResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'AIgateway 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    const nested = parsed.data.data
    const identity = parsed.data.email ?? parsed.data.address ??
      (typeof parsed.data.mailbox === 'string' ? parsed.data.mailbox : parsed.data.mailbox?.email) ??
      nested?.email ?? nested?.address ??
      (typeof nested?.mailbox === 'string' ? nested.mailbox : nested?.mailbox?.email)
    if (identity) requireMatchingEmail(identity, email)
    const messages = parsed.data.messages ?? parsed.data.data?.messages
    if (!messages) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'AIgateway 邮箱接口缺少邮件列表。', { statusCode: 502 })
    }
    const normalized = messages
      .filter((message) => /\b(?:openai|chatgpt)\b/i.test([
        message.from, message.sender, message.subject, message.preview, message.text, message.body, message.html,
      ].filter(Boolean).join('\n')))
      .map((message) => ({
        id: message.id ?? message.uid,
        from: message.from ?? message.sender ?? '',
        subject: message.subject ?? '',
        text: [message.text, message.body, message.preview, message.code].filter(Boolean).join('\n'),
        html: message.html ?? undefined,
        received_at: message.received_at ?? message.receivedAt ?? message.date ?? undefined,
      }))
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages: normalized })),
      ordering: 'unknown',
    }
  }

  async #listApi798Messages(accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    const hop = await this.#fetchPathMailboxHop(accessUrl, signal, null, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
    })
    const response = hop.response
    if (response.status >= 300 && response.status < 400) {
      throw new AppError('MAIL_REDIRECT_REJECTED', 'api798 邮箱接口返回了不受信任的重定向。', { statusCode: 502 })
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', 'api798 邮箱取件授权无效。', { statusCode: 401 })
    }
    if (response.status === 429) {
      throw new AppError('MAIL_RATE_LIMITED', 'api798 邮箱接口请求过于频繁。', {
        statusCode: 429,
        retryable: true,
        details: { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) ?? 3000 },
      })
    }
    if (!response.ok) {
      throw new AppError('MAIL_HTTP_ERROR', `api798 邮箱接口暂时不可用（HTTP ${response.status}）。`, {
        statusCode: 502,
        retryable: response.status >= 500,
      })
    }
    const body = (await readBoundedBody(response, Math.min(this.#maxResponseBytes, 1_048_576))).trim()
    return {
      messages: normalizeApi798Response(response.headers.get('content-type') || 'text/plain', body),
      ordering: 'newest_first',
    }
  }

  async #listWebmail503Messages(
    email: string,
    accessUrl: URL,
    signal?: AbortSignal,
  ): Promise<MailboxSnapshot> {
    const parsed = webmail503ResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(accessUrl, { method: 'GET' }, signal),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'webmail.503.me 邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    requireMatchingEmail(parsed.data.email, email)
    if (!parsed.data.success) {
      return { messages: [], ordering: 'newest_first' }
    }
    if (parsed.data.count !== parsed.data.mails.length) {
      throw new AppError('MAIL_RESPONSE_INVALID', 'webmail.503.me 邮箱接口邮件数量无效。', { statusCode: 502 })
    }
    const messages = parsed.data.mails.flatMap((mail) => {
      const context = `${mail.from}\n${mail.subject}`
      if (!/\b(?:openai|chatgpt)\b/i.test(context)) return []
      const codes = new Set([mail.code, ...(mail.codes ?? [])].filter((code): code is string => /^\d{6}$/.test(code ?? '')))
      if (codes.size === 0) return []
      return [{
        id: mail.uid === undefined ? undefined : String(mail.uid),
        from: mail.from,
        subject: mail.subject,
        text: [...codes].join(' '),
        received_at: mail.date,
      }]
    })
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages })),
      ordering: 'newest_first',
    }
  }

  async #listCloudflareOtpMessages(
    email: string,
    accessUrl: URL,
    signal?: AbortSignal,
  ): Promise<MailboxSnapshot> {
    const token = new URLSearchParams(accessUrl.hash.slice(1)).get('otp') ?? ''
    const parsed = cloudflareOtpResponseSchema.safeParse(
      await this.#requestCloudMailboxJson(
        new URL('/api/otp', accessUrl.origin),
        { method: 'POST', body: JSON.stringify({ link_token: token }) },
        signal,
      ),
    )
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '动态邮箱接口响应结构发生变化。', { statusCode: 502 })
    }
    if (!parsed.data.ok) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
    }
    if (parsed.data.email) requireMatchingEmail(parsed.data.email, email)
    if (parsed.data.status === 'waiting') return { messages: [], ordering: 'newest_first' }
    const messages = parsed.data.messages ?? []
    const normalized = messages
      .filter((message) => /\b(?:openai|chatgpt)\b/i.test([
        message.from, message.sender, message.subject, message.preview, message.text, message.body, message.html,
      ].filter(Boolean).join('\n')))
      .map((message) => ({
        id: message.id ?? message.uid,
        from: message.from ?? message.sender ?? '',
        subject: message.subject ?? '',
        text: [message.text, message.body, message.preview, message.code].filter(Boolean).join('\n'),
        html: message.html ?? undefined,
        received_at: message.received_at ?? message.receivedAt ?? message.date ?? undefined,
      }))
    if (parsed.data.code && !normalized.some((message) => message.text.includes(parsed.data.code!))) {
      throw new AppError('MAIL_RESPONSE_INVALID', '动态邮箱验证码用途无法确认。', { statusCode: 502 })
    }
    return {
      messages: normalizeMailboxResponse('application/json', JSON.stringify({ messages: normalized })),
      ordering: 'newest_first',
    }
  }

  async #listMailComCodeMessages(email: string, accessUrl: URL, signal?: AbortSignal): Promise<MailboxSnapshot> {
    accessUrl.searchParams.set('max_age', '3600')
    const hop = await this.#fetchPathMailboxHop(accessUrl, signal, null, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const response = hop.response
    if (response.status >= 300 && response.status < 400) {
      throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了不受信任的重定向。', { statusCode: 502 })
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
    }
    if (response.status !== 200 && response.status !== 400) {
      throw new AppError('MAIL_HTTP_ERROR', `邮箱接口暂时不可用（HTTP ${response.status}）。`, {
        statusCode: 502,
        retryable: response.status >= 500,
      })
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
    }
    const body = await readBoundedBody(response, this.#maxResponseBytes)
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch (error) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回的 JSON 无法解析。', { statusCode: 502, cause: error })
    }
    const parsed = mailComCodeResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接码接口响应结构发生变化。', { statusCode: 502 })
    }
    requireMatchingEmail(parsed.data.email, email)
    if (parsed.data.code === null && parsed.data.mail === null) return { messages: [], ordering: 'newest_first' }
    if (!parsed.data.code || !parsed.data.mail) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接码接口返回了不完整的验证码结果。', { statusCode: 502 })
    }
    const mailText = JSON.stringify(parsed.data.mail)
    if (!/\b(?:openai|chatgpt)\b/i.test(mailText)) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接码接口返回的验证码用途无法确认。', { statusCode: 502 })
    }
    const mail = parsed.data.mail
    const stringField = (...keys: string[]): string | undefined => {
      for (const key of keys) if (typeof mail[key] === 'string' && mail[key].trim()) return mail[key]
      return undefined
    }
    const receivedAt = stringField('received_at', 'receivedAt', 'date', 'timestamp')
    return {
      messages: normalizeMailboxResponse(
        'application/json',
        JSON.stringify({
          messages: [{
            id: stringField('id', 'message_id', 'uid'),
            from: stringField('from', 'sender', 'from_email') ?? 'OpenAI',
            subject: stringField('subject', 'title') ?? 'OpenAI verification code',
            text: `${stringField('text', 'body', 'content', 'snippet') ?? ''}\n${parsed.data.code}`,
            received_at: receivedAt,
          }],
        }),
      ),
      ordering: 'newest_first',
    }
  }

  async listMessages(
    email: string,
    mailboxPassword: string,
    signal?: AbortSignal,
    trustedPathOrigins: readonly string[] = this.#trustedPathOrigins(),
  ): Promise<MailboxSnapshot> {
    const pathOrigins = effectivePathOrigins(trustedPathOrigins)
    const access = normalizeMailboxAccessInput(email, mailboxPassword, trustedPathOrigins)
    const fullAccessUrl = /^https?:\/\//i.test(access)
    const url = fullAccessUrl ? new URL(access) : new URL(MAILBOX_ENDPOINT)
    const builtInPathMailbox = fullAccessUrl && pathOrigins.has(url.origin)
    const icloudApiShowMailbox =
      fullAccessUrl &&
      url.origin === ICLOUD_API_ORIGIN &&
      normalizeMailboxPath(url.pathname).startsWith(ICLOUD_API_SHOW_PREFIX)
    const ai1998Mailbox = fullAccessUrl && url.origin === AI1998_ORIGIN
    const o6f4Mailbox = fullAccessUrl && url.origin === O6F4_ORIGIN
    const pathMailbox = (builtInPathMailbox || ai1998Mailbox) && !icloudApiShowMailbox
    const assurivoMailbox = fullAccessUrl && ASSURIVO_ORIGINS.has(url.origin)
    const blogTxFirstMail =
      fullAccessUrl && url.origin === BLOG_TX_ORIGIN && url.pathname === BLOG_TX_FIRSTMAIL_PATH
    if (fullAccessUrl && url.origin === CLOUD_MAILBOX_ORIGIN) {
      return this.#listCloudMailboxMessages(email, url, signal)
    }
    if (fullAccessUrl && url.origin === MCZERO_ORIGIN) return this.#listMcZeroMessages(url, signal)
    if (fullAccessUrl && GPTMAIL_ORIGINS.has(url.origin)) return this.#listGptMailMessages(email, url, signal)
    if (fullAccessUrl && url.origin === MAILOTP_ORIGIN) return this.#listMailOtpMessages(url, signal)
    if (fullAccessUrl && url.origin === CHINA_AGARWOOD_ORIGIN) {
      return this.#listChinaAgarwoodMessages(url, signal)
    }
    if (fullAccessUrl && url.origin === YISEN_MAIL_ORIGIN) return this.#listYisenMailMessages(email, url, signal)
    if (fullAccessUrl && url.origin === MAIL_776867_ORIGIN) return this.#list776867Messages(email, url, signal)
    if (fullAccessUrl && url.origin === FLYSMS_ORIGIN) return this.#listFlySmsMessages(email, url, signal)
    if (fullAccessUrl && url.origin === DESK360_ORIGIN) return this.#listDesk360Messages(email, signal)
    if (fullAccessUrl && url.origin === AIGATEWAY_ORIGIN) return this.#listAigatewayPickupMessages(email, url, signal)
    if (fullAccessUrl && url.origin === API798_ORIGIN) return this.#listApi798Messages(url, signal)
    if (fullAccessUrl && url.origin === WEBMAIL503_ORIGIN && url.pathname === WEBMAIL503_PATH) {
      return this.#listWebmail503Messages(email, url, signal)
    }
    if (fullAccessUrl && isCloudflareMailboxLink(url)) return this.#listCloudflareMailboxMessages(url, signal)
    if (fullAccessUrl && isCloudflareCodeEmailLink(url)) return this.#listCloudflareMailboxMessages(url, signal)
    if (fullAccessUrl && isCloudflareOtpLink(url)) return this.#listCloudflareOtpMessages(email, url, signal)
    if (fullAccessUrl && isMailComCodeOrigin(url)) return this.#listMailComCodeMessages(email, url, signal)
    if (fullAccessUrl && url.origin === AISVIP_ORIGIN) return this.#listAisvipMessages(url, signal)
    if (fullAccessUrl && url.origin === BOMYI_ORIGIN) return this.#listBomyiMessages(email, url, signal)
    const mailcatMailbox = fullAccessUrl && url.origin === MAILCAT_ORIGIN
    if (!fullAccessUrl) {
      url.searchParams.set('mail', email)
      url.searchParams.set('pwd', access)
      url.searchParams.set('limit', '5')
    }
    let response: Response
    if (pathMailbox) {
      response = await this.#requestPathMailbox(
        email,
        url,
        signal,
        ai1998Mailbox
          ? parseAi1998MailboxUrl
          : o6f4Mailbox
          ? parseO6f4Url
          : parsePathMailboxUrl,
      )
    } else if (icloudApiShowMailbox) {
      response = await this.#requestPathMailbox(email, url, signal, parseIcloudApiShowUrl)
    } else if (assurivoMailbox) {
      response = (await this.#fetchPathMailboxHop(url, signal, null)).response
    } else if (fullAccessUrl) {
      const requestUrl = new URL(url.toString())
      const fragment = new URLSearchParams(requestUrl.hash.slice(1))
      const fragmentJwt = fragment.get('jwt') ?? fragment.get('bearer') ?? fragment.get('access_token')
      requestUrl.hash = ''
      response = (
        await this.#fetchPathMailboxHop(
          requestUrl,
          signal,
          null,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json, text/html;q=0.9, text/plain;q=0.8, message/rfc822;q=0.8',
              ...(fragmentJwt && YISEN_MAIL_JWT.test(fragmentJwt)
                ? { Authorization: `Bearer ${fragmentJwt}` }
                : {}),
            },
          },
          blogTxFirstMail ? Math.max(this.#requestTimeoutMs, 30_000) : this.#requestTimeoutMs,
        )
      ).response
    } else {
      const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      try {
        response = await this.#fetch(url, { method: 'GET', redirect: 'manual', signal: requestSignal })
      } catch (error) {
        throwMailboxRequestFailure(error, signal, timeoutSignal)
      }
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AppError('MAIL_REDIRECT_REJECTED', '邮箱接口返回了不受信任的重定向。', { statusCode: 502 })
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱账号或取件密码无效。', { statusCode: 401 })
    }
    if (fullAccessUrl && (response.status === 404 || response.status === 410)) {
      if (pathMailbox || icloudApiShowMailbox) {
        throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
      }
      throw new AppError('MAIL_ACCESS_URL_EXPIRED', '邮箱取件链接无效或已经失效。', { statusCode: 401 })
    }
    if (response.status === 429) {
      throw new AppError('MAIL_RATE_LIMITED', '邮箱接口请求过于频繁。', {
        statusCode: 429,
        retryable: true,
        details: { retryAfterMs: retryAfterMs(response.headers.get('retry-after')) ?? 3000 },
      })
    }
    if (!response.ok) {
      throw new AppError('MAIL_HTTP_ERROR', `邮箱接口暂时不可用（HTTP ${response.status}）。`, {
        statusCode: 502,
        retryable: response.status >= 500,
      })
    }

    const body = await readBoundedBody(response, this.#maxResponseBytes)
    if (assurivoMailbox && !response.headers.get('content-type')?.toLowerCase().includes('json')) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
    }
    if (blogTxFirstMail && !response.headers.get('content-type')?.toLowerCase().includes('html')) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
    }
    if (icloudApiShowMailbox && !response.headers.get('content-type')?.toLowerCase().includes('html')) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
    }
    return {
      messages: blogTxFirstMail
        ? normalizeBlogTxFirstMailHtml(email, body)
        : icloudApiShowMailbox
        ? normalizeIcloudApiShowHtml(body)
        : mailcatMailbox
        ? normalizeMailcatHtml(email, body)
        : normalizeMailboxResponse(
            response.headers.get('content-type') || '',
            body,
            pathMailbox ? 'path_page' : 'default',
          ),
      ordering: assurivoMailbox || blogTxFirstMail || mailcatMailbox ? 'newest_first' : 'unknown',
    }
  }
}
