import type {
  Concurrency,
  CreateTaskInput,
  LoginMaterialSource,
  OptionsSnapshot,
  ProxyChoice,
  ReauthorizationAccountSummary,
  ReauthorizationProxyMode,
  ReauthorizeTaskInput,
} from '../shared/contracts'
import { isSubscriptionAvailable } from '../shared/contracts'
import { normalizeTotpSecret } from '../shared/login-material'

export const TASK_FREEFORM_FIELDS = [
  { key: 'accountEmail', type: 'email' },
  { key: 'mailboxAccess', type: 'password' },
  { key: 'accountPassword', type: 'password' },
  { key: 'totpSecret', type: 'password' },
] as const

export type TaskLoginMode = 'email_otp' | 'password_totp'

export interface TaskFormState {
  materialSource: LoginMaterialSource
  loginMode: TaskLoginMode
  accountEmail: string
  mailboxAccess: string
  accountPassword: string
  totpSecret: string
  proxyMode: ProxyChoice['mode']
  fixedProxyId: number | null
  subscriptionId: number | null
  concurrency: Concurrency
  supplier: string | null
  groupIds: number[]
  allowDuplicateCreation: boolean
  confirmMixedChannelRisk: boolean
  modelsCleared: true
}

export interface ReauthorizationFormState {
  materialSource: LoginMaterialSource
  accountId: number | null
  accountName: string
  accountStatus: string
  accountImportedAt: string | null
  maxUsage7dPercent: number
  proxyMode: ReauthorizationProxyMode
  loginMode: TaskLoginMode
  accountEmail: string
  mailboxAccess: string
  accountPassword: string
  totpSecret: string
}

export interface ReauthorizationCredentialMemory {
  activeAccountId: number | null
  byAccountId: Map<number, { mailboxAccess: string; accountPassword: string; totpSecret: string }>
}

export interface TaskCredentialMemory {
  activeEmail: string
  byEmail: Map<string, { mailboxAccess: string; accountPassword: string; totpSecret: string }>
}

export interface LatestRequestGuard {
  begin(): number
  isLatest(requestId: number): boolean
  invalidate(): void
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latestRequestId = 0
  return {
    begin: () => ++latestRequestId,
    isLatest: (requestId) => requestId === latestRequestId,
    invalidate: () => {
      latestRequestId += 1
    },
  }
}

export function createTaskFormState(): TaskFormState {
  return {
    materialSource: 'account_pool',
    loginMode: 'email_otp',
    accountEmail: '',
    mailboxAccess: '',
    accountPassword: '',
    totpSecret: '',
    proxyMode: 'none',
    fixedProxyId: null,
    subscriptionId: null,
    concurrency: 10,
    supplier: null,
    groupIds: [],
    allowDuplicateCreation: true,
    confirmMixedChannelRisk: false,
    modelsCleared: true,
  }
}

export function createTaskCredentialMemory(): TaskCredentialMemory {
  return { activeEmail: '', byEmail: new Map() }
}

export function createReauthorizationFormState(): ReauthorizationFormState {
  return {
    materialSource: 'account_pool',
    accountId: null,
    accountName: '',
    accountStatus: '',
    accountImportedAt: null,
    maxUsage7dPercent: 90,
    proxyMode: 'existing',
    loginMode: 'email_otp',
    accountEmail: '',
    mailboxAccess: '',
    accountPassword: '',
    totpSecret: '',
  }
}

export function createReauthorizationCredentialMemory(): ReauthorizationCredentialMemory {
  return { activeAccountId: null, byAccountId: new Map() }
}

