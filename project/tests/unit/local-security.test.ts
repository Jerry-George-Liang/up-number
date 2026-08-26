import { describe, expect, it } from 'vitest'
import { LocalSessionSecurity } from '../../src/server/local-security'

describe('LocalSessionSecurity', () => {
  it('consumes the bootstrap nonce once and validates writes', () => {
    const security = new LocalSessionSecurity(() => 'fixed-random')
    const bootstrap = security.bootstrapNonce
    expect(security.canBootstrap(bootstrap)).toBe(true)
    expect(security.canBootstrap(bootstrap)).toBe(true)
    expect(security.canBootstrap('wrong')).toBe(false)
    expect(security.consumeBootstrap(bootstrap)).toBe(true)
    expect(security.canBootstrap(bootstrap)).toBe(false)
    expect(security.consumeBootstrap(bootstrap)).toBe(false)

    expect(
      security.validateWrite({
        cookieSession: security.sessionId,
        csrfHeader: security.csrfToken,
        origin: 'http://127.0.0.1:43123',
        expectedOrigin: 'http://127.0.0.1:43123',
      }),
    ).toEqual({ ok: true })
  })

  it('rejects cross-origin and missing-token writes', () => {
    const security = new LocalSessionSecurity(() => 'fixed-random')
    expect(
      security.validateWrite({
        cookieSession: security.sessionId,
        csrfHeader: security.csrfToken,
        origin: 'https://attacker.invalid',
        expectedOrigin: 'http://127.0.0.1:43123',
      }).ok,
    ).toBe(false)
    expect(
      security.validateWrite({
        cookieSession: security.sessionId,
        csrfHeader: undefined,
        origin: 'http://127.0.0.1:43123',
        expectedOrigin: 'http://127.0.0.1:43123',
      }).ok,
    ).toBe(false)
  })

  it('derives the same session and CSRF tokens across restarts while rotating bootstrap nonces', () => {
    const persistentSeed = 'A'.repeat(43)
    const first = new LocalSessionSecurity({ persistentSeed, random: () => 'bootstrap-first' })
    const second = new LocalSessionSecurity({ persistentSeed, random: () => 'bootstrap-second' })

    expect(first.bootstrapNonce).toBe('bootstrap-first')
    expect(second.bootstrapNonce).toBe('bootstrap-second')
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.csrfToken).toBe(first.csrfToken)
    expect(first.sessionId).not.toBe(first.csrfToken)
  })

  it('isolates LAN cookies and CSRF from the existing loopback session', () => {
    const persistentSeed = 'A'.repeat(43)
    const loopback = new LocalSessionSecurity({ persistentSeed })
    const lanFirst = new LocalSessionSecurity({
      persistentSeed,
      namespace: 'lan:192.168.50.218:43123',
      random: () => 'lan-bootstrap-first',
    })
    const lanSecond = new LocalSessionSecurity({
      persistentSeed,
      namespace: 'lan:192.168.50.218:43123',
      random: () => 'lan-bootstrap-second',
    })

    expect(lanFirst.sessionId).toBe(lanSecond.sessionId)
    expect(lanFirst.csrfToken).toBe(lanSecond.csrfToken)
    expect(lanFirst.bootstrapNonce).not.toBe(lanSecond.bootstrapNonce)
    expect(lanFirst.sessionId).not.toBe(loopback.sessionId)
    expect(lanFirst.csrfToken).not.toBe(loopback.csrfToken)
  })
})
