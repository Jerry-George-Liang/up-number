import { AppError } from '../../shared/errors'
import { normalizeTotpSecret } from '../../shared/login-material'
import type { LoginMaterial } from '../../shared/contracts'
import type { AccountPoolMaterials } from './bridge-client'

const TWO_FA_KIM_ORIGIN = 'https://2fa.kim'
const TWO_FA_KIM_TOKEN_PATH_PREFIX = '/2fa='
const FLYSMS_ORIGIN = 'https://flysms.xyz'
const FLYSMS_PATH = '/icloud/pickup'

export interface PasswordErrorFallback {
  password: string
  totpSecret: string
}

export type ResolvedAccountPoolMaterial = LoginMaterial & {
  source: 'account_pool'
  passwordErrorFallback?: PasswordErrorFallback
  passwordHyphenFallbacks?: string[]
}

function totpSecretFromMailboxAccess(value: string): string | null {
  if (!isTwoFaKimMailboxAccess(value)) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) {
    return null
  }
  const token = decodeURIComponent(url.pathname.slice(TWO_FA_KIM_TOKEN_PATH_PREFIX.length))
  return normalizeTotpSecret(token)
}

function isTwoFaKimMailboxAccess(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.origin === TWO_FA_KIM_ORIGIN && url.pathname.startsWith(TWO_FA_KIM_TOKEN_PATH_PREFIX)
  } catch {
    return false
  }
}

function emailFromFlySmsMailboxAccess(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.origin !== FLYSMS_ORIGIN || url.pathname !== FLYSMS_PATH || url.username || url.password || url.search) return null
    const fragment = new URLSearchParams(url.hash.slice(1))
    const email = fragment.get('email')?.trim().toLowerCase() ?? ''
    const key = fragment.get('key') ?? ''
    if (!email || !key || fragment.getAll('email').length !== 1 || fragment.getAll('key').length !== 1) return null
    return email
  } catch {
    return null
  }
}

export function selectAccountPoolMaterial(
  email: string,
  materials: AccountPoolMaterials,
): ResolvedAccountPoolMaterial {
  const requestedEmail = email.trim().toLowerCase()
  const materialEmail = materials.email.trim().toLowerCase() ||
    (materials.mailboxAccess ? emailFromFlySmsMailboxAccess(materials.mailboxAccess) : null)
  if (materialEmail !== requestedEmail) {
    throw new AppError('ACCOUNT_POOL_PROTOCOL_ERROR', '账号池返回的邮箱与任务邮箱不一致。')
  }

  const normalizedTotp = materials.totpSecret ? normalizeTotpSecret(materials.totpSecret) : null
  const mailboxAccessIsTotp = materials.mailboxAccess ? isTwoFaKimMailboxAccess(materials.mailboxAccess) : false
  const mailboxTotp = materials.mailboxAccess ? totpSecretFromMailboxAccess(materials.mailboxAccess) : null
  const effectiveTotp = normalizedTotp ?? mailboxTotp ?? materials.totpSecret
  const passwordErrorFallback: PasswordErrorFallback | undefined =
    materials.password && (materials.totpSecret || mailboxTotp)
      ? { password: mailboxTotp ?? materials.totpSecret!, totpSecret: materials.password }
      : undefined

  if (materials.password && (effectiveTotp || passwordErrorFallback)) {
    return {
      source: 'account_pool',
      kind: 'password_totp',
      password: materials.password,
      // Keep the original order for the first attempt. The orchestrator only
      // uses the fallback after OpenAI explicitly rejects the password.
      totpSecret: effectiveTotp ?? materials.totpSecret!,
      passwordHyphenFallbacks: [`${materials.password}-`, `-${materials.password}`],
      ...(passwordErrorFallback ? { passwordErrorFallback } : {}),
    }
  }

  if (materials.mailboxAccess && !mailboxAccessIsTotp) {
    return {
      source: 'account_pool',
      kind: 'email_otp',
      mailboxAccess: materials.mailboxAccess,
    }
  }

  throw new AppError(
    'ACCOUNT_POOL_MATERIALS_INCOMPLETE',
    '账号池中没有完整的密码 + 2FA，也没有邮箱取件 Token。',
    { statusCode: 422 },
  )
}
