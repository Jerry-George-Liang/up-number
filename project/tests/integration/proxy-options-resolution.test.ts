import { describe, expect, it, vi } from 'vitest'
import type { BackendRequester } from '../../src/server/backend/client'
import { BackendOptionsApi } from '../../src/server/backend/options'
import { ProxyResolver } from '../../src/server/tasks/proxy-resolver'

describe('proxy option resolution', () => {
  it('resolves a dynamic assignment from the private all-proxies index without a privileged detail request', async () => {
    const requester = {
      request: vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === 'admin/proxies/all') {
          return {
            proxies: [
              {
                id: 285,
                name: 'Assigned proxy',
                protocol: 'socks5h',
                host: 'proxy.internal.invalid',
                port: 8443,
                username: 'synthetic-user',
                password: 'synthetic-password',
              },
            ],
          }
        }
        if (path === 'admin/proxy-machines?page_size=200') return { items: [] }
        if (path === 'admin/proxies/subscriptions') {
          return {
            items: [
              {
                id: 21,
                name: 'Healthy pool',
                enabled: true,
                node_count: 3,
                healthy_node_count: 2,
              },
            ],
          }
        }
        if (path === 'admin/accounts/suppliers') return { suppliers: [] }
        if (path === 'admin/groups/all') return []
        if (path === 'admin/proxies/assignments/resolve') {
          expect(options).toEqual({
            method: 'POST',
            body: {
              mode: 'dynamic',
              subscription_id: 21,
              affinity_key: 'user@example.invalid',
            },
          })
          return { proxy_id: 285 }
        }
        throw new Error(`unexpected path: ${path}`)
      }),
    }
    const options = new BackendOptionsApi(requester as unknown as BackendRequester)
    const snapshot = await options.loadSnapshot()
    const resolver = new ProxyResolver(options)

    await expect(
      resolver.resolve({ mode: 'dynamic', subscriptionId: 21 }, snapshot, 'user@example.invalid'),
    ).resolves.toEqual({
      mode: 'dynamic',
      proxyId: 285,
      proxyName: 'Assigned proxy',
      assignmentMode: 'dynamic',
      subscriptionId: 21,
      browserProxy: {
        server: 'socks5://proxy.internal.invalid:8443',
        username: 'synthetic-user',
        password: 'synthetic-password',
      },
    })

    expect(JSON.stringify(snapshot)).not.toMatch(/proxy\.internal\.invalid|synthetic-user|synthetic-password/)
    expect(requester.request).toHaveBeenCalledTimes(6)
    expect(requester.request.mock.calls.map(([path]) => path)).not.toContain('admin/proxies/285')
  })
})
