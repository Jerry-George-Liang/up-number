import type { AccountPoolMaterials, AccountPoolResolver } from './bridge-client'
import type { AccountPoolPortalService } from './portal'

export class ConfiguredAccountPoolResolver implements AccountPoolResolver {
  constructor(
    private readonly portal: AccountPoolPortalService,
    private readonly fallback: AccountPoolResolver,
  ) {}

  resolve(email: string, signal?: AbortSignal): Promise<AccountPoolMaterials> {
    return this.portal.status().configured
      ? this.portal.resolve(email, signal)
      : this.fallback.resolve(email, signal)
  }
}
