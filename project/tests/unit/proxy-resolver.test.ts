import { describe, expect, it, vi } from 'vitest'
import type { OptionsSnapshot } from '../../src/shared/contracts'
import { ProxyResolver } from '../../src/server/tasks/proxy-resolver'

const snapshot: OptionsSnapshot = {
  version: 'v1',
  loadedAt: '2026-08-11T08:00:00.000Z',
  proxies: [
    { id: 11, name: 'Tokyo fixed', status: 'active' },
    { id: -41, name: 'Machine only', status: 'active', proxyMachineId: 41 },
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
  suppliers: [],
  groups: [],
}

function createBackend() {
  return {
    resolveAssignment: vi.fn(async (choice: { mode: 'random_fixed' } | { mode: 'dynamic'; subscription_id: number }) => ({
      proxyId: choice.mode === 'random_fixed' ? 12 : 13,
      proxyName: choice.mode === 'random_fixed' ? 'Random result' : 'Dynamic result',
    })),
    getProxy: vi.fn(async (id: number) => ({
      id,
      name: `Proxy ${id}`,
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'proxy-user',
      password: 'proxy-password',
    })),
    getProxyMachine: vi.fn(async (id: number) => ({
      id,
      name: `Machine ${id}`,
      server: 'socks5://127.0.0.1:9000',
    })),
  }
}

describe('ProxyResolver', () => {
  it('keeps none as a true direct connection', async () => {
    const backend = createBackend()
    const resolver = new ProxyResolver(backend)
    await expect(resolver.resolve({ mode: 'none' }, snapshot, 'user@example.invalid')).resolves.toEqual({ mode: 'none' })
    expect(backend.resolveAssignment).not.toHaveBeenCalled()
    expect(backend.getProxy).not.toHaveBeenCalled()
  })

  it('uses a selected fixed proxy and creates an in-memory browser config', async () => {
    const backend = createBackend()
    const resolver = new ProxyResolver(backend)
    await expect(resolver.resolve({ mode: 'fixed', proxyId: 11 }, snapshot, 'user@example.invalid')).resolves.toEqual({
      mode: 'fixed',
      proxyId: 11,
      proxyName: 'Tokyo fixed',
      browserProxy: {
        server: 'http://127.0.0.1:8080',
        username: 'proxy-user',
        password: 'proxy-password',
      },
    })
  })

  it('uses the real machine id and direct machine connection for a virtual option', async () => {
    const backend = createBackend()
    const resolver = new ProxyResolver(backend)
    await expect(
      resolver.resolve({ mode: 'fixed', proxyId: -41 }, snapshot, 'user@example.invalid'),
    ).resolves.toEqual({
      mode: 'fixed',
      machineId: 41,
      proxyName: 'Machine only',
      browserProxy: { server: 'socks5://127.0.0.1:9000' },
    })
    expect(backend.getProxyMachine).toHaveBeenCalledWith(41)
    expect(backend.getProxy).not.toHaveBeenCalled()
  })

  it.each([
    [
      { mode: 'random_fixed' } as const,
      { mode: 'random_fixed', affinity_key: 'user@example.invalid' },
      12,
    ],
    [
      { mode: 'dynamic', subscriptionId: 21 } as const,
      { mode: 'dynamic', subscription_id: 21, affinity_key: 'user@example.invalid' },
      13,
    ],
  ])('resolves %o exactly once and then pins its proxy id', async (choice, expectedBody, expectedId) => {
    const backend = createBackend()
    const resolver = new ProxyResolver(backend)
    const result = await resolver.resolve(choice, snapshot, 'user@example.invalid')
    expect(backend.resolveAssignment).toHaveBeenCalledWith(expectedBody)
    expect(backend.resolveAssignment).toHaveBeenCalledTimes(1)
    expect(backend.getProxy).toHaveBeenCalledWith(expectedId)
    expect(result.mode).not.toBe('none')
    if (result.mode !== 'none') expect(result.proxyId).toBe(expectedId)
  })

  it('uses the proxy detail name when an assignment response only contains the proxy id', async () => {
    const backend = createBackend()
    backend.resolveAssignment.mockResolvedValueOnce({ proxyId: 285 } as never)
    backend.getProxy.mockResolvedValueOnce({
      id: 285,
      name: 'Resolved proxy detail',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: 'proxy-user',
      password: 'proxy-password',
    })
    const resolver = new ProxyResolver(backend)

    await expect(
      resolver.resolve({ mode: 'dynamic', subscriptionId: 21 }, snapshot, 'user@example.invalid'),
    ).resolves.toMatchObject({
      mode: 'dynamic',
      proxyId: 285,
      proxyName: 'Resolved proxy detail',
      browserProxy: { server: 'http://127.0.0.1:8080' },
    })
    expect(backend.getProxy).toHaveBeenCalledWith(285)
  })

  it.each([
    {
      id: 285,
      name: 'Dynamic SOCKS5H fields',
      protocol: 'socks5h',
      host: 'proxy.internal.invalid',
      port: 1080,
    },
    {
      id: 285,
      name: 'Dynamic SOCKS5H URL',
      proxyUrl: 'socks5h://proxy.internal.invalid:1080',
    },
  ])('normalizes backend SOCKS5H aliases for Chromium: $name', async (proxy) => {
    const backend = createBackend()
    backend.resolveAssignment.mockResolvedValueOnce({ proxyId: 285 } as never)
    backend.getProxy.mockResolvedValueOnce(proxy as never)
    const resolver = new ProxyResolver(backend)

    await expect(
      resolver.resolve({ mode: 'dynamic', subscriptionId: 21 }, snapshot, 'user@example.invalid'),
    ).resolves.toMatchObject({
      mode: 'dynamic',
      proxyId: 285,
      browserProxy: { server: 'socks5://proxy.internal.invalid:1080' },
    })
  })

  it.each([
    { id: 21, name: 'Disabled pool', enabled: false, healthyNodeCount: 4 },
    { id: 21, name: 'Empty pool', enabled: true, healthyNodeCount: 0 },
  ])('does not resolve an unavailable dynamic subscription', async (subscription) => {
    const backend = createBackend()
    const resolver = new ProxyResolver(backend)

    await expect(
      resolver.resolve(
        { mode: 'dynamic', subscriptionId: 21 },
        { ...snapshot, subscriptions: [subscription] },
        'user@example.invalid',
      ),
    ).rejects.toMatchObject({ code: 'OPTION_SELECTION_UNAVAILABLE' })
    expect(backend.resolveAssignment).not.toHaveBeenCalled()
    expect(backend.getProxy).not.toHaveBeenCalled()
  })

  it('fails before browser launch when the selected proxy lacks connection details', async () => {
    const backend = createBackend()
    backend.getProxy.mockResolvedValueOnce({ id: 11, name: 'Broken proxy' } as never)
    const resolver = new ProxyResolver(backend)
    await expect(
      resolver.resolve({ mode: 'fixed', proxyId: 11 }, snapshot, 'user@example.invalid'),
    ).rejects.toMatchObject({
      code: 'PROXY_CONFIG_INVALID',
    })
  })
})
