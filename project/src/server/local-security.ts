import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

interface WriteRequestSecurity {
  cookieSession?: string
  csrfHeader?: string
  origin?: string
  expectedOrigin: string
}

function constantTimeEquals(left?: string, right?: string): boolean {
  if (!left || !right) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

interface LocalSessionSecurityOptions {
  persistentSeed: string
  namespace?: string
  random?: () => string
}

function derivedToken(seed: string, purpose: 'session' | 'csrf', namespace?: string): string {
  const label = namespace
    ? `up-icloud-${purpose}-v1\0${namespace}`
    : `up-icloud-local-${purpose}-v1`
  return createHmac('sha256', Buffer.from(seed, 'base64url'))
    .update(label)
    .digest('base64url')
}

export class LocalSessionSecurity {
  readonly bootstrapNonce: string
  readonly sessionId: string
  readonly csrfToken: string
  #bootstrapConsumed = false

  constructor(
    options: (() => string) | LocalSessionSecurityOptions = () => randomBytes(32).toString('base64url'),
  ) {
    const random = typeof options === 'function' ? options : options.random ?? (() => randomBytes(32).toString('base64url'))
    this.bootstrapNonce = random()
    this.sessionId =
      typeof options === 'function'
        ? random()
        : derivedToken(options.persistentSeed, 'session', options.namespace)
    this.csrfToken =
      typeof options === 'function'
        ? random()
        : derivedToken(options.persistentSeed, 'csrf', options.namespace)
  }

  canBootstrap(value: string): boolean {
    return !this.#bootstrapConsumed && constantTimeEquals(value, this.bootstrapNonce)
  }

  consumeBootstrap(value: string): boolean {
    if (!this.canBootstrap(value)) return false
    this.#bootstrapConsumed = true
    return true
  }

  hasSession(cookieSession?: string): boolean {
    return constantTimeEquals(cookieSession, this.sessionId)
  }

  validateWrite(request: WriteRequestSecurity): { ok: true } | { ok: false; reason: string } {
    if (!this.hasSession(request.cookieSession)) return { ok: false, reason: 'LOCAL_SESSION_REQUIRED' }
    if (!constantTimeEquals(request.csrfHeader, this.csrfToken)) return { ok: false, reason: 'CSRF_TOKEN_INVALID' }
    if (request.origin !== request.expectedOrigin) return { ok: false, reason: 'ORIGIN_INVALID' }
    return { ok: true }
  }
}
