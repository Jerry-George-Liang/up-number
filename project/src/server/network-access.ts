import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

export interface Ipv4Cidr {
  value: string
  network: number
  mask: number
  prefix: number
}

function ipv4Number(value: string): number {
  if (!isIPv4(value)) throw new Error('LAN_HOST must be an IPv4 address')
  return value
    .split('.')
    .map(Number)
    .reduce((result, part) => ((result * 256) + part) >>> 0, 0)
}

function numberIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

export function isPrivateIpv4(value: string): boolean {
  if (!isIPv4(value)) return false
  const [first = -1, second = -1] = value.split('.').map(Number)
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

export function parseIpv4Cidr(value: string): Ipv4Cidr {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value)
  if (!match) throw new Error('LAN_ALLOWED_CIDR must be a valid IPv4 CIDR')
  const address = ipv4Number(match[1]!)
  const prefix = Number(match[2])
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0
  const network = (address & mask) >>> 0
  if (network !== address) throw new Error('LAN_ALLOWED_CIDR must use its canonical network address')
  return { value, network, mask, prefix }
}

export function isIpv4InCidr(address: string, cidr: Ipv4Cidr): boolean {
  if (!isIPv4(address)) return false
  return ((ipv4Number(address) & cidr.mask) >>> 0) === cidr.network
}

export function normalizeRemoteAddress(value: string | undefined): string | null {
  if (!value) return null
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length)
  return value
}

export function assertLanNetwork(host: string, allowedCidr: string): Ipv4Cidr {
  if (!isPrivateIpv4(host)) throw new Error('LAN_HOST must be a private IPv4 address')
  const cidr = parseIpv4Cidr(allowedCidr)
  const lastAddress = (cidr.network | (~cidr.mask >>> 0)) >>> 0
  if (!isPrivateIpv4(numberIpv4(cidr.network)) || !isPrivateIpv4(numberIpv4(lastAddress))) {
    throw new Error('LAN_ALLOWED_CIDR must stay entirely inside private IPv4 address space')
  }
  if (!isIpv4InCidr(host, cidr)) throw new Error('LAN_HOST must belong to LAN_ALLOWED_CIDR')
  return cidr
}

export function isAddressAssignedToLocalInterface(address: string): boolean {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => entry.family === 'IPv4' && entry.address === address)
}
