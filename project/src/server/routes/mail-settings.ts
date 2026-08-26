import type { FastifyInstance } from 'fastify'
import {
  UpdateMailboxTrustSettingsInputSchema,
  type MailboxTrustSettings,
  type UpdateMailboxTrustSettingsInput,
} from '../../shared/contracts'
import { AppError } from '../../shared/errors'

export interface MailboxSettingsRoutesAdapter {
  getSettings(): MailboxTrustSettings
  updateSettings(input: UpdateMailboxTrustSettingsInput): MailboxTrustSettings
  hasActiveTask(): boolean
}

export function registerMailboxSettingsRoutes(
  app: FastifyInstance,
  settings: MailboxSettingsRoutesAdapter,
): void {
  app.get('/local-api/settings/mailbox-trust', async () => settings.getSettings())

  app.put('/local-api/settings/mailbox-trust', async (request) => {
    const input = UpdateMailboxTrustSettingsInputSchema.parse(request.body)
    if (settings.hasActiveTask()) {
      throw new AppError(
        'MAILBOX_SETTINGS_BUSY',
        '当前有账号任务正在运行，请在任务结束后修改可信邮箱服务。',
        { statusCode: 409 },
      )
    }
    return settings.updateSettings(input)
  })
}
