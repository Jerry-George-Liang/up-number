import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PoolConnectionModeService } from '../pool-connection/mode'

const switchModeInputSchema = z
  .object({ mode: z.enum(['account_pool', 'provisioning_agent']) })
  .strict()

export function registerPoolConnectionModeRoutes(
  app: FastifyInstance,
  service: PoolConnectionModeService,
): void {
  app.get('/local-api/pool-connection-mode', async () => service.status())
  app.put('/local-api/pool-connection-mode', async (request) => {
    const input = switchModeInputSchema.parse(request.body)
    return service.switchMode(input.mode)
  })
}
