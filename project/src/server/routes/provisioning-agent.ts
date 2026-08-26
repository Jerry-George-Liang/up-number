import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ProvisioningAgentController } from '../agent/types'
import type { PoolConnectionModeService } from '../pool-connection/mode'

const pairInputSchema = z
  .object({
    centralOrigin: z.string().trim().url().max(2048),
    pairingCode: z.string().trim().min(8).max(100),
    deviceName: z.string().trim().min(1).max(80),
  })
  .strict()
const changeOriginInputSchema = z
  .object({ centralOrigin: z.string().trim().url().max(2048) })
  .strict()

export function registerProvisioningAgentRoutes(
  app: FastifyInstance,
  agent: ProvisioningAgentController,
  connectionMode?: PoolConnectionModeService,
): void {
  app.get('/local-api/provisioning-agent', async () => agent.status())
  app.post('/local-api/provisioning-agent/pair', async (request, reply) => {
    connectionMode?.assertActive('provisioning_agent')
    const input = pairInputSchema.parse(request.body)
    return reply.code(201).send(await agent.pair(input))
  })
  app.put('/local-api/provisioning-agent/origin', async (request) => {
    connectionMode?.assertActive('provisioning_agent')
    const input = changeOriginInputSchema.parse(request.body)
    return agent.changeOrigin(input)
  })
  app.delete('/local-api/provisioning-agent', async (_request, reply) => {
    await agent.disconnect()
    return reply.code(204).send()
  })
}
