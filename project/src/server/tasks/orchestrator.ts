import { randomUUID } from 'node:crypto'
import type { BackendAccount, BackendAccountsApi, GeneratedAuth, OpenAICredentials } from '../backend/accounts'
import type { BackendOptionsApi } from '../backend/options'
import { validateTaskSelection } from '../backend/options'
import type {
  AutomatedPageKind,
  ManualInterventionReason,
  OAuthBrowserDriver,
  OAuthBrowserSession,
  OAuthCallbackResult,
} from '../browser/types'
import { describeOAuthUrl } from '../browser/callback-capture'
import type { MailOtpPoller } from '../mail/poller'
import { mailboxPasswordFromInput } from '../mail/client'
import { BUILT_IN_PATH_MAILBOX_ORIGINS } from '../mail/settings'
import { SecretScope } from '../security/secret-scope'
import { TotpGenerator } from '../security/totp'
import type { TaskDatabase } from '../storage/database'
import {
  CreateTaskInputSchema,
  type AccountResult,
  type CreateTaskSelection,
  type CreateTaskInput,
  type LoginMaterial,
  type OAuthNavigationDiagnostics,
  type PublicTask,
  ReauthorizeTaskInputSchema,
  type ReauthorizeTaskInput,
  type ReauthorizeTaskSelection,
} from '../../shared/contracts'
import { AppError, toPublicError } from '../../shared/errors'
import { isTerminalTaskStage } from '../../shared/task-state'
import type { MailBaseline } from '../mail/otp'
import type { AccountCreator } from './account-creator'
import { buildOpenAIAccountPayload } from './account-creator'
import type { AccountReauthorizer, ReauthorizationTarget } from './account-reauthorizer'
import type { AccountPoolResolver } from '../account-pool/bridge-client'
import { selectAccountPoolMaterial } from '../account-pool/material-selector'
import type { ProxyResolver, ResolvedProxy } from './proxy-resolver'
import { TaskStateMachine } from './state-machine'
import type { AccountDeactivationManager } from './account-deactivation'

const EMAIL_OTP_ROUND_LIMIT = 3
const DYNAMIC_PROXY_CONNECTION_ATTEMPTS = 3
const DYNAMIC_PROXY_RESOLUTION_CANDIDATES = 3
const MAILBOX_ACCESS_FAILURE_CODES = new Set([
  'MAIL_ACCESS_URL_EXPIRED',
  'MAIL_AUTHENTICATION_FAILED',
])

function isMailboxAccessFailure(error: unknown): error is AppError {
  return error instanceof AppError && MAILBOX_ACCESS_FAILURE_CODES.has(error.code)
}

type TaskListener = (task: PublicTask) => void

interface OptionsAdapter {
  loadSnapshot: BackendOptionsApi['loadSnapshot']
}

interface AccountCreatorAdapter {
  findExactDuplicate: AccountCreator['findExactDuplicate']
  createAndConfirm: AccountCreator['createAndConfirm']
}

interface AccountReauthorizerAdapter {
  loadTarget: AccountReauthorizer['loadTarget']
  assertOAuthEmail: AccountReauthorizer['assertOAuthEmail']
  assertUnchanged: AccountReauthorizer['assertUnchanged']
  applyAndConfirm: AccountReauthorizer['applyAndConfirm']
  markMailboxExpired?: AccountReauthorizer['markMailboxExpired']
  markMailboxAccessExpired?: AccountReauthorizer['markMailboxAccessExpired']
  markPhoneVerification?: AccountReauthorizer['markPhoneVerification']
  markMailboxAccessMissing?: AccountReauthorizer['markMailboxAccessMissing']
}

interface AccountDeactivationAdapter {
  locateCreateTarget: AccountDeactivationManager['locateCreateTarget']
  markBanned: AccountDeactivationManager['markBanned']
}

interface MailAdapter {
  establishBaseline: MailOtpPoller['establishBaseline']
  waitForOtp: MailOtpPoller['waitForOtp']
}

interface ProxyAdapter {
  resolve: ProxyResolver['resolve']
}

interface OAuthAdapter {
  generateAuthUrl: BackendAccountsApi['generateAuthUrl']
  exchangeCode: BackendAccountsApi['exchangeCode']
  checkMixedChannel: BackendAccountsApi['checkMixedChannel']
}

interface ScopedAccountPoolResolver extends AccountPoolResolver {
  resolve(email: string, signal?: AbortSignal, scope?: string): Promise<Awaited<ReturnType<AccountPoolResolver['resolve']>>>
}

type RuntimeLoginMaterial = LoginMaterial & {
  passwordErrorFallback?: {
    password: string
    totpSecret: string
  }
  passwordHyphenFallbacks?: string[]
}

function isLoopbackProxyServer(server: string): boolean {
  try {
    const hostname = new URL(server).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  } catch {
    return false
  }
}

export type BackendWriteStage =
  | 'marking_account_banned'
  | 'marking_mailbox_expired'
  | 'marking_mailbox_access_expired'
  | 'marking_mailbox_access_missing'
  | 'marking_phone_verification'
  | 'applying_oauth_credentials'
  | 'creating_account'

export interface ExternalExecutionReservation {
  readonly token: symbol
}

export interface ExternalExecutionOptions {
  materialScope?: string
  beforeBackendWrite?: (stage: BackendWriteStage) => Promise<void>
}

interface BeginOptions extends ExternalExecutionOptions {
  reservation?: ExternalExecutionReservation
}

class ManualTakeoverGate {
  #active = false
  #release: (() => void) | null = null
  #released = Promise.resolve()

  get active(): boolean {
    return this.#active
  }

  takeOver(): void {
    if (this.#active) return
    this.#active = true
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve
    })
  }

  release(): void {
    if (!this.#active) return
    this.#active = false
    this.#release?.()
    this.#release = null
  }

  async wait(signal: AbortSignal): Promise<void> {
    while (this.#active) {
      if (signal.aborted) throw signal.reason
      let abort: (() => void) | undefined
      try {
        await Promise.race([
          this.#released,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
          }),
        ])
      } finally {
        if (abort) signal.removeEventListener('abort', abort)
      }
    }
  }
}

export interface TaskOrchestratorDependencies {
  database: TaskDatabase
  options: OptionsAdapter
  accountCreator: AccountCreatorAdapter
  accountDeactivation?: AccountDeactivationAdapter
  accountReauthorizer: AccountReauthorizerAdapter
  mail: MailAdapter
  proxyResolver: ProxyAdapter
  oauth: OAuthAdapter
  browser: OAuthBrowserDriver
  accountPool?: ScopedAccountPoolResolver
  trustedPathOrigins?: () => readonly string[]
  deactivationConfirmationAttempts?: () => number
  createSecretScope?: () => SecretScope
  totp?: Pick<TotpGenerator, 'next'>
  id?: () => string
  now?: () => Date
}

type ExecutableCreateTaskInput = CreateTaskInput & {
  operation: 'create'
  trustedPathOrigins: readonly string[]
} & ExternalExecutionOptions
type ExecutableReauthorizeTaskInput = ReauthorizeTaskInput & {
  operation: 'reauthorize'
  trustedPathOrigins: readonly string[]
} & ExternalExecutionOptions
type ExecutableTaskInput = ExecutableCreateTaskInput | ExecutableReauthorizeTaskInput

function accountResult(account: BackendAccount | AccountResult): AccountResult {
  return { id: account.id, name: account.name, status: account.status }
}

function isUncertainCreateError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'BACKEND_NETWORK_ERROR' ||
      error.code === 'BACKEND_REQUEST_TIMEOUT' ||
      error.code === 'BACKEND_TIMEOUT')
  )
}

