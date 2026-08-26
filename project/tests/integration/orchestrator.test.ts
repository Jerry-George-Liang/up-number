import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/shared/errors'
import type { CreateTaskInput, OptionsSnapshot, PublicTask, ReauthorizeTaskInput } from '../../src/shared/contracts'
import type { OAuthBrowserSession } from '../../src/server/browser/types'
import type { MailBaseline } from '../../src/server/mail/otp'
import { SecretScope } from '../../src/server/security/secret-scope'
import { TaskDatabase } from '../../src/server/storage/database'
import { TaskOrchestrator, type TaskOrchestratorDependencies } from '../../src/server/tasks/orchestrator'

const databases: TaskDatabase[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

const input: CreateTaskInput = {
  accountEmail: 'user@example.invalid',
  loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
  proxyChoice: { mode: 'none' },
  concurrency: 10,
  supplier: null,
  groupIds: [],
  allowDuplicateCreation: false,
  confirmMixedChannelRisk: false,
}

const reauthorizationInput: ReauthorizeTaskInput = {
  accountId: 71,
  accountEmail: 'user@example.invalid',
  maxUsage7dPercent: 90,
  loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
}

const snapshot: OptionsSnapshot = {
  version: 'v1',
  loadedAt: '2026-08-11T08:00:00.000Z',
  proxies: [],
  subscriptions: [],
  suppliers: [],
  groups: [],
}

const generatedAuthUrl =
  'https://auth.openai.com/oauth/authorize?client_id=synthetic-client&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=expected-state'

function generatedAttempt(attempt: 1 | 2) {
  const state = `deactivation-state-${attempt}`
  return {
    authUrl: generatedAuthUrl.replace('state=expected-state', `state=${state}`),
    sessionId: `backend-session-${attempt}`,
    state,
  }
}

function independentDeactivationOAuth() {
  return {
    checkMixedChannel: vi.fn(async () => ({ hasRisk: false })),
    generateAuthUrl: vi
      .fn()
      .mockResolvedValueOnce(generatedAttempt(1))
      .mockResolvedValueOnce(generatedAttempt(2)),
    exchangeCode: vi.fn(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function session(overrides: Partial<OAuthBrowserSession> = {}): OAuthBrowserSession {
  return {
    submitEmail: vi.fn(async (_email, _preferredLogin, beforeOtpRequest) => {
      await beforeOtpRequest?.()
      return { kind: 'submitted' as const }
    }),
    submitPassword: vi.fn(async () => ({ kind: 'submitted' as const })),
    resendOtp: vi.fn(async (beforeOtpRequest) => {
      await beforeOtpRequest?.()
      return { kind: 'submitted' as const }
    }),
    submitEmailOtp: vi.fn(async () => ({ kind: 'submitted' as const })),
    submitAuthenticatorTotp: vi.fn(async () => ({ kind: 'submitted' as const })),
    classifyCurrentPage: vi.fn(async () => ({ kind: 'consent' as const, submitSelector: 'button[type="submit"]' })),
    waitForManualProgress: vi.fn(async () => ({ kind: 'callback_captured' as const })),
    submitConsent: vi.fn(async () => ({ kind: 'submitted' as const })),
    waitForCallback: vi.fn(async () => ({ code: 'oauth-code', state: 'expected-state' })),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

function harness(overrides: Partial<TaskOrchestratorDependencies> = {}) {
  const database = new TaskDatabase(':memory:')
  databases.push(database)
  const browserSession = session()
  const secretScopes: SecretScope[] = []
  const dependencies: TaskOrchestratorDependencies = {
    database,
    options: { loadSnapshot: vi.fn(async () => snapshot) },
    accountCreator: {
      findExactDuplicate: vi.fn(async () => null),
      createAndConfirm: vi.fn(async () => ({ id: 71, name: 'user@example.invalid', status: 'active' })),
    },
    accountReauthorizer: {
      loadTarget: vi.fn(async () => ({
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
      })),
      assertOAuthEmail: vi.fn(),
      assertUnchanged: vi.fn(),
      applyAndConfirm: vi.fn(async (_target, _credentials, _onUncertain, onApplied) => {
        onApplied()
        return {
          id: 71,
          name: 'user@example.invalid',
          status: 'active',
        }
      }),
      markMailboxExpired: vi.fn(async () => ({
        id: 71,
        name: 'user@example.invalid（邮箱接码过期）',
        status: 'error',
      })),
    },
    mail: {
      establishBaseline: vi.fn(async () => ({ messageIds: new Set(), fingerprints: new Set() }) as MailBaseline),
      waitForOtp: vi.fn(async () => ({ kind: 'found' as const, code: '246810' })),
    },
    proxyResolver: { resolve: vi.fn(async () => ({ mode: 'none' as const })) },
    oauth: {
      checkMixedChannel: vi.fn(async () => ({ hasRisk: false })),
      generateAuthUrl: vi.fn(async () => ({
        authUrl: generatedAuthUrl,
        sessionId: 'backend-session',
        state: 'expected-state',
      })),
      exchangeCode: vi.fn(async () => ({
        access_token: 'access-value',
        refresh_token: 'refresh-value',
        email: 'user@example.invalid',
      })),
    },
    browser: {
      start: vi.fn(async (browserInput) => {
        browserInput.onBrowserStarted?.()
        browserInput.onAuthorizationUrlOpened?.({
          initialNavigation: {
            origin: 'https://auth.openai.com',
            path: '/oauth/authorize',
            totalLength: generatedAuthUrl.length,
            parameterCount: 9,
            parameterNames: [
              'client_id',
              'code_challenge',
              'code_challenge_method',
              'codex_cli_simplified_flow',
              'id_token_add_organizations',
              'redirect_uri',
              'response_type',
              'scope',
              'state',
            ],
            parameterFingerprint: '0123456789abcdef',
          },
          redirect: { origin: 'https://auth.openai.com', path: '/log-in' },
        })
        return browserSession
      }),
    },
    createSecretScope: () => {
      const scope = new SecretScope()
      secretScopes.push(scope)
      return scope
    },
    id: () => 'task-orchestrator-1',
    now: () => new Date('2026-08-11T08:00:00.000Z'),
    ...overrides,
  }
  const orchestrator = new TaskOrchestrator(dependencies)
  return { orchestrator, dependencies, database, browserSession, secretScopes }
}

describe('TaskOrchestrator', () => {
  it('pauses at the first safe browser boundary until manual takeover is released', async () => {
    const setup = harness()
    const controlledSession = setup.browserSession
    let takeoverTask: PublicTask | null = null
    let takeoverRequested = false
    const unsubscribe = setup.orchestrator.subscribe((task) => {
      if (task.stage === 'browser_started' && !takeoverRequested) {
        takeoverRequested = true
        takeoverTask = setup.orchestrator.takeOver(task.id)
      }
    })

    const started = setup.orchestrator.start(input)
    await vi.waitFor(() => expect(takeoverTask).not.toBeNull())
    await Promise.resolve()

    expect(takeoverTask).toMatchObject({ manualTakeover: true, status: 'active' })
    expect(controlledSession.submitEmail).not.toHaveBeenCalled()
    expect(setup.orchestrator.releaseTakeover(started.id)).toMatchObject({ manualTakeover: false })
    await expect(setup.orchestrator.waitForCompletion(started.id)).resolves.toMatchObject({ stage: 'completed' })
    expect(controlledSession.submitEmail).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('atomically reserves execution from ordinary local tasks and consumes the reservation on start', async () => {
    const setup = harness()
    const reservation = setup.orchestrator.reserveExternalExecution()

    expect(() => setup.orchestrator.start(input)).toThrow(
      expect.objectContaining({ code: 'TASK_ALREADY_ACTIVE' }),
    )

    const started = setup.orchestrator.startReserved(reservation, input)
    expect(() => setup.orchestrator.start(input)).toThrow(
      expect.objectContaining({ code: 'TASK_ALREADY_ACTIVE' }),
    )
    await expect(setup.orchestrator.waitForCompletion(started.id)).resolves.toMatchObject({
      stage: 'completed',
    })
  })

  it('releases an unused external execution reservation', async () => {
    const setup = harness()
    const reservation = setup.orchestrator.reserveExternalExecution()

    setup.orchestrator.releaseExternalExecution(reservation)

    await expect(
      setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id),
    ).resolves.toMatchObject({ stage: 'completed' })
  })

  it('runs the central create hook immediately before the backend create', async () => {
    const order: string[] = []
    const setup = harness({
      accountCreator: {
        findExactDuplicate: vi.fn(async () => null),
        createAndConfirm: vi.fn(async () => {
          order.push('backend-create')
          return { id: 71, name: 'user@example.invalid', status: 'active' }
        }),
      },
    })
    const beforeBackendWrite = vi.fn(async (stage: string) => {
      await Promise.resolve()
      order.push(`hook:${stage}`)
    })
    const reservation = setup.orchestrator.reserveExternalExecution()

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReserved(reservation, input, { beforeBackendWrite }).id,
    )

    expect(finished.stage).toBe('completed')
    expect(beforeBackendWrite).toHaveBeenCalledOnce()
    expect(order).toEqual(['hook:creating_account', 'backend-create'])
  })

  it('runs the central reauthorization hook immediately before applying credentials', async () => {
    const order: string[] = []
    const setup = harness()
    vi.mocked(setup.dependencies.accountReauthorizer.applyAndConfirm).mockImplementationOnce(
      async (_target, _credentials, _onUncertain, onApplied) => {
        order.push('backend-reauthorize')
        onApplied()
        return { id: 71, name: 'user@example.invalid', status: 'active' }
      },
    )
    const beforeBackendWrite = vi.fn(async (stage: string) => {
      await Promise.resolve()
      order.push(`hook:${stage}`)
    })
    const reservation = setup.orchestrator.reserveExternalExecution()

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReservedReauthorization(reservation, reauthorizationInput, {
        beforeBackendWrite,
      }).id,
    )

    expect(finished.stage).toBe('completed')
    expect(beforeBackendWrite).toHaveBeenCalledOnce()
    expect(order).toEqual(['hook:applying_oauth_credentials', 'backend-reauthorize'])
  })

  it('uses two independent OAuth sessions and bans one exact account only after both report deactivation', async () => {
    const order: string[] = []
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const secondSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const locateCreateTarget = vi.fn(async () => ({
      kind: 'unique' as const,
      account: {
        id: 81,
        name: 'user@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentialEmail: 'user@example.invalid',
      },
    }))
    const markBanned = vi.fn(async () => {
      order.push('backend-ban')
      return {
        kind: 'banned' as const,
        account: { id: 81, name: 'user@example.invalid', status: 'banned' },
      }
    })
    const setup = harness({
      oauth: {
        checkMixedChannel: vi.fn(async () => ({ hasRisk: false })),
        generateAuthUrl: vi
          .fn()
          .mockResolvedValueOnce(generatedAttempt(1))
          .mockResolvedValueOnce(generatedAttempt(2)),
        exchangeCode: vi.fn(),
      },
      browser: {
        start: vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession),
      },
      accountDeactivation: { locateCreateTarget, markBanned },
    })

    const beforeBackendWrite = vi.fn(async (stage: string) => {
      await Promise.resolve()
      order.push(`hook:${stage}`)
    })
    const reservation = setup.orchestrator.reserveExternalExecution()
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReserved(reservation, input, { beforeBackendWrite }).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      status: 'error',
      account: { id: 81, status: 'banned' },
      error: { code: 'OPENAI_ACCOUNT_DEACTIVATED_BANNED' },
      deactivation: {
        detectedCount: 2,
        retryAttempted: true,
        confirmed: true,
        targetAccountId: 81,
        banResult: 'banned',
      },
    })
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.browser.start).toHaveBeenCalledTimes(2)
    expect(vi.mocked(setup.dependencies.browser.start).mock.calls.map(([value]) => value.authUrl)).toEqual([
      generatedAttempt(1).authUrl,
      generatedAttempt(2).authUrl,
    ])
    expect(firstSession.submitEmailOtp).toHaveBeenCalledOnce()
    expect(secondSession.submitEmailOtp).toHaveBeenCalledOnce()
    expect(firstSession.close).toHaveBeenCalledOnce()
    expect(secondSession.close).toHaveBeenCalledOnce()
    expect(locateCreateTarget).toHaveBeenCalledWith('user@example.invalid')
    expect(markBanned).toHaveBeenCalledWith(81, 'user@example.invalid', 2)
    expect(beforeBackendWrite).toHaveBeenCalledOnce()
    expect(order).toEqual(['hook:marking_account_banned', 'backend-ban'])
    expect(setup.dependencies.oauth.exchangeCode).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('bans after the first explicit deactivation when confirmation attempts is one', async () => {
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const locateCreateTarget = vi.fn(async () => ({
      kind: 'unique' as const,
      account: {
        id: 81,
        name: 'user@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentialEmail: 'user@example.invalid',
      },
    }))
    const markBanned = vi.fn(async () => ({
      kind: 'banned' as const,
      account: { id: 81, name: 'user@example.invalid', status: 'banned' },
    }))
    const setup = harness({
      deactivationConfirmationAttempts: () => 1,
      browser: { start: vi.fn(async () => firstSession) },
      accountDeactivation: { locateCreateTarget, markBanned },
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.deactivation).toMatchObject({
      detectedCount: 1,
      confirmationAttempts: 1,
      retryAttempted: false,
      confirmed: true,
      banResult: 'banned',
    })
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledOnce()
    expect(setup.dependencies.browser.start).toHaveBeenCalledOnce()
    expect(markBanned).toHaveBeenCalledWith(81, 'user@example.invalid', 1)
  })

  it('continues normally without banning when the second independent authorization succeeds', async () => {
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const secondSession = session({
      waitForCallback: vi.fn(async () => ({ code: 'second-oauth-code', state: generatedAttempt(2).state })),
    })
    const markBanned = vi.fn()
    const setup = harness({
      oauth: {
        checkMixedChannel: vi.fn(async () => ({ hasRisk: false })),
        generateAuthUrl: vi
          .fn()
          .mockResolvedValueOnce(generatedAttempt(1))
          .mockResolvedValueOnce(generatedAttempt(2)),
        exchangeCode: vi.fn(async () => ({
          access_token: 'access-value',
          refresh_token: 'refresh-value',
          email: 'user@example.invalid',
        })),
      },
      browser: {
        start: vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession),
      },
      accountDeactivation: { locateCreateTarget: vi.fn(), markBanned },
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished).toMatchObject({ stage: 'completed', status: 'success' })
    expect(markBanned).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledWith({
      sessionId: generatedAttempt(2).sessionId,
      code: 'second-oauth-code',
      state: generatedAttempt(2).state,
    })
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledOnce()
    expect(firstSession.close).toHaveBeenCalledOnce()
    expect(secondSession.close).toHaveBeenCalledOnce()
  })

  it('preserves a deterministic ban gate rejection without marking the write uncertain', async () => {
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const secondSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated', { statusCode: 422 })
      }),
    })
    const markBanned = vi.fn(async () => ({
      kind: 'banned' as const,
      account: { id: 81, name: 'user@example.invalid', status: 'banned' },
    }))
    const setup = harness({
      oauth: independentDeactivationOAuth(),
      browser: { start: vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession) },
      accountDeactivation: {
        locateCreateTarget: vi.fn(async () => ({
          kind: 'unique' as const,
          account: {
            id: 81,
            name: 'user@example.invalid',
            status: 'error',
            platform: 'openai',
            type: 'oauth',
            credentialEmail: 'user@example.invalid',
          },
        })),
        markBanned,
      },
    })
    const beforeBackendWrite = vi.fn(async () => {
      throw new AppError('PROVISIONING_TASK_CANCELLED', 'central task cancelled', { statusCode: 409 })
    })
    const reservation = setup.orchestrator.reserveExternalExecution()

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReserved(reservation, input, { beforeBackendWrite }).id,
    )

    expect(beforeBackendWrite).toHaveBeenCalledWith('marking_account_banned')
    expect(markBanned).not.toHaveBeenCalled()
    expect(finished).toMatchObject({
      stage: 'failed',
      status: 'error',
      error: { code: 'PROVISIONING_TASK_CANCELLED' },
      deactivation: {
        detectedCount: 2,
        retryAttempted: true,
        confirmed: true,
        targetAccountId: 81,
        banResult: 'pending',
      },
    })
  })

  it('uses the locked reauthorization id and never searches by email before banning', async () => {
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated')
      }),
    })
    const secondSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated')
      }),
    })
    const locateCreateTarget = vi.fn()
    const markBanned = vi.fn(async () => ({
      kind: 'banned' as const,
      account: { id: 71, name: 'user@example.invalid', status: 'banned' },
    }))
    const setup = harness({
      oauth: independentDeactivationOAuth(),
      browser: { start: vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession) },
      accountDeactivation: { locateCreateTarget, markBanned },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      account: { id: 71, status: 'banned' },
      deactivation: { targetAccountId: 71, banResult: 'banned' },
    })
    expect(locateCreateTarget).not.toHaveBeenCalled()
    expect(markBanned).toHaveBeenCalledWith(71, 'user@example.invalid', 2)
    expect(setup.dependencies.accountReauthorizer.applyAndConfirm).not.toHaveBeenCalled()
  })

  it('does not ban when the second independent authorization cannot start', async () => {
    const markBanned = vi.fn()
    const firstSession = session({
      submitEmailOtp: vi.fn(async () => {
        throw new AppError('OPENAI_ACCOUNT_DEACTIVATED', 'deactivated')
      }),
    })
    const setup = harness({
      oauth: independentDeactivationOAuth(),
      browser: {
        start: vi
          .fn()
          .mockResolvedValueOnce(firstSession)
          .mockRejectedValueOnce(new AppError('BROWSER_NAVIGATION_FAILED', 'second session failed', {
            statusCode: 502,
          })),
      },
      accountDeactivation: { locateCreateTarget: vi.fn(), markBanned },
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'BROWSER_NAVIGATION_FAILED' },
      deactivation: { detectedCount: 1, confirmed: false, banResult: 'pending' },
    })
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.browser.start).toHaveBeenCalledTimes(2)
    expect(markBanned).not.toHaveBeenCalled()
  })

  it('rejects an invalid mailbox access URL before creating or persisting a task', () => {
    const setup = harness()
    const malformedInput = {
      ...input,
      loginMaterial: {
        kind: 'email_otp' as const,
        mailboxAccess:
          'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&pwd=synthetic-secret&limit=7',
      },
    }

    expect(() => setup.orchestrator.start(malformedInput)).toThrowError(
      expect.objectContaining({
        code: 'MAIL_ACCESS_URL_INVALID',
        message: '邮箱接口链接无效：limit 参数必须为 5。',
      }),
    )
    expect(setup.database.listTasks()).toEqual([])
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
  })

  it('extracts a full mailbox access URL before the task enters its secret scope', async () => {
    const setup = harness()
    const accessUrl =
      'https://icloud.thefindnet.xyz/api/mail.php?mail=user%40example.invalid&amp;pwd=synthetic%26secret'
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start({
        ...input,
        loginMaterial: { kind: 'email_otp', mailboxAccess: accessUrl },
      }).id,
    )

    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.mail.establishBaseline).toHaveBeenCalledWith(
      'user@example.invalid',
      'synthetic&secret',
      expect.any(AbortSignal),
      ['https://icloud-api.top', 'https://mail.mczero.top'],
    )
    expect(JSON.stringify(finished)).not.toContain(accessUrl)
  })

  it('runs the full path, performs two duplicate checks, and exposes no secrets', async () => {
    const setup = harness()
    const started = setup.orchestrator.start(input)
    expect(started).toMatchObject({ stage: 'validating', status: 'active' })
    const finished = await setup.orchestrator.waitForCompletion(started.id)
    expect(finished).toMatchObject({
      stage: 'completed',
      status: 'success',
      authorization: {
        source: 'backend_generate_auth_url',
        validated: true,
        navigationValidated: true,
        browserOpenedAt: expect.any(String),
        urlOpenedAt: expect.any(String),
        diagnostics: {
          generated: {
            path: '/oauth/authorize',
            parameterCount: 9,
            parameterNames: expect.arrayContaining(['client_id', 'code_challenge', 'state']),
            parameterFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
          },
          initialNavigation: {
            path: '/oauth/authorize',
            parameterFingerprint: '0123456789abcdef',
          },
          redirect: { path: '/log-in' },
        },
      },
      account: { id: 71, name: 'user@example.invalid', status: 'active' },
    })
    expect(setup.dependencies.accountCreator.findExactDuplicate).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.mail.establishBaseline).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.mail.waitForOtp).toHaveBeenCalledWith(
      input.accountEmail,
      'mail-secret',
      expect.objectContaining({ messageIds: expect.any(Set), fingerprints: expect.any(Set) }),
      new Date('2026-08-11T08:00:00.000Z'),
      expect.any(AbortSignal),
      ['https://icloud-api.top', 'https://mail.mczero.top'],
    )
    expect(setup.browserSession.resendOtp).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.checkMixedChannel).toHaveBeenCalledWith([])
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledWith({})
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledTimes(1)
    expect(setup.browserSession.submitConsent).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(finished)).not.toMatch(
      /mail-secret|access-value|refresh-value|oauth-code|246810|expected-state|backend-session|redirect_uri=http/,
    )
    expect(setup.secretScopes).toHaveLength(1)
    expect(setup.secretScopes[0]?.disposed).toBe(true)
    expect(setup.browserSession.close).toHaveBeenCalledTimes(1)
  })

  it('runs password + TOTP without calling any mailbox operation or persisting login material', async () => {
    const passwordInput: CreateTaskInput = {
      ...input,
      loginMaterial: {
        kind: 'password_totp',
        password: 'synthetic-account-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    }
    const controlledSession = session({
      classifyCurrentPage: vi.fn(async () => ({
        kind: 'authenticator_totp' as const,
        inputSelector: '#code',
        submitSelector: 'button[type="submit"]',
      })),
    })
    const next = vi.fn(async () => ({ code: '123456', counter: 41 }))
    const setup = harness({
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(passwordInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
    expect(setup.dependencies.mail.waitForOtp).not.toHaveBeenCalled()
    expect(controlledSession.resendOtp).not.toHaveBeenCalled()
    expect(controlledSession.submitEmailOtp).not.toHaveBeenCalled()
    expect(controlledSession.submitEmail).toHaveBeenCalledWith(
      'user@example.invalid',
      'password',
      undefined,
    )
    expect(controlledSession.submitPassword).toHaveBeenCalledWith('synthetic-account-password')
    expect(next).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', undefined, expect.any(AbortSignal))
    expect(controlledSession.submitAuthenticatorTotp).toHaveBeenCalledWith('123456')
    expect(JSON.stringify(finished)).not.toMatch(/synthetic-account-password|JBSWY3DPEHPK3PXP|123456/)
    expect(JSON.stringify(setup.database.listTasks())).not.toMatch(
      /synthetic-account-password|JBSWY3DPEHPK3PXP|123456/,
    )
    expect(setup.secretScopes[0]?.disposed).toBe(true)
  })

  it('resolves all account-pool materials once and prefers password + TOTP', async () => {
    const automaticInput: CreateTaskInput = {
      accountEmail: input.accountEmail,
      loginMaterialSource: 'account_pool',
      proxyChoice: input.proxyChoice,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groupIds: input.groupIds,
      allowDuplicateCreation: input.allowDuplicateCreation,
      confirmMixedChannelRisk: input.confirmMixedChannelRisk,
    }
    const resolve = vi.fn(async () => ({
      email: 'user@example.invalid',
      password: 'automatic-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      mailboxAccess: 'unused-mailbox-token',
    }))
    const controlledSession = session({
      classifyCurrentPage: vi.fn(async () => ({
        kind: 'authenticator_totp' as const,
        inputSelector: '#code',
        submitSelector: 'button[type="submit"]',
      })),
    })
    const next = vi.fn(async () => ({ code: '123456', counter: 41 }))
    const setup = harness({
      accountPool: { resolve },
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(automaticInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
    expect(setup.dependencies.mail.waitForOtp).not.toHaveBeenCalled()
    expect(controlledSession.submitPassword).toHaveBeenCalledWith('automatic-password')
    expect(next).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', undefined, expect.any(AbortSignal))
    expect(JSON.stringify(finished)).not.toMatch(/automatic-password|unused-mailbox-token|JBSWY3DPEHPK3PXP/)
  })

  it('tries reversed account-pool materials after an explicit password rejection', async () => {
    const automaticInput: CreateTaskInput = {
      accountEmail: input.accountEmail,
      loginMaterialSource: 'account_pool',
      proxyChoice: input.proxyChoice,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groupIds: input.groupIds,
      allowDuplicateCreation: input.allowDuplicateCreation,
      confirmMixedChannelRisk: input.confirmMixedChannelRisk,
    }
    const password = 'JBSWY3DPEHPK3PXP'
    const totpSecret = 'actual-password-with-any-length'
    const resolve = vi.fn(async () => ({
      email: 'user@example.invalid',
      password,
      totpSecret,
    }))
    const controlledSession = session({
      submitPassword: vi
        .fn()
        .mockRejectedValueOnce(
          new AppError('OPENAI_CREDENTIALS_REJECTED', 'OpenAI rejected the original password'),
        )
        .mockResolvedValueOnce({ kind: 'manual_intervention' as const, reason: 'credentials' as const })
        .mockResolvedValueOnce({ kind: 'manual_intervention' as const, reason: 'credentials' as const })
        .mockResolvedValueOnce({ kind: 'submitted' as const }),
      classifyCurrentPage: vi.fn(async () => ({
        kind: 'authenticator_totp' as const,
        inputSelector: '#code',
        submitSelector: 'button[type="submit"]',
      })),
    })
    const next = vi.fn(async () => ({ code: '123456', counter: 41 }))
    const setup = harness({
      accountPool: { resolve },
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })
    const messages: string[] = []
    setup.orchestrator.subscribe((task) => messages.push(task.message))

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(automaticInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(controlledSession.submitPassword).toHaveBeenNthCalledWith(1, password)
    expect(controlledSession.submitPassword).toHaveBeenNthCalledWith(2, `${password}-`, {
      allowCredentialsErrorPage: true,
    })
    expect(controlledSession.submitPassword).toHaveBeenNthCalledWith(3, `-${password}`, {
      allowCredentialsErrorPage: true,
    })
    expect(controlledSession.submitPassword).toHaveBeenNthCalledWith(4, totpSecret, {
      allowCredentialsErrorPage: true,
    })
    expect(next).toHaveBeenCalledWith(password, undefined, expect.any(AbortSignal))
    expect(messages).toContain('补全密码仍未通过，已交换密码和 2FA，正在继续尝试。')
    expect(JSON.stringify(finished)).not.toMatch(new RegExp(`${password}|${totpSecret}`))
  })

  it('does not reverse account-pool materials for a non-credential password interruption', async () => {
    const automaticInput: CreateTaskInput = {
      accountEmail: input.accountEmail,
      loginMaterialSource: 'account_pool',
      proxyChoice: input.proxyChoice,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groupIds: input.groupIds,
      allowDuplicateCreation: input.allowDuplicateCreation,
      confirmMixedChannelRisk: input.confirmMixedChannelRisk,
    }
    const password = 'JBSWY3DPEHPK3PXP'
    const totpSecret = 'actual-password-with-any-length'
    const controlledSession = session({
      submitPassword: vi.fn(async () => ({
        kind: 'manual_intervention' as const,
        reason: 'challenge' as const,
      })),
    })
    const next = vi.fn(async () => ({ code: '123456', counter: 41 }))
    const setup = harness({
      accountPool: {
        resolve: vi.fn(async () => ({
          email: 'user@example.invalid',
          password,
          totpSecret,
        })),
      },
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(automaticInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(controlledSession.submitPassword).toHaveBeenCalledTimes(1)
    expect(controlledSession.submitPassword).toHaveBeenCalledWith(password)
    expect(next).not.toHaveBeenCalled()
  })

  it('uses mailbox OTP when account-pool password materials are incomplete', async () => {
    const automaticInput: CreateTaskInput = {
      accountEmail: input.accountEmail,
      loginMaterialSource: 'account_pool',
      proxyChoice: input.proxyChoice,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groupIds: input.groupIds,
      allowDuplicateCreation: input.allowDuplicateCreation,
      confirmMixedChannelRisk: input.confirmMixedChannelRisk,
    }
    const setup = harness({
      accountPool: {
        resolve: vi.fn(async () => ({
          email: 'user@example.invalid',
          password: 'incomplete-password',
          mailboxAccess: 'automatic-mailbox-token',
        })),
      },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(automaticInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.mail.establishBaseline).toHaveBeenCalled()
    expect(setup.dependencies.mail.waitForOtp).toHaveBeenCalled()
    expect(setup.browserSession.submitPassword).not.toHaveBeenCalled()
    expect(JSON.stringify(finished)).not.toContain('automatic-mailbox-token')
  })

  it('fails before options, OAuth, and browser startup when account-pool materials are incomplete', async () => {
    const setup = harness({
      accountPool: {
        resolve: vi.fn(async () => ({
          email: 'user@example.invalid',
          password: 'incomplete-password',
        })),
      },
    })
    const automaticInput = {
      accountEmail: input.accountEmail,
      proxyChoice: input.proxyChoice,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groupIds: input.groupIds,
      allowDuplicateCreation: input.allowDuplicateCreation,
      confirmMixedChannelRisk: input.confirmMixedChannelRisk,
      loginMaterialSource: 'account_pool' as const,
    }

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(automaticInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'ACCOUNT_POOL_MATERIALS_INCOMPLETE' },
    })
    expect(setup.dependencies.options.loadSnapshot).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.generateAuthUrl).not.toHaveBeenCalled()
    expect(setup.dependencies.browser.start).not.toHaveBeenCalled()
    expect(setup.secretScopes[0]?.disposed).toBe(true)
  })

  it('adopts a callback completed by the user without briefly handing the password flow to manual control', async () => {
    const passwordInput: CreateTaskInput = {
      ...input,
      loginMaterial: {
        kind: 'password_totp',
        password: 'synthetic-account-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    }
    const controlledSession = session({
      classifyCurrentPage: vi.fn(async () => ({ kind: 'callback_captured' as const })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => controlledSession) } })
    const stages: string[] = []
    setup.orchestrator.subscribe((task) => stages.push(task.stage))

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(passwordInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(stages).not.toContain('manual_intervention')
    expect(stages).toContain('waiting_for_callback')
    expect(controlledSession.submitAuthenticatorTotp).not.toHaveBeenCalled()
    expect(controlledSession.submitConsent).not.toHaveBeenCalled()
  })

  it('submits at most one later-period TOTP when the first authenticator page remains active', async () => {
    const passwordInput: CreateTaskInput = {
      ...input,
      loginMaterial: {
        kind: 'password_totp',
        password: 'synthetic-account-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    }
    const controlledSession = session({
      classifyCurrentPage: vi.fn(async () => ({
        kind: 'authenticator_totp' as const,
        inputSelector: '#code',
        submitSelector: 'button[type="submit"]',
      })),
      submitAuthenticatorTotp: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'still_active' as const })
        .mockResolvedValueOnce({ kind: 'submitted' as const }),
    })
    const next = vi
      .fn()
      .mockResolvedValueOnce({ code: '123456', counter: 41 })
      .mockResolvedValueOnce({ code: '654321', counter: 42 })
    const setup = harness({
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(passwordInput).id,
    )

    expect(finished.stage).toBe('completed')
    expect(next).toHaveBeenCalledTimes(2)
    expect(next.mock.calls[1]?.[1]).toBe(41)
    expect(controlledSession.submitAuthenticatorTotp).toHaveBeenNthCalledWith(1, '123456')
    expect(controlledSession.submitAuthenticatorTotp).toHaveBeenNthCalledWith(2, '654321')
  })

  it('fails explicitly instead of requesting manual control when two generated TOTP values are rejected', async () => {
    const passwordInput: CreateTaskInput = {
      ...input,
      loginMaterial: {
        kind: 'password_totp',
        password: 'synthetic-account-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      },
    }
    const controlledSession = session({
      classifyCurrentPage: vi.fn(async () => ({
        kind: 'authenticator_totp' as const,
        inputSelector: '#code',
        submitSelector: 'button[type="submit"]',
      })),
      submitAuthenticatorTotp: vi.fn(async () => ({ kind: 'still_active' as const })),
    })
    const next = vi
      .fn()
      .mockResolvedValueOnce({ code: '123456', counter: 41 })
      .mockResolvedValueOnce({ code: '654321', counter: 42 })
    const setup = harness({
      browser: { start: vi.fn(async () => controlledSession) },
      totp: { next },
    })
    const stages: string[] = []
    setup.orchestrator.subscribe((task) => stages.push(task.stage))

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(passwordInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'OPENAI_CREDENTIALS_REJECTED' },
    })
    expect(stages).not.toContain('manual_intervention')
    expect(controlledSession.submitAuthenticatorTotp).toHaveBeenCalledTimes(2)
  })

  it('captures one trusted-origin snapshot for input validation and all mailbox calls', async () => {
    const customOrigins = ['https://icloud-api.top', 'https://mail.example.invalid']
    const setup = harness({ trustedPathOrigins: () => customOrigins })
    const accessUrl =
      'https://mail.example.invalid/s/private_synthetic_token_123/user%40example.invalid/'

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start({
        ...input,
        loginMaterial: { kind: 'email_otp', mailboxAccess: accessUrl },
      }).id,
    )

    expect(finished.stage).toBe('completed')
    for (const call of vi.mocked(setup.dependencies.mail.establishBaseline).mock.calls) {
      expect(call[3]).toEqual(customOrigins)
    }
    for (const call of vi.mocked(setup.dependencies.mail.waitForOtp).mock.calls) {
      expect(call[5]).toEqual(customOrigins)
    }
    expect(JSON.stringify(finished)).not.toContain('private_synthetic_token_123')
    expect(JSON.stringify(setup.database.listTasks())).not.toContain('private_synthetic_token_123')
  })

  it('refreshes and merges the baseline before every OTP-triggering browser action', async () => {
    let currentTime = new Date('2026-08-11T08:00:00.000Z')
    const initialBaseline: MailBaseline = {
      messageIds: new Set(['initial-message']),
      fingerprints: new Set(['initial-fingerprint']),
    }
    const emailSubmitBaseline: MailBaseline = {
      messageIds: new Set(['before-email-submit']),
      fingerprints: new Set(['before-email-fingerprint']),
    }
    const passwordChoiceBaseline: MailBaseline = {
      messageIds: new Set(['before-password-choice']),
      fingerprints: new Set(['before-password-fingerprint']),
    }
    const controlledSession = session({
      submitEmail: vi.fn(async (_email, _preferredLogin, beforeOtpRequest) => {
        currentTime = new Date('2026-08-11T08:00:05.000Z')
        await beforeOtpRequest?.()
        currentTime = new Date('2026-08-11T08:00:10.000Z')
        await beforeOtpRequest?.()
        return { kind: 'submitted' as const }
      }),
    })
    const establishBaseline = vi
      .fn()
      .mockResolvedValueOnce(initialBaseline)
      .mockResolvedValueOnce(emailSubmitBaseline)
      .mockResolvedValueOnce(passwordChoiceBaseline)
    const waitForOtp = vi.fn<TaskOrchestratorDependencies['mail']['waitForOtp']>(async () => ({
      kind: 'found',
      code: '246810',
    }))
    const setup = harness({
      mail: { establishBaseline, waitForOtp },
      browser: { start: vi.fn(async () => controlledSession) },
      now: () => currentTime,
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(establishBaseline).toHaveBeenCalledTimes(3)
    const firstOtpCall = waitForOtp.mock.calls[0]
    expect(firstOtpCall).toBeDefined()
    const baseline = firstOtpCall![2]
    expect([...baseline.messageIds].sort()).toEqual([
      'before-email-submit',
      'before-password-choice',
      'initial-message',
    ])
    expect([...baseline.fingerprints].sort()).toEqual([
      'before-email-fingerprint',
      'before-password-fingerprint',
      'initial-fingerprint',
    ])
    expect(firstOtpCall![3]).toEqual(new Date('2026-08-11T08:00:10.000Z'))
  })

  it('accepts an existing same-code message after a verified resend', async () => {
    let currentTime = new Date('2026-08-11T08:00:00.000Z')
    const initialBaseline: MailBaseline = {
      messageIds: new Set(['initial']),
      fingerprints: new Set(['initial-fingerprint']),
    }
    const emailBaseline: MailBaseline = {
      messageIds: new Set(['before-email']),
      fingerprints: new Set(['before-email-fingerprint']),
    }
    const resendBaseline: MailBaseline = {
      messageIds: new Set(['first-round-message']),
      fingerprints: new Set(['first-round-fingerprint']),
    }
    const establishBaseline = vi
      .fn()
      .mockResolvedValueOnce(initialBaseline)
      .mockImplementationOnce(async () => {
        currentTime = new Date('2026-08-11T08:00:01.000Z')
        return emailBaseline
      })
      .mockImplementationOnce(async () => {
        currentTime = new Date('2026-08-11T08:00:31.000Z')
        return resendBaseline
      })
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
      .mockResolvedValueOnce({ kind: 'found', code: '135790' })
    const controlledSession = session()
    const setup = harness({
      mail: { establishBaseline, waitForOtp },
      browser: { start: vi.fn(async () => controlledSession) },
      now: () => currentTime,
    })
    const stages: string[] = []
    const messages: string[] = []
    setup.orchestrator.subscribe((task) => {
      stages.push(task.stage)
      messages.push(task.message)
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(stages).toEqual(expect.arrayContaining(['waiting_for_otp', 'resending_otp', 'waiting_for_otp_retry']))
    expect(messages).toContain('第一轮未取得可靠验证码，正在重新发送验证码。')
    expect(controlledSession.resendOtp).toHaveBeenCalledTimes(1)
    expect(controlledSession.submitEmailOtp).toHaveBeenCalledWith('135790')
    expect(waitForOtp).toHaveBeenCalledTimes(2)
    const secondRound = waitForOtp.mock.calls[1]
    expect(secondRound?.[2]).toEqual({
      messageIds: new Set(['initial', 'before-email']),
      fingerprints: new Set(['initial-fingerprint', 'before-email-fingerprint']),
    })
    expect(secondRound?.[3]).toEqual(new Date('2026-08-11T08:00:01.000Z'))
  })

  it('resends twice and submits a code found during the third OTP round', async () => {
    let currentTime = new Date('2026-08-11T08:00:00.000Z')
    let baselineIndex = 0
    const baselineSnapshots = [
      {
        at: new Date('2026-08-11T08:00:00.000Z'),
        baseline: { messageIds: new Set(['initial']), fingerprints: new Set(['initial-fingerprint']) },
      },
      {
        at: new Date('2026-08-11T08:00:01.000Z'),
        baseline: { messageIds: new Set(['email']), fingerprints: new Set(['email-fingerprint']) },
      },
      {
        at: new Date('2026-08-11T08:00:31.000Z'),
        baseline: { messageIds: new Set(['first-resend']), fingerprints: new Set(['first-resend-fingerprint']) },
      },
      {
        at: new Date('2026-08-11T08:01:01.000Z'),
        baseline: { messageIds: new Set(['second-resend']), fingerprints: new Set(['second-resend-fingerprint']) },
      },
    ]
    const establishBaseline = vi.fn(async () => {
      const snapshot = baselineSnapshots[baselineIndex++]!
      currentTime = snapshot.at
      return snapshot.baseline
    })
    const controlledSession = session()
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
      .mockResolvedValueOnce({ kind: 'ambiguous', reason: 'order_changed' })
      .mockResolvedValueOnce({ kind: 'found', code: '246802' })
    const setup = harness({
      mail: {
        establishBaseline,
        waitForOtp,
      },
      browser: { start: vi.fn(async () => controlledSession) },
      now: () => currentTime,
    })
    const stages: string[] = []
    setup.orchestrator.subscribe((task) => stages.push(task.stage))

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(stages).toEqual(expect.arrayContaining([
      'waiting_for_otp',
      'resending_otp',
      'waiting_for_otp_retry',
      'resending_otp_second',
      'waiting_for_otp_third',
    ]))
    expect(waitForOtp).toHaveBeenCalledTimes(3)
    expect(controlledSession.resendOtp).toHaveBeenCalledTimes(2)
    expect(controlledSession.submitEmailOtp).toHaveBeenCalledWith('246802')
    const thirdRound = waitForOtp.mock.calls[2]
    expect(thirdRound?.[2]).toEqual({
      messageIds: new Set(['initial', 'email']),
      fingerprints: new Set(['initial-fingerprint', 'email-fingerprint']),
    })
    expect(thirdRound?.[3]).toEqual(new Date('2026-08-11T08:00:01.000Z'))
  })

  it('keeps the incognito browser open after all three OTP rounds end without a safe code', async () => {
    const callback = deferred<{ code: string; state: string }>()
    const manualReached = deferred<void>()
    const controlledSession = session({
      waitForManualProgress: vi.fn(async () => {
        await callback.promise
        return { kind: 'callback_captured' as const }
      }),
      waitForCallback: vi.fn(() => callback.promise),
    })
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
      .mockResolvedValueOnce({ kind: 'ambiguous', reason: 'order_changed' })
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: true })
    const setup = harness({
      mail: {
        establishBaseline: vi.fn(async () => ({
          messageIds: new Set<string>(),
          fingerprints: new Set<string>(),
        })),
        waitForOtp,
      },
      browser: { start: vi.fn(async () => controlledSession) },
    })
    setup.orchestrator.subscribe((task) => {
      if (task.stage === 'manual_intervention') manualReached.resolve()
    })

    const started = setup.orchestrator.start(input)
    await manualReached.promise

    expect(setup.orchestrator.activeTask).toMatchObject({
      stage: 'manual_intervention',
      status: 'active',
      message: expect.stringContaining('三轮等待结束'),
    })
    expect(waitForOtp).toHaveBeenCalledTimes(3)
    expect(controlledSession.resendOtp).toHaveBeenCalledTimes(2)
    expect(controlledSession.submitEmailOtp).not.toHaveBeenCalled()
    expect(controlledSession.close).not.toHaveBeenCalled()
    callback.resolve({ code: 'oauth-code', state: 'expected-state' })
    await expect(setup.orchestrator.waitForCompletion(started.id)).resolves.toMatchObject({ stage: 'completed' })
    expect(controlledSession.close).toHaveBeenCalledTimes(1)
  })

  it('keeps polling from the pre-resend baseline when the user clicks before automation', async () => {
    let currentTime = new Date('2026-08-11T08:00:00.000Z')
    const initialBaseline: MailBaseline = {
      messageIds: new Set(['initial']),
      fingerprints: new Set(['initial-fingerprint']),
    }
    const emailBaseline: MailBaseline = {
      messageIds: new Set(['before-email']),
      fingerprints: new Set(['before-email-fingerprint']),
    }
    const racedBaseline: MailBaseline = {
      messageIds: new Set(['possibly-user-triggered-message']),
      fingerprints: new Set(['possibly-user-triggered-fingerprint']),
    }
    const establishBaseline = vi
      .fn()
      .mockResolvedValueOnce(initialBaseline)
      .mockImplementationOnce(async () => {
        currentTime = new Date('2026-08-11T08:00:01.000Z')
        return emailBaseline
      })
      .mockImplementationOnce(async () => {
        currentTime = new Date('2026-08-11T08:00:31.000Z')
        return racedBaseline
      })
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
      .mockResolvedValueOnce({ kind: 'found', code: '135790' })
    const controlledSession = session({
      resendOtp: vi.fn(async (beforeOtpRequest) => {
        await beforeOtpRequest?.()
        return { kind: 'continue_polling' as const }
      }),
    })
    const setup = harness({
      mail: { establishBaseline, waitForOtp },
      browser: { start: vi.fn(async () => controlledSession) },
      now: () => currentTime,
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(waitForOtp).toHaveBeenCalledTimes(2)
    const secondRound = waitForOtp.mock.calls[1]
    expect(secondRound?.[2]).toEqual({
      messageIds: new Set(['initial', 'before-email']),
      fingerprints: new Set(['initial-fingerprint', 'before-email-fingerprint']),
    })
    expect(secondRound?.[3]).toEqual(new Date('2026-08-11T08:00:01.000Z'))
    expect(controlledSession.submitEmailOtp).toHaveBeenCalledWith('135790')
  })

  it('continues from a verified consent page reached by the user during OTP waiting', async () => {
    const controlledSession = session({
      resendOtp: vi.fn(async () => ({ kind: 'consent_ready' as const })),
    })
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
    const setup = harness({
      mail: {
        establishBaseline: vi.fn(async () => ({
          messageIds: new Set<string>(),
          fingerprints: new Set<string>(),
        })),
        waitForOtp,
      },
      browser: { start: vi.fn(async () => controlledSession) },
    })
    const stages: string[] = []
    setup.orchestrator.subscribe((task) => stages.push(task.stage))

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(stages).toEqual(expect.arrayContaining(['resending_otp', 'otp_submitted', 'waiting_for_consent']))
    expect(waitForOtp).toHaveBeenCalledTimes(1)
    expect(controlledSession.submitEmailOtp).not.toHaveBeenCalled()
    expect(controlledSession.submitConsent).toHaveBeenCalledTimes(1)
  })

  it('does not start a second mail round when the callback is captured before resend', async () => {
    const controlledSession = session({
      resendOtp: vi.fn(async () => ({ kind: 'callback_captured' as const })),
    })
    const waitForOtp = vi
      .fn<TaskOrchestratorDependencies['mail']['waitForOtp']>()
      .mockResolvedValueOnce({ kind: 'timed_out', observedCandidates: false })
    const setup = harness({
      mail: {
        establishBaseline: vi.fn(async () => ({
          messageIds: new Set<string>(),
          fingerprints: new Set<string>(),
        })),
        waitForOtp,
      },
      browser: { start: vi.fn(async () => controlledSession) },
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(waitForOtp).toHaveBeenCalledTimes(1)
    expect(controlledSession.submitEmailOtp).not.toHaveBeenCalled()
    expect(controlledSession.submitConsent).not.toHaveBeenCalled()
  })

  it('keeps the latest generated authorization URL only in memory for local inspection', async () => {
    const setup = harness()
    const started = setup.orchestrator.start(input)
    const finished = await setup.orchestrator.waitForCompletion(started.id)

    expect(setup.orchestrator.getAuthorizationUrl(started.id)).toBe(generatedAuthUrl)
    expect(JSON.stringify(finished)).not.toContain(generatedAuthUrl)
    expect(JSON.stringify(setup.database.getTask(started.id))).not.toContain(generatedAuthUrl)
    setup.orchestrator.forgetAuthorizationUrl(started.id)
    expect(setup.orchestrator.getAuthorizationUrl(started.id)).toBeNull()
  })

  it('stops before mailbox and browser work when the account already exists', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountCreator.findExactDuplicate).mockResolvedValueOnce({
      id: 70,
      name: 'user@example.invalid',
      status: 'active',
      platform: 'openai',
      type: 'oauth',
    })
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(finished).toMatchObject({ stage: 'already_exists', account: { id: 70 } })
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
    expect(setup.dependencies.browser.start).not.toHaveBeenCalled()
  })

  it('requires explicit mixed-channel confirmation before mailbox and OAuth work', async () => {
    const setup = harness({
      oauth: {
        checkMixedChannel: vi.fn(async () => ({ hasRisk: true })),
        generateAuthUrl: vi.fn(),
        exchangeCode: vi.fn(),
      },
    })
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'MIXED_CHANNEL_CONFIRMATION_REQUIRED' },
    })
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.generateAuthUrl).not.toHaveBeenCalled()
  })

  it('includes confirmed mixed-channel risk in the final create payload', async () => {
    const setup = harness({
      oauth: {
        checkMixedChannel: vi.fn(async () => ({ hasRisk: true })),
        generateAuthUrl: vi.fn(async () => ({
          authUrl: generatedAuthUrl,
          sessionId: 'backend-session',
          state: 'expected-state',
        })),
        exchangeCode: vi.fn(async () => ({ access_token: 'access-value' })),
      },
    })
    const confirmedInput = { ...input, confirmMixedChannelRisk: true }
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(confirmedInput).id,
    )
    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirm_mixed_channel_risk: true }),
    )
  })

  it('passes a machine-only proxy through OAuth generation and account creation', async () => {
    const machineSnapshot: OptionsSnapshot = {
      ...snapshot,
      proxies: [{ id: -41, name: 'Machine only', proxyMachineId: 41 }],
    }
    const setup = harness({
      options: { loadSnapshot: vi.fn(async () => machineSnapshot) },
      proxyResolver: {
        resolve: vi.fn(async () => ({
          mode: 'fixed' as const,
          machineId: 41,
          proxyName: 'Machine only',
          browserProxy: { server: 'socks5://127.0.0.1:9000' },
        })),
      },
    })
    const machineInput: CreateTaskInput = {
      ...input,
      proxyChoice: { mode: 'fixed', proxyId: -41 },
    }
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.start(machineInput).id,
    )
    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.proxyResolver.resolve).toHaveBeenCalledWith(
      machineInput.proxyChoice,
      machineSnapshot,
      'user@example.invalid',
    )
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledWith({ machineId: 41 })
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledWith(
      expect.not.objectContaining({ proxyId: expect.anything() }),
    )
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ proxy_id: null, machine_id: 41 }),
    )
  })

  it('maps a late backend mixed-channel warning without retrying create', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountCreator.createAndConfirm).mockRejectedValueOnce(
      new AppError('mixed_channel_warning', 'confirmation required', { statusCode: 409 }),
    )
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'MIXED_CHANNEL_CONFIRMATION_REQUIRED' },
    })
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledTimes(1)
  })

  it('performs a final duplicate check after exchange and skips create on a race', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountCreator.findExactDuplicate)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 72,
        name: 'user@example.invalid',
        status: 'active',
        platform: 'openai',
        type: 'oauth',
      })
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(finished).toMatchObject({ stage: 'already_exists', account: { id: 72 } })
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('allows an explicit duplicate creation without either local duplicate lookup', async () => {
    const setup = harness()
    const duplicateInput = { ...input, allowDuplicateCreation: true }
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(duplicateInput).id)
    expect(finished).toMatchObject({
      stage: 'completed',
      selection: { allowDuplicateCreation: true },
    })
    expect(setup.dependencies.accountCreator.findExactDuplicate).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps listening for a callback after handing an unknown page to the user', async () => {
    const manualSession = session({
      submitEmail: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'challenge' as const })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    const stages: string[] = []
    let manualMessage = ''
    setup.orchestrator.subscribe((task) => {
      stages.push(task.stage)
      if (task.stage === 'manual_intervention') manualMessage = task.message
    })
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(stages).toContain('manual_intervention')
    expect(manualMessage).toContain('OpenAI 页面要求完成安全验证')
    expect(manualMessage).toContain('验证码轮询尚未开始')
    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.mail.waitForOtp).not.toHaveBeenCalled()
  })

  it('resumes create automation after the user advances an unexpected email step', async () => {
    const submitEmail = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'manual_intervention' as const, reason: 'challenge' as const })
      .mockResolvedValueOnce({ kind: 'submitted' as const })
    const manualSession = session({
      submitEmail,
      waitForManualProgress: vi.fn(async () => ({
        kind: 'email' as const,
        inputSelector: 'input[type="email"]',
        submitSelector: 'button[type="submit"]',
      })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    const messages: string[] = []
    setup.orchestrator.subscribe((task) => messages.push(task.message))

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished.stage).toBe('completed')
    expect(submitEmail).toHaveBeenCalledTimes(2)
    expect(manualSession.waitForManualProgress).toHaveBeenCalledWith(expect.objectContaining({
      blockedPage: 'email',
      preferredLogin: 'email_otp',
      requireActivityOnBlockedPage: false,
    }))
    expect(messages).toContain('已检测到人工操作进展，正在从当前页面继续自动化。')
    expect(setup.dependencies.mail.waitForOtp).toHaveBeenCalledOnce()
  })

  it('resumes reauthorization at consent and still updates only the original account', async () => {
    const manualSession = session({
      submitEmail: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'unknown' as const })),
      waitForManualProgress: vi.fn(async () => ({
        kind: 'consent' as const,
        submitSelector: 'button[type="submit"]',
      })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'completed',
      selection: { operation: 'reauthorize', targetAccountId: 71 },
    })
    expect(manualSession.waitForManualProgress).toHaveBeenCalledWith(expect.objectContaining({
      blockedPage: 'email',
      requireActivityOnBlockedPage: true,
    }))
    expect(manualSession.submitConsent).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountReauthorizer.applyAndConfirm).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('automatically exchanges a callback captured after takeover and updates the original account once', async () => {
    const manualSession = session({
      submitEmail: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'challenge' as const })),
      waitForManualProgress: vi.fn(async () => ({ kind: 'callback_captured' as const })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    const stages: string[] = []
    setup.orchestrator.subscribe((task) => stages.push(task.stage))

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'completed',
      status: 'success',
      selection: { operation: 'reauthorize', targetAccountId: 71 },
    })
    expect(stages).toEqual(expect.arrayContaining([
      'manual_intervention',
      'waiting_for_callback',
      'exchanging_code',
      'applying_oauth_credentials',
      'confirming_reauthorization',
      'completed',
    ]))
    expect(manualSession.waitForCallback).toHaveBeenCalledOnce()
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountReauthorizer.applyAndConfirm).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('hands an unrecognized consent step to the user and still waits for the callback', async () => {
    const manualSession = session({
      submitConsent: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'unknown' as const })),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    const stages: string[] = []
    let manualMessage = ''
    setup.orchestrator.subscribe((task) => {
      stages.push(task.stage)
      if (task.stage === 'manual_intervention') manualMessage = task.message
    })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(stages).toContain('waiting_for_consent')
    expect(stages).toContain('manual_intervention')
    expect(manualMessage).toContain('Codex 授权步骤出现了当前流程未识别的页面')
    expect(finished.stage).toBe('completed')
  })

  it('keeps the authorization browser open while manual consent is waiting for a callback', async () => {
    const callback = deferred<{ code: string; state: string }>()
    const manualInterventionReached = deferred<void>()
    const manualSession = session({
      submitConsent: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'unknown' as const })),
      waitForManualProgress: vi.fn(async () => {
        await callback.promise
        return { kind: 'callback_captured' as const }
      }),
      waitForCallback: vi.fn(() => callback.promise),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    setup.orchestrator.subscribe((task) => {
      if (task.stage === 'manual_intervention') manualInterventionReached.resolve()
    })

    const started = setup.orchestrator.start(input)
    await manualInterventionReached.promise

    expect(setup.orchestrator.activeTask).toMatchObject({
      stage: 'manual_intervention',
      status: 'active',
      message: expect.stringContaining('授权浏览器已保留'),
    })
    expect(manualSession.close).not.toHaveBeenCalled()

    callback.resolve({ code: 'oauth-code', state: 'expected-state' })
    await expect(setup.orchestrator.waitForCompletion(started.id)).resolves.toMatchObject({ stage: 'completed' })
    expect(manualSession.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the authorization browser open when OTP submission falls back to manual intervention', async () => {
    const callback = deferred<{ code: string; state: string }>()
    const manualInterventionReached = deferred<void>()
    const manualSession = session({
      submitEmailOtp: vi.fn(async () => ({ kind: 'manual_intervention' as const, reason: 'unknown' as const })),
      waitForManualProgress: vi.fn(async () => {
        await callback.promise
        return { kind: 'callback_captured' as const }
      }),
      waitForCallback: vi.fn(() => callback.promise),
    })
    const setup = harness({ browser: { start: vi.fn(async () => manualSession) } })
    setup.orchestrator.subscribe((task) => {
      if (task.stage === 'manual_intervention') manualInterventionReached.resolve()
    })

    const started = setup.orchestrator.start(input)
    await manualInterventionReached.promise

    expect(setup.orchestrator.activeTask).toMatchObject({ stage: 'manual_intervention', status: 'active' })
    expect(setup.orchestrator.activeTask?.message).toContain('邮箱验证码步骤出现了当前流程未识别的页面')
    expect(manualSession.close).not.toHaveBeenCalled()

    callback.resolve({ code: 'oauth-code', state: 'expected-state' })
    await expect(setup.orchestrator.waitForCompletion(started.id)).resolves.toMatchObject({ stage: 'completed' })
    expect(manualSession.close).toHaveBeenCalledTimes(1)
  })

  it('fails on a provider error before polling mail or exchanging OAuth credentials', async () => {
    const failedBrowserSession = session({
      submitEmail: vi.fn(async () => {
        throw new AppError('OAUTH_PROVIDER_ERROR', 'OpenAI provider error')
      }),
    })
    const setup = harness({ browser: { start: vi.fn(async () => failedBrowserSession) } })

    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)

    expect(finished).toMatchObject({ stage: 'failed', error: { code: 'OAUTH_PROVIDER_ERROR' } })
    expect(setup.dependencies.mail.waitForOtp).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.exchangeCode).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('fails safely on mailbox or callback validation errors without exchange/create', async () => {
    const mailFailure = harness({
      mail: {
        establishBaseline: vi.fn(async () => ({
          messageIds: new Set<string>(),
          fingerprints: new Set<string>(),
        })),
        waitForOtp: vi.fn(async () => {
          throw new AppError('MAIL_AUTHENTICATION_FAILED', '邮箱凭据无效。')
        }),
      },
    })
    const mailResult = await mailFailure.orchestrator.waitForCompletion(mailFailure.orchestrator.start(input).id)
    expect(mailResult).toMatchObject({ stage: 'failed', error: { code: 'MAIL_AUTHENTICATION_FAILED' } })
    expect(mailFailure.dependencies.oauth.exchangeCode).not.toHaveBeenCalled()

    const callbackFailure = harness({
      browser: {
        start: vi.fn(async () =>
          session({
            waitForCallback: vi.fn(async () => {
              throw new AppError('OAUTH_CALLBACK_STATE_MISMATCH', 'state mismatch')
            }),
          }),
        ),
      },
    })
    const callbackResult = await callbackFailure.orchestrator.waitForCompletion(
      callbackFailure.orchestrator.start(input).id,
    )
    expect(callbackResult).toMatchObject({ stage: 'failed', error: { code: 'OAUTH_CALLBACK_STATE_MISMATCH' } })
    expect(callbackFailure.dependencies.oauth.exchangeCode).not.toHaveBeenCalled()
  })

  it('marks the locked reauthorization account when FlySMS confirms mailbox expiry', async () => {
    const markMailboxExpired = vi.fn(async () => ({
      id: 71,
      name: 'user@example.invalid（邮箱接码过期）',
      status: 'error',
    }))
    const setup = harness({
      accountReauthorizer: {
        loadTarget: vi.fn(async () => ({
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
        })),
        assertOAuthEmail: vi.fn(),
        assertUnchanged: vi.fn(),
        applyAndConfirm: vi.fn(),
        markMailboxExpired,
      },
      mail: {
        establishBaseline: vi.fn(async () => {
          throw new AppError('MAILBOX_ACCOUNT_EXPIRED', '邮箱接码服务已确认该邮箱过期。')
        }),
        waitForOtp: vi.fn(),
      },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({ stage: 'failed', error: { code: 'MAILBOX_ACCOUNT_EXPIRED' } })
    expect(markMailboxExpired).toHaveBeenCalledOnce()
    expect(setup.dependencies.browser.start).not.toHaveBeenCalled()
  })

  it('marks the locked reauthorization account when its mailbox access link has expired', async () => {
    const markMailboxAccessExpired = vi.fn(async () => ({
      id: 71,
      name: 'user@example.invalid（邮箱接码失效）',
      status: 'error',
    }))
    const setup = harness({
      accountReauthorizer: {
        loadTarget: vi.fn(async () => ({
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
        })),
        assertOAuthEmail: vi.fn(),
        assertUnchanged: vi.fn(),
        applyAndConfirm: vi.fn(),
        markMailboxAccessExpired,
      },
      mail: {
        establishBaseline: vi.fn(async () => {
          throw new AppError('MAIL_ACCESS_URL_EXPIRED', '临时邮箱接码域名已经失效，请更新该邮箱的接码链接。')
        }),
        waitForOtp: vi.fn(),
      },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({ stage: 'failed', error: { code: 'MAIL_ACCESS_URL_EXPIRED' } })
    expect(markMailboxAccessExpired).toHaveBeenCalledOnce()
    expect(setup.dependencies.browser.start).not.toHaveBeenCalled()
  })

  it('marks the locked reauthorization account when OpenAI requires phone verification', async () => {
    const markPhoneVerification = vi.fn(async () => ({
      id: 71,
      name: 'user@example.invalid（手机接码）',
      status: 'error',
    }))
    const setup = harness({
      accountReauthorizer: {
        loadTarget: vi.fn(async () => ({
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
        })),
        assertOAuthEmail: vi.fn(),
        assertUnchanged: vi.fn(),
        applyAndConfirm: vi.fn(),
        markPhoneVerification,
      },
      browser: {
        start: vi.fn(async () => session({
          submitEmail: vi.fn(async () => {
            throw new AppError('OPENAI_PHONE_VERIFICATION_REQUIRED', 'OpenAI requires phone verification')
          }),
        })),
      },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization({
        ...reauthorizationInput,
        loginMaterial: { kind: 'password_totp', password: 'synthetic-password', totpSecret: 'JBSWY3DPEHPK3PXP' },
      }).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'OPENAI_PHONE_VERIFICATION_REQUIRED' },
    })
    expect(markPhoneVerification).toHaveBeenCalledOnce()
    expect(setup.dependencies.oauth.exchangeCode).not.toHaveBeenCalled()
  })

  it('cancels before create and rejects cancellation after create starts', async () => {
    const waiting = deferred<{ kind: 'found'; code: string }>()
    const beforeCreate = harness({
      mail: {
        establishBaseline: vi.fn(async () => ({
          messageIds: new Set<string>(),
          fingerprints: new Set<string>(),
        })),
        waitForOtp: vi.fn(async (_email, _password, _baseline, _startedAt, signal) => {
          signal?.addEventListener('abort', () => waiting.reject(new AppError('TASK_CANCELLED', 'cancelled')))
          return waiting.promise
        }),
      },
    })
    const beforeStages = deferred<void>()
    beforeCreate.orchestrator.subscribe((task) => {
      if (task.stage === 'waiting_for_otp') beforeStages.resolve()
    })
    const first = beforeCreate.orchestrator.start(input)
    await beforeStages.promise
    expect(beforeCreate.orchestrator.cancel(first.id)).toMatchObject({
      stage: 'cancelled',
      terminalFromStage: 'waiting_for_otp',
      message: expect.stringContaining('正在进行第一轮验证码等待'),
    })
    expect((await beforeCreate.orchestrator.waitForCompletion(first.id)).stage).toBe('cancelled')
    expect(beforeCreate.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()

    const creating = deferred<{ id: number; name: string; status: string }>()
    const afterCreate = harness()
    vi.mocked(afterCreate.dependencies.accountCreator.createAndConfirm).mockReturnValueOnce(creating.promise)
    const createStage = deferred<void>()
    afterCreate.orchestrator.subscribe((task) => {
      if (task.stage === 'creating_account') createStage.resolve()
    })
    const second = afterCreate.orchestrator.start(input)
    await createStage.promise
    expect(() => afterCreate.orchestrator.cancel(second.id)).toThrow(
      expect.objectContaining({ code: 'TASK_CANCEL_NOT_ALLOWED' }),
    )
    creating.resolve({ id: 73, name: 'user@example.invalid', status: 'active' })
    expect((await afterCreate.orchestrator.waitForCompletion(second.id)).stage).toBe('completed')
  })

  it('confirms an uncertain create by lookup and never automatically replays create', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountCreator.findExactDuplicate)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 74,
        name: 'user@example.invalid',
        status: 'active',
        platform: 'openai',
        type: 'oauth',
      })
    vi.mocked(setup.dependencies.accountCreator.createAndConfirm).mockRejectedValueOnce(
      new AppError('BACKEND_NETWORK_ERROR', 'connection lost', { retryable: true }),
    )
    const finished = await setup.orchestrator.waitForCompletion(setup.orchestrator.start(input).id)
    expect(finished).toMatchObject({ stage: 'completed', account: { id: 74 } })
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledTimes(1)
  })

  it('fails as uncertain when lookup cannot prove a result and prevents a second active task', async () => {
    const creating = deferred<{ id: number; name: string; status: string }>()
    const setup = harness()
    vi.mocked(setup.dependencies.accountCreator.createAndConfirm).mockReturnValueOnce(creating.promise)
    const createStage = deferred<void>()
    setup.orchestrator.subscribe((task) => {
      if (task.stage === 'creating_account') createStage.resolve()
    })
    const first = setup.orchestrator.start(input)
    expect(() => setup.orchestrator.start({ ...input, accountEmail: 'other@example.invalid' })).toThrow(
      expect.objectContaining({ code: 'TASK_ALREADY_ACTIVE' }),
    )
    await createStage.promise
    creating.reject(new AppError('BACKEND_NETWORK_ERROR', 'connection lost', { retryable: true }))
    const finished = await setup.orchestrator.waitForCompletion(first.id)
    expect(finished).toMatchObject({ stage: 'failed', error: { code: 'ACCOUNT_CREATE_UNCERTAIN' } })
    expect(setup.dependencies.accountCreator.createAndConfirm).toHaveBeenCalledTimes(1)
  })

  it('reauthorizes the same account id without calling duplicate checks or account creation', async () => {
    const setup = harness()
    const started = setup.orchestrator.startReauthorization(reauthorizationInput)
    const finished = await setup.orchestrator.waitForCompletion(started.id)

    expect(finished).toMatchObject({
      stage: 'completed',
      status: 'success',
      accountEmail: 'user@example.invalid',
      account: { id: 71, status: 'active' },
      selection: {
        operation: 'reauthorize',
        targetAccountId: 71,
        targetAccountName: 'user@example.invalid',
        statusBefore: 'error',
        maxUsage7dPercent: 90,
      },
    })
    expect(setup.dependencies.accountReauthorizer.loadTarget).toHaveBeenCalledTimes(2)
    expect(setup.dependencies.accountReauthorizer.assertOAuthEmail).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountReauthorizer.applyAndConfirm).toHaveBeenCalledOnce()
    expect(setup.dependencies.accountCreator.findExactDuplicate).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.checkMixedChannel).not.toHaveBeenCalled()
  })

  it('stops reauthorization before write when the exchanged OAuth email does not match', async () => {
    const applyAndConfirm = vi.fn()
    const setup = harness({
      accountReauthorizer: {
        loadTarget: vi.fn(async () => ({
          account: {
            id: 71,
            name: 'user@example.invalid',
            status: 'error',
            platform: 'openai',
            type: 'oauth',
            credentialEmail: 'user@example.invalid',
          },
          email: 'user@example.invalid',
        })),
        assertOAuthEmail: vi.fn(() => {
          throw new AppError('OAUTH_ACCOUNT_EMAIL_MISMATCH', 'mismatch', { statusCode: 409 })
        }),
        assertUnchanged: vi.fn(),
        applyAndConfirm,
      },
    })
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'OAUTH_ACCOUNT_EMAIL_MISMATCH' },
    })
    expect(applyAndConfirm).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'active', codex7dUsedPercent: 80 },
    { status: 'error', codex7dUsedPercent: 90.01 },
  ])('stops reauthorization before write when target eligibility changes during OAuth', async (changed) => {
    const applyAndConfirm = vi.fn()
    const loadTarget = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockRejectedValueOnce(
        new AppError('REAUTHORIZATION_TARGET_INELIGIBLE', 'target no longer eligible', {
          statusCode: 409,
          details: changed,
        }),
      )
    const setup = harness({
      accountReauthorizer: {
        loadTarget,
        assertOAuthEmail: vi.fn(),
        assertUnchanged: vi.fn(),
        applyAndConfirm,
      },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'failed',
      error: { code: 'REAUTHORIZATION_TARGET_INELIGIBLE' },
    })
    expect(loadTarget).toHaveBeenCalledTimes(2)
    expect(applyAndConfirm).not.toHaveBeenCalled()
    expect(setup.dependencies.accountCreator.createAndConfirm).not.toHaveBeenCalled()
  })

  it('uses password and TOTP reauthorization without calling the mailbox adapter', async () => {
    const next = vi.fn(async () => ({ code: '123456', counter: 41 }))
    const setup = harness({ totp: { next } })
    vi.mocked(setup.browserSession.classifyCurrentPage).mockResolvedValueOnce({
      kind: 'authenticator_totp',
      inputSelector: 'input[name="code"]',
      submitSelector: 'button[type="submit"]',
    })
    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization({
        ...reauthorizationInput,
        loginMaterial: {
          kind: 'password_totp',
          password: 'synthetic-password',
          totpSecret: 'JBSWY3DPEHPK3PXP',
        },
      }).id,
    )

    expect(finished.stage).toBe('completed')
    expect(setup.dependencies.mail.establishBaseline).not.toHaveBeenCalled()
    expect(setup.dependencies.mail.waitForOtp).not.toHaveBeenCalled()
    expect(setup.browserSession.submitPassword).toHaveBeenCalledWith('synthetic-password')
    expect(setup.browserSession.submitAuthenticatorTotp).toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('keeps the target account fixed proxy for auth generation, browser, and code exchange', async () => {
    const setup = harness()
    const browserProxy = {
      server: 'http://proxy.example.invalid:8080',
      username: 'proxy-user',
      password: 'proxy-password',
    }
    vi.mocked(setup.dependencies.accountReauthorizer.loadTarget).mockResolvedValue({
      account: {
        id: 71,
        name: 'user@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentialEmail: 'user@example.invalid',
        proxyId: 11,
      },
      email: 'user@example.invalid',
    })
    vi.mocked(setup.dependencies.options.loadSnapshot).mockResolvedValue({
      ...snapshot,
      proxies: [{ id: 11, name: 'Existing fixed proxy', status: 'active' }],
    })
    vi.mocked(setup.dependencies.proxyResolver.resolve).mockResolvedValue({
      mode: 'fixed',
      proxyId: 11,
      proxyName: 'Existing fixed proxy',
      browserProxy,
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'completed',
      selection: {
        operation: 'reauthorize',
        targetAccountId: 71,
        proxyMode: 'existing',
        proxyId: 11,
        proxyName: 'Existing fixed proxy',
      },
    })
    expect(setup.dependencies.proxyResolver.resolve).toHaveBeenCalledWith(
      { mode: 'fixed', proxyId: 11 },
      expect.objectContaining({ proxies: [expect.objectContaining({ id: 11 })] }),
      'user@example.invalid',
    )
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledWith({ proxyId: 11 })
    expect(setup.dependencies.browser.start).toHaveBeenCalledWith(
      expect.objectContaining({ browserProxy }),
    )
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ proxyId: 11 }),
    )
  })

  it('bypasses the target account proxy when no-proxy reauthorization is selected', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountReauthorizer.loadTarget).mockResolvedValue({
      account: {
        id: 74,
        name: 'direct@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentialEmail: 'direct@example.invalid',
        proxyId: 999,
      },
      email: 'direct@example.invalid',
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization({
        ...reauthorizationInput,
        accountId: 74,
        accountEmail: 'direct@example.invalid',
        proxyMode: 'none',
      }).id,
    )

    expect(finished).toMatchObject({
      stage: 'completed',
      selection: { operation: 'reauthorize', targetAccountId: 74, proxyMode: 'none' },
    })
    expect(setup.dependencies.options.loadSnapshot).not.toHaveBeenCalled()
    expect(setup.dependencies.proxyResolver.resolve).not.toHaveBeenCalled()
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledWith({})
    expect(setup.dependencies.browser.start).toHaveBeenCalledWith(
      expect.not.objectContaining({ browserProxy: expect.anything() }),
    )
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledWith(
      expect.not.objectContaining({ proxyId: expect.anything(), machineId: expect.anything() }),
    )
  })

  it('uses a direct connection when the target account proxy is backend-local loopback', async () => {
    const setup = harness()
    vi.mocked(setup.dependencies.accountReauthorizer.loadTarget).mockResolvedValue({
      account: {
        id: 72,
        name: 'loopback@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentialEmail: 'loopback@example.invalid',
        proxyId: 285,
      },
      email: 'loopback@example.invalid',
    })
    vi.mocked(setup.dependencies.options.loadSnapshot).mockResolvedValue({
      ...snapshot,
      proxies: [{ id: 285, name: 'Backend-local proxy', status: 'active' }],
    })
    vi.mocked(setup.dependencies.proxyResolver.resolve).mockResolvedValue({
      mode: 'fixed',
      proxyId: 285,
      proxyName: 'Backend-local proxy',
      browserProxy: { server: 'socks5://127.0.0.1:22157' },
    })

    const finished = await setup.orchestrator.waitForCompletion(
      setup.orchestrator.startReauthorization(reauthorizationInput).id,
    )

    expect(finished).toMatchObject({
      stage: 'completed',
      selection: {
        operation: 'reauthorize',
        targetAccountId: 72,
        proxyMode: 'none',
      },
    })
    expect(setup.dependencies.oauth.generateAuthUrl).toHaveBeenCalledWith({})
    expect(setup.dependencies.browser.start).toHaveBeenCalledWith(
      expect.not.objectContaining({ browserProxy: expect.anything() }),
    )
    expect(setup.dependencies.oauth.exchangeCode).toHaveBeenCalledWith(
      expect.not.objectContaining({ proxyId: expect.anything(), machineId: expect.anything() }),
    )
  })
})
