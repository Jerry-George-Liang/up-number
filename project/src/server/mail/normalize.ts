import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { z } from 'zod'
import { AppError } from '../../shared/errors'

export interface MailMessage {
  id?: string
  sender: string
  subject: string
  text: string
  receivedAt?: string
  fingerprint: string
}

const rawMessageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    message_id: z.union([z.string(), z.number()]).optional(),
    mail_id: z.union([z.string(), z.number()]).optional(),
    from: z.string().optional(),
    sender: z.string().optional(),
    from_email: z.string().optional(),
    subject: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    body: z.string().optional(),
    content: z.string().optional(),
    html: z.string().optional(),
    html_body: z.string().nullish(),
    snippet: z.string().nullish(),
    body_excerpt: z.string().nullish(),
    raw: z.string().max(2_000_000).nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
    otp: z.union([z.string(), z.number()]).nullish(),
    verification_code: z.union([z.string(), z.number()]).nullish(),
    verificationCode: z.union([z.string(), z.number()]).nullish(),
    received_at: z.union([z.string(), z.number()]).optional(),
    receivedAt: z.union([z.string(), z.number()]).optional(),
    date: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    saved_at: z.union([z.string(), z.number()]).optional(),
    created_at: z.union([z.string(), z.number()]).optional(),
    sent_at: z.union([z.string(), z.number()]).optional(),
    mail_time: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function htmlToText(value: string): string {
  const $ = load(value)
  $('*').contents().filter((_index, node) => node.type === 'comment').remove()
  $('script, style, noscript, template').remove()
  $('br').replaceWith(' ')
  $('address, article, aside, blockquote, div, footer, h1, h2, h3, h4, h5, h6, header, li, main, p, section, td, th').each(
    (_index, element) => {
      $(element).append(' ')
    },
  )
  return cleanText($.text())
}

function bodyToText(value: string | undefined): string | undefined {
  if (!value) return value
  return /<\/?[A-Za-z][^>]*>/.test(value) ? htmlToText(value) : value
}

function normalizeDate(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  let date: Date
  if (typeof value === 'number') date = new Date(value < 10_000_000_000 ? value * 1000 : value)
  else if (/^\d+$/.test(value)) {
    const numeric = Number(value)
    date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
  } else date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function fingerprint(parts: Array<string | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => cleanText(part ?? '').toLowerCase()).join('\u0000'))
    .digest('hex')
}

function buildMessage(input: {
  id?: string
  sender?: string
  subject?: string
  text?: string
  receivedAt?: string
}): MailMessage {
  const sender = cleanText(input.sender ?? '')
  const subject = cleanText(input.subject ?? '')
  const text = cleanText(input.text ?? '')
  const id = input.id?.trim() || undefined
  const receivedAt = input.receivedAt
  return {
    ...(id ? { id } : {}),
    sender,
    subject,
    text,
    ...(receivedAt ? { receivedAt } : {}),
    fingerprint: fingerprint([id, sender, subject, receivedAt, text]),
  }
}

const GENERIC_MESSAGE_KEYS = ['messages', 'mails', 'emails', 'items', 'results', 'data', 'records', 'inbox', 'mailbox']

function looksLikeMessageRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value as Record<string, unknown>).map((key) => key.toLowerCase())
  if (keys.some((key) => GENERIC_MESSAGE_KEYS.includes(key))) return false
  return Object.keys(value as Record<string, unknown>).some((key) =>
    /(?:subject|sender|from|body|content|text|preview|snippet|message|code|otp|verification)/i.test(key),
  )
}

function explicitJsonCollection(payload: unknown, depth = 0): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object' || depth > 5) {
    throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了无效的 JSON。', { statusCode: 502 })
  }
  if (looksLikeMessageRecord(payload)) return [payload]
  const record = payload as Record<string, unknown>
  for (const key of GENERIC_MESSAGE_KEYS) {
    const value = record[key]
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') {
      try {
        return explicitJsonCollection(value, depth + 1)
      } catch {
        // Continue searching sibling containers.
      }
    }
  }
  for (const value of Object.values(record)) {
    if (!value || typeof value !== 'object') continue
    try {
      return explicitJsonCollection(value, depth + 1)
    } catch {
      // Ignore metadata objects that are not mail containers.
    }
  }
  return [payload]
}