function messageFor(stage: PublicTask['stage']): string {
  const messages: Partial<Record<PublicTask['stage'], string>> = {
    validating: '正在校验任务输入。',
    loading_target_account: '正在读取并核对重新授权目标账号。',
    loading_options: '正在读取后台选项。',
    checking_existing: '正在检查账号是否已经存在。',
    mail_baseline: '正在建立邮箱基线。',
    resolving_proxy: '正在解析本次任务代理。',
    generating_auth_url: '正在生成 OpenAI 授权链接。',
    authorization_url_received: '已从后台获取 OpenAI 授权地址。',
    browser_started: 'Chrome 无痕浏览器已启动，正在打开授权地址。',
    authorization_url_opened: '后台生成的完整 OpenAI 授权参数已传入无痕 Chrome。',
    email_submitted: '登录邮箱已提交。',
    waiting_for_password: '正在等待并填写 OpenAI 账号密码。',
    password_submitted: 'OpenAI 账号密码已提交。',
    waiting_for_totp: '正在生成并填写认证器 2FA 动态码。',
    totp_submitted: '认证器 2FA 动态码已提交。',
    waiting_for_otp: '正在进行第一轮验证码等待（最多 60 秒）。',
    resending_otp: '第一轮未取得可靠验证码，正在重新发送验证码。',
    waiting_for_otp_retry: '验证码已重新发送，正在进行第二轮等待（最多 60 秒）。',
    resending_otp_second: '第二轮仍未取得可靠验证码，正在第二次重新发送验证码。',
    waiting_for_otp_third: '验证码已第二次重新发送，正在进行第三轮等待（最多 60 秒）。',
    otp_submitted: '验证码已提交。',
    waiting_for_consent: '正在确认 Codex 授权同意页。',
    consent_submitted: 'Codex 授权同意步骤已完成。',
    waiting_for_callback: '正在等待 OAuth 回调。',
    manual_intervention: '遇到尚未覆盖的页面；授权浏览器已保留，请手动处理当前步骤，完成后工具会自动接回后续流程。',
    exchanging_code: '正在由后台兑换授权结果。',
    applying_oauth_credentials: '正在把新 OAuth 凭据写回原账号，此阶段不能取消。',
    confirming_reauthorization: '正在确认原账号的最新授权状态。',
    reauthorization_result_uncertain: '写回响应不确定，正在查询原账号确认，禁止重复提交。',
    checking_duplicate: '正在执行创建前最终查重。',
    creating_account: '正在创建后台账号，此阶段不能取消。',
    confirming_account: '正在确认后台账号结果。',
    create_result_uncertain: '创建响应不确定，正在查询后台结果。',
    completed: '账号创建完成。',
    already_exists: '后台已存在该账号，未重复创建。',
    failed: '任务失败。',
    cancelled: '任务已取消。',
  }
  return messages[stage] ?? stage
}

type ManualInterventionPhase =
  | 'email'
  | 'password'
  | 'totp'
  | 'otp'
  | 'consent'
  | 'mail_conflict'
  | 'otp_resend'
  | 'otp_rounds_exhausted'

function manualInterventionMessage(
  phase: ManualInterventionPhase,
  reason: ManualInterventionReason = 'unknown',
): string {
  const reasonMessages: Record<ManualInterventionReason, string> = {
    challenge: 'OpenAI 页面要求完成安全验证',
    password: 'OpenAI 页面要求手动输入密码或切换登录方式',
    credentials: 'OpenAI 页面未接受账号密码或 2FA 动态码',
    email_otp: '当前账号要求使用邮箱验证码，密码 + 2FA 模式不会读取邮箱',
    account_selection: 'OpenAI 页面要求手动选择登录账号',
    mfa: 'OpenAI 页面要求完成多因素验证',
    provider_error: 'OpenAI 页面返回提供方错误',
    unknown: {
      email: '邮箱步骤出现了当前流程未识别的页面',
      password: '密码步骤出现了当前流程未识别的页面',
      totp: '2FA 步骤出现了当前流程未识别的页面',
      otp: '邮箱验证码步骤出现了当前流程未识别的页面',
      consent: 'Codex 授权步骤出现了当前流程未识别的页面',
      mail_conflict: '检测到多个无法可靠区分的最新验证码',
      otp_resend: '重新发送验证码时出现了当前流程未识别的页面',
      otp_rounds_exhausted: '三轮等待结束，仍未取得可安全使用的最新验证码',
    }[phase],
  }
  const pollingStatus = phase === 'email' ? '；验证码轮询尚未开始' : ''
  return `${reasonMessages[reason]}${pollingStatus}。授权浏览器已保留，请手动处理当前步骤；完成后工具会自动识别并接回后续流程。`
}

export class TaskOrchestrator {
  readonly #listeners = new Set<TaskListener>()
  readonly #runs = new Map<string, Promise<PublicTask>>()
  readonly #createSecretScope: () => SecretScope
  readonly #id: () => string
  readonly #now: () => Date
  readonly #totp: Pick<TotpGenerator, 'next'>
  readonly #authorizationUrls = new Map<string, string>()
  #active:
    | { id: string; machine: TaskStateMachine; abortController: AbortController; takeover: ManualTakeoverGate }
    | undefined
  #externalReservation: ExternalExecutionReservation | undefined

  constructor(private readonly dependencies: TaskOrchestratorDependencies) {
    this.#createSecretScope = dependencies.createSecretScope ?? (() => new SecretScope())
    this.#id = dependencies.id ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date())
    this.#totp = dependencies.totp ?? new TotpGenerator()
  }

  start(rawInput: unknown): PublicTask {
    return this.startCreate(rawInput)
  }

  reserveExternalExecution(): ExternalExecutionReservation {
    if (this.#active || this.#externalReservation) {
      throw new AppError('TASK_ALREADY_ACTIVE', '当前已有一个账号任务正在运行。', { statusCode: 409 })
    }
    const reservation = Object.freeze({ token: Symbol('external-execution') })
    this.#externalReservation = reservation
    return reservation
  }

