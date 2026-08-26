import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type {
  AccountResult,
  ReauthorizationAccountPage,
  ReauthorizationAccountSummary,
} from '../../shared/contracts'
import { DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import { deriveOAuthNavigationContract } from '../browser/callback-capture'
import type { BackendRequester } from './client'

const oauthCredentialsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_at: z.union([z.number(), z.string().min(1)]).optional(),
  email: z.string().email().optional(),
  chatgpt_account_id: z.string().min(1).optional(),
  chatgpt_user_id: z.string().min(1).optional(),
  organization_id: z.string().min(1).optional(),
  plan_type: z.string().min(1).optional(),
  subscription_expires_at: z.union([z.number(), z.string().min(1)]).optional(),
  client_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  privacy_mode: z.string().min(1).optional(),
})

const mixedChannelSchema = z.object({ has_risk: z.boolean() }).passthrough()

const authUrlSchema = z.object({
  auth_url: z.url(),
  session_id: z.string().min(1),
})

const backendAccountSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    notes: z.string().nullish(),
    status: z.string().min(1),
    management_status: z.string().min(1).optional(),
    platform: z.string().optional(),
    type: z.string().optional(),
    email: z.string().email().optional(),
    credentials: z
      .object({
        email: z.string().email().optional(),
        access_token: z.string().min(1).optional(),
        refresh_token: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    extra: z
      .object({
        email: z.string().email().optional(),
        codex_7d_used_percent: z.union([z.number(), z.string()]).nullish(),
      })
      .passthrough()
      .optional(),
    proxy_id: z.number().int().positive().nullish(),
    machine_id: z.number().int().positive().nullish(),
    created_at: z.string().min(1).nullish(),
    updated_at: z.string().min(1).nullish(),
  })
  .passthrough()

const backendAccountPageSchema = z
  .object({
    items: z.array(z.unknown()),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
    pages: z.number().int().nonnegative().optional(),
  })
  .passthrough()

const backendAccountUsageSchema = z
  .object({
    seven_day: z
      .object({
        utilization: z.union([z.number(), z.string()]),
      })
      .passthrough(),
  })
  .passthrough()

export type OpenAICredentials = z.infer<typeof oauthCredentialsSchema>

export interface GeneratedAuth {
  authUrl: string
  sessionId: string
  state: string
}

export interface GenerateAuthUrlInput {
  proxyId?: number
  machineId?: number
  redirectUri?: string
}

export interface ExchangeCodeInput {
  sessionId: string
  code: string
  state: string
  proxyId?: number
}

export interface BackendAccount extends AccountResult {
  notes?: string
  managementStatus?: string
  platform?: string
  type?: string
  credentialEmail?: string
  extraEmail?: string
  proxyId?: number
  machineId?: number
  createdAt?: string
  updatedAt?: string
  codex7dUsedPercent?: number
}

export interface OAuthCredentialsApplicationPayload {
  type: 'oauth'
  credentials: Omit<OpenAICredentials, 'name' | 'privacy_mode'>
  extra?: {
    email?: string
    name?: string
    privacy_mode?: string
  }
}

export interface ReauthorizationAccountQuery {
  search: string
  page: number
  pageSize: number
  maxUsage7dPercent: number
  importedWithinDays?: number
  excludedAccountIds?: readonly number[]
}

const REAUTHORIZATION_LIST_CACHE_TTL_MS = 60_000
const REAUTHORIZATION_LIST_CACHE_MAX_ENTRIES = 20
const REAUTHORIZATION_USAGE_CONCURRENCY = 32
const REAUTHORIZATION_USAGE_CACHE_TTL_MS = 15_000

interface ReauthorizationListCacheEntry {
  expiresAt: number
  candidates: Promise<ReauthorizationAccountSummary[]>
}

interface ReauthorizationUsageCacheEntry {
  expiresAt: number
  value: Promise<number>
}

