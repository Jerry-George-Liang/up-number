import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BackendAuthApi,
  BackendLoginResult,
  BackendLoginTokens,
  BackendTokens,
  BackendUser,
  PublicAuthRequirements,
} from '../../src/server/backend/auth'
import { AppError } from '../../src/shared/errors'
import { SessionManager, type SessionIdentityStore } from '../../src/server/session/manager'
import {
  decodeBackendCredential,
  encodeBackendCredential,
  MemoryCredentialStore,
} from '../../src/server/session/keychain'

class MemoryIdentityStore implements SessionIdentityStore {
  values = new Map<string, string>()
  getSetting(key: string) {
    return this.values.get(key) ?? null
  }
  setSetting(key: string, value: string) {
    this.values.set(key, value)
  }
  deleteSetting(key: string) {
    this.values.delete(key)
  }
}

class MockAuthApi {
  requirements: PublicAuthRequirements = {
    turnstileEnabled: false,
    tencentCaptchaEnabled: false,
    aliyunCaptchaEnabled: false,
    loginAgreementEnabled: false,
  }
  loginCalls: Array<{ email: string; password: string }> = []
  login2FACalls: Array<{ tempToken: string; code: string }> = []
  refreshCalls: string[] = []
  meCalls: string[] = []
  logoutCalls: string[] = []
  refreshResults: BackendTokens[] = [this.tokens('access-1', 'refresh-1')]
  refreshError: unknown = null
  meError: unknown = null
  refreshDelayMs = 0
  user: BackendUser = { id: 1, email: 'admin@example.invalid', role: 'admin', is_admin: true }
  loginResult: BackendLoginResult = this.tokens('access-login', 'refresh-login')
  login2FAResult: BackendLoginTokens = this.tokens('access-2fa', 'refresh-2fa')
  loginError: unknown = null
  login2FAError: unknown = null

  tokens(accessToken: string, refreshToken: string): BackendLoginTokens {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: this.user,
    }
  }

  async getPublicAuthRequirements(): Promise<PublicAuthRequirements> {
    return this.requirements
  }

  async login(email: string, password: string): Promise<BackendLoginResult> {
    this.loginCalls.push({ email, password })
    if (this.loginError) throw this.loginError
    return this.loginResult
  }

  async login2FA(tempToken: string, code: string): Promise<BackendTokens> {
    this.login2FACalls.push({ tempToken, code })
    if (this.login2FAError) throw this.login2FAError
    return this.login2FAResult
  }

  async refresh(token: string): Promise<BackendTokens> {
    this.refreshCalls.push(token)
    if (this.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs))
    if (this.refreshError) throw this.refreshError
    return this.refreshResults.shift() ?? this.tokens('access-refreshed', 'refresh-rotated')
  }

  async me(token: string): Promise<BackendUser> {
    this.meCalls.push(token)
    if (this.meError) throw this.meError
    return this.user
  }

  async logout(token: string): Promise<void> {
    this.logoutCalls.push(token)
  }
}

function createManager(auth = new MockAuthApi()) {
  const credentials = new MemoryCredentialStore()
  const identity = new MemoryIdentityStore()
  const manager = new SessionManager(auth as unknown as BackendAuthApi, credentials, identity)
  return { auth, credentials, identity, manager }
}

function storedCredential(credentials: MemoryCredentialStore, account = 'backend-user:1') {
  const value = credentials.values.get(account)
  expect(value).toBeTruthy()
  return decodeBackendCredential(value!)?.credential
}

