import { existsSync } from 'node:fs'
import type { SecureContextOptions } from 'node:tls'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../shared/errors'
import type { LocalSessionSecurity } from './local-security'
import {
  isIpv4InCidr,
  normalizeRemoteAddress,
  type Ipv4Cidr,
} from './network-access'
import { registerAuthRoutes, type SessionRoutesAdapter } from './routes/auth'
import {
  registerDeactivationSettingsRoutes,
  type DeactivationSettingsRoutesAdapter,
} from './routes/deactivation-settings'
import {
  registerMailboxSettingsRoutes,
  type MailboxSettingsRoutesAdapter,
} from './routes/mail-settings'
import { registerOptionsRoutes, type OptionsRoutesAdapter } from './routes/options'
import { registerAccountPoolPortalRoutes } from './routes/account-pool'
import { registerPoolConnectionModeRoutes } from './routes/pool-connection-mode'
import { registerProvisioningAgentRoutes } from './routes/provisioning-agent'
import type { ProvisioningAgentController } from './agent/types'
import type { AccountPoolPortalService } from './account-pool/portal'
import type { PoolConnectionModeService } from './pool-connection/mode'
import {
  registerReauthorizationRoutes,
  type ReauthorizationRoutesAdapter,
} from './routes/reauthorization'
import {
  registerTaskRoutes,
  type TaskRoutesOrchestrator,
  type TaskRoutesStorage,
} from './routes/tasks'

const COOKIE_NAME = 'up_icloud_session'
const LOCAL_SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export interface LocalAppDependencies {
  security: LocalSessionSecurity
  localOrigin: string
  sessionCookieName?: string
  autoEstablishSession?: boolean
  accessPolicy?: {
    allowedHostnames: readonly string[]
    allowedClientCidr?: Ipv4Cidr
  }
  session: SessionRoutesAdapter
  mailboxSettings: MailboxSettingsRoutesAdapter
  deactivationSettings: DeactivationSettingsRoutesAdapter
  options: OptionsRoutesAdapter
  reauthorization: ReauthorizationRoutesAdapter
  orchestrator: TaskRoutesOrchestrator
  tasks: TaskRoutesStorage
  provisioningAgent?: ProvisioningAgentController
  accountPoolPortal?: AccountPoolPortalService
  poolConnectionMode?: PoolConnectionModeService
  webRoot?: string
}

export interface LocalAppOptions {
  https?: SecureContextOptions
}

function securityError(reason: string): AppError {
  const statusCode = reason === 'LOCAL_SESSION_REQUIRED' ? 401 : 403
  const message =
    statusCode === 401
      ? '本地启动会话未建立或已失效，请使用本次启动生成的单次链接重新进入。'
      : '本地请求安全校验失败。'
  return new AppError(reason, message, { statusCode })
}

function bootstrapNonceFrom(query: unknown): string {
  if (!query || typeof query !== 'object') {
    throw new AppError('BOOTSTRAP_INVALID', '本地启动链接无效或已经使用。', { statusCode: 403 })
  }
  const nonce = (query as Record<string, unknown>).nonce
  if (typeof nonce !== 'string' || !nonce) {
    throw new AppError('BOOTSTRAP_INVALID', '本地启动链接无效或已经使用。', { statusCode: 403 })
  }
  return nonce
}

function logUnexpectedRequestError(error: unknown, request: FastifyRequest): void {
  const route = request.routeOptions.url ?? 'unknown-route'
  const name = error instanceof Error ? error.name : 'NonErrorThrow'
  const message = error instanceof Error ? error.message : 'No error message available'
  const errorCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? ` ${error.code}` : ''
  console.error(`[up-icloud] Unexpected ${request.method} ${route}: ${name}${errorCode}: ${message}`)
}