function genericRecordText(value: unknown, key = '', depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    if (/(?:password|passwd|token|secret|authorization|cookie|access[_-]?key)/i.test(key)) return ''
    return /html/i.test(key) ? htmlToText(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => genericRecordText(item, key, depth + 1)).join(' ')
  return Object.entries(value as Record<string, unknown>)
    .map(([childKey, childValue]) => genericRecordText(childValue, childKey, depth + 1))
    .filter(Boolean)
    .join(' ')
}

function genericMessageText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return genericRecordText(value)
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => /(?:subject|sender|from|body|content|text|preview|snippet|message|code|otp|verification)/i.test(key))
    .map(([key, childValue]) => genericRecordText(childValue, key))
    .filter(Boolean)
    .join(' ')
}

function normalizeJson(body: string): MailMessage[] {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (error) {
    throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回的 JSON 无法解析。', {
      statusCode: 502,
      cause: error,
    })
  }
  return explicitJsonCollection(payload).map((item, index) => {
    const parsed = rawMessageSchema.safeParse(item)
    if (!parsed.success) {
      return buildMessage({
        id: `generic-${index}`,
        sender: 'OpenAI',
        subject: 'OpenAI verification code',
        text: genericMessageText(item),
      })
    }
    const raw = parsed.data
    const idValue = raw.id ?? raw.message_id ?? raw.mail_id
    const html = raw.html ? htmlToText(raw.html) : undefined
    const htmlBody = raw.html_body ? htmlToText(raw.html_body) : undefined
    const text = [
      raw.text,
      bodyToText(raw.body),
      raw.content,
      html,
      htmlBody,
      raw.snippet,
      raw.body_excerpt,
      raw.raw,
      raw.code,
      raw.otp,
      raw.verification_code,
      raw.verificationCode,
      genericMessageText(item),
    ].find(
      (value): value is string | number =>
        (typeof value === 'string' || typeof value === 'number') && cleanText(String(value)) !== '',
    )
    return buildMessage({
      id: idValue === undefined ? `generic-${index}` : String(idValue),
      sender: raw.from ?? raw.sender ?? raw.from_email ?? 'OpenAI',
      subject: raw.subject ?? raw.title ?? 'OpenAI verification code',
      text: text === undefined ? genericMessageText(item) : String(text),
      receivedAt: normalizeDate(
        raw.received_at ??
          raw.receivedAt ??
          raw.date ??
          raw.timestamp ??
          raw.saved_at ??
          raw.created_at ??
          raw.sent_at ??
          raw.mail_time,
      ),
    })
  })
}

function normalizeGenericText(body: string): MailMessage[] {
  const text = cleanText(body)
  if (
    !text ||
    /^(?:暂无验证码|暂无邮件|未找到验证码|未找到匹配的邮件|没有找到匹配的邮件|no (?:code|mail)(?: found)?|no matching mail(?: found)?|empty)[。.!！]?$/i.test(
      text,
    )
  ) {
    return []
  }
  if (!/\b(?:openai|chatgpt)\b|(?:verification|one[- ]time|code|otp|验证码|登录代码|登录码)/i.test(text) && !/^\d{6}$/.test(text)) {
    return []
  }
  return [buildMessage({ sender: 'OpenAI', subject: 'OpenAI verification code', text })]
}

const API798_LABELED_OTP =
  /(?:verification\s*(?:code|number)?|one[- ]time\s*(?:code|password)?|\bcode\b|otp|验证码|登录(?:代码|码)|安全码)\D{0,32}(\d{6})/gi
const API798_OTP = /(?<!\d)\d{6}(?!\d)/g

/**
 * api798 exposes the latest result as an HTML page for some mailbox records,
 * even when the endpoint was requested with Accept: text/plain. That page is
 * not a mailbox list, so requiring a DOM card would reject an otherwise valid
 * result. Keep only code-bearing fragments so dynamic page chrome does not
 * change the baseline fingerprint on every poll.
 */
