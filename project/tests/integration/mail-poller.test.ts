import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/shared/errors'
import type { MailMessage } from '../../src/server/mail/normalize'
import type { MailboxOrdering, MailboxSnapshot } from '../../src/server/mail/client'
import { createMailBaseline } from '../../src/server/mail/otp'
import { MailOtpPoller } from '../../src/server/mail/poller'

const startedAt = new Date('2026-08-11T08:00:00.000Z')

function otpMessage(): MailMessage {
  return {
    id: 'new-message',
    sender: 'OpenAI <no-reply@openai.com>',
    subject: 'Your login code',
    text: 'Use 246810 to sign in to ChatGPT.',
    receivedAt: '2026-08-11T08:00:05.000Z',
    fingerprint: 'new-fingerprint',
  }
}

function snapshot(messages: MailMessage[], ordering: MailboxOrdering = 'unknown'): MailboxSnapshot {
  return { messages, ordering }
}

function clock() {
  let now = startedAt.getTime()
  const delays: number[] = []
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      delays.push(ms)
      now += ms
    }),
    delays,
  }
}

describe('MailOtpPoller', () => {
  it('establishes a baseline separately and later returns only a new code', async () => {
    const old = { ...otpMessage(), id: 'old-message', fingerprint: 'old-fingerprint' }
    const source = {
      listMessages: vi
        .fn()
        .mockResolvedValueOnce(snapshot([old]))
        .mockResolvedValueOnce(snapshot([old, otpMessage()])),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })
    const baseline = await poller.establishBaseline('user@example.invalid', 'mail-secret')
    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', baseline, startedAt),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(source.listMessages).toHaveBeenCalledTimes(2)
  })

  it('retries transient failures while establishing the initial mailbox baseline', async () => {
    const transient = new AppError('MAIL_REQUEST_TIMEOUT', 'timeout', { retryable: true })
    const source = {
      listMessages: vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(snapshot([])),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })

    await expect(poller.establishBaseline('user@example.invalid', 'mail-secret')).resolves.toEqual(
      createMailBaseline([]),
    )
    expect(source.listMessages).toHaveBeenCalledTimes(3)
    expect(time.delays).toEqual([1000, 2000])
  })

  it('does not retry a permanent initial mailbox failure', async () => {
    const source = {
      listMessages: vi.fn(async () => {
        throw new AppError('MAIL_AUTHENTICATION_FAILED', 'expired')
      }),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })

    await expect(poller.establishBaseline('user@example.invalid', 'mail-secret')).rejects.toMatchObject({
      code: 'MAIL_AUTHENTICATION_FAILED',
    })
    expect(source.listMessages).toHaveBeenCalledTimes(1)
    expect(time.sleep).not.toHaveBeenCalled()
  })

  it('returns the newest code when one mailbox response contains multiple fresh codes', async () => {
    const older = {
      ...otpMessage(),
      id: 'older-message',
      text: 'Use 111111 to sign in to ChatGPT.',
      receivedAt: '2026-08-11T08:00:04.000Z',
      fingerprint: 'older-fingerprint',
    }
    const newer = {
      ...otpMessage(),
      id: 'newer-message',
      text: 'Use 222222 to sign in to ChatGPT.',
      receivedAt: '2026-08-11T08:00:09.000Z',
      fingerprint: 'newer-fingerprint',
    }
    const source = { listMessages: vi.fn(async () => snapshot([newer, older])) }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'found', code: '222222' })
    expect(source.listMessages).toHaveBeenCalledTimes(1)
    expect(time.sleep).not.toHaveBeenCalled()
  })

  it('caps transient retry delays at five seconds', async () => {
    const rateLimit = new AppError('MAIL_RATE_LIMITED', 'rate limited', {
      retryable: true,
      details: { retryAfterMs: 9000 },
    })
    const transient = new AppError('MAIL_NETWORK_ERROR', 'network', { retryable: true })
    const source = {
      listMessages: vi
        .fn()
        .mockRejectedValueOnce(rateLimit)
        .mockRejectedValueOnce(transient)
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(snapshot([otpMessage()])),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 60_000 })
    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(time.delays).toEqual([5000, 5000, 5000])
    expect(Math.max(...time.delays)).toBeLessThanOrEqual(5000)
  })

  it('stops immediately on mailbox authentication failure', async () => {
    const source = {
      listMessages: vi.fn(async () => {
        throw new AppError('MAIL_AUTHENTICATION_FAILED', 'bad credentials')
      }),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })
    await expect(
      poller.waitForOtp('user@example.invalid', 'bad-secret', createMailBaseline([]), startedAt),
    ).rejects.toMatchObject({ code: 'MAIL_AUTHENTICATION_FAILED' })
    expect(source.listMessages).toHaveBeenCalledTimes(1)
    expect(time.sleep).not.toHaveBeenCalled()
  })

  it('ends after the configured total wait without a candidate', async () => {
    const source = { listMessages: vi.fn(async () => snapshot([])) }
    const time = clock()
    const poller = new MailOtpPoller(source, {
      now: time.now,
      sleep: time.sleep,
      pollIntervalMs: 3000,
      maxWaitMs: 9000,
    })
    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
    expect(time.delays.reduce((sum, delay) => sum + delay, 0)).toBe(9000)
  })

  it('uses a verified newest-first order only after the same first candidate appears twice', async () => {
    const newest = otpMessage()
    const older = {
      ...otpMessage(),
      id: 'older-message',
      fingerprint: 'older-fingerprint',
      text: 'Use 111111 to sign in to ChatGPT.',
      receivedAt: undefined,
    }
    const withoutTime = { ...newest, receivedAt: undefined }
    const source = { listMessages: vi.fn(async () => snapshot([withoutTime, older], 'newest_first')) }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 9000 })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(source.listMessages).toHaveBeenCalledTimes(2)
    expect(time.delays).toEqual([3000])
  })

  it('does not reuse a baseline newest message merely because it appears twice', async () => {
    const old = { ...otpMessage(), receivedAt: undefined }
    const source = { listMessages: vi.fn(async () => snapshot([old], 'newest_first')) }
    const time = clock()
    const baseline = createMailBaseline([old])

    await expect(
      new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })
        .waitForOtp('user@example.invalid', 'mail-secret', baseline, startedAt, undefined, undefined, {
          allowExistingNewestAfterResend: true,
        }),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
  })

  it('reuses a timestamp-less baseline message only after a resend and two stable responses', async () => {
    const resendAt = new Date('2026-08-11T08:00:10.000Z')
    const current = { ...otpMessage(), receivedAt: undefined }
    const source = { listMessages: vi.fn(async () => snapshot([current], 'newest_first')) }
    const time = clock()

    await expect(
      new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })
        .waitForOtp(
          'user@example.invalid',
          'mail-secret',
          createMailBaseline([current]),
          startedAt,
          undefined,
          undefined,
          { allowExistingNewestAfterResend: true, existingNewestNotBefore: resendAt },
        ),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(source.listMessages).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a timestamp-less message when the newest candidate changes after resend', async () => {
    const resendAt = new Date('2026-08-11T08:00:10.000Z')
    const first = { ...otpMessage(), receivedAt: undefined }
    const second = { ...first, id: 'changed-message', fingerprint: 'changed-fingerprint', text: 'Use 135790 to sign in to ChatGPT.' }
    const source = {
      listMessages: vi.fn()
        .mockResolvedValueOnce(snapshot([first], 'newest_first'))
        .mockResolvedValueOnce(snapshot([second], 'newest_first'))
        .mockResolvedValue(snapshot([], 'newest_first')),
    }
    const time = clock()

    await expect(
      new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })
        .waitForOtp(
          'user@example.invalid',
          'mail-secret',
          createMailBaseline([first, second]),
          startedAt,
          undefined,
          undefined,
          { allowExistingNewestAfterResend: true, existingNewestNotBefore: resendAt },
        ),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
  })

  it('rejects a newest message timestamped just before the resend boundary', async () => {
    const resendAt = new Date('2026-08-11T08:00:10.000Z')
    const old = {
      ...otpMessage(),
      receivedAt: '2026-08-11T08:00:09.999Z',
    }
    const source = { listMessages: vi.fn(async () => snapshot([old], 'newest_first')) }
    const time = clock()

    await expect(
      new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })
        .waitForOtp(
          'user@example.invalid',
          'mail-secret',
          createMailBaseline([old]),
          startedAt,
          undefined,
          undefined,
          { allowExistingNewestAfterResend: true, existingNewestNotBefore: resendAt },
        ),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
  })

  it('accepts a reliable newest message immediately at the resend boundary', async () => {
    const resendAt = new Date('2026-08-11T08:00:05.000Z')
    const current = otpMessage()
    const source = { listMessages: vi.fn(async () => snapshot([current], 'newest_first')) }
    const time = clock()

    await expect(
      new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })
        .waitForOtp(
          'user@example.invalid',
          'mail-secret',
          createMailBaseline([current]),
          startedAt,
          undefined,
          undefined,
          { allowExistingNewestAfterResend: true, existingNewestNotBefore: resendAt },
        ),
    ).resolves.toEqual({ kind: 'found', code: '246810' })
    expect(source.listMessages).toHaveBeenCalledTimes(1)
  })

  it('does not use stable list order from an unverified source', async () => {
    const messages = [
      { ...otpMessage(), receivedAt: undefined },
      {
        ...otpMessage(),
        id: 'other-message',
        fingerprint: 'other-fingerprint',
        text: 'Use 111111 to sign in to ChatGPT.',
        receivedAt: undefined,
      },
    ]
    const source = { listMessages: vi.fn(async () => snapshot(messages, 'unknown')) }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 6000 })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'ambiguous', reason: 'missing_time' })
  })

  it('keeps an ordering change ambiguous for the rest of the round', async () => {
    const first = { ...otpMessage(), receivedAt: undefined }
    const second = {
      ...otpMessage(),
      id: 'other-message',
      fingerprint: 'other-fingerprint',
      text: 'Use 111111 to sign in to ChatGPT.',
      receivedAt: undefined,
    }
    const source = {
      listMessages: vi
        .fn()
        .mockResolvedValueOnce(snapshot([first, second], 'newest_first'))
        .mockResolvedValue(snapshot([second, first], 'newest_first')),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep, maxWaitMs: 9000 })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'ambiguous', reason: 'order_changed' })
  })

  it('uses a sixty-second default round', async () => {
    let pollCount = 0
    const source = {
      listMessages: vi.fn(async () => {
        pollCount += 1
        return snapshot([])
      }),
    }
    const time = clock()
    const poller = new MailOtpPoller(source, { now: time.now, sleep: time.sleep })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), startedAt),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
    expect(source.listMessages).toHaveBeenCalledTimes(20)
    expect(pollCount).toBe(20)
    expect(time.delays).toHaveLength(20)
    expect(time.delays.every((delay) => delay === 3000)).toBe(true)
    expect(time.delays.reduce((sum, delay) => sum + delay, 0)).toBe(60_000)
  })

  it('aborts an in-flight mailbox request at the round deadline', async () => {
    const source = {
      listMessages: vi.fn(
        async (_email: string, _password: string, signal?: AbortSignal): Promise<MailboxSnapshot> =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new AppError('TASK_CANCELLED', 'round deadline reached')),
              { once: true },
            )
          }),
      ),
    }
    const poller = new MailOtpPoller(source, { maxWaitMs: 15 })

    await expect(
      poller.waitForOtp('user@example.invalid', 'mail-secret', createMailBaseline([]), new Date()),
    ).resolves.toEqual({ kind: 'timed_out', observedCandidates: false })
    expect(source.listMessages).toHaveBeenCalledTimes(1)
  })
})
