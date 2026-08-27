import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright'
import { AppError } from '../../shared/errors'
import {
  CallbackCapture,
  deriveOAuthNavigationContract,
  describeOAuthRedirect,
  describeOAuthUrl,
} from './callback-capture'
import {
  classifyPageHtml,
  ONE_TIME_CODE_LOGIN_CONTROL_NAME,
  OTP_RESEND_CONTROL_NAME,
} from './page-classifier'
import type {
  AuthenticatorSubmissionResult,
  AutomatedPageKind,
  BrowserActionResult,
  OAuthBrowserDriver,
  OAuthBrowserSession,
  OAuthCallbackResult,
  OtpResendResult,
  PageClassification,
  PasswordSubmissionOptions,
  StartBrowserInput,
} from './types'

function cancelledError(): AppError {
  return new AppError('TASK_CANCELLED', '任务已取消。', { statusCode: 409 })
}

type SubmittablePageClassification = Extract<PageClassification, { submitSelector: string }>
type ConsentPageClassification = Extract<PageClassification, { kind: 'consent' }>

export type KnownPageRecoveryResult =
  | BrowserActionResult
  | { kind: 'retry_current_page' }
  | { kind: 'otp_login_choice' }

export interface KnownPageRecoveryOperations {
  callbackSettled: () => boolean
  pageClosed: () => boolean
  readCurrentHtml: () => Promise<string>
  waitBeforeRetry: () => Promise<void>
}

export interface ConsentSubmissionOperations {
  callbackSettled: () => boolean
  classifyUntilConsent: () => Promise<PageClassification>
  clickConsent: (classification: ConsentPageClassification) => Promise<boolean>
  waitForTransition: () => Promise<BrowserActionResult | null>
  readCurrentHtml: () => Promise<string>
}

export interface OtpResendOperations {
  callbackSettled: () => boolean
  classifyOtpPage: () => Promise<PageClassification>
  beforeOtpRequest?: () => Promise<void>
  clickResend: () => Promise<boolean>
}

const CONTINUE_BUTTON_NAME = /^(?:继续|Continue)$/i
const SUBMISSION_TRANSITION_TIMEOUT_MS = 8_000
const SUBMISSION_TRANSITION_STABLE_MS = 750
const AUTOMATION_RECONCILIATION_ATTEMPTS = 12
const FORM_SUBMISSION_ATTEMPTS = 2
const CONSENT_SUBMISSION_ATTEMPTS = 3
const OTP_RESEND_ATTEMPTS = 2
const OTP_RESEND_CLASSIFICATION_TIMEOUT_MS = 3_000
const NATIVE_CHROME_DEBUG_TIMEOUT_MS = 15_000
const INITIAL_NAVIGATION_CAPTURE_TIMEOUT_MS = 2_000
const BROWSER_PROXY_CONNECT_TIMEOUT_MS = 3_000
const MANUAL_PROGRESS_POLL_INTERVAL_MS = 500
const NATIVE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const NATIVE_CHROME_APP_PATH = '/Applications/Google Chrome.app'
const CHROME_BUNDLE_ID = 'com.google.Chrome'
const FOREGROUND_RESTORE_INTERVAL_MS = 50
const FOREGROUND_RESTORE_WINDOW_MS = 15_000

interface ForegroundApplicationSnapshot {
  processId: number
  bundleId: string
}

function runJxa(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: 2_000, maxBuffer: 4_096 },
      (error, stdout) => resolve(error ? '' : String(stdout).trim()),
    )
  })
}

async function captureForegroundApplication(): Promise<ForegroundApplicationSnapshot | null> {
  const output = await runJxa(`
    ObjC.import('AppKit')
    const app = $.NSWorkspace.sharedWorkspace.frontmostApplication
    app ? JSON.stringify({
      processId: Number(app.processIdentifier),
      bundleId: ObjC.unwrap(app.bundleIdentifier) || ''
    }) : ''
  `)
  if (!output) return null
  try {
    const value = JSON.parse(output) as Partial<ForegroundApplicationSnapshot>
    if (!Number.isInteger(value.processId) || Number(value.processId) < 1 || typeof value.bundleId !== 'string') return null
    return { processId:Number(value.processId), bundleId:value.bundleId }
  } catch {
    return null
  }
}

async function restoreForegroundApplication(
  snapshot: ForegroundApplicationSnapshot | null,
  oauthChromeProcessId: number | null,
): Promise<void> {
  if (!snapshot) return
  await runJxa(`
    ObjC.import('AppKit')
    const workspace = $.NSWorkspace.sharedWorkspace
    const current = workspace.frontmostApplication
    const currentProcessId = current ? Number(current.processIdentifier) : 0
    const currentBundleId = current ? (ObjC.unwrap(current.bundleIdentifier) || '') : ''
    const oauthProcessId = ${oauthChromeProcessId ?? 0}
    const oauthChromeTookFocus = oauthProcessId > 0
      ? currentProcessId === oauthProcessId
      : currentProcessId !== ${snapshot.processId} && currentBundleId === ${JSON.stringify(CHROME_BUNDLE_ID)}
    if (oauthChromeTookFocus) {
      const target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${snapshot.processId})
      if (target && (ObjC.unwrap(target.bundleIdentifier) || '') === ${JSON.stringify(snapshot.bundleId)}) {
        target.activateWithOptions($.NSApplicationActivateIgnoringOtherApps)
      }
    }
  `)
}

function keepOAuthChromeInBackground(
  snapshot: ForegroundApplicationSnapshot | null,
): { setProcessId: (processId: number | null) => void; stop: () => void } {
  if (!snapshot) return { setProcessId: () => undefined, stop: () => undefined }
  let stopped = false
  let restoring = false
  let processResolved = false
  let oauthChromeProcessId: number | null = null
  const restore = () => {
    if (stopped || restoring || (processResolved && !oauthChromeProcessId)) return
    restoring = true
    void restoreForegroundApplication(snapshot, oauthChromeProcessId).finally(() => {
      restoring = false
    })
  }
  const interval = setInterval(restore, FOREGROUND_RESTORE_INTERVAL_MS)
  const timeout = setTimeout(() => {
    stopped = true
    clearInterval(interval)
  }, FOREGROUND_RESTORE_WINDOW_MS)
  interval.unref()
  timeout.unref()
  restore()
  return {
    setProcessId: (processId) => {
      processResolved = true
      oauthChromeProcessId = processId
    },
    stop: () => {
      stopped = true
      clearInterval(interval)
      clearTimeout(timeout)
    },
  }
}

export function recoverBrowserAutomationFailure(
  error: unknown,
  callbackSettled: boolean,
  pageClosed: boolean,
): BrowserActionResult {
  if (callbackSettled) return { kind: 'submitted' }
  if (error instanceof AppError) throw error
  if (pageClosed) throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
  return { kind: 'manual_intervention', reason: 'unknown' }
}

