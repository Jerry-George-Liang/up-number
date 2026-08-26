import { describe, expect, it } from 'vitest'
import type { OptionsSnapshot } from '../../src/shared/contracts'
import { isLocalSessionRequired } from '../../src/web/api'
import {
  TASK_FREEFORM_FIELDS,
  canStartTask,
  canStartReauthorization,
  createLatestRequestGuard,
  createReauthorizationCredentialMemory,
  createReauthorizationFormState,
  createTaskCredentialMemory,
  createTaskFormState,
  isForbiddenFrontendApiKey,
  rememberTaskCredential,
  rememberReauthorizationCredential,
  selectReauthorizationAccount,
  switchTaskCredentialEmail,
  toggleAllGroupIds,
  toCreateTaskInput,
  toReauthorizeTaskInput,
} from '../../src/web/state'
import { formatExactTime, formatRelativeTime } from '../../src/web/time'

const options: OptionsSnapshot = {
  version: 'v1',
  loadedAt: '2026-08-11T08:00:00.000Z',
  proxies: [
    { id: 11, name: 'Fixed proxy' },
    { id: -41, name: 'Machine proxy', proxyMachineId: 41 },
  ],
  subscriptions: [{ id: 21, name: 'Dynamic pool', enabled: true, nodeCount: 17, healthyNodeCount: 4 }],
  suppliers: ['Primary'],
  groups: [{ id: 31, name: 'Default group' }],
}

describe('local session errors', () => {
  it('recognizes only the local bootstrap session error', () => {
    expect(isLocalSessionRequired(Object.assign(new Error('expired'), { code: 'LOCAL_SESSION_REQUIRED' }))).toBe(true)
    expect(isLocalSessionRequired(Object.assign(new Error('backend expired'), { code: 'SESSION_EXPIRED' }))).toBe(false)
    expect(isLocalSessionRequired(null)).toBe(false)
  })
})

describe('latest request guard', () => {
  it('accepts only the newest request and invalidates in-flight work', () => {
    const requests = createLatestRequestGuard()
    const first = requests.begin()
    const second = requests.begin()

    expect(requests.isLatest(first)).toBe(false)
    expect(requests.isLatest(second)).toBe(true)

    requests.invalidate()
    expect(requests.isLatest(second)).toBe(false)
  })
})

