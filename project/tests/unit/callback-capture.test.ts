import { describe, expect, it } from 'vitest'
import {
  CallbackCapture,
  deriveOAuthNavigationContract,
  describeOAuthRedirect,
  describeOAuthUrl,
} from '../../src/server/browser/callback-capture'

const authUrl =
  'https://auth.openai.com/oauth/authorize?client_id=synthetic-client&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=expected-state'

describe('deriveOAuthNavigationContract', () => {
  it('accepts the current OpenAI HTTPS authorization host and loopback redirect', () => {
    expect(deriveOAuthNavigationContract(authUrl)).toEqual({
      authUrl,
      state: 'expected-state',
      redirectOrigin: 'http://127.0.0.1:1455',
      redirectPath: '/auth/callback',
    })
  })

  it('preserves the exact backend URL after validation instead of reconstructing it', () => {
    const original =
      'https://auth.openai.com:443/oauth/authorize?scope=openid+profile+email+offline_access&state=expected-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&id_token_add_organizations=true&codex_cli_simplified_flow=true&code_challenge_method=S256&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&client_id=synthetic-client'
    expect(deriveOAuthNavigationContract(original).authUrl).toBe(original)
  })

  it.each([
    'https://attacker.invalid/authorize?state=x&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback',
    'http://auth.openai.com/authorize?state=x&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback',
    'https://auth.openai.com/authorize?state=x&redirect_uri=https%3A%2F%2Fcallback.example.invalid%2Foauth',
  ])('rejects untrusted authorization or callback origins', (url) => {
    expect(() => deriveOAuthNavigationContract(url)).toThrow(/授权|回调/)
  })

  it.each([
    authUrl.replace('/oauth/authorize', '/authorize'),
    authUrl.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    authUrl.replace('client_id=synthetic-client&', ''),
    `${authUrl}&state=duplicate-state`,
    authUrl.replace('scope=openid+profile+email+offline_access', 'scope=openid+profile+email'),
    authUrl.replace('auth.openai.com/', 'auth.openai.com:444/'),
    authUrl.replace('%2Fauth%2Fcallback', '%2Fwrong%2Fcallback'),
  ])('rejects an incomplete or ambiguous Codex OAuth URL', (url) => {
    expect(() => deriveOAuthNavigationContract(url)).toThrow(
      expect.objectContaining({ code: 'OAUTH_AUTH_URL_CONTRACT_INVALID' }),
    )
  })
})

describe('OAuth navigation diagnostics', () => {
  it('describes the complete URL structure without retaining parameter values', () => {
    const shape = describeOAuthUrl(authUrl)
    expect(shape).toMatchObject({
      origin: 'https://auth.openai.com',
      path: '/oauth/authorize',
      totalLength: authUrl.length,
      parameterCount: 9,
      parameterNames: [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'codex_cli_simplified_flow',
        'id_token_add_organizations',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ],
      parameterFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    })
    expect(JSON.stringify(shape)).not.toMatch(
      /synthetic-client|expected-state|abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ|127\.0\.0\.1:1455/,
    )
  })

  it('separates the initial authorization request from the later OpenAI redirect', () => {
    const generated = describeOAuthUrl(authUrl)
    const reordered = describeOAuthUrl(
      'https://auth.openai.com/oauth/authorize?' + new URL(authUrl).searchParams.toString().split('&').reverse().join('&'),
    )
    expect(reordered.parameterFingerprint).toBe(generated.parameterFingerprint)
    expect(describeOAuthRedirect('https://auth.openai.com/log-in')).toEqual({
      origin: 'https://auth.openai.com',
      path: '/log-in',
    })
  })
})

describe('CallbackCapture', () => {
  it('ignores unrelated navigation and accepts one exact callback', () => {
    const capture = new CallbackCapture(deriveOAuthNavigationContract(authUrl))
    expect(capture.accept('https://auth.openai.com/login')).toEqual({ kind: 'ignored' })
    expect(
      capture.accept('http://127.0.0.1:1455/auth/callback?code=oauth-code&state=expected-state'),
    ).toEqual({ kind: 'accepted', code: 'oauth-code', state: 'expected-state' })
  })

  it.each([
    ['http://127.0.0.1:1455/auth/callback?state=expected-state', 'OAUTH_CALLBACK_CODE_MISSING'],
    ['http://127.0.0.1:1455/auth/callback?code=oauth-code', 'OAUTH_CALLBACK_STATE_MISSING'],
    [
      'http://127.0.0.1:1455/auth/callback?code=oauth-code&code=other-code&state=expected-state',
      'OAUTH_CALLBACK_CODE_MISSING',
    ],
    [
      'http://127.0.0.1:1455/auth/callback?code=oauth-code&state=wrong-state',
      'OAUTH_CALLBACK_STATE_MISMATCH',
    ],
  ])('rejects malformed or mismatched callback %s', (url, code) => {
    const capture = new CallbackCapture(deriveOAuthNavigationContract(authUrl))
    expect(() => capture.accept(url)).toThrow(expect.objectContaining({ code }))
  })

  it('rejects duplicate callback acceptance', () => {
    const capture = new CallbackCapture(deriveOAuthNavigationContract(authUrl))
    const callback = 'http://127.0.0.1:1455/auth/callback?code=oauth-code&state=expected-state'
    capture.accept(callback)
    expect(() => capture.accept(callback)).toThrow(expect.objectContaining({ code: 'OAUTH_CALLBACK_DUPLICATE' }))
  })
})
