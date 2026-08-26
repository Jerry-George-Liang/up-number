import { describe, expect, it, vi } from 'vitest'
import { DeactivationSettingsService } from '../../src/server/tasks/deactivation-settings'

describe('DeactivationSettingsService', () => {
  it('defaults to two confirmations and persists an updated value', () => {
    let stored: string | null = null
    const store = {
      getSetting: vi.fn(() => stored),
      setSetting: vi.fn((_key: string, value: string) => {
        stored = value
      }),
    }
    const service = new DeactivationSettingsService(store)

    expect(service.getSettings()).toEqual({ confirmationAttempts: 2 })
    expect(service.updateSettings({ confirmationAttempts: 1 })).toEqual({ confirmationAttempts: 1 })
    expect(service.getSettings()).toEqual({ confirmationAttempts: 1 })
  })

  it('falls back to two when persisted data is invalid', () => {
    const service = new DeactivationSettingsService({
      getSetting: () => '0',
      setSetting: () => undefined,
    })
    expect(service.getSettings()).toEqual({ confirmationAttempts: 2 })
  })
})
