import type { BrowserProxyConfig } from '../tasks/proxy-resolver'
import type { OAuthRedirectShape, OAuthUrlShape } from '../../shared/contracts'

export type ManualInterventionReason =
  | 'challenge'
  | 'password'
  | 'credentials'
  | 'email_otp'
  | 'account_selection'
  | 'mfa'
  | 'provider_error'
  | 'unknown'

export type AutomatedPageKind = 'email' | 'password' | 'email_otp' | 'authenticator_totp' | 'consent'

export type PageClassification =
  | { kind: 'email'; inputSelector: string; submitSelector: string }
  | {
      kind: 'password'
      inputSelector: string
      submitSelector: string
      hasOneTimeCodeLoginChoice: boolean
    }
  | { kind: 'email_otp'; inputSelector: string; submitSelector: string }
  | { kind: 'authenticator_totp'; inputSelector: string; submitSelector: string }
  | { kind: 'consent'; submitSelector: string }
  | { kind: 'account_deactivated' }
  | { kind: 'phone_verification' }
  | { kind: 'callback_captured' }
  | { kind: 'manual_intervention'; reason: ManualInterventionReason }

export type BrowserActionResult =
  | { kind: 'submitted' }
  | { kind: 'manual_intervention'; reason: ManualInterventionReason }

export type OtpResendResult =
  | BrowserActionResult
  | { kind: 'continue_polling' }
  | { kind: 'consent_ready' }
  | { kind: 'callback_captured' }

export type AuthenticatorSubmissionResult = BrowserActionResult | { kind: 'still_active' }

export interface PasswordSubmissionOptions {
  allowCredentialsErrorPage?: boolean
}

export interface OAuthCallbackResult {
  code: string
  state: string
}

export interface StartBrowserInput {
  authUrl: string
  browserProxy?: BrowserProxyConfig
  signal?: AbortSignal
  onBrowserStarted?: () => void
  onAuthorizationUrlOpened?: (evidence: {
    initialNavigation: OAuthUrlShape
    redirect: OAuthRedirectShape
  }) => void
}

export interface OAuthBrowserSession {
  submitEmail(
    email: string,
    preferredLogin: 'email_otp' | 'password',
    beforeOtpRequest?: () => Promise<void>,
  ): Promise<BrowserActionResult>
  submitPassword(password: string, options?: PasswordSubmissionOptions): Promise<BrowserActionResult>
  resendOtp(beforeOtpRequest?: () => Promise<void>): Promise<OtpResendResult>
  submitEmailOtp(code: string): Promise<BrowserActionResult>
  submitAuthenticatorTotp(code: string): Promise<AuthenticatorSubmissionResult>
  classifyCurrentPage(): Promise<PageClassification>
  waitForManualProgress(input: {
    blockedPage: AutomatedPageKind
    preferredLogin: 'email_otp' | 'password'
    requireActivityOnBlockedPage: boolean
    signal?: AbortSignal
  }): Promise<PageClassification>
  submitConsent(): Promise<BrowserActionResult>
  waitForCallback(signal?: AbortSignal): Promise<OAuthCallbackResult>
  close(): Promise<void>
}

export interface OAuthBrowserDriver {
  start(input: StartBrowserInput): Promise<OAuthBrowserSession>
}
