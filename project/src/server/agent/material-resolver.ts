import { AppError } from '../../shared/errors'
import type { AccountPoolMaterials, AccountPoolResolver } from '../account-pool/bridge-client'

interface RemoteMaterialSlot {
  scope: string
  email: string
  materials: AccountPoolMaterials
}

export class RoutedAccountPoolResolver implements AccountPoolResolver {
  #remote: RemoteMaterialSlot | null = null

  constructor(private readonly fallback: AccountPoolResolver) {}

  activate(scope: string, email: string, materials: AccountPoolMaterials): void {
    if (this.#remote) {
      throw new AppError('AGENT_MATERIALS_BUSY', '本地执行助手已有任务材料正在使用。', {
        statusCode: 409,
      })
    }
    this.#remote = { scope, email: email.trim().toLowerCase(), materials }
  }

  clear(scope: string): void {
    if (this.#remote?.scope !== scope) return
    this.#remote = null
  }

  async resolve(email: string, signal?: AbortSignal, scope?: string): Promise<AccountPoolMaterials> {
    const normalized = email.trim().toLowerCase()
    if (scope) {
      if (!this.#remote || this.#remote.scope !== scope) {
        throw new AppError('AGENT_MATERIALS_SCOPE_MISMATCH', '中央任务材料作用域无效。', {
          statusCode: 409,
        })
      }
      if (this.#remote.email !== normalized) {
        throw new AppError('AGENT_MATERIALS_EMAIL_MISMATCH', '中央任务材料与本地任务邮箱不一致。', {
          statusCode: 409,
        })
      }
      return { ...this.#remote.materials }
    }
    return this.fallback.resolve(email, signal)
  }
}