export function normalizeApi798Response(contentType: string, body: string): MailMessage[] {
  const normalizedType = contentType.toLowerCase()
  if (normalizedType.includes('json')) return normalizeJson(body)
  if (!normalizedType.includes('html')) return normalizeGenericText(body)

  const text = htmlToText(body)
  if (!text) return []
  const labeled = [...text.matchAll(API798_LABELED_OTP)].map((match) => match[1]).filter(Boolean)
  const codes = [...new Set(labeled.length > 0 ? labeled : [...text.matchAll(API798_OTP)].map((match) => match[0]))]
  if (codes.length === 0) return []

  return [
    buildMessage({
      sender: 'OpenAI',
      subject: 'OpenAI verification code',
      text: `OpenAI verification code ${codes.join(' ')}`,
    }),
  ]
}

function normalizeHtml(body: string): MailMessage[] {
  const $ = load(body)
  const result: MailMessage[] = []

  $('article.mail').each((_index, element) => {
    const container = $(element)
    const subject = container.find('.mail-head h2.subject, .mail-head h2').first().text()
    let sender = ''
    let receivedRaw: string | undefined
    container.find('.mail-head .meta span').each((_metaIndex, metaElement) => {
      const value = cleanText($(metaElement).text())
      if (/^发件人\s*[:：]/.test(value)) sender = value.replace(/^发件人\s*[:：]\s*/, '')
      if (/^时间\s*[:：]/.test(value)) receivedRaw = value.replace(/^时间\s*[:：]\s*/, '')
    })
    const srcdoc = container.find('iframe.body-frame[srcdoc], iframe[srcdoc]').first().attr('srcdoc')
    if (!cleanText(subject) || !cleanText(sender) || !srcdoc) {
      throw new AppError('MAIL_RESPONSE_INVALID', '邮箱 HTML 邮件结构不完整。', { statusCode: 502 })
    }
    result.push(
      buildMessage({
        sender,
        subject,
        text: htmlToText(srcdoc),
        receivedAt: normalizeDate(receivedRaw),
      }),
    )
  })

  $('.mail-item, .mail-card, [data-mail-item], article[data-message-id]:not(.mail), tr[data-message-id], tr[data-id]').each((_index, element) => {
    const container = $(element)
    const id =
      container.attr('data-message-id') ?? container.attr('data-id') ?? container.find('[data-message-id]').attr('data-message-id')
    let sender = container.find('.mail-from, .sender, [data-field="from"]').first().text()
    if (!cleanText(sender)) {
      const meta = cleanText(container.find('.meta').first().text())
      sender = meta.replace(/^.*?(?:发件人|from)\s*[:：]\s*/i, '').replace(/\s+(?:收件人|to)\s*[:：].*$/i, '')
    }
    const subject = container.find('.mail-subject, .subject, [data-field="subject"]').first().text()
    const text = container.find('.mail-body, .body, .body-rich, .content, [data-field="body"]').first().text()
    const receivedRaw =
      container.attr('data-received-at') ??
      container.find('time').first().attr('datetime') ??
      (cleanText(container.find('.date').first().text()) || undefined)
    result.push(buildMessage({ id, sender, subject, text, receivedAt: normalizeDate(receivedRaw) }))
  })

  const recognizedEmptyShell =
    ($('.top .top-inner').length > 0 && $('.shell').length > 0 && $('.notice').length > 0) ||
    ($('.wrap .header').length > 0 && ($('.wrap .empty').length > 0 || $('.wrap .header + .empty').length > 0))
  if (result.length === 0 && !recognizedEmptyShell && cleanText($('body').text())) {
    const generic = normalizeGenericText(htmlToText(body))
    if (generic.length > 0) return generic
    throw new AppError('MAIL_RESPONSE_INVALID', '邮箱 HTML 不包含受支持的邮件结构。', { statusCode: 502 })
  }
  return result
}

