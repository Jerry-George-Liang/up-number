import { describe, expect, it, vi } from 'vitest'
import type {
  AccountPoolBrowserResponse,
  AccountPoolBrowserSession,
} from '../../src/server/account-pool/browser-session'
import { AccountPoolPortalService } from '../../src/server/account-pool/portal'

const origin = 'http://192.168.50.207:3000'

class MemorySettings {
  readonly values = new Map<string, string>()

  getSetting(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.values.set(key, value)
  }

  deleteSetting(key: string): void {
    this.values.delete(key)
  }
}

function browserJson(target: URL, body: unknown, status = 200): AccountPoolBrowserResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: target.href,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
    redirected: false,
    type: 'basic',
  }
}

function authConfig(target: URL): AccountPoolBrowserResponse {
  return browserJson(target, {
    ssoEnabled: true,
    navigatorSsoEnabled: true,
    passwordLoginEnabled: true,
  })
}

class FakeBrowserSession implements AccountPoolBrowserSession {
  activeOrigin: string | null = null
  loggedIn = true
  handler: (target: URL) => Promise<AccountPoolBrowserResponse>
  readonly opened: Array<{ origin: string; foreground: boolean }> = []
  closeCalls = 0

  constructor(handler?: (target: URL) => Promise<AccountPoolBrowserResponse>) {
    this.handler = handler ?? (async (target) => {
      if (target.pathname === '/api/auth/config') return authConfig(target)
      if (target.pathname === '/api/me') {
        return this.loggedIn
          ? browserJson(target, { user: { id: 7 } })
          : browserJson(target, { error: '请先登录' }, 401)
      }
      throw new Error(`Unexpected browser request: ${target.pathname}`)
    })
  }

  async open(nextOrigin: string, options: { foreground?: boolean } = {}): Promise<void> {
    this.activeOrigin = nextOrigin
    this.opened.push({ origin: nextOrigin, foreground: options.foreground !== false })
  }

  requireExisting(nextOrigin: string): void {
    if (this.activeOrigin !== nextOrigin) throw new Error('No existing browser session')
  }

  async request(target: URL): Promise<AccountPoolBrowserResponse> {
    return this.handler(target)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.activeOrigin = null
  }
}

function setup(browser = new FakeBrowserSession()) {
  const settings = new MemorySettings()
  const portal = new AccountPoolPortalService({ settings, browserSession: browser })
  return { settings, browser, portal }
}

