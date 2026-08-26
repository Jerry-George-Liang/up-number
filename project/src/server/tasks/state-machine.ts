import type { PublicTask } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import { canCancelTaskStage, isTerminalTaskStage, type TaskStage } from '../../shared/task-state'

const TRANSITIONS: Record<TaskStage, TaskStage[]> = {
  draft: ['validating'],
  validating: ['loading_target_account', 'loading_options'],
  loading_target_account: ['loading_options'],
  loading_options: ['checking_existing', 'mail_baseline', 'resolving_proxy'],
  checking_existing: ['mail_baseline', 'resolving_proxy', 'already_exists'],
  mail_baseline: ['resolving_proxy'],
  resolving_proxy: ['generating_auth_url'],
  generating_auth_url: ['authorization_url_received'],
  authorization_url_received: ['browser_started', 'resolving_proxy'],
  browser_started: ['authorization_url_opened', 'resolving_proxy'],
  authorization_url_opened: ['email_submitted', 'manual_intervention'],
  email_submitted: ['waiting_for_otp', 'waiting_for_password'],
  waiting_for_password: ['password_submitted', 'manual_intervention'],
  password_submitted: ['waiting_for_totp', 'waiting_for_consent', 'waiting_for_callback', 'manual_intervention'],
  waiting_for_totp: ['totp_submitted', 'manual_intervention'],
  totp_submitted: ['waiting_for_consent', 'manual_intervention'],
  waiting_for_otp: ['otp_submitted', 'resending_otp', 'manual_intervention'],
  resending_otp: ['waiting_for_otp_retry', 'otp_submitted', 'waiting_for_callback', 'manual_intervention'],
  waiting_for_otp_retry: ['otp_submitted', 'resending_otp_second', 'manual_intervention'],
  resending_otp_second: ['waiting_for_otp_third', 'otp_submitted', 'waiting_for_callback', 'manual_intervention'],
  waiting_for_otp_third: ['otp_submitted', 'manual_intervention'],
  otp_submitted: ['waiting_for_consent'],
  waiting_for_consent: ['consent_submitted', 'manual_intervention'],
  consent_submitted: ['waiting_for_callback'],
  account_deactivated_retrying: ['generating_auth_url'],
  account_deactivated_confirmed: ['locating_deactivated_account'],
  locating_deactivated_account: ['marking_account_banned'],
  marking_account_banned: ['confirming_account_banned'],
  confirming_account_banned: [],
  waiting_for_callback: ['exchanging_code'],
  manual_intervention: ['authorization_url_opened', 'waiting_for_consent', 'waiting_for_callback'],
  exchanging_code: ['checking_duplicate', 'applying_oauth_credentials'],
  applying_oauth_credentials: ['confirming_reauthorization', 'reauthorization_result_uncertain'],
  confirming_reauthorization: ['completed'],
  reauthorization_result_uncertain: ['completed'],
  checking_duplicate: ['creating_account', 'already_exists'],
  creating_account: ['confirming_account', 'create_result_uncertain'],
  confirming_account: ['completed', 'create_result_uncertain'],
  create_result_uncertain: ['completed'],
  completed: [],
  already_exists: [],
  failed: [],
  cancelled: [],
  interrupted: [],
}

export type TaskUpdate = Partial<
  Pick<
    PublicTask,
    'selection' | 'authorization' | 'deactivation' | 'terminalFromStage' | 'account' | 'error' | 'message' | 'manualTakeover'
  >
>

const OPENAI_AUTHORIZATION_STAGES = new Set<TaskStage>([
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
  'waiting_for_callback',
  'manual_intervention',
  'account_deactivated_retrying',
])

export class TaskStateMachine {
  #task: PublicTask

  constructor(
    task: PublicTask,
    private readonly save: (task: PublicTask) => void,
    private readonly emit: (task: PublicTask) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#task = structuredClone(task)
  }

  get current(): PublicTask {
    return structuredClone(this.#task)
  }

  transition(stage: TaskStage, update: TaskUpdate = {}): PublicTask {
    const from = this.#task.stage
    const terminalTransition = stage === 'failed' || stage === 'cancelled'
    const deactivationTransition =
      OPENAI_AUTHORIZATION_STAGES.has(from) &&
      (stage === 'account_deactivated_retrying' || stage === 'account_deactivated_confirmed')
    if (
      isTerminalTaskStage(from) ||
      (!terminalTransition && !deactivationTransition && !TRANSITIONS[from].includes(stage))
    ) {
      throw new AppError('TASK_STATE_INVALID', `任务状态不能从 ${from} 变更为 ${stage}。`, { statusCode: 409 })
    }
    const status: PublicTask['status'] =
      stage === 'completed' || stage === 'already_exists'
        ? 'success'
        : stage === 'failed' || stage === 'interrupted'
          ? 'error'
          : stage === 'cancelled'
            ? 'cancelled'
            : 'active'
    const terminalFromStage = terminalTransition
      ? update.terminalFromStage ?? this.#task.terminalFromStage ?? from
      : update.terminalFromStage ?? this.#task.terminalFromStage
    this.#task = {
      ...this.#task,
      ...structuredClone(update),
      ...(terminalFromStage ? { terminalFromStage } : {}),
      stage,
      status,
      ...(status === 'active' ? {} : { manualTakeover: false }),
      updatedAt: this.now().toISOString(),
    }
    const snapshot = this.current
    this.save(snapshot)
    this.emit(snapshot)
    return snapshot
  }

  update(update: TaskUpdate): PublicTask {
    if (isTerminalTaskStage(this.#task.stage)) {
      throw new AppError('TASK_STATE_INVALID', '已结束的任务不能更新。', { statusCode: 409 })
    }
    this.#task = {
      ...this.#task,
      ...structuredClone(update),
      updatedAt: this.now().toISOString(),
    }
    const snapshot = this.current
    this.save(snapshot)
    this.emit(snapshot)
    return snapshot
  }

  canCancel(): boolean {
    return canCancelTaskStage(this.#task.stage)
  }

  cancel(): PublicTask {
    if (!this.canCancel()) {
      throw new AppError('TASK_CANCEL_NOT_ALLOWED', '后台账号写操作已经开始，当前任务不能取消。', {
        statusCode: 409,
      })
    }
    return this.transition('cancelled', {
      terminalFromStage: this.#task.stage,
      message: `任务已取消。取消前：${this.#task.message}`,
      error: null,
    })
  }
}