export interface OpenAIAccountCreatePayload {
  name: string
  notes: ''
  supplier: string | null
  platform: 'openai'
  type: 'oauth'
  credentials: Omit<OpenAICredentials, 'name' | 'privacy_mode'>
  extra: {
    email: string
    name: string
    privacy_mode?: string
    openai_oauth_responses_websockets_v2_mode: 'off'
    openai_oauth_responses_websockets_v2_enabled: false
    openai_long_context_billing_enabled: false
  }
  proxy_id: number | null
  machine_id: number | null
  proxy_assignment_mode?: 'random_fixed' | 'dynamic'
  proxy_subscription_id?: number
  concurrency: 1 | 3 | 5 | 10 | 20
  priority: 1
  rate_multiplier: 1
  group_ids: number[]
  expires_at: null
  auto_pause_on_expired: true
  random_rest_enabled: false
  confirm_mixed_channel_risk?: true
}

function normalizeAccount(payload: unknown): BackendAccount {
  const raw =
    payload && typeof payload === 'object' && 'account' in payload
      ? (payload as { account: unknown }).account
      : payload
  const parsed = backendAccountSchema.parse(raw)
  const raw7dUsedPercent = parsed.extra?.codex_7d_used_percent
  const codex7dUsedPercent =
    typeof raw7dUsedPercent === 'number'
      ? raw7dUsedPercent
      : typeof raw7dUsedPercent === 'string' && raw7dUsedPercent.trim()
        ? Number(raw7dUsedPercent)
        : undefined
  return {
    id: parsed.id,
    name: parsed.name,
    ...(parsed.notes != null ? { notes: parsed.notes } : {}),
    status: parsed.status,
    ...(parsed.management_status ? { managementStatus: parsed.management_status } : {}),
    ...(parsed.platform ? { platform: parsed.platform } : {}),
    ...(parsed.type ? { type: parsed.type } : {}),
    ...(parsed.email || parsed.credentials?.email
      ? { credentialEmail: parsed.email ?? parsed.credentials!.email }
      : {}),
    ...(parsed.extra?.email ? { extraEmail: parsed.extra.email } : {}),
    ...(parsed.proxy_id ? { proxyId: parsed.proxy_id } : {}),
    ...(parsed.machine_id ? { machineId: parsed.machine_id } : {}),
    ...(parsed.created_at ? { createdAt: parsed.created_at } : {}),
    ...(parsed.updated_at ? { updatedAt: parsed.updated_at } : {}),
    ...(codex7dUsedPercent !== undefined &&
    Number.isFinite(codex7dUsedPercent) &&
    codex7dUsedPercent >= 0 &&
    codex7dUsedPercent <= 100
      ? { codex7dUsedPercent }
      : {}),
  }
}

function rawAccount(payload: unknown): z.infer<typeof backendAccountSchema> {
  const raw =
    payload && typeof payload === 'object' && 'account' in payload
      ? (payload as { account: unknown }).account
      : payload
  return backendAccountSchema.parse(raw)
}

function accountCollection(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['accounts', 'items', 'list', 'records']) {
    if (Array.isArray(record[key])) return record[key]
  }
  return []
}

export function allowlistOpenAICredentials(payload: unknown): OpenAICredentials {
  return oauthCredentialsSchema.parse(payload)
}