describe('task form state', () => {
  it('selects every available group and toggles back to none', () => {
    const groups = [
      { id: 31, name: 'Default' },
      { id: 32, name: 'Secondary' },
    ]
    expect(toggleAllGroupIds([], groups)).toEqual([31, 32])
    expect(toggleAllGroupIds([31], groups)).toEqual([31, 32])
    expect(toggleAllGroupIds([31, 32], groups)).toEqual([])
    expect(toggleAllGroupIds([31], [])).toEqual([])
  })

  it('defines the shared email plus fallback secret fields and defaults to account-pool lookup', () => {
    const form = createTaskFormState()
    expect(TASK_FREEFORM_FIELDS).toEqual([
      { key: 'accountEmail', type: 'email' },
      { key: 'mailboxAccess', type: 'password' },
      { key: 'accountPassword', type: 'password' },
      { key: 'totpSecret', type: 'password' },
    ])
    expect(form.materialSource).toBe('account_pool')
    expect(form.loginMode).toBe('email_otp')
    expect(form.concurrency).toBe(10)
    expect(form.allowDuplicateCreation).toBe(true)
    expect(form.confirmMixedChannelRisk).toBe(false)
    expect(form.modelsCleared).toBe(true)
  })

  it('maps every proxy mode from controlled selectors only', () => {
    const none = createTaskFormState()
    expect(toCreateTaskInput(none).proxyChoice).toEqual({ mode: 'none' })

    const fixed = createTaskFormState()
    fixed.proxyMode = 'fixed'
    fixed.fixedProxyId = 11
    expect(toCreateTaskInput(fixed).proxyChoice).toEqual({ mode: 'fixed', proxyId: 11 })

    fixed.fixedProxyId = -41
    expect(toCreateTaskInput(fixed).proxyChoice).toEqual({ mode: 'fixed', proxyId: -41 })

    const random = createTaskFormState()
    random.proxyMode = 'random_fixed'
    expect(toCreateTaskInput(random).proxyChoice).toEqual({ mode: 'random_fixed' })

    const dynamic = createTaskFormState()
    dynamic.proxyMode = 'dynamic'
    dynamic.subscriptionId = 21
    expect(toCreateTaskInput(dynamic).proxyChoice).toEqual({ mode: 'dynamic', subscriptionId: 21 })
  })

  it('disables start until session, options, required fields, and dependent selections are ready', () => {
    const form = createTaskFormState()
    expect(canStartTask(form, true, options, false)).toBe(false)
    form.accountEmail = 'user@example.invalid'
    expect(canStartTask(form, false, options, false)).toBe(false)
    expect(canStartTask(form, true, null, false)).toBe(false)
    expect(canStartTask(form, true, options, false)).toBe(true)
    form.proxyMode = 'fixed'
    expect(canStartTask(form, true, options, false)).toBe(false)
    form.fixedProxyId = 11
    expect(canStartTask(form, true, options, true)).toBe(false)
  })

  it.each([
    { id: 21, name: 'Disabled pool', enabled: false, healthyNodeCount: 4 },
    { id: 21, name: 'Empty pool', enabled: true, healthyNodeCount: 0 },
  ])('does not start with an unavailable dynamic subscription', (subscription) => {
    const form = createTaskFormState()
    form.accountEmail = 'user@example.invalid'
    form.proxyMode = 'dynamic'
    form.subscriptionId = 21

    expect(canStartTask(form, true, { ...options, subscriptions: [subscription] }, false)).toBe(false)
  })

  it('creates an automatic task input without sending manual secrets', () => {
    const form = createTaskFormState()
    form.accountEmail = ' User@Example.invalid '
    form.mailboxAccess = 'mail-secret'
    expect(toCreateTaskInput(form)).toMatchObject({
      accountEmail: 'user@example.invalid',
      loginMaterialSource: 'account_pool',
    })
    expect(toCreateTaskInput(form)).not.toHaveProperty('loginMaterial')
    expect(form.accountEmail).toBe(' User@Example.invalid ')
    expect(form.mailboxAccess).toBe('mail-secret')
  })

  it('requires and maps separate password and 2FA inputs in password mode', () => {
    const form = createTaskFormState()
    form.materialSource = 'manual'
    form.loginMode = 'password_totp'
    form.accountEmail = ' User@Example.invalid '
    form.accountPassword = '  synthetic password  '
    expect(canStartTask(form, true, options, false)).toBe(false)
    form.totpSecret = 'jbsw y3dp-ehpk3pxp'

    expect(canStartTask(form, true, options, false)).toBe(true)
    expect(toCreateTaskInput(form)).toMatchObject({
      accountEmail: 'user@example.invalid',
      loginMaterial: {
        kind: 'password_totp',
        password: '  synthetic password  ',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    })
    expect(form.accountPassword).toBe('  synthetic password  ')
    expect(form.totpSecret).toBe('jbsw y3dp-ehpk3pxp')
  })

  it('remembers all mode-specific credentials separately for each account email', () => {
    const form = createTaskFormState()
    const memory = createTaskCredentialMemory()

    form.accountEmail = 'First@Example.invalid'
    switchTaskCredentialEmail(form, memory)
    form.mailboxAccess = 'first-mail-secret'
    form.accountPassword = 'first-account-password'
    form.totpSecret = 'FIRSTTOTP'
    rememberTaskCredential(form, memory)

    form.accountEmail = 'second@example.invalid'
    switchTaskCredentialEmail(form, memory)
    expect(form.mailboxAccess).toBe('')
    expect(form.accountPassword).toBe('')
    expect(form.totpSecret).toBe('')
    form.mailboxAccess = 'second-mail-secret'
    form.accountPassword = 'second-account-password'
    form.totpSecret = 'SECONDTOTP'
    rememberTaskCredential(form, memory)

    form.accountEmail = ' first@example.invalid '
    switchTaskCredentialEmail(form, memory)
    expect(form.mailboxAccess).toBe('first-mail-secret')
    expect(form.accountPassword).toBe('first-account-password')
    expect(form.totpSecret).toBe('FIRSTTOTP')

    form.accountEmail = 'SECOND@EXAMPLE.INVALID'
    switchTaskCredentialEmail(form, memory)
    expect(form.mailboxAccess).toBe('second-mail-secret')
    expect(form.accountPassword).toBe('second-account-password')
    expect(form.totpSecret).toBe('SECONDTOTP')
  })

  it('does not inherit an existing account credential when switching to a new account', () => {
    const form = createTaskFormState()
    const memory = createTaskCredentialMemory()
    form.accountEmail = 'first@example.invalid'
    form.mailboxAccess = 'first-mail-secret'
    switchTaskCredentialEmail(form, memory)

    form.accountEmail = 'new@example.invalid'
    switchTaskCredentialEmail(form, memory)

    expect(form.mailboxAccess).toBe('')
    expect(memory.byEmail.get('first@example.invalid')).toEqual({
      mailboxAccess: 'first-mail-secret',
      accountPassword: '',
      totpSecret: '',
    })
    expect(memory.byEmail.has('new@example.invalid')).toBe(false)
  })

  it.each(['access_token', 'refresh_token', 'id_token', 'oauthCredentials', 'session_id'])(
    'forbids token-bearing frontend API key %s',
    (key) => expect(isForbiddenFrontendApiKey(key)).toBe(true),
  )
})

describe('reauthorization form state', () => {
  it('keeps reauthorization disabled until an existing account is selected', () => {
    const form = createReauthorizationFormState()

    expect(form.materialSource).toBe('account_pool')
    expect(form.proxyMode).toBe('existing')
    expect(canStartReauthorization(form, true, false)).toBe(false)
    expect(() => toReauthorizeTaskInput(form)).toThrowError('请选择需要重新授权的账号。')
  })

  it('locks the selected account identity and emits no create-only options', () => {
    const form = createReauthorizationFormState()
    const memory = createReauthorizationCredentialMemory()
    selectReauthorizationAccount(form, memory, {
      id: 71,
      name: 'Existing OpenAI',
      email: 'user@example.invalid',
      status: 'error',
      usage7dPercent: 80,
      importedAt: '2026-08-16T08:00:00.000Z',
    })

    expect(canStartReauthorization(form, true, false)).toBe(true)
    expect(form.accountImportedAt).toBe('2026-08-16T08:00:00.000Z')
    expect(toReauthorizeTaskInput(form)).toEqual({
      accountId: 71,
      accountEmail: 'user@example.invalid',
      maxUsage7dPercent: 90,
      proxyMode: 'existing',
      loginMaterialSource: 'account_pool',
    })
    expect(toReauthorizeTaskInput(form)).not.toHaveProperty('proxyChoice')
    expect(toReauthorizeTaskInput(form)).not.toHaveProperty('allowDuplicateCreation')
  })

  it('maps manual mailbox access without adding create-account options', () => {
    const form = createReauthorizationFormState()
    const memory = createReauthorizationCredentialMemory()
    selectReauthorizationAccount(form, memory, {
      id: 72,
      name: 'Mailbox account',
      email: 'mailbox@example.invalid',
      status: 'error',
      usage7dPercent: 42,
    })
    form.materialSource = 'manual'
    form.loginMode = 'email_otp'
    form.mailboxAccess = 'synthetic-mailbox-access'

    expect(canStartReauthorization(form, true, false)).toBe(true)
    const input = toReauthorizeTaskInput(form)
    expect(input).toEqual({
      accountId: 72,
      accountEmail: 'mailbox@example.invalid',
      maxUsage7dPercent: 90,
      proxyMode: 'existing',
      loginMaterialSource: 'manual',
      loginMaterial: {
        kind: 'email_otp',
        mailboxAccess: 'synthetic-mailbox-access',
      },
    })
    expect(input).not.toHaveProperty('proxyChoice')
    expect(input).not.toHaveProperty('concurrency')
    expect(input).not.toHaveProperty('groupIds')
    expect(input).not.toHaveProperty('allowDuplicateCreation')
  })

  it('requires and maps manual password plus 2FA for the selected account', () => {
    const form = createReauthorizationFormState()
    const memory = createReauthorizationCredentialMemory()
    selectReauthorizationAccount(form, memory, {
      id: 73,
      name: 'Password account',
      email: 'password@example.invalid',
      status: 'error',
      usage7dPercent: 35,
    })
    form.materialSource = 'manual'
    form.loginMode = 'password_totp'
    form.accountPassword = '  synthetic password  '

    expect(canStartReauthorization(form, true, false)).toBe(false)
    form.totpSecret = 'jbsw y3dp-ehpk3pxp'
    expect(canStartReauthorization(form, true, false)).toBe(true)
    expect(toReauthorizeTaskInput(form)).toEqual({
      accountId: 73,
      accountEmail: 'password@example.invalid',
      maxUsage7dPercent: 90,
      proxyMode: 'existing',
      loginMaterialSource: 'manual',
      loginMaterial: {
        kind: 'password_totp',
        password: '  synthetic password  ',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    })
  })

  it('maps an explicit no-proxy reauthorization without create proxy fields', () => {
    const form = createReauthorizationFormState()
    const memory = createReauthorizationCredentialMemory()
    selectReauthorizationAccount(form, memory, {
      id: 74,
      name: 'Direct account',
      email: 'direct@example.invalid',
      status: 'error',
      usage7dPercent: 20,
    })
    form.proxyMode = 'none'

    expect(toReauthorizeTaskInput(form)).toMatchObject({ accountId: 74, proxyMode: 'none' })
    expect(toReauthorizeTaskInput(form)).not.toHaveProperty('proxyChoice')
  })

  it('keeps login materials isolated by target account id in current page memory', () => {
    const form = createReauthorizationFormState()
    const memory = createReauthorizationCredentialMemory()
    const first = { id: 71, name: 'First', email: 'first@example.invalid', status: 'error', usage7dPercent: 80 }
    const second = { id: 72, name: 'Second', email: 'second@example.invalid', status: 'error', usage7dPercent: 70 }

    selectReauthorizationAccount(form, memory, first)
    form.accountPassword = 'first-password'
    form.totpSecret = 'JBSWY3DPEHPK3PXP'
    rememberReauthorizationCredential(form, memory)
    selectReauthorizationAccount(form, memory, second)
    expect(form.accountPassword).toBe('')
    expect(form.totpSecret).toBe('')

    selectReauthorizationAccount(form, memory, first)
    expect(form.accountPassword).toBe('first-password')
    expect(form.totpSecret).toBe('JBSWY3DPEHPK3PXP')
  })
})

describe('relative account import time', () => {
  const now = Date.parse('2026-08-16T08:19:30.000Z')

  it('shows recent account imports as a compact relative time', () => {
    expect(formatRelativeTime('2026-08-16T08:00:00.000Z', now)).toBe('19分钟前')
    expect(formatRelativeTime('2026-08-16T08:19:20.000Z', now)).toBe('刚刚')
  })

  it('uses a stable fallback for missing or invalid backend timestamps', () => {
    expect(formatRelativeTime(null, now)).toBe('时间未知')
    expect(formatRelativeTime('invalid', now)).toBe('时间未知')
    expect(formatExactTime('invalid')).toBe('')
  })
})
