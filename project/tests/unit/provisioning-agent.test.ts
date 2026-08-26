import { describe, expect, it, vi } from 'vitest'
import type { PublicTask } from '../../src/shared/contracts'
import { ProvisioningAgentClient } from '../../src/server/agent/client'
import { RoutedAccountPoolResolver } from '../../src/server/agent/material-resolver'
import type { AccountPoolMaterials, AccountPoolResolver } from '../../src/server/account-pool/bridge-client'
import { MemoryCredentialStore } from '../../src/server/session/keychain'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

class MemorySettings {
  readonly values = new Map<string, string>()
  readonly tasks = new Map<string, PublicTask>()

  getSetting(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.values.set(key, value)
  }

  deleteSetting(key: string): void {
    this.values.delete(key)
  }

  getTask(id: string): PublicTask | null {
    return this.tasks.get(id) ?? null
  }
}

function task(overrides: Partial<PublicTask> = {}): PublicTask {
  const now = '2026-08-15T08:00:00.000Z'
  return {
    id: 'local-task-1',
    accountEmail: 'one@example.com',
    stage: 'completed',
    status: 'success',
    selection: {
      operation: 'create',
      proxyMode: 'none',
      concurrency: 10,
      supplier: null,
      groups: [],
      modelsCleared: true,
      loginMaterialSource: 'account_pool',
    },
    authorization: null,
    deactivation: null,
    terminalFromStage: null,
    account: { id: 88, name: 'one@example.com', status: 'active' },
    error: null,
    message: '账号创建完成。',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function pairedSettings(settings: MemorySettings): void {
  settings.setSetting('provisioning_agent_origin', 'http://192.168.50.218:3001')
  settings.setSetting('provisioning_agent_device_id', '550e8400-e29b-41d4-a716-446655440000')
  settings.setSetting('provisioning_agent_device_name', 'Operator Mac')
}

async function pairedCredentials(credentials: MemoryCredentialStore): Promise<void> {
  await credentials.set('central-device-token', 'device-token-that-is-long-enough-for-testing')
}

function agentOrchestrator() {
  const reservation = Object.freeze({ token: Symbol('test-external-execution') })
  return {
    reservation,
    reserveExternalExecution: vi.fn(() => reservation),
    releaseExternalExecution: vi.fn(),
    startReserved: vi.fn((...args: [unknown, unknown, Record<string, unknown>?]) => {
      void args
      return task({ stage: 'validating', status: 'active', account: null, message: '正在校验任务输入。' })
    }),
    startReservedReauthorization: vi.fn(
      (...args: [unknown, unknown, Record<string, unknown>?]) => {
        void args
        return task({ stage: 'validating', status: 'active', account: null, message: '正在校验任务输入。' })
      },
    ),
    waitForCompletion: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  }
}

const CENTRAL_TASK_ID = '550e8400-e29b-41d4-a716-446655440001'

function centralTaskJob() {
  return {
    id: CENTRAL_TASK_ID,
    kind: 'task' as const,
    operation: 'create' as const,
    accountEmail: 'one@example.com',
    input: {
      proxyChoice: { mode: 'none' },
      concurrency: 10,
      supplier: null,
      groupIds: [],
      allowDuplicateCreation: true,
      confirmMixedChannelRisk: false,
    },
  }
}

function remoteMaterials() {
  return {
    email: 'one@example.com',
    password: 'pool-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    mailboxAccess: 'pool-mailbox',
  }
}

async function runCentralTaskToResult(terminal: PublicTask): Promise<Record<string, unknown>> {
  const credentials = new MemoryCredentialStore()
  const settings = new MemorySettings()
  pairedSettings(settings)
  await pairedCredentials(credentials)
  const orchestrator = agentOrchestrator()
  orchestrator.waitForCompletion.mockResolvedValue(terminal)
  let jobDelivered = false
  let postedResult: Record<string, unknown> | undefined
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
    if (url.pathname === '/api/provisioning/agent/jobs/next' && !jobDelivered) {
      jobDelivered = true
      return jsonResponse({ job: centralTaskJob() })
    }
    if (url.pathname.endsWith('/materials')) return jsonResponse(remoteMaterials())
    if (url.pathname.endsWith('/events')) return jsonResponse({ ok: true })
    if (url.pathname.endsWith('/result')) {
      postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ ok: true })
    }
    if (url.pathname === '/api/provisioning/agent/jobs/next') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }
    throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
  }) as typeof fetch
  const client = new ProvisioningAgentClient({
    credentials,
    settings,
    session: {
      ready: vi.fn(async () => undefined),
      publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
    },
    options: { loadSnapshot: vi.fn() },
    reauthorization: { listAccounts: vi.fn() },
    orchestrator,
    materials: new RoutedAccountPoolResolver({
      resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
    }),
    fetchImpl,
  })

  await client.restore()
  await vi.waitFor(() => expect(postedResult).toBeTruthy())
  await client.shutdown()
  return postedResult!
}

