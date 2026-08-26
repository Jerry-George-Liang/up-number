import { describe, expect, it, vi } from 'vitest'
import { AccountPoolBridgeClient } from '../../src/server/account-pool/bridge-client'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const bridgeToken = 'synthetic-bridge-token-at-least-32-bytes'

describe('AccountPoolBridgeClient', () => {
  it('uses an exact encoded email and returns only a strict material response', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        email: 'user@example.invalid',
        password: 'synthetic-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        mailboxAccess: 'mailbox-token',
      }),
    ) as unknown as typeof fetch
    const client = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: bridgeToken,
      fetchImpl,
    })

    await expect(client.resolve(' User@Example.Invalid ')).resolves.toMatchObject({
      email: 'user@example.invalid',
      password: 'synthetic-password',
    })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call).toBeDefined()
    const [target, init] = call!
    expect(String(target)).toBe('http://127.0.0.1:3001/internal/account-materials?email=user%40example.invalid')
    expect(init.headers.Authorization).toBe(`Bearer ${bridgeToken}`)
  })

  it('fills the requested email when bridge materials omit the redundant email field', async () => {
    const client = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: bridgeToken,
      fetchImpl: vi.fn(async () => response({ mailboxAccess: 'mailbox-token' })) as unknown as typeof fetch,
    })

    await expect(client.resolve('user@example.invalid')).resolves.toEqual({
      email: 'user@example.invalid',
      mailboxAccess: 'mailbox-token',
    })
  })

  it.each([
    [401, 'ACCOUNT_POOL_UNAUTHORIZED'],
    [404, 'ACCOUNT_POOL_EMAIL_NOT_FOUND'],
    [422, 'ACCOUNT_POOL_MATERIALS_MISSING'],
  ])('maps HTTP %s to %s without exposing the response body', async (status, code) => {
    const client = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: bridgeToken,
      fetchImpl: vi.fn(async () => response({ error: 'synthetic-secret-body' }, Number(status))) as unknown as typeof fetch,
    })
    await expect(client.resolve('user@example.invalid')).rejects.toMatchObject({ code })
    await expect(client.resolve('user@example.invalid')).rejects.not.toMatchObject({ message: expect.stringContaining('synthetic-secret-body') })
  })

  it('rejects unknown fields, mismatched email, and an unconfigured token', async () => {
    const unknownField = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: bridgeToken,
      fetchImpl: vi.fn(async () => response({ email: 'user@example.invalid', mailboxAccess: 'token', session: 'forbidden' })) as unknown as typeof fetch,
    })
    await expect(unknownField.resolve('user@example.invalid')).rejects.toMatchObject({ code: 'ACCOUNT_POOL_PROTOCOL_ERROR' })

    const mismatch = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: bridgeToken,
      fetchImpl: vi.fn(async () => response({ email: 'other@example.invalid', mailboxAccess: 'token' })) as unknown as typeof fetch,
    })
    await expect(mismatch.resolve('user@example.invalid')).rejects.toMatchObject({ code: 'ACCOUNT_POOL_PROTOCOL_ERROR' })

    const unconfigured = new AccountPoolBridgeClient({
      baseUrl: 'http://127.0.0.1:3001',
      token: '',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    await expect(unconfigured.resolve('user@example.invalid')).rejects.toMatchObject({ code: 'ACCOUNT_POOL_NOT_CONFIGURED' })
  })
})
