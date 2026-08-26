import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertAuthorizationNavigation,
  classifySubmissionTransition,
  closeNativeChrome,
  findOwnedChromeProcessId,
  hasManualPageChanged,
  mainFrameNavigationUrl,
  nativeChromeLaunchArgs,
  oauthBrowserLaunchOptions,
  reconcileKnownPageAutomationFailure,
  recoverBrowserAutomationFailure,
  resendOtpOnce,
  shouldResumeAfterManualProgress,
  submitConsentWithRetry,
  verifyBrowserProxyReachability,
  verifyInitialAuthorizationNavigation,
} from '../../src/server/browser/controller'
import { classifyPageHtml, OTP_RESEND_CONTROL_NAME } from '../../src/server/browser/page-classifier'
import { AppError } from '../../src/shared/errors'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const generatedAuthUrl =
  'https://auth.openai.com/oauth/authorize?client_id=synthetic-client&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&codex_cli_simplified_flow=true&id_token_add_organizations=true&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=expected-state'

describe('OAuth browser launch', () => {
  it('closes the owned native Chrome process after the CDP browser closes', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      killed: boolean
      pid?: number
      kill: ReturnType<typeof vi.fn>
    }
    child.exitCode = null
    child.killed = false
    child.pid = undefined
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      expect(signal).toBe('SIGTERM')
      child.exitCode = 0
      child.emit('exit', 0, signal)
      return true
    })

    await closeNativeChrome(undefined, {
      launcher: child as unknown as import('node:child_process').ChildProcess,
      processId: null,
    })

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('always opens branded Chrome in an explicit incognito window', () => {
    expect(oauthBrowserLaunchOptions()).toMatchObject({
      headless: false,
      channel: 'chrome',
      chromiumSandbox: true,
      args: ['--incognito'],
      acceptDownloads: false,
    })
  })

  it('keeps the resolved task proxy on the incognito browser', () => {
    const proxy = { server: 'http://proxy.example.invalid:8080', username: 'user', password: 'secret' }
    expect(oauthBrowserLaunchOptions(proxy).proxy).toEqual(proxy)
  })

  it('fails before Chrome launch when the resolved task proxy is unreachable', async () => {
    const probe = vi.fn(async () => {
      throw Object.assign(new Error('synthetic refused proxy endpoint'), { code: 'ECONNREFUSED' })
    })

    await expect(
      verifyBrowserProxyReachability(
        { server: 'socks5://127.0.0.1:9000', username: 'synthetic-user', password: 'synthetic-secret' },
        undefined,
        probe,
      ),
    ).rejects.toMatchObject({
      code: 'BROWSER_PROXY_CONNECTION_FAILED',
      retryable: true,
    })
    expect(probe).toHaveBeenCalledOnce()
    await expect(
      verifyBrowserProxyReachability(
        { server: 'socks5://127.0.0.1:9000', username: 'synthetic-user', password: 'synthetic-secret' },
        undefined,
        probe,
      ),
    ).rejects.not.toThrow(/127\.0\.0\.1|9000|synthetic-user|synthetic-secret/)
  })

  it('passes an IPv6 proxy hostname to the TCP probe without URL brackets', async () => {
    const probe = vi.fn(async () => undefined)
    await verifyBrowserProxyReachability({ server: 'socks5://[::1]:1080' }, undefined, probe)
    expect(probe).toHaveBeenCalledWith({ hostname: '::1', port: 1080 }, undefined)
  })

  it('starts a native Chrome incognito window without sandbox-disabling flags', () => {
    const args = nativeChromeLaunchArgs('/tmp/up-icloud-oauth-synthetic', 43124)
    expect(args).toContain('--incognito')
    expect(args).toContain('--user-data-dir=/tmp/up-icloud-oauth-synthetic')
    expect(args).toContain('--remote-debugging-port=43124')
    expect(args).not.toContain('--no-sandbox')
    expect(args).not.toContain('--disable-web-security')
  })

  it('preserves an unauthenticated SOCKS proxy and remote DNS resolution in native Chrome', () => {
    const args = nativeChromeLaunchArgs('/tmp/up-icloud-oauth-synthetic', 43124, {
      server: 'socks5://proxy.example.invalid:1080',
    })
    expect(args).toContain('--proxy-server=socks5://proxy.example.invalid:1080')
    expect(args).toContain('--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE proxy.example.invalid"')
  })

  it('resolves only the Chrome process matching both the task profile and debugging port', () => {
    const processList = [
      '  100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=43124 --user-data-dir=/tmp/daily',
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=50001 --user-data-dir=/tmp/up-icloud-oauth-synthetic',
      '  102 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=43124 --user-data-dir=/tmp/up-icloud-oauth-synthetic',
    ].join('\n')

    expect(findOwnedChromeProcessId(processList, '/tmp/up-icloud-oauth-synthetic', 43124)).toBe(102)
    expect(findOwnedChromeProcessId(processList, '/tmp/missing', 43124)).toBeNull()
  })

  it('accepts the complete backend URL at the first Chrome navigation boundary', () => {
    expect(() => assertAuthorizationNavigation(generatedAuthUrl, generatedAuthUrl)).not.toThrow()
  })

  it.each([
    'https://auth.openai.com/oauth',
    generatedAuthUrl.replace('&state=expected-state', ''),
    generatedAuthUrl.replace('state=expected-state', 'state=other-state'),
  ])('rejects a first Chrome navigation that loses or changes OAuth parameters', (actualUrl) => {
    expect(() => assertAuthorizationNavigation(generatedAuthUrl, actualUrl)).toThrow(
      expect.objectContaining({ code: 'OAUTH_AUTH_URL_NAVIGATION_MISMATCH' }),
    )
  })

  it('keeps the browser session when goto rejects after the complete first request was captured', async () => {
    const navigate = vi.fn(async () => {
      throw new Error('synthetic navigation interrupted')
    })

    await expect(
      verifyInitialAuthorizationNavigation(generatedAuthUrl, Promise.resolve(generatedAuthUrl), navigate),
    ).resolves.toBe(generatedAuthUrl)
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('does not keep a Chrome proxy error page after the complete first request was captured', async () => {
    const navigate = vi.fn(async () => {
      throw new Error(`page.goto: net::ERR_PROXY_CONNECTION_FAILED at ${generatedAuthUrl}`)
    })

    await expect(
      verifyInitialAuthorizationNavigation(
        generatedAuthUrl,
        Promise.resolve(generatedAuthUrl),
        navigate,
        true,
      ),
    ).rejects.toMatchObject({
      code: 'BROWSER_PROXY_CONNECTION_FAILED',
      retryable: true,
    })
  })

  it('does not classify a direct navigation error as a task proxy failure', async () => {
    const navigate = vi.fn(async () => {
      throw new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED')
    })

    await expect(
      verifyInitialAuthorizationNavigation(generatedAuthUrl, Promise.resolve(null), navigate),
    ).rejects.toMatchObject({ code: 'BROWSER_NAVIGATION_FAILED' })
  })

  it('fails when goto rejects and Chrome never emits a first navigation request', async () => {
    const navigate = vi.fn(async () => {
      throw new Error('synthetic proxy connection failure')
    })

    await expect(
      verifyInitialAuthorizationNavigation(generatedAuthUrl, Promise.resolve(null), navigate),
    ).rejects.toMatchObject({
      code: 'BROWSER_NAVIGATION_FAILED',
      retryable: true,
    })
  })

  it('still rejects a captured request that loses OAuth parameters after goto rejects', async () => {
    await expect(
      verifyInitialAuthorizationNavigation(
        generatedAuthUrl,
        Promise.resolve('https://auth.openai.com/oauth'),
        async () => {
          throw new Error('synthetic navigation interrupted')
        },
      ),
    ).rejects.toMatchObject({ code: 'OAUTH_AUTH_URL_NAVIGATION_MISMATCH' })
  })
})