export function selectReauthorizationAccount(
  form: ReauthorizationFormState,
  memory: ReauthorizationCredentialMemory,
  account: ReauthorizationAccountSummary,
): void {
  if (memory.activeAccountId !== null) {
    if (form.mailboxAccess || form.accountPassword || form.totpSecret) {
      memory.byAccountId.set(memory.activeAccountId, {
        mailboxAccess: form.mailboxAccess,
        accountPassword: form.accountPassword,
        totpSecret: form.totpSecret,
      })
    } else memory.byAccountId.delete(memory.activeAccountId)
  }
  const credentials = memory.byAccountId.get(account.id)
  form.accountId = account.id
  form.accountName = account.name
  form.accountEmail = account.email
  form.accountStatus = account.status
  form.accountImportedAt = account.importedAt ?? null
  form.mailboxAccess = credentials?.mailboxAccess ?? ''
  form.accountPassword = credentials?.accountPassword ?? ''
  form.totpSecret = credentials?.totpSecret ?? ''
  memory.activeAccountId = account.id
}

export function rememberReauthorizationCredential(
  form: ReauthorizationFormState,
  memory: ReauthorizationCredentialMemory,
): void {
  if (!form.accountId) return
  if (form.mailboxAccess || form.accountPassword || form.totpSecret) {
    memory.byAccountId.set(form.accountId, {
      mailboxAccess: form.mailboxAccess,
      accountPassword: form.accountPassword,
      totpSecret: form.totpSecret,
    })
  } else memory.byAccountId.delete(form.accountId)
}

export function canStartReauthorization(
  form: ReauthorizationFormState,
  authenticated: boolean,
  busy: boolean,
): boolean {
  if (
    busy ||
    !authenticated ||
    !form.accountId ||
    !form.accountEmail ||
    !Number.isInteger(form.maxUsage7dPercent) ||
    form.maxUsage7dPercent < 0 ||
    form.maxUsage7dPercent > 100
  ) return false
  if (form.materialSource === 'account_pool') return true
  if (form.loginMode === 'email_otp') return Boolean(form.mailboxAccess)
  return Boolean(form.accountPassword && normalizeTotpSecret(form.totpSecret))
}

export function toReauthorizeTaskInput(form: ReauthorizationFormState): ReauthorizeTaskInput {
  if (!form.accountId) throw new Error('请选择需要重新授权的账号。')
  return {
    accountId: form.accountId,
    accountEmail: form.accountEmail.trim().toLowerCase(),
    maxUsage7dPercent: form.maxUsage7dPercent,
    proxyMode: form.proxyMode,
    ...(form.materialSource === 'account_pool'
      ? { loginMaterialSource: 'account_pool' as const }
      : {
          loginMaterialSource: 'manual' as const,
          loginMaterial:
            form.loginMode === 'email_otp'
              ? { kind: 'email_otp' as const, mailboxAccess: form.mailboxAccess }
              : {
                  kind: 'password_totp' as const,
                  password: form.accountPassword,
                  totpSecret: normalizeTotpSecret(form.totpSecret) ?? form.totpSecret,
                },
        }),
  }
}

function normalizedTaskEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function switchTaskCredentialEmail(
  form: TaskFormState,
  memory: TaskCredentialMemory,
): void {
  const nextEmail = normalizedTaskEmail(form.accountEmail)
  if (nextEmail === memory.activeEmail) return

  if (!memory.activeEmail) {
    memory.activeEmail = nextEmail
    if (nextEmail && (form.mailboxAccess || form.accountPassword || form.totpSecret)) {
      memory.byEmail.set(nextEmail, {
        mailboxAccess: form.mailboxAccess,
        accountPassword: form.accountPassword,
        totpSecret: form.totpSecret,
      })
    }
    return
  }

  if (form.mailboxAccess || form.accountPassword || form.totpSecret) {
    memory.byEmail.set(memory.activeEmail, {
      mailboxAccess: form.mailboxAccess,
      accountPassword: form.accountPassword,
      totpSecret: form.totpSecret,
    })
  } else memory.byEmail.delete(memory.activeEmail)
  const nextCredentials = nextEmail ? memory.byEmail.get(nextEmail) : undefined
  form.mailboxAccess = nextCredentials?.mailboxAccess ?? ''
  form.accountPassword = nextCredentials?.accountPassword ?? ''
  form.totpSecret = nextCredentials?.totpSecret ?? ''
  memory.activeEmail = nextEmail
}

