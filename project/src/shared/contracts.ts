import { z } from 'zod'
import type { PublicTaskError } from './errors'
import type { TaskStage } from './task-state'
import { TotpSecretSchema } from './login-material'

export const concurrencySchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(10),
  z.literal(20),
])

export const DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT = 90
export const ReauthorizationUsageThresholdSchema = z
  .number()
  .int()
  .min(0)
  .max(100)
  .default(DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT)

export const PasswordLoginInputSchema = z
  .object({
    email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    password: z.string().min(1).max(1024),
  })
  .strict()

export const TotpLoginInputSchema = z
  .object({
    attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()

export type PasswordLoginInput = z.infer<typeof PasswordLoginInputSchema>
export type TotpLoginInput = z.infer<typeof TotpLoginInputSchema>

export const UpdateMailboxTrustSettingsInputSchema = z
  .object({
    customPathOrigins: z.array(z.string().trim().min(1).max(2048)).max(20),
  })
  .strict()

export type UpdateMailboxTrustSettingsInput = z.infer<typeof UpdateMailboxTrustSettingsInputSchema>

export interface MailboxTrustSettings {
  builtInPathOrigins: string[]
  customPathOrigins: string[]
  configurationValid: boolean
}

export const DEFAULT_DEACTIVATION_CONFIRMATION_ATTEMPTS = 2
export const DeactivationConfirmationAttemptsSchema = z.number().int().min(1).max(10)
export const UpdateDeactivationSettingsInputSchema = z
  .object({ confirmationAttempts: DeactivationConfirmationAttemptsSchema })
  .strict()
export type UpdateDeactivationSettingsInput = z.infer<typeof UpdateDeactivationSettingsInputSchema>
export interface DeactivationSettings {
  confirmationAttempts: number
}

export const ProxyChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('fixed'), proxyId: z.number().int().refine((value) => value !== 0) }).strict(),
  z.object({ mode: z.literal('random_fixed') }).strict(),
  z.object({ mode: z.literal('dynamic'), subscriptionId: z.number().int().positive() }).strict(),
])

export const LoginMaterialSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('email_otp'),
      mailboxAccess: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('password_totp'),
      password: z.string().min(1).max(1024),
      totpSecret: TotpSecretSchema,
    })
    .strict(),
])

export const LoginMaterialSourceSchema = z.enum(['manual', 'account_pool'])
export type LoginMaterialSource = z.infer<typeof LoginMaterialSourceSchema>

const TaskMaterialInputSchema = z
  .object({
    loginMaterial: LoginMaterialSchema.optional(),
    loginMaterialSource: LoginMaterialSourceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const source = value.loginMaterialSource ?? 'manual'
    if (source === 'manual' && !value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '缺少手动登录材料。' })
    }
    if (source === 'account_pool' && value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '自动账号池模式不能携带手动登录材料。' })
    }
  })

export const CreateTaskInputSchema = z
  .object({
    accountEmail: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    proxyChoice: ProxyChoiceSchema,
    concurrency: concurrencySchema.default(10),
    supplier: z.string().trim().min(1).max(200).nullable(),
    groupIds: z.array(z.number().int().positive()).max(100),
    allowDuplicateCreation: z.boolean().default(false),
    confirmMixedChannelRisk: z.boolean().default(false),
    ...TaskMaterialInputSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    const source = value.loginMaterialSource ?? 'manual'
    if (source === 'manual' && !value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '缺少手动登录材料。' })
    }
    if (source === 'account_pool' && value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '自动账号池模式不能携带手动登录材料。' })
    }
  })

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>
export type LoginMaterial = z.infer<typeof LoginMaterialSchema>
export type ProxyChoice = z.infer<typeof ProxyChoiceSchema>
export type Concurrency = z.infer<typeof concurrencySchema>
export const ReauthorizationProxyModeSchema = z.enum(['existing', 'none'])
export type ReauthorizationProxyMode = z.infer<typeof ReauthorizationProxyModeSchema>

export const ReauthorizeTaskInputSchema = z
  .object({
    accountId: z.number().int().positive(),
    accountEmail: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    maxUsage7dPercent: ReauthorizationUsageThresholdSchema,
    proxyMode: ReauthorizationProxyModeSchema.optional(),
    ...TaskMaterialInputSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    const source = value.loginMaterialSource ?? 'manual'
    if (source === 'manual' && !value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '缺少手动登录材料。' })
    }
    if (source === 'account_pool' && value.loginMaterial) {
      context.addIssue({ code: 'custom', path: ['loginMaterial'], message: '自动账号池模式不能携带手动登录材料。' })
    }
  })

export type ReauthorizeTaskInput = z.infer<typeof ReauthorizeTaskInputSchema>

export interface ReauthorizationAccountSummary {
  id: number
  name: string
  email: string
  status: string
  usage7dPercent: number
  importedAt?: string | null
  errorAt?: string | null
  excludedFromHosting?: boolean
  hostingNote?: string
}

