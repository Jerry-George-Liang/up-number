import { describe, expect, it } from 'vitest'
import {
  assertLanNetwork,
  isIpv4InCidr,
  isPrivateIpv4,
  normalizeRemoteAddress,
  parseIpv4Cidr,
} from '../../src/server/network-access'

describe('LAN network access validation', () => {
  it.each(['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.50.218'])(
    'accepts private IPv4 host %s',
    (host) => expect(isPrivateIpv4(host)).toBe(true),
  )

  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '::1'])(
    'rejects non-private LAN host %s',
    (host) => expect(isPrivateIpv4(host)).toBe(false),
  )

  it('matches only IPv4 clients inside the configured canonical CIDR', () => {
    const cidr = parseIpv4Cidr('192.168.50.0/24')
    expect(isIpv4InCidr('192.168.50.1', cidr)).toBe(true)
    expect(isIpv4InCidr('192.168.50.254', cidr)).toBe(true)
    expect(isIpv4InCidr('192.168.51.1', cidr)).toBe(false)
    expect(isIpv4InCidr('::1', cidr)).toBe(false)
    expect(() => parseIpv4Cidr('192.168.50.10/24')).toThrow(/canonical/)
  })

  it('requires the configured host to belong to the allowed network', () => {
    expect(assertLanNetwork('192.168.50.218', '192.168.50.0/24')).toMatchObject({ prefix: 24 })
    expect(() => assertLanNetwork('192.168.51.218', '192.168.50.0/24')).toThrow(/belong/)
    expect(() => assertLanNetwork('192.168.50.218', '0.0.0.0/0')).toThrow(/private/)
  })

  it('normalizes IPv4-mapped socket addresses without accepting other IPv6 values', () => {
    expect(normalizeRemoteAddress('::ffff:192.168.50.20')).toBe('192.168.50.20')
    expect(normalizeRemoteAddress('::1')).toBe('::1')
    expect(normalizeRemoteAddress(undefined)).toBeNull()
  })
})
