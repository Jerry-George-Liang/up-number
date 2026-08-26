import type { AccountResult } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type {
  BackendAccount,
  BackendAccountsApi,
  OpenAICredentials,
  OAuthCredentialsApplicationPayload,
} from '../backend/accounts'
import {
  assertReauthorizationEligible,
  buildOAuthCredentialsApplication,
  reauthorizationTargetEmail,
} from '../backend/accounts'

export interface ReauthorizationBackend {
  getReauthorizationTarget(id: number): Promise<BackendAccount>
  applyOAuthCredentials(
    id: number,
    payload: OAuthCredentialsApplicationPayload,
  ): Promise<BackendAccount>
  confirmAppliedCredentials(
    id: number,
    expected: OpenAICredentials,
  ): Promise<{ account: BackendAccount; matched: boolean }>
  updateAccountName?(id: number, name: string): Promise<BackendAccount>
  updateAccountNotes?(id: number, notes: string): Promise<BackendAccount>
}

export interface ReauthorizationTarget {
  account: BackendAccount
  email: string
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase()
}

function result(account: BackendAccount): AccountResult {
  return { id: account.id, name: account.name, status: account.status }
}

function isUncertainWriteError(error: unknown): boolean {
  if (!(error instanceof AppError)) return true
  if (['BACKEND_NETWORK_ERROR', 'BACKEND_REQUEST_TIMEOUT', 'BACKEND_TIMEOUT'].includes(error.code)) {
    return true
  }
  const backendStatus = error.details?.backendStatus
  return typeof backendStatus === 'number' && backendStatus >= 500
}

const MAILBOX_EXPIRED_NAME_SUFFIX = '（邮箱接码过期）'
const MAILBOX_ACCESS_EXPIRED_NAME_SUFFIX = '（邮箱接码失效）'
const PHONE_VERIFICATION_NAME_SUFFIX = '（手机接码）'
const MAILBOX_ACCESS_MISSING_NAME_SUFFIX = '（没有接码邮箱链接）'
const MANAGED_NAME_NOTES = ['邮箱接码过期', '邮箱接码失效', '手机接码', '号池没有', '没有接码邮箱链接'] as const

function stripManagedNameNote(name: string, previousNote = ''): string {
  let result = name.trimEnd()
  const notes = previousNote ? [previousNote, ...MANAGED_NAME_NOTES] : [...MANAGED_NAME_NOTES]
  let changed = true
  while (changed) {
    changed = false
    for (const note of notes) {
      const suffix = `（${note}）`
      if (result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length).trimEnd()
        changed = true
      }
    }
  }
  return result
}

export class AccountReauthorizer {
  constructor(private readonly backend: ReauthorizationBackend | BackendAccountsApi) {}

  async loadTarget(
    accountId: number,
    expectedEmail?: string,
    requireEligible = true,
    maxUsage7dPercent?: number,
  ): Promise<ReauthorizationTarget> {
    const account = await this.backend.getReauthorizationTarget(accountId)
    if (requireEligible) assertReauthorizationEligible(account, maxUsage7dPercent)
    const email = reauthorizationTargetEmail(account)
    if (expectedEmail && normalizedEmail(expectedEmail) !== email) {
      throw new AppError(
        'REAUTHORIZATION_TARGET_CHANGED',
        '所选账号的邮箱已经变化，请刷新账号列表后重新选择。',
        { statusCode: 409 },
      )
    }
    return { account, email }
  }

  assertOAuthEmail(target: ReauthorizationTarget, credentials: OpenAICredentials): void {
    if (!credentials.email || normalizedEmail(credentials.email) !== target.email) {
      throw new AppError(
        'OAUTH_ACCOUNT_EMAIL_MISMATCH',
        '本次 OpenAI 授权邮箱与所选后台账号不一致，未更新原账号。',
        { statusCode: 409 },
      )
    }
  }

  assertUnchanged(initial: ReauthorizationTarget, current: ReauthorizationTarget): void {
    if (initial.account.id !== current.account.id || initial.email !== current.email) {
      throw new AppError(
        'REAUTHORIZATION_TARGET_CHANGED',
        '所选账号在授权期间已经变化，未更新原账号。',
        { statusCode: 409 },
      )
    }
  }

  async markMailboxExpired(target: ReauthorizationTarget): Promise<AccountResult> {
    return this.appendNameSuffix(target, MAILBOX_EXPIRED_NAME_SUFFIX, '邮箱接码过期')
  }

  async markMailboxAccessExpired(target: ReauthorizationTarget): Promise<AccountResult> {
    return this.appendNameSuffix(target, MAILBOX_ACCESS_EXPIRED_NAME_SUFFIX, '邮箱接码失效')
  }

  async markPhoneVerification(target: ReauthorizationTarget): Promise<AccountResult> {
    return this.appendNameSuffix(target, PHONE_VERIFICATION_NAME_SUFFIX, '手机接码')
  }

  async markMailboxAccessMissing(target: ReauthorizationTarget): Promise<AccountResult> {
    return this.appendNameSuffix(target, MAILBOX_ACCESS_MISSING_NAME_SUFFIX, '没有接码邮箱链接')
  }

