import { afterEach, describe, expect, it } from 'vitest'
import { TaskDatabase } from '../../src/server/storage/database'
import type { PublicTask } from '../../src/shared/contracts'

let database: TaskDatabase | undefined

afterEach(() => database?.close())

function createTask(): PublicTask {
  const now = new Date().toISOString()
  return {
    id: 'task-storage-1',
    accountEmail: 'user@example.invalid',
    stage: 'waiting_for_otp',
    status: 'active',
    selection: {
      operation: 'create',
      proxyMode: 'none',
      concurrency: 10,
      supplier: null,
      groups: [],
      allowDuplicateCreation: false,
      confirmMixedChannelRisk: false,
      modelsCleared: true,
    },
    authorization: null,
    deactivation: null,
    terminalFromStage: null,
    account: null,
    error: null,
    message: '等待验证码',
    createdAt: now,
    updatedAt: now,
  }
}

describe('TaskDatabase', () => {
  it('stores and loads only the public task shape', () => {
    database = new TaskDatabase(':memory:')
    const task = createTask()
    database.saveTask(task)
    expect(database.getTask('task-storage-1')).toEqual(task)
    expect(database.getColumnNames()).not.toEqual(
      expect.arrayContaining(['mailbox_password', 'access_token', 'refresh_token', 'oauth_code']),
    )
    expect(database.getColumnNames()).toEqual(
      expect.arrayContaining(['authorization_json', 'deactivation_json', 'terminal_from_stage']),
    )
  })

  it('persists only the non-secret Chrome navigation verification result', () => {
    database = new TaskDatabase(':memory:')
    const task = createTask()
    task.authorization = {
      source: 'backend_generate_auth_url',
      validated: true,
      navigationValidated: true,
      receivedAt: task.createdAt,
      browserOpenedAt: task.createdAt,
      urlOpenedAt: task.createdAt,
      diagnostics: {
        generated: {
          origin: 'https://auth.openai.com',
          path: '/oauth/authorize',
          totalLength: 400,
          parameterCount: 9,
          parameterNames: ['client_id', 'code_challenge', 'state'],
          parameterFingerprint: '0123456789abcdef',
        },
        initialNavigation: {
          origin: 'https://auth.openai.com',
          path: '/oauth/authorize',
          totalLength: 400,
          parameterCount: 9,
          parameterNames: ['client_id', 'code_challenge', 'state'],
          parameterFingerprint: '0123456789abcdef',
        },
        redirect: { origin: 'https://auth.openai.com', path: '/log-in' },
      },
    }
    database.saveTask(task)

    expect(database.getTask(task.id)?.authorization).toEqual(task.authorization)
    expect(JSON.stringify(database.getTask(task.id))).not.toMatch(
      /synthetic-client|expected-state|redirect_uri=http|session_id|state=/,
    )
  })

  it('persists structured account-deactivation progress', () => {
    database = new TaskDatabase(':memory:')
    const task = createTask()
    task.deactivation = {
      detectedCount: 2,
      retryAttempted: true,
      confirmed: true,
      targetAccountId: 71,
      banResult: 'banned',
    }
    database.saveTask(task)

    expect(database.getTask(task.id)?.deactivation).toEqual(task.deactivation)
  })

  it('marks active tasks interrupted on restart', () => {
    database = new TaskDatabase(':memory:')
    database.saveTask(createTask())
    expect(database.markActiveTasksInterrupted()).toBe(1)
    expect(database.getTask('task-storage-1')).toMatchObject({
      stage: 'interrupted',
      status: 'error',
      terminalFromStage: 'waiting_for_otp',
    })
  })

  it('loads a legacy selection without an operation as an add-account task', () => {
    database = new TaskDatabase(':memory:')
    const task = createTask()
    delete (task.selection as unknown as { operation?: string }).operation
    database.saveTask(task)

    expect(database.getTask(task.id)?.selection).toMatchObject({
      operation: 'create',
      allowDuplicateCreation: false,
      confirmMixedChannelRisk: false,
    })
  })

  it('defaults a legacy reauthorization selection to the 90 percent threshold', () => {
    database = new TaskDatabase(':memory:')
    const task = createTask()
    task.selection = {
      operation: 'reauthorize',
      targetAccountId: 71,
    } as PublicTask['selection']
    database.saveTask(task)

    expect(database.getTask(task.id)?.selection).toEqual({
      operation: 'reauthorize',
      targetAccountId: 71,
      maxUsage7dPercent: 90,
    })
  })
})
