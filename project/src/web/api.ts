import type {
  CreateTaskInput,
  DeactivationSettings,
  MailboxTrustSettings,
  OptionsSnapshot,
  PublicTask,
  ReauthorizationAccountPage,
  ReauthorizationAccountSummary,
  ReauthorizationHostingState,
  ReauthorizationProxyMode,
  ReauthorizeTaskInput,
} from '../shared/contracts'

export interface PublicBackendUser {
  id: number
  email?: string
  username?: string
  role?: string
  is_admin?: boolean
  permissions?: string[]
}

export interface PublicBackendSession {
  authenticated: boolean
  email: string | null
  user: PublicBackendUser | null
}

export interface PendingTotpLogin {
  state: 'totp_required'
  attemptId: string
  maskedEmail: string | null
  expiresAt: string
}

export interface ProvisioningAgentStatus {
  paired: boolean
  connected: boolean
  runningTask: boolean
  centralOrigin: string | null
  deviceId: string | null
  deviceName: string | null
  lastContactAt: string | null
  lastError: { code: string; message: string } | null
}

export interface AccountPoolPortalStatus {
  configured: boolean
  connected: boolean
  origin: string | null
  lastCheckedAt: string | null
  lastError: { code: string; message: string } | null
}

export interface AccountPoolPortalConnectInput {
  origin: string
  foreground?: boolean
  reuseOnly?: boolean
}

export type PoolConnectionMode = 'account_pool' | 'provisioning_agent'

export interface PoolConnectionModeStatus {
  mode: PoolConnectionMode
}

export type PasswordLoginResult =
  | { state: 'authenticated'; session: PublicBackendSession }
  | PendingTotpLogin

let csrfToken = ''

