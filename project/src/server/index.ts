import { BackendAccountsApi } from './backend/accounts'
import { BackendAuthApi } from './backend/auth'
import { AuthorizedBackendClient, BackendTransport } from './backend/client'
import { BackendOptionsApi } from './backend/options'
import { AppError } from '../shared/errors'
import { buildApp } from './app'
import { PlaywrightBrowserController } from './browser/controller'
import { loadConfig } from './config'
import { loadLanTlsMaterial } from './lan-tls'
import { LocalSessionSecurity } from './local-security'
import { loadOrCreateLocalSessionSeed } from './local-session-store'
import { isAddressAssignedToLocalInterface, parseIpv4Cidr } from './network-access'
import { MailboxClient } from './mail/client'
import { MailOtpPoller } from './mail/poller'
import { MailboxTrustSettingsService } from './mail/settings'
import { KeychainCredentialStore } from './session/keychain'
import { SessionManager } from './session/manager'
import { TaskDatabase } from './storage/database'
import { AccountCreator } from './tasks/account-creator'
import { AccountDeactivationManager } from './tasks/account-deactivation'
import { DeactivationSettingsService } from './tasks/deactivation-settings'
import { AccountReauthorizer } from './tasks/account-reauthorizer'
import { TaskOrchestrator } from './tasks/orchestrator'
import { ReauthorizationHostingService } from './tasks/reauthorization-hosting'
import { ProxyResolver } from './tasks/proxy-resolver'
import { AccountPoolBridgeClient } from './account-pool/bridge-client'
import { AccountPoolPortalService } from './account-pool/portal'
import { ConfiguredAccountPoolResolver } from './account-pool/resolver'
import { ProvisioningAgentClient } from './agent/client'
import { RoutedAccountPoolResolver } from './agent/material-resolver'
import { PoolConnectionModeService } from './pool-connection/mode'
import type { ReauthorizationAccountSummary } from '../shared/contracts'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.host !== '127.0.0.1') throw new Error('The local service may only bind to 127.0.0.1')
  const localSessionSeed = loadOrCreateLocalSessionSeed(config.localSessionSeedPath)

  const database = new TaskDatabase(config.databasePath)
  database.markActiveTasksInterrupted()
  const mailboxSettings = new MailboxTrustSettingsService(database)
  const deactivationSettings = new DeactivationSettingsService(database)
  const transport = new BackendTransport(config.backendBaseUrl)
  const authApi = new BackendAuthApi(transport)
  const session = new SessionManager(authApi, new KeychainCredentialStore(), database)
  const sessionRestore = session.restore()
  const authorized = new AuthorizedBackendClient(transport, session)
  const options = new BackendOptionsApi(authorized)
  const accounts = new BackendAccountsApi(authorized)
  const accountCreator = new AccountCreator(accounts)
  const accountDeactivation = new AccountDeactivationManager(accounts)
  const accountReauthorizer = new AccountReauthorizer(accounts)
  const accountPoolBridge = new AccountPoolBridgeClient({
    baseUrl: config.accountPoolBaseUrl,
    token: config.accountPoolBridgeToken,
    timeoutMs: config.accountPoolTimeoutMs,
  })
  const accountPoolPortal = new AccountPoolPortalService({
    settings: database,
    profileDir: config.accountPoolProfileDir,
    timeoutMs: config.accountPoolTimeoutMs,
  })
  accountPoolPortal.restore()
  const accountPool = new RoutedAccountPoolResolver(
    new ConfiguredAccountPoolResolver(accountPoolPortal, accountPoolBridge),
  )
  const proxyResolver = new ProxyResolver(options)
  const mail = new MailOtpPoller(
    new MailboxClient(fetch, {
      trustedPathOrigins: () => mailboxSettings.snapshot().pathOrigins,
    }),
  )
  const browser = new PlaywrightBrowserController()
  const orchestrator = new TaskOrchestrator({
    database,
    options,
    accountCreator,
    accountDeactivation,
    accountReauthorizer,
    mail,
    proxyResolver,
    oauth: accounts,
    browser,
    accountPool,
    trustedPathOrigins: () => mailboxSettings.snapshot().pathOrigins,
    deactivationConfirmationAttempts: () => deactivationSettings.getSettings().confirmationAttempts,
  })
  const reauthorizationHosting = new ReauthorizationHostingService({
    settings: database,
    listAccounts: (input) => accounts.listReauthorizationAccounts(input),
    getAccount: async (id, maxUsage7dPercent) => {
      const target = await accountReauthorizer.loadTarget(id, undefined, true, maxUsage7dPercent)
      return {
        id: target.account.id,
        name: target.account.name,
        email: target.email,
        status: target.account.status,
        usage7dPercent: target.account.codex7dUsedPercent!,
        importedAt: target.account.createdAt ?? target.account.updatedAt ?? null,
        errorAt: target.account.updatedAt ?? null,
      }
    },
    startTask: (input) => orchestrator.startReauthorization(input),
    getActiveTask: () => orchestrator.activeTask,
    getTask: (id) => database.getTask(id),
    subscribe: (listener) => orchestrator.subscribe(listener),
    cancelTask: (id) => orchestrator.cancel(id),
  })
  await reauthorizationHosting.restore()
  const provisioningAgent = new ProvisioningAgentClient({
    credentials: new KeychainCredentialStore('up-icloud.provisioning-agent'),
    settings: database,
    session,
    options,
    reauthorization: {
      listAccounts: (input) => accounts.listReauthorizationAccounts(input),
    },
    orchestrator,
    materials: accountPool,
  })
  await provisioningAgent.restore()
  const poolConnectionMode = new PoolConnectionModeService({
    settings: database,
    accountPoolPortal,
    provisioningAgent,
  })
  await poolConnectionMode.restore()
  const localSecurity = new LocalSessionSecurity({
    persistentSeed: localSessionSeed,
  })
  const setAccountDisposition = async (
    accountId: number,
    note: string,
    excluded: boolean,
  ): Promise<ReauthorizationAccountSummary> => {
    const previousNote = reauthorizationHosting.accountNote(accountId)
    const target = await accountReauthorizer.loadTarget(accountId, undefined, false)
    const updated = await accountReauthorizer.setManagedNameNote(target, note, previousNote)
    await accountReauthorizer.setManagementNote(target, note)
    reauthorizationHosting.setAccountNote(accountId, note)
    reauthorizationHosting.setAccountExcluded(accountId, excluded)
    return reauthorizationHosting.decorateAccount({
      id: target.account.id,
      name: updated.name,
      email: target.email,
      status: updated.status,
      usage7dPercent: target.account.codex7dUsedPercent ?? 0,
      importedAt: target.account.createdAt ?? target.account.updatedAt ?? null,
      errorAt: target.account.updatedAt ?? null,
    })
  }
  const localOrigin = `http://${config.host}:${config.port}`
  const sharedAppDependencies: Omit<
    Parameters<typeof buildApp>[0],
    'security' | 'localOrigin' | 'accessPolicy'
  > = {
    session,
    mailboxSettings: {
      getSettings: () => mailboxSettings.getSettings(),
      updateSettings: (input) => mailboxSettings.updateSettings(input),
      hasActiveTask: () => orchestrator.activeTask !== null,
    },
    deactivationSettings: {
      getSettings: () => deactivationSettings.getSettings(),
      updateSettings: (input) => deactivationSettings.updateSettings(input),
      hasActiveTask: () => orchestrator.activeTask !== null,
    },
    options,
    reauthorization: {
      listAccounts: async (input) => reauthorizationHosting.decoratePage(await accounts.listReauthorizationAccounts({
        ...input,
        ...(input.includeExcluded
          ? {}
          : {
              excludedAccountIds: [
                ...reauthorizationHosting.excludedAccountIds(),
                ...reauthorizationHosting.notedAccountIds(),
              ],
            }),
      })),
      getAccount: async (id, maxUsage7dPercent) => {
        const target = await accountReauthorizer.loadTarget(id, undefined, true, maxUsage7dPercent)
        return reauthorizationHosting.decorateAccount({
          id: target.account.id,
          name: target.account.name,
          email: target.email,
          status: target.account.status,
          usage7dPercent: target.account.codex7dUsedPercent!,
          importedAt: target.account.createdAt ?? target.account.updatedAt ?? null,
          errorAt: target.account.updatedAt ?? null,
        })
      },
      startTask: (input) => {
        if (['running', 'paused', 'stopping'].includes(reauthorizationHosting.getState().status)) {
          throw new AppError('REAUTHORIZATION_HOSTING_ACTIVE', '重新授权托管正在运行，请先停止托管。', { statusCode: 409 })
        }
        return orchestrator.startReauthorization(input)
      },
      getHostingState: () => reauthorizationHosting.getState(),
      startHosting: (input) => reauthorizationHosting.start(input),
      stopHosting: () => reauthorizationHosting.stop(),
      skipCurrentHosting: () => reauthorizationHosting.skipCurrent(),
      setAccountHostingExcluded: (accountId, excluded) => ({
        accountId,
        excluded: reauthorizationHosting.setAccountExcluded(accountId, excluded),
      }),
      setAccountDisposition,
      setBulkAccountDisposition: async (accountIds, note, excluded) => {
        const updated: ReauthorizationAccountSummary[] = []
        const failed: Array<{ accountId: number; message: string }> = []
        for (const accountId of accountIds) {
          try {
            updated.push(await setAccountDisposition(accountId, note, excluded))
          } catch (error) {
            failed.push({ accountId, message: error instanceof Error ? error.message : '账号处置失败。' })
          }
        }
        return { updated, failed }
      },
    },
    orchestrator: {
      start: (input) => orchestrator.start(input),
      cancel: (id) => orchestrator.cancel(id),
      takeOver: (id) => orchestrator.takeOver(id),
      releaseTakeover: (id) => orchestrator.releaseTakeover(id),
      subscribe: (listener) => orchestrator.subscribe(listener),
      getActiveTask: () => orchestrator.activeTask,
      getAuthorizationUrl: (id) => orchestrator.getAuthorizationUrl(id),
      forgetAuthorizationUrl: (id) => orchestrator.forgetAuthorizationUrl(id),
    },
    tasks: database,
    accountPoolPortal,
    provisioningAgent,
    poolConnectionMode,
    webRoot: config.webRoot,
  }
  const localApp = buildApp({
    ...sharedAppDependencies,
    security: localSecurity,
    localOrigin,
    autoEstablishSession: true,
    accessPolicy: {
      allowedHostnames: ['127.0.0.1', 'localhost'],
    },
  })
  let lanApp: ReturnType<typeof buildApp> | undefined
  let lanOrigin: string | undefined
  let lanSecurity: LocalSessionSecurity | undefined

  if (config.lanAccess) {
    if (!isAddressAssignedToLocalInterface(config.lanAccess.host)) {
      console.warn('[up-icloud] LAN listener unavailable: LAN_HOST_NOT_ASSIGNED')
    } else {
      try {
        const appOptions =
          config.lanAccess.protocol === 'https'
            ? {
                https: loadLanTlsMaterial(
                  config.lanAccess.host,
                  config.lanAccess.tlsCertPath,
                  config.lanAccess.tlsKeyPath,
                ),
              }
            : undefined
        lanOrigin = `${config.lanAccess.protocol}://${config.lanAccess.host}:${config.port}`
        lanSecurity = new LocalSessionSecurity({
          persistentSeed: localSessionSeed,
          namespace:
            config.lanAccess.protocol === 'https'
              ? `lan:${config.lanAccess.host}:${config.port}`
              : `lan-http:${config.lanAccess.host}:${config.port}`,
        })
        lanApp = buildApp(
          {
            ...sharedAppDependencies,
            security: lanSecurity,
            localOrigin: lanOrigin,
            ...(config.lanAccess.protocol === 'http'
              ? {
                  sessionCookieName: 'up_icloud_lan_http_session',
                  autoEstablishSession: true,
                }
              : {}),
            accessPolicy: {
              allowedHostnames: [config.lanAccess.host],
              allowedClientCidr: parseIpv4Cidr(config.lanAccess.allowedCidr),
            },
          },
          appOptions,
        )
      } catch (error) {
        console.warn(
          `[up-icloud] LAN listener unavailable: ${error instanceof AppError ? error.code : 'LAN_SETUP_FAILED'}`,
        )
      }
    }
  }

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await reauthorizationHosting.shutdown()
    await Promise.allSettled([
      provisioningAgent.shutdown(),
      orchestrator.shutdown(),
      accountPoolPortal.shutdown(),
    ])
    await Promise.allSettled([lanApp?.close(), localApp.close()])
    database.close()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  await localApp.listen({ host: config.host, port: config.port })
  if (lanApp && config.lanAccess && lanOrigin && lanSecurity) {
    try {
      await lanApp.listen({ host: config.lanAccess.host, port: config.port })
      console.log(`Open the one-time LAN URL: ${lanOrigin}/bootstrap?nonce=${lanSecurity.bootstrapNonce}`)
    } catch {
      console.warn('[up-icloud] LAN listener unavailable: LAN_LISTEN_FAILED')
      await lanApp.close().catch(() => undefined)
      lanApp = undefined
    }
  }
  console.log(`Open the one-time local URL: ${localOrigin}/bootstrap?nonce=${localSecurity.bootstrapNonce}`)
  void sessionRestore.catch((error: unknown) => {
    console.warn(
      `[up-icloud] Saved backend session restore failed: ${error instanceof AppError ? error.code : 'UNEXPECTED_ERROR'}`,
    )
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failed to start local service')
  process.exitCode = 1
})
