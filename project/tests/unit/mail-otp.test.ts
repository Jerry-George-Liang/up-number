import { describe, expect, it } from 'vitest'
import type { MailMessage } from '../../src/server/mail/normalize'
import type { MailboxSource } from '../../src/server/mail/client'
import { MailOtpPoller } from '../../src/server/mail/poller'
import { createMailBaseline, extractNewestOrderedOtp, extractUniqueOtp, mergeMailBaselines } from '../../src/server/mail/otp'

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'message-1',
    sender: 'OpenAI <no-reply@openai.com>',
    subject: 'Your ChatGPT verification code',
    text: 'Use verification code 246810 to continue.',
    receivedAt: '2026-08-11T08:00:05.000Z',
    fingerprint: 'fingerprint-1',
    ...overrides,
  }
}

describe('mail OTP selection', () => {
  const startedAt = new Date('2026-08-11T08:00:00.000Z')

  it('excludes every message present in the pre-OAuth baseline', () => {
    const oldMessage = message()
    const baseline = createMailBaseline([oldMessage])
    expect(extractUniqueOtp([oldMessage], baseline, startedAt)).toEqual({ kind: 'none' })
  })

  it('merges refreshed baselines without losing messages that left the mailbox window', () => {
    const initial = createMailBaseline([
      message({ id: 'old-1', fingerprint: 'old-fingerprint-1' }),
    ])
    const refreshed = createMailBaseline([
      message({ id: 'old-2', fingerprint: 'old-fingerprint-2' }),
    ])
    const merged = mergeMailBaselines(initial, refreshed)

    expect([...merged.messageIds].sort()).toEqual(['old-1', 'old-2'])
    expect([...merged.fingerprints].sort()).toEqual(['old-fingerprint-1', 'old-fingerprint-2'])
  })

  it('returns one unique trusted six-digit OpenAI code', () => {
    const result = extractUniqueOtp(
      [message({ id: 'new', fingerprint: 'new-fingerprint' })],
      createMailBaseline([]),
      startedAt,
    )
    expect(result).toEqual({ kind: 'found', code: '246810', messageIds: ['new'] })
  })

  it('does not accept unrelated senders, old messages, or embedded longer numbers', () => {
    const baseline = createMailBaseline([])
    expect(
      extractUniqueOtp(
        [
          message({
            id: 'untrusted',
            fingerprint: 'u',
            sender: 'Billing <billing@example.invalid>',
            subject: 'Invoice available',
            text: 'Reference 654321',
          }),
          message({ id: 'old', fingerprint: 'o', receivedAt: '2026-08-11T07:40:00.000Z' }),
          message({ id: 'long', fingerprint: 'l', text: 'Reference 1234567' }),
        ],
        baseline,
        startedAt,
      ),
    ).toEqual({ kind: 'none' })
  })

  it('selects the latest trusted code by received time regardless of API order', () => {
    const result = extractUniqueOtp(
      [
        message({
          id: 'newer',
          fingerprint: 'f2',
          text: 'Code 222222',
          receivedAt: '2026-08-11T08:00:09.000Z',
        }),
        message({
          id: 'older',
          fingerprint: 'f1',
          text: 'Code 111111',
          receivedAt: '2026-08-11T08:00:04.000Z',
        }),
      ],
      createMailBaseline([]),
      startedAt,
    )
    expect(result).toEqual({ kind: 'found', code: '222222', messageIds: ['newer'] })
  })

  it('rejects different codes when their relative freshness cannot be established', () => {
    const result = extractUniqueOtp(
      [
        message({ id: 'new-1', fingerprint: 'f1', text: 'Code 111111', receivedAt: undefined }),
        message({ id: 'new-2', fingerprint: 'f2', text: 'Code 222222' }),
      ],
      createMailBaseline([]),
      startedAt,
    )
    expect(result).toEqual({
      kind: 'conflict',
      reason: 'missing_time',
      codes: 2,
      messageIds: ['new-1', 'new-2'],
    })
  })

  it('rejects different codes received at the same latest timestamp', () => {
    const result = extractUniqueOtp(
      [
        message({ id: 'new-1', fingerprint: 'f1', text: 'Code 111111' }),
        message({ id: 'new-2', fingerprint: 'f2', text: 'Code 222222' }),
      ],
      createMailBaseline([]),
      startedAt,
    )
    expect(result).toEqual({
      kind: 'conflict',
      reason: 'latest_tied',
      codes: 2,
      messageIds: ['new-1', 'new-2'],
    })
  })

  it('exposes only a single-code first candidate for a verified newest-first fallback', () => {
    const result = extractUniqueOtp(
      [
        message({ id: 'new-1', fingerprint: 'f1', text: 'Code 111111', receivedAt: undefined }),
        message({ id: 'new-2', fingerprint: 'f2', text: 'Code 222222', receivedAt: undefined }),
      ],
      createMailBaseline([]),
      startedAt,
      'newest_first',
    )
    expect(result).toMatchObject({
      kind: 'conflict',
      orderedCandidate: { identity: 'new-1', code: '111111' },
    })
  })

  it('never exposes an ordered fallback when the first candidate itself has multiple codes', () => {
    const result = extractUniqueOtp(
      [
        message({ id: 'new-1', fingerprint: 'f1', text: 'Codes 111111 and 222222', receivedAt: undefined }),
        message({ id: 'new-2', fingerprint: 'f2', text: 'Code 333333', receivedAt: undefined }),
      ],
      createMailBaseline([]),
      startedAt,
      'newest_first',
    )
    expect(result).toMatchObject({ kind: 'conflict', reason: 'missing_time' })
    expect(result).not.toHaveProperty('orderedCandidate')
  })

  it('only exposes an existing code from a verified newest-first single message', () => {
    expect(extractNewestOrderedOtp([message()], 'unknown')).toBeNull()
    expect(
      extractNewestOrderedOtp(
        [message({ text: 'Codes 111111 and 222222' })],
        'newest_first',
      ),
    ).toBeNull()
    expect(extractNewestOrderedOtp([message()], 'newest_first')).toEqual({
      identity: 'message-1',
      code: '246810',
      receivedAt: Date.parse('2026-08-11T08:00:05.000Z'),
    })
  })

  it('uses a baseline code only after resend and two stable newest-first observations', async () => {
    const existing = message()
    let requests = 0
    let now = Date.parse('2026-08-11T08:01:00.000Z')
    const source: MailboxSource = {
      listMessages: async () => {
        requests += 1
        return { messages: [existing], ordering: 'newest_first' }
      },
    }
    const poller = new MailOtpPoller(source, {
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      pollIntervalMs: 10,
      maxWaitMs: 100,
    })

    await expect(
      poller.waitForOtp(
        'user@example.invalid',
        'synthetic-secret',
        createMailBaseline([existing]),
        new Date('2026-08-11T08:01:00.000Z'),
        undefined,
        undefined,
        { allowExistingNewestAfterResend: true },
      ),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(requests).toBe(2)
  })

  it('uses one newest-first observation when its reliable time follows the resend', async () => {
    const resent = message({ receivedAt: '2026-08-11T08:01:05.000Z' })
    let requests = 0
    let now = Date.parse('2026-08-11T08:01:10.000Z')
    const source: MailboxSource = {
      listMessages: async () => {
        requests += 1
        return { messages: [resent], ordering: 'newest_first' }
      },
    }
    const poller = new MailOtpPoller(source, {
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      maxWaitMs: 100,
    })

    await expect(
      poller.waitForOtp(
        'user@example.invalid',
        'synthetic-secret',
        createMailBaseline([resent]),
        new Date('2026-08-11T08:00:00.000Z'),
        undefined,
        undefined,
        {
          allowExistingNewestAfterResend: true,
          existingNewestNotBefore: new Date('2026-08-11T08:01:00.000Z'),
        },
      ),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(requests).toBe(1)
  })
})
