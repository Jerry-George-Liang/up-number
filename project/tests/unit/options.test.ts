import { describe, expect, it, vi } from 'vitest'
import type { CreateTaskInput } from '../../src/shared/contracts'
import { BackendOptionsApi, validateTaskSelection } from '../../src/server/backend/options'
import type { BackendRequester } from '../../src/server/backend/client'

describe('BackendOptionsApi', () => {
  it('loads and normalizes backend options including proxy machines', async () => {
    const requester = {
      request: vi.fn(async (path: string) => {
        if (path === 'admin/proxies/all') {
          return {
            proxies: [
              {
                id: 11,
                name: 'Tokyo fixed',
                status: 'active',
                protocol: 'http',
                host: '127.0.0.1',
                port: 8080,
                username: null,
                password: null,
              },
              { id: 12, name: 'Unbound fixed', status: 'active' },
            ],
          }
        }
        if (path === 'admin/proxy-machines?page_size=200') {
          return {
            items: [
              { id: 41, name: 'Bound machine', proxy_id: 11, status: 'active' },
              { id: 42, name: 'Direct machine', endpoint: 'socks5://127.0.0.1:9000', status: 'active' },
              { id: 43, name: 'Inactive machine', status: 'inactive' },
            ],
          }
        }
        if (path === 'admin/proxies/subscriptions') {
          return {
            items: [{ id: 21, name: 'Dynamic pool', enabled: true, node_count: 17, healthy_node_count: 4 }],
          }
        }
        if (path === 'admin/accounts/suppliers') return { suppliers: ['Primary', { name: 'Backup' }] }
        if (path === 'admin/groups/all') return [{ id: 31, name: 'Default group', status: 'active' }]
        throw new Error(`unexpected path: ${path}`)
      }),
    }
    const api = new BackendOptionsApi(
      requester as unknown as BackendRequester,
      () => new Date('2026-08-11T08:00:00.000Z'),
    )

    const snapshot = await api.loadSnapshot()

    expect(snapshot).toEqual({
      version: '2026-08-11T08:00:00.000Z',
      loadedAt: '2026-08-11T08:00:00.000Z',
      proxies: [
        {
          id: 11,
          name: 'Bound machine',
          status: 'active',
          proxyMachineId: 41,
          proxyMachineProxyId: 11,
        },
        { id: -42, name: 'Direct machine', status: 'active', proxyMachineId: 42 },
        { id: 12, name: 'Unbound fixed', status: 'active' },
      ],
      subscriptions: [
        {
          id: 21,
          name: 'Dynamic pool',
          status: 'active',
          enabled: true,
          nodeCount: 17,
          healthyNodeCount: 4,
        },
      ],
      suppliers: ['Primary', 'Backup'],
      groups: [{ id: 31, name: 'Default group', status: 'active' }],
    })
    expect(requester.request).toHaveBeenCalledTimes(5)
    await expect(api.getProxy(11)).resolves.toEqual({
      id: 11,
      name: 'Tokyo fixed',
      server: undefined,
      proxyUrl: undefined,
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: undefined,
      password: undefined,
    })
    expect(requester.request).toHaveBeenCalledTimes(5)
    expect(requester.request).not.toHaveBeenCalledWith('admin/proxies/11')
    expect(JSON.stringify(snapshot)).not.toMatch(/127\.0\.0\.1|username|password/)
  })

  it('refreshes the accessible proxy list on a cache miss without using the privileged detail route', async () => {
    const requester = {
      request: vi.fn(async (path: string) => {
        if (path === 'admin/proxies/all') {
          return {
            proxies: [
              {
                id: 285,
                name: 'Assigned proxy',
                protocol: 'socks5',
                host: '127.0.0.1',
                port: 1080,
                username: 'proxy-user',
                password: 'proxy-secret',
              },
            ],
          }
        }
        throw new Error(`unexpected path: ${path}`)
      }),
    }
    const api = new BackendOptionsApi(requester as unknown as BackendRequester)

    await expect(api.getProxy(285)).resolves.toMatchObject({
      id: 285,
      server: undefined,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'proxy-user',
      password: 'proxy-secret',
    })
    expect(requester.request).toHaveBeenCalledOnce()
    expect(requester.request).toHaveBeenCalledWith('admin/proxies/all')
    expect(requester.request).not.toHaveBeenCalledWith('admin/proxies/285')
  })

  it('accepts the current assignment response when it returns a proxy id without a name', async () => {
    const requester = {
      request: vi.fn(async () => ({
        success: 1,
        skipped: 0,
        failed: 0,
        proxy_id: 285,
        distribution: { 285: 1 },
      })),
    }
    const api = new BackendOptionsApi(requester as unknown as BackendRequester)

    await expect(
      api.resolveAssignment({ mode: 'dynamic', subscription_id: 4, affinity_key: 'user@example.invalid' }),
    ).resolves.toEqual({ proxyId: 285 })
    expect(requester.request).toHaveBeenCalledWith('admin/proxies/assignments/resolve', {
      method: 'POST',
      body: { mode: 'dynamic', subscription_id: 4, affinity_key: 'user@example.invalid' },
    })
  })
})

