import { load, type CheerioAPI } from 'cheerio'
import type { ManualInterventionReason, PageClassification } from './types'

const HIGH_CONFIDENCE_CHALLENGE_PATTERNS: Array<[ManualInterventionReason, RegExp]> = [
  ['provider_error', /糟糕，?出错了|oops[,!]?\s*(?:something )?went wrong|something went wrong/i],
  ['account_selection', /choose (?:an )?account|select (?:an )?account|选择账号|选择帐户|choose (?:an )?organization/i],
  [
    'credentials',
    /incorrect password|incorrect (?:email(?: address)?|username|account) (?:or|and) password|wrong (?:email (?:or|and) )?password|invalid (?:email (?:or|and) )?password|password(?: you entered)? (?:is )?(?:incorrect|wrong|invalid)|(?:your )?(?:email|username|account) (?:or|and) password (?:is )?(?:incorrect|wrong|invalid)|invalid (?:login )?credentials|credentials (?:are )?(?:incorrect|wrong|invalid)|invalid (?:verification )?code|incorrect (?:verification )?code|密码错误|密码不正确|密码无效|(?:邮箱|账号|账户|用户名)(?:或|和)密码(?:错误|不正确|无效)|动态码错误|验证码不正确/i,
  ],
  ['challenge', /captcha|verify you are human|human verification|unusual activity|验证码挑战|人机验证|异常活动/i],
]
const UNSUPPORTED_MFA_PATTERN = /security key|passkey|text message|sms|recovery code|phone verification|安全密钥|短信验证|恢复码|手机验证/i
const PASSWORD_PATTERN = /\bpassword\b|密码/i
const EMAIL_OTP_CONTEXT = /check your email|code (?:was )?sent to (?:your )?email|email verification code|检查(?:你的|您)?的?邮箱|验证码.{0,24}(?:邮箱|邮件)|(?:邮箱|邮件).{0,24}验证码/i
const AUTHENTICATOR_TOTP_CONTEXT = /authenticator app|authentication app|code from (?:your )?authenticator|认证器|身份验证器|动态(?:验证)?码|验证器应用/i
const GENERIC_MFA_CONTEXT = /multi[- ]factor|two[- ]factor|two[- ]step|双重验证|多重验证|两步验证/i
const PASSWORD_SUBMIT_CONTROL_NAME = /^(?:继续|Continue|登录|Log in|Sign in)$/i
export const ONE_TIME_CODE_LOGIN_CONTROL_NAME =
  /^(?:使用一次性验证码登录|使用一次性代码登录|Use a one-time (?:verification )?code(?: instead)?|Log in with a one-time code|Continue with a one-time code|Email me a code)$/i
export const OTP_RESEND_CONTROL_NAME =
  /^(?:重新发送验证码|再次发送验证码|重新发送电子邮件|Resend code|Resend email|Send again)$/i
const ACCOUNT_DEACTIVATED_PATTERN = /\baccount_deactivated\b/i

export interface PageClassificationOptions {
  allowCredentialsErrorPage?: boolean
  pageUrl?: string
}

function stableSelector($: CheerioAPI, element: any, fallback: string): string {
  const id = $(element).attr('id')
  if (id && /^[A-Za-z][\w:.-]*$/.test(id)) return `#${id.replace(/([^A-Za-z0-9_-])/g, '\\$1')}`
  const name = $(element).attr('name')
  if (name) return `input[name="${name.replace(/["\\]/g, '\\$&')}"]`
  return fallback
}

function submitSelector($: CheerioAPI): string {
  if ($('button[type="submit"]').length) return 'button[type="submit"]'
  if ($('input[type="submit"]').length) return 'input[type="submit"]'
  if ($('form button').length) return 'form button'
  return 'button'
}

function hasExactControl($: CheerioAPI, pattern: RegExp): boolean {
  return $('button, a, [role="button"], input[type="button"], input[type="submit"]').toArray().some((element) => {
    const label = element.tagName === 'input' ? $(element).attr('value') : $(element).text()
    return pattern.test(cleanVisibleText(label ?? ''))
  })
}

function hasExactContinueButton($: CheerioAPI): boolean {
  return hasExactControl($, /^(?:继续|Continue)$/i)
}

function isEmailInput($: CheerioAPI, element: any): boolean {
  const input = $(element)
  const type = input.attr('type')?.toLowerCase()
  if (type === 'email') return true
  if (input.attr('autocomplete')?.toLowerCase() === 'email') return true
  if (input.attr('inputmode')?.toLowerCase() === 'email') return true

  const identifiers = [
    input.attr('id'),
    input.attr('name'),
    input.attr('placeholder'),
    input.attr('aria-label'),
  ].filter(Boolean)
  if (identifiers.some((value) => /e[- ]?mail|电子邮件|邮箱/i.test(value!))) return true

  const id = input.attr('id')
  return Boolean(
    id &&
      $('label')
        .filter((_, label) => $(label).attr('for') === id)
        .toArray()
        .some((label) => /e[- ]?mail|电子邮件|邮箱/i.test(cleanVisibleText($(label).text()))),
  )
}

function cleanVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function classifyPageHtml(html: string, options: PageClassificationOptions = {}): PageClassification {
  const $ = load(html)
  $('script, style, noscript, template').remove()
  const visibleText = cleanVisibleText(`${$('title').text()}\n${$('body').text()}`)
  if (ACCOUNT_DEACTIVATED_PATTERN.test(visibleText)) return { kind: 'account_deactivated' }
  const phoneVerificationPath = (() => {
    try {
      const pageUrl = options.pageUrl ? new URL(options.pageUrl) : null
      return Boolean(
        pageUrl?.protocol === 'https:' &&
        pageUrl.hostname === 'auth.openai.com' &&
        pageUrl.pathname.replace(/\/+$/, '') === '/add-phone',
      )
    } catch {
      return false
    }
  })()
  const phoneInputs = $('input[type="tel"], input[autocomplete="tel"], input[name*="phone" i]')
  const phoneRequiredContext =
    /phone number is required|add your phone number to continue|send (?:you )?a one[- ]time verification code|电话号码是必填项|添加您的电话号码以继续|向该号码发送.{0,12}(?:一次性)?验证码/i.test(
      visibleText,
    )
  if (phoneVerificationPath && phoneInputs.length === 1 && phoneRequiredContext && hasExactContinueButton($)) {
    return { kind: 'phone_verification' }
  }
  for (const [reason, pattern] of HIGH_CONFIDENCE_CHALLENGE_PATTERNS) {
    if (reason === 'credentials' && options.allowCredentialsErrorPage) continue
    if (pattern.test(visibleText)) return { kind: 'manual_intervention', reason }
  }

  const passwordInputs = $('input[type="password"]')
  if (passwordInputs.length) {
    if (passwordInputs.length !== 1 || !hasExactControl($, PASSWORD_SUBMIT_CONTROL_NAME)) {
      return { kind: 'manual_intervention', reason: 'password' }
    }
    const password = passwordInputs.first()
    return {
      kind: 'password',
      inputSelector: stableSelector($, password.get(0), 'input[type="password"]'),
      submitSelector: submitSelector($),
      hasOneTimeCodeLoginChoice: hasExactControl($, ONE_TIME_CODE_LOGIN_CONTROL_NAME),
    }
  }

  const otpInputs = $('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[name*="code" i]')
  if (otpInputs.length) {
    if (otpInputs.length !== 1) return { kind: 'manual_intervention', reason: 'mfa' }
    const otp = otpInputs.first()
    const emailContext = EMAIL_OTP_CONTEXT.test(visibleText)
    const authenticatorContext = AUTHENTICATOR_TOTP_CONTEXT.test(visibleText)
    if (emailContext === authenticatorContext) {
      return { kind: 'manual_intervention', reason: authenticatorContext ? 'mfa' : 'unknown' }
    }
    return {
      kind: emailContext ? 'email_otp' : 'authenticator_totp',
      inputSelector: stableSelector($, otp.get(0), 'input[autocomplete="one-time-code"]'),
      submitSelector: submitSelector($),
    }
  }

  const email = $('input').filter((_, element) => isEmailInput($, element)).first()
  if (email.length) {
    return {
      kind: 'email',
      inputSelector: stableSelector(
        $,
        email.get(0),
        'input[type="email"], input[autocomplete="email"], input[inputmode="email"]',
      ),
      submitSelector: submitSelector($),
    }
  }
  if (PASSWORD_PATTERN.test(visibleText)) return { kind: 'manual_intervention', reason: 'password' }
  if (UNSUPPORTED_MFA_PATTERN.test(visibleText) || AUTHENTICATOR_TOTP_CONTEXT.test(visibleText) || GENERIC_MFA_CONTEXT.test(visibleText)) {
    return { kind: 'manual_intervention', reason: 'mfa' }
  }
  const codexConsent =
    /(?:使用\s*ChatGPT\s*登录(?:到)?\s*Codex|Use\s+ChatGPT\s+to\s+(?:log|sign)\s+in\s+to\s+Codex|Sign\s+in\s+to\s+Codex\s+with\s+ChatGPT)/i.test(
      visibleText,
    ) && hasExactContinueButton($)
  if (codexConsent) return { kind: 'consent', submitSelector: submitSelector($) }
  return { kind: 'manual_intervention', reason: 'unknown' }
}
