import type { FastifyInstance } from 'fastify'
import type { OptionsSnapshot } from '../../shared/contracts'

export interface OptionsRoutesAdapter {
  loadSnapshot(): Promise<OptionsSnapshot>
}

export function registerOptionsRoutes(app: FastifyInstance, options: OptionsRoutesAdapter): void {
  app.get('/local-api/options', async () => options.loadSnapshot())
  app.post('/local-api/options/refresh', async () => options.loadSnapshot())
}
