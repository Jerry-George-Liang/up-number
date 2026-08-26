import { z } from 'zod'

const BASE32_BODY = /^[A-Z2-7]+$/
const VALID_UNPADDED_REMAINDERS = new Set([0, 2, 4, 5, 7])
const EXPECTED_PADDING = new Map([
  [0, 0],
  [2, 6],
  [4, 4],
  [5, 3],
  [7, 1],
])

export function normalizeTotpSecret(value: string): string | null {
  const normalized = value.replace(/[ -]/g, '').toUpperCase()
  if (normalized.length < 2 || normalized.length > 512) return null

  const paddingIndex = normalized.indexOf('=')
  const body = paddingIndex === -1 ? normalized : normalized.slice(0, paddingIndex)
  const padding = paddingIndex === -1 ? '' : normalized.slice(paddingIndex)
  if (!BASE32_BODY.test(body) || (padding && !/^=+$/.test(padding))) return null

  const remainder = body.length % 8
  if (!VALID_UNPADDED_REMAINDERS.has(remainder)) return null
  if (!padding) return normalized
  if (normalized.length % 8 !== 0 || EXPECTED_PADDING.get(remainder) !== padding.length) return null
  return normalized
}

export const TotpSecretSchema = z
  .string()
  .min(1)
  .max(1024)
  .transform((value, context) => {
    const normalized = normalizeTotpSecret(value)
    if (normalized) return normalized
    context.addIssue({ code: 'custom', message: '2FA 密钥格式无效。' })
    return z.NEVER
  })

