import { describe, expect, it, vi } from 'vitest'
import { BackendAuthApi } from '../../src/server/backend/auth'
import { AuthorizedBackendClient, BackendTransport } from '../../src/server/backend/client'
import { AppError } from '../../src/shared/errors'

describe('BackendTransport and BackendAuthApi', () => {
  it('logs in with email and password and requires a refresh token in the success response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'admin@example.invalid',
        password: 'synthetic-password',
      })
      return new Response(
        JSON.stringify({
          access_token: 'access-value',
          refresh_token: 'refresh-value',
          expires_in: 3600,
          user: { id: 1, email: 'admin@example.invalid', role: 'admin' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))

    await expect(api.login('admin@example.invalid', 'synthetic-password')).resolves.toMatchObject({
      access_token: 'access-value',
      refresh_token: 'refresh-value',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('parses the TOTP intermediate response and completes it with the exact backend fields', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ requires_2fa: true, temp_token: 'temporary-value', user_email_masked: 'a***@example.invalid' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ temp_token: 'temporary-value', totp_code: '012345' })
        return new Response(
          JSON.stringify({
            access_token: 'access-value',
            refresh_token: 'refresh-value',
            expires_in: 3600,
            user: { id: 1, email: 'admin@example.invalid' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))

    await expect(api.login('admin@example.invalid', 'synthetic-password')).resolves.toEqual({
      requires_2fa: true,
      temp_token: 'temporary-value',
      user_email_masked: 'a***@example.invalid',
    })
    await expect(api.login2FA('temporary-value', '012345')).resolves.toMatchObject({
      access_token: 'access-value',
      refresh_token: 'refresh-value',
    })
  })

  it('reads only public interactive authentication requirements', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          turnstile_enabled: true,
          tencent_captcha_enabled: false,
          aliyun_captcha_enabled: false,
          login_agreement_enabled: true,
          unrelated_secret: 'must-not-survive',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))

    await expect(api.getPublicAuthRequirements()).resolves.toEqual({
      turnstileEnabled: true,
      tencentCaptchaEnabled: false,
      aliyunCaptchaEnabled: false,
      loginAgreementEnabled: true,
    })
  })

  it('classifies malformed public authentication requirements as a backend contract failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ turnstile_enabled: 'yes' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))

    await expect(api.getPublicAuthRequirements()).rejects.toMatchObject({
      code: 'BACKEND_AUTH_REQUIREMENTS_INVALID',
      statusCode: 502,
    })
  })

  it('rejects login success without a refresh token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ access_token: 'access-only', user: { id: 1, email: 'admin@example.invalid' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))

    await expect(api.login('admin@example.invalid', 'synthetic-password')).rejects.toThrow()
  })

  it('exchanges a refresh token without exposing it in the parsed result shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      expect(body).toEqual({ refresh_token: 'submitted-refresh-token' })
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            access_token: 'access-value',
            refresh_token: 'refresh-value',
            expires_in: 3600,
            user: { id: 1, email: 'admin@example.invalid', role: 'admin' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const api = new BackendAuthApi(new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock))
    const result = await api.refresh('submitted-refresh-token')
    expect(result).toMatchObject({ access_token: 'access-value', refresh_token: 'refresh-value' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-host redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }),
    )
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock)
    await expect(transport.request('auth/me')).rejects.toMatchObject({ code: 'BACKEND_REDIRECT_REJECTED' })
  })

  it('retries an idempotent GET once after a transient network failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { id: 7 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock)

    await expect(transport.request('admin/accounts')).resolves.toEqual({ id: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
  })

  it('does not retry a POST after a network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock)

    await expect(
      transport.request('admin/openai/exchange-code', {
        method: 'POST',
        body: { code: 'oauth-code' },
      }),
    ).rejects.toMatchObject({ code: 'BACKEND_NETWORK_ERROR', retryable: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after one GET retry when the network remains unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock)

    await expect(transport.request('admin/accounts')).rejects.toMatchObject({
      code: 'BACKEND_NETWORK_ERROR',
      retryable: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes once after 401 and retries with the replacement token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { id: 7 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const tokenProvider = {
      getAccessToken: vi.fn(async (forceRefresh?: boolean) =>
        forceRefresh ? 'replacement-access-token' : 'expired-access-token',
      ),
    }
    const client = new AuthorizedBackendClient(
      new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock),
      tokenProvider,
    )

    await expect(client.request('admin/accounts/7')).resolves.toEqual({ id: 7 })
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(1)
    expect(tokenProvider.getAccessToken).toHaveBeenNthCalledWith(2, true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer replacement-access-token',
    )
  })

  it('does not refresh or retry a forbidden response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ detail: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const tokenProvider = { getAccessToken: vi.fn(async () => 'access-token') }
    const client = new AuthorizedBackendClient(
      new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock),
      tokenProvider,
    )

    await expect(client.request('admin/accounts')).rejects.toMatchObject({ code: 'BACKEND_FORBIDDEN' })
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not replay a request when an access-only token provider cannot refresh', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ detail: 'expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const tokenProvider = {
      getAccessToken: vi.fn(async (forceRefresh?: boolean) => {
        if (forceRefresh) throw new AppError('SESSION_EXPIRED', 'expired', { statusCode: 401 })
        return 'access-only-token'
      }),
    }
    const client = new AuthorizedBackendClient(
      new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock),
      tokenProvider,
    )

    await expect(client.request('admin/accounts', { method: 'POST', body: { value: 1 } })).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(2)
  })

  it('classifies 423 as an admin compliance requirement', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ detail: 'compliance pending' }), {
        status: 423,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchMock)

    await expect(transport.request('admin/accounts')).rejects.toMatchObject({
      code: 'ADMIN_COMPLIANCE_REQUIRED',
      statusCode: 423,
    })
  })
})