  async setManagedNameNote(target: ReauthorizationTarget, note: string, previousNote = ''): Promise<AccountResult> {
    const normalizedNote = note.trim()
    const current = await this.loadTarget(target.account.id, target.email, false)
    this.assertUnchanged(target, current)
    const baseName = stripManagedNameNote(current.account.name, previousNote)
    const expectedName = normalizedNote ? `${baseName}（${normalizedNote}）` : baseName
    if (current.account.name === expectedName) return result(current.account)
    return this.updateName(current, expectedName, normalizedNote || '备注')
  }

  async setManagementNote(target: ReauthorizationTarget, note: string): Promise<AccountResult> {
    const normalizedNote = note.trim()
    if (!normalizedNote || !this.backend.updateAccountNotes) return result(target.account)
    const current = await this.loadTarget(target.account.id, target.email, false)
    const existing = current.account.notes?.trim() ?? ''
    const parts = existing.split(/[;；\n]/).map((value) => value.trim()).filter(Boolean)
    if (parts.includes(normalizedNote)) return result(current.account)
    const notes = existing ? `${existing}；${normalizedNote}` : normalizedNote
    return result(await this.backend.updateAccountNotes(current.account.id, notes))
  }

  private async appendNameSuffix(
    target: ReauthorizationTarget,
    suffix: string,
    label: string,
  ): Promise<AccountResult> {
    const current = await this.loadTarget(target.account.id, target.email, false)
    this.assertUnchanged(target, current)
    const expectedName = `${stripManagedNameNote(current.account.name)}${suffix}`
    if (current.account.name === expectedName) return result(current.account)
    return this.updateName(current, expectedName, label)
  }

  private async updateName(
    current: ReauthorizationTarget,
    expectedName: string,
    label: string,
  ): Promise<AccountResult> {
    if (!this.backend.updateAccountName) {
      throw new AppError('ACCOUNT_NAME_NOTE_FAILED', `已检测到${label}，但后台账号名称无法更新。`, {
        statusCode: 502,
      })
    }

    try {
      const updated = await this.backend.updateAccountName(current.account.id, expectedName)
      if (updated.id === current.account.id && updated.name === expectedName) return result(updated)
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw new AppError('ACCOUNT_NAME_NOTE_FAILED', `已检测到${label}，但后台拒绝更新账号名称。`, {
          statusCode: error instanceof AppError ? error.statusCode : 502,
          cause: error,
        })
      }
    }

    try {
      const confirmed = await this.loadTarget(current.account.id, current.email, false)
      this.assertUnchanged(current, confirmed)
      if (confirmed.account.name === expectedName) return result(confirmed.account)
    } catch {
      // The single write remains uncertain and must not be replayed.
    }
    throw new AppError(
      'ACCOUNT_NAME_NOTE_UNCERTAIN',
      `已检测到${label}，但无法确认后台账号名称是否已更新，请到后台核对。`,
      { statusCode: 502 },
    )
  }

  async applyAndConfirm(
    target: ReauthorizationTarget,
    credentials: OpenAICredentials,
    onUncertain: () => void,
    onApplied: () => void,
  ): Promise<AccountResult> {
    let applied: BackendAccount
    try {
      applied = await this.backend.applyOAuthCredentials(
        target.account.id,
        buildOAuthCredentialsApplication(credentials),
      )
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw new AppError(
          'ACCOUNT_REAUTHORIZATION_FAILED',
          '后台拒绝更新该账号的 OAuth 凭据。',
          { statusCode: error instanceof AppError ? error.statusCode : 502, cause: error },
        )
      }
      onUncertain()
      try {
        const confirmation = await this.backend.confirmAppliedCredentials(target.account.id, credentials)
        if (confirmation.account.platform?.toLowerCase() !== 'openai' || confirmation.account.type?.toLowerCase() !== 'oauth') {
          throw new AppError('REAUTHORIZATION_TARGET_INVALID', '后台确认的账号不是 OpenAI OAuth 账号。', { statusCode: 409 })
        }
        const confirmed = {
          account: confirmation.account,
          email: reauthorizationTargetEmail(confirmation.account),
        }
        this.assertUnchanged(target, confirmed)
        if (confirmation.account.id === target.account.id && confirmation.matched) {
          return result(confirmed.account)
        }
      } catch {
        // The original write remains uncertain. Never replay it.
      }
      throw new AppError(
        'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
        '无法确认后台是否已更新该账号，已禁止自动重试，请到后台核对。',
        { statusCode: 502 },
      )
    }

    if (applied.id !== target.account.id) {
      onUncertain()
      throw new AppError(
        'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
        '后台返回的账号与重新授权目标不一致，请到后台核对。',
        { statusCode: 502 },
      )
    }
    onApplied()
    try {
      const confirmed = await this.loadTarget(target.account.id, target.email, false)
      this.assertUnchanged(target, confirmed)
      return result(confirmed.account)
    } catch {
      return result(applied)
    }
  }
}