export function buildOAuthCredentialsApplication(
  credentials: OpenAICredentials,
): OAuthCredentialsApplicationPayload {
  const { name, privacy_mode, ...allowedCredentials } = credentials
  const extra = {
    ...(credentials.email ? { email: credentials.email } : {}),
    ...(name ? { name } : {}),
    ...(privacy_mode ? { privacy_mode } : {}),
  }
  return {
    type: 'oauth',
    credentials: allowedCredentials,
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function emailFromAccountName(name: string): string | null {
  const match = name.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match ? normalizeEmail(match[0]) : null
}

export function reauthorizationTargetEmail(account: BackendAccount): string {
  const credentialEmail = account.credentialEmail ? normalizeEmail(account.credentialEmail) : null
  const extraEmail = account.extraEmail ? normalizeEmail(account.extraEmail) : null
  if (credentialEmail && extraEmail && credentialEmail !== extraEmail) {
    throw new AppError('REAUTHORIZATION_TARGET_INVALID', '后台账号的邮箱信息不一致，不能安全重新授权。', {
      statusCode: 409,
    })
  }
  const nameEmail = emailFromAccountName(account.name)
  const email = credentialEmail ?? extraEmail ?? nameEmail
  if (!email) {
    throw new AppError('REAUTHORIZATION_TARGET_INVALID', '后台账号缺少可核对的邮箱，不能安全重新授权。', {
      statusCode: 409,
    })
  }
  return email
}

export function toReauthorizationAccountSummary(
  account: BackendAccount,
  maxUsage7dPercent = DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT,
): ReauthorizationAccountSummary {
  assertReauthorizationEligible(account, maxUsage7dPercent)
  return {
    id: account.id,
    name: account.name,
    email: reauthorizationTargetEmail(account),
    status: account.status,
    usage7dPercent: account.codex7dUsedPercent!,
    importedAt: account.createdAt ?? account.updatedAt ?? null,
    errorAt: account.updatedAt ?? null,
  }
}

function optionalReauthorizationAccountSummary(
  account: BackendAccount,
  maxUsage7dPercent: number,
): ReauthorizationAccountSummary | null {
  try {
    return toReauthorizationAccountSummary(account, maxUsage7dPercent)
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'REAUTHORIZATION_TARGET_INELIGIBLE' ||
        error.code === 'REAUTHORIZATION_TARGET_INVALID')
    ) {
      return null
    }
    throw error
  }
}

export function assertReauthorizationEligible(
  account: BackendAccount,
  maxUsage7dPercent = DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT,
): void {
  if (
    account.status.toLowerCase() !== 'error' ||
    account.codex7dUsedPercent === undefined ||
    account.codex7dUsedPercent > maxUsage7dPercent
  ) {
    throw new AppError(
      'REAUTHORIZATION_TARGET_INELIGIBLE',
      `仅状态为错误且 7 天窗口用量不高于 ${maxUsage7dPercent}% 的账号可以重新授权。`,
      { statusCode: 409 },
    )
  }
}

function secretEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(values[index]!)
      }
    }),
  )
  return results
}

export class BackendAccountsApi {
  private readonly reauthorizationListCache = new Map<string, ReauthorizationListCacheEntry>()
  private readonly reauthorizationUsageCache = new Map<number, ReauthorizationUsageCacheEntry>()

  constructor(private readonly backend: BackendRequester) {}

  private async getLiveUsage7dPercent(id: number): Promise<number> {
    const now = Date.now()
    const cached = this.reauthorizationUsageCache.get(id)
    if (cached && cached.expiresAt > now) return cached.value
    const value = this.fetchLiveUsage7dPercent(id)
    this.reauthorizationUsageCache.set(id, { expiresAt: now + REAUTHORIZATION_USAGE_CACHE_TTL_MS, value })
    void value.catch(() => {
      const current = this.reauthorizationUsageCache.get(id)
      if (current?.value === value) this.reauthorizationUsageCache.delete(id)
    })
    return value
  }

  private async fetchLiveUsage7dPercent(id: number): Promise<number> {
    const payload = await this.backend.request<unknown>(`admin/accounts/${id}/usage`)
    const parsed = backendAccountUsageSchema.parse(payload)
    const usage7dPercent = Number(parsed.seven_day.utilization)
    if (!Number.isFinite(usage7dPercent) || usage7dPercent < 0 || usage7dPercent > 100) {
      throw new AppError(
        'BACKEND_ACCOUNT_USAGE_INVALID',
        '后台账号的 7 天用量数据无效，无法安全筛选重新授权账号。',
        { statusCode: 502 },
      )
    }
    return usage7dPercent
  }