export interface ReauthorizationAccountPage {
  items: ReauthorizationAccountSummary[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export type ReauthorizationHostingStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'completed'

export type ReauthorizationHostingResult = 'success' | 'failed' | 'banned' | 'skipped'

export interface ReauthorizationHostingState {
  status: ReauthorizationHostingStatus
  search: string
  maxUsage7dPercent: number
  importedWithinDays: number | null
  proxyMode: ReauthorizationProxyMode
  currentAccountId: number | null
  currentTaskId: string | null
  total: number
  completed: number
  failed: number
  banned: number
  skipped: number
  lastAccountId: number | null
  lastResult: ReauthorizationHostingResult | null
  lastMessage: string
  createdAt: string | null
  updatedAt: string
}

export interface ProxyOption {
  id: number
  name: string
  status?: string
  proxyMachineId?: number
  proxyMachineProxyId?: number
}

export interface SubscriptionOption {
  id: number
  name: string
  status?: string
  enabled?: boolean
  nodeCount?: number
  healthyNodeCount?: number
}

export function isSubscriptionAvailable(subscription: SubscriptionOption): boolean {
  const normalizedStatus = subscription.status?.trim().toLowerCase()
  return (
    subscription.enabled !== false &&
    normalizedStatus !== 'disabled' &&
    normalizedStatus !== 'inactive' &&
    subscription.healthyNodeCount !== 0
  )
}

export interface GroupOption {
  id: number
  name: string
  status?: string
}

export interface OptionsSnapshot {
  version: string
  loadedAt: string
  proxies: ProxyOption[]
  subscriptions: SubscriptionOption[]
  suppliers: string[]
  groups: GroupOption[]
}

export interface CreateTaskSelection {
  operation: 'create'
  proxyMode: ProxyChoice['mode']
  proxyId?: number
  machineId?: number
  proxyName?: string
  concurrency: Concurrency
  supplier: string | null
  groups: Array<{ id: number; name: string }>
  allowDuplicateCreation?: boolean
  confirmMixedChannelRisk?: boolean
  modelsCleared: true
  loginMaterialSource?: LoginMaterialSource
}

export interface ReauthorizeTaskSelection {
  operation: 'reauthorize'
  targetAccountId: number
  targetAccountName: string | null
  statusBefore: string | null
  maxUsage7dPercent: number
  proxyMode: 'existing' | 'none'
  proxyId?: number
  machineId?: number
  proxyName?: string
  loginMaterialSource?: LoginMaterialSource
}

export type TaskSelection = CreateTaskSelection | ReauthorizeTaskSelection

export interface AccountResult {
  id: number
  name: string
  status: string
}

export interface OAuthUrlShape {
  origin: string
  path: string
  totalLength: number
  parameterCount: number
  parameterNames: string[]
  parameterFingerprint: string
}

export interface OAuthRedirectShape {
  origin: string
  path: string
}

export interface OAuthNavigationDiagnostics {
  generated: OAuthUrlShape
  initialNavigation: OAuthUrlShape | null
  redirect: OAuthRedirectShape | null
}

export interface AuthorizationProgress {
  source: 'backend_generate_auth_url'
  validated: boolean
  navigationValidated: boolean
  receivedAt: string
  browserOpenedAt: string | null
  urlOpenedAt: string | null
  diagnostics?: OAuthNavigationDiagnostics | null
}

export type AccountDeactivationBanResult =
  | 'pending'
  | 'banned'
  | 'already_banned'
  | 'no_matching_account'
  | 'ambiguous_match'
  | 'write_rejected'
  | 'write_uncertain'

export interface AccountDeactivationProgress {
  detectedCount: number
  confirmationAttempts?: number
  retryAttempted: boolean
  confirmed: boolean
  targetAccountId: number | null
  banResult: AccountDeactivationBanResult
}

export interface PublicTask {
  id: string
  accountEmail: string
  stage: TaskStage
  status: 'active' | 'success' | 'error' | 'cancelled'
  manualTakeover?: boolean
  selection: TaskSelection
  authorization?: AuthorizationProgress | null
  deactivation?: AccountDeactivationProgress | null
  terminalFromStage?: TaskStage | null
  account: AccountResult | null
  error: PublicTaskError | null
  message: string
  createdAt: string
  updatedAt: string
}

export interface InternalTask extends PublicTask {
  mailboxPassword?: string
  oauthCredentials?: Record<string, unknown>
  backendAccessToken?: string
}

export function toPublicTask(task: InternalTask): PublicTask {
  return {
    id: task.id,
    accountEmail: task.accountEmail,
    stage: task.stage,
    status: task.status,
    ...(task.manualTakeover !== undefined ? { manualTakeover: task.manualTakeover } : {}),
    selection: structuredClone(task.selection),
    ...(task.authorization !== undefined
      ? { authorization: task.authorization ? structuredClone(task.authorization) : null }
      : {}),
    ...(task.deactivation !== undefined
      ? { deactivation: task.deactivation ? structuredClone(task.deactivation) : null }
      : {}),
    ...(task.terminalFromStage !== undefined ? { terminalFromStage: task.terminalFromStage } : {}),
    account: task.account ? structuredClone(task.account) : null,
    error: task.error ? structuredClone(task.error) : null,
    message: task.message,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}
