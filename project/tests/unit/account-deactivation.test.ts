import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/shared/errors'
import type { BackendAccount } from '../../src/server/backend/accounts'
import {
  AccountDeactivationManager,
  type AccountDeactivationBackend,
} from '../../src/server/tasks/account-deactivation'

function account(overrides: Partial<BackendAccount> = {}): BackendAccount {
  return {
    id: 71,
    name: 'user@example.invalid',
    status: 'error',
    platform: 'openai',
    type: 'oauth',
    credentialEmail: 'user@example.invalid',
    extraEmail: 'user@example.invalid',
    ...overrides,
  }
}

function backend(overrides: Partial<AccountDeactivationBackend> = {}): AccountDeactivationBackend {
  return {
    findAccounts: vi.fn(async () => []),
    getAccount: vi
      .fn()
      .mockResolvedValueOnce(account())
      .mockResolvedValue(account({ managementStatus: 'banned' })),
    updateManagementStatus: vi.fn(async () => account({ managementStatus: 'banned' })),
    ...overrides,
  }
}

describe('AccountDeactivationManager', () => {
  it('requires one strict OpenAI OAuth email match for add-account tasks', async () => {
    const api = backend({
      findAccounts: vi.fn(async () => [
        account({ id: 70, name: 'fuzzy user', credentialEmail: 'other@example.invalid', extraEmail: 'other@example.invalid' }),
        account({ id: 71 }),
        account({ id: 72, platform: 'anthropic' }),
      ]),
    })
    await expect(new AccountDeactivationManager(api).locateCreateTarget(' USER@EXAMPLE.INVALID ')).resolves.toEqual({
      kind: 'unique',
      account: account({ id: 71 }),
    })
  })

  it('distinguishes zero and multiple exact matches without guessing', async () => {
    const none = new AccountDeactivationManager(backend())
    await expect(none.locateCreateTarget('user@example.invalid')).resolves.toEqual({
      kind: 'no_matching_account',
    })

    const multiple = new AccountDeactivationManager(
      backend({ findAccounts: vi.fn(async () => [account({ id: 71 }), account({ id: 72 })]) }),
    )
    await expect(multiple.locateCreateTarget('user@example.invalid')).resolves.toEqual({
      kind: 'ambiguous_match',
    })
  })

  it('does not write when the exact target is already banned', async () => {
    const api = backend({ getAccount: vi.fn(async () => account({ managementStatus: 'banned' })) })
    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).resolves.toEqual({
      kind: 'already_banned',
      account: { id: 71, name: 'user@example.invalid', status: 'banned' },
    })
    expect(api.updateManagementStatus).not.toHaveBeenCalled()
  })

  it('writes banned once with a fixed non-secret reason', async () => {
    const api = backend()
    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).resolves.toEqual({
      kind: 'banned',
      account: { id: 71, name: 'user@example.invalid', status: 'banned' },
    })
    expect(api.updateManagementStatus).toHaveBeenCalledWith(
      71,
      'banned',
      'OpenAI OAuth 连续 2 次返回 account_deactivated',
    )
    expect(api.updateManagementStatus).toHaveBeenCalledTimes(1)
    expect(api.getAccount).toHaveBeenCalledTimes(2)
  })

  it('does not trust a successful PUT response without a confirming GET', async () => {
    const api = backend({ getAccount: vi.fn(async () => account()) })

    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).rejects.toMatchObject({
      code: 'ACCOUNT_BAN_WRITE_UNCERTAIN',
    })
    expect(api.updateManagementStatus).toHaveBeenCalledTimes(1)
    expect(api.getAccount).toHaveBeenCalledTimes(2)
  })

  it('confirms an uncertain write with GET and never replays it', async () => {
    const api = backend({
      getAccount: vi
        .fn()
        .mockResolvedValueOnce(account())
        .mockResolvedValueOnce(account({ managementStatus: 'banned' })),
      updateManagementStatus: vi.fn(async () => {
        throw new AppError('BACKEND_NETWORK_ERROR', 'network', { statusCode: 502 })
      }),
    })
    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).resolves.toMatchObject({
      kind: 'banned',
    })
    expect(api.updateManagementStatus).toHaveBeenCalledTimes(1)
    expect(api.getAccount).toHaveBeenCalledTimes(2)
  })

  it('reports an unconfirmed write without replaying it', async () => {
    const api = backend({
      getAccount: vi.fn(async () => account()),
      updateManagementStatus: vi.fn(async () => {
        throw new AppError('BACKEND_TIMEOUT', 'timeout', { statusCode: 504 })
      }),
    })
    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).rejects.toMatchObject({
      code: 'ACCOUNT_BAN_WRITE_UNCERTAIN',
    })
    expect(api.updateManagementStatus).toHaveBeenCalledTimes(1)
    expect(api.getAccount).toHaveBeenCalledTimes(2)
  })

  it('does not convert a deterministic rejection into a second write', async () => {
    const api = backend({
      updateManagementStatus: vi.fn(async () => {
        throw new AppError('BACKEND_REJECTED', 'rejected', {
          statusCode: 409,
          details: { backendStatus: 409 },
        })
      }),
    })
    await expect(new AccountDeactivationManager(api).markBanned(71, 'user@example.invalid')).rejects.toMatchObject({
      code: 'ACCOUNT_BAN_WRITE_REJECTED',
    })
    expect(api.updateManagementStatus).toHaveBeenCalledTimes(1)
    expect(api.getAccount).toHaveBeenCalledTimes(1)
  })
})
