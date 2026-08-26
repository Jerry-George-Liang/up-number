import type { FastifyInstance } from 'fastify'
import { PasswordLoginInputSchema, TotpLoginInputSchema } from '../../shared/contracts'
import type { PasswordLoginResult, PublicSession } from '../session/manager'

export interface SessionRoutesAdapter {
  ready?(): Promise<void>
  publicSession(): PublicSession
  login(email: string, password: string): Promise<PasswordLoginResult>
  completeTotp(attemptId: string, code: string): Promise<PublicSession>
  cancelPendingLogin(): void
  logout(): Promise<void>
}

export function registerAuthRoutes(
  app: FastifyInstance,
  session: SessionRoutesAdapter,
  csrfToken: string,
): void {
  app.get('/local-api/session', async () => {
    await session.ready?.()
    return { csrfToken, session: session.publicSession() }
  })

  app.post('/local-api/session/login', async (request) => {
    const input = PasswordLoginInputSchema.parse(request.body)
    return session.login(input.email, input.password)
  })

  app.post('/local-api/session/login-2fa', async (request) => {
    const input = TotpLoginInputSchema.parse(request.body)
    return { session: await session.completeTotp(input.attemptId, input.code) }
  })

  app.delete('/local-api/session/login-pending', async (_request, reply) => {
    session.cancelPendingLogin()
    return reply.code(204).send()
  })

  app.delete('/local-api/session', async (_request, reply) => {
    await session.logout()
    return reply.code(204).send()
  })
}
