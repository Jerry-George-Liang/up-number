import { z } from 'zod'
import { AppError } from '../../shared/errors'
import { BackendTransport } from './client'

const userSchema = z
  .object({
    id: z.number().int().positive(),
    email: z.string().email().optional(),
    username: z.string().optional(),
    role: z.string().optional(),
    is_admin: z.boolean().optional(),
    permissions: z.array(z.string()).optional(),
  })
  .passthrough()

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  user: userSchema.optional(),
})

const loginTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  user: userSchema,
})

const totpRequiredSchema = z.object({
  requires_2fa: z.literal(true),
  temp_token: z.string().min(1),
  user_email_masked: z.string().min(1).optional(),
})

const loginResultSchema = z.union([totpRequiredSchema, loginTokenSchema])

const publicAuthRequirementsSchema = z.object({
  turnstile_enabled: z.boolean().optional().default(false),
  tencent_captcha_enabled: z.boolean().optional().default(false),
  aliyun_captcha_enabled: z.boolean().optional().default(false),
  login_agreement_enabled: z.boolean().optional().default(false),
})

export type BackendUser = z.infer<typeof userSchema>
export type BackendTokens = z.infer<typeof tokenSchema>
export type BackendLoginTokens = z.infer<typeof loginTokenSchema>
export type BackendLoginResult = z.infer<typeof loginResultSchema>

export interface PublicAuthRequirements {
  turnstileEnabled: boolean
  tencentCaptchaEnabled: boolean
  aliyunCaptchaEnabled: boolean
  loginAgreementEnabled: boolean
}

function parseLoginResult(payload: unknown): BackendLoginResult {
  const parsed = loginResultSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AppError('BACKEND_LOGIN_RESPONSE_INVALID', '后台登录响应格式无效。', {
      statusCode: 502,
      cause: parsed.error,
    })
  }
  return parsed.data
}

export class BackendAuthApi {
  constructor(private readonly transport: BackendTransport) {}

  async getPublicAuthRequirements(): Promise<PublicAuthRequirements> {
    const payload = await this.transport.request<unknown>('settings/public')
    const parsed = publicAuthRequirementsSchema.safeParse(payload)
    if (!parsed.success) {
      throw new AppError('BACKEND_AUTH_REQUIREMENTS_INVALID', '后台认证配置响应格式无效。', {
        statusCode: 502,
        cause: parsed.error,
      })
    }
    const requirements = parsed.data
    return {
      turnstileEnabled: requirements.turnstile_enabled,
      tencentCaptchaEnabled: requirements.tencent_captcha_enabled,
      aliyunCaptchaEnabled: requirements.aliyun_captcha_enabled,
      loginAgreementEnabled: requirements.login_agreement_enabled,
    }
  }

  async login(email: string, password: string): Promise<BackendLoginResult> {
    const payload = await this.transport.request<unknown>('auth/login', {
      method: 'POST',
      body: { email, password },
    })
    return parseLoginResult(payload)
  }

  async login2FA(tempToken: string, code: string): Promise<BackendLoginTokens> {
    const payload = await this.transport.request<unknown>('auth/login/2fa', {
      method: 'POST',
      body: { temp_token: tempToken, totp_code: code },
    })
    const parsed = loginTokenSchema.safeParse(payload)
    if (!parsed.success) {
      throw new AppError('BACKEND_LOGIN_RESPONSE_INVALID', '后台二次验证响应格式无效。', {
        statusCode: 502,
        cause: parsed.error,
      })
    }
    return parsed.data
  }

  async refresh(refreshToken: string): Promise<BackendTokens> {
    const payload = await this.transport.request<unknown>('auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })
    return tokenSchema.parse(payload)
  }

  async me(accessToken: string): Promise<BackendUser> {
    const payload = await this.transport.request<unknown>('auth/me', { token: accessToken })
    const raw = payload && typeof payload === 'object' && 'user' in payload ? (payload as { user: unknown }).user : payload
    return userSchema.parse(raw)
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      await this.transport.request('auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      })
    } catch (error) {
      if (error instanceof AppError && error.code === 'BACKEND_NETWORK_ERROR') return
      throw error
    }
  }
}
