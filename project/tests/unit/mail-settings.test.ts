import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILT_IN_PATH_MAILBOX_ORIGINS,
  MailboxTrustSettingsService,
  normalizeMailboxTrustOrigin,
} from '../../src/server/mail/settings'
import { TaskDatabase } from '../../src/server/storage/database'

const databases: TaskDatabase[] = []

function setup() {
  const database = new TaskDatabase(':memory:')
  databases.push(database)
  return { database, settings: new MailboxTrustSettingsService(database) }
}

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe('MailboxTrustSettingsService', () => {
  it('keeps the built-in path origin and stores normalized custom origins only', () => {
    const { database, settings } = setup()

    expect(settings.getSettings()).toEqual({
      builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
      customPathOrigins: [],
      configurationValid: true,
    })

    expect(
      settings.updateSettings({
        customPathOrigins: [
          'MAIL.EXAMPLE.INVALID',
          'https://mail.example.invalid/',
          'https://second.example.invalid:8443',
        ],
      }),
    ).toEqual({
      builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
      customPathOrigins: ['https://mail.example.invalid', 'https://second.example.invalid:8443'],
      configurationValid: true,
    })
    expect(database.getSetting('mailbox.trusted_path_origins.v1')).toBe(
      '["https://mail.example.invalid","https://second.example.invalid:8443"]',
    )
    expect(settings.snapshot().pathOrigins).toEqual([
      ...BUILT_IN_PATH_MAILBOX_ORIGINS,
      'https://mail.example.invalid',
      'https://second.example.invalid:8443',
    ])
    expect(BUILT_IN_PATH_MAILBOX_ORIGINS).not.toContain('https://email.lzg666.icu')
  })

  it('normalizes IDN hosts and rejects origins that are unsafe or owned by another adapter', () => {
    expect(normalizeMailboxTrustOrigin('例子.测试')).toBe('https://xn--fsqu00a.xn--0zwm56d')

    const { settings } = setup()
    for (const origin of [
      '',
      'http://mail.example.invalid',
      'https://user:password@mail.example.invalid',
      'https://mail.example.invalid/path',
      'https://mail.example.invalid?query=1',
      '*.example.invalid',
      'localhost',
      'localhost.',
      'mailserver',
      '127.0.0.1',
      '[::1]',
      'https://icloud-api.top',
      'https://assurivo.com',
      'https://icloud.biubiu007.com',
      'https://mail.ai1998.xyz',
      'https://gptmail.wanmail.beer',
      'https://li1329.asia',
      'https://mailotp.xyhelper.ai',
      'https://mail.776867.xyz',
      'https://flysms.xyz',
      'https://redeem.360desk.net',
      'https://email.lzg666.icu',
      'https://aigateway.online',
    ]) {
      expect(() => settings.updateSettings({ customPathOrigins: [origin] })).toThrowError(
        expect.objectContaining({ code: 'MAILBOX_TRUST_ORIGIN_INVALID' }),
      )
    }
  })

  it('fails closed on a corrupted persisted value without exposing it', () => {
    const { database, settings } = setup()
    const sensitiveGarbage = 'not-json-private-value'
    database.setSetting('mailbox.trusted_path_origins.v1', sensitiveGarbage)

    const result = settings.getSettings()
    expect(result).toEqual({
      builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
      customPathOrigins: [],
      configurationValid: false,
    })
    expect(JSON.stringify(result)).not.toContain(sensitiveGarbage)

    expect(settings.updateSettings({ customPathOrigins: ['mail.example.invalid'] })).toMatchObject({
      customPathOrigins: ['https://mail.example.invalid'],
      configurationValid: true,
    })
  })

  it('drops origins from old settings after a dedicated adapter takes ownership', () => {
    const { database, settings } = setup()
    database.setSetting(
      'mailbox.trusted_path_origins.v1',
      JSON.stringify(['https://mail.ai1998.xyz', 'https://mail.example.invalid']),
    )

    expect(settings.getSettings()).toEqual({
      builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
      customPathOrigins: ['https://mail.example.invalid'],
      configurationValid: true,
    })
  })

  it('enforces the custom-origin limit inside the settings service', () => {
    const { settings } = setup()
    const origins = Array.from({ length: 21 }, (_value, index) => `mail-${index}.example.invalid`)

    expect(() => settings.updateSettings({ customPathOrigins: origins })).toThrowError(
      expect.objectContaining({ code: 'MAILBOX_TRUST_ORIGIN_INVALID' }),
    )
  })
})
