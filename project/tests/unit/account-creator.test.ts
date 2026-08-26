import { describe, expect, it, vi } from 'vitest'
import {
  BackendAccountsApi,
  allowlistOpenAICredentials,
  buildOAuthCredentialsApplication,
  type BackendAccount,
} from '../../src/server/backend/accounts'
import { AccountCreator, buildOpenAIAccountPayload } from '../../src/server/tasks/account-creator'

const exchangeResponse = {
  access_token: 'access-value',
  refresh_token: 'refresh-value',
  id_token: 'id-value',
  expires_at: 1_800_000_000,
  email: 'user@example.invalid',
  chatgpt_account_id: 'account-id',
  name: 'OpenAI profile name',
  privacy_mode: 'training_off',
  unknown_secret: 'must-not-pass-through',
  model_mapping: { forbidden: 'field' },
}

const generatedAuthUrl =
  'https://auth.openai.com/oauth/authorize?client_id=synthetic-client&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=expected-state'

describe('OpenAI account payload', () => {
  it('builds the dedicated reauthorization payload without create settings or unknown fields', () => {
    expect(buildOAuthCredentialsApplication(allowlistOpenAICredentials(exchangeResponse))).toEqual({
      type: 'oauth',
      credentials: {
        access_token: 'access-value',
        refresh_token: 'refresh-value',
        id_token: 'id-value',
        expires_at: 1_800_000_000,
        email: 'user@example.invalid',
        chatgpt_account_id: 'account-id',
      },
      extra: {
        email: 'user@example.invalid',
        name: 'OpenAI profile name',
        privacy_mode: 'training_off',
      },
    })
  })

  it('allowlists exchange fields and always omits model_mapping', () => {
    const credentials = allowlistOpenAICredentials(exchangeResponse)
    const payload = buildOpenAIAccountPayload({
      email: ' User@Example.Invalid ',
      credentials,
      proxyId: 11,
      concurrency: 10,
      supplier: 'Primary',
      groupIds: [31],
      confirmMixedChannelRisk: true,
    })

    expect(payload).toMatchObject({
      name: 'user@example.invalid',
      platform: 'openai',
      type: 'oauth',
      notes: '',
      proxy_id: 11,
      machine_id: null,
      concurrency: 10,
      priority: 1,
      rate_multiplier: 1,
      group_ids: [31],
      supplier: 'Primary',
      expires_at: null,
      auto_pause_on_expired: true,
      random_rest_enabled: false,
      confirm_mixed_channel_risk: true,
    })
    expect(payload.credentials).toEqual({
      access_token: 'access-value',
      refresh_token: 'refresh-value',
      id_token: 'id-value',
      expires_at: 1_800_000_000,
      email: 'user@example.invalid',
      chatgpt_account_id: 'account-id',
    })
    expect(payload.extra).toEqual({
      email: 'user@example.invalid',
      name: 'OpenAI profile name',
      privacy_mode: 'training_off',
      openai_oauth_responses_websockets_v2_mode: 'off',
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_long_context_billing_enabled: false,
    })
    expect(payload.credentials).not.toHaveProperty('model_mapping')
    expect(payload.credentials).not.toHaveProperty('unknown_secret')
  })

  it('sends deployed null sentinels for omitted proxy and supplier selections', () => {
    const payload = buildOpenAIAccountPayload({
      email: 'user@example.invalid',
      credentials: allowlistOpenAICredentials(exchangeResponse),
      concurrency: 10,
      supplier: null,
      groupIds: [],
      confirmMixedChannelRisk: false,
    })
    expect(payload.proxy_id).toBeNull()
    expect(payload.machine_id).toBeNull()
    expect(payload.supplier).toBeNull()
    expect(payload).not.toHaveProperty('confirm_mixed_channel_risk')
  })

  it('accepts an exchange without refresh_token and preserves assignment metadata', () => {
    const payload = buildOpenAIAccountPayload({
      email: 'user@example.invalid',
      credentials: allowlistOpenAICredentials({ access_token: 'access-only' }),
      proxyId: 13,
      assignmentMode: 'dynamic',
      subscriptionId: 21,
      concurrency: 10,
      supplier: null,
      groupIds: [],
      confirmMixedChannelRisk: false,
    })
    expect(payload.credentials).toEqual({ access_token: 'access-only' })
    expect(payload).toMatchObject({
      proxy_assignment_mode: 'dynamic',
      proxy_subscription_id: 21,
      proxy_id: 13,
    })
  })
})