describe('RoutedAccountPoolResolver', () => {
  it('uses task-scoped remote materials and returns to the local fallback after clearing', async () => {
    const fallback: AccountPoolResolver = {
      resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback-mailbox' })),
    }
    const resolver = new RoutedAccountPoolResolver(fallback)
    resolver.activate('central-task-1', 'one@example.com', {
      email: 'one@example.com',
      password: 'remote-password',
      totpSecret: 'REMOTE-TOTP',
    })

    await expect(resolver.resolve('one@example.com')).resolves.toEqual({
      email: 'one@example.com',
      mailboxAccess: 'fallback-mailbox',
    })
    await expect(resolver.resolve('one@example.com', undefined, 'central-task-1')).resolves.toEqual({
      email: 'one@example.com',
      password: 'remote-password',
      totpSecret: 'REMOTE-TOTP',
    })
    await expect(resolver.resolve('other@example.com', undefined, 'central-task-1')).rejects.toMatchObject({
      code: 'AGENT_MATERIALS_EMAIL_MISMATCH',
    })
    await expect(resolver.resolve('one@example.com', undefined, 'different-task')).rejects.toMatchObject({
      code: 'AGENT_MATERIALS_SCOPE_MISMATCH',
    })
    resolver.clear('central-task-1')
    await expect(resolver.resolve('one@example.com')).resolves.toEqual({
      email: 'one@example.com',
      mailboxAccess: 'fallback-mailbox',
    })
  })
})

