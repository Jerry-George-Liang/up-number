import { createHash, timingSafeEqual } from 'node:crypto'
import { AppError } from '../../shared/errors'
import type { OAuthRedirectShape, OAuthUrlShape } from '../../shared/contracts'

const OPENAI_AUTH_HOST = 'auth.openai.com'
const OPENAI_AUTH_PATH = '/oauth/authorize'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const REQUIRED_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access'])
const REQUIRED_SINGLE_PARAMS = [
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'codex_cli_simplified_flow',
  'id_token_add_organizations',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
] as const

export interface OAuthNavigationContract {
  authUrl: string
  state: string
  redirectOrigin: string
  redirectPath: string
}

export type CallbackAcceptance =
  | { kind: 'ignored' }
  | { kind: 'accepted'; code: string; state: string }

function constantTimeEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function canonicalParameterFingerprint(value: URL): string {
  const entries = [...value.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
  )
  return createHash('sha256')
    .update(JSON.stringify([value.origin, value.pathname, entries]))
    .digest('hex')
    .slice(0, 16)
}

export function describeOAuthUrl(value: string): OAuthUrlShape {
  const url = new URL(value)
  const parameterNames = [...new Set(url.searchParams.keys())].sort()
  return {
    origin: url.origin,
    path: url.pathname,
    totalLength: value.length,
    parameterCount: [...url.searchParams.keys()].length,
    parameterNames,
    parameterFingerprint: canonicalParameterFingerprint(url),
  }
}

export function describeOAuthRedirect(value: string): OAuthRedirectShape {
  const url = new URL(value)
  return { origin: url.origin, path: url.pathname }
}

function invalidContract(): AppError {
  return new AppError(
    'OAUTH_AUTH_URL_CONTRACT_INVALID',
    '后台生成的 OpenAI 授权链接缺少必要参数或格式不正确，请重新生成。',
    { statusCode: 502 },
  )
}

function singleRequiredParam(url: URL, name: (typeof REQUIRED_SINGLE_PARAMS)[number]): string {
  const values = url.searchParams.getAll(name)
  if (values.length !== 1 || !values[0]?.trim()) throw invalidContract()
  return values[0]
}

export function deriveOAuthNavigationContract(authUrlValue: string): OAuthNavigationContract {
  let authUrl: URL
  try {
    authUrl = new URL(authUrlValue)
  } catch {
    throw new AppError('OAUTH_AUTH_URL_INVALID', '后台返回的授权链接无效。', { statusCode: 502 })
  }
  if (
    authUrl.protocol !== 'https:' ||
    authUrl.hostname.toLowerCase() !== OPENAI_AUTH_HOST ||
    authUrl.port ||
    authUrl.username ||
    authUrl.password
  ) {
    throw invalidContract()
  }
  if (authUrl.pathname !== OPENAI_AUTH_PATH || authUrl.hash) throw invalidContract()

  const params = Object.fromEntries(
    REQUIRED_SINGLE_PARAMS.map((name) => [name, singleRequiredParam(authUrl, name)]),
  ) as Record<(typeof REQUIRED_SINGLE_PARAMS)[number], string>
  if (
    params.code_challenge_method !== 'S256' ||
    params.response_type !== 'code' ||
    params.codex_cli_simplified_flow !== 'true' ||
    params.id_token_add_organizations !== 'true' ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)
  ) {
    throw invalidContract()
  }
  const scopes = new Set(params.scope.split(/\s+/).filter(Boolean))
  if ([...REQUIRED_SCOPES].some((scope) => !scopes.has(scope))) throw invalidContract()

  let redirect: URL
  try {
    redirect = new URL(params.redirect_uri)
  } catch {
    throw invalidContract()
  }
  if (
    redirect.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(redirect.hostname.toLowerCase()) ||
    redirect.username ||
    redirect.password ||
    !redirect.port ||
    redirect.pathname !== '/auth/callback' ||
    redirect.search ||
    redirect.hash
  ) {
    throw invalidContract()
  }
  return {
    // Validate with URL, but navigate with the exact one-time value returned by the backend.
    authUrl: authUrlValue,
    state: params.state,
    redirectOrigin: redirect.origin,
    redirectPath: redirect.pathname,
  }
}

export class CallbackCapture {
  #accepted = false

  constructor(private readonly contract: OAuthNavigationContract) {}

  accept(value: string): CallbackAcceptance {
    let candidate: URL
    try {
      candidate = new URL(value)
    } catch {
      return { kind: 'ignored' }
    }
    if (candidate.origin !== this.contract.redirectOrigin || candidate.pathname !== this.contract.redirectPath) {
      return { kind: 'ignored' }
    }
    if (this.#accepted) {
      throw new AppError('OAUTH_CALLBACK_DUPLICATE', '当前任务已经接收过 OAuth 回调。')
    }
    const codes = candidate.searchParams.getAll('code')
    const states = candidate.searchParams.getAll('state')
    const [code] = codes
    const [state] = states
    if (codes.length !== 1 || !code?.trim()) {
      throw new AppError('OAUTH_CALLBACK_CODE_MISSING', 'OAuth 回调缺少唯一授权码。')
    }
    if (states.length !== 1 || !state?.trim()) {
      throw new AppError('OAUTH_CALLBACK_STATE_MISSING', 'OAuth 回调缺少唯一 state。')
    }
    if (!constantTimeEquals(state, this.contract.state)) {
      throw new AppError('OAUTH_CALLBACK_STATE_MISMATCH', 'OAuth 回调 state 校验失败。')
    }
    this.#accepted = true
    return { kind: 'accepted', code, state }
  }
}
