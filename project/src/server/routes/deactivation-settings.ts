import type { FastifyInstance } from 'fastify'
import {
  UpdateDeactivationSettingsInputSchema,
  type DeactivationSettings,
  type UpdateDeactivationSettingsInput,
} from '../../shared/contracts'
import { AppError } from '../../shared/errors'

export interface DeactivationSettingsRoutesAdapter {
  getSettings(): DeactivationSettings
  updateSettings(input: UpdateDeactivationSettingsInput): DeactivationSettings
  hasActiveTask(): boolean
}

export function registerDeactivationSettingsRoutes(
  app: FastifyInstance,
  settings: DeactivationSettingsRoutesAdapter,
): void {
  app.get('/local-api/settings/deactivation', async () => settings.getSettings())
  app.put('/local-api/settings/deactivation', async (request) => {
    const input = UpdateDeactivationSettingsInputSchema.parse(request.body)
    if (settings.hasActiveTask()) {
      throw new AppError(
        'DEACTIVATION_SETTINGS_BUSY',
        '当前有账号任务正在运行，请在任务结束后修改封号确认次数。',
        { statusCode: 409 },
      )
    }
    return settings.updateSettings(input)
  })
}
