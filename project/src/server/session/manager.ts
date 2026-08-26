import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '../../shared/errors'
import type {
  BackendAuthApi,
  BackendLoginTokens,
  BackendUser,
} from '../backend/auth'
import {
  decodeBackendCredential,
  encodeBackendCredential,
  type CredentialStore,
  type StoredBackendCredentialMode,
} from './keychain'

const CREDENTIAL_ACCOUNT_SETTING = 'backend_credential_account'
const LEGACY_ACCOUNT_SETTING = 'backend_account_email'

export interface SessionIdentityStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

export interface PublicSession {
  authenticated: boolean
  email: string | null
  user: Pick<BackendUser, 'id' | 'email' | 'username' | 'role' | 'is_admin' | 'permissions'> | null
}

export type PasswordLoginResult =
  | { state: 'authenticated'; session: PublicSession }
  | {
      state: 'totp_required'
      attemptId: string
      maskedEmail: string | null
      expiresAt: string
    }

interface PendingTotpLogin {
  attemptId: string
  tempToken: string
  maskedEmail: string | null
  expiresAt: number
}

const TOTP_ATTEMPT_TTL_MS = 5 * 60 * 1000

function isUnauthorized(error: unknown): boolean {
  return error instanceof AppError && error.code === 'BACKEND_UNAUTHORIZED'
}

function identityLabel(user: BackendUser): string | null {
  return user.email ?? user.username ?? null
}

function credentialAccount(user: BackendUser): string {
  return `backend-user:${user.id}`
}

export class SessionManager {
  #accessToken: string | null = null
  #refreshToken: string | null = null
  #expiresAt = 0
  #user: BackendUser | null = null
  #credentialMode: StoredBackendCredentialMode | null = null
  #credentialAccount: string | null = null
  #refreshPromise: Promise<string> | null = null
  #pendingTotp: PendingTotpLogin | null = null
  #loginInProgress = false
  #restorePromise: Promise<PublicSession> | null = null

  constructor(
    private readonly auth: BackendAuthApi,
    private readonly credentials: CredentialStore,
    private readonly identityStore: SessionIdentityStore,
  ) {}

  restore(): Promise<PublicSession> {
    this.#restorePromise ??= this.restoreSavedCredential()
    return this.#restorePromise
  }

  async ready(): Promise<void> {
    await this.#restorePromise
  }

  private async restoreSavedCredential(): Promise<PublicSession> {
    const currentAccount = this.identityStore.getSetting(CREDENTIAL_ACCOUNT_SETTING)
    const legacyAccount = this.identityStore.getSetting(LEGACY_ACCOUNT_SETTING)
    const candidates = [
      ...(currentAccount ? [{ account: currentAccount, setting: CREDENTIAL_ACCOUNT_SETTING }] : []),
      ...(legacyAccount && legacyAccount !== currentAccount
        ? [{ account: legacyAccount, setting: LEGACY_ACCOUNT_SETTING }]
        : []),
    ]

    for (const candidate of candidates) {
      const stored = await this.credentials.get(candidate.account)
      const decoded = stored ? decodeBackendCredential(stored) : null
      if (!decoded) {
        this.identityStore.deleteSetting(candidate.setting)
        if (stored) await this.credentials.delete(candidate.account)
        continue
      }
      try {
        await this.restoreCredential(decoded.credential.mode, decoded.credential.token)
        return this.publicSession()
      } catch (error) {
        this.resetMemory()
        if (!isUnauthorized(error)) return this.publicSession()
        this.identityStore.deleteSetting(candidate.setting)
        await this.credentials.delete(candidate.account)
      }
    }
    return this.publicSession()
  }