describe('ProvisioningAgentClient', () => {
  it('activates a centrally registered device without changing the legacy pairing contract', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((resolve) => {
          const finish = () => resolve(new Response(null, { status: 204 }))
          init?.signal?.addEventListener('abort', finish, { once: true })
          if (init?.signal?.aborted) finish()
        })
      }
      return jsonResponse({ error: 'unexpected' }, 404)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.activate({
      centralOrigin: 'http://192.168.50.218:3001',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      deviceName: '独立助手',
      deviceToken: 'helper-generated-device-token-that-is-long-enough',
    })
    await client.syncHeartbeat()

    expect(client.status()).toMatchObject({
      paired: true,
      centralOrigin: 'http://192.168.50.218:3001',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
      deviceName: '独立助手',
    })
    expect(await credentials.get('central-device-token')).toBe('helper-generated-device-token-that-is-long-enough')
    expect(settings.getSetting('provisioning_agent_origin')).toBe('http://192.168.50.218:3001')
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/provisioning/agent/heartbeat' }),
      expect.objectContaining({ method: 'POST' }),
    )
    await client.shutdown()
  })

  it('validates the existing device token before changing the central origin', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    let selfAuthorization = ''
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/self') {
        selfAuthorization = new Headers(init?.headers).get('authorization') ?? ''
        expect(url.origin).toBe('http://192.168.50.207:3000')
        return jsonResponse({
          deviceId: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Operator Mac',
        })
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((resolve) => {
          const finish = () => resolve(new Response(null, { status: 204 }))
          init?.signal?.addEventListener('abort', finish, { once: true })
          if (init?.signal?.aborted) finish()
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    const status = await client.changeOrigin({ centralOrigin: 'http://192.168.50.207:3000/' })

    expect(status).toMatchObject({
      paired: true,
      connected: true,
      centralOrigin: 'http://192.168.50.207:3000',
      deviceId: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(selfAuthorization).toBe('Bearer device-token-that-is-long-enough-for-testing')
    expect(settings.getSetting('provisioning_agent_origin')).toBe('http://192.168.50.207:3000')
    await client.shutdown()
  })

  it('explains when a replacement origin does not expose provisioning agent routes', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin === 'http://192.168.50.207:3000') {
        return jsonResponse({ error: '接口不存在' }, 404)
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      return new Promise<Response>((resolve) => {
        // The restored job loop is stopped by shutdown after the origin check.
        setTimeout(() => resolve(new Response(null, { status: 204 })), 50)
      })
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    try {
      await expect(
        client.changeOrigin({ centralOrigin: 'http://192.168.50.207:3000/' }),
      ).rejects.toMatchObject({
        code: 'AGENT_CENTRAL_PROVISIONING_UNAVAILABLE',
        message: '该地址未提供中央号池执行助手接口，请确认中央号池地址与端口（当前部署应使用 3001）。',
      })
      expect(settings.getSetting('provisioning_agent_origin')).toBe('http://192.168.50.218:3001')
    } finally {
      await client.shutdown()
    }
  })

  it('keeps the old central origin when the new address belongs to another device', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/self') {
        return jsonResponse({
          deviceId: '550e8400-e29b-41d4-a716-446655440099',
          name: 'Another Mac',
        })
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () => resolve(new Response(null, { status: 204 })), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await expect(
      client.changeOrigin({ centralOrigin: 'http://192.168.50.207:3000' }),
    ).rejects.toMatchObject({ code: 'AGENT_ORIGIN_DEVICE_MISMATCH' })
    expect(settings.getSetting('provisioning_agent_origin')).toBe('http://192.168.50.218:3001')
    expect(client.status().centralOrigin).toBe('http://192.168.50.218:3001')
    await client.shutdown()
  })

  it('waits for the backend session restore before requesting a job', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const sessionReady = deferred<void>()
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(() => sessionReady.promise),
        publicSession: vi.fn(() => ({ authenticated: false, email: null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    try {
      await Promise.resolve()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      sessionReady.resolve()
      await client.shutdown()
    }
  })

  it('does not request a job while the restored backend session is unauthenticated', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      throw new Error(`Unexpected request: ${url.pathname}`)
    })
    const fetchImpl = fetchMock as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: false, email: null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    try {
      await vi.waitFor(() =>
        expect(fetchImpl).toHaveBeenCalledWith(
          expect.objectContaining({ pathname: '/api/provisioning/agent/heartbeat' }),
          expect.anything(),
        ),
      )
      expect(fetchMock.mock.calls.some(([input]) => new URL(input.toString()).pathname.endsWith('/jobs/next'))).toBe(
        false,
      )
    } finally {
      await client.shutdown()
    }
  })

  it('safely rejects a delivered task when backend authentication expires during long polling', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const orchestrator = agentOrchestrator()
    const materials = new RoutedAccountPoolResolver({
      resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
    })
    const activate = vi.spyOn(materials, 'activate')
    let authenticated = true
    let jobDelivered = false
    let postedResult: Record<string, unknown> | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next' && !jobDelivered) {
        jobDelivered = true
        authenticated = false
        return jsonResponse({ job: centralTaskJob() })
      }
      if (url.pathname.endsWith('/result')) {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ ok: true })
      }
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated, email: authenticated ? 'operator@example.com' : null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials,
      fetchImpl,
    })

    await client.restore()
    try {
      await vi.waitFor(() => expect(postedResult).toBeTruthy())
      expect(postedResult).toMatchObject({
        status: 'error',
        result: { error: { code: 'AGENT_BACKEND_SESSION_REQUIRED' } },
      })
      expect(orchestrator.reserveExternalExecution).toHaveBeenCalledOnce()
      expect(orchestrator.releaseExternalExecution).toHaveBeenCalledWith(orchestrator.reservation)
      expect(activate).not.toHaveBeenCalled()
      expect(orchestrator.startReserved).not.toHaveBeenCalled()
    } finally {
      await client.shutdown()
    }
  })

  it('releases the local execution reservation when material retrieval fails', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const orchestrator = agentOrchestrator()
    let jobDelivered = false
    let postedResult: Record<string, unknown> | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next' && !jobDelivered) {
        jobDelivered = true
        return jsonResponse({ job: centralTaskJob() })
      }
      if (url.pathname.endsWith('/materials')) return jsonResponse({ error: 'unavailable' }, 503)
      if (url.pathname.endsWith('/result')) {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ ok: true })
      }
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    try {
      await vi.waitFor(() => expect(postedResult).toBeTruthy())
      expect(orchestrator.releaseExternalExecution).toHaveBeenCalledWith(orchestrator.reservation)
      expect(orchestrator.startReserved).not.toHaveBeenCalled()
    } finally {
      await client.shutdown()
    }
  })

  it('clears scoped materials before reporting a synchronous reserved-start failure', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const orchestrator = agentOrchestrator()
    orchestrator.startReserved.mockImplementation(() => {
      throw new Error('synchronous start failure')
    })
    const materials = new RoutedAccountPoolResolver({
      resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
    })
    const order: string[] = []
    const clear = vi.spyOn(materials, 'clear').mockImplementation((scope) => {
      order.push(`clear:${scope}`)
    })
    const resultResponse = deferred<Response>()
    let jobDelivered = false
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next' && !jobDelivered) {
        jobDelivered = true
        return jsonResponse({ job: centralTaskJob() })
      }
      if (url.pathname.endsWith('/materials')) return jsonResponse(remoteMaterials())
      if (url.pathname.endsWith('/result')) {
        order.push('result-request')
        return resultResponse.promise
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials,
      fetchImpl,
    })

    await client.restore()
    try {
      await vi.waitFor(() => expect(order).toContain('result-request'))
      expect(order.slice(0, 2)).toEqual([`clear:${CENTRAL_TASK_ID}`, 'result-request'])
      expect(clear).toHaveBeenCalledWith(CENTRAL_TASK_ID)
    } finally {
      resultResponse.resolve(jsonResponse({ ok: true }))
      await vi.waitFor(() => expect(settings.getSetting('provisioning_agent_active_central_task')).toBeNull())
      await client.shutdown()
    }
  })

  it('requires disconnecting the current device before pairing again', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    let pairRequests = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/pair') {
        pairRequests += 1
        return jsonResponse(
          {
            deviceId: '550e8400-e29b-41d4-a716-446655440000',
            deviceToken: 'device-token-that-is-long-enough-for-testing',
            name: 'Operator Mac',
          },
          201,
        )
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })
    const input = {
      centralOrigin: 'http://192.168.50.218:3001',
      pairingCode: 'PAIR-CODE-1234',
      deviceName: 'Operator Mac',
    }

    await client.pair(input)
    await expect(client.pair(input)).rejects.toMatchObject({ code: 'AGENT_ALREADY_PAIRED' })
    expect(pairRequests).toBe(1)
    await client.shutdown()
  })

  it('keeps pairing data until the central disconnect handshake succeeds', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    let handshakeSawStoredConfiguration = false
    let disconnectBody: unknown
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/disconnect') {
        handshakeSawStoredConfiguration =
          client.status().connected &&
          (await credentials.get('central-device-token')) === 'device-token-that-is-long-enough-for-testing' &&
          settings.getSetting('provisioning_agent_device_id') === '550e8400-e29b-41d4-a716-446655440000'
        disconnectBody = JSON.parse(String(init?.body)) as unknown
        return jsonResponse({ ok: true })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: false, email: null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await vi.waitFor(() => expect(client.status().connected).toBe(true))
    await client.disconnect()

    expect(handshakeSawStoredConfiguration).toBe(true)
    expect(disconnectBody).toEqual({})
    expect(await credentials.get('central-device-token')).toBeNull()
    expect(settings.getSetting('provisioning_agent_origin')).toBeNull()
    expect(client.status().paired).toBe(false)
  })

  it('preserves pairing data when the central disconnect handshake fails', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/disconnect') {
        return jsonResponse({ code: 'AGENT_DISCONNECT_REJECTED', error: 'disconnect rejected' }, 503)
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: false, email: null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await vi.waitFor(() => expect(client.status().connected).toBe(true))
    await expect(client.disconnect()).rejects.toMatchObject({ code: 'AGENT_DISCONNECT_REJECTED' })
    expect(await credentials.get('central-device-token')).toBe('device-token-that-is-long-enough-for-testing')
    expect(settings.getSetting('provisioning_agent_origin')).toBe('http://192.168.50.218:3001')
    expect(client.status().paired).toBe(true)
    expect(client.status().connected).toBe(true)
    await client.shutdown()
  })

  it('blocks pairing changes while a central task is still pending', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    settings.setSetting('provisioning_agent_active_central_task', '550e8400-e29b-41d4-a716-446655440001')
    const fetchImpl = vi.fn() as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await expect(
      client.pair({
        centralOrigin: 'http://192.168.50.218:3001',
        pairingCode: 'PAIR-CODE-1234',
        deviceName: 'Operator Mac',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_TASK_ACTIVE' })
    await expect(
      client.changeOrigin({ centralOrigin: 'http://192.168.50.207:3000' }),
    ).rejects.toMatchObject({ code: 'AGENT_TASK_ACTIVE' })
    await expect(client.disconnect()).rejects.toMatchObject({ code: 'AGENT_TASK_ACTIVE' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a restarted backend write as uncertain and never replays it', async () => {
    const credentials = new MemoryCredentialStore()
    await credentials.set('central-device-token', 'device-token-that-is-long-enough-for-testing')
    const settings = new MemorySettings()
    settings.setSetting('provisioning_agent_origin', 'http://192.168.50.218:3001')
    settings.setSetting('provisioning_agent_device_id', '550e8400-e29b-41d4-a716-446655440000')
    settings.setSetting('provisioning_agent_device_name', 'Operator Mac')
    settings.setSetting('provisioning_agent_active_central_task', '550e8400-e29b-41d4-a716-446655440001')
    settings.setSetting('provisioning_agent_active_local_task', 'local-task-1')
    settings.tasks.set(
      'local-task-1',
      task({
        stage: 'interrupted',
        status: 'error',
        terminalFromStage: 'creating_account',
        account: null,
        error: {
          stage: 'interrupted',
          code: 'TASK_INTERRUPTED',
          message: '本地服务曾中断。',
          retryable: true,
        },
      }),
    )
    let postedResult: Record<string, unknown> | undefined
    let pendingNextSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname.endsWith('/result')) {
        postedResult = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ ok: true })
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        pendingNextSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await vi.waitFor(() => expect(postedResult).toBeTruthy())
    expect(postedResult).toMatchObject({
      status: 'uncertain',
      stage: 'interrupted',
      result: { terminalFromStage: 'creating_account' },
    })
    await vi.waitFor(() => {
      expect(settings.getSetting('provisioning_agent_active_central_task')).toBeNull()
      expect(settings.getSetting('provisioning_agent_active_local_task')).toBeNull()
    })
    await client.shutdown()
    expect(pendingNextSignal?.aborted).toBe(true)
  })

  it('stores the device token outside public status and runs a central task once', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    const terminal = task()
    settings.tasks.set(terminal.id, terminal)
    let jobDelivered = false
    let postedResult: unknown
    let startedInput: unknown
    let startedOptions: Record<string, unknown> | undefined
    let beginWriteBody: unknown
    let resolvedMaterials: AccountPoolMaterials | undefined
    let pendingNextSignal: AbortSignal | undefined
    const fallback: AccountPoolResolver = {
      resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
    }
    const materials = new RoutedAccountPoolResolver(fallback)
    const orchestrator = agentOrchestrator()
    orchestrator.startReserved.mockImplementation((_reservation, input, options) => {
        startedInput = input
        startedOptions = options
        return task({ stage: 'validating', status: 'active', account: null, message: '正在校验任务输入。' })
      })
    orchestrator.waitForCompletion.mockImplementation(async () => {
      await (startedOptions?.beforeBackendWrite as (stage: string) => Promise<void>)('creating_account')
      resolvedMaterials = await materials.resolve(
        'one@example.com',
        undefined,
        CENTRAL_TASK_ID,
      )
      return terminal
    })
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method || 'GET'
      if (url.pathname === '/api/provisioning/agent/pair') {
        return jsonResponse({
          deviceId: '550e8400-e29b-41d4-a716-446655440000',
          deviceToken: 'device-token-that-is-long-enough-for-testing',
          name: 'Operator Mac',
        }, 201)
      }
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next' && !jobDelivered) {
        jobDelivered = true
        return jsonResponse({
          job: {
            id: '550e8400-e29b-41d4-a716-446655440001',
            kind: 'task',
            operation: 'create',
            accountEmail: 'one@example.com',
            input: {
              proxyChoice: { mode: 'none' },
              concurrency: 10,
              supplier: null,
              groupIds: [],
              allowDuplicateCreation: true,
              confirmMixedChannelRisk: false,
            },
          },
        })
      }
      if (url.pathname.endsWith('/materials')) {
        return jsonResponse(remoteMaterials())
      }
      if (url.pathname === `/api/provisioning/agent/tasks/${CENTRAL_TASK_ID}/begin-write`) {
        beginWriteBody = JSON.parse(String(init?.body)) as unknown
        return jsonResponse({ ok: true })
      }
      if (url.pathname.endsWith('/events')) return jsonResponse({ ok: true })
      if (url.pathname.endsWith('/result') && method === 'POST') {
        postedResult = JSON.parse(String(init?.body)) as unknown
        return jsonResponse({ ok: true })
      }
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        pendingNextSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }) as typeof fetch

    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials,
      fetchImpl,
    })

    const status = await client.pair({
      centralOrigin: 'http://192.168.50.218:3001',
      pairingCode: 'PAIR-CODE-1234',
      deviceName: 'Operator Mac',
    })
    try {
      expect(status).not.toHaveProperty('deviceToken')
      await vi.waitFor(() => expect(postedResult).toBeTruthy())
      expect(await credentials.get('central-device-token')).toBe('device-token-that-is-long-enough-for-testing')
      expect(startedInput).toMatchObject({
        accountEmail: 'one@example.com',
        loginMaterialSource: 'account_pool',
      })
      expect(startedOptions).toMatchObject({ materialScope: CENTRAL_TASK_ID })
      expect(beginWriteBody).toEqual({ stage: 'creating_account' })
      expect(resolvedMaterials).toEqual({
        email: 'one@example.com',
        password: 'pool-password',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        mailboxAccess: 'pool-mailbox',
      })
      expect(JSON.stringify(postedResult)).not.toContain('pool-password')
      expect(JSON.stringify(postedResult)).not.toContain('pool-mailbox')
      expect(settings.getSetting('provisioning_agent_active_central_task')).toBeNull()
    } finally {
      await client.shutdown()
    }
    expect(pendingNextSignal?.aborted).toBe(true)
  })

  it('finishes the current central task before suspending and does not claim another job', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const orchestrator = agentOrchestrator()
    const terminal = task()
    settings.tasks.set(terminal.id, terminal)
    const completion = deferred<PublicTask>()
    orchestrator.waitForCompletion.mockReturnValue(completion.promise)
    let nextJobRequests = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        nextJobRequests += 1
        if (nextJobRequests === 1) return jsonResponse({ job: centralTaskJob() })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      if (url.pathname.endsWith('/materials')) return jsonResponse(remoteMaterials())
      if (url.pathname.endsWith('/events')) return jsonResponse({ ok: true })
      if (url.pathname.endsWith('/result')) return jsonResponse({ ok: true })
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await vi.waitFor(() => expect(client.status().runningTask).toBe(true))
    const suspending = client.suspend()
    await Promise.resolve()
    expect(client.status().runningTask).toBe(true)

    completion.resolve(terminal)
    await suspending

    expect(client.status()).toMatchObject({ paired: true, connected: false, runningTask: false })
    expect(nextJobRequests).toBe(1)

    await client.restore()
    await vi.waitFor(() => expect(nextJobRequests).toBe(2))
    await client.shutdown()
  })

  it('keeps a queued task running during manual intervention and claims the next job only after recovery', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const orchestrator = agentOrchestrator()
    const manualTask = task({
      stage: 'manual_intervention',
      status: 'active',
      account: null,
      message: '当前页面需要人工处理，授权浏览器已保留。',
    })
    const terminalTask = task()
    orchestrator.startReserved.mockReturnValue(manualTask)
    const completion = deferred<PublicTask>()
    orchestrator.waitForCompletion.mockReturnValue(completion.promise)

    let nextJobRequests = 0
    let resultRequests = 0
    const eventBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      if (url.pathname === '/api/provisioning/agent/jobs/next') {
        nextJobRequests += 1
        if (nextJobRequests === 1) return jsonResponse({ job: centralTaskJob() })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      if (url.pathname.endsWith('/materials')) return jsonResponse(remoteMaterials())
      if (url.pathname.endsWith('/events')) {
        eventBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return jsonResponse({ ok: true })
      }
      if (url.pathname.endsWith('/result')) {
        resultRequests += 1
        return jsonResponse({ ok: true })
      }
      throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator,
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    await client.restore()
    await vi.waitFor(() => expect(eventBodies).toContainEqual(expect.objectContaining({
      stage: 'manual_intervention',
    })))
    expect(client.status().runningTask).toBe(true)
    expect(nextJobRequests).toBe(1)
    expect(resultRequests).toBe(0)

    completion.resolve(terminalTask)
    await vi.waitFor(() => expect(resultRequests).toBe(1))
    await vi.waitFor(() => expect(nextJobRequests).toBe(2))
    expect(client.status().runningTask).toBe(false)
    await client.shutdown()
  })

  it('keeps the request timeout active while reading the response body', async () => {
    vi.useFakeTimers()
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    let requestSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller
            requestSignal?.addEventListener('abort', () => controller.error(requestSignal?.reason), { once: true })
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })
    const outcome = client
      .pair({
        centralOrigin: 'http://192.168.50.218:3001',
        pairingCode: 'PAIR-CODE-1234',
        deviceName: 'Operator Mac',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    try {
      await vi.waitFor(() => expect(requestSignal).toBeDefined())
      await vi.advanceTimersByTimeAsync(15_001)
      expect(requestSignal?.aborted).toBe(true)
      await expect(outcome).resolves.toMatchObject({ code: 'AGENT_CENTRAL_TIMEOUT' })
    } finally {
      if (!requestSignal?.aborted) bodyController?.error(new Error('test cleanup'))
      await outcome
      vi.useRealTimers()
    }
  })

  it('cancels a chunked response as soon as it exceeds the byte limit', async () => {
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    const cancel = vi.fn(async () => undefined)
    const chunks = [new Uint8Array(700 * 1024), new Uint8Array(400 * 1024)]
    let index = 0
    const response = {
      status: 201,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: vi.fn(async () =>
            index < chunks.length ? { done: false as const, value: chunks[index++] } : { done: true as const }),
          cancel,
          releaseLock: vi.fn(),
        }),
      },
      text: vi.fn(async () => 'x'.repeat(1024 * 1024 + 1)),
    } as unknown as Response
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: true, email: 'operator@example.com' })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl: vi.fn(async () => response) as typeof fetch,
    })

    await expect(
      client.pair({
        centralOrigin: 'http://192.168.50.218:3001',
        pairingCode: 'PAIR-CODE-1234',
        deviceName: 'Operator Mac',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('removes delay abort listeners after normal completion and abort', async () => {
    vi.useFakeTimers()
    const NativeAbortController = AbortController
    const tracked: Array<{
      signal: AbortSignal
      listeners: Set<EventListenerOrEventListenerObject>
    }> = []
    class TrackingAbortController extends NativeAbortController {
      constructor() {
        super()
        const signal = this.signal
        const listeners = new Set<EventListenerOrEventListenerObject>()
        const originalAdd = signal.addEventListener.bind(signal)
        const originalRemove = signal.removeEventListener.bind(signal)
        Object.defineProperty(signal, 'addEventListener', {
          value: (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (!listener) return
            if (type === 'abort' && listener) listeners.add(listener)
            originalAdd(type, listener, options)
          },
        })
        Object.defineProperty(signal, 'removeEventListener', {
          value: (
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
          ) => {
            if (!listener) return
            if (type === 'abort' && listener) listeners.delete(listener)
            originalRemove(type, listener, options)
          },
        })
        tracked.push({ signal, listeners })
      }
    }
    vi.stubGlobal('AbortController', TrackingAbortController)
    const credentials = new MemoryCredentialStore()
    const settings = new MemorySettings()
    pairedSettings(settings)
    await pairedCredentials(credentials)
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === '/api/provisioning/agent/heartbeat') return jsonResponse({ ok: true })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch
    const client = new ProvisioningAgentClient({
      credentials,
      settings,
      session: {
        ready: vi.fn(async () => undefined),
        publicSession: vi.fn(() => ({ authenticated: false, email: null })),
      },
      options: { loadSnapshot: vi.fn() },
      reauthorization: { listAccounts: vi.fn() },
      orchestrator: agentOrchestrator(),
      materials: new RoutedAccountPoolResolver({
        resolve: vi.fn(async (email: string) => ({ email, mailboxAccess: 'fallback' })),
      }),
      fetchImpl,
    })

    try {
      await client.restore()
      await vi.advanceTimersByTimeAsync(5_000)
      const loopSignal = tracked[0]
      expect(loopSignal?.listeners.size).toBeLessThanOrEqual(2)
      await client.shutdown()
      expect(loopSignal?.listeners.size).toBe(0)
    } finally {
      await client.shutdown()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it.each([
    ['ACCOUNT_CREATE_UNCERTAIN', undefined, 'uncertain'],
    ['ACCOUNT_REAUTHORIZATION_UNCERTAIN', undefined, 'uncertain'],
    ['ACCOUNT_BAN_WRITE_UNCERTAIN', undefined, 'uncertain'],
    [
      'BACKEND_HTTP_409',
      {
        detectedCount: 1 as const,
        retryAttempted: false,
        confirmed: false,
        targetAccountId: 88,
        banResult: 'write_uncertain' as const,
      },
      'uncertain',
    ],
    ['BACKEND_HTTP_409', undefined, 'error'],
    ['ACCOUNT_REAUTHORIZATION_FAILED', undefined, 'error'],
  ])('maps a terminal task condition to the expected central status', async (code, deactivation, expectedStatus) => {
    const postedResult = await runCentralTaskToResult(
      task({
        stage: 'failed',
        status: 'error',
        account: null,
        deactivation,
        error: {
          stage: 'failed',
          code,
          message: 'terminal failure',
          retryable: false,
        },
      }),
    )

    expect(postedResult.status).toBe(expectedStatus)
  })

  it('reports only the non-sensitive deactivation summary for confirmed banned accounts', async () => {
    const postedResult = await runCentralTaskToResult(
      task({
        stage: 'failed',
        status: 'error',
        account: { id: 88, name: 'one@example.com', status: 'banned' },
        deactivation: {
          detectedCount: 2,
          retryAttempted: true,
          confirmed: true,
          targetAccountId: 88,
          banResult: 'banned',
        },
        error: {
          stage: 'confirming_account_banned',
          code: 'OPENAI_ACCOUNT_DEACTIVATED_BANNED',
          message: 'OpenAI 账号已确认停用；对应后台账号已标记为封号。',
          retryable: false,
        },
      }),
    )

    expect(postedResult).toMatchObject({
      status: 'error',
      result: {
        account: { id: 88, name: 'one@example.com', status: 'banned' },
        deactivation: {
          detectedCount: 2,
          retryAttempted: true,
          confirmed: true,
          targetAccountId: 88,
          banResult: 'banned',
        },
        error: {
          code: 'OPENAI_ACCOUNT_DEACTIVATED_BANNED',
          retryable: false,
        },
      },
    })
    expect(Object.keys((postedResult.result as Record<string, unknown>).deactivation as object).sort()).toEqual([
      'banResult',
      'confirmed',
      'detectedCount',
      'retryAttempted',
      'targetAccountId',
    ])
  })
})
