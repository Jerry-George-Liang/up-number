import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config'

const baseEnv = {
  APP_DATA_DIR: '/tmp/up-icloud-config-test-does-not-exist',
}

describe('application LAN configuration', () => {
  it('keeps LAN access disabled by default', () => {
    expect(loadConfig(baseEnv).lanAccess).toBeNull()
  })

  it('loads one exact private LAN HTTPS listener', () => {
    expect(loadConfig({
      ...baseEnv,
      LAN_ACCESS_ENABLED: 'true',
      LAN_HOST: '192.168.50.218',
      LAN_ALLOWED_CIDR: '192.168.50.0/24',
      LAN_TLS_CERT_FILE: '/tmp/up-icloud/server-cert.pem',
      LAN_TLS_KEY_FILE: '/tmp/up-icloud/server-key.pem',
    }).lanAccess).toEqual({
      protocol: 'https',
      host: '192.168.50.218',
      allowedCidr: '192.168.50.0/24',
      tlsCertPath: '/tmp/up-icloud/server-cert.pem',
      tlsKeyPath: '/tmp/up-icloud/server-key.pem',
    })
  })

  it('loads an explicit private LAN HTTP listener without TLS material', () => {
    expect(loadConfig({
      ...baseEnv,
      LAN_ACCESS_ENABLED: 'true',
      LAN_PROTOCOL: 'http',
      LAN_HOST: '192.168.50.218',
      LAN_ALLOWED_CIDR: '192.168.50.0/24',
    }).lanAccess).toEqual({
      protocol: 'http',
      host: '192.168.50.218',
      allowedCidr: '192.168.50.0/24',
    })
  })

  it.each([
    { LAN_ACCESS_ENABLED: 'yes' },
    { LAN_ACCESS_ENABLED: 'true', LAN_HOST: '8.8.8.8', LAN_ALLOWED_CIDR: '8.8.8.0/24' },
    { LAN_ACCESS_ENABLED: 'true', LAN_HOST: '192.168.51.218', LAN_ALLOWED_CIDR: '192.168.50.0/24' },
    { LAN_ACCESS_ENABLED: 'true', LAN_HOST: '192.168.50.218', LAN_ALLOWED_CIDR: '192.168.50.1/24' },
    {
      LAN_ACCESS_ENABLED: 'true',
      LAN_PROTOCOL: 'ftp',
      LAN_HOST: '192.168.50.218',
      LAN_ALLOWED_CIDR: '192.168.50.0/24',
    },
  ])('rejects unsafe or incomplete LAN configuration', (overrides) => {
    expect(() => loadConfig({
      ...baseEnv,
      LAN_TLS_CERT_FILE: '/tmp/up-icloud/server-cert.pem',
      LAN_TLS_KEY_FILE: '/tmp/up-icloud/server-key.pem',
      ...overrides,
    })).toThrow()
  })

  it('requires absolute TLS material paths', () => {
    expect(() => loadConfig({
      ...baseEnv,
      LAN_ACCESS_ENABLED: 'true',
      LAN_HOST: '192.168.50.218',
      LAN_ALLOWED_CIDR: '192.168.50.0/24',
      LAN_TLS_CERT_FILE: 'server-cert.pem',
      LAN_TLS_KEY_FILE: 'server-key.pem',
    })).toThrow(/absolute/)
  })

  it('still requires TLS material when LAN_PROTOCOL is omitted or set to https', () => {
    for (const protocol of [undefined, 'https']) {
      expect(() => loadConfig({
        ...baseEnv,
        LAN_ACCESS_ENABLED: 'true',
        ...(protocol ? { LAN_PROTOCOL: protocol } : {}),
        LAN_HOST: '192.168.50.218',
        LAN_ALLOWED_CIDR: '192.168.50.0/24',
      })).toThrow(/LAN_TLS_CERT_FILE/)
    }
  })
})