describe('browser automation fallback', () => {
  it('observes top-level callback navigation from a popup page', () => {
    const popupPage = { mainFrame: () => popupMainFrame }
    const popupMainFrame = { page: () => popupPage }
    const callbackUrl = 'http://localhost:1455/auth/callback?code=synthetic-code&state=expected-state'

    expect(mainFrameNavigationUrl({
      isNavigationRequest: () => true,
      url: () => callbackUrl,
      frame: () => popupMainFrame,
    })).toBe(callbackUrl)
  })

  it('ignores subframe and non-navigation requests from the browser context', () => {
    const page = { mainFrame: () => mainFrame }
    const mainFrame = { page: () => page }
    const childFrame = { page: () => page }
    const request = {
      url: () => 'http://localhost:1455/auth/callback?code=synthetic-code&state=expected-state',
    }

    expect(mainFrameNavigationUrl({
      ...request,
      isNavigationRequest: () => true,
      frame: () => childFrame,
    })).toBeNull()
    expect(mainFrameNavigationUrl({
      ...request,
      isNavigationRequest: () => false,
      frame: () => mainFrame,
    })).toBeNull()
  })

  it('keeps same-path full navigations as durable manual progress', () => {
    expect(hasManualPageChanged({
      samePage: true,
      initialIdentity: 'https://auth.openai.com/log-in',
      currentIdentity: 'https://auth.openai.com/log-in',
      initialNavigationCount: 4,
      currentNavigationCount: 5,
    })).toBe(true)
    expect(hasManualPageChanged({
      samePage: true,
      initialIdentity: 'https://auth.openai.com/log-in',
      currentIdentity: 'https://auth.openai.com/log-in',
      initialNavigationCount: 4,
      currentNavigationCount: 4,
    })).toBe(false)
  })

  it('resumes only on a supported page after real manual progress', () => {
    const otpPage = {
      kind: 'email_otp' as const,
      inputSelector: 'input[name="code"]',
      submitSelector: 'button[type="submit"]',
    }
    expect(shouldResumeAfterManualProgress(otpPage, {
      blockedPage: 'email_otp',
      preferredLogin: 'email_otp',
      requireActivityOnBlockedPage: true,
      pageChanged: false,
      userActivity: false,
    })).toBe(false)
    expect(shouldResumeAfterManualProgress(otpPage, {
      blockedPage: 'email_otp',
      preferredLogin: 'email_otp',
      requireActivityOnBlockedPage: true,
      pageChanged: false,
      userActivity: true,
    })).toBe(true)
    expect(shouldResumeAfterManualProgress(otpPage, {
      blockedPage: 'password',
      preferredLogin: 'password',
      requireActivityOnBlockedPage: false,
      pageChanged: true,
      userActivity: true,
    })).toBe(false)
    expect(shouldResumeAfterManualProgress(
      { kind: 'consent', submitSelector: 'button[type="submit"]' },
      {
        blockedPage: 'email',
        preferredLogin: 'email_otp',
        requireActivityOnBlockedPage: true,
        pageChanged: true,
        userActivity: false,
      },
    )).toBe(true)
  })

  it('hands a recoverable DOM operation failure to the user without closing the page', () => {
    expect(recoverBrowserAutomationFailure(new Error('synthetic DOM transition'), false, false)).toEqual({
      kind: 'manual_intervention',
      reason: 'unknown',
    })
  })

  it('treats a captured callback as success even when the preceding DOM action rejected', () => {
    expect(recoverBrowserAutomationFailure(new Error('synthetic navigation race'), true, false)).toEqual({
      kind: 'submitted',
    })
  })

  it('keeps explicit application errors instead of masking them as manual intervention', () => {
    const error = new AppError('MAIL_AUTHENTICATION_FAILED', 'synthetic mail failure')
    expect(() => recoverBrowserAutomationFailure(error, false, false)).toThrow(error)
  })

  it('reports a genuinely closed authorization page as terminal', () => {
    expect(() => recoverBrowserAutomationFailure(new Error('synthetic closed page'), false, true)).toThrow(
      expect.objectContaining({ code: 'BROWSER_CLOSED' }),
    )
  })

  it('continues automatically when a DOM race has already reached the expected next page', async () => {
    const pages = [
      '<main><h1>Loading</h1></main>',
      '<main><h1>Check your email</h1><input name="code" autocomplete="one-time-code"><button type="submit">Continue</button></main>',
    ]
    await expect(
      reconcileKnownPageAutomationFailure(new Error('synthetic detached locator'), 'email', 'email_otp', {
        callbackSettled: () => false,
        pageClosed: () => false,
        readCurrentHtml: async () => pages.shift()!,
        waitBeforeRetry: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'submitted' })
  })

  it('retries the known form when the user interaction only invalidated the old locator', async () => {
    const html = await readFile(`${fixtures}/openai-email-zh.html`, 'utf8')
    await expect(
      reconcileKnownPageAutomationFailure(new Error('synthetic stale locator'), 'email', 'email_otp', {
        callbackSettled: () => false,
        pageClosed: () => false,
        readCurrentHtml: async () => html,
        waitBeforeRetry: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'retry_current_page' })
  })

  it('keeps true unknown and security-challenge pages inside the manual boundary', async () => {
    const unknown = await reconcileKnownPageAutomationFailure(
      new Error('synthetic unknown page'),
      'password',
      'password',
      {
        callbackSettled: () => false,
        pageClosed: () => false,
        readCurrentHtml: async () => '<main><h1>Unexpected new step</h1></main>',
        waitBeforeRetry: async () => undefined,
      },
    )
    const challenge = await reconcileKnownPageAutomationFailure(
      new Error('synthetic challenge transition'),
      'email',
      'email_otp',
      {
        callbackSettled: () => false,
        pageClosed: () => false,
        readCurrentHtml: async () => '<main><h1>Verify you are human</h1></main>',
        waitBeforeRetry: async () => undefined,
      },
    )
    expect(unknown).toEqual({ kind: 'manual_intervention', reason: 'unknown' })
    expect(challenge).toEqual({ kind: 'manual_intervention', reason: 'challenge' })
  })

  it('gives a captured callback priority while reclassifying an interrupted action', async () => {
    const readCurrentHtml = vi.fn(async () => '<main>unused</main>')
    await expect(
      reconcileKnownPageAutomationFailure(new Error('synthetic navigation race'), 'consent', 'email_otp', {
        callbackSettled: () => true,
        pageClosed: () => false,
        readCurrentHtml,
        waitBeforeRetry: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'submitted' })
    expect(readCurrentHtml).not.toHaveBeenCalled()
  })

  it('reports rejected credentials as an explicit failure instead of manual intervention', async () => {
    await expect(
      reconcileKnownPageAutomationFailure(new Error('synthetic rejected token'), 'authenticator_totp', 'password', {
        callbackSettled: () => false,
        pageClosed: () => false,
        readCurrentHtml: async () => '<main><h1>Invalid verification code</h1></main>',
        waitBeforeRetry: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'OPENAI_CREDENTIALS_REJECTED' })
  })
})

describe('credential-error password retry classification', () => {
  const rejectedPasswordPage = `
    <main>
      <p>Incorrect password</p>
      <input id="password" type="password">
      <button type="submit">Continue</button>
    </main>
  `

  it('normally reports a rejected password page as credentials', () => {
    expect(classifyPageHtml(rejectedPasswordPage)).toEqual({
      kind: 'manual_intervention',
      reason: 'credentials',
    })
  })

  it('allows the controlled retry to recover the password form', () => {
    expect(classifyPageHtml(rejectedPasswordPage, { allowCredentialsErrorPage: true })).toMatchObject({
      kind: 'password',
      inputSelector: '#password',
    })
  })

  it.each([
    'Wrong email or password',
    'Incorrect email address or password',
    'Your email or password is incorrect',
    'Password you entered is invalid',
    'Invalid login credentials',
    '邮箱或密码错误',
  ])('recognizes an explicit password rejection variant: %s', (message) => {
    expect(classifyPageHtml(`<main><p>${message}</p></main>`)).toEqual({
      kind: 'manual_intervention',
      reason: 'credentials',
    })
  })
})

describe('OTP resend', () => {
  const otpClassification = {
    kind: 'email_otp' as const,
    inputSelector: '#code',
    submitSelector: 'button[type="submit"]',
  }

  it('refreshes the baseline before one verified resend click', async () => {
    const calls: string[] = []
    const clickResend = vi.fn(async () => {
      calls.push('click')
      return true
    })
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => otpClassification,
        beforeOtpRequest: async () => {
          calls.push('baseline')
        },
        clickResend,
      }),
    ).resolves.toEqual({ kind: 'submitted' })
    expect(calls).toEqual(['baseline', 'click'])
    expect(clickResend).toHaveBeenCalledTimes(1)
  })

  it('does not refresh or click when the current page is not a verified OTP page', async () => {
    const beforeOtpRequest = vi.fn(async () => undefined)
    const clickResend = vi.fn(async () => true)
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => ({ kind: 'manual_intervention', reason: 'challenge' }),
        beforeOtpRequest,
        clickResend,
      }),
    ).resolves.toEqual({ kind: 'manual_intervention', reason: 'challenge' })
    expect(beforeOtpRequest).not.toHaveBeenCalled()
    expect(clickResend).not.toHaveBeenCalled()
  })

  it('gives a captured callback priority before and after the baseline refresh', async () => {
    let callbackSettled = false
    const clickResend = vi.fn(async () => true)
    await expect(
      resendOtpOnce({
        callbackSettled: () => callbackSettled,
        classifyOtpPage: async () => otpClassification,
        beforeOtpRequest: async () => {
          callbackSettled = true
        },
        clickResend,
      }),
    ).resolves.toEqual({ kind: 'callback_captured' })
    expect(clickResend).not.toHaveBeenCalled()
  })

  it('continues polling when a user click or DOM race leaves the verified OTP page active', async () => {
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => otpClassification,
        clickResend: async () => false,
      }),
    ).resolves.toEqual({ kind: 'continue_polling' })
  })

  it('adopts a consent page reached by the user while resend is being reconciled', async () => {
    const beforeOtpRequest = vi.fn(async () => undefined)
    const clickResend = vi.fn(async () => true)
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => ({ kind: 'consent', submitSelector: 'button[type="submit"]' }),
        beforeOtpRequest,
        clickResend,
      }),
    ).resolves.toEqual({ kind: 'consent_ready' })
    expect(beforeOtpRequest).not.toHaveBeenCalled()
    expect(clickResend).not.toHaveBeenCalled()
  })

  it('still hands an unknown page to the user after an unconfirmed resend click', async () => {
    const classifications = [
      otpClassification,
      { kind: 'manual_intervention' as const, reason: 'unknown' as const },
    ]
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => classifications.shift()!,
        clickResend: async () => false,
      }),
    ).resolves.toEqual({ kind: 'manual_intervention', reason: 'unknown' })
  })

  it('does not mask an OpenAI provider error as an OTP resend failure', async () => {
    const clickResend = vi.fn(async () => true)
    await expect(
      resendOtpOnce({
        callbackSettled: () => false,
        classifyOtpPage: async () => ({ kind: 'manual_intervention', reason: 'provider_error' }),
        clickResend,
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_ERROR' })
    expect(clickResend).not.toHaveBeenCalled()
  })

  it.each(['重新发送验证码', '再次发送验证码', '重新发送电子邮件', 'Resend code', 'Resend email', 'Send again'])(
    'accepts only the approved exact resend label: %s',
    (label) => {
      expect(OTP_RESEND_CONTROL_NAME.test(label)).toBe(true)
    },
  )

  it.each(['重新发送', 'Resend', 'Send code again', 'Please resend code now'])(
    'rejects an unapproved broad resend label: %s',
    (label) => {
      expect(OTP_RESEND_CONTROL_NAME.test(label)).toBe(false)
    },
  )
})

describe('classifyPageHtml', () => {
  it('classifies only a visible exact account_deactivated error code', async () => {
    const html = await readFile(`${fixtures}/openai-account-deactivated-zh.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({ kind: 'account_deactivated' })
    expect(() => classifySubmissionTransition('email_otp', html)).toThrow(
      expect.objectContaining({ code: 'OPENAI_ACCOUNT_DEACTIVATED' }),
    )
  })

  it.each([
    '<main><h1>身份验证错误</h1><p>账号暂时不可用</p><button>重试</button></main>',
    '<main><h1>account_deactivated_pending</h1><button>重试</button></main>',
    '<main><h1>Unexpected</h1><script>window.error = "account_deactivated"</script></main>',
  ])('does not infer deactivation from broad, partial, or hidden evidence', (html) => {
    expect(classifyPageHtml(html)).not.toEqual({ kind: 'account_deactivated' })
  })

  it('classifies an email page using semantic input attributes', async () => {
    const html = await readFile(`${fixtures}/openai-email.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'email',
      inputSelector: '#email',
      submitSelector: 'button[type="submit"]',
    })
  })

  it('classifies the Chinese OpenAI email page with its visible continue button', async () => {
    const html = await readFile(`${fixtures}/openai-email-zh.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'email',
      inputSelector: '#email',
      submitSelector: 'button[type="submit"]',
    })
  })

  it('falls back to a semantic input submit control', () => {
    expect(
      classifyPageHtml(
        '<form><input name="email" type="email"><input type="submit" value="Continue"></form>',
      ),
    ).toEqual({
      kind: 'email',
      inputSelector: 'input[name="email"]',
      submitSelector: 'input[type="submit"]',
    })
  })

  it('classifies a one-time-code page without relying on CSS classes', async () => {
    const html = await readFile(`${fixtures}/openai-otp.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'email_otp',
      inputSelector: '#code',
      submitSelector: 'button[type="submit"]',
    })
  })

  it('classifies a password page while retaining the exact email-code alternative', async () => {
    const html = await readFile(`${fixtures}/openai-password.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'password',
      inputSelector: '#password',
      submitSelector: 'button[type="submit"]',
      hasOneTimeCodeLoginChoice: true,
    })
    expect(classifySubmissionTransition('email', html, 'email_otp')).toEqual({ kind: 'otp_login_choice' })
    expect(classifySubmissionTransition('email', html, 'password')).toEqual({ kind: 'submitted' })
  })

  it.each([
    '<main><input type="password"><button>Delete</button></main>',
    '<main><input type="password"><input type="password"><button>Continue</button></main>',
  ])('does not automate a password field without one unambiguous login form', (html) => {
    expect(classifyPageHtml(html)).toEqual({ kind: 'manual_intervention', reason: 'password' })
  })

  it('classifies an authenticator code separately from an email code', async () => {
    const html = await readFile(`${fixtures}/openai-authenticator-totp.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'authenticator_totp',
      inputSelector: '#code',
      submitSelector: 'button[type="submit"]',
    })
  })

  it('does not infer the purpose of an otherwise valid six-digit code input', () => {
    const html = `
      <main>
        <h1>Enter a code</h1>
        <input id="code" name="code" autocomplete="one-time-code" maxlength="6">
        <button type="submit">Continue</button>
      </main>
    `
    expect(classifyPageHtml(html)).toEqual({ kind: 'manual_intervention', reason: 'unknown' })
  })

  it('does not automate multiple code inputs even with authenticator text', () => {
    const html = `
      <main>
        <h1>Authenticator app</h1>
        <input name="code" autocomplete="one-time-code">
        <input name="backup_code">
        <button type="submit">Continue</button>
      </main>
    `
    expect(classifyPageHtml(html)).toEqual({ kind: 'manual_intervention', reason: 'mfa' })
  })

  it('classifies only the exact OpenAI add-phone form as phone verification', () => {
    const html = `
      <main>
        <h1>电话号码是必填项</h1>
        <p>添加您的电话号码以继续。我们会向该号码发送一次性验证码进行验证。</p>
        <input type="tel" name="phone_number" autocomplete="tel">
        <button type="submit">继续</button>
      </main>
    `
    expect(classifyPageHtml(html, { pageUrl: 'https://auth.openai.com/add-phone' })).toEqual({
      kind: 'phone_verification',
    })
    expect(classifyPageHtml(html, { pageUrl: 'https://auth.openai.com/log-in' })).toEqual({
      kind: 'manual_intervention',
      reason: 'unknown',
    })
    expect(classifyPageHtml('<main><h1>电话号码是必填项</h1><button>继续</button></main>', {
      pageUrl: 'https://auth.openai.com/add-phone',
    })).toEqual({ kind: 'manual_intervention', reason: 'unknown' })
  })

  it('classifies the Codex consent page only when its purpose and continue control are both visible', async () => {
    const html = await readFile(`${fixtures}/openai-consent-zh.html`, 'utf8')
    expect(classifyPageHtml(html)).toEqual({
      kind: 'consent',
      submitSelector: 'button[type="submit"]',
    })
  })

  it.each([
    '<main><h1>使用 ChatGPT 登录 Codex</h1><button>取消</button></main>',
    '<main><h1>Unknown consent</h1><button>继续</button></main>',
  ])('does not click a generic or incomplete consent-like page', (html) => {
    expect(classifyPageHtml(html)).toEqual({ kind: 'manual_intervention', reason: 'unknown' })
  })

  it('gives security challenges priority over fillable fields', async () => {
    const html = await readFile(`${fixtures}/openai-challenge.html`, 'utf8')
    expect(classifyPageHtml(html)).toMatchObject({ kind: 'manual_intervention', reason: 'challenge' })
  })

  it('does not mistake the password fallback link on the email page for a password challenge', () => {
    const html = `
      <main>
        <input id="email" name="email" type="email" autocomplete="email">
        <a href="#password">改用密码</a>
        <button type="submit">继续</button>
      </main>
    `
    expect(classifyPageHtml(html)).toMatchObject({ kind: 'email', inputSelector: '#email' })
  })

  it('prioritizes a semantic email field over incidental MFA copy on the login shell', () => {
    const html = `
      <main>
        <h1>欢迎回来</h1>
        <p>你也可以使用手机验证恢复访问。</p>
        <form>
          <label for="identifier">电子邮件地址</label>
          <input id="identifier" type="text" inputmode="email">
          <button type="submit">继续</button>
        </form>
      </main>
    `
    expect(classifyPageHtml(html)).toEqual({
      kind: 'email',
      inputSelector: '#identifier',
      submitSelector: 'button[type="submit"]',
    })
  })

  it('does not mistake the password fallback link on the OTP page for a password challenge', () => {
    const html = `
      <main>
        <h1>Check your email</h1>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
        <a href="#password">Use password instead</a>
        <button type="submit">Continue</button>
      </main>
    `
    expect(classifyPageHtml(html)).toMatchObject({ kind: 'email_otp', inputSelector: '#code' })
  })

  it.each(['使用一次性验证码登录', 'Use a one-time code'])(
    'recognizes the exact one-time-code login choice on a password page: %s',
    (label) => {
      const html = `
        <main>
          <input id="password" name="password" type="password">
          <button type="submit">Continue</button>
          <button type="button">${label}</button>
        </main>
      `
      expect(classifyPageHtml(html)).toEqual({
        kind: 'password',
        inputSelector: '#password',
        submitSelector: 'button[type="submit"]',
        hasOneTimeCodeLoginChoice: true,
      })
      expect(classifySubmissionTransition('email', html)).toEqual({ kind: 'otp_login_choice' })
      expect(classifySubmissionTransition('email_otp', html)).toEqual({
        kind: 'manual_intervention',
        reason: 'password',
      })
      expect(classifySubmissionTransition('email', html, 'password')).toEqual({ kind: 'submitted' })
    },
  )

  it('does not infer an automatic OTP choice from plain password-page text', () => {
    const html = `
      <main>
        <input id="password" name="password" type="password">
        <p>使用一次性验证码登录</p>
        <button type="submit">继续</button>
      </main>
    `
    expect(classifyPageHtml(html)).toEqual({
      kind: 'password',
      inputSelector: '#password',
      submitSelector: 'button[type="submit"]',
      hasOneTimeCodeLoginChoice: false,
    })
  })

  it('keeps a security challenge ahead of the one-time-code login choice', () => {
    const html = `
      <main>
        <h1>Verify you are human</h1>
        <input id="password" name="password" type="password">
        <button type="button">Use a one-time code</button>
      </main>
    `
    expect(classifyPageHtml(html)).toEqual({ kind: 'manual_intervention', reason: 'challenge' })
  })

  it.each([
    '<main><h1>Choose an account</h1></main>',
    '<main><h1>Use your security key</h1></main>',
  ])('never automates account selection or unsupported MFA-like pages', (html) => {
    expect(classifyPageHtml(html).kind).toBe('manual_intervention')
  })

  it('classifies an unrecognized page as manual intervention', () => {
    expect(classifyPageHtml('<main><h1>Unexpected page</h1></main>')).toEqual({
      kind: 'manual_intervention',
      reason: 'unknown',
    })
  })

  it('does not report success while the same email or OTP form remains visible', async () => {
    const emailHtml = await readFile(`${fixtures}/openai-email-zh.html`, 'utf8')
    const otpHtml = await readFile(`${fixtures}/openai-otp.html`, 'utf8')
    expect(classifySubmissionTransition('email', emailHtml)).toBeNull()
    expect(classifySubmissionTransition('email_otp', otpHtml)).toBeNull()
  })

  it('adopts known next steps when the user advances before automation finishes', () => {
    const otpHtml = `
      <main>
        <h1>Check your email</h1>
        <input name="code" autocomplete="one-time-code">
        <button type="submit">Continue</button>
      </main>
    `
    const authenticatorHtml = `
      <main>
        <h1>Authenticator app</h1>
        <input name="code" autocomplete="one-time-code">
        <button type="submit">Continue</button>
      </main>
    `
    expect(classifySubmissionTransition('email', otpHtml)).toEqual({ kind: 'submitted' })
    expect(classifySubmissionTransition('password', authenticatorHtml, 'password')).toEqual({
      kind: 'submitted',
    })
    expect(classifySubmissionTransition('email', authenticatorHtml, 'password')).toEqual({
      kind: 'submitted',
    })
  })

  it('does not report consent completion while the same consent page remains visible', async () => {
    const html = await readFile(`${fixtures}/openai-consent-zh.html`, 'utf8')
    expect(classifySubmissionTransition('consent', html)).toBeNull()
    expect(classifySubmissionTransition('consent', '<main><h1>Redirecting</h1></main>')).toEqual({
      kind: 'manual_intervention',
      reason: 'unknown',
    })
  })

  it('stops rather than treating the OpenAI provider error page as a submission', () => {
    const errorHtml = `
      <html>
        <head><title>糟糕，出错了！ - OpenAI</title></head>
        <body><main></main></body>
      </html>
    `
    expect(classifyPageHtml(errorHtml)).toEqual({
      kind: 'manual_intervention',
      reason: 'provider_error',
    })
    expect(() => classifySubmissionTransition('email', errorHtml)).toThrow(
      expect.objectContaining({ code: 'OAUTH_PROVIDER_ERROR' }),
    )
  })
})