function normalizePathMailboxHtml(body: string): MailMessage[] {
  const $ = load(body)
  const structuredSelector =
    'article.mail, .mail-item, .mail-card, [data-mail-item], article[data-message-id], tr[data-message-id], tr[data-id]'
  if ($(structuredSelector).length > 0) return normalizeHtml(body)

  const recognizedEmptyShell =
    ($('.top .top-inner').length > 0 && $('.shell').length > 0 && $('.notice').length > 0) ||
    ($('.wrap .header').length > 0 && ($('.wrap .empty').length > 0 || $('.wrap .header + .empty').length > 0))
  if (recognizedEmptyShell) return []

  $('script, style, noscript, template').remove()
  const text = cleanText($('body').text())
  const hasMailboxHeading = /(?:最新邮件|收件箱|latest\s+(?:mail|messages?)|recent\s+(?:mail|messages?)|inbox)/i.test(text)
  const hasMailboxAction = /(?:刷新|查看全部|refresh|view\s+all)/i.test(text)
  const recognizedShell = hasMailboxHeading && hasMailboxAction
  if (!recognizedShell) {
    throw new AppError('MAIL_PAGE_UNRECOGNIZED', '邮箱页面用途或邮件结构无法确认。', { statusCode: 502 })
  }

  if (!/\b(?:openai|chatgpt)\b/i.test(text)) return []
  const receivedAtMatch = text.match(
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}(?:\s+\([A-Z]+\))?/i,
  )
  return [
    buildMessage({
      sender: 'ChatGPT',
      subject: /临时\s*ChatGPT\s*登录代码/i.test(text) ? 'ChatGPT 登录验证码' : 'ChatGPT 邮件',
      text,
      receivedAt: normalizeDate(receivedAtMatch?.[0]),
    }),
  ]
}

export function normalizeFirstMailHtml(body: string): MailMessage[] {
  const $ = load(body)
  const pageText = cleanText($('body').text())
  const subject = $('h1, h2, h3, h4, .subject, [data-field="subject"]')
    .toArray()
    .map((element) => cleanText($(element).text()))
    .find((value) => /\b(?:openai|chatgpt)\b/i.test(value))
  const sender = $('body *')
    .toArray()
    .map((element) => cleanText($(element).clone().children().remove().end().text()))
    .find((value) => /^(?:发件人|from)\s*[:：]/i.test(value))
    ?.replace(/^(?:发件人|from)\s*[:：]\s*/i, '')
  const receivedRaw = $('body *')
    .toArray()
    .map((element) => cleanText($(element).clone().children().remove().end().text()))
    .find((value) => /^(?:时间|date)\s*[:：]/i.test(value))
    ?.replace(/^(?:时间|date)\s*[:：]\s*/i, '')
  const trustedHeader = `${subject ?? ''} ${sender ?? ''}`
  if (!/\b(?:openai|chatgpt)\b/i.test(trustedHeader)) {
    if (/收件箱暂无邮件/.test(pageText)) return []
    throw new AppError('MAIL_PAGE_UNRECOGNIZED', '邮箱页面用途或邮件结构无法确认。', { statusCode: 502 })
  }

  const previews = $('iframe[srcdoc]')
    .toArray()
    .map((element) => $(element).attr('srcdoc'))
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  if (previews.length !== 1) {
    throw new AppError('MAIL_PAGE_UNRECOGNIZED', '邮箱页面用途或邮件结构无法确认。', { statusCode: 502 })
  }
  return [
    buildMessage({
      sender,
      subject,
      text: htmlToText(previews[0]!),
      receivedAt: normalizeDate(receivedRaw),
    }),
  ]
}

export function normalizeMailboxResponse(
  contentType: string,
  body: string,
  source: 'default' | 'path_page' = 'default',
): MailMessage[] {
  if (contentType.toLowerCase().includes('json')) {
    try {
      return normalizeJson(body)
    } catch (error) {
      // New providers often wrap the message in an unfamiliar JSON shape.
      // Keep the generic text fallback constrained to code-bearing responses.
      const fallback = normalizeGenericText(body)
      if (fallback.length > 0) return fallback
      throw error
    }
  }
  if (contentType.toLowerCase().includes('html')) {
    return source === 'path_page' ? normalizePathMailboxHtml(body) : normalizeHtml(body)
  }
  if (contentType.toLowerCase().includes('text') || !contentType.trim()) return normalizeGenericText(body)
  throw new AppError('MAIL_RESPONSE_INVALID', '邮箱接口返回了不受支持的内容类型。', { statusCode: 502 })
}