function bootstrapConfirmationPage(nonce: string): string {
  const action = `/bootstrap?nonce=${encodeURIComponent(nonce)}`
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>确认进入本地工具</title>
  </head>
  <body>
    <main>
      <h1>正在连接本地工具</h1>
      <p id="bootstrap-status" role="status" aria-live="polite">正在检查安全连接...</p>
      <form id="bootstrap-form" method="post" action="${action}">
        <button id="bootstrap-submit" type="submit">检查并进入</button>
      </form>
      <noscript><p>浏览器未运行脚本，请点击“检查并进入”继续。</p></noscript>
    </main>
    <script src="/bootstrap.js" defer></script>
  </body>
</html>`
}

const BOOTSTRAP_CLIENT_SCRIPT = `(() => {
  const form = document.getElementById('bootstrap-form')
  const submitButton = document.getElementById('bootstrap-submit')
  const status = document.getElementById('bootstrap-status')
  if (!(form instanceof HTMLFormElement) || !(submitButton instanceof HTMLButtonElement) || !status) return

  let checking = false
  const checkAndSubmit = async () => {
    if (checking) return
    checking = true
    submitButton.disabled = true
    status.textContent = '正在检查安全连接...'

    try {
      const response = await fetch('/healthz', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error('health request failed')
      const payload = await response.json()
      if (!payload || payload.status !== 'ok') throw new Error('health response invalid')

      status.textContent = '检查成功，正在进入...'
      HTMLFormElement.prototype.submit.call(form)
    } catch {
      checking = false
      submitButton.disabled = false
      status.textContent = '检查未通过，请确认当前地址可以访问后重试。'
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void checkAndSubmit()
  })
  void checkAndSubmit()
})()`

function setLocalSessionCookie(reply: FastifyReply, dependencies: LocalAppDependencies): void {
  reply.setCookie(dependencies.sessionCookieName ?? COOKIE_NAME, dependencies.security.sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: dependencies.localOrigin.startsWith('https://'),
    maxAge: LOCAL_SESSION_COOKIE_MAX_AGE_SECONDS,
  })
}

export function buildApp(
  dependencies: LocalAppDependencies,
  options: LocalAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    ...(options.https ? { https: options.https } : {}),
  }) as FastifyInstance
  void app.register(cookie)
  void app.register(formbody, { bodyLimit: 1024 })

  app.addHook('onRequest', async (request, reply) => {
    if (dependencies.accessPolicy) {
      const hostname = request.hostname.toLowerCase()
      if (!dependencies.accessPolicy.allowedHostnames.includes(hostname)) {
        throw securityError('LOCAL_HOST_INVALID')
      }
      const allowedClientCidr = dependencies.accessPolicy.allowedClientCidr
      if (allowedClientCidr) {
        const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress)
        if (!remoteAddress || !isIpv4InCidr(remoteAddress, allowedClientCidr)) {
          throw securityError('LOCAL_CLIENT_NETWORK_INVALID')
        }
      }
    }
    if (!request.url.startsWith('/local-api/')) return
    const sessionCookie = request.cookies[dependencies.sessionCookieName ?? COOKIE_NAME]
    if (!dependencies.security.hasSession(sessionCookie)) {
      if (
        dependencies.autoEstablishSession &&
        request.method === 'GET' &&
        request.url === '/local-api/session'
      ) {
        setLocalSessionCookie(reply, dependencies)
        return
      }
      throw securityError('LOCAL_SESSION_REQUIRED')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      const validation = dependencies.security.validateWrite({
        cookieSession: sessionCookie,
        csrfHeader: request.headers['x-csrf-token'] as string | undefined,
        origin: request.headers.origin,
        expectedOrigin: dependencies.localOrigin,
      })
      if (!validation.ok) throw securityError(validation.reason)
    }
    setLocalSessionCookie(reply, dependencies)
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    )
    const contentType = String(reply.getHeader('content-type') ?? '').toLowerCase()
    if (request.url.startsWith('/local-api/') || contentType.startsWith('text/html')) {
      reply.header('Cache-Control', 'no-store')
    }
    if (dependencies.localOrigin.startsWith('https://')) {
      reply.header('Strict-Transport-Security', 'max-age=31536000')
    }
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'INPUT_INVALID', message: '请求参数无效。' } })
    }
    if (error instanceof AppError) {
      if (request.routeOptions.url?.startsWith('/local-api/session')) {
        console.warn(`[up-icloud] ${request.method} ${request.routeOptions.url} failed: ${error.code}`)
      }
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    logUnexpectedRequestError(error, request)
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '本地服务发生未预期错误。' } })
  })

  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/bootstrap.js', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .type('application/javascript; charset=utf-8')
      .send(BOOTSTRAP_CLIENT_SCRIPT),
  )
  app.get('/bootstrap', async (request, reply) => {
    if (dependencies.security.hasSession(request.cookies[dependencies.sessionCookieName ?? COOKIE_NAME])) {
      setLocalSessionCookie(reply, dependencies)
      const home = request.hostname === 'localhost' ? `${dependencies.localOrigin}/?bootstrapped=1` : '/?bootstrapped=1'
      return reply.header('Cache-Control', 'no-store').redirect(home)
    }
    const nonce = bootstrapNonceFrom(request.query)
    if (!dependencies.security.canBootstrap(nonce)) {
      throw new AppError('BOOTSTRAP_INVALID', '本地启动链接无效或已经使用。', { statusCode: 403 })
    }
    if (request.hostname === 'localhost') {
      return reply.redirect(`${dependencies.localOrigin}/bootstrap?nonce=${encodeURIComponent(nonce)}`)
    }
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(bootstrapConfirmationPage(nonce))
  })

  app.post('/bootstrap', async (request, reply) => {
    if (dependencies.security.hasSession(request.cookies[dependencies.sessionCookieName ?? COOKIE_NAME])) {
      setLocalSessionCookie(reply, dependencies)
      const home = request.hostname === 'localhost' ? `${dependencies.localOrigin}/?bootstrapped=1` : '/?bootstrapped=1'
      return reply.header('Cache-Control', 'no-store').redirect(home)
    }
    const nonce = bootstrapNonceFrom(request.query)
    if (!dependencies.security.consumeBootstrap(nonce)) {
      throw new AppError('BOOTSTRAP_INVALID', '本地启动链接无效或已经使用。', { statusCode: 403 })
    }
    setLocalSessionCookie(reply, dependencies)
    return reply.redirect('/?bootstrapped=1')
  })

  registerAuthRoutes(app, dependencies.session, dependencies.security.csrfToken)
  if (dependencies.accountPoolPortal) {
    registerAccountPoolPortalRoutes(app, dependencies.accountPoolPortal, dependencies.poolConnectionMode)
  }
  if (dependencies.poolConnectionMode) {
    registerPoolConnectionModeRoutes(app, dependencies.poolConnectionMode)
  }
  registerMailboxSettingsRoutes(app, dependencies.mailboxSettings)
  registerDeactivationSettingsRoutes(app, dependencies.deactivationSettings)
  registerOptionsRoutes(app, dependencies.options)
  registerReauthorizationRoutes(app, dependencies.reauthorization)
  registerTaskRoutes(app, dependencies.orchestrator, dependencies.tasks)
  if (dependencies.provisioningAgent) {
    registerProvisioningAgentRoutes(app, dependencies.provisioningAgent, dependencies.poolConnectionMode)
  }

  if (dependencies.webRoot && existsSync(dependencies.webRoot)) {
    void app.register(fastifyStatic, { root: dependencies.webRoot, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/local-api/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '未找到资源。' } })
    })
  }

  return app
}