  releaseExternalExecution(reservation: ExternalExecutionReservation): void {
    if (this.#externalReservation === reservation) this.#externalReservation = undefined
  }

  startReserved(
    reservation: ExternalExecutionReservation,
    rawInput: unknown,
    options: ExternalExecutionOptions = {},
  ): PublicTask {
    return this.startCreate(rawInput, { ...options, reservation })
  }

  startReservedReauthorization(
    reservation: ExternalExecutionReservation,
    rawInput: unknown,
    options: ExternalExecutionOptions = {},
  ): PublicTask {
    return this.startReauthorizationTask(rawInput, { ...options, reservation })
  }

  private startCreate(rawInput: unknown, options: BeginOptions = {}): PublicTask {
    const parsedInput = CreateTaskInputSchema.parse(rawInput)
    const trustedPathOrigins = Object.freeze([
      ...(this.dependencies.trustedPathOrigins?.() ?? BUILT_IN_PATH_MAILBOX_ORIGINS),
    ])
    const loginMaterial = parsedInput.loginMaterial &&
      (parsedInput.loginMaterial.kind === 'email_otp'
        ? {
            kind: 'email_otp' as const,
            mailboxAccess: mailboxPasswordFromInput(
              parsedInput.accountEmail,
              parsedInput.loginMaterial.mailboxAccess,
              trustedPathOrigins,
            ),
          }
        : parsedInput.loginMaterial)
    const input: ExecutableCreateTaskInput = {
      ...parsedInput,
      loginMaterialSource: parsedInput.loginMaterialSource ?? 'manual',
      operation: 'create',
      loginMaterial,
      trustedPathOrigins,
      ...(options.materialScope ? { materialScope: options.materialScope } : {}),
      ...(options.beforeBackendWrite ? { beforeBackendWrite: options.beforeBackendWrite } : {}),
    }
    return this.begin(input, {
      operation: 'create',
      proxyMode: input.proxyChoice.mode,
      concurrency: input.concurrency,
      supplier: input.supplier,
      groups: [],
      allowDuplicateCreation: input.allowDuplicateCreation,
      modelsCleared: true,
      loginMaterialSource: input.loginMaterialSource,
    }, options)
  }

  startReauthorization(rawInput: unknown): PublicTask {
    return this.startReauthorizationTask(rawInput)
  }

  private startReauthorizationTask(rawInput: unknown, options: BeginOptions = {}): PublicTask {
    const parsedInput = ReauthorizeTaskInputSchema.parse(rawInput)
    const trustedPathOrigins = Object.freeze([
      ...(this.dependencies.trustedPathOrigins?.() ?? BUILT_IN_PATH_MAILBOX_ORIGINS),
    ])
    const loginMaterial = parsedInput.loginMaterial &&
      (parsedInput.loginMaterial.kind === 'email_otp'
        ? {
            kind: 'email_otp' as const,
            mailboxAccess: mailboxPasswordFromInput(
              parsedInput.accountEmail,
              parsedInput.loginMaterial.mailboxAccess,
              trustedPathOrigins,
            ),
          }
        : parsedInput.loginMaterial)
    const input: ExecutableReauthorizeTaskInput = {
      ...parsedInput,
      loginMaterialSource: parsedInput.loginMaterialSource ?? 'manual',
      operation: 'reauthorize',
      loginMaterial,
      trustedPathOrigins,
      ...(options.materialScope ? { materialScope: options.materialScope } : {}),
      ...(options.beforeBackendWrite ? { beforeBackendWrite: options.beforeBackendWrite } : {}),
    }
    return this.begin(input, {
      operation: 'reauthorize',
      targetAccountId: input.accountId,
      targetAccountName: null,
      statusBefore: null,
      maxUsage7dPercent: input.maxUsage7dPercent,
      proxyMode: input.proxyMode ?? 'existing',
      loginMaterialSource: input.loginMaterialSource,
    }, options)
  }

  private begin(
    input: ExecutableTaskInput,
    initialSelection: CreateTaskSelection | ReauthorizeTaskSelection,
    options: BeginOptions = {},
  ): PublicTask {
    if (this.#active) {
      throw new AppError('TASK_ALREADY_ACTIVE', '当前已有一个账号任务正在运行。', { statusCode: 409 })
    }
    if (options.reservation) {
      if (this.#externalReservation !== options.reservation) {
        throw new AppError('TASK_EXECUTION_RESERVATION_INVALID', '外部任务执行预约无效。', { statusCode: 409 })
      }
    } else if (this.#externalReservation) {
      throw new AppError('TASK_ALREADY_ACTIVE', '当前已有一个账号任务正在运行。', { statusCode: 409 })
    }
    const now = this.#now().toISOString()
    const task: PublicTask = {
      id: this.#id(),
      accountEmail: input.accountEmail,
      stage: 'validating',
      status: 'active',
      selection: initialSelection,
      authorization: null,
      deactivation: null,
      terminalFromStage: null,
      account: null,
      error: null,
      message:
        input.loginMaterialSource === 'account_pool'
          ? '正在从本地账号池获取登录材料。'
          : messageFor('validating'),
      createdAt: now,
      updatedAt: now,
    }
    // URLs are one-time secrets. Keep only the current task's URL in memory.
    this.#authorizationUrls.clear()
    this.dependencies.database.saveTask(task)
    this.emit(task)
    const machine = new TaskStateMachine(
      task,
      (next) => this.dependencies.database.saveTask(next),
      (next) => this.emit(next),
      this.#now,
    )
    const abortController = new AbortController()
    const takeover = new ManualTakeoverGate()
    this.#active = { id: task.id, machine, abortController, takeover }
    if (options.reservation) this.#externalReservation = undefined
    const run = Promise.resolve()
      .then(() => this.execute(input, machine, abortController, takeover))
      .finally(() => {
        if (this.#active?.id === task.id) this.#active = undefined
    })
    this.#runs.set(task.id, run)
    void run.then(
      () => {
        this.#runs.delete(task.id)
      },
      () => {
        this.#runs.delete(task.id)
      },
    )
    return structuredClone(task)
  }

  cancel(taskId: string): PublicTask {
    if (!this.#active || this.#active.id !== taskId) {
      throw new AppError('TASK_NOT_ACTIVE', '该任务当前未在运行。', { statusCode: 404 })
    }
    const cancelled = this.#active.machine.cancel()
    this.#active.abortController.abort()
    return cancelled
  }

  takeOver(taskId: string): PublicTask {
    if (!this.#active || this.#active.id !== taskId) {
      throw new AppError('TASK_NOT_ACTIVE', '该任务当前未在运行。', { statusCode: 404 })
    }
    const current = this.#active.machine.current
    if (!current.authorization?.browserOpenedAt || !this.#active.machine.canCancel()) {
      throw new AppError('TASK_TAKEOVER_NOT_ALLOWED', '当前阶段不能人工接管。', { statusCode: 409 })
    }
    this.#active.takeover.takeOver()
    return this.#active.machine.update({
      manualTakeover: true,
      message: '人工接管中，自动化已在安全操作边界暂停。完成手动操作后请点击“取消接管”。',
    })
  }

