import type { DatabaseSync } from 'node:sqlite'

function ensureTaskColumn(database: DatabaseSync, name: string, definition: string): void {
  const columns = database.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{ name: string }>
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`)
  }
}

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      account_email TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      selection_json TEXT NOT NULL,
      authorization_json TEXT,
      deactivation_json TEXT,
      terminal_from_stage TEXT,
      account_json TEXT,
      error_json TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  ensureTaskColumn(database, 'authorization_json', 'TEXT')
  ensureTaskColumn(database, 'deactivation_json', 'TEXT')
  ensureTaskColumn(database, 'terminal_from_stage', 'TEXT')
}