export function rememberTaskCredential(
  form: TaskFormState,
  memory: TaskCredentialMemory,
): void {
  const email = normalizedTaskEmail(form.accountEmail)
  if (!email) return
  if (email !== memory.activeEmail) switchTaskCredentialEmail(form, memory)
  if (form.mailboxAccess || form.accountPassword || form.totpSecret) {
    memory.byEmail.set(email, {
      mailboxAccess: form.mailboxAccess,
      accountPassword: form.accountPassword,
      totpSecret: form.totpSecret,
    })
  } else memory.byEmail.delete(email)
}

export function toCreateTaskInput(form: TaskFormState): CreateTaskInput {
  let proxyChoice: ProxyChoice
  if (form.proxyMode === 'fixed') {
    if (!form.fixedProxyId) throw new Error('请选择固定代理。')
    proxyChoice = { mode: 'fixed', proxyId: form.fixedProxyId }
  } else if (form.proxyMode === 'dynamic') {
    if (!form.subscriptionId) throw new Error('请选择动态订阅。')
    proxyChoice = { mode: 'dynamic', subscriptionId: form.subscriptionId }
  } else if (form.proxyMode === 'random_fixed') proxyChoice = { mode: 'random_fixed' }
  else proxyChoice = { mode: 'none' }

  return {
    accountEmail: form.accountEmail.trim().toLowerCase(),
    ...(form.materialSource === 'account_pool'
      ? { loginMaterialSource: 'account_pool' as const }
      : {
          loginMaterialSource: 'manual' as const,
          loginMaterial:
            form.loginMode === 'email_otp'
              ? { kind: 'email_otp' as const, mailboxAccess: form.mailboxAccess }
              : {
                  kind: 'password_totp' as const,
                  password: form.accountPassword,
                  totpSecret: normalizeTotpSecret(form.totpSecret) ?? form.totpSecret,
                },
        }),
    proxyChoice,
    concurrency: form.concurrency,
    supplier: form.supplier,
    groupIds: [...form.groupIds],
    allowDuplicateCreation: form.allowDuplicateCreation,
    confirmMixedChannelRisk: form.confirmMixedChannelRisk,
  }
}

export function toggleAllGroupIds(
  selectedIds: readonly number[],
  groups: OptionsSnapshot['groups'],
): number[] {
  if (!groups.length) return []
  const allSelected = groups.every((group) => selectedIds.includes(group.id))
  return allSelected ? [] : groups.map((group) => group.id)
}

export function canStartTask(
  form: TaskFormState,
  authenticated: boolean,
  options: OptionsSnapshot | null,
  busy: boolean,
): boolean {
  if (busy || !authenticated || !options || !form.accountEmail.trim()) return false
  if (form.materialSource === 'account_pool') {
    if (form.proxyMode === 'fixed' && !options.proxies.some((proxy) => proxy.id === form.fixedProxyId)) return false
    if (
      form.proxyMode === 'dynamic' &&
      !options.subscriptions.some(
        (subscription) => subscription.id === form.subscriptionId && isSubscriptionAvailable(subscription),
      )
    ) return false
    return true
  }
  if (form.loginMode === 'email_otp' && !form.mailboxAccess) return false
  if (
    form.loginMode === 'password_totp' &&
    (!form.accountPassword || !normalizeTotpSecret(form.totpSecret))
  ) return false
  if (form.proxyMode === 'fixed' && !options.proxies.some((proxy) => proxy.id === form.fixedProxyId)) return false
  if (
    form.proxyMode === 'dynamic' &&
    !options.subscriptions.some(
      (subscription) => subscription.id === form.subscriptionId && isSubscriptionAvailable(subscription),
    )
  ) return false
  return true
}

const FORBIDDEN_FRONTEND_API_KEY = /(?:access_token|refresh_token|id_token|oauthcredentials|session_id)/i

export function isForbiddenFrontendApiKey(key: string): boolean {
  return FORBIDDEN_FRONTEND_API_KEY.test(key)
}
