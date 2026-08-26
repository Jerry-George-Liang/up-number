import { describe, expect, it, vi } from 'vitest'
import { BackendTransport } from '../../src/server/backend/client'

describe('BackendTransport error contracts', () => {
  it('uses the deployed error field for mixed-channel warnings', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'mixed_channel_warning',
          message: 'confirmation required',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    )
    const transport = new BackendTransport('https://backend.example.invalid/api/v1/', fetchImpl as never)
    await expect(
      transport.request('admin/accounts', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({
      code: 'mixed_channel_warning',
      statusCode: 409,
      details: { backendStatus: 409 },
    })
  })
})