export function shouldResumeAfterManualProgress(
  classification: PageClassification,
  input: {
    blockedPage: AutomatedPageKind
    preferredLogin: 'email_otp' | 'password'
    requireActivityOnBlockedPage: boolean
    pageChanged: boolean
    userActivity: boolean
  },
): boolean {
  if (classification.kind === 'callback_captured') return true
  if (classification.kind === 'manual_intervention' || classification.kind === 'account_deactivated') return false

  const supported =
    classification.kind === 'email' ||
    classification.kind === 'consent' ||
    (input.preferredLogin === 'email_otp' &&
      (classification.kind === 'email_otp' ||
        (classification.kind === 'password' && classification.hasOneTimeCodeLoginChoice))) ||
    (input.preferredLogin === 'password' &&
      (classification.kind === 'password' || classification.kind === 'authenticator_totp'))
  if (!supported) return false
  if (classification.kind !== input.blockedPage) return true
  return !input.requireActivityOnBlockedPage || input.pageChanged || input.userActivity
}

interface NavigationRequestLike {
  isNavigationRequest(): boolean
  url(): string
  frame(): { page(): { mainFrame(): unknown } }
}

export function mainFrameNavigationUrl(request: NavigationRequestLike): string | null {
  if (!request.isNavigationRequest()) return null
  try {
    const frame = request.frame()
    return frame === frame.page().mainFrame() ? request.url() : null
  } catch {
    return null
  }
}

export function hasManualPageChanged(input: {
  samePage: boolean
  initialIdentity: string
  currentIdentity: string
  initialNavigationCount: number
  currentNavigationCount: number
}): boolean {
  return (
    !input.samePage ||
    input.currentIdentity !== input.initialIdentity ||
    input.currentNavigationCount !== input.initialNavigationCount
  )
}

function navigationMismatch(): AppError {
  return new AppError(
    'OAUTH_AUTH_URL_NAVIGATION_MISMATCH',
    '完整授权参数未能传入 Chrome，已停止本次任务，请重新生成后再试。',
    { statusCode: 502, retryable: true },
  )
}

function providerError(): AppError {
  return new AppError(
    'OAUTH_PROVIDER_ERROR',
    'OpenAI 授权页面显示“糟糕，出错了”。已停止验证码轮询；请在本地工具中核对完整授权链接后重新生成。',
    { statusCode: 502, retryable: true },
  )
}

function credentialsRejected(): AppError {
  return new AppError(
    'OPENAI_CREDENTIALS_REJECTED',
    'OpenAI 未接受当前账号密码或验证码，请确认登录材料有效后重新开始。',
    { statusCode: 422 },
  )
}

function accountDeactivated(): AppError {
  return new AppError(
    'OPENAI_ACCOUNT_DEACTIVATED',
    'OpenAI 明确返回 account_deactivated。',
    { statusCode: 422 },
  )
}

function phoneVerificationRequired(): AppError {
  return new AppError(
    'OPENAI_PHONE_VERIFICATION_REQUIRED',
    'OpenAI 要求通过手机号码接码验证，已停止自动授权。',
    { statusCode: 422 },
  )
}

function rejectProviderError(classification: PageClassification): void {
  if (classification.kind === 'account_deactivated') throw accountDeactivated()
  if (classification.kind === 'phone_verification') throw phoneVerificationRequired()
  if (classification.kind === 'manual_intervention') {
    if (classification.reason === 'provider_error') throw providerError()
    if (classification.reason === 'credentials') throw credentialsRejected()
  }
}

function queryEntries(value: URL): Map<string, number> {
  const entries = new Map<string, number>()
  for (const [name, parameterValue] of value.searchParams) {
    const key = `${name}\u0000${parameterValue}`
    entries.set(key, (entries.get(key) ?? 0) + 1)
  }
  return entries
}

export function assertAuthorizationNavigation(expectedValue: string, actualValue: string): void {
  let expected: URL
  let actual: URL
  try {
    expected = new URL(expectedValue)
    actual = new URL(actualValue)
  } catch {
    throw navigationMismatch()
  }

  const expectedEntries = queryEntries(expected)
  const actualEntries = queryEntries(actual)
  if (
    expected.protocol !== actual.protocol ||
    expected.username !== actual.username ||
    expected.password !== actual.password ||
    expected.hostname.toLowerCase() !== actual.hostname.toLowerCase() ||
    expected.port !== actual.port ||
    expected.pathname !== actual.pathname ||
    expected.hash !== actual.hash ||
    expectedEntries.size !== actualEntries.size ||
    [...expectedEntries].some(([key, count]) => actualEntries.get(key) !== count)
  ) {
    throw navigationMismatch()
  }
}

function browserNavigationFailed(cause?: unknown): AppError {
  return new AppError('BROWSER_NAVIGATION_FAILED', '无痕浏览器已启动，但无法打开 OpenAI 授权地址。', {
    statusCode: 502,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  })
}

function browserProxyConnectionFailed(): AppError {
  return new AppError(
    'BROWSER_PROXY_CONNECTION_FAILED',
    '本次任务代理无法从这台 Mac 建立连接，请检查代理可用性后重试。',
    { statusCode: 502, retryable: true },
  )
}

function isBrowserProxyNavigationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /\b(?:net::)?ERR_(?:PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)\b/i.test(
    error.message,
  )
}

export interface BrowserProxyEndpoint {
  hostname: string
  port: number
}

export type BrowserProxyProbe = (endpoint: BrowserProxyEndpoint, signal?: AbortSignal) => Promise<void>

async function probeBrowserProxyEndpoint(endpoint: BrowserProxyEndpoint, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: endpoint.hostname, port: endpoint.port })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(cancelledError())
    socket.setTimeout(BROWSER_PROXY_CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish())
    socket.once('timeout', () => finish(new Error('Proxy connection timed out')))
    socket.once('error', (error) => finish(error))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function verifyBrowserProxyReachability(
  browserProxy: StartBrowserInput['browserProxy'],
  signal?: AbortSignal,
  probe: BrowserProxyProbe = probeBrowserProxyEndpoint,
): Promise<void> {
  if (!browserProxy) return
  if (signal?.aborted) throw cancelledError()
  let endpoint: BrowserProxyEndpoint
  try {
    const parsed = new URL(browserProxy.server)
    const defaultPort = parsed.protocol === 'https:' ? 443 : parsed.protocol === 'socks5:' ? 1080 : 80
    endpoint = {
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: Number(parsed.port || defaultPort),
    }
  } catch {
    throw new AppError('PROXY_CONFIG_INVALID', '所选代理的连接地址无效。')
  }
  try {
    await probe(endpoint, signal)
  } catch (error) {
    if (signal?.aborted || (error instanceof AppError && error.code === 'TASK_CANCELLED')) throw cancelledError()
    throw browserProxyConnectionFailed()
  }
}

