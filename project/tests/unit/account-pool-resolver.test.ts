import { describe, expect, it, vi } from 'vitest'
import { ConfiguredAccountPoolResolver } from '../../src/server/account-pool/resolver'
import type { AccountPoolPortalService } from '../../src/server/account-pool/portal'

describe('ConfiguredAccountPoolResolver', () => {
  it('uses the configured remote portal and otherwise preserves the loopback bridge fallback', async () => {
    const portalResolve = vi.fn(async (email: string) => ({ email, password: 'remote-password' }))
    let configured = true
    const portal = {
      status: vi.fn(() => ({
        configured,
        connected: configured,
        origin: configured ? 'http://192.168.50.207:3000' : null,
        lastCheckedAt: null,
        lastError: null,
      })),
      resolve: portalResolve,
    } as unknown as AccountPoolPortalService
    const fallback = {
      resolve: vi.fn(async (email: string) => ({ email, password: 'local-password' })),
    }
    const resolver = new ConfiguredAccountPoolResolver(portal, fallback)

    await expect(resolver.resolve('user@example.invalid')).resolves.toMatchObject({
      password: 'remote-password',
    })
    expect(portalResolve).toHaveBeenCalledTimes(1)
    expect(fallback.resolve).not.toHaveBeenCalled()

    configured = false
    await expect(resolver.resolve('user@example.invalid')).resolves.toMatchObject({
      password: 'local-password',
    })
    expect(fallback.resolve).toHaveBeenCalledTimes(1)
  })
})