  async generateAuthUrl(input: GenerateAuthUrlInput = {}): Promise<GeneratedAuth> {
    const body: Record<string, number | string> = {}
    if (input.proxyId && input.proxyId > 0) body.proxy_id = input.proxyId
    else if (input.machineId && input.machineId > 0) body.machine_id = input.machineId
    if (input.redirectUri) body.redirect_uri = input.redirectUri

    const payload = await this.backend.request<unknown>('admin/openai/generate-auth-url', {
      method: 'POST',
      body,
    })
    const parsed = authUrlSchema.parse(payload)
    const contract = deriveOAuthNavigationContract(parsed.auth_url)
    return { authUrl: contract.authUrl, sessionId: parsed.session_id, state: contract.state }
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<OpenAICredentials> {
    const payload = await this.backend.request<unknown>('admin/openai/exchange-code', {
      method: 'POST',
      body: {
        session_id: input.sessionId,
        code: input.code,
        state: input.state,
        ...(input.proxyId ? { proxy_id: input.proxyId } : {}),
      },
    })
    return allowlistOpenAICredentials(payload)
  }

  async checkMixedChannel(groupIds: number[]): Promise<{ hasRisk: boolean }> {
    const payload = await this.backend.request<unknown>('admin/accounts/check-mixed-channel', {
      method: 'POST',
      body: { platform: 'openai', group_ids: groupIds },
    })
    return { hasRisk: mixedChannelSchema.parse(payload).has_risk }
  }

  async findAccounts(email: string): Promise<BackendAccount[]> {
    const accounts: BackendAccount[] = []
    const incompleteSearch = () =>
      new AppError(
        'BACKEND_ACCOUNT_SEARCH_INCOMPLETE',
        '后台账号搜索结果不完整，不能安全确定唯一账号。',
        { statusCode: 502 },
      )
    for (let page = 1; page <= 100; page += 1) {
      const query = new URLSearchParams({ page: String(page), page_size: '100', search: email })
      const payload = await this.backend.request<unknown>(`admin/accounts?${query.toString()}`)
      if (Array.isArray(payload)) return payload.map(normalizeAccount)
      const parsed = backendAccountPageSchema.safeParse(payload)
      if (!parsed.success) return accountCollection(payload).map(normalizeAccount)
      if (parsed.data.page !== undefined && parsed.data.page !== page) throw incompleteSearch()
      accounts.push(...parsed.data.items.map(normalizeAccount))
      const pageSize = parsed.data.page_size ?? 100
      const pages =
        parsed.data.pages ??
        (parsed.data.total !== undefined ? Math.ceil(parsed.data.total / pageSize) : undefined)
      if (parsed.data.total !== undefined && accounts.length > parsed.data.total) {
        throw incompleteSearch()
      }
      if (pages === undefined) {
        if (parsed.data.items.length < pageSize) return accounts
        throw incompleteSearch()
      }
      if (pages > 100) {
        throw new AppError(
          'BACKEND_ACCOUNT_SEARCH_INCOMPLETE',
          '后台账号搜索结果页数异常，不能安全确定唯一账号。',
          { statusCode: 502 },
        )
      }
      if (page >= pages) {
        if (parsed.data.total !== undefined && accounts.length < parsed.data.total) {
          throw incompleteSearch()
        }
        return accounts
      }
    }
    throw incompleteSearch()
  }

  private async loadReauthorizationCandidates(
    query: ReauthorizationAccountQuery,
  ): Promise<ReauthorizationAccountSummary[]> {
    const accounts: BackendAccount[] = []
    const seenIds = new Set<number>()
    const backendPageSize = 100
    let complete = false

    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(backendPageSize),
        status: 'error',
        usage_window: '7d',
        usage_operator: 'lte',
        usage_percent: String(query.maxUsage7dPercent),
      })
      if (query.search) params.set('search', query.search)

