import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AccountPoolPortalService } from '../account-pool/portal'
import type { PoolConnectionModeService } from '../pool-connection/mode'

const connectInputSchema = z
  .object({
    origin: z.string().trim().url().max(2048),
    foreground: z.boolean().optional(),
    reuseOnly: z.boolean().optional(),
  })
  .strict()
const mailboxOriginQuerySchema = z.object({ email: z.string().trim().min(1).max(320) }).strict()

export function registerAccountPoolPortalRoutes(
  app: FastifyInstance,
  portal: AccountPoolPortalService,
  connectionMode?: PoolConnectionModeService,
): void {
  app.get('/local-api/account-pool', async () => portal.status())
  app.get('/local-api/account-pool/mailbox-origin-audit', async () => portal.auditMailboxOrigins())
  app.get('/local-api/account-pool/mailbox-origin', async (request) => {
    const { email } = mailboxOriginQuerySchema.parse(request.query)
    return portal.inspectMailboxOrigin(email)
  })
  app.put('/local-api/account-pool', async (request) => {
    connectionMode?.assertActive('account_pool')
    const input = connectInputSchema.parse(request.body)
    return portal.connect(input)
  })
  app.delete('/local-api/account-pool', async (_request, reply) => {
    await portal.disconnect()
    return reply.code(204).send()
  })
}