describe('AccountPoolPortalService', () => {
  it('uses the existing webpage login and can recheck after the user logs in', async () => {
    const { settings, browser, portal } = setup()
    browser.loggedIn = false

    await expect(portal.connect({ origin: `${origin}/` })).resolves.toMatchObject({
      configured: true,
      connected: false,
      origin,
      lastError: { code: 'ACCOUNT_POOL_LOGIN_REQUIRED' },
    })
    expect(settings.getSetting('account_pool_portal_origin')).toBe(origin)
    expect(browser.activeOrigin).toBe(origin)

    browser.loggedIn = true
    await expect(portal.connect({ origin })).resolves.toMatchObject({
      configured: true,
      connected: true,
      origin,
      lastError: null,
    })
    expect(browser.opened).toEqual([
      { origin, foreground: true },
      { origin, foreground: true },
    ])
  })

  it('keeps rechecks in the existing background browser session', async () => {
    const { browser, portal } = setup()

    await expect(portal.connect({ origin, foreground: false })).resolves.toMatchObject({
      configured: true,
      connected: true,
    })

    expect(browser.opened).toEqual([{ origin, foreground: false }])
  })

  it('reads one exact remote record through the same webpage session', async () => {
    const browser = new FakeBrowserSession()
    browser.handler = vi.fn(async (target: URL) => {
      if (target.pathname === '/api/auth/config') return authConfig(target)
      if (target.pathname === '/api/me') return browserJson(target, { user: { id: 7 } })
      if (target.pathname === '/api/records') {
        if (target.searchParams.has('q')) expect(target.searchParams.get('q')).toBe('user@example.invalid')
        return browserJson(target, {
          items: [
            {
              id: 42,
              email: 'User@Example.Invalid',
              hasPassword: true,
              hasVerification: true,
              hasEmailToken: true,
            },
          ],
          total: 1,
          page: 1,
          limit: 100,
        })
      }
      if (target.pathname === '/api/records/42/secret') {
        const values: Record<string, string> = {
          password: 'synthetic-account-password',
          verification: 'JBSWY3DPEHPK3PXP',
          emailToken: 'https://mail.example.invalid/token',
        }
        return browserJson(target, { value: values[target.searchParams.get('field') ?? ''] ?? '' })
      }
      throw new Error(`Unexpected browser request: ${target.pathname}`)
    })
    const { portal } = setup(browser)
    await portal.connect({ origin })

    await expect(portal.resolve(' User@Example.Invalid ')).resolves.toEqual({
      email: 'user@example.invalid',
      password: 'synthetic-account-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      mailboxAccess: 'https://mail.example.invalid/token',
    })
    expect(browser.opened).toEqual([
      { origin, foreground: true },
      { origin, foreground: false },
    ])

    await expect(portal.auditMailboxOrigins()).resolves.toEqual({
      totalRecords: 1,
      recordsWithMailboxAccess: 1,
      invalidAccessValues: 0,
      readFailures: 0,
      origins: [{ origin: 'https://mail.example.invalid', count: 1, pathTemplates: ['/<value>'] }],
    })
  })

  it('inspects one mailbox origin without returning its access token', async () => {
    const browser = new FakeBrowserSession()
    browser.handler = vi.fn(async (target: URL) => {
      if (target.pathname === '/api/auth/config') return authConfig(target)
      if (target.pathname === '/api/me') return browserJson(target, { user: { id: 7 } })
      if (target.pathname === '/api/records') {
        return browserJson(target, {
          items: [{ id: 42, email: 'User@Example.Invalid', hasEmailToken: true }],
          total: 1,
          page: 1,
          limit: 100,
        })
      }
      if (target.pathname === '/api/records/42/secret') {
        return browserJson(target, { value: 'https://mail.example.invalid/s/private-token/user%40example.invalid' })
      }
      throw new Error(`Unexpected browser request: ${target.pathname}`)
    })
    const { portal } = setup(browser)
    await portal.connect({ origin })

    const inspected = await portal.inspectMailboxOrigin('user@example.invalid')
    expect(inspected).toEqual({
      email: 'user@example.invalid',
      hasMailboxAccess: true,
      validAccessUrl: true,
      origin: 'https://mail.example.invalid',
      pathTemplate: '/s/<value>/<value>',
      queryParameterNames: [],
    })
    expect(JSON.stringify(inspected)).not.toContain('private-token')
  })

  it('does not reject an audit page because another legacy record has a non-RFC email', async () => {
    const browser = new FakeBrowserSession()
    browser.handler = vi.fn(async (target: URL) => {
      if (target.pathname === '/api/auth/config') return authConfig(target)
      if (target.pathname === '/api/me') return browserJson(target, { user: { id: 7 } })
      if (target.pathname === '/api/records') {
        return browserJson(target, {
          items: [{ id: 42, email: 'legacy-mailbox', hasEmailToken: false }],
          total: 1,
          page: 1,
          limit: 100,
        })
      }
      throw new Error(`Unexpected browser request: ${target.pathname}`)
    })
    const { portal } = setup(browser)
    await portal.connect({ origin })

    await expect(portal.auditMailboxOrigins()).resolves.toMatchObject({
      totalRecords: 1,
      recordsWithMailboxAccess: 0,
      invalidAccessValues: 0,
      readFailures: 0,
    })
  })

  it('retries a rate-limited account list request and then resolves the account', async () => {
    const browser = new FakeBrowserSession()
    let recordRequests = 0
    browser.handler = vi.fn(async (target: URL) => {
      if (target.pathname === '/api/auth/config') return authConfig(target)
      if (target.pathname === '/api/me') return browserJson(target, { user: { id: 7 } })
      if (target.pathname === '/api/records') {
        recordRequests += 1
        if (recordRequests === 1) return browserJson(target, { error: 'rate limited' }, 429)
        return browserJson(target, {
          items: [{ id: 42, email: 'user@example.invalid', hasPassword: true, hasVerification: false, hasEmailToken: false }],
          total: 1,
          page: 1,
          limit: 100,
        })
      }
      if (target.pathname === '/api/records/42/secret') return browserJson(target, { value: 'synthetic-password' })
      throw new Error(`Unexpected browser request: ${target.pathname}`)
    })
    const { portal } = setup(browser)
    await portal.connect({ origin })

    await expect(portal.resolve('user@example.invalid')).resolves.toMatchObject({
      email: 'user@example.invalid',
      password: 'synthetic-password',
    })
    expect(recordRequests).toBe(2)
  })

  it('closes the controlled browser and removes only the saved origin on disconnect', async () => {
    const { settings, browser, portal } = setup()
    await portal.connect({ origin })

    await portal.disconnect()

    expect(portal.status()).toEqual({
      configured: false,
      connected: false,
      origin: null,
      lastCheckedAt: null,
      lastError: null,
    })
    expect(settings.getSetting('account_pool_portal_origin')).toBeNull()
    expect(browser.closeCalls).toBe(1)
  })

  it('rejects paths and embedded credentials before opening the browser', async () => {
    const { browser, portal } = setup()

    await expect(portal.connect({ origin: `${origin}/path` })).rejects.toMatchObject({
      code: 'ACCOUNT_POOL_ORIGIN_INVALID',
    })
    await expect(
      portal.connect({ origin: 'http://user:password@192.168.50.207:3000/' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_POOL_ORIGIN_INVALID' })
    expect(browser.opened).toEqual([])
  })
})
