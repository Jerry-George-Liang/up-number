import { isIP } from 'node:net'
import { z } from 'zod'
import type {
  MailboxTrustSettings,
  UpdateMailboxTrustSettingsInput,
} from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type { TaskDatabase } from '../storage/database'

export const BUILT_IN_PATH_MAILBOX_ORIGINS = [
  'https://icloud-api.top',
  'https://mail.mczero.top',
  'https://blog.tx.sb',
  'https://webmail.503.me',
  'https://email.newzoe.cloud',
  'https://o6f4.my',
  'https://mail.oscarxlpz.cloud',
  'https://inbox.chinaagarwood.com',
] as const
const RESERVED_MAILBOX_ORIGINS = new Set([
  'https://icloud.thefindnet.xyz',
  'https://icloud.olo.lat',
  'https://assurivo.com',
  'https://icloud.biubiu007.com',
  'https://mail.ai1998.xyz',
  'https://gptmail.wanmail.beer',
  'https://li1329.asia',
  'https://mailotp.xyhelper.ai',
  'https://mail.776867.xyz',
  'https://flysms.xyz',
  'https://redeem.360desk.net',
  'https://191006.xyz',
  'https://email.lzg666.icu',
  'https://aigateway.online',
  'https://api798.com',
  'https://ai100.my',
  'https://main.aisvip.shop',
  'https://mail.bomyi.com',
])

function isDedicatedMailboxOrigin(origin: string): boolean {
  return RESERVED_MAILBOX_ORIGINS.has(origin) || new URL(origin).hostname.endsWith('.trycloudflare.com')
}
const SETTINGS_KEY = 'mailbox.trusted_path_origins.v1'
const persistedOriginsSchema = z.array(z.string()).max(20)

export interface MailboxTrustSnapshot {
  readonly pathOrigins: readonly string[]
}

function invalidOrigin(reason: string): AppError {
  return new AppError('MAILBOX_TRUST_ORIGIN_INVALID', `可信邮箱域名无效：${reason}。`)
}

export function normalizeMailboxTrustOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw invalidOrigin('不能为空')

  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw invalidOrigin('无法识别')
  }

  if (url.protocol !== 'https:') throw invalidOrigin('必须使用 HTTPS')
  if (url.username || url.password) throw invalidOrigin('不能包含用户名或密码')
  if (url.pathname !== '/' || url.search || url.hash) throw invalidOrigin('只能填写域名或 HTTPS origin')

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  url.hostname = hostname
  if (
    !hostname ||
    hostname.includes('*') ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    !hostname.includes('.') ||
    isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
  ) {
    throw invalidOrigin('必须是公开域名，不能使用通配符、本机名称或 IP 地址')
  }

  return url.origin
}

function normalizeCustomOrigins(inputs: readonly string[]): string[] {
  if (inputs.length > 20) throw invalidOrigin('自定义邮箱服务最多 20 个')
  const normalized = [...new Set(inputs.map(normalizeMailboxTrustOrigin))].sort()
  for (const origin of normalized) {
    if (BUILT_IN_PATH_MAILBOX_ORIGINS.some((builtIn) => builtIn === origin)) {
      throw invalidOrigin(`${new URL(origin).hostname} 已经是内置路径式邮箱服务`)
    }
    if (isDedicatedMailboxOrigin(origin)) {
      throw invalidOrigin(`${new URL(origin).hostname} 已由专用邮箱适配器管理`)
    }
  }
  return normalized
}

function normalizePersistedOrigins(inputs: readonly string[]): string[] {
  const normalized = inputs.map(normalizeMailboxTrustOrigin)
  return normalizeCustomOrigins(
    normalized.filter(
      (origin) =>
        !isDedicatedMailboxOrigin(origin) &&
        !BUILT_IN_PATH_MAILBOX_ORIGINS.some((builtIn) => builtIn === origin),
    ),
  )
}

export class MailboxTrustSettingsService {
  constructor(private readonly database: Pick<TaskDatabase, 'getSetting' | 'setSetting'>) {}

  getSettings(): MailboxTrustSettings {
    const stored = this.database.getSetting(SETTINGS_KEY)
    if (stored === null) {
      return {
        builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
        customPathOrigins: [],
        configurationValid: true,
      }
    }

    try {
      const parsed = persistedOriginsSchema.parse(JSON.parse(stored))
      return {
        builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
        customPathOrigins: normalizePersistedOrigins(parsed),
        configurationValid: true,
      }
    } catch {
      return {
        builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
        customPathOrigins: [],
        configurationValid: false,
      }
    }
  }

  updateSettings(input: UpdateMailboxTrustSettingsInput): MailboxTrustSettings {
    const customPathOrigins = normalizeCustomOrigins(input.customPathOrigins)
    this.database.setSetting(SETTINGS_KEY, JSON.stringify(customPathOrigins))
    return {
      builtInPathOrigins: [...BUILT_IN_PATH_MAILBOX_ORIGINS],
      customPathOrigins,
      configurationValid: true,
    }
  }

  snapshot(): MailboxTrustSnapshot {
    const settings = this.getSettings()
    return {
      pathOrigins: Object.freeze([...settings.builtInPathOrigins, ...settings.customPathOrigins]),
    }
  }
}
