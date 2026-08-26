import { AppError } from '../../shared/errors'
import type { AccountPoolPortalService } from '../account-pool/portal'
import type { ProvisioningAgentStatus } from '../agent/types'

const SETTING_MODE = 'pool_connection_mode'

export type PoolConnectionMode = 'account_pool' | 'provisioning_agent'

export interface PoolConnectionModeStatus {
  mode: PoolConnectionMode
}

export interface PoolConnectionModeSettings {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export interface PoolConnectionAgentRuntime {
  status(): ProvisioningAgentStatus
  restore(): Promise<void>
  shutdown(): Promise<void>
  suspend(): Promise<void>
}

export interface PoolConnectionModeServiceOptions {
  settings: PoolConnectionModeSettings
  accountPoolPortal: AccountPoolPortalService
  provisioningAgent: PoolConnectionAgentRuntime
}

function isPoolConnectionMode(value: string | null): value is PoolConnectionMode {
  return value === 'account_pool' || value === 'provisioning_agent'
}

export class PoolConnectionModeService {
  readonly #settings: PoolConnectionModeSettings
  readonly #accountPoolPortal: AccountPoolPortalService
  readonly #provisioningAgent: PoolConnectionAgentRuntime
  #mode: PoolConnectionMode = 'account_pool'

  constructor(options: PoolConnectionModeServiceOptions) {
    this.#settings = options.settings
    this.#accountPoolPortal = options.accountPoolPortal
    this.#provisioningAgent = options.provisioningAgent
  }

  async restore(): Promise<void> {
    const savedMode = this.#settings.getSetting(SETTING_MODE)
    if (isPoolConnectionMode(savedMode)) {
      this.#mode = savedMode
    } else {
      const portalConfigured = this.#accountPoolPortal.status().configured
      const agentPaired = this.#provisioningAgent.status().paired
      this.#mode = portalConfigured || !agentPaired ? 'account_pool' : 'provisioning_agent'
      this.#settings.setSetting(SETTING_MODE, this.#mode)
    }

    if (this.#mode === 'account_pool') await this.#provisioningAgent.shutdown()
  }

  status(): PoolConnectionModeStatus {
    return { mode: this.#mode }
  }

  assertActive(mode: PoolConnectionMode): void {
    if (this.#mode === mode) return
    throw new AppError(
      'POOL_CONNECTION_MODE_MISMATCH',
      mode === 'account_pool' ? '请先切换到纯号池系统。' : '请先切换到中央执行助手。',
      { statusCode: 409 },
    )
  }

  async switchMode(mode: PoolConnectionMode): Promise<PoolConnectionModeStatus> {
    if (mode === this.#mode) return this.status()

    if (mode === 'account_pool') {
      await this.#provisioningAgent.suspend()
      const portalStatus = this.#accountPoolPortal.status()
      if (portalStatus.configured && portalStatus.origin) {
        await this.#accountPoolPortal.restoreSession()
      }
    } else {
      await this.#provisioningAgent.restore()
    }

    this.#mode = mode
    this.#settings.setSetting(SETTING_MODE, mode)
    return this.status()
  }
}