describe('Codex consent submission', () => {
  async function consentHtml() {
    return readFile(`${fixtures}/openai-consent-zh.html`, 'utf8')
  }

  it('retries once when the first click leaves the same consent page', async () => {
    const html = await consentHtml()
    const clickConsent = vi.fn(async () => true)
    const waitForTransition = vi
      .fn<() => Promise<{ kind: 'submitted' } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: 'submitted' })

    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition,
        readCurrentHtml: async () => html,
      }),
    ).resolves.toEqual({ kind: 'submitted' })
    expect(clickConsent).toHaveBeenCalledTimes(2)
    expect(waitForTransition).toHaveBeenCalledTimes(2)
  })

  it('hands control to the user after all known consent retries are ineffective', async () => {
    const html = await consentHtml()
    const clickConsent = vi.fn(async () => true)
    const waitForTransition = vi.fn(async () => null)

    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition,
        readCurrentHtml: async () => html,
      }),
    ).resolves.toEqual({ kind: 'manual_intervention', reason: 'unknown' })
    expect(clickConsent).toHaveBeenCalledTimes(3)
    expect(waitForTransition).toHaveBeenCalledTimes(3)
  })

  it('adopts the navigation when the user click wins the race with the automatic consent click', async () => {
    const html = await consentHtml()
    const clickConsent = vi.fn(async () => false)
    const waitForTransition = vi.fn(async () => ({ kind: 'submitted' as const }))
    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition,
        readCurrentHtml: async () => '<main>unused</main>',
      }),
    ).resolves.toEqual({ kind: 'submitted' })
    expect(clickConsent).toHaveBeenCalledOnce()
    expect(waitForTransition).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'manual_intervention' as const, reason: 'challenge' as const },
    { kind: 'manual_intervention' as const, reason: 'unknown' as const },
  ])('does not click a security or unknown page: $reason', async (classification) => {
    const clickConsent = vi.fn(async () => true)
    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classification,
        clickConsent,
        waitForTransition: async () => ({ kind: 'submitted' }),
        readCurrentHtml: async () => '<main>unused</main>',
      }),
    ).resolves.toEqual(classification)
    expect(clickConsent).not.toHaveBeenCalled()
  })

  it('does not click or retry an OpenAI provider error page', async () => {
    const clickConsent = vi.fn(async () => true)
    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => ({ kind: 'manual_intervention', reason: 'provider_error' }),
        clickConsent,
        waitForTransition: async () => ({ kind: 'submitted' }),
        readCurrentHtml: async () => '<main>unused</main>',
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_ERROR' })
    expect(clickConsent).not.toHaveBeenCalled()
  })

  it.each([
    {
      html: '<main><h1>Verify you are human</h1></main>',
      expected: { kind: 'manual_intervention' as const, reason: 'challenge' as const },
    },
    {
      html: '<main><h1>Redirecting</h1></main>',
      expected: { kind: 'manual_intervention' as const, reason: 'unknown' as const },
    },
  ])('does not retry after the first click reaches a different page', async ({ html: nextHtml, expected }) => {
    const html = await consentHtml()
    const clickConsent = vi.fn(async () => true)
    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition: async () => null,
        readCurrentHtml: async () => nextHtml,
      }),
    ).resolves.toEqual(expected)
    expect(clickConsent).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the provider error appears after the first click', async () => {
    const html = await consentHtml()
    const clickConsent = vi.fn(async () => true)
    await expect(
      submitConsentWithRetry({
        callbackSettled: () => false,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition: async () => null,
        readCurrentHtml: async () => '<main><h1>糟糕，出错了！</h1></main>',
      }),
    ).rejects.toMatchObject({ code: 'OAUTH_PROVIDER_ERROR' })
    expect(clickConsent).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2])('accepts a callback captured after consent click %s', async (callbackAttempt) => {
    const html = await consentHtml()
    let settled = false
    let attempt = 0
    const clickConsent = vi.fn(async () => true)
    const waitForTransition = vi.fn(async () => {
      attempt += 1
      if (attempt === callbackAttempt) settled = true
      return null
    })

    await expect(
      submitConsentWithRetry({
        callbackSettled: () => settled,
        classifyUntilConsent: async () => classifyPageHtml(html),
        clickConsent,
        waitForTransition,
        readCurrentHtml: async () => html,
      }),
    ).resolves.toEqual({ kind: 'submitted' })
    expect(clickConsent).toHaveBeenCalledTimes(callbackAttempt)
  })
})
