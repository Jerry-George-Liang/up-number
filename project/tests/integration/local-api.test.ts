import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { PublicTask } from '../../src/shared/contracts'
import { AppError } from '../../src/shared/errors'
import { buildApp, type LocalAppDependencies } from '../../src/server/app'
import { LocalSessionSecurity } from '../../src/server/local-security'
import { parseIpv4Cidr } from '../../src/server/network-access'

const origin = 'http://127.0.0.1:43123'
const bootstrapFormHeaders = { 'content-type': 'application/x-www-form-urlencoded' }
const generatedAuthUrl =
  'https://auth.openai.com/oauth/authorize?client_id=synthetic-client&code_challenge=synthetic-challenge&code_challenge_method=S256&response_type=code&state=synthetic-state'
const webFixtureRoot = fileURLToPath(new URL('../fixtures/web', import.meta.url))

function publicTask(overrides: Partial<PublicTask> = {}): PublicTask {
  const now = '2026-08-11T08:00:00.000Z'
  return {
    id: 'task-api-1',
    accountEmail: 'user@example.invalid',
    stage: 'waiting_for_otp',
    status: 'active',
    selection: {
      operation: 'create',
      proxyMode: 'none',
      concurrency: 10,
      supplier: null,
      groups: [],
      modelsCleared: true,
    },
    authorization: null,
    terminalFromStage: null,
    account: null,
    error: null,
    message: '等待验证码',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function setup(
  webRoot?: string,
  securityOverride?: LocalSessionSecurity,
  accessOverride: Pick<LocalAppDependencies, 'localOrigin' | 'accessPolicy'> &
    Partial<Pick<LocalAppDependencies, 'sessionCookieName' | 'autoEstablishSession'>> = { localOrigin: origin },
) {
  const randomValues = ['bootstrap-nonce', 'local-session-id', 'csrf-value']
  const security = securityOverride ?? new LocalSessionSecurity(() => randomValues.shift()!)
  let active: PublicTask | null = null
  const history = [publicTask({ stage: 'completed', status: 'success' })]
  const listeners = new Set<(task: PublicTask) => void>()
  const session = {
    publicSession: vi.fn(() => ({
      authenticated: false,
      email: null,
      user: null,
    })),
    login: vi.fn(async (email: string, password: string) =>
      email.startsWith('totp')
        ? {
            state: 'totp_required' as const,
            attemptId: 'a'.repeat(43),
            maskedEmail: 't***@example.invalid',
            expiresAt: '2026-08-12T06:00:00.000Z',
          }
        : {
            state: 'authenticated' as const,
            session: {
              authenticated: true,
              email,
              user: { id: 1, email, role: password ? 'admin' : 'none' },
            },
          },
    ),
    completeTotp: vi.fn(async () => ({
      authenticated: true,
      email: 'totp@example.invalid',
      user: { id: 1, email: 'totp@example.invalid', role: 'admin' },
    })),
    cancelPendingLogin: vi.fn(() => undefined),
    logout: vi.fn(async () => undefined),
  }
  const optionsSnapshot = {
    version: 'v1',
    loadedAt: '2026-08-11T08:00:00.000Z',
    proxies: [],
    subscriptions: [],
    suppliers: [],
    groups: [],
  }
  let customPathOrigins: string[] = []
  let confirmationAttempts = 2
  const dependencies: LocalAppDependencies = {
    security,
    ...accessOverride,
    webRoot,
    session,
    mailboxSettings: {
      getSettings: vi.fn(() => ({
        builtInPathOrigins: ['https://icloud-api.top'],
        customPathOrigins,
        configurationValid: true,
      })),
      updateSettings: vi.fn((input) => {
        customPathOrigins = [...input.customPathOrigins]
        return {
          builtInPathOrigins: ['https://icloud-api.top'],
          customPathOrigins,
          configurationValid: true,
        }
      }),
      hasActiveTask: () => active !== null,
    },
    options: { loadSnapshot: vi.fn(async () => optionsSnapshot) },
    reauthorization: {
      listAccounts: vi.fn(async () => ({ items: [], page: 1, pageSize: 50, total: 0, pages: 0 })),
      getAccount: vi.fn(async (accountId: number) => ({
        id: accountId,
        name: 'user@example.invalid',
        email: 'user@example.invalid',
        status: 'error',
        usage7dPercent: 80,
      })),
      startTask: vi.fn((input: any) => {
        if (active) throw new AppError('TASK_ALREADY_ACTIVE', '已有任务', { statusCode: 409 })
        active = publicTask({
          accountEmail: input.accountEmail,
          selection: {
            operation: 'reauthorize',
            targetAccountId: input.accountId,
            targetAccountName: 'user@example.invalid',
            statusBefore: 'error',
            maxUsage7dPercent: input.maxUsage7dPercent,
            proxyMode: 'none',
          },
        })
        return active
      }),
      getHostingState: vi.fn(() => ({
        status: 'idle' as const,
        search: '',
        maxUsage7dPercent: 90,
        importedWithinDays: null,
        proxyMode: 'existing' as const,
        currentAccountId: null,
        currentTaskId: null,
        total: 0,
        completed: 0,
        failed: 0,
        banned: 0,
        skipped: 0,
        lastAccountId: null,
        lastResult: null,
        lastMessage: '',
        createdAt: null,
        updatedAt: '2026-08-18T00:00:00.000Z',
      })),
      startHosting: vi.fn(async () => ({
        status: 'running' as const,
        search: '',
        maxUsage7dPercent: 90,
        importedWithinDays: null,
        proxyMode: 'existing' as const,
        currentAccountId: null,
        currentTaskId: null,
        total: 2,
        completed: 0,
        failed: 0,
        banned: 0,
        skipped: 0,
        lastAccountId: null,
        lastResult: null,
        lastMessage: 'started',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      })),
      stopHosting: vi.fn(() => ({
        status: 'stopped' as const,
        search: '',
        maxUsage7dPercent: 90,
        importedWithinDays: null,
        proxyMode: 'existing' as const,
        currentAccountId: null,
        currentTaskId: null,
        total: 2,
        completed: 0,
        failed: 0,
        banned: 0,
        skipped: 0,
        lastAccountId: null,
        lastResult: null,
        lastMessage: 'stopped',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      })),
      skipCurrentHosting: vi.fn(() => ({
        status: 'running' as const,
        search: '',
        maxUsage7dPercent: 90,
        importedWithinDays: null,
        proxyMode: 'existing' as const,
        currentAccountId: null,
        currentTaskId: null,
        total: 2,
        completed: 0,
        failed: 0,
        banned: 0,
        skipped: 1,
        lastAccountId: 1,
        lastResult: 'skipped' as const,
        lastMessage: 'skipped',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      })),
      setAccountHostingExcluded: vi.fn((accountId: number, excluded: boolean) => ({ accountId, excluded })),
      setAccountDisposition: vi.fn(async (accountId: number, note: string, excluded: boolean) => ({
        id: accountId,
        name: `user@example.invalid（${note}）`,
        email: 'user@example.invalid',
        status: 'error',
        usage7dPercent: 80,
        hostingNote: note,
        excludedFromHosting: excluded,
      })),
      setBulkAccountDisposition: vi.fn(async (accountIds: number[], note: string, excluded: boolean) => ({
        updated: accountIds.map((accountId) => ({
          id: accountId,
          name: `user@example.invalid（${note}）`,
          email: 'user@example.invalid',
          status: 'error',
          usage7dPercent: 80,
          hostingNote: note,
          excludedFromHosting: excluded,
        })),
        failed: [],
      })),
    },
    deactivationSettings: {
      getSettings: vi.fn(() => ({ confirmationAttempts })),
      updateSettings: vi.fn((input) => {
        confirmationAttempts = input.confirmationAttempts
        return { confirmationAttempts }
      }),
      hasActiveTask: vi.fn(() => active !== null),
    },
    orchestrator: {
      start: vi.fn((input: any) => {
        if (active) throw new AppError('TASK_ALREADY_ACTIVE', '已有任务', { statusCode: 409 })
        active = publicTask({ accountEmail: input.accountEmail })
        return active
      }),
      cancel: vi.fn((id: string) => {
        if (!active || active.id !== id) throw new AppError('TASK_NOT_ACTIVE', '任务未运行', { statusCode: 404 })
        active = { ...active, stage: 'cancelled', status: 'cancelled' }
        listeners.forEach((listener) => listener(active!))
        return active
      }),
      takeOver: vi.fn((id: string) => {
        if (!active || active.id !== id) throw new AppError('TASK_NOT_ACTIVE', 'not active')
        active = { ...active, manualTakeover: true }
        return active
      }),
      releaseTakeover: vi.fn((id: string) => {
        if (!active || active.id !== id) throw new AppError('TASK_NOT_ACTIVE', 'not active')
        active = { ...active, manualTakeover: false }
        return active
      }),
      subscribe: vi.fn((listener: (task: PublicTask) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
      getActiveTask: () => active,
      getAuthorizationUrl: vi.fn((id: string) => (id === 'task-api-1' ? generatedAuthUrl : null)),
      forgetAuthorizationUrl: vi.fn(),
    },
    tasks: {
      listTasks: vi.fn(() => history),
      getTask: vi.fn((id: string) => (id === 'task-api-1' ? active ?? history[0]! : null)),
      deleteTask: vi.fn((id: string) => id === 'task-api-1'),
    },
    provisioningAgent: {
      status: vi.fn(() => ({
        paired: false,
        connected: false,
        runningTask: false,
        centralOrigin: null,
        deviceId: null,
        deviceName: null,
        lastContactAt: null,
        lastError: null,
      })),
      pair: vi.fn(async (input) => ({
        paired: true,
        connected: false,
        runningTask: false,
        centralOrigin: input.centralOrigin,
        deviceId: '550e8400-e29b-41d4-a716-446655440000',
        deviceName: input.deviceName,
        lastContactAt: null,
        lastError: null,
      })),
      changeOrigin: vi.fn(async (input) => ({
        paired: true,
        connected: true,
        runningTask: false,
        centralOrigin: input.centralOrigin,
        deviceId: '550e8400-e29b-41d4-a716-446655440000',
        deviceName: 'Operator Mac',
        lastContactAt: '2026-08-16T03:00:00.000Z',
        lastError: null,
      })),
      disconnect: vi.fn(async () => undefined),
    },
  }
  return { app: buildApp(dependencies), dependencies, security }
}

async function bootstrap(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: 'POST',
    url: '/bootstrap?nonce=bootstrap-nonce',
    headers: bootstrapFormHeaders,
    payload: '',
  })
  expect(response.statusCode).toBe(302)
  const setCookie = response.headers['set-cookie']
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!
  return cookie
}

function writeHeaders(cookie: string) {
  return { cookie, origin, 'x-csrf-token': 'csrf-value' }
}

describe('local Fastify API', () => {
  it('restricts a LAN listener to its exact Host, client CIDR, Origin, and own session', async () => {
    const persistentSeed = 'A'.repeat(43)
    const lanOrigin = 'https://192.168.50.218:43123'
    const lanSecurity = new LocalSessionSecurity({
      persistentSeed,
      namespace: 'lan:192.168.50.218:43123',
      random: () => 'lan-bootstrap',
    })
    const { app } = setup(undefined, lanSecurity, {
      localOrigin: lanOrigin,
      accessPolicy: {
        allowedHostnames: ['192.168.50.218'],
        allowedClientCidr: parseIpv4Cidr('192.168.50.0/24'),
      },
    })
    const allowedConnection = {
      host: '192.168.50.218:43123',
    }

    const wrongHost = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'attacker.invalid' },
      remoteAddress: '192.168.50.10',
    })
    expect(wrongHost).toMatchObject({ statusCode: 403 })
    expect(wrongHost.json()).toMatchObject({ error: { code: 'LOCAL_HOST_INVALID' } })

    const wrongNetwork = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: allowedConnection,
      remoteAddress: '192.168.51.10',
    })
    expect(wrongNetwork).toMatchObject({ statusCode: 403 })
    expect(wrongNetwork.json()).toMatchObject({ error: { code: 'LOCAL_CLIENT_NETWORK_INVALID' } })

    const health = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: allowedConnection,
      remoteAddress: '192.168.50.10',
    })
    expect(health.statusCode).toBe(200)

    const confirmed = await app.inject({
      method: 'POST',
      url: '/bootstrap?nonce=lan-bootstrap',
      headers: { ...allowedConnection, ...bootstrapFormHeaders },
      remoteAddress: '192.168.50.10',
      payload: '',
    })
    expect(confirmed.statusCode).toBe(302)
    expect(confirmed.headers['set-cookie']).toMatch(/Secure/i)
    expect(confirmed.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    const lanCookie = String(confirmed.headers['set-cookie']).split(';')[0]!

    const crossOrigin = await app.inject({
      method: 'DELETE',
      url: '/local-api/session/login-pending',
      headers: {
        ...allowedConnection,
        cookie: lanCookie,
        origin,
        'x-csrf-token': lanSecurity.csrfToken,
      },
      remoteAddress: '192.168.50.10',
    })
    expect(crossOrigin).toMatchObject({ statusCode: 403 })
    expect(crossOrigin.headers['set-cookie']).toBeUndefined()

    const write = await app.inject({
      method: 'DELETE',
      url: '/local-api/session/login-pending',
      headers: {
        ...allowedConnection,
        cookie: lanCookie,
        origin: lanOrigin,
        'x-csrf-token': lanSecurity.csrfToken,
      },
      remoteAddress: '192.168.50.10',
    })
    expect(write.statusCode).toBe(204)
    expect(write.headers['strict-transport-security']).toBe('max-age=31536000')
    expect(write.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    expect(write.headers['set-cookie']).toMatch(/Secure/i)

    const loopbackSecurity = new LocalSessionSecurity({ persistentSeed })
    const loopbackCookie = `up_icloud_session=${loopbackSecurity.sessionId}`
    const loopbackCookieOnLan = await app.inject({
      method: 'GET',
      url: '/local-api/session',
      headers: { ...allowedConnection, cookie: loopbackCookie },
      remoteAddress: '192.168.50.10',
    })
    expect(loopbackCookieOnLan).toMatchObject({ statusCode: 401 })
    await app.close()
  })

  it('supports explicit LAN HTTP with a separate non-Secure persistent cookie', async () => {
    const persistentSeed = 'A'.repeat(43)
    const lanOrigin = 'http://192.168.50.218:43123'
    const lanSecurity = new LocalSessionSecurity({
      persistentSeed,
      namespace: 'lan-http:192.168.50.218:43123',
      random: () => 'lan-http-bootstrap',
    })
    const allowedConnection = {
      host: '192.168.50.218:43123',
    }
    const { app } = setup(undefined, lanSecurity, {
      localOrigin: lanOrigin,
      sessionCookieName: 'up_icloud_lan_http_session',
      autoEstablishSession: true,
      accessPolicy: {
        allowedHostnames: ['192.168.50.218'],
        allowedClientCidr: parseIpv4Cidr('192.168.50.0/24'),
      },
    })

    const automaticallyEstablished = await app.inject({
      method: 'GET',
      url: '/local-api/session',
      headers: allowedConnection,
      remoteAddress: '192.168.50.10',
    })
    expect(automaticallyEstablished.statusCode).toBe(200)
    expect(automaticallyEstablished.headers['set-cookie']).toMatch(/up_icloud_lan_http_session=/)
    expect(automaticallyEstablished.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    expect(automaticallyEstablished.headers['set-cookie']).toMatch(/HttpOnly/i)
    expect(automaticallyEstablished.headers['set-cookie']).toMatch(/SameSite=Strict/i)
    expect(automaticallyEstablished.headers['set-cookie']).not.toMatch(/Secure/i)
    expect(automaticallyEstablished.headers['strict-transport-security']).toBeUndefined()
    const lanCookie = String(automaticallyEstablished.headers['set-cookie']).split(';')[0]!

    const session = await app.inject({
      method: 'GET',
      url: '/local-api/session',
      headers: { ...allowedConnection, cookie: lanCookie },
      remoteAddress: '192.168.50.10',
    })
    expect(session.statusCode).toBe(200)
    expect(session.headers['set-cookie']).toMatch(/up_icloud_lan_http_session=/)
    expect(session.headers['set-cookie']).not.toMatch(/Secure/i)

    const write = await app.inject({
      method: 'DELETE',
      url: '/local-api/session/login-pending',
      headers: {
        ...allowedConnection,
        cookie: lanCookie,
        origin: lanOrigin,
        'x-csrf-token': lanSecurity.csrfToken,
      },
      remoteAddress: '192.168.50.10',
    })
    expect(write.statusCode).toBe(204)
    expect(write.headers['set-cookie']).not.toMatch(/Secure/i)

    const oldHttpsCookie = `up_icloud_session=${lanSecurity.sessionId}`
    const wrongCookieName = await app.inject({
      method: 'GET',
      url: '/local-api/options',
      headers: { ...allowedConnection, cookie: oldHttpsCookie },
      remoteAddress: '192.168.50.10',
    })
    expect(wrongCookieName.statusCode).toBe(401)
    await app.close()
  })

  it('auto-establishes only the session GET when explicitly enabled', async () => {
    const { app } = setup(undefined, undefined, {
      localOrigin: origin,
      autoEstablishSession: true,
    })

    const protectedRead = await app.inject({ method: 'GET', url: '/local-api/options' })
    expect(protectedRead.statusCode).toBe(401)
    expect(protectedRead.headers['set-cookie']).toBeUndefined()

    const protectedWrite = await app.inject({
      method: 'POST',
      url: '/local-api/session/login',
      payload: { email: 'admin@example.invalid', password: 'synthetic-password' },
    })
    expect(protectedWrite.statusCode).toBe(401)
    expect(protectedWrite.headers['set-cookie']).toBeUndefined()

    const session = await app.inject({ method: 'GET', url: '/local-api/session' })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ csrfToken: 'csrf-value' })
    expect(session.headers['set-cookie']).toMatch(/up_icloud_session=local-session-id/)
    expect(session.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    const cookie = String(session.headers['set-cookie']).split(';')[0]!

    const protectedAfterInitialization = await app.inject({
      method: 'GET',
      url: '/local-api/options',
      headers: { cookie },
    })
    expect(protectedAfterInitialization.statusCode).toBe(200)
    await app.close()
  })

  it('prevents browsers from retaining the SPA HTML document', async () => {
    const { app } = setup(webFixtureRoot)

    const home = await app.inject({ method: 'GET', url: '/' })
    expect(home.statusCode).toBe(200)
    expect(home.headers['content-type']).toContain('text/html')
    expect(home.headers['cache-control']).toBe('no-store')
    expect(home.body).toContain('current-spa-fixture')

    const clientRoute = await app.inject({ method: 'GET', url: '/reauthorization' })
    expect(clientRoute.statusCode).toBe(200)
    expect(clientRoute.headers['content-type']).toContain('text/html')
    expect(clientRoute.headers['cache-control']).toBe('no-store')

    await app.close()
  })

  it('keeps bootstrap GETs non-consuming and consumes the nonce only on confirmation', async () => {
    const { app } = setup()
    await expect(
      app.inject({ method: 'GET', url: '/bootstrap?nonce=wrong', headers: { host: '127.0.0.1:43123' } }),
    ).resolves.toMatchObject({
      statusCode: 403,
    })

    const firstGet = await app.inject({
      method: 'GET',
      url: '/bootstrap?nonce=bootstrap-nonce',
      headers: { host: '127.0.0.1:43123' },
    })
    expect(firstGet.statusCode).toBe(200)
    expect(firstGet.headers['content-type']).toContain('text/html')
    expect(firstGet.headers['cache-control']).toBe('no-store')
    expect(firstGet.headers['set-cookie']).toBeUndefined()
    expect(firstGet.body).toContain('id="bootstrap-status"')
    expect(firstGet.body).toContain('id="bootstrap-form"')
    expect(firstGet.body).toContain('method="post"')
    expect(firstGet.body).toContain('action="/bootstrap?nonce=bootstrap-nonce"')
    expect(firstGet.body).toContain('src="/bootstrap.js"')
    expect(firstGet.body).not.toContain('<script>')
    expect(firstGet.body).not.toMatch(/local-session-id|csrf-value/)

    const bootstrapScript = await app.inject({ method: 'GET', url: '/bootstrap.js' })
    expect(bootstrapScript.statusCode).toBe(200)
    expect(bootstrapScript.headers['content-type']).toContain('application/javascript')
    expect(bootstrapScript.headers['cache-control']).toBe('no-store')
    expect(bootstrapScript.body).toContain("fetch('/healthz'")
    expect(bootstrapScript.body).toContain("payload.status !== 'ok'")
    expect(bootstrapScript.body).toContain('HTMLFormElement.prototype.submit.call(form)')
    expect(bootstrapScript.body.indexOf("fetch('/healthz'")).toBeLessThan(
      bootstrapScript.body.indexOf('HTMLFormElement.prototype.submit.call(form)'),
    )
    expect(bootstrapScript.body).not.toMatch(/bootstrap-nonce|local-session-id|csrf-value/)

    const secondGet = await app.inject({
      method: 'GET',
      url: '/bootstrap?nonce=bootstrap-nonce',
      headers: { host: '127.0.0.1:43123' },
    })
    expect(secondGet.statusCode).toBe(200)
    expect(secondGet.headers['set-cookie']).toBeUndefined()

    const confirmed = await app.inject({
      method: 'POST',
      url: '/bootstrap?nonce=bootstrap-nonce',
      headers: bootstrapFormHeaders,
      payload: '',
    })
    expect(confirmed.statusCode).toBe(302)
    expect(confirmed.headers.location).toBe('/?bootstrapped=1')
    expect(confirmed.headers['set-cookie']).toMatch(/up_icloud_session=local-session-id/)
    expect(confirmed.headers['set-cookie']).toMatch(/HttpOnly/i)
    expect(confirmed.headers['set-cookie']).toMatch(/SameSite=Strict/i)
    expect(confirmed.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    expect(confirmed.headers['set-cookie']).toMatch(/Path=\//i)
    expect(confirmed.headers['set-cookie']).not.toMatch(/Secure/i)
    const sessionCookie = String(confirmed.headers['set-cookie']).split(';')[0]!
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/bootstrap?nonce=bootstrap-nonce',
          headers: bootstrapFormHeaders,
          payload: '',
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/bootstrap?nonce=bootstrap-nonce',
          headers: { host: '127.0.0.1:43123' },
        })
      ).statusCode,
    ).toBe(403)
    const repeatedGet = await app.inject({
      method: 'GET',
      url: '/bootstrap?nonce=bootstrap-nonce',
      headers: { cookie: sessionCookie, host: '127.0.0.1:43123' },
    })
    expect(repeatedGet.statusCode).toBe(302)
    expect(repeatedGet.headers.location).toBe('/?bootstrapped=1')
    expect(repeatedGet.headers['cache-control']).toBe('no-store')
    expect(repeatedGet.headers['set-cookie']).toMatch(/Max-Age=31536000/i)

    const repeatedPost = await app.inject({
      method: 'POST',
      url: '/bootstrap?nonce=already-consumed',
      headers: { ...bootstrapFormHeaders, cookie: sessionCookie, host: '127.0.0.1:43123' },
      payload: '',
    })
    expect(repeatedPost.statusCode).toBe(302)
    expect(repeatedPost.headers.location).toBe('/?bootstrapped=1')
    expect(repeatedPost.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    await app.close()
  })

  it('accepts the existing cookie and CSRF token after a service restart with the same seed', async () => {
    const persistentSeed = 'A'.repeat(43)
    const firstSecurity = new LocalSessionSecurity({ persistentSeed, random: () => 'first-bootstrap' })
    const first = setup(undefined, firstSecurity)
    const firstBootstrap = await first.app.inject({
      method: 'POST',
      url: '/bootstrap?nonce=first-bootstrap',
      headers: bootstrapFormHeaders,
      payload: '',
    })
    const cookie = String(firstBootstrap.headers['set-cookie']).split(';')[0]!
    await first.app.close()

    const secondSecurity = new LocalSessionSecurity({ persistentSeed, random: () => 'second-bootstrap' })
    const second = setup(undefined, secondSecurity)
    const restored = await second.app.inject({
      method: 'GET',
      url: '/local-api/session',
      headers: { cookie },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ csrfToken: firstSecurity.csrfToken })
    expect(restored.headers['set-cookie']).toMatch(/Max-Age=31536000/i)

    const write = await second.app.inject({
      method: 'DELETE',
      url: '/local-api/session/login-pending',
      headers: { cookie, origin, 'x-csrf-token': firstSecurity.csrfToken },
    })
    expect(write.statusCode).toBe(204)
    expect(write.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    await second.app.close()
  })

  it('rejects ambiguous bootstrap query values without raising an internal error', async () => {
    const { app } = setup()
    const response = await app.inject({
      method: 'GET',
      url: '/bootstrap?nonce=bootstrap-nonce&nonce=duplicate',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'BOOTSTRAP_INVALID' } })
    await app.close()
  })

  it('logs unexpected failures without logging the bootstrap nonce', async () => {
    const { app, security } = setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(security, 'canBootstrap').mockImplementation(() => {
      throw new TypeError('synthetic bootstrap failure')
    })

    try {
      const response = await app.inject({ method: 'GET', url: '/bootstrap?nonce=bootstrap-nonce' })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
      const logged = JSON.stringify(consoleError.mock.calls)
      expect(logged).toContain('Unexpected GET /bootstrap')
      expect(logged).toContain('synthetic bootstrap failure')
      expect(logged).not.toContain('bootstrap-nonce')
    } finally {
      consoleError.mockRestore()
      await app.close()
    }
  })

  it('requires the local cookie for reads and CSRF plus matching Origin for writes', async () => {
    const { app } = setup()
    const unauthenticated = await app.inject({ method: 'GET', url: '/local-api/session' })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.headers['set-cookie']).toBeUndefined()
    const cookie = await bootstrap(app)
    const session = await app.inject({ method: 'GET', url: '/local-api/session', headers: { cookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({ csrfToken: 'csrf-value', session: { authenticated: false } })
    expect(session.headers['set-cookie']).toMatch(/up_icloud_session=local-session-id/)
    expect(session.headers['set-cookie']).toMatch(/Max-Age=31536000/i)

    const body = { email: 'admin@example.invalid', password: 'synthetic-password' }
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/local-api/session/login',
      headers: { cookie },
      payload: body,
    })
    expect(missingCsrf.statusCode).toBe(403)
    expect(missingCsrf.headers['set-cookie']).toBeUndefined()
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/local-api/session/login',
      headers: { cookie, origin: 'http://attacker.invalid', 'x-csrf-token': 'csrf-value' },
      payload: body,
    })
    expect(wrongOrigin.statusCode).toBe(403)
    expect(wrongOrigin.headers['set-cookie']).toBeUndefined()
    const valid = await app.inject({
      method: 'POST',
      url: '/local-api/session/login',
      headers: writeHeaders(cookie),
      payload: body,
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toMatchObject({ state: 'authenticated', session: { authenticated: true } })
    expect(valid.headers['set-cookie']).toMatch(/Max-Age=31536000/i)
    expect(JSON.stringify(valid.json())).not.toContain('synthetic-password')
    await app.close()
  })

  it('protects mailbox trust settings, validates writes, and blocks changes during an active task', async () => {
    const { app, dependencies } = setup()
    expect((await app.inject({ method: 'GET', url: '/local-api/settings/mailbox-trust' })).statusCode).toBe(401)

    const cookie = await bootstrap(app)
    const initial = await app.inject({
      method: 'GET',
      url: '/local-api/settings/mailbox-trust',
      headers: { cookie },
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toEqual({
      builtInPathOrigins: ['https://icloud-api.top'],
      customPathOrigins: [],
      configurationValid: true,
    })

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/local-api/settings/mailbox-trust',
          headers: { cookie },
          payload: { customPathOrigins: ['https://mail.example.invalid'] },
        })
      ).statusCode,
    ).toBe(403)

    const malformed = await app.inject({
      method: 'PUT',
      url: '/local-api/settings/mailbox-trust',
      headers: writeHeaders(cookie),
      payload: { customPathOrigins: [], extra: true },
    })
    expect(malformed.statusCode).toBe(400)

    const updated = await app.inject({
      method: 'PUT',
      url: '/local-api/settings/mailbox-trust',
      headers: writeHeaders(cookie),
      payload: { customPathOrigins: ['https://mail.example.invalid'] },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ customPathOrigins: ['https://mail.example.invalid'] })
    expect(dependencies.mailboxSettings.updateSettings).toHaveBeenCalledTimes(1)

    dependencies.orchestrator.start({ accountEmail: 'user@example.invalid' })
    const busy = await app.inject({
      method: 'PUT',
      url: '/local-api/settings/mailbox-trust',
      headers: writeHeaders(cookie),
      payload: { customPathOrigins: [] },
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ error: { code: 'MAILBOX_SETTINGS_BUSY' } })
    expect(dependencies.mailboxSettings.updateSettings).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('serves a current authorization URL only to the local session and never via task history or SSE', async () => {
    const { app } = setup()
    expect(
      (await app.inject({ method: 'GET', url: '/local-api/tasks/task-api-1/authorization-url' })).statusCode,
    ).toBe(401)

    const cookie = await bootstrap(app)
    const authorization = await app.inject({
      method: 'GET',
      url: '/local-api/tasks/task-api-1/authorization-url',
      headers: { cookie },
    })
    expect(authorization.statusCode).toBe(200)
    expect(authorization.json()).toEqual({ authUrl: generatedAuthUrl })

    const history = await app.inject({ method: 'GET', url: '/local-api/tasks', headers: { cookie } })
    const events = await app.inject({
      method: 'GET',
      url: '/local-api/tasks/task-api-1/events?once=1',
      headers: { cookie },
    })
    expect(history.body).not.toContain(generatedAuthUrl)
    expect(events.body).not.toContain(generatedAuthUrl)

    const unavailable = await app.inject({
      method: 'GET',
      url: '/local-api/tasks/missing-task/authorization-url',
      headers: { cookie },
    })
    expect(unavailable.statusCode).toBe(404)
    expect(unavailable.json()).toMatchObject({ error: { code: 'TASK_AUTHORIZATION_URL_UNAVAILABLE' } })
    await app.close()
  })

  it('supports password and TOTP login, retires the token route, and never returns submitted credentials', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const pending = await app.inject({
      method: 'POST',
      url: '/local-api/session/login',
      headers: writeHeaders(cookie),
      payload: { email: 'totp@example.invalid', password: 'synthetic-password' },
    })
    expect(pending.statusCode).toBe(200)
    expect(pending.json()).toMatchObject({
      state: 'totp_required',
      attemptId: 'a'.repeat(43),
      maskedEmail: 't***@example.invalid',
    })
    expect(JSON.stringify(pending.json())).not.toMatch(/synthetic-password|temp_token|password/)

    const completed = await app.inject({
      method: 'POST',
      url: '/local-api/session/login-2fa',
      headers: writeHeaders(cookie),
      payload: { attemptId: 'a'.repeat(43), code: '012345' },
    })
    expect(completed.statusCode).toBe(200)
    expect(completed.json()).toMatchObject({ session: { authenticated: true } })
    expect(JSON.stringify(completed.json())).not.toContain('012345')
    expect(dependencies.session.completeTotp).toHaveBeenCalledWith('a'.repeat(43), '012345')

    const retired = await app.inject({
      method: 'POST',
      url: '/local-api/session/token',
      headers: writeHeaders(cookie),
      payload: { tokenType: 'refresh', token: 'synthetic-token' },
    })
    expect(retired.statusCode).toBe(404)
    await app.close()
  })

  it('rejects malformed password and TOTP bodies before passing them to the session manager', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const invalidLoginBodies = [
      { email: 'not-an-email', password: 'synthetic-password' },
      { email: 'admin@example.invalid', password: '' },
      { email: 'admin@example.invalid', password: 'synthetic-password', extra: true },
    ]

    for (const payload of invalidLoginBodies) {
      const response = await app.inject({
        method: 'POST',
        url: '/local-api/session/login',
        headers: writeHeaders(cookie),
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'INPUT_INVALID' } })
    }
    expect(dependencies.session.login).not.toHaveBeenCalled()

    for (const payload of [
      { attemptId: 'short', code: '012345' },
      { attemptId: 'a'.repeat(43), code: '12345a' },
      { attemptId: 'a'.repeat(43), code: '012345', extra: true },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/local-api/session/login-2fa',
        headers: writeHeaders(cookie),
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'INPUT_INVALID' } })
    }
    expect(dependencies.session.completeTotp).not.toHaveBeenCalled()
    await app.close()
  })

  it('cancels a pending TOTP attempt through a protected write route', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)

    const response = await app.inject({
      method: 'DELETE',
      url: '/local-api/session/login-pending',
      headers: writeHeaders(cookie),
    })
    expect(response.statusCode).toBe(204)
    expect(dependencies.session.cancelPendingLogin).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('supports logout and option refresh without returning credentials', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const options = await app.inject({ method: 'GET', url: '/local-api/options', headers: { cookie } })
    expect(options.json()).toMatchObject({ version: 'v1' })
    const refreshed = await app.inject({
      method: 'POST',
      url: '/local-api/options/refresh',
      headers: writeHeaders(cookie),
    })
    expect(refreshed.statusCode).toBe(200)
    expect(dependencies.options.loadSnapshot).toHaveBeenCalledTimes(2)
    const logout = await app.inject({
      method: 'DELETE',
      url: '/local-api/session',
      headers: writeHeaders(cookie),
    })
    expect(logout.statusCode).toBe(204)
    await app.close()
  })

  it('pairs and disconnects the central provisioning agent without returning its token', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const initial = await app.inject({
      method: 'GET',
      url: '/local-api/provisioning-agent',
      headers: { cookie },
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toMatchObject({ paired: false })

    const paired = await app.inject({
      method: 'POST',
      url: '/local-api/provisioning-agent/pair',
      headers: writeHeaders(cookie),
      payload: {
        centralOrigin: 'http://192.168.50.218:3001',
        pairingCode: 'PAIR-CODE-1234',
        deviceName: 'Operator Mac',
      },
    })
    expect(paired.statusCode).toBe(201)
    expect(paired.json()).toMatchObject({ paired: true, deviceName: 'Operator Mac' })
    expect(JSON.stringify(paired.json())).not.toContain('deviceToken')
    expect(dependencies.provisioningAgent?.pair).toHaveBeenCalledTimes(1)

    const changed = await app.inject({
      method: 'PUT',
      url: '/local-api/provisioning-agent/origin',
      headers: writeHeaders(cookie),
      payload: { centralOrigin: 'http://192.168.50.207:3000' },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({
      paired: true,
      connected: true,
      centralOrigin: 'http://192.168.50.207:3000',
    })
    expect(dependencies.provisioningAgent?.changeOrigin).toHaveBeenCalledWith({
      centralOrigin: 'http://192.168.50.207:3000',
    })

    const disconnected = await app.inject({
      method: 'DELETE',
      url: '/local-api/provisioning-agent',
      headers: writeHeaders(cookie),
    })
    expect(disconnected.statusCode).toBe(204)
    expect(dependencies.provisioningAgent?.disconnect).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('validates task fields, enforces one active task, serves history, cancellation, and one-shot SSE', async () => {
    const { app } = setup()
    const cookie = await bootstrap(app)
    const validInput = {
      accountEmail: 'user@example.invalid',
      loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
      proxyChoice: { mode: 'none' },
      concurrency: 10,
      supplier: null,
      groupIds: [],
    }
    const unknown = await app.inject({
      method: 'POST',
      url: '/local-api/tasks',
      headers: writeHeaders(cookie),
      payload: { ...validInput, accountName: 'injected' },
    })
    expect(unknown.statusCode).toBe(400)

    const started = await app.inject({
      method: 'POST',
      url: '/local-api/tasks',
      headers: writeHeaders(cookie),
      payload: validInput,
    })
    expect(started.statusCode).toBe(202)
    expect(JSON.stringify(started.json())).not.toMatch(/mail-secret|access_token|refresh_token|id_token|oauth-code/)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/local-api/tasks',
          headers: writeHeaders(cookie),
          payload: { ...validInput, accountEmail: 'other@example.invalid' },
        })
      ).statusCode,
    ).toBe(409)

    expect((await app.inject({ method: 'GET', url: '/local-api/tasks/active', headers: { cookie } })).json()).toMatchObject({
      task: { id: 'task-api-1' },
    })
    expect((await app.inject({ method: 'GET', url: '/local-api/tasks', headers: { cookie } })).json()).toHaveLength(1)
    const events = await app.inject({
      method: 'GET',
      url: '/local-api/tasks/task-api-1/events?once=1',
      headers: { cookie },
    })
    expect(events.headers['content-type']).toContain('text/event-stream')
    expect(events.body).toContain('event: task')
    expect(events.body).not.toMatch(/mail-secret|access_token|refresh_token|id_token/)

    const cancelled = await app.inject({
      method: 'POST',
      url: '/local-api/tasks/task-api-1/cancel',
      headers: writeHeaders(cookie),
    })
    expect(cancelled.json()).toMatchObject({ stage: 'cancelled' })
    await app.close()
  })

  it('accepts strict password + TOTP material without returning either secret', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const payload = {
      accountEmail: 'user@example.invalid',
      loginMaterial: {
        kind: 'password_totp',
        password: '  synthetic account password  ',
        totpSecret: 'jbsw y3dp-ehpk3pxp',
      },
      proxyChoice: { mode: 'none' },
      concurrency: 10,
      supplier: null,
      groupIds: [],
    }

    const response = await app.inject({
      method: 'POST',
      url: '/local-api/tasks',
      headers: writeHeaders(cookie),
      payload,
    })

    expect(response.statusCode).toBe(202)
    expect(dependencies.orchestrator.start).toHaveBeenCalledWith(
      expect.objectContaining({
        loginMaterial: {
          kind: 'password_totp',
          password: '  synthetic account password  ',
          totpSecret: 'JBSWY3DPEHPK3PXP',
        },
      }),
    )
    expect(response.body).not.toMatch(/synthetic account password|JBSWY3DPEHPK3PXP/)
    await app.close()
  })

  it('rejects cross-mode and invalid 2FA task material before orchestration', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)
    const base = {
      accountEmail: 'user@example.invalid',
      proxyChoice: { mode: 'none' },
      concurrency: 10,
      supplier: null,
      groupIds: [],
    }
    for (const loginMaterial of [
      { kind: 'email_otp', mailboxAccess: 'mail-secret', password: 'unexpected' },
      { kind: 'password_totp', password: 'synthetic-password', totpSecret: 'invalid*secret' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/local-api/tasks',
        headers: writeHeaders(cookie),
        payload: { ...base, loginMaterial },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: { code: 'INPUT_INVALID', message: '请求参数无效。' } })
    }
    expect(dependencies.orchestrator.start).not.toHaveBeenCalled()
    await app.close()
  })

  it('lists sanitized reauthorization targets and starts only the strict reauthorization shape', async () => {
    const { app, dependencies } = setup()
    const cookie = await bootstrap(app)

    const list = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts?scope=error&search=user&page=1&pageSize=50&maxUsage7dPercent=37',
      headers: { cookie },
    })
    expect(list.statusCode).toBe(200)
    expect(dependencies.reauthorization.listAccounts).toHaveBeenCalledWith({
      search: 'user',
      page: 1,
      pageSize: 50,
      maxUsage7dPercent: 37,
    })

    const importedTimeList = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts?importedWithinDays=7',
      headers: { cookie },
    })
    expect(importedTimeList.statusCode).toBe(200)
    expect(dependencies.reauthorization.listAccounts).toHaveBeenLastCalledWith({
      search: '',
      page: 1,
      pageSize: 50,
      maxUsage7dPercent: 90,
      importedWithinDays: 7,
    })

    const allScope = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts?scope=all',
      headers: { cookie },
    })
    expect(allScope.statusCode).toBe(400)

    const detail = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts/71?maxUsage7dPercent=37',
      headers: { cookie },
    })
    expect(detail.json()).toMatchObject({ id: 71, email: 'user@example.invalid' })
    expect(dependencies.reauthorization.getAccount).toHaveBeenCalledWith(71, 37)

    const excluded = await app.inject({
      method: 'PUT',
      url: '/local-api/reauthorization/accounts/71/hosting-exclusion',
      headers: writeHeaders(cookie),
      payload: { excluded: true },
    })
    expect(excluded.statusCode).toBe(200)
    expect(excluded.json()).toEqual({ accountId: 71, excluded: true })
    expect(dependencies.reauthorization.setAccountHostingExcluded).toHaveBeenCalledWith(71, true)

    const disposition = await app.inject({
      method: 'PUT',
      url: '/local-api/reauthorization/accounts/71/disposition',
      headers: writeHeaders(cookie),
      payload: { note: '邮箱接码过期', excluded: true },
    })
    expect(disposition.statusCode).toBe(200)
    expect(disposition.json()).toMatchObject({
      id: 71,
      name: 'user@example.invalid（邮箱接码过期）',
      hostingNote: '邮箱接码过期',
      excludedFromHosting: true,
    })

    const bulkDisposition = await app.inject({
      method: 'PUT',
      url: '/local-api/reauthorization/accounts/disposition',
      headers: writeHeaders(cookie),
      payload: { accountIds: [71, 72, 71], note: '手机接码', excluded: true },
    })
    expect(bulkDisposition.statusCode).toBe(200)
    expect(dependencies.reauthorization.setBulkAccountDisposition).toHaveBeenCalledWith([71, 72], '手机接码', true)
    expect(bulkDisposition.json()).toMatchObject({ updated: [{ id: 71 }, { id: 72 }], failed: [] })

    const invalidThreshold = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts?maxUsage7dPercent=37.5',
      headers: { cookie },
    })
    expect(invalidThreshold.statusCode).toBe(400)

    const invalidImportedTime = await app.inject({
      method: 'GET',
      url: '/local-api/reauthorization/accounts?importedWithinDays=0',
      headers: { cookie },
    })
    expect(invalidImportedTime.statusCode).toBe(400)

    const invalid = await app.inject({
      method: 'POST',
      url: '/local-api/reauthorization/tasks',
      headers: writeHeaders(cookie),
      payload: {
        accountId: 71,
        accountEmail: 'user@example.invalid',
        maxUsage7dPercent: 90,
        loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
        concurrency: 10,
      },
    })
    expect(invalid.statusCode).toBe(400)

    const started = await app.inject({
      method: 'POST',
      url: '/local-api/reauthorization/tasks',
      headers: writeHeaders(cookie),
      payload: {
        accountId: 71,
        accountEmail: 'user@example.invalid',
        maxUsage7dPercent: 37,
        loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
      },
    })
    expect(started.statusCode).toBe(202)
    expect(started.json()).toMatchObject({
      selection: { operation: 'reauthorize', targetAccountId: 71, maxUsage7dPercent: 37 },
    })
    expect(started.body).not.toContain('mail-secret')
    expect(dependencies.reauthorization.startTask).toHaveBeenCalledOnce()
    expect(dependencies.reauthorization.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ maxUsage7dPercent: 37 }),
    )

    const hosting = await app.inject({
      method: 'POST',
      url: '/local-api/reauthorization/hosting',
      headers: writeHeaders(cookie),
      payload: { search: 'user', maxUsage7dPercent: 37, importedWithinDays: 7, proxyMode: 'none' },
    })
    expect(hosting.statusCode).toBe(202)
    expect(dependencies.reauthorization.startHosting).toHaveBeenCalledWith({
      search: 'user', maxUsage7dPercent: 37, importedWithinDays: 7, proxyMode: 'none',
    })
    const stopped = await app.inject({
      method: 'DELETE', url: '/local-api/reauthorization/hosting', headers: writeHeaders(cookie),
    })
    expect(stopped.statusCode).toBe(200)
    expect(dependencies.reauthorization.stopHosting).toHaveBeenCalledOnce()
    const skipped = await app.inject({
      method: 'POST', url: '/local-api/reauthorization/hosting/skip', headers: writeHeaders(cookie),
    })
    expect(skipped.statusCode).toBe(200)
    expect(skipped.json()).toMatchObject({ skipped: 1 })
    expect(dependencies.reauthorization.skipCurrentHosting).toHaveBeenCalledOnce()
    await app.close()
  })
})
