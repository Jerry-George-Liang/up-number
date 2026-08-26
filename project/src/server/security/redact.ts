const REDACTED = '[REDACTED]'
const SECRET_KEY = /(?:authorization|cookie|password|passwd|pwd|secret|token|totp|login_?material|mailbox_?access|access_token|refresh_token|id_token|code|state|session_id|proxy_url|mail_body)/i
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g
const QUERY_SECRET = /([?&](?:pwd|password|code|state|session_id|access_token|refresh_token)=)[^&\s]*/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const LABELED_SECRET = /\b(access_token|refresh_token|id_token|code|state|session_id)\s*[:=]\s*[^,\s&]+/gi
const OTP = /\b\d{6}\b/g

export function redactString(value: string): string {
  return value
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(LABELED_SECRET, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(OTP, REDACTED)
}

export function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]),
    )
  }
  return value
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (!local || !domain) return '[REDACTED_EMAIL]'
  if (local.length === 1) return `*@${domain}`
  if (local.length === 2) return `${local[0]}*@${domain}`
  return `${local[0]}${'*'.repeat(Math.min(7, local.length - 2))}${local.at(-1)}@${domain}`
}