  releaseTakeover(taskId: string): PublicTask {
    if (!this.#active || this.#active.id !== taskId) {
      throw new AppError('TASK_NOT_ACTIVE', '该任务当前未在运行。', { statusCode: 404 })
    }
    if (!this.#active.takeover.active) return this.#active.machine.current
    this.#active.takeover.release()
    return this.#active.machine.update({
      manualTakeover: false,
      message: '已取消人工接管，正在从当前页面继续自动流程。',
    })
  }

  async waitForCompletion(taskId: string): Promise<PublicTask> {
    const running = this.#runs.get(taskId)
    if (running) return running
    const task = this.dependencies.database.getTask(taskId)
    if (!task) throw new AppError('TASK_NOT_FOUND', '未找到任务。', { statusCode: 404 })
    return task
  }

  subscribe(listener: TaskListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get activeTask(): PublicTask | null {
    return this.#active?.machine.current ?? null
  }

  getAuthorizationUrl(taskId: string): string | null {
    return this.#authorizationUrls.get(taskId) ?? null
  }

  forgetAuthorizationUrl(taskId: string): void {
    this.#authorizationUrls.delete(taskId)
  }

  async shutdown(): Promise<void> {
    const active = this.#active
    if (!active) return
    if (active.machine.canCancel()) {
      active.machine.cancel()
      active.abortController.abort()
    }
    const running = this.#runs.get(active.id)
    if (running) await running
  }

  private emit(task: PublicTask): void {
    const publicCopy = structuredClone(task)
    for (const listener of this.#listeners) listener(publicCopy)
  }

  private async resolveLoginMaterial(
    input: ExecutableTaskInput,
    signal: AbortSignal,
  ): Promise<RuntimeLoginMaterial> {
    if (input.loginMaterialSource === 'manual') {
      if (!input.loginMaterial) throw new AppError('LOGIN_MATERIAL_MISSING', '缺少手动登录材料。')
      return input.loginMaterial
    }
    if (!this.dependencies.accountPool) {
      throw new AppError('ACCOUNT_POOL_NOT_CONFIGURED', '本地账号池桥接尚未配置。', { statusCode: 503 })
    }
    const materials = await this.dependencies.accountPool.resolve(input.accountEmail, signal, input.materialScope)
    const selected = selectAccountPoolMaterial(input.accountEmail, materials)
    if (selected.kind === 'email_otp') {
      return {
        kind: selected.kind,
        mailboxAccess: mailboxPasswordFromInput(
          input.accountEmail,
          selected.mailboxAccess,
          input.trustedPathOrigins,
        ),
      }
    }
    return selected
  }

  private async execute(
    input: ExecutableTaskInput,
    machine: TaskStateMachine,
    abortController: AbortController,
    takeover: ManualTakeoverGate,
  ): Promise<PublicTask> {
    const scope = this.#createSecretScope()
    const signal = abortController.signal
    const waitForTakeover = () => takeover.wait(signal)
    const startedAt = this.#now()
    const deactivationConfirmationAttempts = Math.max(
      1,
      Math.min(10, this.dependencies.deactivationConfirmationAttempts?.() ?? 2),
    )
    let browserSession: OAuthBrowserSession | undefined
    let target: ReauthorizationTarget | undefined
    let backendWriteStarted = false
    const beforeBackendWrite = async (stage: BackendWriteStage): Promise<void> => {
      if (backendWriteStarted) {
        throw new AppError('TASK_BACKEND_WRITE_ALREADY_STARTED', '后台写入阶段不能重复开始。', {
          statusCode: 409,
        })
      }
      backendWriteStarted = true
      await input.beforeBackendWrite?.(stage)
    }
    try {
      const loginMaterial = await this.resolveLoginMaterial(input, signal)
      if (loginMaterial.kind === 'email_otp') {
        scope.set('mailboxAccess', loginMaterial.mailboxAccess)
      } else {
        scope.set('accountPassword', loginMaterial.password)
        scope.set('totpSecret', loginMaterial.totpSecret)
      }
      let selection: PublicTask['selection'] = machine.current.selection
      let createSelection: CreateTaskSelection | undefined
      let confirmMixedChannelRisk = false
      if (input.operation === 'reauthorize') {
        machine.transition('loading_target_account', { message: messageFor('loading_target_account') })
        target = await this.dependencies.accountReauthorizer.loadTarget(
          input.accountId,
          input.accountEmail,
          true,
          input.maxUsage7dPercent,
        )
        const reauthorizationProxyMode = input.proxyMode ?? 'existing'
        selection = {
          operation: 'reauthorize',
          targetAccountId: target.account.id,
          targetAccountName: target.account.name,
          statusBefore: target.account.status,
          maxUsage7dPercent: input.maxUsage7dPercent,
          proxyMode: reauthorizationProxyMode,
          loginMaterialSource: input.loginMaterialSource,
        }
        machine.transition('loading_options', { selection, message: messageFor('loading_options') })
      } else {
        machine.transition('loading_options', { message: messageFor('loading_options') })
      }
      const options =
        input.operation === 'create' || (input.proxyMode ?? 'existing') === 'existing'
          ? await this.dependencies.options.loadSnapshot()
          : undefined
      if (input.operation === 'create') {
        createSelection = validateTaskSelection(input, options!)
        selection = createSelection
        machine.transition('checking_existing', { selection, message: messageFor('checking_existing') })
        const mixedChannel = await this.dependencies.oauth.checkMixedChannel(
          selection.groups.map((group) => group.id),
        )
        if (mixedChannel.hasRisk && !input.confirmMixedChannelRisk) {
          throw new AppError(
            'MIXED_CHANNEL_CONFIRMATION_REQUIRED',
            '所选分组存在混合渠道风险，请开启“确认混合渠道风险”后重新开始。',
            { statusCode: 409 },
          )
        }
        confirmMixedChannelRisk = mixedChannel.hasRisk && input.confirmMixedChannelRisk

        const existing = input.allowDuplicateCreation
          ? null
          : await this.dependencies.accountCreator.findExactDuplicate(input.accountEmail)
        if (existing) {
          return machine.transition('already_exists', {
            account: accountResult(existing),
            message: messageFor('already_exists'),
          })
        }
      }

      let baseline: MailBaseline | undefined
      let otpRequestedAt = startedAt
      if (loginMaterial.kind === 'email_otp') {
        machine.transition('mail_baseline', { message: messageFor('mail_baseline') })
        baseline = await this.dependencies.mail.establishBaseline(
          input.accountEmail,
          scope.require<string>('mailboxAccess'),
          signal,
          input.trustedPathOrigins,
        )
      }

      machine.transition('resolving_proxy', { message: messageFor('resolving_proxy') })
      const failedDynamicProxyIds = new Set<number>()
      const resolveCreateProxy = async (proxyChoice: Extract<typeof input, { operation: 'create' }>['proxyChoice']) => {
        let metadataError: AppError | undefined
        for (let candidate = 1; candidate <= DYNAMIC_PROXY_RESOLUTION_CANDIDATES; candidate += 1) {
          try {
            return await this.dependencies.proxyResolver.resolve(
              proxyChoice,
              options!,
              candidate === 1 ? input.accountEmail : `${input.accountEmail}#proxy-initial-${candidate}`,
            )
          } catch (error) {
            if (
              proxyChoice.mode !== 'dynamic' ||
              !(error instanceof AppError) ||
              error.code !== 'PROXY_ASSIGNMENT_METADATA_NODE'
            ) {
              throw error
            }
            metadataError = error
            const rejectedProxyId = error.details?.proxyId
            if (typeof rejectedProxyId === 'number') failedDynamicProxyIds.add(rejectedProxyId)
          }
        }
        throw new AppError(
          'BROWSER_PROXY_CONNECTION_FAILED',
          '动态代理订阅连续返回流量或到期信息节点，请刷新或更换订阅后重试。',
          { statusCode: 502, retryable: true, cause: metadataError },
        )
      }
      let resolvedProxy =
        input.operation === 'create'
          ? await resolveCreateProxy(input.proxyChoice)
          : (input.proxyMode ?? 'existing') === 'none'
            ? { mode: 'none' as const }
            : await this.resolveReauthorizationProxy(target!.account, options!, input.accountEmail)
      let resolvedSelection = this.withResolvedProxy(selection, resolvedProxy)

      machine.transition('generating_auth_url', {
        selection: resolvedSelection,
        message: messageFor('generating_auth_url'),
      })
      let previousGeneratedAuth: GeneratedAuth | undefined
      const startAuthorizationAttempt = async (attempt: number) => {
        const generated = scope.set<GeneratedAuth>(
          `generatedAuth:${attempt}`,
          await this.dependencies.oauth.generateAuthUrl(
            resolvedProxy.mode === 'none'
              ? {}
              : {
                  ...(resolvedProxy.proxyId ? { proxyId: resolvedProxy.proxyId } : {}),
                  ...(resolvedProxy.machineId ? { machineId: resolvedProxy.machineId } : {}),
                },
          ),
        )
        if (
          attempt > 1 &&
          previousGeneratedAuth &&
          (generated.sessionId === previousGeneratedAuth.sessionId || generated.state === previousGeneratedAuth.state)
        ) {
          throw new AppError(
            'OAUTH_DEACTIVATION_CONFIRMATION_SESSION_REUSED',
            `第 ${attempt} 次授权没有取得新的 OAuth 会话，未确认停用，也未标记封号。`,
            { statusCode: 502, retryable: true },
          )
        }
        previousGeneratedAuth = generated
        this.#authorizationUrls.set(machine.current.id, generated.authUrl)
        const diagnostics: OAuthNavigationDiagnostics = {
          generated: describeOAuthUrl(generated.authUrl),
          initialNavigation: null,
          redirect: null,
        }
        let authorization = {
          source: 'backend_generate_auth_url' as const,
          validated: true as const,
          navigationValidated: false,
          receivedAt: this.#now().toISOString(),
          browserOpenedAt: null as string | null,
          urlOpenedAt: null as string | null,
          diagnostics,
        }
        const attemptLabel = attempt === 1 ? '' : `第 ${attempt} 次独立确认：`
        machine.transition('authorization_url_received', {
          authorization,
          message: `${attemptLabel}${messageFor('authorization_url_received')}`,
        })
        const markBrowserStarted = () => {
          if (machine.current.stage !== 'authorization_url_received') return
          authorization = { ...authorization, browserOpenedAt: this.#now().toISOString() }
          machine.transition('browser_started', {
            authorization,
            message: `${attemptLabel}${messageFor('browser_started')}`,
          })
        }
        const markAuthorizationUrlOpened = (
          evidence?: Parameters<NonNullable<Parameters<OAuthBrowserDriver['start']>[0]['onAuthorizationUrlOpened']>>[0],
        ) => {
          markBrowserStarted()
          if (machine.current.stage !== 'browser_started') return
          authorization = {
            ...authorization,
            navigationValidated: true,
            urlOpenedAt: this.#now().toISOString(),
            diagnostics: {
              ...authorization.diagnostics,
              initialNavigation: evidence?.initialNavigation ?? null,
              redirect: evidence?.redirect ?? null,
            },
          }
          machine.transition('authorization_url_opened', {
            authorization,
            message: `${attemptLabel}${messageFor('authorization_url_opened')}`,
          })
        }
        const session = await this.dependencies.browser.start({
          authUrl: generated.authUrl,
          ...(resolvedProxy.mode === 'none' ? {} : { browserProxy: resolvedProxy.browserProxy }),
          signal,
          onBrowserStarted: markBrowserStarted,
          onAuthorizationUrlOpened: markAuthorizationUrlOpened,
        })
        markAuthorizationUrlOpened()
        return { generated, session }
      }

      const startAuthorizationWithProxyRetries = async (attempt: number) => {
        for (let proxyAttempt = 1; proxyAttempt <= DYNAMIC_PROXY_CONNECTION_ATTEMPTS; proxyAttempt += 1) {
          try {
            return await startAuthorizationAttempt(attempt)
          } catch (error) {
            const retryDynamicProxy =
              input.operation === 'create' &&
              input.proxyChoice.mode === 'dynamic' &&
              error instanceof AppError &&
              error.code === 'BROWSER_PROXY_CONNECTION_FAILED' &&
              proxyAttempt < DYNAMIC_PROXY_CONNECTION_ATTEMPTS
            if (!retryDynamicProxy) throw error

            if (resolvedProxy.mode !== 'none' && resolvedProxy.proxyId) {
              failedDynamicProxyIds.add(resolvedProxy.proxyId)
            }
            machine.transition('resolving_proxy', {
              message: `动态代理节点连接失败，正在更换节点（第 ${proxyAttempt + 1}/${DYNAMIC_PROXY_CONNECTION_ATTEMPTS} 轮）。`,
            })

            let nextProxy: ResolvedProxy | undefined
            for (
              let candidate = 1;
              candidate <= DYNAMIC_PROXY_RESOLUTION_CANDIDATES;
              candidate += 1
            ) {
              let resolved: ResolvedProxy
              try {
                resolved = await this.dependencies.proxyResolver.resolve(
                  input.proxyChoice,
                  options!,
                  `${input.accountEmail}#proxy-retry-${attempt}-${proxyAttempt + 1}-${candidate}`,
                )
              } catch (candidateError) {
                if (
                  candidateError instanceof AppError &&
                  candidateError.code === 'PROXY_ASSIGNMENT_METADATA_NODE'
                ) {
                  const rejectedProxyId = candidateError.details?.proxyId
                  if (typeof rejectedProxyId === 'number') failedDynamicProxyIds.add(rejectedProxyId)
                  continue
                }
                throw candidateError
              }
              if (
                resolved.mode !== 'none' &&
                (!resolved.proxyId || !failedDynamicProxyIds.has(resolved.proxyId))
              ) {
                nextProxy = resolved
                break
              }
            }
            if (!nextProxy) throw error

            resolvedProxy = nextProxy
            resolvedSelection = this.withResolvedProxy(selection, resolvedProxy)
            machine.transition('generating_auth_url', {
              selection: resolvedSelection,
              message: `已更换动态代理节点，正在重新生成授权链接（第 ${proxyAttempt + 1}/${DYNAMIC_PROXY_CONNECTION_ATTEMPTS} 轮）。`,
            })
          }
        }
        throw new AppError(
          'BROWSER_PROXY_CONNECTION_FAILED',
          '动态代理节点连续三轮无法从这台 Mac 建立连接，请更换订阅后重试。',
          { statusCode: 502, retryable: true },
        )
      }

      let authorizationAttempt = 1
      let { generated, session: activeBrowserSession } = await startAuthorizationWithProxyRetries(authorizationAttempt)
      browserSession = activeBrowserSession

      const preferredLogin = loginMaterial.kind === 'email_otp' ? 'email_otp' : 'password'
      let manualWait:
        | {
            blockedPage: AutomatedPageKind
            reason: ManualInterventionReason
          }
        | undefined
      const enterManualIntervention = (
        phase: ManualInterventionPhase,
        reason: ManualInterventionReason,
        blockedPage: AutomatedPageKind,
      ) => {
        manualWait = { blockedPage, reason }
        machine.transition('manual_intervention', {
          message: manualInterventionMessage(phase, reason),
        })
      }
      const markInitialOtpRequest =
        loginMaterial.kind === 'email_otp'
          ? async () => {
              otpRequestedAt = this.#now()
            }
          : undefined
      let latestResendRequestedAt: Date | undefined
      let callback: OAuthCallbackResult | undefined
      let deactivationDetectedCount = 0
      while (!callback) {
        try {
          await waitForTakeover()
          const emailAction = await activeBrowserSession.submitEmail(
            input.accountEmail,
            preferredLogin,
            markInitialOtpRequest,
          )
          if (emailAction.kind === 'manual_intervention') {
            enterManualIntervention('email', emailAction.reason, 'email')
          } else {
            machine.transition('email_submitted', { message: messageFor('email_submitted') })
            let readyForConsent = false

            if (loginMaterial.kind === 'email_otp') {
              machine.transition('waiting_for_otp', { message: messageFor('waiting_for_otp') })
              let otpCode: string | null = null
              for (let round = 1; round <= EMAIL_OTP_ROUND_LIMIT; round += 1) {
                const roundResult = await this.dependencies.mail.waitForOtp(
                  input.accountEmail,
                  scope.require<string>('mailboxAccess'),
                  baseline!,
                  otpRequestedAt,
                  signal,
                  input.trustedPathOrigins,
                  round > 1
                    ? {
                        allowExistingNewestAfterResend: true,
                        ...(latestResendRequestedAt
                          ? { existingNewestNotBefore: latestResendRequestedAt }
                          : {}),
                      }
                    : {},
                )
                if (roundResult.kind === 'found') {
                  otpCode = roundResult.code
                  break
                }
                if (round === EMAIL_OTP_ROUND_LIMIT) {
                  enterManualIntervention('otp_rounds_exhausted', 'unknown', 'email_otp')
                  break
                }

                const resendingStage = round === 1 ? 'resending_otp' : 'resending_otp_second'
                machine.transition(resendingStage, { message: messageFor(resendingStage) })
                await waitForTakeover()
                const resendAction = await activeBrowserSession.resendOtp(async () => {
                  latestResendRequestedAt = this.#now()
                })
                if (resendAction.kind === 'callback_captured') {
                  machine.transition('waiting_for_callback', { message: messageFor('waiting_for_callback') })
                  break
                }
                if (resendAction.kind === 'consent_ready') {
                  machine.transition('otp_submitted', { message: messageFor('otp_submitted') })
                  readyForConsent = true
                  break
                }
                if (resendAction.kind === 'manual_intervention') {
                  enterManualIntervention('otp_resend', resendAction.reason, 'email_otp')
                  break
                }
                const waitingStage = round === 1 ? 'waiting_for_otp_retry' : 'waiting_for_otp_third'
                machine.transition(waitingStage, {
                  message:
                    resendAction.kind === 'continue_polling'
                      ? `验证码页面仍然有效，正在继续第 ${round + 1} 轮检查最新邮件（最多 60 秒）。`
                      : messageFor(waitingStage),
                })
              }

              if (otpCode) {
                await waitForTakeover()
                const otpAction = await activeBrowserSession.submitEmailOtp(otpCode)
                if (otpAction.kind === 'manual_intervention') {
                  enterManualIntervention('otp', otpAction.reason, 'email_otp')
                } else {
                  machine.transition('otp_submitted', { message: messageFor('otp_submitted') })
                  readyForConsent = true
                }
              }
            } else {
              machine.transition('waiting_for_password', { message: messageFor('waiting_for_password') })
              const passwordFallbacks =
                loginMaterial.kind === 'password_totp'
                  ? [
                      ...(loginMaterial.passwordHyphenFallbacks ?? []).map((password, index) => ({
                        password,
                        totpSecret: loginMaterial.totpSecret,
                        message:
                          index === 0
                            ? '当前密码未通过，正在尝试末尾补短横线的密码。'
                            : '当前密码未通过，正在尝试开头补短横线的密码。',
                      })),
                      ...(loginMaterial.passwordErrorFallback
                        ? [{
                            ...loginMaterial.passwordErrorFallback,
                            message: '补全密码仍未通过，已交换密码和 2FA，正在继续尝试。',
                          }]
                        : []),
                    ]
                  : []
              let passwordFallbackIndex = 0
              const submitNextPassword = async () => {
                const fallback = passwordFallbacks[passwordFallbackIndex++]
                if (!fallback) return null
                machine.update({ message: fallback.message })
                scope.set('accountPassword', fallback.password)
                scope.set('totpSecret', fallback.totpSecret)
                await waitForTakeover()
                return activeBrowserSession.submitPassword(fallback.password, {
                  allowCredentialsErrorPage: true,
                })
              }
              let passwordAction
              try {
                await waitForTakeover()
                passwordAction = await activeBrowserSession.submitPassword(
                  scope.require<string>('accountPassword'),
                )
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'OPENAI_CREDENTIALS_REJECTED') throw error
                const fallbackAction = await submitNextPassword()
                if (!fallbackAction) throw error
                passwordAction = fallbackAction
              }
              while (passwordAction.kind === 'manual_intervention' && passwordAction.reason === 'credentials') {
                const fallbackAction = await submitNextPassword()
                if (!fallbackAction) break
                passwordAction = fallbackAction
              }
              if (passwordAction.kind === 'manual_intervention') {
                enterManualIntervention('password', passwordAction.reason, 'password')
              } else {
                machine.transition('password_submitted', { message: messageFor('password_submitted') })
                const nextPage = await activeBrowserSession.classifyCurrentPage()
                if (nextPage.kind === 'callback_captured') {
                  machine.transition('waiting_for_callback', { message: messageFor('waiting_for_callback') })
                } else if (nextPage.kind === 'consent') {
                  readyForConsent = true
                } else if (nextPage.kind === 'email_otp') {
                  throw new AppError(
                    'OPENAI_EMAIL_VERIFICATION_REQUIRED',
                    '当前账号需要邮箱验证码，但没有可用的接码邮箱链接。',
                    { statusCode: 422 },
                  )
                } else if (nextPage.kind !== 'authenticator_totp') {
                  enterManualIntervention(
                    'totp',
                    nextPage.kind === 'manual_intervention' ? nextPage.reason : 'mfa',
                    'authenticator_totp',
                  )
                } else {
                  machine.transition('waiting_for_totp', { message: messageFor('waiting_for_totp') })
                  const firstToken = await this.#totp.next(
                    scope.require<string>('totpSecret'),
                    undefined,
                    signal,
                  )
                  await waitForTakeover()
                  let totpAction = await activeBrowserSession.submitAuthenticatorTotp(firstToken.code)
                  if (totpAction.kind === 'still_active') {
                    const retryToken = await this.#totp.next(
                      scope.require<string>('totpSecret'),
                      firstToken.counter,
                      signal,
                    )
                    await waitForTakeover()
                    totpAction = await activeBrowserSession.submitAuthenticatorTotp(retryToken.code)
                  }
                  if (totpAction.kind === 'manual_intervention' || totpAction.kind === 'still_active') {
                    if (
                      totpAction.kind === 'still_active' ||
                      (totpAction.kind === 'manual_intervention' && totpAction.reason === 'credentials')
                    ) {
                      throw new AppError(
                        'OPENAI_CREDENTIALS_REJECTED',
                        'OpenAI 未接受当前账号密码或 2FA 动态码，请确认登录材料有效后重新开始。',
                        { statusCode: 422 },
                      )
                    }
                    enterManualIntervention('totp', totpAction.reason, 'authenticator_totp')
                  } else {
                    machine.transition('totp_submitted', { message: messageFor('totp_submitted') })
                    readyForConsent = true
                  }
                }
              }
            }

            if (readyForConsent) {
              machine.transition('waiting_for_consent', { message: messageFor('waiting_for_consent') })
              await waitForTakeover()
              const consentAction = await activeBrowserSession.submitConsent()
              if (consentAction.kind === 'manual_intervention') {
                enterManualIntervention('consent', consentAction.reason, 'consent')
              } else {
                machine.transition('consent_submitted', { message: messageFor('consent_submitted') })
              }
            }
          }

          let restartAutomation = false
          while (machine.current.stage === 'manual_intervention') {
            const wait = manualWait ?? { blockedPage: 'email' as const, reason: 'unknown' as const }
            const resumedPage = await activeBrowserSession.waitForManualProgress({
              blockedPage: wait.blockedPage,
              preferredLogin,
              requireActivityOnBlockedPage: wait.reason === 'unknown',
              signal,
            })
            if (resumedPage.kind === 'callback_captured') {
              machine.transition('waiting_for_callback', { message: messageFor('waiting_for_callback') })
              callback = scope.set('oauthCallback', await activeBrowserSession.waitForCallback(signal))
              break
            }
            if (resumedPage.kind === 'consent') {
              machine.transition('waiting_for_consent', {
                message: '已检测到人工步骤完成，正在继续 Codex 授权确认。',
              })
              await waitForTakeover()
              const resumedConsent = await activeBrowserSession.submitConsent()
              if (resumedConsent.kind === 'manual_intervention') {
                enterManualIntervention('consent', resumedConsent.reason, 'consent')
                continue
              }
              machine.transition('consent_submitted', { message: messageFor('consent_submitted') })
              break
            }
            manualWait = undefined
            machine.transition('authorization_url_opened', {
              message: '已检测到人工操作进展，正在从当前页面继续自动化。',
            })
            restartAutomation = true
          }
          if (restartAutomation) continue
          if (machine.current.stage === 'consent_submitted') {
            machine.transition('waiting_for_callback', { message: messageFor('waiting_for_callback') })
          }
          if (!callback) {
            await waitForTakeover()
            callback = scope.set('oauthCallback', await activeBrowserSession.waitForCallback(signal))
          }
          if (callback.state !== generated.state) {
            throw new AppError('OAUTH_CALLBACK_STATE_MISMATCH', 'OAuth 回调 state 校验失败。')
          }
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'OPENAI_ACCOUNT_DEACTIVATED') throw error
          deactivationDetectedCount += 1
          if (deactivationDetectedCount < deactivationConfirmationAttempts) {
            const nextAttempt = deactivationDetectedCount + 1
            machine.transition('account_deactivated_retrying', {
              deactivation: {
                detectedCount: deactivationDetectedCount,
                confirmationAttempts: deactivationConfirmationAttempts,
                retryAttempted: true,
                confirmed: false,
                targetAccountId: input.operation === 'reauthorize' ? input.accountId : null,
                banResult: 'pending',
              },
              message: `第 ${deactivationDetectedCount} 次授权检测到 account_deactivated，正在关闭旧窗口并启动第 ${nextAttempt} 次独立授权确认。`,
            })
            await activeBrowserSession.close()
            browserSession = undefined
            authorizationAttempt = nextAttempt
            machine.transition('generating_auth_url', {
              message: `第 ${nextAttempt} 次独立确认：正在重新生成新的 OpenAI OAuth 授权链接。`,
            })
            const retryAttempt = await startAuthorizationWithProxyRetries(authorizationAttempt)
            generated = retryAttempt.generated
            activeBrowserSession = retryAttempt.session
            browserSession = activeBrowserSession
            continue
          }
          return await this.finishConfirmedDeactivation(
            input,
            target,
            machine,
            beforeBackendWrite,
            deactivationDetectedCount,
            deactivationConfirmationAttempts,
          )
        }
      }

      machine.transition('exchanging_code', { message: messageFor('exchanging_code') })
      const credentials = scope.set<OpenAICredentials>(
        'oauthCredentials',
        await this.dependencies.oauth.exchangeCode({
          sessionId: generated.sessionId,
          code: callback.code,
          state: callback.state,
          ...(resolvedProxy.mode !== 'none' && resolvedProxy.proxyId
            ? { proxyId: resolvedProxy.proxyId }
            : {}),
        }),
      )

      if (input.operation === 'reauthorize') {
        this.dependencies.accountReauthorizer.assertOAuthEmail(target!, credentials)
        const currentTarget = await this.dependencies.accountReauthorizer.loadTarget(
          target!.account.id,
          target!.email,
          true,
          input.maxUsage7dPercent,
        )
        this.dependencies.accountReauthorizer.assertUnchanged(target!, currentTarget)
        machine.transition('applying_oauth_credentials', {
          message: messageFor('applying_oauth_credentials'),
        })
        await beforeBackendWrite('applying_oauth_credentials')
        const reauthorized = await this.dependencies.accountReauthorizer.applyAndConfirm(
          currentTarget,
          credentials,
          () => {
            if (machine.current.stage === 'applying_oauth_credentials') {
              machine.transition('reauthorization_result_uncertain', {
                message: messageFor('reauthorization_result_uncertain'),
              })
            }
          },
          () => {
            if (machine.current.stage === 'applying_oauth_credentials') {
              machine.transition('confirming_reauthorization', {
                message: messageFor('confirming_reauthorization'),
              })
            }
          },
        )
        return machine.transition('completed', {
          account: reauthorized,
          message:
            machine.current.stage === 'reauthorization_result_uncertain'
              ? '后台查询已确认原账号重新授权完成。'
              : '原账号重新授权完成。',
        })
      }

      machine.transition('checking_duplicate', { message: messageFor('checking_duplicate') })
      const finalDuplicate = input.allowDuplicateCreation
        ? null
        : await this.dependencies.accountCreator.findExactDuplicate(input.accountEmail)
      if (finalDuplicate) {
        return machine.transition('already_exists', {
          account: accountResult(finalDuplicate),
          message: messageFor('already_exists'),
        })
      }

      const payload = buildOpenAIAccountPayload({
        email: input.accountEmail,
        credentials,
        ...(resolvedProxy.mode !== 'none' && resolvedProxy.proxyId
          ? { proxyId: resolvedProxy.proxyId }
          : {}),
        ...(resolvedProxy.mode !== 'none' && resolvedProxy.machineId
          ? { machineId: resolvedProxy.machineId }
          : {}),
        ...(resolvedProxy.mode !== 'none' && resolvedProxy.assignmentMode
          ? { assignmentMode: resolvedProxy.assignmentMode }
          : {}),
        ...(resolvedProxy.mode !== 'none' && resolvedProxy.subscriptionId
          ? { subscriptionId: resolvedProxy.subscriptionId }
          : {}),
        concurrency: input.concurrency,
        supplier: input.supplier,
        groupIds: createSelection!.groups.map((group) => group.id),
        confirmMixedChannelRisk,
      })
      machine.transition('creating_account', { message: messageFor('creating_account') })
      await beforeBackendWrite('creating_account')
      let created: AccountResult
      try {
        created = await this.dependencies.accountCreator.createAndConfirm(payload)
      } catch (error) {
        if (error instanceof AppError && error.code === 'mixed_channel_warning') {
          throw new AppError(
            'MIXED_CHANNEL_CONFIRMATION_REQUIRED',
            '后台检测到混合渠道风险，请开启“确认混合渠道风险”后重新开始。',
            { statusCode: 409 },
          )
        }
        if (!isUncertainCreateError(error)) throw error
        machine.transition('create_result_uncertain', { message: messageFor('create_result_uncertain') })
        if (input.allowDuplicateCreation) {
          throw new AppError(
            'ACCOUNT_CREATE_UNCERTAIN',
            '创建响应不确定，未自动重试，请到后台确认新账号是否已创建。',
            { statusCode: 502 },
          )
        }
        let confirmed: BackendAccount | null = null
        try {
          confirmed = await this.dependencies.accountCreator.findExactDuplicate(input.accountEmail)
        } catch {
          // The original create result remains uncertain; do not replay it.
        }
        if (!confirmed) {
          throw new AppError('ACCOUNT_CREATE_UNCERTAIN', '无法确认后台是否已创建账号，已禁止自动重试。', {
            statusCode: 502,
          })
        }
        return machine.transition('completed', {
          account: accountResult(confirmed),
          message: '后台查询已确认账号创建完成。',
        })
      }
      machine.transition('confirming_account', {
        account: accountResult(created),
        message: messageFor('confirming_account'),
      })
      return machine.transition('completed', {
        account: accountResult(created),
        message: messageFor('completed'),
      })
    } catch (error) {
      const current = machine.current
      if (isTerminalTaskStage(current.stage)) return current
      if (error instanceof AppError && error.code === 'TASK_CANCELLED') {
        return machine.canCancel() ? machine.cancel() : current
      }
      if (
        error instanceof AppError &&
        error.code === 'MAILBOX_ACCOUNT_EXPIRED' &&
        input.operation === 'reauthorize' &&
        target
      ) {
        try {
          await beforeBackendWrite('marking_mailbox_expired')
          if (!this.dependencies.accountReauthorizer.markMailboxExpired) {
            throw new AppError('MAILBOX_EXPIRY_NOTE_FAILED', '邮箱已确认过期，但后台账号名称无法更新。', {
              statusCode: 502,
            })
          }
          await this.dependencies.accountReauthorizer.markMailboxExpired(target)
        } catch (noteError) {
          return machine.transition('failed', {
            error: toPublicError(noteError, current.stage),
            message: noteError instanceof AppError ? noteError.message : '邮箱已确认过期，但后台账号名称更新失败。',
          })
        }
      }
      if (
        isMailboxAccessFailure(error) &&
        input.operation === 'reauthorize' &&
        target
      ) {
        try {
          await beforeBackendWrite('marking_mailbox_access_expired')
          if (!this.dependencies.accountReauthorizer.markMailboxAccessExpired) {
            throw new AppError('ACCOUNT_NAME_NOTE_FAILED', '邮箱接码链接已失效，但后台账号名称无法更新。', {
              statusCode: 502,
            })
          }
          await this.dependencies.accountReauthorizer.markMailboxAccessExpired(target)
        } catch (noteError) {
          return machine.transition('failed', {
            error: toPublicError(noteError, current.stage),
            message: noteError instanceof AppError ? noteError.message : '邮箱接码链接已失效，但后台账号名称更新失败。',
          })
        }
      }
      if (
        error instanceof AppError &&
        error.code === 'OPENAI_PHONE_VERIFICATION_REQUIRED' &&
        input.operation === 'reauthorize' &&
        target
      ) {
        try {
          await beforeBackendWrite('marking_phone_verification')
          if (!this.dependencies.accountReauthorizer.markPhoneVerification) {
            throw new AppError('ACCOUNT_NAME_NOTE_FAILED', '已检测到手机接码，但后台账号名称无法更新。', {
              statusCode: 502,
            })
          }
          await this.dependencies.accountReauthorizer.markPhoneVerification(target)
        } catch (noteError) {
          return machine.transition('failed', {
            error: toPublicError(noteError, current.stage),
            message: noteError instanceof AppError ? noteError.message : '已检测到手机接码，但后台账号名称更新失败。',
          })
        }
      }
      if (
        error instanceof AppError &&
        error.code === 'OPENAI_EMAIL_VERIFICATION_REQUIRED' &&
        input.operation === 'reauthorize' &&
        target
      ) {
        try {
          await beforeBackendWrite('marking_mailbox_access_missing')
          if (!this.dependencies.accountReauthorizer.markMailboxAccessMissing) {
            throw new AppError('ACCOUNT_NAME_NOTE_FAILED', '账号需要邮箱验证，但后台账号名称无法更新。', {
              statusCode: 502,
            })
          }
          await this.dependencies.accountReauthorizer.markMailboxAccessMissing(target)
        } catch (noteError) {
          return machine.transition('failed', {
            error: toPublicError(noteError, current.stage),
            message: noteError instanceof AppError ? noteError.message : '账号需要邮箱验证，但后台账号名称更新失败。',
          })
        }
      }
      return machine.transition('failed', {
        error: toPublicError(error, current.stage),
        message: error instanceof AppError ? error.message : messageFor('failed'),
      })
    } finally {
      await browserSession?.close().catch(() => undefined)
      scope.dispose()
    }
  }

  private async finishConfirmedDeactivation(
    input: ExecutableTaskInput,
    target: ReauthorizationTarget | undefined,
    machine: TaskStateMachine,
    beforeBackendWrite: (stage: BackendWriteStage) => Promise<void>,
    detectedCount: number,
    confirmationAttempts: number,
  ): Promise<PublicTask> {
    if (!this.dependencies.accountDeactivation) {
      throw new AppError(
        'ACCOUNT_DEACTIVATION_NOT_CONFIGURED',
        '封号处理器尚未配置，未修改后台状态。',
        { statusCode: 503 },
      )
    }
    let progress: NonNullable<PublicTask['deactivation']> = {
      detectedCount,
      confirmationAttempts,
      retryAttempted: detectedCount > 1,
      confirmed: true,
      targetAccountId: input.operation === 'reauthorize' ? input.accountId : null,
      banResult: 'pending',
    }
    machine.transition('account_deactivated_confirmed', {
      deactivation: progress,
      message: `连续 ${detectedCount} 次授权检测到 account_deactivated，已确认该 OpenAI 账号停用。`,
    })
    machine.transition('locating_deactivated_account', {
      message: '正在严格定位唯一对应的后台 OpenAI OAuth 账号。',
    })

    let accountId: number
    let expectedEmail: string
    if (input.operation === 'reauthorize') {
      if (!target) {
        throw new AppError('ACCOUNT_BAN_TARGET_MISSING', '重新授权目标账号已经丢失，未修改后台状态。', {
          statusCode: 409,
        })
      }
      accountId = target.account.id
      expectedEmail = target.email
    } else {
      const located = await this.dependencies.accountDeactivation.locateCreateTarget(input.accountEmail)
      if (located.kind !== 'unique') {
        progress = {
          ...progress,
          banResult: located.kind,
        }
        const error = new AppError(
          located.kind === 'no_matching_account'
            ? 'OPENAI_ACCOUNT_DEACTIVATED_NO_BACKEND_ACCOUNT'
            : 'OPENAI_ACCOUNT_DEACTIVATED_AMBIGUOUS_ACCOUNT',
          located.kind === 'no_matching_account'
            ? '已确认 OpenAI 账号停用，但后台没有可唯一标记的账号。'
            : '已确认 OpenAI 账号停用，但后台存在多条同邮箱账号，未修改任何状态。',
          { statusCode: 409 },
        )
        return machine.transition('failed', {
          deactivation: progress,
          error: toPublicError(error, machine.current.stage),
          message: error.message,
        })
      }
      accountId = located.account.id
      expectedEmail = input.accountEmail
    }

    progress = { ...progress, targetAccountId: accountId }
    machine.transition('marking_account_banned', {
      deactivation: progress,
      message: `正在将后台账号 ${accountId} 标记为封号，此写入不会自动重放。`,
    })
    await beforeBackendWrite('marking_account_banned')
    try {
      const outcome = await this.dependencies.accountDeactivation.markBanned(
        accountId,
        expectedEmail,
        confirmationAttempts,
      )
      progress = {
        ...progress,
        banResult: outcome.kind,
      }
      machine.transition('confirming_account_banned', {
        deactivation: progress,
        account: outcome.account,
        message:
          outcome.kind === 'already_banned'
            ? `后台账号 ${accountId} 原本已经是封号状态。`
            : `后台账号 ${accountId} 已确认标记为封号。`,
      })
      const error = new AppError(
        'OPENAI_ACCOUNT_DEACTIVATED_BANNED',
        outcome.kind === 'already_banned'
          ? 'OpenAI 账号已确认停用；对应后台账号原本已经封号。'
          : 'OpenAI 账号已确认停用；对应后台账号已标记为封号。',
        { statusCode: 422 },
      )
      return machine.transition('failed', {
        deactivation: progress,
        account: outcome.account,
        error: toPublicError(error, machine.current.stage),
        message: error.message,
      })
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError('ACCOUNT_BAN_WRITE_UNCERTAIN', '封号写入结果无法确认。', {
              statusCode: 502,
              cause: error,
            })
      progress = {
        ...progress,
        banResult:
          appError.code === 'ACCOUNT_BAN_WRITE_REJECTED'
            ? 'write_rejected'
            : 'write_uncertain',
      }
      return machine.transition('failed', {
        deactivation: progress,
        error: toPublicError(appError, machine.current.stage),
        message: appError.message,
      })
    }
  }

  private withResolvedProxy(
    selection: PublicTask['selection'],
    resolved: ResolvedProxy,
  ): PublicTask['selection'] {
    if (resolved.mode === 'none') {
      return selection.operation === 'reauthorize' ? { ...selection, proxyMode: 'none' } : selection
    }
    if (selection.operation === 'reauthorize') {
      return {
        ...selection,
        proxyMode: 'existing',
        ...(resolved.proxyId ? { proxyId: resolved.proxyId } : {}),
        ...(resolved.machineId ? { machineId: resolved.machineId } : {}),
        proxyName: resolved.proxyName,
      }
    }
    return {
      ...selection,
      ...(resolved.proxyId ? { proxyId: resolved.proxyId } : {}),
      ...(resolved.machineId ? { machineId: resolved.machineId } : {}),
      proxyName: resolved.proxyName,
    }
  }

  private async resolveReauthorizationProxy(
    account: BackendAccount,
    options: Awaited<ReturnType<OptionsAdapter['loadSnapshot']>>,
    accountEmail: string,
  ): Promise<ResolvedProxy> {
    if (!account.proxyId && !account.machineId) return { mode: 'none' }
    const option = account.machineId
      ? options.proxies.find((candidate) => candidate.proxyMachineId === account.machineId)
      : options.proxies.find(
          (candidate) =>
            candidate.id === account.proxyId || candidate.proxyMachineProxyId === account.proxyId,
        )
    if (!option) {
      throw new AppError(
        'REAUTHORIZATION_PROXY_INVALID',
        '原账号使用的代理已经失效，不能按原网络路径重新授权。',
        { statusCode: 409 },
      )
    }
    try {
      const resolved = await this.dependencies.proxyResolver.resolve(
        { mode: 'fixed', proxyId: option.id },
        options,
        accountEmail,
      )
      if (resolved.mode !== 'none' && isLoopbackProxyServer(resolved.browserProxy.server)) {
        return { mode: 'none' }
      }
      return resolved
    } catch (error) {
      throw new AppError(
        'REAUTHORIZATION_PROXY_INVALID',
        '原账号使用的代理无法连接，不能按原网络路径重新授权。',
        { statusCode: 409, cause: error },
      )
    }
  }

}