export async function verifyInitialAuthorizationNavigation(
  expectedValue: string,
  initialNavigationRequest: Promise<string | null>,
  navigate: () => Promise<unknown>,
  browserProxyConfigured = false,
): Promise<string> {
  let navigationError: unknown
  try {
    await navigate()
  } catch (error) {
    navigationError = error
  }

  const actualInitialNavigation = await initialNavigationRequest
  if (!actualInitialNavigation) {
    if (browserProxyConfigured && isBrowserProxyNavigationFailure(navigationError)) {
      throw browserProxyConnectionFailed()
    }
    throw browserNavigationFailed(navigationError)
  }
  assertAuthorizationNavigation(expectedValue, actualInitialNavigation)
  if (browserProxyConfigured && isBrowserProxyNavigationFailure(navigationError)) {
    throw browserProxyConnectionFailed()
  }
  return actualInitialNavigation
}

export function classifySubmissionTransition(
  expected: AutomatedPageKind,
  html: string,
  preferredLogin: 'email_otp' | 'password' = 'email_otp',
  pageUrl?: string,
  allowCredentialsErrorPage = false,
): BrowserActionResult | { kind: 'otp_login_choice' } | null {
  const classification = classifyPageHtml(html, { pageUrl, allowCredentialsErrorPage })
  rejectProviderError(classification)
  if (classification.kind === 'phone_verification') throw phoneVerificationRequired()
  if (classification.kind === expected) return null
  if (classification.kind === 'password') {
    if (expected === 'email' && preferredLogin === 'password') return { kind: 'submitted' }
    if (expected === 'email' && classification.hasOneTimeCodeLoginChoice) {
      return { kind: 'otp_login_choice' }
    }
    return { kind: 'manual_intervention', reason: 'password' }
  }
  if (classification.kind === 'email_otp') {
    return expected === 'email'
      ? { kind: 'submitted' }
      : { kind: 'manual_intervention', reason: 'email_otp' }
  }
  if (classification.kind === 'authenticator_totp') {
    return expected === 'password' || (expected === 'email' && preferredLogin === 'password')
      ? { kind: 'submitted' }
      : { kind: 'manual_intervention', reason: 'mfa' }
  }
  if (classification.kind === 'consent') return { kind: 'submitted' }
  if (classification.kind === 'callback_captured') return { kind: 'submitted' }
  if (classification.kind === 'email') return { kind: 'manual_intervention', reason: 'unknown' }
  if (classification.kind === 'account_deactivated') throw accountDeactivated()
  return classification
}

export async function reconcileKnownPageAutomationFailure(
  error: unknown,
  expected: AutomatedPageKind,
  preferredLogin: 'email_otp' | 'password',
  operations: KnownPageRecoveryOperations,
): Promise<KnownPageRecoveryResult> {
  if (operations.callbackSettled()) return { kind: 'submitted' }
  if (error instanceof AppError) throw error
  if (operations.pageClosed()) {
    throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
  }

  for (let attempt = 0; attempt < AUTOMATION_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (operations.callbackSettled()) return { kind: 'submitted' }
    if (operations.pageClosed()) {
      throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
    }
    try {
      const transition = classifySubmissionTransition(
        expected,
        await operations.readCurrentHtml(),
        preferredLogin,
      )
      if (transition === null) return { kind: 'retry_current_page' }
      if (transition.kind !== 'manual_intervention' || transition.reason !== 'unknown') return transition
    } catch (reconciliationError) {
      if (reconciliationError instanceof AppError) throw reconciliationError
      if (operations.callbackSettled()) return { kind: 'submitted' }
      if (operations.pageClosed()) {
        throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: reconciliationError })
      }
    }
    if (attempt < AUTOMATION_RECONCILIATION_ATTEMPTS - 1) {
      try {
        await operations.waitBeforeRetry()
      } catch (waitError) {
        if (operations.callbackSettled()) return { kind: 'submitted' }
        if (operations.pageClosed()) {
          throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: waitError })
        }
      }
    }
  }

  return { kind: 'manual_intervention', reason: 'unknown' }
}

export async function submitConsentWithRetry(
  operations: ConsentSubmissionOperations,
): Promise<BrowserActionResult> {
  if (operations.callbackSettled()) return { kind: 'submitted' }

  let classification = await operations.classifyUntilConsent()
  if (operations.callbackSettled()) return { kind: 'submitted' }
  rejectProviderError(classification)
  if (classification.kind === 'manual_intervention') return classification
  if (classification.kind === 'callback_captured') return { kind: 'submitted' }
  if (classification.kind !== 'consent') return { kind: 'manual_intervention', reason: 'unknown' }

  for (let attempt = 0; attempt < CONSENT_SUBMISSION_ATTEMPTS; attempt += 1) {
    const clicked = await operations.clickConsent(classification)
    if (operations.callbackSettled()) return { kind: 'submitted' }

    const transition = await operations.waitForTransition()
    if (transition) return transition
    if (operations.callbackSettled()) return { kind: 'submitted' }

    const html = await operations.readCurrentHtml()
    if (operations.callbackSettled()) return { kind: 'submitted' }
    const retryTransition = classifySubmissionTransition('consent', html)
    if (retryTransition?.kind === 'otp_login_choice') {
      return { kind: 'manual_intervention', reason: 'password' }
    }
    if (retryTransition) return retryTransition

    const retryClassification = classifyPageHtml(html)
    if (retryClassification.kind !== 'consent') {
      return { kind: 'manual_intervention', reason: 'unknown' }
    }
    classification = retryClassification
    if (!clicked && attempt === CONSENT_SUBMISSION_ATTEMPTS - 1) break
  }

  return { kind: 'manual_intervention', reason: 'unknown' }
}

export async function resendOtpOnce(operations: OtpResendOperations): Promise<OtpResendResult> {
  if (operations.callbackSettled()) return { kind: 'callback_captured' }

  const classification = await operations.classifyOtpPage()
  if (operations.callbackSettled()) return { kind: 'callback_captured' }
  rejectProviderError(classification)
  if (classification.kind === 'manual_intervention') return classification
  if (classification.kind === 'callback_captured') return { kind: 'callback_captured' }
  if (classification.kind === 'consent') return { kind: 'consent_ready' }
  if (classification.kind !== 'email_otp') return { kind: 'manual_intervention', reason: 'unknown' }

  await operations.beforeOtpRequest?.()
  if (operations.callbackSettled()) return { kind: 'callback_captured' }
  if (await operations.clickResend()) return { kind: 'submitted' }
  if (operations.callbackSettled()) return { kind: 'callback_captured' }

  const retryClassification = await operations.classifyOtpPage()
  if (operations.callbackSettled()) return { kind: 'callback_captured' }
  rejectProviderError(retryClassification)
  if (retryClassification.kind === 'manual_intervention') return retryClassification
  if (retryClassification.kind === 'consent') return { kind: 'consent_ready' }
  if (retryClassification.kind === 'email_otp') return { kind: 'continue_polling' }
  return { kind: 'manual_intervention', reason: 'unknown' }
}

export function oauthBrowserLaunchOptions(browserProxy?: StartBrowserInput['browserProxy']) {
  return {
    headless: false,
    channel: 'chrome' as const,
    chromiumSandbox: true,
    args: ['--incognito'],
    acceptDownloads: false,
    ...(browserProxy ? { proxy: browserProxy } : {}),
  }
}

