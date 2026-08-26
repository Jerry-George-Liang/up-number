import { describe, expect, it, vi } from 'vitest'
import type { PublicTask } from '../../src/shared/contracts'
import { ReauthorizationHostingService } from '../../src/server/tasks/reauthorization-hosting'

function task(id: string, accountId: number, stage: PublicTask['stage'] = 'validating'): PublicTask {
  return {
    id,
    accountEmail: `user${accountId}@example.invalid`,
    stage,
    status: stage === 'completed' ? 'success' : stage === 'failed' ? 'error' : 'active',
    selection: {
      operation: 'reauthorize', targetAccountId: accountId, targetAccountName: `user${accountId}`,
      statusBefore: 'error', maxUsage7dPercent: 90, proxyMode: 'existing',
    },
    authorization: null, deactivation: null, account: null, error: null, message: stage,
    createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
  }
}

function setup(ids = [1, 2]) {
  const settings = new Map<string, string>()
  const setSetting = vi.fn((key: string, value: string) => settings.set(key, value))
  const tasks = new Map<string, PublicTask>()
  const listeners = new Set<(value: PublicTask) => void>()
  let active: PublicTask | null = null
  let sequence = 0
  const startTask = vi.fn((input: any) => {
    active = task(`task-${++sequence}`, input.accountId)
    tasks.set(active.id, active)
    return active
  })
  const cancelTask = vi.fn((id: string) => {
    const current = tasks.get(id)
    if (!current) throw new Error('task missing')
    const cancelled = { ...current, stage: 'cancelled' as const, status: 'cancelled' as const }
    active = null
    tasks.set(id, cancelled)
    listeners.forEach((listener) => listener(cancelled))
    return cancelled
  })
  const service = new ReauthorizationHostingService({
    settings: {
      getSetting: (key) => settings.get(key) ?? null,
      setSetting,
    },
    listAccounts: vi.fn(async ({ page }) => ({
      items: page === 1 ? ids.map((id) => ({ id, name: `user${id}`, email: `user${id}@example.invalid`, status: 'error', usage7dPercent: 10 })) : [],
      page, pageSize: 100, total: ids.length, pages: ids.length ? 1 : 0,
    })),
    getAccount: vi.fn(async (id) => ({ id, name: `user${id}`, email: `user${id}@example.invalid`, status: 'error', usage7dPercent: 10 })),
    startTask,
    getActiveTask: () => active,
    getTask: (id) => tasks.get(id) ?? null,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    cancelTask,
  })
  const emit = (next: PublicTask) => {
    active = next.status === 'active' ? next : null
    tasks.set(next.id, next)
    listeners.forEach((listener) => listener(next))
  }
  return { service, startTask, cancelTask, emit, settings, setSetting }
}

