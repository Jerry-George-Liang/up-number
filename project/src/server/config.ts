import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { assertLanNetwork } from './network-access'

interface LanAccessBaseConfig {
  host: string
  allowedCidr: string
}

export interface LanHttpAccessConfig extends LanAccessBaseConfig {
  protocol: 'http'
}

export interface LanHttpsAccessConfig extends LanAccessBaseConfig {
  protocol: 'https'
  tlsCertPath: string
  tlsKeyPath: string
}

export type LanAccessConfig = LanHttpAccessConfig | LanHttpsAccessConfig

export interface AppConfig {
  host: '127.0.0.1'
  port: number
  lanAccess: LanAccessConfig | null
  backendBaseUrl: string
  accountPoolBaseUrl: string
  accountPoolBridgeToken: string
  accountPoolTimeoutMs: number
  accountPoolProfileDir: string
  appDataDir: string
  databasePath: string
  localSessionSeedPath: string
  webRoot: string
}

function enabledFlag(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'false') return false
  if (value.trim().toLowerCase() === 'true') return true
  throw new Error('LAN_ACCESS_ENABLED must be true or false')
}

function lanProtocol(value: string | undefined): 'http' | 'https' {
  const normalized = value?.trim().toLowerCase() || 'https'
  if (normalized === 'http' || normalized === 'https') return normalized
  throw new Error('LAN_PROTOCOL must be http or https')
}

function loadLanAccessConfig(env: NodeJS.ProcessEnv): LanAccessConfig | null {
  if (!enabledFlag(env.LAN_ACCESS_ENABLED)) return null
  const host = env.LAN_HOST?.trim() ?? ''
  const allowedCidr = env.LAN_ALLOWED_CIDR?.trim() ?? ''
  if (!host || !allowedCidr) throw new Error('LAN_HOST and LAN_ALLOWED_CIDR are required when LAN access is enabled')
  assertLanNetwork(host, allowedCidr)
  const protocol = lanProtocol(env.LAN_PROTOCOL)
  if (protocol === 'http') return { protocol, host, allowedCidr }

  const tlsCertPath = env.LAN_TLS_CERT_FILE?.trim() ?? ''
  const tlsKeyPath = env.LAN_TLS_KEY_FILE?.trim() ?? ''
  if (!tlsCertPath || !tlsKeyPath) {
    throw new Error('LAN_TLS_CERT_FILE and LAN_TLS_KEY_FILE are required when LAN_PROTOCOL is https')
  }
  if (!isAbsolute(tlsCertPath) || !isAbsolute(tlsKeyPath)) {
    throw new Error('LAN TLS certificate and key paths must be absolute')
  }
  return { protocol, host, allowedCidr, tlsCertPath, tlsKeyPath }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appDataDir = env.APP_DATA_DIR?.trim() || join(homedir(), 'Library', 'Application Support', 'up-icloud')
  const accountPoolBridgeTokenFile =
    env.ACCOUNT_POOL_BRIDGE_TOKEN_FILE?.trim() || join(appDataDir, 'account-pool-bridge-token')
  const port = Number.parseInt(env.PORT || '43123', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535')
  }
  const accountPoolTimeoutMs = Number.parseInt(env.ACCOUNT_POOL_TIMEOUT_MS || '5000', 10)
  if (!Number.isInteger(accountPoolTimeoutMs) || accountPoolTimeoutMs < 500 || accountPoolTimeoutMs > 30_000) {
    throw new Error('ACCOUNT_POOL_TIMEOUT_MS must be an integer from 500 to 30000')
  }

  return {
    host: '127.0.0.1',
    port,
    lanAccess: loadLanAccessConfig(env),
    backendBaseUrl: 'https://coding.tu-zi.com/api/v1',
    accountPoolBaseUrl: env.ACCOUNT_POOL_BASE_URL?.trim() || 'http://127.0.0.1:3001',
    accountPoolBridgeToken:
      env.ACCOUNT_POOL_BRIDGE_TOKEN?.trim() ||
      (existsSync(accountPoolBridgeTokenFile) ? readFileSync(accountPoolBridgeTokenFile, 'utf8').trim() : ''),
    accountPoolTimeoutMs,
    accountPoolProfileDir: join(appDataDir, 'account-pool-profile'),
    appDataDir,
    databasePath: join(appDataDir, 'tasks.sqlite'),
    localSessionSeedPath: join(appDataDir, 'local-session-seed'),
    webRoot: env.WEB_ROOT?.trim() || join(process.cwd(), 'dist', 'web'),
  }
}