  async login(email: string, password: string): Promise<PasswordLoginResult> {
    await this.ready()
    this.assertLoginAvailable()
    this.#loginInProgress = true
    this.#pendingTotp = null
    try {
      const requirements = await this.auth.getPublicAuthRequirements()
      if (
        requirements.turnstileEnabled ||
        requirements.tencentCaptchaEnabled ||
        requirements.aliyunCaptchaEnabled ||
        requirements.loginAgreementEnabled
      ) {
        throw new AppError(
          'BACKEND_INTERACTIVE_LOGIN_REQUIRED',
          '后台当前要求交互验证或登录协议确认，请先在后台完成后再重试。',
          { statusCode: 409 },
        )
      }

      let result
      try {
        result = await this.auth.login(email, password)
      } catch (error) {
        if (isUnauthorized(error)) {
          throw new AppError('BACKEND_LOGIN_INVALID', '后台账号或密码错误。', {
            statusCode: 401,
            cause: error,
          })
        }
        throw error
      }

      if ('requires_2fa' in result) {
        const attemptId = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + TOTP_ATTEMPT_TTL_MS
        this.#pendingTotp = {
          attemptId,
          tempToken: result.temp_token,
          maskedEmail: result.user_email_masked ?? null,
          expiresAt,
        }
        return {
          state: 'totp_required',
          attemptId,
          maskedEmail: this.#pendingTotp.maskedEmail,
          expiresAt: new Date(expiresAt).toISOString(),
        }
      }

      await this.activateLoginTokens(result)
      return { state: 'authenticated', session: this.publicSession() }
    } finally {
      this.#loginInProgress = false
    }
  }

  async completeTotp(attemptId: string, code: string): Promise<PublicSession> {
    await this.ready()
    this.assertLoginAvailable()
    const pending = this.requirePendingTotp(attemptId)
    this.#loginInProgress = true
    try {
      let tokens: BackendLoginTokens
      try {
        tokens = await this.auth.login2FA(pending.tempToken, code)
      } catch (error) {
        if (isUnauthorized(error)) {
          throw new AppError('BACKEND_TOTP_INVALID_OR_EXPIRED', '动态验证码错误或已经过期。', {
            statusCode: 401,
            cause: error,
          })
        }
        throw error
      }
      if (this.#pendingTotp !== pending) {
        throw new AppError('BACKEND_TOTP_ATTEMPT_EXPIRED', '二次验证已取消，请重新登录。', {
          statusCode: 401,
        })
      }
      this.#pendingTotp = null
      await this.activateLoginTokens(tokens)
      return this.publicSession()
    } finally {
      this.#loginInProgress = false
    }
  }

  cancelPendingLogin(): void {
    this.#pendingTotp = null
  }

  private assertLoginAvailable(): void {
    if (this.#loginInProgress) {
      throw new AppError('LOGIN_IN_PROGRESS', '后台登录请求正在处理中。', { statusCode: 409 })
    }
  }

  private requirePendingTotp(attemptId: string): PendingTotpLogin {
    const pending = this.#pendingTotp
    if (!pending || pending.expiresAt <= Date.now()) {
      this.#pendingTotp = null
      throw new AppError('BACKEND_TOTP_ATTEMPT_EXPIRED', '二次验证已过期，请重新登录。', { statusCode: 401 })
    }
    const submitted = Buffer.from(attemptId)
    const expected = Buffer.from(pending.attemptId)
    if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) {
      throw new AppError('BACKEND_TOTP_ATTEMPT_INVALID', '二次验证请求无效。', { statusCode: 401 })
    }
    return pending
  }

  private async activateLoginTokens(tokens: BackendLoginTokens): Promise<void> {
    await this.saveAndActivate({
      mode: 'refresh',
      token: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      user: tokens.user,
    })
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.#credentialMode === 'access') {
      if (!forceRefresh && this.#accessToken) return this.#accessToken
      await this.clear()
      throw new AppError('SESSION_EXPIRED', '后台会话已失效，请重新登录。', { statusCode: 401 })
    }
    if (!forceRefresh && this.#accessToken && this.#expiresAt > Date.now() + 30_000) return this.#accessToken
    if (this.#credentialMode !== 'refresh' || !this.#refreshToken) {
      throw new AppError('SESSION_EXPIRED', '后台会话已失效，请重新连接。', { statusCode: 401 })
    }
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.refreshAccessToken().finally(() => {
        this.#refreshPromise = null
      })
    }
    return this.#refreshPromise
  }

  async logout(): Promise<void> {
    const refreshToken = this.#credentialMode === 'refresh' ? this.#refreshToken : null
    try {
      if (refreshToken) await this.auth.logout(refreshToken)
    } finally {
      await this.clear()
    }
  }

  publicSession(): PublicSession {
    return {
      authenticated: Boolean(this.#accessToken && this.#user),
      email: this.#user ? identityLabel(this.#user) : null,
      user: this.#user
        ? {
            id: this.#user.id,
            email: this.#user.email,
            username: this.#user.username,
            role: this.#user.role,
            is_admin: this.#user.is_admin,
            permissions: this.#user.permissions,
          }
        : null,
    }
  }

  private async restoreCredential(mode: StoredBackendCredentialMode, token: string): Promise<void> {
    if (mode === 'access') {
      const user = await this.auth.me(token)
      await this.saveAndActivate({
        mode,
        token,
        accessToken: token,
        expiresAt: Number.POSITIVE_INFINITY,
        user,
      })
      return
    }
    const tokens = await this.auth.refresh(token)
    const user = tokens.user ?? (await this.auth.me(tokens.access_token))
    const refreshToken = tokens.refresh_token ?? token
    await this.saveAndActivate({
      mode,
      token: refreshToken,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      user,
    })
  }

  private async saveAndActivate(input: {
    mode: StoredBackendCredentialMode
    token: string
    accessToken: string
    expiresAt: number
    user: BackendUser
  }): Promise<void> {
    const account = credentialAccount(input.user)
    const previousAccounts = new Set(
      [
        this.#credentialAccount,
        this.identityStore.getSetting(CREDENTIAL_ACCOUNT_SETTING),
        this.identityStore.getSetting(LEGACY_ACCOUNT_SETTING),
      ].filter((value): value is string => Boolean(value)),
    )

    await this.credentials.set(
      account,
      encodeBackendCredential({ version: 1, mode: input.mode, token: input.token }),
    )
    this.identityStore.setSetting(CREDENTIAL_ACCOUNT_SETTING, account)
    this.identityStore.deleteSetting(LEGACY_ACCOUNT_SETTING)

    this.#credentialAccount = account
    this.#credentialMode = input.mode
    this.#accessToken = input.accessToken
    this.#refreshToken = input.mode === 'refresh' ? input.token : null
    this.#expiresAt = input.expiresAt
    this.#user = input.user

    for (const previousAccount of previousAccounts) {
      if (previousAccount !== account) await this.credentials.delete(previousAccount)
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const refreshToken = this.#refreshToken
    const account = this.#credentialAccount
    if (this.#credentialMode !== 'refresh' || !refreshToken || !account) {
      throw new AppError('SESSION_EXPIRED', '后台会话已失效，请重新连接。')
    }
    try {
      const tokens = await this.auth.refresh(refreshToken)
      this.#accessToken = tokens.access_token
      this.#refreshToken = tokens.refresh_token ?? refreshToken
      this.#expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
      if (tokens.user) this.#user = tokens.user
      if (this.#refreshToken !== refreshToken) {
        await this.credentials.set(
          account,
          encodeBackendCredential({ version: 1, mode: 'refresh', token: this.#refreshToken }),
        )
      }
      return tokens.access_token
    } catch (error) {
      await this.clear()
      throw new AppError('SESSION_EXPIRED', '后台会话已失效，请重新连接。', {
        statusCode: 401,
        cause: error,
      })
    }
  }

  private async clear(): Promise<void> {
    const accounts = new Set(
      [
        this.#credentialAccount,
        this.identityStore.getSetting(CREDENTIAL_ACCOUNT_SETTING),
        this.identityStore.getSetting(LEGACY_ACCOUNT_SETTING),
      ].filter((value): value is string => Boolean(value)),
    )
    for (const account of accounts) await this.credentials.delete(account)
    this.identityStore.deleteSetting(CREDENTIAL_ACCOUNT_SETTING)
    this.identityStore.deleteSetting(LEGACY_ACCOUNT_SETTING)
    this.resetMemory()
  }

  private resetMemory(): void {
    this.#accessToken = null
    this.#refreshToken = null
    this.#expiresAt = 0
    this.#user = null
    this.#credentialMode = null
    this.#credentialAccount = null
    this.#refreshPromise = null
    this.#pendingTotp = null
    this.#loginInProgress = false
  }
}
