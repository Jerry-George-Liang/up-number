import { AppError } from '../../shared/errors'
import type { MailboxSource } from './client'
import {
  createMailBaseline,
  extractNewestOrderedOtp,
  extractUniqueOtp,
  type MailBaseline,
  type OtpAmbiguityReason,
  type OrderedOtpCandidate,
} from './otp'

export type MailOtpRoundResult =
  | { kind: 'found'; code: string }
  | { kind: 'timed_out'; observedCandidates: boolean }
  | { kind: 'ambiguous'; reason: OtpAmbiguityReason | 'order_changed' }

export interface MailPollerOptions {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  maxBackoffMs?: number
  maxWaitMs?: number
}

export interface MailOtpWaitOptions {
  allowExistingNewestAfterResend?: boolean
  existingNewestNotBefore?: Date
}

const BASELINE_ATTEMPTS = 3

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 }))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MailOtpPoller {
  readonly #now: () => number
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly #pollIntervalMs: number
  readonly #maxBackoffMs: number
  readonly #maxWaitMs: number

  constructor(
    private readonly source: MailboxSource,
    options: MailPollerOptions = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? defaultSleep
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000
    this.#maxBackoffMs = options.maxBackoffMs ?? 5_000
    this.#maxWaitMs = options.maxWaitMs ?? 60_000
  }

  async establishBaseline(
    email: string,
    mailboxPassword: string,
    signal?: AbortSignal,
    trustedPathOrigins?: readonly string[],
  ): Promise<MailBaseline> {
    for (let attempt = 1; attempt <= BASELINE_ATTEMPTS; attempt += 1) {
      try {
        const snapshot = await this.source.listMessages(email, mailboxPassword, signal, trustedPathOrigins)
        return createMailBaseline(snapshot.messages)
      } catch (error) {
        if (!(error instanceof AppError) || !error.retryable || attempt === BASELINE_ATTEMPTS) throw error
        const retryAfter = Number(error.details?.retryAfterMs)
        const delay = Number.isFinite(retryAfter)
          ? retryAfter
          : this.#pollIntervalMs * attempt
        await this.#sleep(Math.min(delay, this.#maxBackoffMs), signal)
      }
    }
    throw new AppError('MAIL_BASELINE_FAILED', '无法建立邮箱初始快照。')
  }

  async waitForOtp(
    email: string,
    mailboxPassword: string,
    baseline: MailBaseline,
    startedAt: Date,
    signal?: AbortSignal,
    trustedPathOrigins?: readonly string[],
    options: MailOtpWaitOptions = {},
  ): Promise<MailOtpRoundResult> {
    const deadline = this.#now() + this.#maxWaitMs
    let transientFailures = 0
    let previousOrderedCandidate: OrderedOtpCandidate | null = null
    let previousResendCandidate: OrderedOtpCandidate | null = null
    let orderingFallbackInvalid = false
    let ambiguity: MailOtpRoundResult | null = null
    while (this.#now() < deadline) {
      if (signal?.aborted) throw new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 })
      let delay = this.#pollIntervalMs
      const requestDeadlineSignal = AbortSignal.timeout(Math.max(1, deadline - this.#now()))
      const requestSignal = signal ? AbortSignal.any([signal, requestDeadlineSignal]) : requestDeadlineSignal
      try {
        const snapshot = await this.source.listMessages(email, mailboxPassword, requestSignal, trustedPathOrigins)
        const selection = extractUniqueOtp(snapshot.messages, baseline, startedAt, snapshot.ordering)
        if (selection.kind === 'found') {
          ;(baseline.otpCodes ??= new Set()).add(selection.code)
          return { kind: 'found', code: selection.code }
        }
        if (selection.kind === 'conflict') {
          ambiguity = orderingFallbackInvalid
            ? { kind: 'ambiguous', reason: 'order_changed' }
            : { kind: 'ambiguous', reason: selection.reason }
          const candidate = selection.orderedCandidate
          if (!orderingFallbackInvalid && candidate) {
            if (
              previousOrderedCandidate &&
              previousOrderedCandidate.identity === candidate.identity &&
              previousOrderedCandidate.code === candidate.code
            ) {
              ;(baseline.otpCodes ??= new Set()).add(candidate.code)
              return { kind: 'found', code: candidate.code }
            }
            if (previousOrderedCandidate) {
              orderingFallbackInvalid = true
              ambiguity = { kind: 'ambiguous', reason: 'order_changed' }
            } else {
              previousOrderedCandidate = candidate
            }
          }
        }
        if (options.allowExistingNewestAfterResend) {
          const candidate = extractNewestOrderedOtp(snapshot.messages, snapshot.ordering)
          if (
            candidate?.receivedAt !== undefined &&
            options.existingNewestNotBefore &&
            candidate.receivedAt >= options.existingNewestNotBefore.getTime()
          ) {
            if (!baseline.otpCodes?.has(candidate.code)) {
              ;(baseline.otpCodes ??= new Set()).add(candidate.code)
              return { kind: 'found', code: candidate.code }
            }
          } else if (
            candidate &&
            candidate.receivedAt === undefined &&
            options.existingNewestNotBefore
          ) {
            if (
              previousResendCandidate?.identity === candidate.identity &&
              previousResendCandidate.code === candidate.code
            ) {
              if (!baseline.otpCodes?.has(candidate.code)) {
                ;(baseline.otpCodes ??= new Set()).add(candidate.code)
                return { kind: 'found', code: candidate.code }
              }
            } else {
              previousResendCandidate = candidate
            }
          }
        }
        transientFailures = 0
      } catch (error) {
        if (requestDeadlineSignal.aborted && !signal?.aborted) break
        if (!(error instanceof AppError) || !error.retryable) throw error
        const retryAfter = Number(error.details?.retryAfterMs)
        if (Number.isFinite(retryAfter)) delay = retryAfter
        else {
          transientFailures += 1
          delay = this.#pollIntervalMs * (transientFailures + 1)
        }
      }
      const remaining = deadline - this.#now()
      if (remaining <= 0) break
      await this.#sleep(Math.min(delay, this.#maxBackoffMs, remaining), signal)
    }
    return ambiguity ?? { kind: 'timed_out', observedCandidates: false }
  }
}
