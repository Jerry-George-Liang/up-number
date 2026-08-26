import { describe, expect, it } from 'vitest'
import type {
  AccountPoolBrowserResponse,
  AccountPoolBrowserSession,
} from '../../src/server/account-pool/browser-session'
import { AccountPoolPortalService } from '../../src/server/account-pool/portal'
import type { ProvisioningAgentStatus } from '../../src/server/agent/types'
import { PoolConnectionModeService } from '../../src/server/pool-connection/mode'

const portalOrigin = 'http://192.168.50.207:3000'

class MemorySettings {
  readonly values = new Map<string, string>()

  getSetting(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.values.set(key, value)
  }

  deleteSetting(key: string): void {
    this.values.delete(key)
  }
}

function browserJson(target: URL, body: unknown, status = 200): AccountPoolBrowserResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: target.href,
    contentType: 'application/json',
    body: JSON.stringify(body),
    redirected: false,
    type: 'basic',
  }
}

class FakeBrowserSession implements AccountPoolBrowserSession {
  activeOrigin: string | null = null
  loggedIn: boolean
  readonly opened: string[] = []

  constructor(loggedIn: boolean) {
    this.loggedIn = loggedIn
  }

  async open(origin: string): Promise<void> {
    this.activeOrigin = origin
    this.opened.push(origin)
  }

  async request(target: URL): Promise<AccountPoolBrowserResponse> {
    if (target.pathname === '/api/auth/config') {
      return browserJson(target, {
        ssoEnabled: true,
        navigatorSsoEnabled: true,
        passwordLoginEnabled: true,
      })
    }
    if (target.pathname === '/api/me') {
      return this.loggedIn
        ? browserJson(target, { user: { id: 1 } })
        : browserJson(target, { error: '请先登录' }, 401)
    }
    throw new Error(`Unexpected browser request: ${target.pathname}`)
  }

  async close(): Promise<void> {
    this.activeOrigin = null
  }
}

class FakeProvisioningAgent {
  restoreCalls = 0
  shutdownCalls = 0
  suspendCalls = 0
  paired = true
  connected = true
  runningTask = false

  status(): ProvisioningAgentStatus {
    return {
      paired: this.paired,
      connected: this.connected,
      runningTask: this.runningTask,
      centralOrigin: this.paired ? 'http://192.168.50.218:3001' : null,
      deviceId: this.paired ? '550e8400-e29b-41d4-a716-446655440000' : null,
      deviceName: this.paired ? 'Mac 执行助手' : null,
      lastContactAt: null,
      lastError: null,
    }
  }

  async restore(): Promise<void> {
    this.restoreCalls += 1
    this.connected = this.paired
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1
    this.connected = false
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1
    this.connected = false
    this.runningTask = false
  }
}

function setup(options: { savedMode?: string; portalConfigured?: boolean; portalLoggedIn?: boolean } = {}) {
  const settings = new MemorySettings()
  if (options.savedMode) settings.setSetting('pool_connection_mode', options.savedMode)
  if (options.portalConfigured) settings.setSetting('account_pool_portal_origin', portalOrigin)
  const browser = new FakeBrowserSession(options.portalLoggedIn !== false)
  const accountPoolPortal = new AccountPoolPortalService({ settings, browserSession: browser })
  accountPoolPortal.restore()
  const provisioningAgent = new FakeProvisioningAgent()
  const service = new PoolConnectionModeService({
    settings,
    accountPoolPortal,
    provisioningAgent,
  })
  return { settings, browser, accountPoolPortal, provisioningAgent, service }
}

describe('PoolConnectionModeService', () => {
  it('restores the pure account-pool mode and keeps the central agent stopped', async () => {
    const { settings, provisioningAgent, service } = setup({ portalConfigured: true })

    await service.restore()

    expect(service.status()).toEqual({ mode: 'account_pool' })
    expect(settings.getSetting('pool_connection_mode')).toBe('account_pool')
    expect(provisioningAgent.shutdownCalls).toBe(1)
    expect(provisioningAgent.connected).toBe(false)
  })

  it('opens the saved pool webpage when switching away from the central agent', async () => {
    const { browser, provisioningAgent, service } = setup({
      savedMode: 'provisioning_agent',
      portalConfigured: true,
    })
    await service.restore()

    await expect(service.switchMode('account_pool')).resolves.toEqual({ mode: 'account_pool' })

    expect(browser.opened).toEqual([portalOrigin])
    expect(provisioningAgent.suspendCalls).toBe(1)
    expect(provisioningAgent.connected).toBe(false)
  })

  it('still switches modes while the saved pool webpage is waiting for login', async () => {
    const { settings, browser, accountPoolPortal, provisioningAgent, service } = setup({
      savedMode: 'provisioning_agent',
      portalConfigured: true,
      portalLoggedIn: false,
    })
    await service.restore()

    await expect(service.switchMode('account_pool')).resolves.toEqual({ mode: 'account_pool' })

    expect(settings.getSetting('pool_connection_mode')).toBe('account_pool')
    expect(browser.opened).toEqual([portalOrigin])
    expect(accountPoolPortal.status()).toMatchObject({
      configured: true,
      connected: false,
      lastError: { code: 'ACCOUNT_POOL_LOGIN_REQUIRED' },
    })
    expect(provisioningAgent.suspendCalls).toBe(1)
    expect(provisioningAgent.restoreCalls).toBe(0)
  })

  it('keeps the central pairing and resumes it when switching back', async () => {
    const { settings, provisioningAgent, service } = setup({
      savedMode: 'account_pool',
      portalConfigured: true,
    })
    await service.restore()

    await expect(service.switchMode('provisioning_agent')).resolves.toEqual({
      mode: 'provisioning_agent',
    })

    expect(settings.getSetting('pool_connection_mode')).toBe('provisioning_agent')
    expect(provisioningAgent.restoreCalls).toBe(1)
    expect(provisioningAgent.connected).toBe(true)
  })
})