describe('BackendAccountsApi', () => {
  it('lists only sanitized OpenAI OAuth summaries and confirms exact credentials in memory', async () => {
    const requester = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          items: [
            {
              id: 71,
              name: 'user@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              created_at: '2026-08-16T08:00:00.000Z',
              updated_at: '2026-08-16T09:30:00.000Z',
              credentials: {
                email: 'user@example.invalid',
                access_token: 'new-access-token',
                refresh_token: 'new-refresh-token',
              },
              extra: { codex_7d_used_percent: 100 },
            },
            {
              id: 72,
              name: 'over-limit@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'over-limit@example.invalid' },
              extra: { codex_7d_used_percent: 99 },
            },
          ],
          page: 1,
          page_size: 100,
          total: 2,
          pages: 1,
        })
        .mockResolvedValueOnce({ seven_day: { utilization: '89.5' } })
        .mockResolvedValueOnce({ seven_day: { utilization: 99 } })
        .mockResolvedValueOnce({
          id: 71,
          name: 'user@example.invalid',
          status: 'active',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'user@example.invalid',
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
          },
        }),
    }
    const api = new BackendAccountsApi(requester as never)
    await expect(
      api.listReauthorizationAccounts({
        search: '',
        page: 1,
        pageSize: 50,
        maxUsage7dPercent: 90,
      }),
    ).resolves.toEqual({
      items: [{
        id: 71,
        name: 'user@example.invalid',
        email: 'user@example.invalid',
        status: 'error',
        usage7dPercent: 89.5,
        importedAt: '2026-08-16T08:00:00.000Z',
        errorAt: '2026-08-16T09:30:00.000Z',
      }],
      page: 1,
      pageSize: 50,
      total: 1,
      pages: 1,
    })
    await expect(api.confirmAppliedCredentials(71, {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    })).resolves.toMatchObject({ matched: true, account: { id: 71 } })
    expect(requester.request).toHaveBeenNthCalledWith(1, expect.stringContaining('admin/accounts?'))
    expect(requester.request.mock.calls[0]![0]).not.toContain('platform=')
    expect(requester.request.mock.calls[0]![0]).not.toContain('type=')
    expect(requester.request.mock.calls[0]![0]).toContain('status=error')
    expect(requester.request.mock.calls[0]![0]).toContain('usage_window=7d')
    expect(requester.request.mock.calls[0]![0]).toContain('usage_operator=lte')
    expect(requester.request.mock.calls[0]![0]).toContain('usage_percent=90')
    expect(requester.request.mock.calls[1]![0]).toBe('admin/accounts/71/usage')
  })

  it('applies the user-selected threshold to live 7-day usage instead of stale list data', async () => {
    const requester = {
      request: vi.fn(async (path: string) => {
        if (path === 'admin/accounts/71/usage') return { seven_day: { utilization: 37 } }
        if (path === 'admin/accounts/72/usage') return { seven_day: { utilization: 38 } }
        return {
          items: [
            {
              id: 71,
              name: 'eligible@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'eligible@example.invalid' },
              extra: { codex_7d_used_percent: 100 },
            },
            {
              id: 72,
              name: 'over-limit@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'over-limit@example.invalid' },
              extra: { codex_7d_used_percent: 0 },
            },
          ],
          page: 1,
          page_size: 100,
          total: 2,
          pages: 1,
        }
      }),
    }
    const api = new BackendAccountsApi(requester as never)

    const result = await api.listReauthorizationAccounts({
      search: 'user@example.invalid',
      page: 1,
      pageSize: 50,
      maxUsage7dPercent: 37,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe(71)
    expect(result.total).toBe(1)
    expect(requester.request).toHaveBeenCalledWith(expect.stringContaining('search=user%40example.invalid'))
  })

  it('filters by imported time before requesting live usage and paginating', async () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const requester = {
      request: vi.fn(async (path: string) => {
        if (path === 'admin/accounts/71/usage') return { seven_day: { utilization: 20 } }
        if (path.endsWith('/usage')) throw new Error(`unexpected usage request: ${path}`)
        return {
          items: [
            {
              id: 71,
              name: 'recent@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'recent@example.invalid' },
              created_at: '2026-08-17T12:00:00.000Z',
            },
            {
              id: 72,
              name: 'old@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'old@example.invalid' },
              created_at: '2026-08-01T12:00:00.000Z',
            },
            {
              id: 73,
              name: 'unknown-time@example.invalid',
              status: 'error',
              platform: 'openai',
              type: 'oauth',
              credentials: { email: 'unknown-time@example.invalid' },
              created_at: 'not-a-date',
            },
          ],
          page: 1,
          page_size: 100,
          total: 3,
          pages: 1,
        }
      }),
    }
    const api = new BackendAccountsApi(requester as never)

    try {
      await expect(api.listReauthorizationAccounts({
        search: '',
        page: 1,
        pageSize: 50,
        maxUsage7dPercent: 90,
        importedWithinDays: 7,
      })).resolves.toMatchObject({
        items: [{ id: 71 }],
        total: 1,
        pages: 1,
      })
      expect(requester.request).toHaveBeenCalledTimes(2)
      expect(requester.request).toHaveBeenCalledWith('admin/accounts/71/usage')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('collects every backend page before paginating eligible reauthorization accounts', async () => {
    const account = (id: number, used: number) => ({
      id,
      name: `user-${id}@example.invalid`,
      status: 'error',
      platform: 'openai',
      type: 'oauth',
      credentials: { email: `user-${id}@example.invalid` },
      extra: { codex_7d_used_percent: used },
    })
    const requester = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          items: [account(1, 91), account(2, 20)],
          page: 1,
          page_size: 2,
          total: 4,
          pages: 2,
        })
        .mockResolvedValueOnce({
          items: [account(3, 30), account(4, 99)],
          page: 2,
          page_size: 2,
          total: 4,
          pages: 2,
        })
        .mockResolvedValueOnce({ seven_day: { utilization: 91 } })
        .mockResolvedValueOnce({ seven_day: { utilization: 20 } })
        .mockResolvedValueOnce({ seven_day: { utilization: 30 } })
        .mockResolvedValueOnce({ seven_day: { utilization: 99 } }),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.listReauthorizationAccounts({
      search: '',
      page: 1,
      pageSize: 1,
      maxUsage7dPercent: 90,
    })).resolves.toMatchObject({
      items: [{ id: 2 }],
      page: 1,
      pageSize: 1,
      total: 2,
      pages: 2,
    })
    await expect(api.listReauthorizationAccounts({
      search: '',
      page: 2,
      pageSize: 1,
      maxUsage7dPercent: 90,
    })).resolves.toMatchObject({
      items: [{ id: 3 }],
      page: 2,
      pageSize: 1,
      total: 2,
      pages: 2,
    })
    expect(requester.request).toHaveBeenCalledTimes(6)
    expect(requester.request.mock.calls[1]![0]).toContain('page=2')
  })

  it('follows declared account-search pagination before deciding uniqueness', async () => {
    const requester = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          items: [{
            id: 71,
            name: 'user@example.invalid',
            status: 'error',
            platform: 'openai',
            type: 'oauth',
            credentials: { email: 'user@example.invalid' },
          }],
          page: 1,
          page_size: 1,
          total: 2,
        })
        .mockResolvedValueOnce({
          items: [{
            id: 72,
            name: 'user@example.invalid',
            status: 'error',
            platform: 'openai',
            type: 'oauth',
            credentials: { email: 'user@example.invalid' },
          }],
          page: 2,
          page_size: 1,
          total: 2,
        }),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.findAccounts('user@example.invalid')).resolves.toMatchObject([
      { id: 71 },
      { id: 72 },
    ])
    expect(requester.request).toHaveBeenCalledTimes(2)
    expect(requester.request.mock.calls[1]![0]).toContain('page=2')
  })

  it('rejects a full account-search page without pagination evidence', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `user-${index}@example.invalid`,
      status: 'error',
      platform: 'openai',
      type: 'oauth',
      credentials: { email: `user-${index}@example.invalid` },
    }))
    const api = new BackendAccountsApi({ request: vi.fn(async () => ({ items })) } as never)

    await expect(api.findAccounts('user@example.invalid')).rejects.toMatchObject({
      code: 'BACKEND_ACCOUNT_SEARCH_INCOMPLETE',
    })
  })

  it('writes and parses the deployed banned management status contract', async () => {
    const requester = {
      request: vi.fn(async () => ({
        account: {
          id: 71,
          name: 'user@example.invalid',
          status: 'error',
          management_status: 'banned',
          platform: 'openai',
          type: 'oauth',
          credentials: { email: 'user@example.invalid' },
        },
      })),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.updateManagementStatus(71, 'banned', 'confirmed reason')).resolves.toMatchObject({
      id: 71,
      managementStatus: 'banned',
    })
    expect(requester.request).toHaveBeenCalledWith('admin/accounts/71', {
      method: 'PUT',
      body: {
        management_status: 'banned',
        status_reason: 'confirmed reason',
      },
    })
  })

  it('updates only the backend account name for a confirmed mailbox expiry note', async () => {
    const requester = {
      request: vi.fn(async () => ({
        id: 71,
        name: 'user@example.invalid（邮箱接码过期）',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentials: { email: 'user@example.invalid' },
      })),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.updateAccountName(71, 'user@example.invalid（邮箱接码过期）')).resolves.toMatchObject({
      id: 71,
      name: 'user@example.invalid（邮箱接码过期）',
    })
    expect(requester.request).toHaveBeenCalledWith('admin/accounts/71', {
      method: 'PUT',
      body: { name: 'user@example.invalid（邮箱接码过期）' },
    })
  })

  it('loads an OpenAI OAuth target after a successful write changes its status', async () => {
    const requester = {
      request: vi.fn(async (path: string) => {
        if (path === 'admin/accounts/71/usage') return { seven_day: { utilization: 37 } }
        return {
          id: 71,
          name: 'user@example.invalid',
          status: 'active',
          platform: 'openai',
          type: 'oauth',
          credentials: { email: 'user@example.invalid' },
          extra: { codex_7d_used_percent: 100 },
        }
      }),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.getReauthorizationTarget(71)).resolves.toMatchObject({
      id: 71,
      status: 'active',
      codex7dUsedPercent: 37,
    })
    expect(requester.request).toHaveBeenNthCalledWith(1, 'admin/accounts/71')
    expect(requester.request).toHaveBeenNthCalledWith(2, 'admin/accounts/71/usage')
  })

  it('rejects a reauthorization detail response for a different account id', async () => {
    const requester = {
      request: vi.fn(async () => ({
        id: 72,
        name: 'other@example.invalid',
        status: 'error',
        platform: 'openai',
        type: 'oauth',
        credentials: { email: 'other@example.invalid' },
      })),
    }
    const api = new BackendAccountsApi(requester as never)

    await expect(api.getReauthorizationTarget(71)).rejects.toMatchObject({
      code: 'REAUTHORIZATION_TARGET_INVALID',
    })
    expect(requester.request).toHaveBeenCalledWith('admin/accounts/71')
  })

  it('generates and exchanges OAuth using one pinned proxy id', async () => {
    const requester = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          auth_url: generatedAuthUrl,
          session_id: 'backend-session',
        })
        .mockResolvedValueOnce(exchangeResponse),
    }
    const api = new BackendAccountsApi(requester as never)
    const generated = await api.generateAuthUrl({ proxyId: 11 })
    const credentials = await api.exchangeCode({
      sessionId: generated.sessionId,
      code: 'oauth-code',
      state: generated.state,
      proxyId: 11,
    })

    expect(requester.request).toHaveBeenNthCalledWith(1, 'admin/openai/generate-auth-url', {
      method: 'POST',
      body: { proxy_id: 11 },
    })
    expect(requester.request).toHaveBeenNthCalledWith(2, 'admin/openai/exchange-code', {
      method: 'POST',
      body: {
        session_id: 'backend-session',
        code: 'oauth-code',
        state: 'expected-state',
        proxy_id: 11,
      },
    })
    expect(credentials).not.toHaveProperty('unknown_secret')
  })

  it('matches the deployed frontend body rules for machine and redirect inputs', async () => {
    const requester = {
      request: vi.fn(async () => ({ auth_url: generatedAuthUrl, session_id: 'backend-session' })),
    }
    const api = new BackendAccountsApi(requester as never)

    await api.generateAuthUrl({ machineId: 22, redirectUri: 'http://localhost:1455/auth/callback' })
    await api.generateAuthUrl({
      proxyId: 11,
      machineId: 22,
      redirectUri: 'http://localhost:1455/auth/callback',
    })

    expect(requester.request).toHaveBeenNthCalledWith(1, 'admin/openai/generate-auth-url', {
      method: 'POST',
      body: { machine_id: 22, redirect_uri: 'http://localhost:1455/auth/callback' },
    })
    expect(requester.request).toHaveBeenNthCalledWith(2, 'admin/openai/generate-auth-url', {
      method: 'POST',
      body: { proxy_id: 11, redirect_uri: 'http://localhost:1455/auth/callback' },
    })
  })

  it('calls the deployed mixed-channel preflight endpoint', async () => {
    const requester = { request: vi.fn(async () => ({ has_risk: true })) }
    const api = new BackendAccountsApi(requester as never)
    await expect(api.checkMixedChannel([31, 32])).resolves.toEqual({ hasRisk: true })
    expect(requester.request).toHaveBeenCalledWith('admin/accounts/check-mixed-channel', {
      method: 'POST',
      body: { platform: 'openai', group_ids: [31, 32] },
    })
  })
})

describe('AccountCreator duplicate protection', () => {
  it('uses exact normalized name/email matching on every duplicate check', async () => {
    const existing: BackendAccount = {
      id: 41,
      name: 'user@example.invalid',
      status: 'active',
      platform: 'openai',
      type: 'oauth',
    }
    const backend = {
      findAccounts: vi.fn(async () => [
        { ...existing, id: 40, name: 'user@example.invalid-old' },
        existing,
      ]),
      createAccount: vi.fn(),
      getAccount: vi.fn(),
    }
    const creator = new AccountCreator(backend)

    expect(await creator.findExactDuplicate(' User@Example.Invalid ')).toEqual(existing)
    expect(await creator.findExactDuplicate('user@example.invalid')).toEqual(existing)
    expect(backend.findAccounts).toHaveBeenCalledTimes(2)
    expect(backend.createAccount).not.toHaveBeenCalled()
  })
})