export function isLocalSessionRequired(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'LOCAL_SESSION_REQUIRED')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）。`)
    Object.assign(error, { code: payload?.error?.code || `HTTP_${response.status}`, statusCode: response.status })
    throw error
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const localApi = {
  async initializeSession(): Promise<PublicBackendSession> {
    const payload = await request<{ csrfToken: string; session: PublicBackendSession }>('/local-api/session')
    csrfToken = payload.csrfToken
    return payload.session
  },
  login(email: string, password: string): Promise<PasswordLoginResult> {
    return request('/local-api/session/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },
  async completeTotp(attemptId: string, code: string): Promise<PublicBackendSession> {
    const payload = await request<{ session: PublicBackendSession }>('/local-api/session/login-2fa', {
      method: 'POST',
      body: JSON.stringify({ attemptId, code }),
    })
    return payload.session
  },
  cancelPendingLogin(): Promise<void> {
    return request('/local-api/session/login-pending', { method: 'DELETE' })
  },
  async logout(): Promise<void> {
    await request('/local-api/session', { method: 'DELETE' })
  },
  mailboxTrustSettings(): Promise<MailboxTrustSettings> {
    return request('/local-api/settings/mailbox-trust')
  },
  updateMailboxTrustSettings(customPathOrigins: string[]): Promise<MailboxTrustSettings> {
    return request('/local-api/settings/mailbox-trust', {
      method: 'PUT',
      body: JSON.stringify({ customPathOrigins }),
    })
  },
  deactivationSettings(): Promise<DeactivationSettings> {
    return request('/local-api/settings/deactivation')
  },
  updateDeactivationSettings(confirmationAttempts: number): Promise<DeactivationSettings> {
    return request('/local-api/settings/deactivation', {
      method: 'PUT',
      body: JSON.stringify({ confirmationAttempts }),
    })
  },
  accountPoolPortal(): Promise<AccountPoolPortalStatus> {
    return request('/local-api/account-pool')
  },
  connectAccountPoolPortal(input: AccountPoolPortalConnectInput): Promise<AccountPoolPortalStatus> {
    return request('/local-api/account-pool', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  disconnectAccountPoolPortal(): Promise<void> {
    return request('/local-api/account-pool', { method: 'DELETE' })
  },
  poolConnectionMode(): Promise<PoolConnectionModeStatus> {
    return request('/local-api/pool-connection-mode')
  },
  switchPoolConnectionMode(mode: PoolConnectionMode): Promise<PoolConnectionModeStatus> {
    return request('/local-api/pool-connection-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    })
  },
  provisioningAgent(): Promise<ProvisioningAgentStatus> {
    return request('/local-api/provisioning-agent')
  },
  pairProvisioningAgent(input: {
    centralOrigin: string
    pairingCode: string
    deviceName: string
  }): Promise<ProvisioningAgentStatus> {
    return request('/local-api/provisioning-agent/pair', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  changeProvisioningAgentOrigin(centralOrigin: string): Promise<ProvisioningAgentStatus> {
    return request('/local-api/provisioning-agent/origin', {
      method: 'PUT',
      body: JSON.stringify({ centralOrigin }),
    })
  },
  disconnectProvisioningAgent(): Promise<void> {
    return request('/local-api/provisioning-agent', { method: 'DELETE' })
  },
  options(refresh = false): Promise<OptionsSnapshot> {
    return request('/local-api/options' + (refresh ? '/refresh' : ''), refresh ? { method: 'POST' } : {})
  },
  startTask(input: CreateTaskInput): Promise<PublicTask> {
    return request('/local-api/tasks', { method: 'POST', body: JSON.stringify(input) })
  },
  reauthorizationAccounts(
    search: string,
    page = 1,
    pageSize = 50,
    maxUsage7dPercent = 90,
    importedWithinDays?: number,
    includeExcluded = false,
  ): Promise<ReauthorizationAccountPage> {
    const query = new URLSearchParams({
      search,
      page: String(page),
      pageSize: String(pageSize),
      maxUsage7dPercent: String(maxUsage7dPercent),
    })
    if (importedWithinDays !== undefined) query.set('importedWithinDays', String(importedWithinDays))
    query.set('includeExcluded', String(includeExcluded))
    return request(`/local-api/reauthorization/accounts?${query.toString()}`)
  },
  reauthorizationAccount(accountId: number, maxUsage7dPercent = 90): Promise<ReauthorizationAccountSummary> {
    const query = new URLSearchParams({ maxUsage7dPercent: String(maxUsage7dPercent) })
    return request(`/local-api/reauthorization/accounts/${accountId}?${query.toString()}`)
  },
  setReauthorizationHostingExcluded(accountId: number, excluded: boolean): Promise<{ accountId: number; excluded: boolean }> {
    return request(`/local-api/reauthorization/accounts/${accountId}/hosting-exclusion`, {
      method: 'PUT',
      body: JSON.stringify({ excluded }),
    })
  },
  setReauthorizationAccountDisposition(
    accountId: number,
    note: string,
    excluded: boolean,
  ): Promise<ReauthorizationAccountSummary> {
    return request(`/local-api/reauthorization/accounts/${accountId}/disposition`, {
      method: 'PUT',
      body: JSON.stringify({ note, excluded }),
    })
  },
  setBulkReauthorizationAccountDisposition(
    accountIds: number[],
    note: string,
    excluded: boolean,
  ): Promise<{ updated: ReauthorizationAccountSummary[]; failed: Array<{ accountId: number; message: string }> }> {
    return request('/local-api/reauthorization/accounts/disposition', {
      method: 'PUT',
      body: JSON.stringify({ accountIds, note, excluded }),
    })
  },
  startReauthorization(input: ReauthorizeTaskInput): Promise<PublicTask> {
    return request('/local-api/reauthorization/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  reauthorizationHosting(): Promise<ReauthorizationHostingState> {
    return request('/local-api/reauthorization/hosting')
  },
  startReauthorizationHosting(input: {
    search: string
    maxUsage7dPercent: number
    importedWithinDays?: number
    proxyMode: ReauthorizationProxyMode
    accountIds?: number[]
  }): Promise<ReauthorizationHostingState> {
    return request('/local-api/reauthorization/hosting', { method: 'POST', body: JSON.stringify(input) })
  },
  stopReauthorizationHosting(): Promise<ReauthorizationHostingState> {
    return request('/local-api/reauthorization/hosting', { method: 'DELETE' })
  },
  skipCurrentReauthorizationHosting(): Promise<ReauthorizationHostingState> {
    return request('/local-api/reauthorization/hosting/skip', { method: 'POST' })
  },
  activeTask(): Promise<{ task: PublicTask | null }> {
    return request('/local-api/tasks/active')
  },
  taskAuthorizationUrl(id: string): Promise<{ authUrl: string }> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}/authorization-url`)
  },
  tasks(limit = 50): Promise<PublicTask[]> {
    return request(`/local-api/tasks?limit=${limit}`)
  },
  task(id: string): Promise<PublicTask> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}`)
  },
  cancelTask(id: string): Promise<PublicTask> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  },
  deleteTask(id: string): Promise<void> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  takeOverTask(id: string): Promise<PublicTask> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}/takeover`, { method: 'POST' })
  },
  releaseTaskTakeover(id: string): Promise<PublicTask> {
    return request(`/local-api/tasks/${encodeURIComponent(id)}/takeover`, { method: 'DELETE' })
  },
  taskEvents(id: string, onTask: (task: PublicTask) => void): () => void {
    const source = new EventSource(`/local-api/tasks/${encodeURIComponent(id)}/events`)
    source.addEventListener('task', (event) => {
      const task = JSON.parse((event as MessageEvent<string>).data) as PublicTask
      onTask(task)
    })
    return () => source.close()
  },
}
