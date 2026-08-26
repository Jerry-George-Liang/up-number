import { Entry } from '@napi-rs/keyring'

export type StoredBackendCredentialMode = 'refresh' | 'access'

export interface StoredBackendCredential {
  version: 1
  mode: StoredBackendCredentialMode
  token: string
}

export interface DecodedBackendCredential {
  credential: StoredBackendCredential
  legacy: boolean
}

export function encodeBackendCredential(credential: StoredBackendCredential): string {
  return JSON.stringify(credential)
}

export function decodeBackendCredential(value: string): DecodedBackendCredential | null {
  if (!value) return null
  if (!value.trimStart().startsWith('{')) {
    return { credential: { version: 1, mode: 'refresh', token: value }, legacy: true }
  }
  try {
    const parsed = JSON.parse(value) as Partial<StoredBackendCredential>
    if (
      parsed.version !== 1 ||
      (parsed.mode !== 'refresh' && parsed.mode !== 'access') ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      return null
    }
    return { credential: parsed as StoredBackendCredential, legacy: false }
  } catch {
    return null
  }
}

export interface CredentialStore {
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

export class KeychainCredentialStore implements CredentialStore {
  constructor(private readonly service = 'up-icloud.coding-session') {}

  async get(account: string): Promise<string | null> {
    try {
      return new Entry(this.service, account).getPassword()
    } catch {
      return null
    }
  }

  async set(account: string, value: string): Promise<void> {
    new Entry(this.service, account).setPassword(value)
  }

  async delete(account: string): Promise<void> {
    try {
      new Entry(this.service, account).deletePassword()
    } catch {
      // Deleting an already-missing credential is idempotent.
    }
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>()

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value)
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account)
  }
}
