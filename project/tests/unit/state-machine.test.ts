import { describe, expect, it, vi } from 'vitest'
import type { PublicTask } from '../../src/shared/contracts'
import { TaskStateMachine } from '../../src/server/tasks/state-machine'

function task(): PublicTask {
  const now = '2026-08-11T08:00:00.000Z'
  return {
    id: 'task-state-1',
    accountEmail: 'user@example.invalid',
    stage: 'validating',
    status: 'active',
    selection: {
      operation: 'create',
      proxyMode: 'none',
      concurrency: 10,
      supplier: null,
      groups: [],
      modelsCleared: true,
    },
    account: null,
    error: null,
    message: '正在校验任务',
    createdAt: now,
    updatedAt: now,
  }
}

describe('TaskStateMachine', () => {
  it('persists and emits every allowed public transition', () => {
    const save = vi.fn()
    const emit = vi.fn()
    const machine = new TaskStateMachine(task(), save, emit, () => new Date('2026-08-11T08:00:01.000Z'))
    machine.transition('loading_options', { message: '加载选项' })
    machine.transition('checking_existing')
    expect(machine.current).toMatchObject({ stage: 'checking_existing', status: 'active' })
    expect(save).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('rejects skipped or backwards state changes', () => {
    const machine = new TaskStateMachine(task(), vi.fn(), vi.fn())
    expect(() => machine.transition('creating_account')).toThrow(/状态/)
    machine.transition('loading_options')
    expect(() => machine.transition('validating')).toThrow(/状态/)
  })

  it('allows the password and authenticator branch after email submission', () => {
    const machine = new TaskStateMachine(
      { ...task(), stage: 'email_submitted' },
      vi.fn(),
      vi.fn(),
    )
    machine.transition('waiting_for_password')
    machine.transition('password_submitted')
    machine.transition('waiting_for_totp')
    machine.transition('totp_submitted')
    machine.transition('waiting_for_consent')
    expect(machine.current.stage).toBe('waiting_for_consent')
  })

  it('allows cancellation only before account creation starts', () => {
    const cancellable = new TaskStateMachine(task(), vi.fn(), vi.fn())
    expect(cancellable.canCancel()).toBe(true)
    cancellable.cancel()
    expect(cancellable.current).toMatchObject({
      stage: 'cancelled',
      status: 'cancelled',
      terminalFromStage: 'validating',
      message: expect.stringContaining('取消前'),
    })

    const creatingTask = { ...task(), stage: 'creating_account' as const }
    const creating = new TaskStateMachine(creatingTask, vi.fn(), vi.fn())
    expect(creating.canCancel()).toBe(false)
    expect(() => creating.cancel()).toThrow(expect.objectContaining({ code: 'TASK_CANCEL_NOT_ALLOWED' }))
  })

  it('accepts user progress from OTP resend directly to consent preparation', () => {
    const machine = new TaskStateMachine({ ...task(), stage: 'resending_otp' }, vi.fn(), vi.fn())
    machine.transition('otp_submitted')
    expect(machine.current).toMatchObject({ stage: 'otp_submitted', status: 'active' })
  })

  it('allows two verified resends before the third OTP polling round', () => {
    const machine = new TaskStateMachine({ ...task(), stage: 'waiting_for_otp' }, vi.fn(), vi.fn())
    machine.transition('resending_otp')
    machine.transition('waiting_for_otp_retry')
    machine.transition('resending_otp_second')
    machine.transition('waiting_for_otp_third')
    machine.transition('otp_submitted')
    expect(machine.current).toMatchObject({ stage: 'otp_submitted', status: 'active' })
  })

  it('allows automation to resume from manual intervention', () => {
    const fromKnownPage = new TaskStateMachine(
      { ...task(), stage: 'manual_intervention' },
      vi.fn(),
      vi.fn(),
    )
    fromKnownPage.transition('authorization_url_opened')
    fromKnownPage.transition('email_submitted')
    expect(fromKnownPage.current.stage).toBe('email_submitted')

    const fromConsent = new TaskStateMachine(
      { ...task(), stage: 'manual_intervention' },
      vi.fn(),
      vi.fn(),
    )
    fromConsent.transition('waiting_for_consent')
    expect(fromConsent.current.stage).toBe('waiting_for_consent')
  })

  it('allows one deactivation retry and then enters the non-cancellable ban write stages', () => {
    const retry = new TaskStateMachine({ ...task(), stage: 'waiting_for_callback' }, vi.fn(), vi.fn())
    retry.transition('account_deactivated_retrying')
    retry.transition('generating_auth_url')
    retry.transition('authorization_url_received')
    expect(retry.current.stage).toBe('authorization_url_received')

    const confirmed = new TaskStateMachine({ ...task(), stage: 'waiting_for_callback' }, vi.fn(), vi.fn())
    confirmed.transition('account_deactivated_confirmed')
    confirmed.transition('locating_deactivated_account')
    confirmed.transition('marking_account_banned')
    expect(confirmed.canCancel()).toBe(false)
    confirmed.transition('confirming_account_banned')
    expect(confirmed.canCancel()).toBe(false)
  })
})
