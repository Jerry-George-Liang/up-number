import { describe, expect, it, vi } from 'vitest'
import { TotpGenerator } from '../../src/server/security/totp'

const syntheticRfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('TotpGenerator', () => {
  it('generates the RFC-compatible six-digit SHA1 token for a fixed timestamp', async () => {
    const generator = new TotpGenerator({ now: () => 45_000 })
    await expect(generator.next(syntheticRfcSecret)).resolves.toEqual({
      code: '287082',
      counter: 1,
    })
  })

  it('waits across a period when the current token has less than ten seconds remaining', async () => {
    let now = 59_000
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds
    })
    const generator = new TotpGenerator({ now: () => now, wait })

    const token = await generator.next(syntheticRfcSecret)

    expect(wait).toHaveBeenCalledOnce()
    expect(wait.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1_000)
    expect(token.counter).toBe(2)
  })

  it('waits for a later counter before producing the one allowed retry token', async () => {
    let now = 40_000
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds
    })
    const generator = new TotpGenerator({ now: () => now, wait })

    const token = await generator.next(syntheticRfcSecret, 1)

    expect(wait).toHaveBeenCalledOnce()
    expect(token.counter).toBe(2)
  })

  it('fails closed when an injected clock does not advance after waiting', async () => {
    const generator = new TotpGenerator({
      now: () => 59_000,
      wait: vi.fn(async () => undefined),
    })

    await expect(generator.next(syntheticRfcSecret)).rejects.toMatchObject({ code: 'TOTP_GENERATION_FAILED' })
  })

  it('honors cancellation before reading or generating a token', async () => {
    const controller = new AbortController()
    controller.abort()
    const generator = new TotpGenerator({ now: () => 30_000 })

    await expect(generator.next(syntheticRfcSecret, undefined, controller.signal)).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
    })
  })

  it('rejects an invalid secret without including it in the public error', async () => {
    const generator = new TotpGenerator({ now: () => 30_000 })
    const invalidSecret = 'invalid*secret'

    await expect(generator.next(invalidSecret)).rejects.toMatchObject({
      code: 'TOTP_SECRET_INVALID',
      message: expect.not.stringContaining(invalidSecret),
    })
  })
})
