import * as OTPAuth from 'otpauth'
import { AppError } from '../../shared/errors'
import { normalizeTotpSecret } from '../../shared/login-material'

const MINIMUM_REMAINING_MS = 10_000
const PERIOD_BOUNDARY_BUFFER_MS = 250

export interface GeneratedTotp {
  code: string
  counter: number
}

export interface TotpGeneratorOptions {
  now?: () => number
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

function cancelledError(): AppError {
  return new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 })
}

async function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelledError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class TotpGenerator {
  readonly #now: () => number
  readonly #wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(options: TotpGeneratorOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#wait = options.wait ?? abortableWait
  }

  async next(secretValue: string, afterCounter?: number, signal?: AbortSignal): Promise<GeneratedTotp> {
    if (signal?.aborted) throw cancelledError()
    const normalizedSecret = normalizeTotpSecret(secretValue)
    if (!normalizedSecret) {
      throw new AppError('TOTP_SECRET_INVALID', '2FA 密钥格式无效。', { statusCode: 400 })
    }

    try {
      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(normalizedSecret),
      })
      let timestamp = this.#now()
      let counter = totp.counter({ timestamp })
      let remaining = totp.remaining({ timestamp })
      if (remaining < MINIMUM_REMAINING_MS || (afterCounter !== undefined && counter <= afterCounter)) {
        await this.#wait(remaining + PERIOD_BOUNDARY_BUFFER_MS, signal)
        if (signal?.aborted) throw cancelledError()
        timestamp = this.#now()
        counter = totp.counter({ timestamp })
        remaining = totp.remaining({ timestamp })
      }

      if (
        remaining < MINIMUM_REMAINING_MS ||
        (afterCounter !== undefined && counter <= afterCounter)
      ) {
        throw new AppError('TOTP_GENERATION_FAILED', '无法生成有效期充足的 2FA 动态码。', {
          statusCode: 502,
          retryable: true,
        })
      }
      return { code: totp.generate({ timestamp }), counter }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('TOTP_GENERATION_FAILED', '无法生成 2FA 动态码。', {
        statusCode: 502,
        cause: error,
      })
    }
  }
}

