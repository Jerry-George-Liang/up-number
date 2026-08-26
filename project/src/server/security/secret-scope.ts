export class SecretScope {
  #values = new Map<string, unknown>()
  #disposed = false

  set<T>(key: string, value: T): T {
    if (this.#disposed) throw new Error('SecretScope is disposed')
    this.#values.set(key, value)
    return value
  }

  get<T>(key: string): T | undefined {
    if (this.#disposed) return undefined
    return this.#values.get(key) as T | undefined
  }

  require<T>(key: string): T {
    const value = this.get<T>(key)
    if (value === undefined) throw new Error(`Missing secret value: ${key}`)
    return value
  }

  dispose(): void {
    this.#values.clear()
    this.#disposed = true
  }

  get disposed(): boolean {
    return this.#disposed
  }
}
