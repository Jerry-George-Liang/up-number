import { describe, expect, it } from 'vitest'
import {
  CreateTaskInputSchema,
  PasswordLoginInputSchema,
  ReauthorizeTaskInputSchema,
  TotpLoginInputSchema,
  toPublicTask,
  type InternalTask,
} from '../../src/shared/contracts'

const validInput = {
  accountEmail: ' User@Example.Invalid ',
  loginMaterial: { kind: 'email_otp' as const, mailboxAccess: 'mail-secret' },
  proxyChoice: { mode: 'none' as const },
  concurrency: 10 as const,
  supplier: null,
  groupIds: [],
}

describe('CreateTaskInputSchema', () => {
  it('normalizes the email and accepts the default supported workflow', () => {
    const parsed = CreateTaskInputSchema.parse(validInput)
    expect(parsed.accountEmail).toBe('user@example.invalid')
    expect(parsed.concurrency).toBe(10)
    expect(parsed.allowDuplicateCreation).toBe(false)
    expect(parsed.confirmMixedChannelRisk).toBe(false)
  })

  it('accepts password + TOTP without changing password characters', () => {
    const parsed = CreateTaskInputSchema.parse({
      ...validInput,
      loginMaterial: {
        kind: 'password_totp',
        password: '  synthetic password--value  ',
        totpSecret: 'jbsw y3dp-ehpk3pxp',
      },
    })
    expect(parsed.loginMaterial).toEqual({
      kind: 'password_totp',
      password: '  synthetic password--value  ',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    })
  })

  it('accepts account-pool lookup without any manual login material', () => {
    expect(
      CreateTaskInputSchema.parse({
        accountEmail: validInput.accountEmail,
        proxyChoice: validInput.proxyChoice,
        concurrency: validInput.concurrency,
        supplier: validInput.supplier,
        groupIds: validInput.groupIds,
        loginMaterialSource: 'account_pool',
      }),
    ).toMatchObject({
      accountEmail: 'user@example.invalid',
      loginMaterialSource: 'account_pool',
    })
  })

  it('rejects mixed automatic and manual login material', () => {
    expect(() =>
      CreateTaskInputSchema.parse({ ...validInput, loginMaterialSource: 'account_pool' }),
    ).toThrow()
  })

  it.each([
    { kind: 'email_otp', mailboxAccess: 'mail-secret', password: 'unexpected' },
    { kind: 'password_totp', password: 'synthetic-password', totpSecret: 'JBSWY3DPEHPK3PXP', mailboxAccess: 'unexpected' },
    { kind: 'password_totp', password: '', totpSecret: 'JBSWY3DPEHPK3PXP' },
    { kind: 'password_totp', password: 'synthetic-password', totpSecret: 'not-base32' },
  ])('rejects incomplete or cross-mode login material %#', (loginMaterial) => {
    expect(() => CreateTaskInputSchema.parse({ ...validInput, loginMaterial })).toThrow()
  })

  it.each([1, 3, 5, 10, 20])('accepts concurrency %s', (concurrency) => {
    expect(CreateTaskInputSchema.parse({ ...validInput, concurrency }).concurrency).toBe(concurrency)
  })

  it('rejects unsupported concurrency and unknown fields', () => {
    expect(() => CreateTaskInputSchema.parse({ ...validInput, concurrency: 7 })).toThrow()
    expect(() => CreateTaskInputSchema.parse({ ...validInput, accountName: 'manual-name' })).toThrow()
  })

  it.each([
    { mode: 'none' },
    { mode: 'fixed', proxyId: 1 },
    { mode: 'fixed', proxyId: -1 },
    { mode: 'random_fixed' },
    { mode: 'dynamic', subscriptionId: 2 },
  ])('accepts proxy choice $mode', (proxyChoice) => {
    expect(CreateTaskInputSchema.parse({ ...validInput, proxyChoice }).proxyChoice.mode).toBe(proxyChoice.mode)
  })
})

