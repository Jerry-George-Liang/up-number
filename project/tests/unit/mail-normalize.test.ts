import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MailboxClient, parseLoopbackMacOsHttpsProxy } from '../../src/server/mail/client'
import { normalizeApi798Response, normalizeMailboxResponse } from '../../src/server/mail/normalize'
import { createMailBaseline, extractUniqueOtp } from '../../src/server/mail/otp'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

function cloudflareEmail(email: string): string {
  const key = 0x5a
  return key.toString(16).padStart(2, '0') + [...email].map((character) => (character.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('')
}

describe('MailboxClient', () => {
  it('reads the fixed webmail.503.me JSON endpoint and ignores non-six-digit results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://webmail.503.me')
      expect(url.pathname).toBe('/webmail')
      expect(url.searchParams.get('mail')).toBe('user@example.invalid')
      expect(url.searchParams.get('pwd')).toBe('synthetic&password')
      expect(url.searchParams.get('limit')).toBe('1')
      expect(url.searchParams.get('format')).toBe('json')
      expect(init?.redirect).toBe('manual')
      return Response.json({
        success: true,
        email: 'user@example.invalid',
        count: 1,
        code: 'none',
        codes: ['none'],
        mails: [{ uid: 1, from: 'ChatGPT <no-reply@openai.com>', subject: 'ChatGPT', date: '2026-08-20T04:00:00Z', code: 'none', codes: ['none'] }],
      })
    })
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages(
      'user@example.invalid',
      'https://webmail.503.me/webmail?mail=user%40example.invalid&pwd=synthetic%26password&limit=1&format=json',
    )).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('accepts only a six-digit OpenAI code from webmail.503.me', async () => {
    const client = new MailboxClient(vi.fn<typeof fetch>(async () => Response.json({
      success: true,
      email: 'user@example.invalid',
      count: 1,
      code: '123456',
      codes: ['123456'],
      mails: [{ uid: 2, from: 'OpenAI', subject: 'Your ChatGPT verification code', date: '2026-08-20T04:00:00Z', code: '123456', codes: ['123456'] }],
    })))
    await expect(client.listMessages(
      'user@example.invalid',
      'https://webmail.503.me/webmail?mail=user%40example.invalid&pwd=synthetic-password&limit=1&format=json',
    )).resolves.toEqual({
      messages: [expect.objectContaining({ text: '123456' })],
      ordering: 'newest_first',
    })
  })

  it.each([
    'https://webmail.503.me/webmail?mail=user%40example.invalid&pwd=synthetic-password&limit=1',
    'https://webmail.503.me/webmail?mail=user%40example.invalid&pwd=synthetic-password&limit=1&format=html',
  ])('normalizes a legacy webmail.503.me format to JSON', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).searchParams.get('format')).toBe('json')
      return Response.json({ success: true, email: 'user@example.invalid', count: 0, code: '', codes: [], mails: [] })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [],
      ordering: 'newest_first',
    })
  })

  it('upgrades the fixed api798 endpoint to HTTPS and reads a plain six-digit code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api798.com')
      expect(url.pathname).toBe('/latest')
      expect(url.searchParams.get('email')).toBe('user@example.invalid')
      expect(url.searchParams.get('auth_code')).toBe('SYNTHETIC123')
      expect([...url.searchParams.keys()].sort()).toEqual(['auth_code', 'email'])
      expect(init?.redirect).toBe('manual')
      return new Response('123456', { headers: { 'content-type': 'text/plain' } })
    })
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages(
      'user@example.invalid',
      'http://api798.com/latest?email=user%40example.invalid&auth_code=SYNTHETIC123',
    )).resolves.toEqual({
      messages: [expect.objectContaining({ text: '123456' })],
      ordering: 'newest_first',
    })
  })

  it('accepts api798 empty results and rejects mismatched or malformed links before fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('暂无验证码'))
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages(
      'user@example.invalid',
      'https://api798.com/latest?email=user%40example.invalid&auth_code=SYNTHETIC123',
    )).resolves.toEqual({ messages: [], ordering: 'newest_first' })
    await expect(client.listMessages(
      'user@example.invalid',
      'https://api798.com/latest?email=other%40example.invalid&auth_code=SYNTHETIC123',
    )).rejects.toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    await expect(client.listMessages(
      'user@example.invalid',
      'https://api798.com/latest?email=user%40example.invalid&auth_code=SYNTHETIC123&extra=1',
    )).rejects.toMatchObject({ code: 'MAIL_ACCESS_URL_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats api798 matching-mail empty text as a normal empty mailbox', async () => {
    const client = new MailboxClient(vi.fn<typeof fetch>(async () => new Response('未找到匹配的邮件')))
    await expect(client.listMessages(
      'user@example.invalid',
      'https://api798.com/latest?email=user%40example.invalid&auth_code=SYNTHETIC123',
    )).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('reads an api798 HTML result page without requiring mailbox card markup', async () => {
    const client = new MailboxClient(vi.fn<typeof fetch>(async () => new Response(
      '<html><body><main>最新验证码：<strong>246810</strong></main></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    )))

    await expect(client.listMessages(
      'user@example.invalid',
      'https://api798.com/latest?email=user%40example.invalid&auth_code=SYNTHETIC123',
    )).resolves.toEqual({
      messages: [expect.objectContaining({ sender: 'OpenAI', text: expect.stringContaining('246810') })],
      ordering: 'newest_first',
    })
  })

  it('treats an api798 HTML empty page as an empty mailbox', () => {
    expect(normalizeApi798Response(
      'text/html; charset=utf-8',
      '<html><body><p>暂无验证码</p></body></html>',
    )).toEqual([])
  })

  it('uses the fixed AIgateway pickup GET endpoint and requires a matching mailbox identity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://aigateway.online/api/v1/mail-pickup/synthetic_pickup_token_123456')
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      return Response.json({
        email: 'user@example.invalid',
        messages: [{ id: 'm1', from: 'OpenAI', subject: 'Your ChatGPT code', text: 'Code 123456', received_at: '2026-08-18T10:00:00Z' }],
      })
    })
    const client = new MailboxClient(fetchMock)
    const result = await client.listMessages(
      'user@example.invalid',
      'https://aigateway.online/api/v1/mail-pickup/synthetic_pickup_token_123456',
    )
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'm1', text: expect.stringContaining('123456') }),
    ])
  })

  it('accepts the current AIgateway message shape when its extracted code is empty', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () => Response.json({
        email: 'user@example.invalid',
        status: 'active',
        expires_at: '2026-08-20T10:00:00Z',
        messages: [{
          code: '',
          sender: 'OpenAI <no-reply@openai.com>',
          subject: 'Your ChatGPT verification code is 123456',
          received_at: '2026-08-19T10:00:00Z',
        }],
      })),
    )

    await expect(client.listMessages(
      'user@example.invalid',
      'https://aigateway.online/api/v1/mail-pickup/synthetic_pickup_token_123456',
    )).resolves.toEqual({
      messages: [expect.objectContaining({ subject: expect.stringContaining('123456') })],
      ordering: 'unknown',
    })
  })

  it('rejects a non-empty malformed AIgateway code value', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () => Response.json({
        email: 'user@example.invalid',
        messages: [{
          code: 'not-a-code',
          sender: 'OpenAI',
          subject: 'Your ChatGPT verification code',
          received_at: '2026-08-19T10:00:00Z',
        }],
      })),
    )

    await expect(client.listMessages(
      'user@example.invalid',
      'https://aigateway.online/api/v1/mail-pickup/synthetic_pickup_token_123456',
    )).rejects.toMatchObject({ code: 'MAIL_RESPONSE_INVALID' })
  })

  it('uses a trycloudflare root fragment only as a token for the fixed OTP POST endpoint', async () => {
    const token = 'synthetic_cloudflare_otp_token_123456'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://generated-mail.trycloudflare.com/api/otp')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ link_token: token })
      return Response.json({
        ok: true,
        status: 'ready',
        email: 'user@example.invalid',
        code: '654321',
        messages: [{ id: 'm2', from: 'OpenAI', subject: 'ChatGPT verification', preview: 'Use 654321', received_at: '2026-08-18T10:00:00Z' }],
      })
    })
    const client = new MailboxClient(fetchMock)
    const result = await client.listMessages(
      'user@example.invalid',
      `https://generated-mail.trycloudflare.com/#otp=${token}`,
    )
    expect(result.ordering).toBe('newest_first')
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'm2', text: expect.stringContaining('654321') }),
    ])
  })

  it.each([
    'https://aigateway.online/api/v1/mail-pickup/short',
    'https://aigateway.online/api/v1/mail-pickup/synthetic_pickup_token_123456?extra=1',
    'https://generated-mail.trycloudflare.com/#otp=short',
    'https://generated-mail.trycloudflare.com/path#otp=synthetic_cloudflare_otp_token_123456',
  ])('rejects a malformed dedicated pickup link before fetching: %s', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses only the fixed endpoint and URL-encodes the three fixed query values', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://icloud.thefindnet.xyz')
      expect(url.pathname).toBe('/api/mail.php')
      expect(url.searchParams.get('mail')).toBe('user+tag@example.invalid')
      expect(url.searchParams.get('pwd')).toBe('p&ss = value')
      expect(url.searchParams.get('limit')).toBe('5')
      expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'mail', 'pwd'])
      expect(init?.redirect).toBe('manual')
      return new Response('{"messages":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages('user+tag@example.invalid', 'p&ss = value')).resolves.toEqual({
      messages: [],
      ordering: 'unknown',
    })
  })

  it.each([
    [
      'surrounding whitespace and normal separators',
      ' https://icloud.thefindnet.xyz/api/mail.php?limit=5&pwd=synthetic%26secret&mail=USER%40example.invalid ',
    ],
    [
      'HTML-escaped separators copied from rendered content',
      'https://icloud.thefindnet.xyz/api/mail.php?mail=USER%40example.invalid&amp;pwd=synthetic%26secret&amp;limit=5',
    ],
    [
      'an omitted limit that the client fixes to five',
      'https://icloud.thefindnet.xyz/api/mail.php?mail=USER%40example.invalid&pwd=synthetic%26secret',
    ],
    [
      'a trailing slash copied after the PHP endpoint',
      'https://icloud.thefindnet.xyz/api/mail.php/?mail=USER%40example.invalid&pwd=synthetic%26secret&limit=5',
    ],
    [
      'duplicate path separators accepted by the fixed endpoint',
      'https://icloud.thefindnet.xyz//api//mail.php?mail=USER%40example.invalid&pwd=synthetic%26secret&limit=5',
    ],
  ])('accepts the fixed full mailbox URL with %s', async (_scenario, accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://icloud.thefindnet.xyz')
      expect(url.pathname).toBe('/api/mail.php')
      expect(url.searchParams.get('mail')).toBe('user@example.invalid')
      expect(url.searchParams.get('pwd')).toBe('synthetic&secret')
      expect(url.searchParams.get('limit')).toBe('5')
      return new Response('{"messages":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [],
      ordering: 'unknown',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'generated web link',
      'https://assurivo.com/console/open.php?mail=USER%2Btag%40example.invalid&pwd=synthetic%26query%20code&limit=20',
    ],
    [
      'direct JSON link without an explicit limit',
      'https://assurivo.com/console/feed.php?pwd=synthetic%26query%20code&mail=USER%2Btag%40example.invalid',
    ],
  ])('converts an assurivo.com %s to the fixed JSON feed', async (_scenario, accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://assurivo.com')
      expect(url.pathname).toBe('/console/feed.php')
      expect(url.searchParams.get('mail')).toBe('user+tag@example.invalid')
      expect(url.searchParams.get('pwd')).toBe('synthetic&query code')
      expect(url.searchParams.get('limit')).toBe('1')
      expect([...url.searchParams.keys()]).toEqual(['mail', 'pwd', 'limit'])
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      return Response.json({ data: [] })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user+tag@example.invalid', accessUrl)).resolves.toEqual({
      messages: [],
      ordering: 'newest_first',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses an Assurivo primary iCloud mailbox for an iCloud plus-address account', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/console/feed.php')
      expect(url.searchParams.get('mail')).toBe('finding-splurge-8t@icloud.com')
      return Response.json({ data: [] })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages(
      'finding-splurge-8t+825@icloud.com',
      'https://assurivo.com/console/open.php?mail=finding-splurge-8t%40icloud.com&pwd=synthetic-query-code&limit=5',
    )).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('uses Assurivo saved_at to distinguish a resent message with identical content', () => {
    const first = normalizeMailboxResponse(
      'application/json',
      JSON.stringify({ data: [{
        from: 'ChatGPT <no-reply@openai.com>',
        subject: 'ChatGPT',
        body: '<p>Use 123456 to continue.</p>',
        saved_at: '2026-08-19 20:45:10',
      }] }),
    )[0]!
    const resent = normalizeMailboxResponse(
      'application/json',
      JSON.stringify({ data: [{
        from: 'ChatGPT <no-reply@openai.com>',
        subject: 'ChatGPT',
        body: '<p>Use 123456 to continue.</p>',
        saved_at: '2026-08-19 20:47:09',
      }] }),
    )[0]!

    expect(first.receivedAt).toBeDefined()
    expect(resent.receivedAt).toBeDefined()
    expect(resent.fingerprint).not.toBe(first.fingerprint)
    expect(extractUniqueOtp(
      [resent],
      createMailBaseline([first]),
      new Date('2026-08-19T12:44:50Z'),
      'newest_first',
    )).toMatchObject({ kind: 'found', code: '123456' })
  })

  it('removes CSS and conditional-comment numbers from an Assurivo HTML body', () => {
    const messages = normalizeMailboxResponse(
      'application/json',
      JSON.stringify({ data: [{
        from: 'ChatGPT <no-reply@openai.com>',
        subject: 'ChatGPT',
        body: '<style>.code{color:#123456}</style><!-- 234567 --><p>Use <strong>345678</strong> to continue.</p>',
        saved_at: '2026-08-19 20:51:52',
      }] }),
    )

    expect(messages[0]?.text).toBe('Use 345678 to continue.')
    expect(extractUniqueOtp(
      messages,
      { messageIds: new Set(), fingerprints: new Set() },
      new Date('2026-08-19T12:50:29Z'),
      'newest_first',
    )).toMatchObject({ kind: 'found', code: '345678' })
  })

  it.each([
    ['different iCloud primary mailbox', 'other+825@icloud.com', 'finding-splurge-8t@icloud.com'],
    ['non-iCloud plus address', 'user+825@example.invalid', 'user@example.invalid'],
    ['link contains an unrelated plus address', 'user@icloud.com', 'user+825@icloud.com'],
  ])('rejects an Assurivo alias mismatch: %s', async (_scenario, accountEmail, linkedEmail) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const accessUrl = `https://assurivo.com/console/open.php?mail=${encodeURIComponent(linkedEmail)}&pwd=synthetic-query-code&limit=5`

    await expect(client.listMessages(accountEmail, accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=5',
    'https://assurivo.com/console/open.php/?mail=user%40example.invalid&pwd=secret&limit=5',
    'https://assurivo.com/console/wrong.php?mail=user%40example.invalid&pwd=secret&limit=5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=5&extra=1',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&mail=user%40example.invalid&pwd=secret&limit=5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&pwd=secret&limit=5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=5&limit=6',
    'https://assurivo.com/console/open.php?mail=&pwd=secret&limit=5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=&limit=5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=0',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=21',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=1.5',
    'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=5#mail',
    'https://user:password@assurivo.com/console/open.php?mail=user%40example.invalid&pwd=secret&limit=5',
  ])('rejects a malformed assurivo.com link before fetching', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an assurivo.com link for another account without exposing the query code', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const queryCode = 'private-synthetic-assurivo-code'
    const accessUrl = `https://assurivo.com/console/open.php?mail=other%40example.invalid&pwd=${queryCode}&limit=5`
    const error = await client.listMessages('user@example.invalid', accessUrl).catch((caught: unknown) => caught)
    const serializedError = `${String(error)} ${JSON.stringify(error)}`

    expect(error).toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(serializedError).not.toContain(queryCode)
    expect(serializedError).not.toContain(accessUrl)
    expect(serializedError).not.toContain('other@example.invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps assurivo.com authentication failures without exposing its link or query code', async () => {
    const queryCode = 'private-synthetic-assurivo-code'
    const accessUrl = `https://assurivo.com/console/feed.php?mail=user%40example.invalid&pwd=${queryCode}&limit=5`
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        Response.json({ status: 'error', message: 'Authentication failed.' }, { status: 401 }),
      ),
    )
    const error = await client.listMessages('user@example.invalid', accessUrl).catch((caught: unknown) => caught)
    const serializedError = `${String(error)} ${JSON.stringify(error)}`

    expect(error).toMatchObject({ code: 'MAIL_AUTHENTICATION_FAILED', retryable: false })
    expect(serializedError).not.toContain(queryCode)
    expect(serializedError).not.toContain(accessUrl)
  })

  it('rejects a non-JSON assurivo.com response', async () => {
    const accessUrl =
      'https://assurivo.com/console/open.php?mail=user%40example.invalid&pwd=synthetic-query-code&limit=5'
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response('<html><body>unexpected</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    )

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_RESPONSE_INVALID',
    })
  })

  it('reads a mail.ai1998.xyz messages link and keeps its credential-bound URL intact', async () => {
    const accessUrl =
      'https://mail.ai1998.xyz/messages/synthetic_token_123456/user%40example.invalid?recipient=user%40example.invalid'
    const html = `<!doctype html><html><body><main class="wrap">
      <header class="header">Mailbox</header>
      <article class="mail-card" data-message-id="ai1998-1">
        <h2 class="subject">Your ChatGPT verification code</h2>
        <div class="date">2026-08-16T08:00:05.000Z</div>
        <div class="meta">From: OpenAI &lt;no-reply@openai.com&gt;</div>
        <div class="body-rich">Use 246810 to sign in.</div>
      </article>
    </main></body></html>`
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(accessUrl)
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('USER@example.invalid', accessUrl)).resolves.toEqual({
      messages: [
        expect.objectContaining({
          id: 'ai1998-1',
          sender: 'OpenAI <no-reply@openai.com>',
          subject: 'Your ChatGPT verification code',
          text: 'Use 246810 to sign in.',
          receivedAt: '2026-08-16T08:00:05.000Z',
        }),
      ],
      ordering: 'unknown',
    })
  })

  it('uses the assurivo-compatible JSON feed for icloud.biubiu007.com', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://icloud.biubiu007.com')
      expect(url.pathname).toBe('/console/feed.php')
      expect(url.searchParams.get('mail')).toBe('user@example.invalid')
      expect(url.searchParams.get('pwd')).toBe('synthetic-query-code')
      expect(url.searchParams.get('limit')).toBe('1')
      return Response.json({ status: 'ok', data: [], sync_pending: false })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud.biubiu007.com/console/open.php?mail=user%40example.invalid&pwd=synthetic-query-code',
      ),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it.each(['https://gptmail.wanmail.beer', 'https://li1329.asia'])(
    'maps a public inbox response from %s after verifying its address',
    async (origin) => {
      const accessUrl = `${origin}/api/v1/public/inboxes/123e4567-e89b-12d3-a456-426614174000`
      const client = new MailboxClient(
        vi.fn<typeof fetch>(async () =>
          Response.json({
            data: {
              address: 'USER@example.invalid',
              subject: 'ChatGPT login code',
              snippet: 'Use 112233 to continue.',
              sent_at: '2026-08-16T08:00:05.000Z',
            },
          }),
        ),
      )

      await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
        messages: [
          expect.objectContaining({
            sender: 'OpenAI',
            subject: 'ChatGPT login code',
            text: 'Use 112233 to continue.',
            receivedAt: '2026-08-16T08:00:05.000Z',
          }),
        ],
        ordering: 'unknown',
      })
    },
  )

  it('maps the latest mailotp.xyhelper.ai code without scanning arbitrary response fields', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async (input) => {
        expect(String(input)).toBe('https://mailotp.xyhelper.ai/api/code?token=synthetic_token_123456')
        return Response.json({ success: true, code: '445566', count: 1, unrelated: '999999' })
      }),
    )

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://mailotp.xyhelper.ai/api/code?token=synthetic_token_123456',
      ),
    ).resolves.toEqual({
      messages: [expect.objectContaining({ sender: 'OpenAI', text: '445566' })],
      ordering: 'newest_first',
    })
  })

  it('posts only the access id to mail.776867.xyz and verifies the returned mailbox', async () => {
    const accessId = 'ABCDEF1234567890ABCDEF12'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://mail.776867.xyz/api/pickup')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ access_id: accessId, sync: false })
      return Response.json({
        ok: true,
        email: 'user@example.invalid',
        count: 1,
        messages: [
          {
            uid: 42,
            sender: 'OpenAI <no-reply@openai.com>',
            subject: 'ChatGPT login code',
            received_at: '2026-08-16T08:00:05.000Z',
            body_text: 'Use 556677 to continue.',
            body_html: '<p>Use <b>556677</b> to continue.</p>',
            code: '556677',
          },
        ],
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages('user@example.invalid', `https://mail.776867.xyz/icloud/p/${accessId}`),
    ).resolves.toEqual({
      messages: [expect.objectContaining({ id: '42', text: expect.stringContaining('556677') })],
      ordering: 'unknown',
    })
  })

  it('uses the flysms.xyz bearer API with the fragment-bound email and token', async () => {
    const accessUrl =
      'https://flysms.xyz/icloud/pickup#email=user%40example.invalid&key=tok_synthetic_token_123456'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://flysms.xyz/icloud/api/pickup/messages/latest')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer tok_synthetic_token_123456')
      expect(headers.get('x-mailbox-email')).toBe('user@example.invalid')
      return Response.json({
        email: 'user@example.invalid',
        message: {
          mailbox: 'USER@example.invalid',
          uid: 'latest-1',
          subject: 'Your ChatGPT verification code',
          from: 'OpenAI <no-reply@openai.com>',
          mailboxReceivedAt: '2026-08-16T08:00:05.000Z',
          text: 'Use 667788 to continue.',
          html: '<p>Use 667788 to continue.</p>',
        },
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [expect.objectContaining({ id: 'latest-1', text: 'Use 667788 to continue.' })],
      ordering: 'newest_first',
    })
  })

  it('distinguishes a confirmed FlySMS mailbox expiry from a generic authorization failure', async () => {
    const accessUrl =
      'https://flysms.xyz/icloud/pickup#email=user%40example.invalid&key=tok_synthetic_token_123456'
    const expiredClient = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        Response.json({ code: 'ACCOUNT_EXPIRED', error: 'Mailbox account expired' }, { status: 403 }),
      ),
    )
    const genericClient = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        Response.json({ code: 'ACCESS_DENIED', error: 'Not authorized' }, { status: 403 }),
      ),
    )

    await expect(expiredClient.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAILBOX_ACCOUNT_EXPIRED',
      retryable: false,
    })
    await expect(genericClient.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_AUTHENTICATION_FAILED',
    })
  })

  it('uses the fixed 360Desk recent-mail API for the public quick-mail page', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://redeem.360desk.net/quick-mail/api/recent')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('accept')).toBe('application/json')
      expect(headers.get('content-type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'USER@example.invalid', minutes: 60 })
      return Response.json({
        email: 'user@example.invalid',
        count: 2,
        window_minutes: 60,
        messages: [
          {
            from: 'OpenAI <no-reply@openai.com>',
            subject: 'Your ChatGPT verification code',
            folder: 'Inbox',
            received_at: '2026-08-16T08:00:05.000Z',
            preview: 'Use 778899 to continue.',
            ignored_message_field: 'not scanned',
          },
          {
            from: null,
            subject: null,
            folder: null,
            received_at: '2026-08-16T08:00:01.000Z',
            preview: null,
          },
        ],
        ignored_response_field: 'not scanned',
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages('USER@example.invalid', 'https://redeem.360desk.net/quick-mail'),
    ).resolves.toEqual({
      messages: [
        expect.objectContaining({
          sender: 'OpenAI <no-reply@openai.com>',
          subject: 'Your ChatGPT verification code',
          text: 'Use 778899 to continue.',
          receivedAt: '2026-08-16T08:00:05.000Z',
        }),
        expect.objectContaining({
          sender: '',
          subject: '',
          text: '',
          receivedAt: '2026-08-16T08:00:01.000Z',
        }),
      ],
      ordering: 'unknown',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts an empty 360Desk mailbox response', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        Response.json({
          email: 'user@example.invalid',
          count: 0,
          window_minutes: 60,
          messages: [],
        }),
      ),
    )

    await expect(
      client.listMessages('user@example.invalid', 'https://redeem.360desk.net/quick-mail/'),
    ).resolves.toEqual({ messages: [], ordering: 'unknown' })
  })

  it('reads a fixed 191006 mailbox page and verifies its encoded mailbox identity', async () => {
    const encodedEmail = cloudflareEmail('user@example.invalid')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://191006.xyz')
      expect(url.pathname).toBe('/mailbox/synthetic_mailbox_access_token')
      expect(init?.redirect).toBe('manual')
      return new Response(
        `<main><a data-cfemail="${encodedEmail}">[email protected]</a><article class="mail-card" data-message-id="message-1"><span class="mail-from">OpenAI</span><h2 class="mail-subject">Your ChatGPT verification code</h2><time datetime="2026-08-18T05:30:00.000Z"></time><div class="mail-body">Use 314159 to continue.</div></article></main>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages('USER@example.invalid', 'https://191006.xyz/mailbox/synthetic_mailbox_access_token/'),
    ).resolves.toEqual({
      messages: [
        expect.objectContaining({
          id: 'message-1',
          sender: 'OpenAI',
          subject: 'Your ChatGPT verification code',
          text: 'Use 314159 to continue.',
          receivedAt: '2026-08-18T05:30:00.000Z',
        }),
      ],
      ordering: 'newest_first',
    })
  })

  it('reads the deployed 191006 single-message detail layout', async () => {
    const encodedEmail = cloudflareEmail('user@example.invalid')
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response(
          `<main><div class="mailbox"><a data-cfemail="${encodedEmail}">[email protected]</a></div><div class="subject">你的临时 ChatGPT 登录代码</div><div class="content"><table class="main"><tbody><tr><td><p>验证码</p><p>271828</p></td></tr></tbody></table></div></main>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
      ),
    )

    await expect(
      client.listMessages('user@example.invalid', 'https://191006.xyz/mailbox/synthetic_mailbox_access_token'),
    ).resolves.toEqual({
      messages: [
        expect.objectContaining({
          sender: 'OpenAI',
          subject: '你的临时 ChatGPT 登录代码',
          text: expect.stringContaining('271828'),
        }),
      ],
      ordering: 'newest_first',
    })
  })

  it('does not treat a non-OpenAI 191006 detail page as a verification email', async () => {
    const encodedEmail = cloudflareEmail('user@example.invalid')
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response(
          `<main><div class="mailbox"><a data-cfemail="${encodedEmail}">[email protected]</a></div><div class="subject">普通通知</div><div class="content"><p>Reference 271828</p></div></main>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
      ),
    )

    await expect(
      client.listMessages('user@example.invalid', 'https://191006.xyz/mailbox/synthetic_mailbox_access_token'),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('accepts an empty 191006 mailbox page and rejects another mailbox identity', async () => {
    const responseBody = (email: string) =>
      `<div class="box"><h1>暂无邮件</h1><p><a data-cfemail="${cloudflareEmail(email)}">[email protected]</a> 还没有收到邮件。</p></div>`
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response(responseBody('user@example.invalid'), { headers: { 'content-type': 'text/html' } }),
      ),
    )
    await expect(
      client.listMessages('user@example.invalid', 'https://191006.xyz/mailbox/synthetic_mailbox_access_token'),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })

    const mismatchClient = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response(responseBody('other@example.invalid'), { headers: { 'content-type': 'text/html' } }),
      ),
    )
    await expect(
      mismatchClient.listMessages('user@example.invalid', 'https://191006.xyz/mailbox/synthetic_mailbox_access_token'),
    ).rejects.toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
  })

  it('reads the fixed mail.com code endpoint and accepts its documented empty 400 response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://legs-leslie-cure-notices.trycloudflare.com')
      expect(url.pathname).toBe('/code/synthetic_mailcom_access_token')
      expect(url.searchParams.get('max_age')).toBe('3600')
      expect(init?.redirect).toBe('manual')
      return Response.json(
        { email: 'user@example.invalid', code: null, mail: null },
        { status: 400 },
      )
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'USER@example.invalid',
        'https://legs-leslie-cure-notices.trycloudflare.com/code/synthetic_mailcom_access_token/',
      ),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('uses the fixed email.lzg666.icu code endpoint with the mail.com response contract', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://email.lzg666.icu')
      expect(url.pathname).toBe('/code/synthetic_lzg666_access_token')
      expect(url.searchParams.get('max_age')).toBe('3600')
      return Response.json({ email: 'user@example.invalid', code: null, mail: null }, { status: 400 })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://email.lzg666.icu/code/synthetic_lzg666_access_token',
      ),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('uses the ai100.my mail code endpoint with the mail.com response contract', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://ai100.my')
      expect(url.pathname).toBe('/mail/code/synthetic_ai100_access_token')
      expect(url.searchParams.get('max_age')).toBe('3600')
      return Response.json({
        email: 'user@example.invalid',
        code: '314159',
        mail: {
          id: 'ai100-1',
          from: 'OpenAI <no-reply@openai.com>',
          subject: 'Your ChatGPT verification code',
          text: 'Use 314159 to continue.',
          received_at: '2026-08-20T06:00:00Z',
        },
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'USER@example.invalid',
        'https://ai100.my/mail/code/synthetic_ai100_access_token/',
      ),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          id: 'ai100-1',
          text: expect.stringContaining('314159'),
          receivedAt: '2026-08-20T06:00:00.000Z',
        }),
      ],
      ordering: 'newest_first',
    })
  })

  it('normalizes a trusted OpenAI code result and rejects mismatched mailbox identity', async () => {
    const accessUrl =
      'https://another-generated-tunnel.trycloudflare.com/code/synthetic_mailcom_access_token'
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        Response.json({
          email: 'user@example.invalid',
          code: '271828',
          mail: {
            id: 'mail-1',
            from: 'OpenAI <no-reply@openai.com>',
            subject: 'Your ChatGPT verification code',
            text: 'Use this code to continue.',
            received_at: '2026-08-18T05:50:00.000Z',
          },
        }),
      ),
    )
    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [expect.objectContaining({ id: 'mail-1', text: 'Use this code to continue. 271828' })],
      ordering: 'newest_first',
    })

    const mismatchClient = new MailboxClient(
      vi.fn<typeof fetch>(async () => Response.json({ email: 'other@example.invalid', code: null, mail: null }, { status: 400 })),
    )
    await expect(mismatchClient.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH',
    })
  })

  it('uses short polling for Cloudflare code-by-email links', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/code/user%40example.invalid')
      expect(url.searchParams.get('timeout')).toBe('5')
      return Response.json({ ok: false, error: '没有找到该邮箱' }, { status: 400 })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages(
      'user@example.invalid',
      'https://generated-tunnel.trycloudflare.com/code/user%40example.invalid?timeout=60',
    )).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it.each([
    ['another response email', { email: 'other@example.invalid', count: 0, window_minutes: 60, messages: [] }, 'MAIL_ACCESS_URL_EMAIL_MISMATCH'],
    ['an impossible message count', { email: 'user@example.invalid', count: 0, window_minutes: 60, messages: [{ received_at: '2026-08-16T08:00:05.000Z' }] }, 'MAIL_RESPONSE_INVALID'],
    ['an invalid received time', { email: 'user@example.invalid', count: 1, window_minutes: 60, messages: [{ received_at: 'not-a-date' }] }, 'MAIL_RESPONSE_INVALID'],
  ])('rejects a 360Desk response with %s', async (_scenario, responseBody, expectedCode) => {
    const client = new MailboxClient(vi.fn<typeof fetch>(async () => Response.json(responseBody)))

    await expect(
      client.listMessages('user@example.invalid', 'https://redeem.360desk.net/quick-mail/'),
    ).rejects.toMatchObject({ code: expectedCode })
  })

  it.each([
    'https://mail.ai1998.xyz/messages/synthetic_token_123456/user%40example.invalid?all=1',
    'https://gptmail.wanmail.beer/api/v1/public/inboxes/not-a-uuid',
    'https://mailotp.xyhelper.ai/api/code?token=synthetic_token_123456&extra=1',
    'https://mail.776867.xyz/icloud/p/ABCDEF1234567890ABCDEF12#secret',
    'https://flysms.xyz/icloud/pickup?email=user%40example.invalid#email=user%40example.invalid&key=tok_synthetic',
    'http://redeem.360desk.net/quick-mail/',
    'https://redeem.360desk.net/quick-mail/api/recent',
    'https://redeem.360desk.net/quick-mail/?email=user%40example.invalid',
    'https://redeem.360desk.net/quick-mail/#mail',
    'https://user:password@redeem.360desk.net/quick-mail/',
  ])('rejects a malformed dedicated-provider link before fetching', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'https://mail.ai1998.xyz/messages/synthetic_token_123456/other%40example.invalid',
    'https://flysms.xyz/icloud/pickup#email=other%40example.invalid&key=tok_synthetic',
  ])('rejects a dedicated-provider link bound to another email', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests an allowlisted path-style mailbox URL without rebuilding it as the legacy endpoint', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const accessUrl = 'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(accessUrl)
      expect(init?.redirect).toBe('manual')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [
        expect.objectContaining({
          sender: 'ChatGPT',
          subject: 'ChatGPT 登录验证码',
          receivedAt: '2026-08-13T13:34:37.000Z',
          text: expect.stringContaining('271828'),
        }),
      ],
      ordering: 'unknown',
    })
  })

  it('accepts one matching email query on a path-style mailbox URL and preserves it for the request', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const accessUrl =
      'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?email=user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(accessUrl)
      expect(init?.redirect).toBe('manual')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('USER@example.invalid', accessUrl)).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: 'ChatGPT' })],
      ordering: 'unknown',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts the built-in blog.tx.sb path-style mailbox origin', async () => {
    const accessUrl = 'https://blog.tx.sb/s/synthetic_token_123456/user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(accessUrl)
      return new Response('<div class="wrap"><div class="header">收件箱</div><div class="empty">暂无邮件</div></div>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [],
      ordering: 'unknown',
    })
  })

  it('accepts the built-in webmail.503.me path-style mailbox origin', async () => {
    const accessUrl = 'https://webmail.503.me/s/synthetic_token_123456/user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(accessUrl)
      return new Response('<div class="wrap"><div class="header">Inbox</div><div class="empty">No mail</div></div>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toEqual({
      messages: [],
      ordering: 'unknown',
    })
  })

  it('supports the icloud-api.top show mailbox page format', async () => {
    const accessUrl = 'https://icloud-api.top/show/synthetic_token_123456/user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(accessUrl)
      expect(init?.redirect).toBe('manual')
      return new Response(
        `<!doctype html>
        <html>
          <body>
            <div class="hd">收件箱</div>
            <div class="cnt">
              <div class="card">
                <div class="fr">OpenAI &lt;noreply@tm.openai.com&gt;</div>
                <div class="su">Your ChatGPT verification code</div>
                <div class="dt">2026-08-18 23:56:49</div>
                <div class="bd">Use verification code 246810 to continue.</div>
              </div>
            </div>
          </body>
        </html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    })
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('USER@example.invalid', accessUrl)).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          sender: 'OpenAI <noreply@tm.openai.com>',
          subject: 'Your ChatGPT verification code',
          text: 'Use verification code 246810 to continue.',
        }),
      ],
      ordering: 'unknown',
    })
  })

  it('accepts an empty icloud-api.top show mailbox page', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('<html><body><div class="hd">收件箱</div><div class="cnt">0 封</div></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages('user@example.invalid', 'https://icloud-api.top/show/synthetic_token_123456/user%40example.invalid'),
    ).resolves.toEqual({ messages: [], ordering: 'unknown' })
  })

  it.each([
    'https://icloud-api.top/show/synthetic_token_123456/other%40example.invalid',
    'https://icloud-api.top/show/short/user%40example.invalid',
    'https://icloud-api.top/show/synthetic_token_123456/user%40example.invalid?extra=1',
    'https://icloud-api.top/show/synthetic_token_123456/user%40example.invalid#fragment',
  ])('rejects unsafe icloud-api.top show mailbox links before fetching: %s', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: expect.stringMatching(/^MAIL_(?:ACCESS_URL_INVALID|ACCESS_URL_EMAIL_MISMATCH)$/),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('supports the blog.tx.sb FirstMail viewer and rebuilds its bounded request URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const requested = new URL(String(input))
      expect(requested.origin + requested.pathname).toBe('https://blog.tx.sb/fx.php')
      expect(requested.searchParams.get('mail')).toBe('user@example.invalid')
      expect(requested.searchParams.get('pwd')).toBe('synthetic password')
      expect(requested.searchParams.get('limit')).toBe('1')
      expect(init?.redirect).toBe('manual')
      return new Response(
        '<html><head><title>user@example.invalid - 邮件查看</title></head><body><h1>FirstMail 查看器</h1><h2>邮件列表 (最新 0 封)</h2><p>收件箱暂无邮件</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'USER@example.invalid',
        'https://blog.tx.sb/fx.php?pwd=synthetic%20password&limit=1&mail=user%40example.invalid',
      ),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('rejects unsafe blog.tx.sb FirstMail inputs before requesting them', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const invalidLinks = [
      'http://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=secret&limit=1',
      'https://blog.tx.sb/fx.php?mail=other%40example.invalid&pwd=secret&limit=1',
      'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=secret&limit=0',
      'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=secret&limit=51',
      'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=secret&limit=1&extra=1',
      'https://blog.tx.sb/fx.php?mail=user%40example.invalid&mail=user%40example.invalid&pwd=secret',
      'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=secret#fragment',
    ]
    for (const link of invalidLinks) {
      await expect(client.listMessages('user@example.invalid', link)).rejects.toMatchObject({
        code: expect.stringMatching(/^MAIL_(?:ACCESS_URL_INVALID|ACCESS_URL_EMAIL_MISMATCH)$/),
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps blog.tx.sb FirstMail authentication failures without exposing credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        '<html><head><title>user@example.invalid - 邮件查看</title></head><body><h1>FirstMail 查看器</h1><p>连接邮箱失败: Authentication failed.</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    )
    const client = new MailboxClient(fetchMock)
    const error = await client
      .listMessages('user@example.invalid', 'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=synthetic-secret&limit=1')
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MAIL_AUTHENTICATION_FAILED' })
    expect(String(error)).not.toContain('synthetic-secret')
    expect(String(error)).not.toContain('user@example.invalid')
  })

  it('extracts the code from a trusted FirstMail iframe preview', async () => {
    const html = `
      <html>
        <head><title>user@example.invalid - 邮件查看</title></head>
        <body>
          <h1>FirstMail 查看器</h1>
          <section>
            <h2>你的临时 ChatGPT 登录代码</h2>
            <p>发件人: ChatGPT &lt;noreply@tm.openai.com&gt;</p>
            <p>时间: 2026-08-18 13:29:33</p>
            <iframe srcdoc="&lt;main&gt;&lt;p&gt;输入此临时验证码以继续：&lt;/p&gt;&lt;strong&gt;005872&lt;/strong&gt;&lt;/main&gt;"></iframe>
          </section>
        </body>
      </html>`
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://blog.tx.sb/fx.php?mail=user%40example.invalid&pwd=synthetic-secret&limit=1',
      ),
    ).resolves.toMatchObject({
      messages: [
        {
          sender: expect.stringContaining('ChatGPT'),
          subject: expect.stringContaining('ChatGPT'),
          text: expect.stringContaining('005872'),
        },
      ],
    })
  })

  it('normalizes common copied path-link variations for an explicitly trusted custom origin', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const canonicalUrl = 'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid'
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(canonicalUrl)
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(fetchMock, {
      trustedPathOrigins: () => ['https://mail.example.invalid'],
    })

    await expect(
      client.listMessages(
        'USER@example.invalid',
        ' “https://MAIL.example.invalid//s//synthetic_token_123456/user%40example.invalid/” ',
      ),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: 'ChatGPT' })],
      ordering: 'unknown',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts the fixed aisvip code page format without adding a custom trusted origin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://main.aisvip.shop')
      expect(url.pathname).toBe('/api/public/latest-code/2322')
      expect(url.searchParams.get('token')).toBe('synthetic_token_123456')
      expect([...url.searchParams.keys()]).toEqual(['token'])
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('accept')).toBe('application/json')
      return Response.json({
        ok: true,
        status: 'ready',
        code: '246802',
        sender: 'ChatGPT <noreply@tm.openai.com>',
        subject: 'Your ChatGPT code is 246802',
        mail_time: '2026-08-21T06:20:00Z',
        checked_at: '2026-08-21T06:20:01Z',
      })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://main.aisvip.shop/c/2322?token=synthetic_token_123456',
      ),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: expect.stringContaining('ChatGPT'), text: '246802' })],
      ordering: 'newest_first',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects aisvip code page links with extra parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://main.aisvip.shop/c/2322?token=synthetic_token_123456&email=user%40example.invalid',
      ),
    ).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
      message: '邮箱接口链接无效：token 参数必须唯一且格式正确。',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an aisvip 404 as an expired or invalid access link', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () => new Response('not found', { status: 404 })),
    )

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://main.aisvip.shop/c/2322?token=synthetic_token_123456',
      ),
    ).rejects.toMatchObject({
      code: 'MAIL_AUTHENTICATION_FAILED',
      message: '邮箱取件链接无效或已经失效。',
    })
  })

  it('treats an aisvip response without a current code as an empty mailbox', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () => Response.json({ ok: true, status: 'waiting', code: '' })),
    )

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://main.aisvip.shop/c/2322?token=synthetic_token_123456',
      ),
    ).resolves.toEqual({ messages: [], ordering: 'newest_first' })
  })

  it('retries one transient aisvip request failure before returning the latest code', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error('temporary timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))
      .mockResolvedValueOnce(Response.json({ ok: true, status: 'ready', code: '135790' }))
    const client = new MailboxClient(fetchMock, {
      systemHttpsProxyResolver: async () => null,
    })

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://main.aisvip.shop/c/2322?token=synthetic_token_123456',
      ),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ text: '135790' })],
      ordering: 'newest_first',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('supports the signed o6f4 root mailbox URL without exposing its signature', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    const client = new MailboxClient(fetchMock)
    const accessUrl =
      'https://o6f4.my/?email=user%40example.invalid&pos=7&sign=synthetic-signature-123456'

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: 'ChatGPT' })],
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('email=user%40example.invalid')
  })

  it('rejects an o6f4 URL for a different mailbox before requesting it', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://o6f4.my/?email=other%40example.invalid&pos=7&sign=synthetic-signature-123456',
      ),
    ).rejects.toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows at most three same-origin path redirects and revalidates the target email', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      requests.push(url.toString())
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: '/s/redirected_token_123456/user%40example.invalid/' },
        })
      }
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(fetchMock, {
      trustedPathOrigins: () => ['https://mail.example.invalid'],
    })

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid',
      ),
    ).resolves.toMatchObject({ messages: [expect.objectContaining({ sender: 'ChatGPT' })] })
    expect(requests).toEqual([
      'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid',
      'https://mail.example.invalid/s/redirected_token_123456/user%40example.invalid',
    ])
  })

  it('rejects a redirected path mailbox with a mismatched email query before the next request', async () => {
    const redirectToken = 'private_redirected_token_123456'
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `/s/${redirectToken}/user%40example.invalid?email=other%40example.invalid`,
        },
      }),
    )
    const client = new MailboxClient(fetchMock)
    const error = await client
      .listMessages(
        'user@example.invalid',
        'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?email=user%40example.invalid',
      )
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(error)).not.toContain(redirectToken)
    expect(JSON.stringify(error)).not.toContain('other@example.invalid')
  })

  it('rejects cross-origin redirects before sending the access path to the target', async () => {
    const secret = 'private_synthetic_token_123'
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://other.example.invalid/s/${secret}/user%40example.invalid` },
      }),
    )
    const client = new MailboxClient(fetchMock, {
      trustedPathOrigins: () => ['https://mail.example.invalid', 'https://other.example.invalid'],
    })
    const error = await client
      .listMessages(
        'user@example.invalid',
        'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid',
      )
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MAIL_REDIRECT_REJECTED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('stops after the configured same-origin redirect limit', async () => {
    let requestCount = 0
    const fetchMock = vi.fn<typeof fetch>(async () => {
      requestCount += 1
      return new Response(null, {
        status: 302,
        headers: {
          location: `/s/redirected_token_${String(requestCount).padStart(6, '0')}/user%40example.invalid`,
        },
      })
    })
    const client = new MailboxClient(fetchMock, {
      trustedPathOrigins: () => ['https://mail.example.invalid'],
    })

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid',
      ),
    ).rejects.toMatchObject({ code: 'MAIL_REDIRECT_LIMIT_EXCEEDED' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retries an allowlisted path-style mailbox through the local macOS HTTPS proxy', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const accessUrl = 'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid'
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('synthetic direct TLS failure')
    })
    const systemHttpsProxyResolver = vi.fn(async () => 'http://127.0.0.1:7890')
    const proxyFetch = vi.fn(async (url: URL, init: RequestInit, proxyUrl: string) => {
      expect(url.toString()).toBe(accessUrl)
      expect(init.redirect).toBe('manual')
      expect(proxyUrl).toBe('http://127.0.0.1:7890')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const client = new MailboxClient(directFetch, { systemHttpsProxyResolver, proxyFetch })

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: 'ChatGPT', receivedAt: '2026-08-13T13:34:37.000Z' })],
      ordering: 'unknown',
    })
    expect(directFetch).toHaveBeenCalledTimes(1)
    expect(systemHttpsProxyResolver).toHaveBeenCalledTimes(1)
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  })

  it('uses the same loopback proxy fallback for a trusted custom path origin', async () => {
    const html = await readFile(`${fixtures}/mail-path-page.html`, 'utf8')
    const accessUrl = 'https://mail.example.invalid/s/synthetic_token_123456/user%40example.invalid'
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('synthetic direct TLS failure')
    })
    const proxyFetch = vi.fn(async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    const client = new MailboxClient(directFetch, {
      trustedPathOrigins: () => ['https://mail.example.invalid'],
      systemHttpsProxyResolver: async () => 'http://127.0.0.1:7890',
      proxyFetch,
    })

    await expect(client.listMessages('user@example.invalid', accessUrl)).resolves.toMatchObject({
      messages: [expect.objectContaining({ sender: 'ChatGPT' })],
    })
    expect(proxyFetch).toHaveBeenCalledWith(
      new URL(accessUrl),
      expect.objectContaining({ redirect: 'manual' }),
      'http://127.0.0.1:7890',
      1_048_576,
    )
  })

  it.each([
    ['ENOTFOUND', 'MAIL_DNS_ERROR'],
    ['UND_ERR_CONNECT_TIMEOUT', 'MAIL_REQUEST_TIMEOUT'],
    ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'MAIL_TLS_ERROR'],
    ['ECONNREFUSED', 'MAIL_CONNECTION_ERROR'],
    ['UNKNOWN_NETWORK_CODE', 'MAIL_NETWORK_ERROR'],
  ])('classifies path mailbox network failures with %s as %s', async (causeCode, expectedCode) => {
    const lowLevel = Object.assign(new Error('private low-level failure'), { code: causeCode })
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: lowLevel })
    })
    const client = new MailboxClient(directFetch, {
      systemHttpsProxyResolver: async () => null,
    })

    const error = await client
      .listMessages(
        'user@example.invalid',
        'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid',
      )
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: expectedCode, retryable: true })
    expect(String(error)).not.toContain('private low-level failure')
  })

  it('reports a distinct failure when the loopback proxy retry also fails', async () => {
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('synthetic direct failure')
    })
    const proxyFetch = vi.fn(async () => {
      throw new TypeError('synthetic proxy failure')
    })
    const client = new MailboxClient(directFetch, {
      systemHttpsProxyResolver: async () => 'http://127.0.0.1:7890',
      proxyFetch,
    })

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid',
      ),
    ).rejects.toMatchObject({ code: 'MAIL_PROXY_FALLBACK_FAILED', retryable: true })
  })

  it('stops retrying when a temporary Cloudflare mailbox tunnel no longer exists', async () => {
    const dnsError = Object.assign(new Error('synthetic DNS failure'), { code: 'ENOTFOUND' })
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: dnsError })
    })
    const proxyFetch = vi.fn(async () => {
      throw Object.assign(new Error('synthetic proxy TLS failure'), { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' })
    })
    const client = new MailboxClient(directFetch, {
      systemHttpsProxyResolver: async () => 'http://127.0.0.1:7890',
      proxyFetch,
    })

    await expect(client.listMessages(
      'user@example.invalid',
      'https://expired-tunnel.trycloudflare.com/code/synthetic_mailcom_access_token',
    )).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_EXPIRED',
      message: '临时邮箱接码域名已经失效，请更新该邮箱的接码链接。',
      retryable: false,
    })
  })

  it('treats a path mailbox 404 as an expired or invalid access link', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () => new Response('not found', { status: 404 })),
    )

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid',
      ),
    ).rejects.toMatchObject({
      code: 'MAIL_AUTHENTICATION_FAILED',
      message: '邮箱取件链接无效或已经失效。',
      retryable: false,
    })
  })

  it('does not use the system proxy fallback for another mailbox origin', async () => {
    const directFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('synthetic direct TLS failure')
    })
    const systemHttpsProxyResolver = vi.fn(async () => 'http://127.0.0.1:7890')
    const proxyFetch = vi.fn()
    const client = new MailboxClient(directFetch, { systemHttpsProxyResolver, proxyFetch })

    await expect(client.listMessages('user@example.invalid', 'mail-secret')).rejects.toMatchObject({
      code: 'MAIL_NETWORK_ERROR',
    })
    expect(systemHttpsProxyResolver).not.toHaveBeenCalled()
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('accepts only enabled loopback macOS HTTPS proxy settings', () => {
    expect(
      parseLoopbackMacOsHttpsProxy(`
        HTTPSEnable : 1
        HTTPSProxy : 127.0.0.1
        HTTPSPort : 7890
      `),
    ).toBe('http://127.0.0.1:7890')
    expect(
      parseLoopbackMacOsHttpsProxy(`
        HTTPSEnable : 1
        HTTPSProxy : ::1
        HTTPSPort : 7891
      `),
    ).toBe('http://[::1]:7891')
    expect(
      parseLoopbackMacOsHttpsProxy(`
        HTTPSEnable : 1
        HTTPSProxy : proxy.example.invalid
        HTTPSPort : 7890
      `),
    ).toBeNull()
    expect(
      parseLoopbackMacOsHttpsProxy(`
        HTTPSEnable : 0
        HTTPSProxy : 127.0.0.1
        HTTPSPort : 7890
      `),
    ).toBeNull()
  })

  it('uses the allowlisted Cloud Mailbox public API and normalizes the latest message details', async () => {
    const token = 'synthetic_cloud_mailbox_token_123'
    const requests: Array<{ method: string; pathname: string }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      requests.push({ method: init?.method ?? 'GET', pathname: url.pathname })
      expect(url.origin).toBe('https://icloud.olo.lat')
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')

      if (url.pathname.endsWith('/meta')) {
        return Response.json({
          filterEmail: 'USER@example.invalid',
          codeRequired: false,
          authorized: true,
        })
      }
      if (url.pathname.endsWith('/sync')) return Response.json({ status: 'synced' })
      if (url.pathname.endsWith('/messages')) {
        return Response.json({
          messages: [
            {
              id: 'older',
              from: 'OpenAI <no-reply@openai.com>',
              subject: 'Older code',
              receivedAt: '2026-08-14T08:00:01.000Z',
            },
            {
              id: 'newer',
              from: 'OpenAI <no-reply@openai.com>',
              subject: 'Latest code',
              receivedAt: '2026-08-14T08:00:05.000Z',
            },
          ],
        })
      }
      if (url.pathname.endsWith('/messages/newer')) {
        return Response.json({
          id: 'newer',
          from: 'OpenAI <no-reply@openai.com>',
          subject: 'Latest code',
          body: 'Use 222222 to sign in to ChatGPT.',
          receivedAt: '2026-08-14T08:00:05.000Z',
        })
      }
      if (url.pathname.endsWith('/messages/older')) {
        return Response.json({
          id: 'older',
          from: 'OpenAI <no-reply@openai.com>',
          subject: 'Older code',
          body: 'Use 111111 to sign in to ChatGPT.',
          receivedAt: '2026-08-14T08:00:01.000Z',
        })
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 })
    })
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages('user@example.invalid', `https://icloud.olo.lat/p/${token}`),
    ).resolves.toEqual({
      messages: [
        expect.objectContaining({
          id: 'newer',
          sender: 'OpenAI <no-reply@openai.com>',
          subject: 'Latest code',
          text: 'Use 222222 to sign in to ChatGPT.',
          receivedAt: '2026-08-14T08:00:05.000Z',
        }),
        expect.objectContaining({ id: 'older', text: 'Use 111111 to sign in to ChatGPT.' }),
      ],
      ordering: 'newest_first',
    })
    expect(requests).toEqual([
      { method: 'GET', pathname: `/api/public/${token}/meta` },
      { method: 'POST', pathname: `/api/public/${token}/sync` },
      { method: 'GET', pathname: `/api/public/${token}/messages` },
      { method: 'GET', pathname: `/api/public/${token}/messages/newer` },
      { method: 'GET', pathname: `/api/public/${token}/messages/older` },
    ])
  })

  it('rejects Cloud Mailbox links for a different email before syncing or reading messages', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        filterEmail: 'other@example.invalid',
        codeRequired: false,
        authorized: true,
      }),
    )
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud.olo.lat/p/synthetic_cloud_mailbox_token_123',
      ),
    ).rejects.toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a changed Cloud Mailbox contract without exposing its access token', async () => {
    const token = 'private_synthetic_cloud_token_123'
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ unexpected: true }))
    const client = new MailboxClient(fetchMock)
    const error = await client
      .listMessages('user@example.invalid', `https://icloud.olo.lat/p/${token}`)
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'MAIL_RESPONSE_INVALID' })
    expect(JSON.stringify(error)).not.toContain(token)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops explicitly when a Cloud Mailbox share requires an access code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        filterEmail: 'user@example.invalid',
        codeRequired: true,
        authorized: false,
      }),
    )
    const client = new MailboxClient(fetchMock)

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud.olo.lat/p/synthetic_cloud_mailbox_token_123',
      ),
    ).rejects.toMatchObject({
      code: 'MAIL_ACCESS_CODE_REQUIRED',
      message: '该邮箱取件链接需要访问码，当前任务只支持无需访问码的分享链接。',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'http://icloud.olo.lat/p/synthetic_cloud_mailbox_token_123',
    'https://icloud.olo.lat/wrong/synthetic_cloud_mailbox_token_123',
    'https://icloud.olo.lat/p/short',
    'https://icloud.olo.lat/p/synthetic_cloud_mailbox_token_123?extra=1',
    'https://icloud.olo.lat/p/synthetic_cloud_mailbox_token_123/extra',
  ])('rejects a malformed Cloud Mailbox URL before fetching', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://icloud-api.top/s/synthetic_token_123456/user%40example.invalid',
    'https://icloud-api.top/wrong/synthetic_token_123456/user%40example.invalid',
    'https://icloud-api.top/s/short/user%40example.invalid',
    'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?extra=1',
    'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?email=',
    'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?email=%20user%40example.invalid',
    'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid?email=user%40example.invalid&email=user%40example.invalid',
    'https://icloud-api.top/s/synthetic_token_123456/user%40example.invalid/extra',
  ])('rejects a malformed path-style mailbox URL before fetching', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a mismatched path email query without exposing the access credential or query email', async () => {
    const secret = 'private_synthetic_path_token_123456'
    const accessUrl =
      `https://icloud-api.top/s/${secret}/user%40example.invalid?email=other%40example.invalid`
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const error = await client.listMessages('user@example.invalid', accessUrl).catch((caught: unknown) => caught)
    const serializedError = `${String(error)} ${JSON.stringify(error)}`

    expect(error).toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(serializedError).not.toContain(secret)
    expect(serializedError).not.toContain('other@example.invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a path-style mailbox URL for a different account without exposing the URL', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const accessUrl = 'https://icloud-api.top/s/private_synthetic_token/other%40example.invalid'
    const error = await client.listMessages('user@example.invalid', accessUrl).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(JSON.stringify(error)).not.toContain('private_synthetic_token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    'http://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=secret&limit=5',
    'https://icloud.thefindnet.xyz/wrong?mail=user%40example.invalid&pwd=secret&limit=5',
    'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=secret&limit=5&extra=1',
    'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&mail=user2%40example.invalid&pwd=secret&limit=5',
    'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=secret&limit=10',
  ])('rejects an invalid full mailbox URL before fetching', async (accessUrl) => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=&limit=5',
      '缺少唯一的 pwd 参数',
    ],
    [
      'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&limit=5',
      '缺少唯一的 pwd 参数',
    ],
    [
      'http://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=secret&limit=5',
      '必须使用 HTTPS',
    ],
    [
      'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=secret&limit=7',
      'limit 参数必须为 5',
    ],
  ])('reports a safe and specific validation reason', async (accessUrl, message) => {
    const client = new MailboxClient(vi.fn<typeof fetch>())

    await expect(client.listMessages('user@example.invalid', accessUrl)).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
      message: `邮箱接口链接无效：${message}。`,
    })
  })

  it('uses the generic adapter for an unknown public HTTPS mailbox host', async () => {
    const secret = 'private-synthetic-secret'
    const accessUrl = `https://attacker.invalid/s/${secret}/user%40example.invalid`
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(accessUrl)
      return new Response(JSON.stringify({ results: [{ subject: 'OpenAI verification code', code: '123456' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const client = new MailboxClient(fetchMock)

    const snapshot = await client.listMessages('user@example.invalid', accessUrl)

    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]?.text).toContain('123456')
  })

  it('distinguishes an invalid path on a built-in mailbox host', async () => {
    const client = new MailboxClient(vi.fn<typeof fetch>())

    await expect(
      client.listMessages(
        'user@example.invalid',
        'https://icloud.thefindnet.xyz/wrong?mail=user%40example.invalid&pwd=secret&limit=5',
      ),
    ).rejects.toMatchObject({
      code: 'MAIL_ACCESS_URL_INVALID',
      message: '邮箱接口链接无效：接口路径不正确。',
    })
  })

  it('rejects a full mailbox URL for a different email without exposing secrets', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new MailboxClient(fetchMock)
    const secret = 'private-synthetic-secret'
    const accessUrl = `https://icloud.thefindnet.xyz/api/mail.php?mail=other%40example.invalid&pwd=${secret}&limit=5`
    const error = await client.listMessages('user@example.invalid', accessUrl).catch((caught: unknown) => caught)
    const serializedError = `${String(error)} ${JSON.stringify(error)}`

    expect(error).toMatchObject({ code: 'MAIL_ACCESS_URL_EMAIL_MISMATCH' })
    expect(serializedError).not.toContain(secret)
    expect(serializedError).not.toContain(accessUrl)
    expect(serializedError).not.toContain('other@example.invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects redirects without exposing the request URL', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } }),
      ),
    )
    const error = await client.listMessages('user@example.invalid', 'mail-secret').catch((caught) => caught)
    expect(error).toMatchObject({ code: 'MAIL_REDIRECT_REJECTED' })
    expect(JSON.stringify(error)).not.toContain('mail-secret')
    expect(JSON.stringify(error)).not.toContain('mail.php?')
  })

  it('rejects an oversized response before parsing it', async () => {
    const client = new MailboxClient(
      vi.fn<typeof fetch>(async () =>
        new Response('x'.repeat(200), {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': '200' },
        }),
      ),
      { maxResponseBytes: 100 },
    )
    await expect(client.listMessages('user@example.invalid', 'mail-secret')).rejects.toMatchObject({
      code: 'MAIL_RESPONSE_TOO_LARGE',
    })
  })

  it('classifies authentication and rate-limit responses', async () => {
    const authClient = new MailboxClient(vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 })))
    await expect(authClient.listMessages('user@example.invalid', 'bad-secret')).rejects.toMatchObject({
      code: 'MAIL_AUTHENTICATION_FAILED',
      retryable: false,
    })

    const rateClient = new MailboxClient(
      vi.fn<typeof fetch>(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })),
    )
    await expect(rateClient.listMessages('user@example.invalid', 'mail-secret')).rejects.toMatchObject({
      code: 'MAIL_RATE_LIMITED',
      retryable: true,
      details: { retryAfterMs: 7000 },
    })
  })
})