describe('SessionManager', () => {
  afterEach(() => vi.useRealTimers())

  it('logs in with a password and stores only the returned refresh credential', async () => {
    const { auth, credentials, identity, manager } = createManager()
    const result = await manager.login('admin@example.invalid', 'synthetic-password')

    expect(auth.loginCalls).toEqual([{ email: 'admin@example.invalid', password: 'synthetic-password' }])
    expect(result).toMatchObject({
      state: 'authenticated',
      session: { authenticated: true, email: 'admin@example.invalid' },
    })
    expect(storedCredential(credentials)).toEqual({ version: 1, mode: 'refresh', token: 'refresh-login' })
    expect(identity.getSetting('backend_credential_account')).toBe('backend-user:1')
    expect(identity.getSetting('backend_account_email')).toBeNull()
    expect(JSON.stringify(result)).not.toMatch(/access-login|refresh-login|synthetic-password/)
  })

  it('keeps the backend TOTP token in memory and exposes only an opaque local attempt', async () => {
    const { auth, credentials, manager } = createManager()
    auth.loginResult = {
      requires_2fa: true,
      temp_token: 'backend-temporary-token',
      user_email_masked: 'a***@example.invalid',
    }

    const pending = await manager.login('admin@example.invalid', 'synthetic-password')
    expect(pending).toMatchObject({
      state: 'totp_required',
      maskedEmail: 'a***@example.invalid',
    })
    expect(pending.state === 'totp_required' ? pending.attemptId : '').toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(pending)).not.toContain('backend-temporary-token')
    expect(credentials.values.size).toBe(0)

    const completed = await manager.completeTotp(
      pending.state === 'totp_required' ? pending.attemptId : '',
      '012345',
    )
    expect(auth.login2FACalls).toEqual([{ tempToken: 'backend-temporary-token', code: '012345' }])
    expect(completed).toMatchObject({ authenticated: true, email: 'admin@example.invalid' })
    expect(storedCredential(credentials)).toEqual({ version: 1, mode: 'refresh', token: 'refresh-2fa' })
  })

  it('classifies invalid credentials and invalid TOTP without storing secrets', async () => {
    const credentialsLogin = createManager()
    credentialsLogin.auth.loginError = new AppError('BACKEND_UNAUTHORIZED', 'raw backend message', { statusCode: 401 })
    await expect(credentialsLogin.manager.login('admin@example.invalid', 'wrong-password')).rejects.toMatchObject({
      code: 'BACKEND_LOGIN_INVALID',
    })
    expect(credentialsLogin.credentials.values.size).toBe(0)

    const totp = createManager()
    totp.auth.loginResult = { requires_2fa: true, temp_token: 'temporary-token' }
    const pending = await totp.manager.login('admin@example.invalid', 'synthetic-password')
    totp.auth.login2FAError = new AppError('BACKEND_UNAUTHORIZED', 'raw TOTP message', { statusCode: 401 })
    await expect(
      totp.manager.completeTotp(pending.state === 'totp_required' ? pending.attemptId : '', '999999'),
    ).rejects.toMatchObject({
      code: 'BACKEND_TOTP_INVALID_OR_EXPIRED',
    })
    expect(totp.credentials.values.size).toBe(0)
  })

  it('rejects interactive login requirements before sending the password', async () => {
    const { auth, credentials, manager } = createManager()
    auth.requirements.turnstileEnabled = true

    await expect(manager.login('admin@example.invalid', 'synthetic-password')).rejects.toMatchObject({
      code: 'BACKEND_INTERACTIVE_LOGIN_REQUIRED',
    })
    expect(auth.loginCalls).toEqual([])
    expect(credentials.values.size).toBe(0)
  })

  it('rejects forged, cancelled, and expired TOTP attempts without calling the backend', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T05:00:00.000Z'))
    const forged = createManager()
    forged.auth.loginResult = { requires_2fa: true, temp_token: 'temporary-token' }
    const pending = await forged.manager.login('admin@example.invalid', 'synthetic-password')
    const attemptId = pending.state === 'totp_required' ? pending.attemptId : ''

    await expect(forged.manager.completeTotp('b'.repeat(43), '012345')).rejects.toMatchObject({
      code: 'BACKEND_TOTP_ATTEMPT_INVALID',
    })
    expect(forged.auth.login2FACalls).toEqual([])

    forged.manager.cancelPendingLogin()
    await expect(forged.manager.completeTotp(attemptId, '012345')).rejects.toMatchObject({
      code: 'BACKEND_TOTP_ATTEMPT_EXPIRED',
    })

    const expired = createManager()
    expired.auth.loginResult = { requires_2fa: true, temp_token: 'temporary-token' }
    const expiring = await expired.manager.login('admin@example.invalid', 'synthetic-password')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    await expect(
      expired.manager.completeTotp(expiring.state === 'totp_required' ? expiring.attemptId : '', '012345'),
    ).rejects.toMatchObject({ code: 'BACKEND_TOTP_ATTEMPT_EXPIRED' })
    expect(expired.auth.login2FACalls).toEqual([])
  })

  it('rejects a concurrent login while the first authentication request is in flight', async () => {
    const { auth, manager } = createManager()
    let releaseRequirements: (() => void) | undefined
    auth.getPublicAuthRequirements = vi.fn(
      () => new Promise<PublicAuthRequirements>((resolve) => {
        releaseRequirements = () => resolve(auth.requirements)
      }),
    )

    const first = manager.login('admin@example.invalid', 'synthetic-password')
    await expect(manager.login('second@example.invalid', 'synthetic-password')).rejects.toMatchObject({
      code: 'LOGIN_IN_PROGRESS',
    })
    releaseRequirements?.()
    await expect(first).resolves.toMatchObject({ state: 'authenticated' })
    expect(auth.loginCalls).toHaveLength(1)
  })

  it('does not activate a TOTP response after the pending attempt is cancelled', async () => {
    const { auth, credentials, manager } = createManager()
    auth.loginResult = { requires_2fa: true, temp_token: 'temporary-token' }
    const pending = await manager.login('admin@example.invalid', 'synthetic-password')
    let releaseTotp: (() => void) | undefined
    auth.login2FA = vi.fn(
      () => new Promise<BackendLoginTokens>((resolve) => {
        releaseTotp = () => resolve(auth.login2FAResult)
      }),
    )

    const completion = manager.completeTotp(
      pending.state === 'totp_required' ? pending.attemptId : '',
      '012345',
    )
    manager.cancelPendingLogin()
    releaseTotp?.()

    await expect(completion).rejects.toMatchObject({ code: 'BACKEND_TOTP_ATTEMPT_EXPIRED' })
    expect(manager.publicSession()).toMatchObject({ authenticated: false })
    expect(credentials.values.size).toBe(0)
  })

  it('coalesces concurrent refreshes and rotates the structured Keychain value', async () => {
    const { auth, credentials, manager } = createManager()
    auth.refreshResults = [auth.tokens('access-refreshed', 'refresh-rotated')]
    await manager.login('admin@example.invalid', 'synthetic-password')
    auth.refreshDelayMs = 5

    const [first, second] = await Promise.all([manager.getAccessToken(true), manager.getAccessToken(true)])
    expect(first).toBe('access-refreshed')
    expect(second).toBe('access-refreshed')
    expect(auth.refreshCalls).toEqual(['refresh-login'])
    expect(storedCredential(credentials)?.token).toBe('refresh-rotated')
  })

  it('restores a structured access token by validating it with the backend', async () => {
    const { auth, credentials, identity, manager } = createManager()
    credentials.values.set(
      'backend-user:1',
      encodeBackendCredential({ version: 1, mode: 'access', token: 'saved-access-token' }),
    )
    identity.setSetting('backend_credential_account', 'backend-user:1')

    await expect(manager.restore()).resolves.toMatchObject({ authenticated: true })
    expect(auth.meCalls).toEqual(['saved-access-token'])
  })

  it('migrates a legacy email-keyed raw refresh token only after successful validation', async () => {
    const { auth, credentials, identity, manager } = createManager()
    credentials.values.set('admin@example.invalid', 'legacy-refresh-token')
    identity.setSetting('backend_account_email', 'admin@example.invalid')

    await expect(manager.restore()).resolves.toMatchObject({ authenticated: true })
    expect(auth.refreshCalls).toEqual(['legacy-refresh-token'])
    expect(credentials.values.has('admin@example.invalid')).toBe(false)
    expect(storedCredential(credentials)).toEqual({ version: 1, mode: 'refresh', token: 'refresh-1' })
    expect(identity.getSetting('backend_credential_account')).toBe('backend-user:1')
    expect(identity.getSetting('backend_account_email')).toBeNull()
  })

  it('preserves a saved credential when restore fails because of a transient network error', async () => {
    const { auth, credentials, identity, manager } = createManager()
    const saved = encodeBackendCredential({ version: 1, mode: 'refresh', token: 'saved-refresh-token' })
    credentials.values.set('backend-user:1', saved)
    identity.setSetting('backend_credential_account', 'backend-user:1')
    auth.refreshError = new AppError('BACKEND_NETWORK_ERROR', 'network', { retryable: true })

    await expect(manager.restore()).resolves.toMatchObject({ authenticated: false })
    expect(credentials.values.get('backend-user:1')).toBe(saved)
    expect(identity.getSetting('backend_credential_account')).toBe('backend-user:1')
  })

  it('uses remote logout only for refresh mode and always clears local credentials', async () => {
    const refresh = createManager()
    await refresh.manager.login('admin@example.invalid', 'synthetic-password')
    await refresh.manager.logout()
    expect(refresh.auth.logoutCalls).toEqual(['refresh-login'])
    expect(refresh.credentials.values.size).toBe(0)

    const access = createManager()
    access.credentials.values.set(
      'backend-user:1',
      encodeBackendCredential({ version: 1, mode: 'access', token: 'saved-access-token' }),
    )
    access.identity.setSetting('backend_credential_account', 'backend-user:1')
    await access.manager.restore()
    await access.manager.logout()
    expect(access.auth.logoutCalls).toEqual([])
    expect(access.credentials.values.size).toBe(0)
  })
})