async function tick() { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('ReauthorizationHostingService', () => {
  it('stops and drains the hosting loop before shutdown returns', async () => {
    const { service, cancelTask, setSetting } = setup([1, 2])
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()

    await service.shutdown()

    expect(cancelTask).toHaveBeenCalledWith('task-1')
    expect(service.getState()).toMatchObject({ status: 'stopped', currentTaskId: null })
    const writesAfterShutdown = setSetting.mock.calls.length
    await tick()
    expect(setSetting).toHaveBeenCalledTimes(writesAfterShutdown)
  })

  it('does not persist a late account-loading failure after shutdown starts', async () => {
    let rejectAccount!: (error: Error) => void
    const pendingAccount = new Promise<never>((_resolve, reject) => { rejectAccount = reject })
    const { service, setSetting } = setup([1])
    const dependencies = service as unknown as { dependencies: { getAccount: () => Promise<never> } }
    dependencies.dependencies.getAccount = () => pendingAccount
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()

    const shutdown = service.shutdown()
    rejectAccount(new Error('late account failure'))
    await shutdown
    const writesAfterShutdown = setSetting.mock.calls.length
    await tick()

    expect(service.getState().status).toBe('stopped')
    expect(setSetting).toHaveBeenCalledTimes(writesAfterShutdown)
  })

  it('runs matching accounts strictly one at a time and continues after completion', async () => {
    const { service, startTask, emit } = setup()
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    expect(startTask).toHaveBeenCalledTimes(1)
    emit(task('task-1', 1, 'completed'))
    await tick()
    expect(startTask).toHaveBeenCalledTimes(2)
    emit(task('task-2', 2, 'failed'))
    await tick()
    expect(service.getState()).toMatchObject({ status: 'completed', completed: 1, failed: 1, banned: 0, total: 2 })
  })

  it('counts an explicitly confirmed deactivated account as banned instead of failed', async () => {
    const { service, emit } = setup([1])
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    const banned = task('task-1', 1, 'failed')
    banned.error = {
      stage: 'confirming_account_banned',
      code: 'OPENAI_ACCOUNT_DEACTIVATED_BANNED',
      message: '账号已确认停用。',
      retryable: false,
    }
    emit(banned)
    await tick()
    expect(service.getState()).toMatchObject({
      status: 'completed', completed: 0, failed: 0, banned: 1, skipped: 0,
      lastAccountId: 1, lastResult: 'banned',
    })
  })

  it('shows an artificial pause and resumes without starting another account', async () => {
    const { service, startTask, emit } = setup()
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    emit(task('task-1', 1, 'manual_intervention'))
    expect(service.getState()).toMatchObject({ status: 'paused', currentTaskId: 'task-1' })
    expect(startTask).toHaveBeenCalledTimes(1)
    emit(task('task-1', 1, 'waiting_for_callback'))
    expect(service.getState().status).toBe('running')
  })

  it('automatically skips an account after all three OTP rounds are exhausted', async () => {
    const { service, startTask, cancelTask, emit } = setup()
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    const exhausted = task('task-1', 1, 'manual_intervention')
    exhausted.message = '三轮等待结束，仍未取得可安全使用的最新验证码。授权浏览器已保留。'
    emit(exhausted)
    await tick()
    expect(cancelTask).toHaveBeenCalledWith('task-1')
    expect(service.getState()).toMatchObject({ status: 'running', skipped: 1, failed: 0 })
    expect(startTask).toHaveBeenCalledTimes(2)
  })

  it('stops after the current account without cancelling it or starting the next', async () => {
    const { service, startTask, emit } = setup()
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    expect(service.stop().status).toBe('stopping')
    emit(task('task-1', 1, 'completed'))
    await tick()
    expect(service.getState().status).toBe('stopped')
    expect(startTask).toHaveBeenCalledTimes(1)
  })

  it('counts the cancelled current account as skipped and continues with the next', async () => {
    const { service, startTask, cancelTask } = setup()
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    service.skipCurrent()
    await tick()
    expect(cancelTask).toHaveBeenCalledWith('task-1')
    expect(service.getState()).toMatchObject({ status: 'running', skipped: 1, failed: 0 })
    expect(startTask).toHaveBeenCalledTimes(2)
  })

  it('persists manually excluded accounts and omits them when hosting starts', async () => {
    const { service, startTask } = setup([1, 2])
    expect(service.setAccountExcluded(1, true)).toBe(true)
    expect(service.excludedAccountIds()).toEqual([1])
    expect(service.decorateAccount({
      id: 1, name: 'user1', email: 'user1@example.invalid', status: 'error', usage7dPercent: 10,
    })).toMatchObject({ excludedFromHosting: true })

    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    expect(startTask).toHaveBeenCalledTimes(1)
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ accountId: 2 })
    expect(service.getState().total).toBe(1)
  })

  it('skips a queued account if it is manually excluded while hosting is running', async () => {
    const { service, startTask, emit } = setup([1, 2])
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    await tick()
    service.setAccountExcluded(2, true)
    emit(task('task-1', 1, 'completed'))
    await tick()
    expect(startTask).toHaveBeenCalledTimes(1)
    expect(service.getState()).toMatchObject({ status: 'completed', completed: 1, skipped: 1, total: 2 })
  })

  it('does not start an account when stopped while its details are loading', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service, startTask } = setup([1])
    const dependencies = service as unknown as { dependencies: { getAccount: (id: number) => Promise<unknown> } }
    const original = dependencies.dependencies.getAccount
    dependencies.dependencies.getAccount = async (id) => { await gate; return original(id) }
    await service.start({ search: '', maxUsage7dPercent: 90, proxyMode: 'existing' })
    service.stop()
    release()
    await tick()
    expect(startTask).not.toHaveBeenCalled()
    expect(service.getState().status).toBe('stopped')
  })

  it('persists only queue metadata and no login materials', async () => {
    const { service, settings } = setup([1])
    await service.start({ search: 'user', maxUsage7dPercent: 80, proxyMode: 'none' })
    await tick()
    const serialized = [...settings.values()].join(' ')
    expect(serialized).toContain('pendingAccountIds')
    expect(serialized).not.toMatch(/password|totp|mailboxAccess|loginMaterial/i)
  })
})
