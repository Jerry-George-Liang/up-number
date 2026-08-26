export const TASK_STAGES = [
  'draft',
  'validating',
  'loading_target_account',
  'loading_options',
  'checking_existing',
  'mail_baseline',
  'resolving_proxy',
  'generating_auth_url',
  'authorization_url_received',
  'browser_started',
  'authorization_url_opened',
  'email_submitted',
  'waiting_for_password',
  'password_submitted',
  'waiting_for_totp',
  'totp_submitted',
  'waiting_for_otp',
  'resending_otp',
  'waiting_for_otp_retry',
  'resending_otp_second',
  'waiting_for_otp_third',
  'otp_submitted',
  'waiting_for_consent',
  'consent_submitted',
  'account_deactivated_retrying',
  'account_deactivated_confirmed',
  'locating_deactivated_account',
  'marking_account_banned',
  'confirming_account_banned',
  'waiting_for_callback',
  'manual_intervention',
  'exchanging_code',
  'applying_oauth_credentials',
  'confirming_reauthorization',
  'reauthorization_result_uncertain',
  'checking_duplicate',
  'creating_account',
  'confirming_account',
  'create_result_uncertain',
  'completed',
  'already_exists',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type TaskStage = (typeof TASK_STAGES)[number]

export const TERMINAL_TASK_STAGES = new Set<TaskStage>([
  'completed',
  'already_exists',
  'failed',
  'cancelled',
  'interrupted',
])

export function isTerminalTaskStage(stage: TaskStage): boolean {
  return TERMINAL_TASK_STAGES.has(stage)
}

export const NON_CANCELLABLE_TASK_STAGES = new Set<TaskStage>([
  'marking_account_banned',
  'confirming_account_banned',
  'applying_oauth_credentials',
  'confirming_reauthorization',
  'reauthorization_result_uncertain',
  'creating_account',
  'confirming_account',
  'create_result_uncertain',
  ...TERMINAL_TASK_STAGES,
])

export function canCancelTaskStage(stage: TaskStage): boolean {
  return !NON_CANCELLABLE_TASK_STAGES.has(stage)
}
