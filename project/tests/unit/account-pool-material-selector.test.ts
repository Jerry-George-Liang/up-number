import { describe, expect, it } from 'vitest'
import { selectAccountPoolMaterial } from '../../src/server/account-pool/material-selector'

describe('selectAccountPoolMaterial', () => {
  it('prefers a complete password and TOTP pair even when mailbox access exists', () => {
    expect(
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        password: 'synthetic-password',
        totpSecret: 'jbsw y3dp-ehpk3pxp',
        mailboxAccess: 'https://example.invalid/mailbox-token',
      }),
    ).toEqual({
      source: 'account_pool',
      kind: 'password_totp',
      password: 'synthetic-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      passwordHyphenFallbacks: ['synthetic-password-', '-synthetic-password'],
      passwordErrorFallback: {
        password: 'jbsw y3dp-ehpk3pxp',
        totpSecret: 'synthetic-password',
      },
    })
  })

  it('keeps a reversed candidate of any length for a password rejection retry', () => {
    const password = 'JBSWY3DPEHPK3PXP'
    const totpSecret = 'actual-password-with-any-length'
    expect(
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        password,
        totpSecret,
      }),
    ).toMatchObject({
      source: 'account_pool',
      kind: 'password_totp',
      password,
      totpSecret,
      passwordErrorFallback: { password: totpSecret, totpSecret: password },
    })
  })

  it('keeps a reversed retry when neither field can be identified by format in advance', () => {
    expect(
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        password: 'unrecognized-secret-0',
        totpSecret: 'actual-password-0',
        mailboxAccess: 'mailbox-token',
      }),
    ).toMatchObject({
      source: 'account_pool',
      kind: 'password_totp',
      password: 'unrecognized-secret-0',
      totpSecret: 'actual-password-0',
      passwordErrorFallback: {
        password: 'actual-password-0',
        totpSecret: 'unrecognized-secret-0',
      },
    })
  })

  it('keeps a reversed retry when 2FA is embedded in the mailbox access URL', () => {
    const result = selectAccountPoolMaterial('user@example.invalid', {
      email: 'user@example.invalid',
      password: 'account-password',
      mailboxAccess: 'https://2fa.kim/2fa=JBSWY3DPEHPK3PXP',
    })

    expect(result).toMatchObject({
      kind: 'password_totp',
      password: 'account-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      passwordErrorFallback: {
        password: 'JBSWY3DPEHPK3PXP',
        totpSecret: 'account-password',
      },
    })
  })

  it.each([
    { password: 'synthetic-password' },
    { totpSecret: 'JBSWY3DPEHPK3PXP' },
  ])('falls back to mailbox access when password materials are incomplete %#', (partial) => {
    expect(
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        ...partial,
        mailboxAccess: 'mailbox-token',
      }),
    ).toEqual({ source: 'account_pool', kind: 'email_otp', mailboxAccess: 'mailbox-token' })
  })

  it('uses a 2fa.kim link saved in the mailbox field as the password TOTP secret', () => {
    expect(
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        password: 'synthetic-password',
        mailboxAccess: 'https://2fa.kim/2fa=A47GCTSBEOFFDWXRCQJJRWESXKLLZNN4',
      }),
    ).toEqual({
      source: 'account_pool',
      kind: 'password_totp',
      password: 'synthetic-password',
      totpSecret: 'A47GCTSBEOFFDWXRCQJJRWESXKLLZNN4',
      passwordHyphenFallbacks: ['synthetic-password-', '-synthetic-password'],
      passwordErrorFallback: {
        password: 'A47GCTSBEOFFDWXRCQJJRWESXKLLZNN4',
        totpSecret: 'synthetic-password',
      },
    })
  })

  it('uses the FlySMS fragment email when the account-pool email field is empty', () => {
    expect(
      selectAccountPoolMaterial('unisex-lagers0c@icloud.com', {
        email: '',
        mailboxAccess: 'https://flysms.xyz/icloud/pickup#email=unisex-lagers0c%40icloud.com&key=tok_synthetic_token_123456',
      }),
    ).toEqual({
      source: 'account_pool',
      kind: 'email_otp',
      mailboxAccess: 'https://flysms.xyz/icloud/pickup#email=unisex-lagers0c%40icloud.com&key=tok_synthetic_token_123456',
    })
  })

  it('rejects an empty account-pool email when the FlySMS fragment email differs', () => {
    expect(() => selectAccountPoolMaterial('other@example.invalid', {
      email: '',
      mailboxAccess: 'https://flysms.xyz/icloud/pickup#email=unisex-lagers0c%40icloud.com&key=tok_synthetic_token_123456',
    })).toThrowError(expect.objectContaining({ code: 'ACCOUNT_POOL_PROTOCOL_ERROR' }))
  })

  it('does not treat a 2fa.kim link without a password as mailbox access', () => {
    expect(() =>
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        mailboxAccess: 'https://2fa.kim/2fa=A47GCTSBEOFFDWXRCQJJRWESXKLLZNN4',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_POOL_MATERIALS_INCOMPLETE' }))
  })

  it('rejects incomplete materials and a mismatched email', () => {
    expect(() =>
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'user@example.invalid',
        password: 'synthetic-password',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_POOL_MATERIALS_INCOMPLETE' }))
    expect(() =>
      selectAccountPoolMaterial('user@example.invalid', {
        email: 'other@example.invalid',
        mailboxAccess: 'mailbox-token',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_POOL_PROTOCOL_ERROR' }))
  })
})
