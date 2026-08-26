import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  OAuthNavigationDiagnostics,
  OAuthRedirectShape,
  OAuthUrlShape,
  PublicTask,
} from '../../shared/contracts'
import type { TaskStage } from '../../shared/task-state'
import { runMigrations } from './migrations'

interface TaskRow {
  id: string
  account_email: string
  stage: PublicTask['stage']
  status: PublicTask['status']
  selection_json: string
  authorization_json: string | null
  deactivation_json: string | null
  terminal_from_stage: string | null
  account_json: string | null
  error_json: string | null
  message: string
  created_at: string
  updated_at: string
}

function parseOAuthUrlShape(value: unknown): OAuthUrlShape | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.origin !== 'string' ||
    typeof raw.path !== 'string' ||
    typeof raw.totalLength !== 'number' ||
    typeof raw.parameterCount !== 'number' ||
    !Array.isArray(raw.parameterNames) ||
    !raw.parameterNames.every((name) => typeof name === 'string') ||
    typeof raw.parameterFingerprint !== 'string'
  ) {
    return null
  }
  return {
    origin: raw.origin,
    path: raw.path,
    totalLength: raw.totalLength,
    parameterCount: raw.parameterCount,
    parameterNames: raw.parameterNames,
    parameterFingerprint: raw.parameterFingerprint,
  }
}

function parseOAuthRedirectShape(value: unknown): OAuthRedirectShape | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.origin !== 'string' || typeof raw.path !== 'string') return null
  return { origin: raw.origin, path: raw.path }
}

function parseOAuthNavigationDiagnostics(value: unknown): OAuthNavigationDiagnostics | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const generated = parseOAuthUrlShape(raw.generated)
  if (!generated) return null
  return {
    generated,
    initialNavigation: parseOAuthUrlShape(raw.initialNavigation),
    redirect: parseOAuthRedirectShape(raw.redirect),
  }
}

function parseAuthorizationProgress(value: string | null): PublicTask['authorization'] {
  if (!value) return null
  const raw = JSON.parse(value) as Record<string, unknown>
  const diagnostics = parseOAuthNavigationDiagnostics(raw.diagnostics)
  return {
    source: 'backend_generate_auth_url',
    // Legacy rows only stored a display URL and passed the earlier partial validator.
    validated: raw.validated === true,
    // Legacy rows opened a browser but did not verify the first Chrome navigation request.
    navigationValidated: raw.navigationValidated === true,
    receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : '',
    browserOpenedAt: typeof raw.browserOpenedAt === 'string' ? raw.browserOpenedAt : null,
    urlOpenedAt: typeof raw.urlOpenedAt === 'string' ? raw.urlOpenedAt : null,
    ...(diagnostics ? { diagnostics } : {}),
  }
}

function parseTaskRow(row: TaskRow): PublicTask {
  const selection = JSON.parse(row.selection_json) as PublicTask['selection']
  selection.operation ??= 'create'
  if (selection.operation === 'create') {
    selection.allowDuplicateCreation ??= false
    selection.confirmMixedChannelRisk ??= false
  } else {
    selection.maxUsage7dPercent ??= 90
  }
  return {
    id: row.id,
    accountEmail: row.account_email,
    stage: row.stage,
    status: row.status,
    selection,
    authorization: parseAuthorizationProgress(row.authorization_json),
    deactivation: row.deactivation_json
      ? (JSON.parse(row.deactivation_json) as PublicTask['deactivation'])
      : null,
    terminalFromStage: (row.terminal_from_stage as TaskStage | null) ?? null,
    account: row.account_json ? (JSON.parse(row.account_json) as PublicTask['account']) : null,
    error: row.error_json ? (JSON.parse(row.error_json) as PublicTask['error']) : null,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class TaskDatabase {
  readonly #database: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.#database = new DatabaseSync(path)
    runMigrations(this.#database)
    if (path !== ':memory:') chmodSync(path, 0o600)
  }

  saveTask(task: PublicTask): void {
    this.#database
      .prepare(`
        INSERT INTO tasks (
          id, account_email, stage, status, selection_json, authorization_json,
          deactivation_json, terminal_from_stage, account_json, error_json, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          account_email = excluded.account_email,
          stage = excluded.stage,
          status = excluded.status,
          selection_json = excluded.selection_json,
          authorization_json = excluded.authorization_json,
          deactivation_json = excluded.deactivation_json,
          terminal_from_stage = excluded.terminal_from_stage,
          account_json = excluded.account_json,
          error_json = excluded.error_json,
          message = excluded.message,
          updated_at = excluded.updated_at
      `)
      .run(
        task.id,
        task.accountEmail,
        task.stage,
        task.status,
        JSON.stringify(task.selection),
        task.authorization ? JSON.stringify(task.authorization) : null,
        task.deactivation ? JSON.stringify(task.deactivation) : null,
        task.terminalFromStage ?? null,
        task.account ? JSON.stringify(task.account) : null,
        task.error ? JSON.stringify(task.error) : null,
        task.message,
        task.createdAt,
        task.updatedAt,
      )
  }

  getTask(id: string): PublicTask | null {
    const row = this.#database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? parseTaskRow(row) : null
  }

  listTasks(limit = 50): PublicTask[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
    const rows = this.#database
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as unknown as TaskRow[]
    return rows.map(parseTaskRow)
  }

  deleteTask(id: string): boolean {
    return this.#database.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
  }

  markActiveTasksInterrupted(): number {
    const now = new Date().toISOString()
    return Number(
      this.#database
        .prepare(`
          UPDATE tasks
          SET terminal_from_stage = stage, stage = 'interrupted', status = 'error', message = ?,
              error_json = ?, updated_at = ?
          WHERE status = 'active'
        `)
        .run(
          '本地服务曾中断，此授权任务不能继续，请重新开始。',
          JSON.stringify({
            stage: 'interrupted',
            code: 'TASK_INTERRUPTED',
            message: '本地服务曾中断，此授权任务不能继续，请重新开始。',
            retryable: true,
          }),
          now,
        ).changes,
    )
  }

  getColumnNames(): string[] {
    const rows = this.#database.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  getSetting(key: string): string | null {
    const row = this.#database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.#database
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  deleteSetting(key: string): void {
    this.#database.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  close(): void {
    this.#database.close()
  }
}