      const payload = await this.backend.request<unknown>(`admin/accounts?${params.toString()}`)
      const parsed = backendAccountPageSchema.parse(payload)
      if (parsed.page !== undefined && parsed.page !== page) {
        throw new AppError(
          'BACKEND_REAUTHORIZATION_LIST_INCOMPLETE',
          '后台账号列表分页异常，无法安全筛选重新授权账号。',
          { statusCode: 502 },
        )
      }

      for (const item of parsed.items) {
        const account = normalizeAccount(item)
        if (seenIds.has(account.id)) {
          throw new AppError(
            'BACKEND_REAUTHORIZATION_LIST_INCOMPLETE',
            '后台账号列表包含重复账号，无法安全筛选重新授权账号。',
            { statusCode: 502 },
          )
        }
        seenIds.add(account.id)
        accounts.push(account)
      }

      const responsePageSize = parsed.page_size ?? backendPageSize
      const pages =
        parsed.pages ??
        (parsed.total !== undefined ? Math.ceil(parsed.total / responsePageSize) : undefined)
      if (pages !== undefined && pages > 100) {
        throw new AppError(
          'BACKEND_REAUTHORIZATION_LIST_INCOMPLETE',
          '后台账号列表页数异常，无法安全筛选重新授权账号。',
          { statusCode: 502 },
        )
      }
      if (pages === undefined) {
        if (parsed.items.length < responsePageSize) {
          complete = true
          break
        }
        continue
      }
      if (page >= pages) {
        if (parsed.total !== undefined && seenIds.size < parsed.total) {
          throw new AppError(
            'BACKEND_REAUTHORIZATION_LIST_INCOMPLETE',
            '后台账号列表数量不完整，无法安全筛选重新授权账号。',
            { statusCode: 502 },
          )
        }
        complete = true
        break
      }
    }

    if (!complete) {
      throw new AppError(
        'BACKEND_REAUTHORIZATION_LIST_INCOMPLETE',
        '后台账号列表超出安全分页范围，无法继续筛选。',
        { statusCode: 502 },
      )
    }

    const importedCutoff = query.importedWithinDays === undefined
      ? null
      : Date.now() - query.importedWithinDays * 24 * 60 * 60 * 1_000
    const timeFilteredAccounts = importedCutoff === null
      ? accounts
      : accounts.filter((account) => {
          const importedAt = account.createdAt ?? account.updatedAt
          if (!importedAt) return false
          const timestamp = Date.parse(importedAt)
          return !Number.isNaN(timestamp) && timestamp >= importedCutoff
        })

    const hydrated = await mapWithConcurrency(
      timeFilteredAccounts,
      REAUTHORIZATION_USAGE_CONCURRENCY,
      async (account) => {
        // The list value may be stale; live usage remains authoritative for eligibility.
        const usage7dPercent = await this.getLiveUsage7dPercent(account.id)
        return optionalReauthorizationAccountSummary(
          { ...account, codex7dUsedPercent: usage7dPercent },
          query.maxUsage7dPercent,
        )
      },
    )
    const candidates = hydrated.filter(
      (candidate): candidate is ReauthorizationAccountSummary => candidate !== null,
    )

    return candidates
  }

  async listReauthorizationAccounts(
    query: ReauthorizationAccountQuery,
  ): Promise<ReauthorizationAccountPage> {
    const now = Date.now()
    for (const [key, entry] of this.reauthorizationListCache) {
      if (entry.expiresAt <= now) this.reauthorizationListCache.delete(key)
    }

    const cacheKey = JSON.stringify([
      query.search.trim().toLowerCase(),
      query.maxUsage7dPercent,
      query.importedWithinDays ?? null,
    ])
    let entry = this.reauthorizationListCache.get(cacheKey)
    if (!entry) {
      if (this.reauthorizationListCache.size >= REAUTHORIZATION_LIST_CACHE_MAX_ENTRIES) {
        const oldestKey = this.reauthorizationListCache.keys().next().value
        if (oldestKey !== undefined) this.reauthorizationListCache.delete(oldestKey)
      }
      const candidates = this.loadReauthorizationCandidates(query)
      entry = { expiresAt: now + REAUTHORIZATION_LIST_CACHE_TTL_MS, candidates }
      this.reauthorizationListCache.set(cacheKey, entry)
      void candidates.catch(() => {
        if (this.reauthorizationListCache.get(cacheKey) === entry) {
          this.reauthorizationListCache.delete(cacheKey)
        }
      })
    }

    const allCandidates = await entry.candidates
    const excluded = new Set(query.excludedAccountIds ?? [])
    const candidates = excluded.size > 0
      ? allCandidates.filter((candidate) => !excluded.has(candidate.id))
      : allCandidates

    const total = candidates.length
    const pages = total === 0 ? 0 : Math.ceil(total / query.pageSize)
    const start = (query.page - 1) * query.pageSize
    const items = candidates.slice(start, start + query.pageSize)
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      pages,
    }
  }

  async getReauthorizationTarget(id: number): Promise<BackendAccount> {
    const account = await this.getAccount(id)
    if (account.id !== id) {
      throw new AppError('REAUTHORIZATION_TARGET_INVALID', '后台返回的账号与请求目标不一致，不能安全重新授权。', {
        statusCode: 409,
      })
    }
    const usage7dPercent = await this.getLiveUsage7dPercent(id)
    const hydrated = { ...account, codex7dUsedPercent: usage7dPercent }
    reauthorizationTargetEmail(hydrated)
    return hydrated
  }

  async applyOAuthCredentials(
    id: number,
    payload: OAuthCredentialsApplicationPayload,
  ): Promise<BackendAccount> {
    return normalizeAccount(
      await this.backend.request<unknown>(`admin/accounts/${id}/apply-oauth-credentials`, {
        method: 'POST',
        body: payload,
      }),
    )
  }

  async confirmAppliedCredentials(
    id: number,
    expected: OpenAICredentials,
  ): Promise<{ account: BackendAccount; matched: boolean }> {
    const payload = await this.backend.request<unknown>(`admin/accounts/${id}`)
    const parsed = rawAccount(payload)
    const account = normalizeAccount(parsed)
    const accessToken = parsed.credentials?.access_token
    const refreshToken = parsed.credentials?.refresh_token
    const matched = Boolean(
      accessToken &&
        secretEquals(accessToken, expected.access_token) &&
        (!expected.refresh_token || (refreshToken && secretEquals(refreshToken, expected.refresh_token))),
    )
    return { account, matched }
  }

  async createAccount(payload: OpenAIAccountCreatePayload): Promise<BackendAccount> {
    const response = await this.backend.request<unknown>('admin/accounts', { method: 'POST', body: payload })
    return normalizeAccount(response)
  }

  async updateManagementStatus(
    id: number,
    managementStatus: 'banned',
    statusReason: string,
  ): Promise<BackendAccount> {
    return normalizeAccount(
      await this.backend.request<unknown>(`admin/accounts/${id}`, {
        method: 'PUT',
        body: {
          management_status: managementStatus,
          status_reason: statusReason,
        },
      }),
    )
  }

  async updateAccountName(id: number, name: string): Promise<BackendAccount> {
    const account = normalizeAccount(
      await this.backend.request<unknown>(`admin/accounts/${id}`, {
        method: 'PUT',
        body: { name },
      }),
    )
    this.reauthorizationListCache.clear()
    return account
  }

  async updateAccountNotes(id: number, notes: string): Promise<BackendAccount> {
    const account = normalizeAccount(
      await this.backend.request<unknown>(`admin/accounts/${id}`, {
        method: 'PUT',
        body: { notes },
      }),
    )
    this.reauthorizationListCache.clear()
    return account
  }

  async getAccount(id: number): Promise<BackendAccount> {
    return normalizeAccount(await this.backend.request<unknown>(`admin/accounts/${id}`))
  }
}
