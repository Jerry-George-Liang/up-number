import { describe, expect, it } from 'vitest'
import { normalizeTotpSecret } from '../../src/shared/login-material'

describe('normalizeTotpSecret', () => {
  it('normalizes presentation spaces, hyphens, and casing', () => {
    expect(normalizeTotpSecret('jbsw y3dp-ehpk3pxp')).toBe('JBSWY3DPEHPK3PXP')
  })

  it.each([
    '',
    'ABC',
    'JBSWY3DP0HPK3PXP',
    'JBSWY3DP\tEHPK3PXP',
    'JBSWY3DP=EHPK3PXP',
    'JBSWY3DPEHPK3PXP=',
    'otpauth://totp/example',
  ])('rejects invalid or ambiguous Base32 material %#', (value) => {
    expect(normalizeTotpSecret(value)).toBeNull()
  })

  it('accepts valid RFC 4648 padding and preserves it canonically', () => {
    expect(normalizeTotpSecret('MZXW6===')).toBe('MZXW6===')
  })
})