export function nativeChromeLaunchArgs(
  userDataDir: string,
  debugPort: number,
  browserProxy?: StartBrowserInput['browserProxy'],
): string[] {
  const proxyArgs: string[] = []
  if (browserProxy) {
    const proxyUrl = new URL(browserProxy.server)
    if (proxyUrl.protocol === 'socks5:') {
      proxyArgs.push(`--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE ${proxyUrl.hostname}"`)
    }
    proxyArgs.push(`--proxy-server=${browserProxy.server}`)
  }
  return [
    '--incognito',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...proxyArgs,
    'about:blank',
  ]
}

interface NativeChromeProcess {
  launcher: ChildProcess
  processId: number | null
}

function spawnBackgroundChrome(args: string[]): NativeChromeProcess {
  // Launch Services honors -g before Chrome creates its first window. The unique
  // profile and debugging port are used below to resolve the real Chrome PID.
  const launcher = spawn('/usr/bin/open', ['-g', '-n', '-W', '-a', NATIVE_CHROME_APP_PATH, '--args', ...args], {
    stdio: 'ignore',
    detached: true,
  })
  return { launcher, processId: null }
}

function readProcessList(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,command='], { timeout: 2_000, maxBuffer: 2_000_000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout))
    })
  })
}

export function findOwnedChromeProcessId(processList: string, userDataDir: string, debugPort: number): number | null {
  const profileArgument = `--user-data-dir=${userDataDir}`
  const portArgument = `--remote-debugging-port=${debugPort}`
  for (const line of processList.split('\n')) {
    if (!line.includes(NATIVE_CHROME_PATH) || !line.includes(profileArgument) || !line.includes(portArgument)) continue
    const match = line.match(/^\s*(\d+)\s+/)
    const processId = match ? Number(match[1]) : 0
    if (Number.isInteger(processId) && processId > 0) return processId
  }
  return null
}

async function resolveOwnedChromeProcessId(userDataDir: string, debugPort: number): Promise<number | null> {
  return findOwnedChromeProcessId(await readProcessList(), userDataDir, debugPort)
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a Chrome debugging port')
  return address.port
}

async function waitForChromeDebugEndpoint(port: number, signal?: AbortSignal): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + NATIVE_CHROME_DEBUG_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw cancelledError()
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(750) })
      if (response.ok) return endpoint
    } catch {
      // Chrome needs a short startup window before its local DevTools endpoint is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new AppError('BROWSER_START_FAILED', '本机 Chrome 无痕浏览器未能在规定时间内启动。', {
    statusCode: 502,
    retryable: true,
  })
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    once(child, 'exit').then(() => undefined).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function signalChromeProcess(child: NativeChromeProcess, signal: NodeJS.Signals): void {
  if (child.processId) {
    try {
      process.kill(child.processId, signal)
      return
    } catch {
      // The task-owned Chrome instance may already have exited.
    }
  }
  try {
    if (child.launcher.exitCode === null) child.launcher.kill(signal)
  } catch {
    // Cleanup is best effort after the browser has already gone away.
  }
}

async function waitForNativeChromeExit(child: NativeChromeProcess, timeoutMs: number): Promise<void> {
  if (child.processId) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && isProcessRunning(child.processId)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return
  }
  await waitForChildExit(child.launcher, timeoutMs)
}

export async function closeNativeChrome(browser: Browser | undefined, child: NativeChromeProcess | undefined): Promise<void> {
  await browser?.close().catch(() => undefined)
  if (!child) return
  if (child.processId ? !isProcessRunning(child.processId) : child.launcher.exitCode !== null) return
  signalChromeProcess(child, 'SIGTERM')
  await waitForNativeChromeExit(child, 2_000)
  if (child.processId ? isProcessRunning(child.processId) : child.launcher.exitCode === null) {
    signalChromeProcess(child, 'SIGKILL')
    await waitForNativeChromeExit(child, 1_000)
  }
}

