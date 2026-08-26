import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/shared/errors'
import {
  AccountReauthorizer,
  type ReauthorizationTarget,
} from '../../src/server/tasks/account-reauthorizer'
import type { BackendAccount, OpenAICredentials } from '../../src/server/backend/accounts'

const credentials: OpenAICredentials = {
  access_token: 'new-access-token',
  refresh_token: 'new-refresh-token',
  email: 'user@example.invalid',
  expires_at: 1_800_000_000,
}

const target: ReauthorizationTarget = {
  account: {
    id: 71,
    name: 'user@example.invalid',
    status: 'error',
    platform: 'openai',
    type: 'oauth',
    credentialEmail: 'user@example.invalid',
    codex7dUsedPercent: 80,
  },
  email: 'user@example.invalid',
}

function account(overrides: Partial<BackendAccount> = {}): BackendAccount {
  return {
    id: 71,
    name: 'user@example.invalid',
    status: 'active',
    platform: 'openai',
    type: 'oauth',
    credentialEmail: 'user@example.invalid',
    codex7dUsedPercent: 80,
    ...overrides,
  }
}

describe('AccountReauthorizer', () => {
  it('appends the mailbox expiry suffix once to the locked backend account name', async () => {
    const updateAccountName = vi.fn(async (_id: number, name: string) => account({ name, status: 'error' }))
    const backend = {
      getReauthorizationTarget: vi.fn(async () => account({ status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }
    const reauthorizer = new AccountReauthorizer(backend)

    await expect(reauthorizer.markMailboxExpired(target)).resolves.toMatchObject({
      id: 71,
      name: 'user@example.invalid（邮箱接码过期）',
    })
    expect(updateAccountName).toHaveBeenCalledWith(71, 'user@example.invalid（邮箱接码过期）')

    backend.getReauthorizationTarget.mockResolvedValueOnce(
      account({ name: 'user@example.invalid（邮箱接码过期）', status: 'error' }),
    )
    await reauthorizer.markMailboxExpired(target)
    expect(updateAccountName).toHaveBeenCalledTimes(1)
  })

  it('confirms an uncertain mailbox expiry name write without replaying it', async () => {
    const updateAccountName = vi.fn(async () => {
      throw new AppError('BACKEND_TIMEOUT', 'synthetic timeout', { statusCode: 504 })
    })
    const backend = {
      getReauthorizationTarget: vi
        .fn()
        .mockResolvedValueOnce(account({ status: 'error' }))
        .mockResolvedValueOnce(account({ name: 'user@example.invalid（邮箱接码过期）', status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }

    await expect(new AccountReauthorizer(backend).markMailboxExpired(target)).resolves.toMatchObject({
      name: 'user@example.invalid（邮箱接码过期）',
    })
    expect(updateAccountName).toHaveBeenCalledTimes(1)
  })

  it('appends the mailbox access expiry suffix once', async () => {
    const updateAccountName = vi.fn(async (_id: number, name: string) => account({ name, status: 'error' }))
    const backend = {
      getReauthorizationTarget: vi.fn(async () => account({ status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }
    const reauthorizer = new AccountReauthorizer(backend)

    await expect(reauthorizer.markMailboxAccessExpired(target)).resolves.toMatchObject({
      name: 'user@example.invalid（邮箱接码失效）',
    })
    expect(updateAccountName).toHaveBeenCalledWith(71, 'user@example.invalid（邮箱接码失效）')

    backend.getReauthorizationTarget.mockResolvedValueOnce(
      account({ name: 'user@example.invalid（邮箱接码失效）', status: 'error' }),
    )
    await reauthorizer.markMailboxAccessExpired(target)
    expect(updateAccountName).toHaveBeenCalledTimes(1)
  })

  it('replaces an existing managed suffix when marking phone verification', async () => {
    const initialName = 'user@example.invalid（邮箱接码过期）'
    const updateAccountName = vi.fn(async (_id: number, name: string) => account({ name, status: 'error' }))
    const backend = {
      getReauthorizationTarget: vi.fn(async () => account({ name: initialName, status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }
    const reauthorizer = new AccountReauthorizer(backend)
    const markedTarget = { ...target, account: { ...target.account, name: initialName } }

    await expect(reauthorizer.markPhoneVerification(markedTarget)).resolves.toMatchObject({ name: 'user@example.invalid（手机接码）' })
    expect(updateAccountName).toHaveBeenCalledWith(71, 'user@example.invalid（手机接码）')

    backend.getReauthorizationTarget.mockResolvedValueOnce(
      account({ name: 'user@example.invalid（手机接码）', status: 'error' }),
    )
    await reauthorizer.markPhoneVerification(markedTarget)
    expect(updateAccountName).toHaveBeenCalledTimes(1)
  })

  it('replaces a managed account-name note instead of appending another suffix', async () => {
    const updateAccountName = vi.fn(async (_id: number, name: string) => account({ name, status: 'error' }))
    const backend = {
      getReauthorizationTarget: vi.fn(async () => account({ name: 'user@example.invalid（邮箱接码过期）', status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }
    const reauthorizer = new AccountReauthorizer(backend)

    await expect(reauthorizer.setManagedNameNote(target, '手机接码', '邮箱接码过期')).resolves.toMatchObject({
      name: 'user@example.invalid（手机接码）',
    })
    expect(updateAccountName).toHaveBeenCalledWith(71, 'user@example.invalid（手机接码）')
  })

  it('removes the previously managed custom note when the note is cleared', async () => {
    const updateAccountName = vi.fn(async (_id: number, name: string) => account({ name, status: 'error' }))
    const backend = {
      getReauthorizationTarget: vi.fn(async () => account({ name: 'user@example.invalid（暂时不用）', status: 'error' })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
      updateAccountName,
    }

    await new AccountReauthorizer(backend).setManagedNameNote(target, '', '暂时不用')
    expect(updateAccountName).toHaveBeenCalledWith(71, 'user@example.invalid')
  })

  it.each([
    account({ status: 'active' }),
    account({ status: 'error', codex7dUsedPercent: 91 }),
    account({ status: 'error', codex7dUsedPercent: undefined }),
  ])('refuses an ineligible target before browser or write work', async (candidate) => {
    const reauthorizer = new AccountReauthorizer({
      getReauthorizationTarget: vi.fn(async () => candidate),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
    })

    await expect(reauthorizer.loadTarget(71)).rejects.toMatchObject({
      code: 'REAUTHORIZATION_TARGET_INELIGIBLE',
    })
  })

  it('accepts the exact 90 percent boundary shown by the deployed filter', async () => {
    const candidate = account({ status: 'error', codex7dUsedPercent: 90 })
    const reauthorizer = new AccountReauthorizer({
      getReauthorizationTarget: vi.fn(async () => candidate),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
    })

    await expect(reauthorizer.loadTarget(71)).resolves.toMatchObject({
      account: { id: 71, codex7dUsedPercent: 90 },
      email: 'user@example.invalid',
    })
  })

  it('uses the selected threshold for the final target eligibility check', async () => {
    const accepted = new AccountReauthorizer({
      getReauthorizationTarget: vi.fn(async () => account({ status: 'error', codex7dUsedPercent: 37 })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
    })
    await expect(accepted.loadTarget(71, undefined, true, 37)).resolves.toMatchObject({
      account: { codex7dUsedPercent: 37 },
    })

    const rejected = new AccountReauthorizer({
      getReauthorizationTarget: vi.fn(async () => account({ status: 'error', codex7dUsedPercent: 37.1 })),
      applyOAuthCredentials: vi.fn(),
      confirmAppliedCredentials: vi.fn(),
    })
    await expect(rejected.loadTarget(71, undefined, true, 37)).rejects.toMatchObject({
      code: 'REAUTHORIZATION_TARGET_INELIGIBLE',
    })
  })

  it('builds the dedicated write path and never calls account creation', async () => {
    const backend = {
      getReauthorizationTarget: vi
        .fn()
        .mockResolvedValueOnce(account({ status: 'error' }))
        .mockResolvedValueOnce(account()),
      applyOAuthCredentials: vi.fn(async () => account()),
      confirmAppliedCredentials: vi.fn(),
    }
    const reauthorizer = new AccountReauthorizer(backend)
    const initial = await reauthorizer.loadTarget(71, 'user@example.invalid')
    const result = await reauthorizer.applyAndConfirm(initial, credentials, vi.fn(), vi.fn())

    expect(result).toEqual({ id: 71, name: 'user@example.invalid', status: 'active' })
    expect(backend.applyOAuthCredentials).toHaveBeenCalledWith(71, {
      type: 'oauth',
      credentials,
      extra: { email: 'user@example.invalid' },
    })
    expect(backend.getReauthorizationTarget).toHaveBeenNthCalledWith(1, 71)
    expect(backend.getReauthorizationTarget).toHaveBeenNthCalledWith(2, 71)
  })

  it('rejects a different OAuth email before the write request', () => {
    const reauthorizer = new AccountReauthorizer({} as never)
    expect(() => reauthorizer.assertOAuthEmail(target, { ...credentials, email: 'other@example.invalid' })).toThrowError(
      expect.objectContaining({ code: 'OAUTH_ACCOUNT_EMAIL_MISMATCH' }),
    )
  })

  it('queries once and never replays an uncertain write', async () => {
    const uncertain = new AppError('BACKEND_TIMEOUT', 'timeout', { statusCode: 504 })
    const backend = {
      getReauthorizationTarget: vi.fn(async () => target.account),
      applyOAuthCredentials: vi.fn(async () => {
        throw uncertain
      }),
      confirmAppliedCredentials: vi.fn(async () => ({
        account: account(),
        matched: true,
      })),
    }
    const reauthorizer = new AccountReauthorizer(backend)
    const onUncertain = vi.fn()
    const result = await reauthorizer.applyAndConfirm(target, credentials, onUncertain, vi.fn())

    expect(result.id).toBe(71)
    expect(onUncertain).toHaveBeenCalledOnce()
    expect(backend.applyOAuthCredentials).toHaveBeenCalledOnce()
    expect(backend.confirmAppliedCredentials).toHaveBeenCalledOnce()
  })

  it('does not treat a masked or different credential as confirmed', async () => {
    const backend = {
      getReauthorizationTarget: vi.fn(async () => target.account),
      applyOAuthCredentials: vi.fn(async () => {
        throw new AppError('BACKEND_NETWORK_ERROR', 'network', { statusCode: 502 })
      }),
      confirmAppliedCredentials: vi.fn(async () => ({ account: account(), matched: false })),
    }
    const reauthorizer = new AccountReauthorizer(backend)
    await expect(reauthorizer.applyAndConfirm(target, credentials, vi.fn(), vi.fn())).rejects.toMatchObject({
      code: 'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
    })
  })

  it('does not confirm an uncertain write against a non-OpenAI OAuth account response', async () => {
    const backend = {
      getReauthorizationTarget: vi.fn(async () => target.account),
      applyOAuthCredentials: vi.fn(async () => {
        throw new AppError('BACKEND_NETWORK_ERROR', 'network', { statusCode: 502 })
      }),
      confirmAppliedCredentials: vi.fn(async () => ({
        account: account({ platform: 'other', type: 'api' }),
        matched: true,
      })),
    }
    const reauthorizer = new AccountReauthorizer(backend)

    await expect(reauthorizer.applyAndConfirm(target, credentials, vi.fn(), vi.fn())).rejects.toMatchObject({
      code: 'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
    })
    expect(backend.applyOAuthCredentials).toHaveBeenCalledOnce()
    expect(backend.confirmAppliedCredentials).toHaveBeenCalledOnce()
  })

  it('does not query or retry after an explicit backend rejection', async () => {
    const backend = {
      getReauthorizationTarget: vi.fn(async () => target.account),
      applyOAuthCredentials: vi.fn(async () => {
        throw new AppError('BACKEND_HTTP_409', 'conflict', {
          statusCode: 409,
          details: { backendStatus: 409 },
        })
      }),
      confirmAppliedCredentials: vi.fn(),
    }
    const reauthorizer = new AccountReauthorizer(backend)

    await expect(reauthorizer.applyAndConfirm(target, credentials, vi.fn(), vi.fn())).rejects.toMatchObject({
      code: 'ACCOUNT_REAUTHORIZATION_FAILED',
    })
    expect(backend.applyOAuthCredentials).toHaveBeenCalledOnce()
    expect(backend.confirmAppliedCredentials).not.toHaveBeenCalled()
  })

  it('never retries when a successful response contains another account id', async () => {
    const backend = {
      getReauthorizationTarget: vi.fn(async () => target.account),
      applyOAuthCredentials: vi.fn(async () => account({ id: 72 })),
      confirmAppliedCredentials: vi.fn(),
    }
    const reauthorizer = new AccountReauthorizer(backend)
    const onUncertain = vi.fn()

    await expect(reauthorizer.applyAndConfirm(target, credentials, onUncertain, vi.fn())).rejects.toMatchObject({
      code: 'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
    })
    expect(onUncertain).toHaveBeenCalledOnce()
    expect(backend.applyOAuthCredentials).toHaveBeenCalledOnce()
    expect(backend.confirmAppliedCredentials).not.toHaveBeenCalled()
  })
})
