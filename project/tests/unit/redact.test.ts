import { describe, expect, it } from 'vitest'
import { maskEmail, redactValue } from '../../src/server/security/redact'

describe('redactValue', () => {
  it('redacts secrets from nested values and strings', () => {
    const redacted = redactValue({
      authorization: 'Bearer backend-secret',
      nested: {
        access_token: 'oauth-access',
        url: 'https://mail.test/?mail=user%40example.invalid&pwd=mail-secret&limit=5',
        message: 'callback code=oauth-code&state=oauth-state, otp 123456',
      },
      loginMaterial: {
        kind: 'password_totp',
        password: 'synthetic-account-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
      mailboxAccess: 'synthetic-mailbox-access',
    })

    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toMatch(
      /backend-secret|oauth-access|mail-secret|oauth-code|oauth-state|123456|synthetic-account-password|JBSWY3DPEHPK3PXP|synthetic-mailbox-access/,
    )
    expect(serialized).toContain('[REDACTED]')
  })

  it('masks email addresses for logs', () => {
    expect(maskEmail('operator@example.invalid')).toBe('o******r@example.invalid')
  })
})