class PlaywrightOAuthSession implements OAuthBrowserSession {
  readonly #capture: CallbackCapture
  readonly #callbackPromise: Promise<OAuthCallbackResult>
  #resolveCallback!: (value: OAuthCallbackResult) => void
  #rejectCallback!: (error: unknown) => void
  #callbackSettled = false
  #closed = false
  #otpResendAttempts = 0
  #mainFrameNavigationCounts = new WeakMap<Page, number>()
  private page: Page

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    capture: CallbackCapture,
    private readonly closeBrowser: () => Promise<void>,
    private readonly removeUserDataDir: () => Promise<void>,
  ) {
    this.page = page
    this.#capture = capture
    this.#callbackPromise = new Promise((resolve, reject) => {
      this.#resolveCallback = resolve
      this.#rejectCallback = reject
    })
    // The browser can close before the orchestrator reaches waitForCallback().
    // Mark the deferred rejection as handled while preserving it for later awaiters.
    void this.#callbackPromise.catch(() => undefined)
    this.observePage(page)
    context.on('page', (openedPage) => {
      this.observePage(openedPage)
      this.page = openedPage
    })
    context.on('request', (request) => {
      const navigationUrl = mainFrameNavigationUrl(request)
      if (navigationUrl) this.inspectNavigation(navigationUrl)
    })
  }

  async bringToFront(): Promise<void> {
    await this.currentPage().bringToFront()
  }

  async submitEmail(
    email: string,
    preferredLogin: 'email_otp' | 'password',
    beforeOtpRequest?: () => Promise<void>,
  ): Promise<BrowserActionResult> {
    return this.fillKnownPage('email', email, beforeOtpRequest, preferredLogin)
  }

  async submitPassword(password: string, options: PasswordSubmissionOptions = {}): Promise<BrowserActionResult> {
    void options
    return this.fillKnownPage(
      'password',
      password,
      undefined,
      'password',
      // OpenAI can render its generic credential error on the fresh password
      // form. Allow the first fill to proceed; post-submit classification still
      // detects the error and lets the orchestrator swap the materials.
      true,
    )
  }

  async resendOtp(beforeOtpRequest?: () => Promise<void>): Promise<OtpResendResult> {
    if (this.#otpResendAttempts >= OTP_RESEND_ATTEMPTS) {
      return { kind: 'manual_intervention', reason: 'unknown' }
    }
    this.#otpResendAttempts += 1
    try {
      return await resendOtpOnce({
        callbackSettled: () => this.#callbackSettled,
        classifyOtpPage: () => this.classifyOtpResendPage(),
        ...(beforeOtpRequest ? { beforeOtpRequest } : {}),
        clickResend: async () => {
          const control = await this.findUniqueResendControl()
          if (!control) return false
          try {
            await control.click({ timeout: 10_000 })
            return true
          } catch (error) {
            if (this.#callbackSettled) return true
            if (this.page.isClosed()) {
              throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
            }
            return false
          }
        },
      })
    } catch (error) {
      const recovered = await reconcileKnownPageAutomationFailure(error, 'email_otp', 'email_otp', {
        callbackSettled: () => this.#callbackSettled,
        pageClosed: () => this.page.isClosed(),
        readCurrentHtml: () => this.page.content(),
        waitBeforeRetry: () => this.page.waitForTimeout(250),
      })
      if (this.#callbackSettled) return { kind: 'callback_captured' }
      if (recovered.kind === 'retry_current_page') return { kind: 'continue_polling' }
      if (recovered.kind === 'otp_login_choice') {
        return { kind: 'manual_intervention', reason: 'password' }
      }
      if (recovered.kind !== 'submitted') return recovered

      const current = await this.classifyOtpResendPage()
      if (this.#callbackSettled || current.kind === 'callback_captured') return { kind: 'callback_captured' }
      if (current.kind === 'consent') return { kind: 'consent_ready' }
      if (current.kind === 'email_otp') return { kind: 'continue_polling' }
      if (current.kind === 'manual_intervention') return current
      return { kind: 'manual_intervention', reason: 'unknown' }
    }
  }

  async submitEmailOtp(code: string): Promise<BrowserActionResult> {
    if (!/^\d{6}$/.test(code)) throw new AppError('OTP_INVALID', '验证码必须是六位数字。')
    return this.fillKnownPage('email_otp', code)
  }

  async submitAuthenticatorTotp(code: string): Promise<AuthenticatorSubmissionResult> {
    if (!/^\d{6}$/.test(code)) throw new AppError('OTP_INVALID', '2FA 动态码必须是六位数字。')
    for (let attempt = 0; attempt < FORM_SUBMISSION_ATTEMPTS; attempt += 1) {
      let submissionAttempted = false
      try {
        const classification = await this.classifyUntil('authenticator_totp')
        if (this.#callbackSettled) return { kind: 'submitted' as const }
        if (classification.kind === 'manual_intervention') return classification
        if (classification.kind !== 'authenticator_totp') {
          const transition = await this.waitForSubmissionTransition('authenticator_totp')
          if (transition) return transition
          continue
        }

        const originalPage = this.pageIdentity()
        const input = this.page.locator(classification.inputSelector).first()
        await input.waitFor({ state: 'visible', timeout: 10_000 })
        if (!(await input.isEnabled())) throw new Error('Authenticator input is not enabled')
        await input.fill(code)
        if ((await input.inputValue()) !== code) throw new Error('Authenticator input value changed')
        const submit = await this.findSubmitControl(classification)
        if (!submit) throw new Error('Authenticator submit control is unavailable')
        submissionAttempted = true
        await submit.click({ timeout: 10_000 })

        const transition = await this.waitForSubmissionTransition('authenticator_totp')
        if (transition) return transition
        const current = classifyPageHtml(await this.page.content(), { pageUrl: this.page.url() })
        rejectProviderError(current)
        if (current.kind === 'authenticator_totp' && this.pageIdentity() === originalPage) {
          return { kind: 'still_active' as const }
        }
      } catch (error) {
        const recovered = await this.reconcileKnownPageFailure(error, 'authenticator_totp', 'password')
        if (recovered) return recovered
        if (submissionAttempted) return { kind: 'still_active' as const }
      }
    }
    return { kind: 'manual_intervention', reason: 'unknown' }
  }

  async classifyCurrentPage(): Promise<PageClassification> {
    const deadline = Date.now() + SUBMISSION_TRANSITION_TIMEOUT_MS
    let latest: PageClassification = { kind: 'manual_intervention', reason: 'unknown' }
    while (Date.now() < deadline) {
      if (this.#callbackSettled) return { kind: 'callback_captured' }
      try {
        latest = classifyPageHtml(await this.page.content(), { pageUrl: this.page.url() })
        rejectProviderError(latest)
        if (latest.kind !== 'manual_intervention' || latest.reason !== 'unknown') return latest
      } catch (error) {
        if (error instanceof AppError) throw error
        if (this.page.isClosed()) throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
      }
      await this.page.waitForTimeout(250)
    }
    return latest
  }

  async waitForManualProgress(input: {
    blockedPage: AutomatedPageKind
    preferredLogin: 'email_otp' | 'password'
    requireActivityOnBlockedPage: boolean
    signal?: AbortSignal
  }): Promise<PageClassification> {
    if (input.signal?.aborted) throw cancelledError()
    const initialPage = this.page
    const initialIdentity = this.pageIdentity(initialPage)
    const initialNavigationCount = this.mainFrameNavigationCount(initialPage)
    let trackedPage = initialPage
    await this.armManualActivityTracking(trackedPage)
    try {
      while (true) {
        if (input.signal?.aborted) throw cancelledError()
        if (this.#callbackSettled) return { kind: 'callback_captured' }
        const currentPage = this.currentPage()
        if (currentPage.isClosed()) throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。')
        if (currentPage !== trackedPage) {
          await this.clearManualActivityTracking(trackedPage).catch(() => undefined)
          trackedPage = currentPage
          await this.armManualActivityTracking(trackedPage).catch(() => undefined)
        }

        let classification: PageClassification
        try {
          classification = classifyPageHtml(await currentPage.content(), { pageUrl: currentPage.url() })
          rejectProviderError(classification)
        } catch (error) {
          if (error instanceof AppError) throw error
          if (this.#callbackSettled) return { kind: 'callback_captured' }
          if (currentPage.isClosed() && this.currentPage().isClosed()) {
            throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
          }
          await this.waitForManualPoll()
          continue
        }

        let activityCount = await this.readManualActivityCount(currentPage).catch(() => null)
        if (activityCount === null && !currentPage.isClosed()) {
          await this.armManualActivityTracking(currentPage).catch(() => undefined)
          activityCount = 0
        }
        if (
          shouldResumeAfterManualProgress(classification, {
            blockedPage: input.blockedPage,
            preferredLogin: input.preferredLogin,
            requireActivityOnBlockedPage: input.requireActivityOnBlockedPage,
            pageChanged: hasManualPageChanged({
              samePage: currentPage === initialPage,
              initialIdentity,
              currentIdentity: this.pageIdentity(currentPage),
              initialNavigationCount,
              currentNavigationCount: this.mainFrameNavigationCount(currentPage),
            }),
            userActivity: (activityCount ?? 0) > 0,
          })
        ) {
          return classification
        }
        await this.waitForManualPoll()
      }
    } finally {
      await this.clearManualActivityTracking(trackedPage).catch(() => undefined)
    }
  }

  async submitConsent(): Promise<BrowserActionResult> {
    for (let attempt = 0; attempt < FORM_SUBMISSION_ATTEMPTS; attempt += 1) {
      try {
        return await submitConsentWithRetry({
          callbackSettled: () => this.#callbackSettled,
          classifyUntilConsent: () => this.classifyUntil('consent'),
          clickConsent: async (classification) => {
            const submit = await this.findSubmitControl(classification)
            if (!submit) return false
            try {
              await submit.click({ timeout: 10_000 })
              return true
            } catch (error) {
              if (this.#callbackSettled) return true
              if (this.page.isClosed()) {
                throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
              }
              return false
            }
          },
          waitForTransition: () => this.waitForSubmissionTransition('consent'),
          readCurrentHtml: () => this.page.content(),
        })
      } catch (error) {
        const recovered = await this.reconcileKnownPageFailure(error, 'consent', 'email_otp')
        if (recovered) return recovered
      }
    }
    return { kind: 'manual_intervention', reason: 'unknown' }
  }

  async waitForCallback(signal?: AbortSignal): Promise<OAuthCallbackResult> {
    if (signal?.aborted) throw cancelledError()
    const monitorDeactivation = async (): Promise<never> => {
      while (!this.#callbackSettled && !this.page.isClosed()) {
        try {
          const classification = classifyPageHtml(await this.page.content(), { pageUrl: this.page.url() })
          if (classification.kind === 'account_deactivated') throw accountDeactivated()
        } catch (error) {
          if (error instanceof AppError) throw error
          if (this.page.isClosed()) break
        }
        await this.page.waitForTimeout(250)
      }
      return new Promise<never>(() => undefined)
    }
    const pending: Array<Promise<OAuthCallbackResult>> = [
      this.#callbackPromise,
      monitorDeactivation(),
    ]
    if (signal) {
      pending.push(
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(cancelledError()), { once: true })
        }),
      )
    }
    return Promise.race(pending)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (!this.#callbackSettled) {
      this.#callbackSettled = true
      this.#rejectCallback(new AppError('BROWSER_CLOSED', '授权浏览器已关闭。'))
    }
    await this.closeBrowser().catch(() => undefined)
    await this.removeUserDataDir().catch(() => undefined)
  }

  private inspectNavigation(value: string): void {
    if (this.#callbackSettled) return
    try {
      const result = this.#capture.accept(value)
      if (result.kind === 'accepted') {
        this.#callbackSettled = true
        this.#resolveCallback({ code: result.code, state: result.state })
      }
    } catch (error) {
      this.#callbackSettled = true
      this.#rejectCallback(error)
    }
  }

  private async classifyUntil(
    expected: AutomatedPageKind,
    options: { allowCredentialsErrorPage?: boolean } = {},
  ): Promise<PageClassification> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (this.#callbackSettled) return { kind: 'manual_intervention', reason: 'unknown' }
      let html: string
      try {
        html = await this.page.content()
      } catch (error) {
        if (this.#callbackSettled) return { kind: 'manual_intervention', reason: 'unknown' }
        throw error
      }
      const classification = classifyPageHtml(html, { ...options, pageUrl: this.page.url() })
      rejectProviderError(classification)
      if (this.#callbackSettled) return { kind: 'callback_captured' }
      if (classification.kind === expected) return classification
      if (classification.kind !== 'manual_intervention' || classification.reason !== 'unknown') return classification
      await this.page.waitForTimeout(250)
    }
    return { kind: 'manual_intervention', reason: 'unknown' }
  }

  private async classifyOtpResendPage(): Promise<PageClassification> {
    const deadline = Date.now() + OTP_RESEND_CLASSIFICATION_TIMEOUT_MS
    let latest: PageClassification = { kind: 'manual_intervention', reason: 'unknown' }
    while (Date.now() < deadline) {
      if (this.#callbackSettled) return latest
      latest = classifyPageHtml(await this.page.content(), { pageUrl: this.page.url() })
      rejectProviderError(latest)
      if (
        latest.kind === 'email_otp' ||
        latest.kind === 'consent' ||
        (latest.kind === 'manual_intervention' && latest.reason !== 'unknown')
      ) {
        return latest
      }
      await this.page.waitForTimeout(100)
    }
    return latest
  }

  private async firstVisibleEnabled(locator: Locator): Promise<Locator | null> {
    const count = Math.min(await locator.count(), 10)
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if ((await candidate.isVisible()) && (await candidate.isEnabled())) return candidate
    }
    return null
  }

  private async findUniqueResendControl(): Promise<Locator | null> {
    const matches: Locator[] = []
    for (const locator of [
      this.page.getByRole('button', { name: OTP_RESEND_CONTROL_NAME }),
      this.page.getByRole('link', { name: OTP_RESEND_CONTROL_NAME }),
    ]) {
      const count = Math.min(await locator.count(), 10)
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index)
        if (await candidate.isVisible()) matches.push(candidate)
      }
    }
    if (matches.length !== 1 || !(await matches[0]!.isEnabled())) return null
    return matches[0]!
  }

  private async findSubmitControl(classification: SubmittablePageClassification) {
    const namedContinue = await this.firstVisibleEnabled(
      this.page.getByRole('button', { name: CONTINUE_BUTTON_NAME }),
    )
    if (namedContinue) return namedContinue

    const semanticSubmit = await this.firstVisibleEnabled(this.page.locator(classification.submitSelector))
    if (semanticSubmit) return semanticSubmit

    return this.firstVisibleEnabled(this.page.locator('button[type="submit"], input[type="submit"]'))
  }

  private async switchToOneTimeCodeLogin(beforeOtpRequest?: () => Promise<void>): Promise<boolean> {
    const button = await this.firstVisibleEnabled(
      this.page.getByRole('button', { name: ONE_TIME_CODE_LOGIN_CONTROL_NAME }),
    )
    const control =
      button ??
      (await this.firstVisibleEnabled(
        this.page.getByRole('link', { name: ONE_TIME_CODE_LOGIN_CONTROL_NAME }),
      ))
    if (!control) return false
    await beforeOtpRequest?.()
    await control.click({ timeout: 10_000 })
    return true
  }

  private sameAction(left: BrowserActionResult | null, right: BrowserActionResult): boolean {
    return (
      left?.kind === right.kind &&
      (left.kind !== 'manual_intervention' ||
        (right.kind === 'manual_intervention' && left.reason === right.reason))
    )
  }

  private async waitForSubmissionTransition(
    expected: AutomatedPageKind,
    beforeOtpRequest?: () => Promise<void>,
    preferredLogin: 'email_otp' | 'password' = 'email_otp',
    allowCredentialsErrorPage = false,
  ): Promise<BrowserActionResult | null> {
    const deadline = Date.now() + (allowCredentialsErrorPage ? 3_000 : SUBMISSION_TRANSITION_TIMEOUT_MS)
    let candidate: BrowserActionResult | null = null
    let candidateSince = 0
    let otpLoginChoiceClicks = 0
    let lastOtpLoginChoiceClick = 0

    while (Date.now() < deadline) {
      if (this.#callbackSettled) return { kind: 'submitted' }
      try {
        const next = classifySubmissionTransition(
          expected,
          await this.page.content(),
          preferredLogin,
          this.page.url(),
          allowCredentialsErrorPage,
        )
        if (next?.kind === 'otp_login_choice') {
          candidate = null
          candidateSince = 0
          if (
            otpLoginChoiceClicks < FORM_SUBMISSION_ATTEMPTS &&
            (otpLoginChoiceClicks === 0 || Date.now() - lastOtpLoginChoiceClick >= 1_000)
          ) {
            if (await this.switchToOneTimeCodeLogin(beforeOtpRequest)) {
              otpLoginChoiceClicks += 1
              lastOtpLoginChoiceClick = Date.now()
            }
          }
          await this.page.waitForTimeout(250)
          continue
        }
        if (!next) {
          candidate = null
          candidateSince = 0
        } else if (!this.sameAction(candidate, next)) {
          candidate = next
          candidateSince = Date.now()
        } else if (
          !(next.kind === 'manual_intervention' && next.reason === 'unknown') &&
          Date.now() - candidateSince >= SUBMISSION_TRANSITION_STABLE_MS
        ) {
          return next
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        if (this.page.isClosed()) throw new AppError('BROWSER_CLOSED', '授权浏览器已关闭。', { cause: error })
        throw error
      }
      await this.page.waitForTimeout(250)
    }
    if (candidate?.kind === 'manual_intervention' && candidate.reason === 'unknown') return candidate
    if (candidate) return candidate
    return otpLoginChoiceClicks > 0 ? { kind: 'manual_intervention', reason: 'password' } : null
  }

  private async reconcileKnownPageFailure(
    error: unknown,
    expected: AutomatedPageKind,
    preferredLogin: 'email_otp' | 'password',
  ): Promise<BrowserActionResult | null> {
    const recovered = await reconcileKnownPageAutomationFailure(error, expected, preferredLogin, {
      callbackSettled: () => this.#callbackSettled,
      pageClosed: () => this.page.isClosed(),
      readCurrentHtml: () => this.page.content(),
      waitBeforeRetry: () => this.page.waitForTimeout(250),
    })
    if (recovered.kind === 'retry_current_page' || recovered.kind === 'otp_login_choice') return null
    return recovered
  }

  private async fillKnownPage(
    expected: 'email' | 'password' | 'email_otp',
    value: string,
    beforeOtpRequest?: () => Promise<void>,
    preferredLogin: 'email_otp' | 'password' = 'email_otp',
    allowCredentialsErrorPage = false,
  ): Promise<BrowserActionResult> {
    const submissionAttempts = expected === 'password' ? 1 : FORM_SUBMISSION_ATTEMPTS
    for (let attempt = 0; attempt < submissionAttempts; attempt += 1) {
      try {
        const classification = await this.classifyUntil(
          expected,
          allowCredentialsErrorPage ? { allowCredentialsErrorPage: true } : {},
        )
        if (this.#callbackSettled) return { kind: 'submitted' }
        if (classification.kind === 'manual_intervention') return classification
        if (classification.kind !== expected) {
          const transition = await this.waitForSubmissionTransition(
            expected,
            beforeOtpRequest,
            preferredLogin,
            expected === 'password',
          )
          if (transition) return transition
          continue
        }

        const input = this.page.locator(classification.inputSelector).first()
        await input.waitFor({ state: 'visible', timeout: attempt === 0 ? 10_000 : 5_000 })
        if (!(await input.isEnabled())) throw new Error('Known-page input is not enabled')
        await input.fill(value)
        if ((await input.inputValue()) !== value) throw new Error('Known-page input value changed')

        if (expected === 'email' && preferredLogin === 'email_otp') await beforeOtpRequest?.()
        if (attempt === 0) {
          const submit = await this.findSubmitControl(classification)
          if (!submit) throw new Error('Known-page submit control is unavailable')
          await submit.click({ timeout: 10_000 })
        } else {
          await input.press('Enter', { timeout: 5_000 })
        }

        const transition = await this.waitForSubmissionTransition(
          expected,
          beforeOtpRequest,
          preferredLogin,
          expected === 'password',
        )
        if (transition) return transition
        if (expected === 'password') {
          const current = classifyPageHtml(await this.page.content(), { pageUrl: this.page.url() })
          if (current.kind === 'manual_intervention' && current.reason === 'credentials') return current
        }
      } catch (error) {
        const recovered = await this.reconcileKnownPageFailure(error, expected, preferredLogin)
        if (recovered) return recovered
      }
    }
    return { kind: 'manual_intervention', reason: 'unknown' }
  }

  private observePage(page: Page): void {
    if (this.#mainFrameNavigationCounts.has(page)) return
    this.#mainFrameNavigationCounts.set(page, 0)
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      this.#mainFrameNavigationCounts.set(page, this.mainFrameNavigationCount(page) + 1)
      this.inspectNavigation(frame.url())
    })
    page.on('close', () => {
      if (this.page !== page) return
      const fallback = [...this.context.pages()].reverse().find((candidate) => !candidate.isClosed())
      if (fallback) this.page = fallback
    })
  }

  private currentPage(): Page {
    if (!this.page.isClosed()) return this.page
    const fallback = [...this.context.pages()].reverse().find((candidate) => !candidate.isClosed())
    if (fallback) this.page = fallback
    return this.page
  }

  private mainFrameNavigationCount(page: Page): number {
    return this.#mainFrameNavigationCounts.get(page) ?? 0
  }

  private pageIdentity(page: Page = this.page): string {
    try {
      const url = new URL(page.url())
      return `${url.origin}${url.pathname}`
    } catch {
      return ''
    }
  }

  private async waitForManualPoll(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, MANUAL_PROGRESS_POLL_INTERVAL_MS))
  }

  private async armManualActivityTracking(page: Page): Promise<void> {
    await page.evaluate(() => {
      type ManualActivityWindow = Window & {
        __upIcloudManualActivity?: { count: number; cleanup: () => void }
      }
      const activityWindow = window as ManualActivityWindow
      activityWindow.__upIcloudManualActivity?.cleanup()
      const state = { count: 0, cleanup: () => undefined }
      const click = (event: Event) => {
        const target = event.target instanceof Element ? event.target : null
        if (
          event.isTrusted &&
          target?.closest('button, a, [role="button"], input[type="button"], input[type="submit"]')
        ) {
          state.count += 1
        }
      }
      const submit = (event: Event) => {
        if (event.isTrusted) state.count += 1
      }
      const keydown = (event: Event) => {
        if (event.isTrusted && event instanceof KeyboardEvent && event.key === 'Enter') state.count += 1
      }
      document.addEventListener('click', click, true)
      document.addEventListener('submit', submit, true)
      document.addEventListener('keydown', keydown, true)
      state.cleanup = () => {
        document.removeEventListener('click', click, true)
        document.removeEventListener('submit', submit, true)
        document.removeEventListener('keydown', keydown, true)
      }
      activityWindow.__upIcloudManualActivity = state
    })
  }

  private async readManualActivityCount(page: Page): Promise<number | null> {
    return page.evaluate(() => {
      const activityWindow = window as Window & {
        __upIcloudManualActivity?: { count: number }
      }
      return activityWindow.__upIcloudManualActivity?.count ?? null
    })
  }

  private async clearManualActivityTracking(page: Page): Promise<void> {
    await page.evaluate(() => {
      const activityWindow = window as Window & {
        __upIcloudManualActivity?: { cleanup: () => void }
      }
      activityWindow.__upIcloudManualActivity?.cleanup()
      delete activityWindow.__upIcloudManualActivity
    })
  }
}

export class PlaywrightBrowserController implements OAuthBrowserDriver {
  async start(input: StartBrowserInput): Promise<OAuthBrowserSession> {
    const foregroundApplication = await captureForegroundApplication()
    const requiresPlaywrightProxyAuthentication = Boolean(
      input.browserProxy?.username || input.browserProxy?.password,
    )
    return requiresPlaywrightProxyAuthentication
      ? this.startWithPlaywright(input, foregroundApplication)
      : this.startWithNativeChrome(input, foregroundApplication)
  }

  private async startWithPlaywright(
    input: StartBrowserInput,
    foregroundApplication: ForegroundApplicationSnapshot | null,
  ): Promise<OAuthBrowserSession> {
    if (input.signal?.aborted) throw cancelledError()
    const contract = deriveOAuthNavigationContract(input.authUrl)
    await verifyBrowserProxyReachability(input.browserProxy, input.signal)
    const userDataDir = await mkdtemp(join(tmpdir(), 'up-icloud-oauth-'))
    const removeUserDataDir = () => rm(userDataDir, { recursive: true, force: true })
    const foregroundGuard = keepOAuthChromeInBackground(foregroundApplication)
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(userDataDir, oauthBrowserLaunchOptions(input.browserProxy))
    } catch (error) {
      foregroundGuard.stop()
      await removeUserDataDir().catch(() => undefined)
      if (input.signal?.aborted) throw cancelledError()
      throw new AppError('BROWSER_START_FAILED', '无法启动 Chrome 无痕浏览器。', {
        statusCode: 502,
        cause: error,
      })
    }

    const launchedApplication = await captureForegroundApplication()
    const oauthChromeProcessId =
      launchedApplication?.bundleId === CHROME_BUNDLE_ID &&
      launchedApplication.processId !== foregroundApplication?.processId
        ? launchedApplication.processId
        : null
    foregroundGuard.setProcessId(oauthChromeProcessId)

    let session: PlaywrightOAuthSession | undefined
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      session = new PlaywrightOAuthSession(
        context,
        page,
        new CallbackCapture(contract),
        () => context.close(),
        removeUserDataDir,
      )
      if (input.signal?.aborted) throw cancelledError()
      input.onBrowserStarted?.()
      const initialNavigationRequest = this.firstMainFrameNavigation(page)
      const actualInitialNavigation = await verifyInitialAuthorizationNavigation(
        contract.authUrl,
        initialNavigationRequest,
        () => page.goto(contract.authUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        true,
      )
      input.onAuthorizationUrlOpened?.({
        initialNavigation: describeOAuthUrl(actualInitialNavigation),
        redirect: describeOAuthRedirect(page.url()),
      })
      await restoreForegroundApplication(foregroundApplication, oauthChromeProcessId)
      return session
    } catch (error) {
      if (session) await session.close()
      else {
        await context.close().catch(() => undefined)
        await removeUserDataDir().catch(() => undefined)
      }
      if (input.signal?.aborted) throw cancelledError()
      if (error instanceof AppError) throw error
      throw new AppError('BROWSER_NAVIGATION_FAILED', '无痕浏览器已启动，但无法打开 OpenAI 授权地址。', {
        statusCode: 502,
        cause: error,
      })
    }
  }

  private async startWithNativeChrome(
    input: StartBrowserInput,
    foregroundApplication: ForegroundApplicationSnapshot | null,
  ): Promise<OAuthBrowserSession> {
    if (input.signal?.aborted) throw cancelledError()
    const contract = deriveOAuthNavigationContract(input.authUrl)
    const userDataDir = await mkdtemp(join(tmpdir(), 'up-icloud-oauth-'))
    const removeUserDataDir = () => rm(userDataDir, { recursive: true, force: true })
    let nativeChrome: NativeChromeProcess | undefined
    let browser: Browser | undefined
    let foregroundGuard: ReturnType<typeof keepOAuthChromeInBackground> | null = null
    try {
      await access(NATIVE_CHROME_PATH)
      if (input.browserProxy) await verifyBrowserProxyReachability(input.browserProxy, input.signal)
      const debugPort = await reserveLoopbackPort()
      foregroundGuard = keepOAuthChromeInBackground(foregroundApplication)
      nativeChrome = spawnBackgroundChrome(nativeChromeLaunchArgs(userDataDir, debugPort, input.browserProxy))
      nativeChrome.launcher.unref()
      const endpoint = await waitForChromeDebugEndpoint(debugPort, input.signal)
      nativeChrome.processId = await resolveOwnedChromeProcessId(userDataDir, debugPort)
      const oauthChromeProcessId = nativeChrome.processId
      foregroundGuard.setProcessId(oauthChromeProcessId)
      browser = await chromium.connectOverCDP(endpoint)
      const context = browser.contexts()[0]
      if (!context) throw new AppError('BROWSER_START_FAILED', '本机 Chrome 无痕窗口没有可用标签页上下文。', { statusCode: 502 })
      const page = context.pages()[0] ?? (await context.newPage())
      const session = new PlaywrightOAuthSession(
        context,
        page,
        new CallbackCapture(contract),
        () => closeNativeChrome(browser, nativeChrome),
        removeUserDataDir,
      )
      if (input.signal?.aborted) throw cancelledError()
      input.onBrowserStarted?.()
      const initialNavigationRequest = this.firstMainFrameNavigation(page)
      const actualInitialNavigation = await verifyInitialAuthorizationNavigation(
        contract.authUrl,
        initialNavigationRequest,
        () => page.goto(contract.authUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        Boolean(input.browserProxy),
      )
      input.onAuthorizationUrlOpened?.({
        initialNavigation: describeOAuthUrl(actualInitialNavigation),
        redirect: describeOAuthRedirect(page.url()),
      })
      await restoreForegroundApplication(foregroundApplication, oauthChromeProcessId)
      return session
    } catch (error) {
      foregroundGuard?.stop()
      await closeNativeChrome(browser, nativeChrome)
      await removeUserDataDir().catch(() => undefined)
      if (input.signal?.aborted) throw cancelledError()
      if (error instanceof AppError) throw error
      throw new AppError('BROWSER_START_FAILED', '无法启动本机 Chrome 无痕浏览器。', {
        statusCode: 502,
        cause: error,
      })
    }
  }

  private async firstMainFrameNavigation(page: Page): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        page.off('request', inspectRequest)
        resolve(null)
      }, INITIAL_NAVIGATION_CAPTURE_TIMEOUT_MS)
      const inspectRequest = (request: Request) => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
        clearTimeout(timeout)
        page.off('request', inspectRequest)
        resolve(request.url())
      }
      page.on('request', inspectRequest)
    })
  }
}