describe('normalizeMailboxResponse', () => {
  it('normalizes a structured path mailbox card without scanning unrelated page text', () => {
    const messages = normalizeMailboxResponse(
      'text/html; charset=utf-8',
      `<!doctype html><html><body>
        <p>Unrelated page number 999999</p>
        <section class="mail-card" data-message-id="message-1" data-received-at="2026-08-14T08:00:05.000Z">
          <span class="mail-from">OpenAI &lt;no-reply@openai.com&gt;</span>
          <h2 class="mail-subject">Your ChatGPT verification code</h2>
          <div class="mail-body">Use 246810 to continue.</div>
        </section>
      </body></html>`,
      'path_page',
    )

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        sender: 'OpenAI <no-reply@openai.com>',
        subject: 'Your ChatGPT verification code',
        text: 'Use 246810 to continue.',
        receivedAt: '2026-08-14T08:00:05.000Z',
      }),
    ])
    expect(messages[0]?.text).not.toContain('999999')
  })

  it('accepts a recognized English path mailbox shell but rejects an unknown page with six digits', () => {
    expect(
      normalizeMailboxResponse(
        'text/html',
        '<html><body><h1>Latest messages</h1><button>Refresh</button><p>OpenAI ChatGPT code 135790</p></body></html>',
        'path_page',
      ),
    ).toEqual([expect.objectContaining({ sender: 'ChatGPT', text: expect.stringContaining('135790') })])

    expect(() =>
      normalizeMailboxResponse(
        'text/html',
        '<html><body><h1>Account dashboard</h1><p>OpenAI status 123456</p></body></html>',
        'path_page',
      ),
    ).toThrowError(expect.objectContaining({ code: 'MAIL_PAGE_UNRECOGNIZED' }))
  })

  it('normalizes assurivo.com HTML bodies and uses excerpts only as the final fallback', () => {
    const messages = normalizeMailboxResponse(
      'application/json; charset=utf-8',
      JSON.stringify({
        data: [
          {
            id: 'assurivo-new',
            from: 'OpenAI <no-reply@openai.com>',
            subject: 'Your ChatGPT verification code',
            date: '2026-08-14T08:00:05.000Z',
            html_body: '<main>Use <strong>654321</strong> to sign in.<script>ignore 999999</script></main>',
            body_excerpt: 'Excerpt must not replace the full body.',
          },
          {
            id: 'assurivo-old',
            from: 'OpenAI <no-reply@openai.com>',
            subject: 'Older ChatGPT verification code',
            date: '2026-08-14T08:00:01.000Z',
            html_body: '',
            body_excerpt: 'Use 111111 to sign in.',
          },
        ],
      }),
    )

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'assurivo-new',
        sender: 'OpenAI <no-reply@openai.com>',
        subject: 'Your ChatGPT verification code',
        text: 'Use 654321 to sign in.',
        receivedAt: '2026-08-14T08:00:05.000Z',
      }),
      expect.objectContaining({ id: 'assurivo-old', text: 'Use 111111 to sign in.' }),
    ])
    expect(
      extractUniqueOtp(messages, createMailBaseline([]), new Date('2026-08-14T08:00:00.000Z')),
    ).toMatchObject({ kind: 'found', code: '654321' })
  })

  it('normalizes the explicit JSON fixture without traversing unknown fields', async () => {
    const body = await readFile(`${fixtures}/mail-json.json`, 'utf8')
    const messages = normalizeMailboxResponse('application/json', body)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'message-json-1',
      sender: 'OpenAI <no-reply@openai.com>',
      subject: 'Your ChatGPT verification code',
      receivedAt: '2026-08-11T08:00:04.000Z',
    })
    expect(messages[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('normalizes only recognized HTML mail containers', async () => {
    const body = await readFile(`${fixtures}/mail-html.html`, 'utf8')
    const messages = normalizeMailboxResponse('text/html; charset=utf-8', body)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'message-html-1',
      subject: 'Your OpenAI verification code',
      text: 'Enter 135790 to finish signing in.',
    })
  })

  it('normalizes the production article and extracts OTP text from iframe srcdoc', async () => {
    const body = await readFile(`${fixtures}/mail-live-page.html`, 'utf8')
    const messages = normalizeMailboxResponse('text/html; charset=utf-8', body)
    const repeated = normalizeMailboxResponse('text/html; charset=utf-8', body)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      sender: 'ChatGPT <noreply_at_tm_openai_com_example@icloud.com>',
      subject: 'ChatGPT verification',
      text: 'ChatGPT Use verification code 314159 to continue.',
    })
    expect(messages[0]?.id).toBeUndefined()
    expect(messages[0]?.receivedAt).toBeTruthy()
    expect(messages[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(repeated[0]?.fingerprint).toBe(messages[0]?.fingerprint)
    expect(
      extractUniqueOtp(messages, createMailBaseline([]), new Date('2026-08-11T00:00:00.000Z')),
    ).toMatchObject({ kind: 'found', code: '314159' })
  })

  it('extracts the six-digit code from the current Chinese ChatGPT mailbox article', () => {
    const body = `
      <html><body>
        <p>页面会每 30 秒自动刷新。</p>
        <article class="mail">
          <div class="mail-head">
            <h2>ChatGPT</h2>
            <div class="meta">
              <span>发件人：ChatGPT &lt;noreply_at_tm_openai_com_synthetic@icloud.com&gt;</span>
              <span>时间：2026-08-16 11:40:06</span>
            </div>
          </div>
          <iframe class="body-frame" srcdoc="&lt;html&gt;&lt;body&gt;&lt;h1&gt;ChatGPT&lt;/h1&gt;&lt;p&gt;输入此临时验证码以继续：&lt;/p&gt;&lt;strong&gt;207854&lt;/strong&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
        </article>
      </body></html>
    `
    const messages = normalizeMailboxResponse('text/html; charset=utf-8', body, 'path_page')

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      sender: 'ChatGPT <noreply_at_tm_openai_com_synthetic@icloud.com>',
      subject: 'ChatGPT',
      text: expect.stringContaining('207854'),
    })
    expect(
      extractUniqueOtp(messages, createMailBaseline([]), new Date('2026-08-16T03:39:00.000Z')),
    ).toMatchObject({ kind: 'found', code: '207854' })
  })

  it('accepts a recognized authenticated mailbox shell with no messages', () => {
    const body = `
      <html><body>
        <div class="top"><div class="top-inner">Mailbox</div></div>
        <main class="shell"><div class="notice">No mail yet</div></main>
      </body></html>
    `
    expect(normalizeMailboxResponse('text/html', body)).toEqual([])
  })

  it('accepts the mail.ai1998.xyz empty mailbox shell', () => {
    const body = `
      <html><body><main class="wrap">
        <header class="header">Mailbox</header>
        <div class="empty">No messages yet</div>
      </main></body></html>
    `
    expect(normalizeMailboxResponse('text/html', body, 'path_page')).toEqual([])
  })

  it('rejects malformed production articles and unknown non-empty HTML', () => {
    const malformed = `
      <article class="mail">
        <div class="mail-head"><h2>ChatGPT</h2><div class="meta"><span>发件人：sender</span></div></div>
      </article>
    `
    expect(() => normalizeMailboxResponse('text/html', malformed)).toThrowError(
      expect.objectContaining({ code: 'MAIL_RESPONSE_INVALID' }),
    )
    expect(() => normalizeMailboxResponse('text/html', '<html><body>unknown response</body></html>')).toThrowError(
      expect.objectContaining({ code: 'MAIL_RESPONSE_INVALID' }),
    )
  })
})