describe('ReauthorizeTaskInputSchema', () => {
  const valid = {
    accountId: 71,
    accountEmail: ' User@Example.Invalid ',
    loginMaterial: { kind: 'email_otp' as const, mailboxAccess: 'mail-secret' },
  }

  it('keeps only the existing account identity and one login material branch', () => {
    expect(ReauthorizeTaskInputSchema.parse(valid)).toEqual({
      accountId: 71,
      accountEmail: 'user@example.invalid',
      maxUsage7dPercent: 90,
      loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
    })
  })

  it('accepts account-pool lookup for a locked existing account', () => {
    expect(
      ReauthorizeTaskInputSchema.parse({
        accountId: 71,
        accountEmail: ' User@Example.Invalid ',
        loginMaterialSource: 'account_pool',
      }),
    ).toEqual({
      accountId: 71,
      accountEmail: 'user@example.invalid',
      maxUsage7dPercent: 90,
      loginMaterialSource: 'account_pool',
    })
  })

  it.each([
    { ...valid, accountId: 0 },
    { ...valid, proxyChoice: { mode: 'none' } },
    { ...valid, concurrency: 10 },
    { ...valid, groupIds: [] },
    { ...valid, allowDuplicateCreation: true },
  ])('rejects invalid identity or create-only fields %#', (input) => {
    expect(() => ReauthorizeTaskInputSchema.parse(input)).toThrow()
  })

  it.each([0, 90, 100])('accepts a 7-day usage threshold of %s', (maxUsage7dPercent) => {
    expect(ReauthorizeTaskInputSchema.parse({ ...valid, maxUsage7dPercent }).maxUsage7dPercent).toBe(
      maxUsage7dPercent,
    )
  })

  it.each(['existing', 'none'] as const)('accepts reauthorization proxy mode %s', (proxyMode) => {
    expect(ReauthorizeTaskInputSchema.parse({ ...valid, proxyMode }).proxyMode).toBe(proxyMode)
  })

  it('rejects unsupported reauthorization proxy modes', () => {
    expect(() => ReauthorizeTaskInputSchema.parse({ ...valid, proxyMode: 'dynamic' })).toThrow()
  })

  it.each([-1, 100.1, 101, Number.NaN])('rejects an invalid 7-day usage threshold of %s', (maxUsage7dPercent) => {
    expect(() => ReauthorizeTaskInputSchema.parse({ ...valid, maxUsage7dPercent })).toThrow()
  })
})

describe('PasswordLoginInputSchema', () => {
  it('normalizes the email without changing the password', () => {
    expect(PasswordLoginInputSchema.parse({ email: ' Admin@Example.Invalid ', password: '  synthetic password  ' })).toEqual({
      email: 'admin@example.invalid',
      password: '  synthetic password  ',
    })
  })

  it.each([
    { email: 'not-an-email', password: 'synthetic-password' },
    { email: 'admin@example.invalid', password: '' },
    { email: 'admin@example.invalid', password: 'x'.repeat(1025) },
    { email: 'admin@example.invalid', password: 'synthetic-password', extra: true },
  ])('rejects invalid login input %#', (input) => {
    expect(() => PasswordLoginInputSchema.parse(input)).toThrow()
  })
})

describe('TotpLoginInputSchema', () => {
  const validAttemptId = 'a'.repeat(43)

  it('accepts an exact base64url attempt ID and six digit code', () => {
    expect(TotpLoginInputSchema.parse({ attemptId: validAttemptId, code: '012345' })).toEqual({
      attemptId: validAttemptId,
      code: '012345',
    })
  })

  it.each([
    { attemptId: 'short', code: '123456' },
    { attemptId: `${'a'.repeat(42)}+`, code: '123456' },
    { attemptId: validAttemptId, code: '12345' },
    { attemptId: validAttemptId, code: '12345a' },
    { attemptId: validAttemptId, code: '123456', extra: true },
  ])('rejects invalid TOTP input %#', (input) => {
    expect(() => TotpLoginInputSchema.parse(input)).toThrow()
  })
})

describe('toPublicTask', () => {
  it('serializes only allowlisted public task fields', () => {
    const now = new Date().toISOString()
    const task: InternalTask = {
      id: 'task-1',
      accountEmail: 'user@example.invalid',
      stage: 'waiting_for_otp',
      status: 'active',
      selection: {
        operation: 'create',
        proxyMode: 'none',
        concurrency: 10,
        supplier: null,
        groups: [],
        modelsCleared: true,
      },
      account: null,
      error: null,
      message: '等待验证码',
      createdAt: now,
      updatedAt: now,
      mailboxPassword: 'mail-secret',
      oauthCredentials: { access_token: 'oauth-access', refresh_token: 'oauth-refresh' },
      backendAccessToken: 'backend-access',
    }

    const serialized = JSON.stringify(toPublicTask(task))
    expect(serialized).not.toMatch(/mailboxPassword|mail-secret|access_token|refresh_token|oauth-access|oauth-refresh|backend-access/)
  })
})
