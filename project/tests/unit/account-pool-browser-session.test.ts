import { describe, expect, it, vi } from 'vitest'
import { PersistentAccountPoolBrowserSession } from '../../src/server/account-pool/browser-session'

function fakeContext(origin: string) {
  const page = {
    url: vi.fn(() => origin),
    isClosed: vi.fn(() => false),
    bringToFront: vi.fn(async () => undefined),
  }
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    once: vi.fn(),
    close: vi.fn(async () => undefined),
  }
  return { page, context }
}

describe('PersistentAccountPoolBrowserSession', () => {
  it('starts background reads headlessly and relaunches visibly only for an explicit foreground open', async () => {
    const origin = 'http://192.168.50.207:3000'
    const background = fakeContext(origin)
    const visible = fakeContext(origin)
    const launch = vi.fn()
      .mockResolvedValueOnce(background.context)
      .mockResolvedValueOnce(visible.context)
    const session = new PersistentAccountPoolBrowserSession({
      profileDir: '/tmp/account-pool-profile',
      launchPersistentContext: launch as never,
    })

    await session.open(origin, { foreground: false })
    expect(launch.mock.calls[0]?.[1]).toMatchObject({ headless: true })
    expect(background.page.bringToFront).not.toHaveBeenCalled()

    await session.open(origin)
    expect(background.context.close).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[1]?.[1]).toMatchObject({ headless: false })
    expect(visible.page.bringToFront).toHaveBeenCalledTimes(1)

    await session.close()
  })
})
