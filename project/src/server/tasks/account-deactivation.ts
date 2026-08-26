import type { AccountResult } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type { BackendAccount, BackendAccountsApi } from '../backend/accounts'
import { reauthorizationTargetEmail } from '../backend/accounts'

function deactivationStatusReason(confirmationAttempts: number): string {
  return `OpenAI OAuth 连续 ${confirmationAttempts} 次返回 account_deactivated`
}

export type CreateDeactivationTarget =
  | { kind: 'unique'; account: BackendAccount }
  | { kind: 'no_matching_account' }
  | { kind: 'ambiguous_match' }

export type AccountBanOutcome = {
  kind: 'banned' | 'already_banned'
  account: AccountResult
}

export interface AccountDeactivationBackend {
  findAccounts(email: string): Promise<BackendAccount[]>
  getAccount(id: number): Promise<BackendAccount>
  updateManagementStatus(
    id: number,
    managementStatus: 'banned',
    statusReason: string,
  ): Promise<BackendAccount>
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isBanned(account: BackendAccount): boolean {
  return (account.managementStatus ?? account.status).trim().toLowerCase() === 'banned'
}

function bannedResult(account: BackendAccount): AccountResult {
  return { id: account.id, name: account.name, status: 'banned' }
}

function assertTargetIdentity(account: BackendAccount, id: number, expectedEmail: string): void {
  if (account.id !== id || reauthorizationTargetEmail(account) !== normalizedEmail(expectedEmail)) {
    throw new AppError(
      'ACCOUNT_BAN_TARGET_CHANGED',
      '待封号账号的编号或邮箱已经变化，未修改后台状态。',
      { statusCode: 409 },
    )
  }
}

function isUncertainWriteError(error: unknown): boolean {
  if (!(error instanceof AppError)) return true
  if (['BACKEND_NETWORK_ERROR', 'BACKEND_REQUEST_TIMEOUT', 'BACKEND_TIMEOUT'].includes(error.code)) {
    return true
  }
  const backendStatus = error.details?.backendStatus
  return typeof backendStatus === 'number' && backendStatus >= 500
}

export class AccountDeactivationManager {
  constructor(private readonly backend: AccountDeactivationBackend | BackendAccountsApi) {}

  async locateCreateTarget(email: string): Promise<CreateDeactivationTarget> {
    const expected = normalizedEmail(email)
    const candidates = await this.backend.findAccounts(expected)
    const exact = new Map<number, BackendAccount>()
    for (const candidate of candidates) {
      try {
        if (reauthorizationTargetEmail(candidate) === expected) exact.set(candidate.id, candidate)
      } catch {
        // Fuzzy, incomplete, non-OpenAI, and internally inconsistent results are never ban targets.
      }
    }
    if (exact.size === 0) return { kind: 'no_matching_account' }
    if (exact.size !== 1) return { kind: 'ambiguous_match' }
    return { kind: 'unique', account: [...exact.values()][0]! }
  }

  async markBanned(
    accountId: number,
    expectedEmail: string,
    confirmationAttempts = 2,
  ): Promise<AccountBanOutcome> {
    const before = await this.backend.getAccount(accountId)
    assertTargetIdentity(before, accountId, expectedEmail)
    if (isBanned(before)) return { kind: 'already_banned', account: bannedResult(before) }

    try {
      const updated = await this.backend.updateManagementStatus(
        accountId,
        'banned',
        deactivationStatusReason(confirmationAttempts),
      )
      assertTargetIdentity(updated, accountId, expectedEmail)
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw new AppError(
          'ACCOUNT_BAN_WRITE_REJECTED',
          '后台拒绝将该账号标记为封号。',
          { statusCode: error instanceof AppError ? error.statusCode : 502, cause: error },
        )
      }
      return this.confirmWrite(accountId, expectedEmail)
    }

    // The PUT response is not authoritative. A separate GET is required before reporting success.
    return this.confirmWrite(accountId, expectedEmail)
  }

  private async confirmWrite(
    accountId: number,
    expectedEmail: string,
  ): Promise<AccountBanOutcome> {
    try {
      const confirmed = await this.backend.getAccount(accountId)
      assertTargetIdentity(confirmed, accountId, expectedEmail)
      if (isBanned(confirmed)) return { kind: 'banned', account: bannedResult(confirmed) }
    } catch {
      // The original status write remains uncertain. Never replay it.
    }
    throw new AppError(
      'ACCOUNT_BAN_WRITE_UNCERTAIN',
      '无法确认后台是否已将账号标记为封号，已禁止自动重试，请到后台核对。',
      { statusCode: 502 },
    )
  }
}
