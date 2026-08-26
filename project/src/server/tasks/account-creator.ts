import type { AccountResult, Concurrency } from '../../shared/contracts'
import type {
  BackendAccount,
  BackendAccountsApi,
  OpenAIAccountCreatePayload,
  OpenAICredentials,
} from '../backend/accounts'

export interface BuildAccountPayloadInput {
  email: string
  credentials: OpenAICredentials
  proxyId?: number
  machineId?: number
  assignmentMode?: 'random_fixed' | 'dynamic'
  subscriptionId?: number
  concurrency: Concurrency
  supplier: string | null
  groupIds: number[]
  confirmMixedChannelRisk: boolean
}

export function buildOpenAIAccountPayload(input: BuildAccountPayloadInput): OpenAIAccountCreatePayload {
  const normalizedEmail = input.email.trim().toLowerCase()
  const { name, privacy_mode, ...credentials } = input.credentials
  return {
    name: normalizedEmail,
    notes: '',
    supplier: input.supplier,
    platform: 'openai',
    type: 'oauth',
    credentials,
    extra: {
      email: input.credentials.email ?? normalizedEmail,
      name: name ?? input.credentials.email ?? normalizedEmail,
      ...(privacy_mode ? { privacy_mode } : {}),
      openai_oauth_responses_websockets_v2_mode: 'off',
      openai_oauth_responses_websockets_v2_enabled: false,
      openai_long_context_billing_enabled: false,
    },
    proxy_id: input.proxyId ?? null,
    machine_id: input.machineId ?? null,
    ...(input.assignmentMode ? { proxy_assignment_mode: input.assignmentMode } : {}),
    ...(input.subscriptionId ? { proxy_subscription_id: input.subscriptionId } : {}),
    concurrency: input.concurrency,
    priority: 1,
    rate_multiplier: 1,
    group_ids: [...input.groupIds],
    expires_at: null,
    auto_pause_on_expired: true,
    random_rest_enabled: false,
    ...(input.confirmMixedChannelRisk ? { confirm_mixed_channel_risk: true } : {}),
  }
}

export interface AccountBackend {
  findAccounts(email: string): Promise<BackendAccount[]>
  createAccount(payload: OpenAIAccountCreatePayload): Promise<BackendAccount>
  getAccount(id: number): Promise<BackendAccount>
}

function isOpenAIOAuth(account: BackendAccount): boolean {
  return (!account.platform || account.platform.toLowerCase() === 'openai') &&
    (!account.type || account.type.toLowerCase() === 'oauth')
}

export class AccountCreator {
  constructor(private readonly backend: AccountBackend | BackendAccountsApi) {}

  async findExactDuplicate(email: string): Promise<BackendAccount | null> {
    const normalized = email.trim().toLowerCase()
    const candidates = await this.backend.findAccounts(normalized)
    return (
      candidates.find(
        (account) =>
          isOpenAIOAuth(account) &&
          (account.name.trim().toLowerCase() === normalized ||
            account.credentialEmail?.trim().toLowerCase() === normalized),
      ) ?? null
    )
  }

  async createAndConfirm(payload: OpenAIAccountCreatePayload): Promise<AccountResult> {
    const created = await this.backend.createAccount(payload)
    const confirmed = await this.backend.getAccount(created.id)
    return { id: confirmed.id, name: confirmed.name, status: confirmed.status }
  }
}
