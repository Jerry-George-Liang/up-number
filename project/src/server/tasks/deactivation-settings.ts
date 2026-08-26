import {
  DEFAULT_DEACTIVATION_CONFIRMATION_ATTEMPTS,
  DeactivationConfirmationAttemptsSchema,
  type DeactivationSettings,
  type UpdateDeactivationSettingsInput,
} from '../../shared/contracts'

const SETTING_KEY = 'tasks.deactivation-confirmation-attempts'

export interface DeactivationSettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export class DeactivationSettingsService {
  constructor(private readonly store: DeactivationSettingsStore) {}

  getSettings(): DeactivationSettings {
    const parsed = DeactivationConfirmationAttemptsSchema.safeParse(
      Number(this.store.getSetting(SETTING_KEY)),
    )
    return {
      confirmationAttempts: parsed.success
        ? parsed.data
        : DEFAULT_DEACTIVATION_CONFIRMATION_ATTEMPTS,
    }
  }

  updateSettings(input: UpdateDeactivationSettingsInput): DeactivationSettings {
    this.store.setSetting(SETTING_KEY, String(input.confirmationAttempts))
    return { confirmationAttempts: input.confirmationAttempts }
  }
}