describe('validateTaskSelection', () => {
  const snapshot = {
    version: 'v1',
    loadedAt: '2026-08-11T08:00:00.000Z',
    proxies: [
      { id: 11, name: 'Tokyo fixed', status: 'active' },
      { id: -41, name: 'Machine only', status: 'active', proxyMachineId: 41 },
    ],
    subscriptions: [{ id: 21, name: 'Dynamic pool', status: 'active' }],
    suppliers: ['Primary'],
    groups: [{ id: 31, name: 'Default group', status: 'active' }],
  }

  function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
    return {
      accountEmail: 'user@example.invalid',
      loginMaterial: { kind: 'email_otp', mailboxAccess: 'mail-secret' },
      proxyChoice: { mode: 'fixed', proxyId: 11 },
      concurrency: 10,
      supplier: 'Primary',
      groupIds: [31],
      allowDuplicateCreation: false,
      confirmMixedChannelRisk: false,
      ...overrides,
    }
  }

  it('returns a public selection containing only names and validated ids', () => {
    expect(validateTaskSelection(input(), snapshot)).toEqual({
      operation: 'create',
      proxyMode: 'fixed',
      proxyId: 11,
      proxyName: 'Tokyo fixed',
      concurrency: 10,
      supplier: 'Primary',
      groups: [{ id: 31, name: 'Default group' }],
      allowDuplicateCreation: false,
      confirmMixedChannelRisk: false,
      modelsCleared: true,
      loginMaterialSource: 'manual',
    })
  })

  it.each([
    { id: 21, name: 'Disabled pool', enabled: false, healthyNodeCount: 4 },
    { id: 21, name: 'Empty pool', enabled: true, healthyNodeCount: 0 },
  ])('rejects an unavailable dynamic subscription before task execution', (subscription) => {
    expect(() =>
      validateTaskSelection(
        input({ proxyChoice: { mode: 'dynamic', subscriptionId: 21 } }),
        { ...snapshot, subscriptions: [subscription] },
      ),
    ).toThrowError(expect.objectContaining({ code: 'OPTION_SELECTION_UNAVAILABLE' }))
  })

  it('keeps a machine-only selection without exposing a synthetic proxy id', () => {
    expect(
      validateTaskSelection(input({ proxyChoice: { mode: 'fixed', proxyId: -41 } }), snapshot),
    ).toMatchObject({ proxyMode: 'fixed', machineId: 41, proxyName: 'Machine only' })
  })

  it.each([
    input({ proxyChoice: { mode: 'fixed', proxyId: 999 } }),
    input({ proxyChoice: { mode: 'dynamic', subscriptionId: 999 } }),
    input({ supplier: 'Injected supplier' }),
    input({ groupIds: [999] }),
  ])('rejects a selection not present in the current snapshot', (untrustedInput) => {
    expect(() => validateTaskSelection(untrustedInput, snapshot)).toThrow(/选项|代理|供应商|分组/)
  })
})
