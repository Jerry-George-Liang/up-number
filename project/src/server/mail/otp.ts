import type { MailMessage } from './normalize'
import type { MailboxOrdering } from './client'

export interface MailBaseline {
  messageIds: Set<string>
  fingerprints: Set<string>
  otpCodes?: Set<string>
}

export type OtpAmbiguityReason = 'missing_time' | 'latest_tied' | 'multiple_codes'

export interface OrderedOtpCandidate {
  identity: string
  code: string
  receivedAt?: number
}

export type OtpSelection =
  | { kind: 'none' }
  | { kind: 'found'; code: string; messageIds: string[] }
  | {
      kind: 'conflict'
      reason: OtpAmbiguityReason
      codes: number
      messageIds: string[]
      orderedCandidate?: OrderedOtpCandidate
    }

const TRUSTED_CONTEXT = /\b(?:openai|chatgpt)\b/i
const OTP = /(?<!\d)\d{6}(?!\d)/g
const LABELED_OTP = /(?:verification\s*(?:code|number)?|one[- ]time\s*(?:code|password)?|\bcode\b|otp|验证码|登录(?:代码|码)|安全码)\D{0,24}(\d{6})/gi
const CLOCK_SKEW_MS = 120_000
const SENDER_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const VERIFICATION_HINT = /verification|verify|security|登录|验证码|安全码|一次性|code|otp/i

function extractOtpCodes(text: string): Set<string> {
  const labeled = new Set(
    [...text.matchAll(LABELED_OTP)]
      .map((match) => match[1])
      .filter((code): code is string => Boolean(code)),
  )
  if (labeled.size > 0) return labeled
  return new Set([...text.matchAll(OTP)].map((match) => match[0]))
}

export function createMailBaseline(messages: MailMessage[]): MailBaseline {
  return {
    messageIds: new Set(messages.flatMap((message) => (message.id ? [message.id] : []))),
    fingerprints: new Set(messages.map((message) => message.fingerprint)),
    otpCodes: new Set(),
  }
}

export function mergeMailBaselines(...baselines: MailBaseline[]): MailBaseline {
  return {
    messageIds: new Set(baselines.flatMap((baseline) => [...baseline.messageIds])),
    fingerprints: new Set(baselines.flatMap((baseline) => [...baseline.fingerprints])),
    otpCodes: new Set(baselines.flatMap((baseline) => [...(baseline.otpCodes ?? [])])),
  }
}

function isNewMessage(message: MailMessage, baseline: MailBaseline, startedAt: Date): boolean {
  if (message.id && baseline.messageIds.has(message.id)) return false
  if (baseline.fingerprints.has(message.fingerprint)) return false
  if (message.receivedAt) {
    const receivedAt = Date.parse(message.receivedAt)
    if (Number.isNaN(receivedAt) || receivedAt < startedAt.getTime() - CLOCK_SKEW_MS) return false
  }
  return true
}

export function extractUniqueOtp(
  messages: MailMessage[],
  baseline: MailBaseline,
  startedAt: Date,
  ordering: MailboxOrdering = 'unknown',
): OtpSelection {
  const candidates: Array<{ codes: Set<string>; messageId: string; receivedAt?: number }> = []
  for (const message of messages) {
    if (!isNewMessage(message, baseline, startedAt)) continue
    const context = `${message.sender}\n${message.subject}\n${message.text}`
    // Some mailbox providers rewrite the sender/subject and omit OpenAI's
    // usual wording. Keep the strict sender/context rule first, then allow a
    // conservative generic fallback for a fresh message from an email sender
    // whose subject or body looks like a verification message.
    if (!TRUSTED_CONTEXT.test(context) && !(SENDER_EMAIL.test(message.sender) && VERIFICATION_HINT.test(context))) continue
    const codes = new Set([...extractOtpCodes(message.text)].filter((code) => !baseline.otpCodes?.has(code)))
    if (codes.size === 0) continue
    candidates.push({
      codes,
      messageId: message.id ?? message.fingerprint,
      ...(message.receivedAt ? { receivedAt: Date.parse(message.receivedAt) } : {}),
    })
  }

  const codes = new Set(candidates.flatMap((candidate) => [...candidate.codes]))
  const messageIds = candidates.map((candidate) => candidate.messageId)
  if (codes.size === 0) return { kind: 'none' }
  if (codes.size === 1) return { kind: 'found', code: [...codes][0]!, messageIds }

  const first = candidates[0]
  const orderedCandidate =
    ordering === 'newest_first' && first?.codes.size === 1
      ? { identity: first.messageId, code: [...first.codes][0]! }
      : undefined

  if (candidates.some((candidate) => candidate.receivedAt === undefined)) {
    return {
      kind: 'conflict',
      reason: 'missing_time',
      codes: codes.size,
      messageIds,
      ...(orderedCandidate ? { orderedCandidate } : {}),
    }
  }
  const latestReceivedAt = Math.max(...candidates.map((candidate) => candidate.receivedAt!))
  const latest = candidates.filter((candidate) => candidate.receivedAt === latestReceivedAt)
  const latestCodes = new Set(latest.flatMap((candidate) => [...candidate.codes]))
  const latestMessageIds = latest.map((candidate) => candidate.messageId)
  if (latestCodes.size > 1) {
    return {
      kind: 'conflict',
      reason: latest.length === 1 ? 'multiple_codes' : 'latest_tied',
      codes: latestCodes.size,
      messageIds: latestMessageIds,
      ...(orderedCandidate ? { orderedCandidate } : {}),
    }
  }
  return { kind: 'found', code: [...latestCodes][0]!, messageIds: latestMessageIds }
}

export function extractNewestOrderedOtp(
  messages: MailMessage[],
  ordering: MailboxOrdering,
): OrderedOtpCandidate | null {
  if (ordering !== 'newest_first' || messages.length === 0) return null
  const first = messages[0]!
  const selection = extractUniqueOtp(
    [first],
    { messageIds: new Set(), fingerprints: new Set(), otpCodes: new Set() },
    new Date(0),
    ordering,
  )
  if (selection.kind !== 'found') return null
  const receivedAt = first.receivedAt ? Date.parse(first.receivedAt) : Number.NaN
  return {
    identity: selection.messageIds[0] ?? first.id ?? first.fingerprint,
    code: selection.code,
    ...(Number.isNaN(receivedAt) ? {} : { receivedAt }),
  }
}
