import { z } from 'zod'
import {
  CreateTaskInputSchema,
  ReauthorizeTaskInputSchema,
  type OptionsSnapshot,
  type PublicTask,
  type ReauthorizationAccountPage,
} from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type { CredentialStore } from '../session/keychain'
import type { BackendWriteStage, ExternalExecutionReservation } from '../tasks/orchestrator'
import type { RoutedAccountPoolResolver } from './material-resolver'
import type {
  AgentOrchestrator,
  PairProvisioningAgentInput,
  ProvisioningAgentController,
  ProvisioningAgentStatus,
} from './types'

const DEVICE_TOKEN_ACCOUNT = 'central-device-token'
const SETTING_ORIGIN = 'provisioning_agent_origin'
const SETTING_DEVICE_ID = 'provisioning_agent_device_id'
const SETTING_DEVICE_NAME = 'provisioning_agent_device_name'
const SETTING_ACTIVE_CENTRAL_TASK = 'provisioning_agent_active_central_task'
const SETTING_ACTIVE_LOCAL_TASK = 'provisioning_agent_active_local_task'
const MAX_RESPONSE_BYTES = 1024 * 1024
const BACKEND_WRITE_STAGES = new Set([
  'marking_account_banned',
  'marking_mailbox_expired',
  'marking_phone_verification',
  'confirming_account_banned',
  'applying_oauth_credentials',
  'confirming_reauthorization',
  'reauthorization_result_uncertain',
  'creating_account',
  'confirming_account',
  'create_result_uncertain',
])
const UNCERTAIN_TERMINAL_CODES = new Set([
  'ACCOUNT_CREATE_UNCERTAIN',
  'ACCOUNT_REAUTHORIZATION_UNCERTAIN',
  'ACCOUNT_BAN_WRITE_UNCERTAIN',
  'ACCOUNT_NAME_NOTE_UNCERTAIN',
])

const pairResponseSchema = z
  .object({
    deviceId: z.string().uuid(),
    deviceToken: z.string().min(32).max(256),
    name: z.string().min(1).max(80),
  })
  .strict()
const selfResponseSchema = z
  .object({
    deviceId: z.string().uuid(),
    name: z.string().min(1).max(80),
  })
  .strict()
const materialsSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    password: z.string().min(1).max(1024).optional(),
    totpSecret: z.string().min(1).max(1024).optional(),
    mailboxAccess: z.string().min(1).max(4096).optional(),
  })
  .strict()
const controlSchema = z
  .object({
    cancelRequested: z.boolean(),
    writeStarted: z.boolean(),
    status: z.string(),
  })
  .strict()
const jobSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1).max(200),
      kind: z.literal('query_options'),
      payload: z.object({ refresh: z.boolean().optional() }).passthrough(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(200),
      kind: z.literal('query_reauthorization_accounts'),
      payload: z
        .object({
          search: z.string().max(200),
          page: z.number().int().min(1).max(10_000),
          pageSize: z.number().int().min(1).max(100),
          maxUsage7dPercent: z.number().int().min(0).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal('task'),
      operation: z.enum(['create', 'reauthorize']),
      accountEmail: z.string().trim().email().max(320),
      input: z.record(z.string(), z.unknown()),
    })
    .strict(),
])

interface AgentSettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
  getTask(id: string): PublicTask | null
}

interface AgentSession {
  ready(): Promise<void>
  publicSession(): { authenticated: boolean; email: string | null }
}

interface AgentDependencies {
  credentials: CredentialStore
  settings: AgentSettingsStore
  session: AgentSession
  options: { loadSnapshot(): Promise<OptionsSnapshot> }
  reauthorization: {
    listAccounts(input: {
      search: string
      page: number
      pageSize: number
      maxUsage7dPercent: number
    }): Promise<ReauthorizationAccountPage>
  }
  orchestrator: AgentOrchestrator
  materials: RoutedAccountPoolResolver
  fetchImpl?: typeof fetch
}

interface AgentConfiguration {
  centralOrigin: string
  deviceId: string
  deviceName: string
  deviceToken: string
}

export interface ActivateProvisioningAgentInput {
  centralOrigin: string
  deviceId: string
  deviceName: string
  deviceToken: string
}

interface JsonResponse<T> {
  status: number
  data: T | null
}

function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppError('AGENT_ORIGIN_INVALID', '中央号池地址无效。', { statusCode: 400 })
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new AppError('AGENT_ORIGIN_INVALID', '中央号池地址必须是独立的 HTTP 或 HTTPS 站点根地址。', {
      statusCode: 400,
    })
  }
  return url.origin
}

function safeAgentError(error: unknown, fallbackCode = 'AGENT_REQUEST_FAILED') {
  if (error instanceof AppError) {
    return { code: error.code.slice(0, 100), message: error.message.slice(0, 500), retryable: error.retryable }
  }
  return { code: fallbackCode, message: '本地执行助手请求失败。', retryable: true }
}

function centralHttpError(payload: Record<string, unknown>, status: number): AppError {
  const code = typeof payload.code === 'string' ? payload.code : `AGENT_CENTRAL_HTTP_${status}`
  const message =
    typeof payload.error === 'string' ? payload.error : `中央号池请求失败（HTTP ${status}）。`
  if (
    status === 404 &&
    (code === 'PROVISIONING_AGENT_ROUTE_NOT_FOUND' || message === '接口不存在')
  ) {
    return new AppError(
      'AGENT_CENTRAL_PROVISIONING_UNAVAILABLE',
      '该地址未提供中央号池执行助手接口，请确认中央号池地址与端口（当前部署应使用 3001）。',
      { statusCode: 502 },
    )
  }
  return new AppError(code, message, { statusCode: status, retryable: status >= 500 })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function responseJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new AppError('AGENT_PROTOCOL_ERROR', '中央号池响应内容过大。', { statusCode: 502 })
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new AppError('AGENT_PROTOCOL_ERROR', '中央号池响应内容过大。', { statusCode: 502 })
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new AppError('AGENT_PROTOCOL_ERROR', '中央号池响应格式无效。', {
      statusCode: 502,
      cause: error,
    })
  }
}

function terminalPayload(task: PublicTask) {
  const uncertain =
    task.status === 'error' &&
    (UNCERTAIN_TERMINAL_CODES.has(task.error?.code ?? '') || task.deactivation?.banResult === 'write_uncertain')
  const status =
    task.status === 'success'
      ? 'success'
      : task.status === 'cancelled'
        ? 'cancelled'
        : uncertain
          ? 'uncertain'
          : 'error'
  return {
    status,
    stage: task.stage,
    message: task.message,
    result: {
      ...(task.account ? { account: task.account } : {}),
      ...(task.deactivation
        ? {
            deactivation: {
              detectedCount: task.deactivation.detectedCount,
              retryAttempted: task.deactivation.retryAttempted,
              confirmed: task.deactivation.confirmed,
              targetAccountId: task.deactivation.targetAccountId,
              banResult: task.deactivation.banResult,
            },
          }
        : {}),
      ...(task.error
        ? {
            error: {
              code: task.error.code,
              message: task.error.message,
              retryable: task.error.retryable,
            },
          }
        : {}),
      ...(task.terminalFromStage ? { terminalFromStage: task.terminalFromStage } : {}),
    },
  }
}

export class ProvisioningAgentClient implements ProvisioningAgentController {
  readonly #fetch: typeof fetch
  #configuration: AgentConfiguration | null = null
  #controller: AbortController | null = null
  #loops: Promise<void>[] = []
  #connected = false
  #runningTask = false
  #suspendRequested = false
  readonly #suspendWaiters = new Set<() => void>()
  #lastContactAt: string | null = null
  #lastError: ProvisioningAgentStatus['lastError'] = null

  constructor(private readonly dependencies: AgentDependencies) {
    this.#fetch = dependencies.fetchImpl ?? fetch
  }

  async restore(): Promise<void> {
    const centralOrigin = this.dependencies.settings.getSetting(SETTING_ORIGIN)
    const deviceId = this.dependencies.settings.getSetting(SETTING_DEVICE_ID)
    const deviceName = this.dependencies.settings.getSetting(SETTING_DEVICE_NAME)
    const deviceToken = await this.dependencies.credentials.get(DEVICE_TOKEN_ACCOUNT)
    if (!centralOrigin || !deviceId || !deviceName || !deviceToken) return
    try {
      this.#configuration = {
        centralOrigin: normalizeOrigin(centralOrigin),
        deviceId,
        deviceName,
        deviceToken,
      }
      this.startLoops()
    } catch {
      await this.clearConfiguration()
    }
  }

  status(): ProvisioningAgentStatus {
    return {
      paired: Boolean(this.#configuration),
      connected: this.#connected,
      runningTask: this.#runningTask,
      centralOrigin: this.#configuration?.centralOrigin ?? null,
      deviceId: this.#configuration?.deviceId ?? null,
      deviceName: this.#configuration?.deviceName ?? null,
      lastContactAt: this.#lastContactAt,
      lastError: this.#lastError ? { ...this.#lastError } : null,
    }
  }

  async pair(input: PairProvisioningAgentInput): Promise<ProvisioningAgentStatus> {
    this.assertNoPendingTask('重新配对')
    if (this.#configuration) {
      throw new AppError('AGENT_ALREADY_PAIRED', '本地执行助手已经配对，请先断开当前设备。', {
        statusCode: 409,
      })
    }
    const centralOrigin = normalizeOrigin(input.centralOrigin)
    const response = await this.request<unknown>(
      centralOrigin,
      '/api/provisioning/agent/pair',
      {
        method: 'POST',
        body: JSON.stringify({ code: input.pairingCode, name: input.deviceName }),
      },
      null,
      15_000,
    )
    const paired = pairResponseSchema.safeParse(response.data)
    if (response.status !== 201 || !paired.success) {
      throw new AppError('AGENT_PAIRING_PROTOCOL_ERROR', '中央号池返回了无效的配对结果。', {
        statusCode: 502,
      })
    }

    return this.activate({
      centralOrigin,
      deviceId: paired.data.deviceId,
      deviceName: paired.data.name,
      deviceToken: paired.data.deviceToken,
    })
  }

  async activate(input: ActivateProvisioningAgentInput): Promise<ProvisioningAgentStatus> {
    this.assertNoPendingTask('连接')
    if (this.#configuration) {
      throw new AppError('AGENT_ALREADY_PAIRED', '本地执行助手已经连接。', { statusCode: 409 })
    }
    const centralOrigin = normalizeOrigin(input.centralOrigin)
    const deviceId = z.string().uuid().parse(input.deviceId)
    const deviceName = z.string().trim().min(1).max(80).parse(input.deviceName)
    const deviceToken = z.string().min(32).max(512).parse(input.deviceToken)

    await this.stopLoops()
    try {
      await this.dependencies.credentials.set(DEVICE_TOKEN_ACCOUNT, deviceToken)
      this.dependencies.settings.setSetting(SETTING_ORIGIN, centralOrigin)
      this.dependencies.settings.setSetting(SETTING_DEVICE_ID, deviceId)
      this.dependencies.settings.setSetting(SETTING_DEVICE_NAME, deviceName)
      this.#configuration = { centralOrigin, deviceId, deviceName, deviceToken }
      this.#lastError = null
      this.startLoops()
      return this.status()
    } catch (error) {
      await this.clearConfiguration()
      throw error
    }
  }

  async changeOrigin(input: { centralOrigin: string }): Promise<ProvisioningAgentStatus> {
    this.assertNoPendingTask('更换地址')
    const current = this.configuration()
    const centralOrigin = normalizeOrigin(input.centralOrigin)
    const response = await this.request<{ deviceId: string; name: string }>(
      centralOrigin,
      '/api/provisioning/agent/self',
      { method: 'GET' },
      current.deviceToken,
      15_000,
    )
    const verified = selfResponseSchema.safeParse(response.data)
    if (response.status !== 200 || !verified.success || verified.data.deviceId !== current.deviceId) {
      throw new AppError('AGENT_ORIGIN_DEVICE_MISMATCH', '新地址对应的执行设备不是当前已配对设备。', {
        statusCode: 409,
      })
    }
    if (centralOrigin === current.centralOrigin) return this.status()

    await this.stopLoops()
    this.dependencies.settings.setSetting(SETTING_ORIGIN, centralOrigin)
    this.#configuration = { ...current, centralOrigin }
    this.#lastError = null
    this.startLoops()
    this.markContact()
    return this.status()
  }

  async syncHeartbeat(signal?: AbortSignal): Promise<void> {
    await this.dependencies.session.ready()
    const session = this.dependencies.session.publicSession()
    await this.centralRequest(
      '/api/provisioning/agent/heartbeat',
      {
        method: 'POST',
        body: JSON.stringify({
          backendAuthenticated: session.authenticated,
          backendIdentity: session.email ?? '',
        }),
      },
      10_000,
      signal,
    )
  }

  async disconnect(): Promise<void> {
    this.assertNoPendingTask('断开')
    if (this.#configuration) {
      await this.centralRequest(
        '/api/provisioning/agent/disconnect',
        { method: 'POST', body: '{}' },
        15_000,
      )
    }
    await this.stopLoops()
    await this.clearConfiguration()
  }

  async shutdown(): Promise<void> {
    await this.stopLoops()
  }

  async suspend(): Promise<void> {
    this.#suspendRequested = true
    try {
      if (this.#runningTask) {
        await new Promise<void>((resolve) => this.#suspendWaiters.add(resolve))
      }
      await this.stopLoops()
    } finally {
      this.#suspendRequested = false
      for (const resolve of this.#suspendWaiters) resolve()
      this.#suspendWaiters.clear()
    }
  }

  private startLoops(): void {
    if (!this.#configuration || this.#controller) return
    this.#controller = new AbortController()
    this.#loops = [this.jobLoop(this.#controller.signal), this.heartbeatLoop(this.#controller.signal)]
    for (const loop of this.#loops) void loop.catch(() => undefined)
  }

  private async stopLoops(): Promise<void> {
    const controller = this.#controller
    if (!controller) return
    this.#controller = null
    controller.abort()
    await Promise.allSettled(this.#loops)
    this.#loops = []
    this.#connected = false
  }

  private async clearConfiguration(): Promise<void> {
    await this.dependencies.credentials.delete(DEVICE_TOKEN_ACCOUNT)
    for (const key of [SETTING_ORIGIN, SETTING_DEVICE_ID, SETTING_DEVICE_NAME]) {
      this.dependencies.settings.deleteSetting(key)
    }
    this.#configuration = null
    this.#connected = false
  }

  private configuration(): AgentConfiguration {
    if (!this.#configuration) {
      throw new AppError('AGENT_NOT_PAIRED', '本地执行助手尚未与中央号池配对。', { statusCode: 409 })
    }
    return this.#configuration
  }

  private assertNoPendingTask(action: string): void {
    if (this.#runningTask || this.dependencies.settings.getSetting(SETTING_ACTIVE_CENTRAL_TASK)) {
      throw new AppError('AGENT_TASK_ACTIVE', `本地执行助手仍有中央任务待处理，暂时不能${action}。`, {
        statusCode: 409,
      })
    }
  }

  private async request<T>(
    origin: string,
    path: string,
    init: RequestInit,
    token: string | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonResponse<T>> {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    timer.unref?.()
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    try {
      const response = await this.#fetch(new URL(path, origin), {
        ...init,
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal,
      })
      const data = response.status === 204 ? null : await responseJson(response)
      if (!response.ok) {
        const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
        throw centralHttpError(payload, response.status)
      }
      this.markContact()
      return { status: response.status, data: data as T | null }
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof AppError && !timeout.signal.aborted) throw error
      throw new AppError(
        timeout.signal.aborted ? 'AGENT_CENTRAL_TIMEOUT' : 'AGENT_CENTRAL_UNAVAILABLE',
        timeout.signal.aborted ? '中央号池请求超时。' : '无法连接中央号池。',
        { statusCode: 502, retryable: true, cause: error },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private centralRequest<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<JsonResponse<T>> {
    const configuration = this.configuration()
    return this.request<T>(
      configuration.centralOrigin,
      path,
      init,
      configuration.deviceToken,
      timeoutMs,
      signal,
    )
  }

  private markContact(): void {
    this.#connected = true
    this.#lastContactAt = new Date().toISOString()
    this.#lastError = null
  }

  private markFailure(error: unknown): void {
    this.#connected = false
    const safe = safeAgentError(error)
    this.#lastError = { code: safe.code, message: safe.message }
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    await this.dependencies.session.ready()
    while (!signal.aborted) {
      try {
        await this.syncHeartbeat(signal)
      } catch (error) {
        if (signal.aborted) return
        this.markFailure(error)
      }
      try {
        await delay(10_000, signal)
      } catch {
        return
      }
    }
  }

  private async jobLoop(signal: AbortSignal): Promise<void> {
    await this.dependencies.session.ready()
    let retryDelay = 1_000
    while (!signal.aborted) {
      if (this.#suspendRequested) return
      try {
        if (await this.recoverPendingResult(signal)) {
          retryDelay = 1_000
          continue
        }
        if (!this.dependencies.session.publicSession().authenticated) {
          await delay(1_000, signal)
          retryDelay = 1_000
          continue
        }
        const response = await this.centralRequest<{ job: unknown }>(
          '/api/provisioning/agent/jobs/next?timeout=25',
          { method: 'GET' },
          32_000,
          signal,
        )
        if (response.status === 204 || !response.data) continue
        const parsed = jobSchema.safeParse(response.data.job)
        if (!parsed.success) {
          throw new AppError('AGENT_PROTOCOL_ERROR', '中央号池下发了无效任务。', { statusCode: 502 })
        }
        await this.handleJob(parsed.data, signal)
        retryDelay = 1_000
      } catch (error) {
        if (signal.aborted) return
        this.markFailure(error)
        try {
          await delay(retryDelay, signal)
        } catch {
          return
        }
        retryDelay = Math.min(retryDelay * 2, 15_000)
      }
    }
  }

  private async handleJob(job: z.infer<typeof jobSchema>, signal: AbortSignal): Promise<void> {
    if (job.kind === 'query_options') {
      await this.handleQuery(job.id, async () => this.dependencies.options.loadSnapshot(), signal)
      return
    }
    if (job.kind === 'query_reauthorization_accounts') {
      await this.handleQuery(
        job.id,
        async () => this.dependencies.reauthorization.listAccounts(job.payload),
        signal,
      )
      return
    }
    await this.runTask(job, signal)
  }

  private async handleQuery(id: string, query: () => Promise<unknown>, signal: AbortSignal): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = { ok: true, data: await query() }
    } catch (error) {
      body = { ok: false, error: safeAgentError(error, 'AGENT_QUERY_FAILED') }
    }
    await this.centralRequest(
      `/api/provisioning/agent/queries/${encodeURIComponent(id)}/result`,
      { method: 'POST', body: JSON.stringify(body) },
      15_000,
      signal,
    )
  }

  private async runTask(
    job: Extract<z.infer<typeof jobSchema>, { kind: 'task' }>,
    signal: AbortSignal,
  ): Promise<void> {
    this.#runningTask = true
    this.dependencies.settings.setSetting(SETTING_ACTIVE_CENTRAL_TASK, job.id)
    this.dependencies.settings.deleteSetting(SETTING_ACTIVE_LOCAL_TASK)
    let reservation: ExternalExecutionReservation | undefined
    let localTaskId = ''
    let eventChain = Promise.resolve()
    const unsubscribe = this.dependencies.orchestrator.subscribe((task) => {
      if (!localTaskId || task.id !== localTaskId) return
      eventChain = eventChain
        .then(() =>
          this.centralRequest(
            `/api/provisioning/agent/tasks/${job.id}/events`,
            { method: 'POST', body: JSON.stringify({ stage: task.stage, message: task.message }) },
            10_000,
            signal,
          ).then(() => undefined),
        )
        .catch((error) => this.markFailure(error))
    })
    try {
      reservation = this.dependencies.orchestrator.reserveExternalExecution()
      if (!this.dependencies.session.publicSession().authenticated) {
        throw new AppError('AGENT_BACKEND_SESSION_REQUIRED', '后台会话已失效，中央任务未启动。', {
          statusCode: 409,
        })
      }
      const materialResponse = await this.centralRequest<unknown>(
        `/api/provisioning/agent/tasks/${job.id}/materials`,
        { method: 'POST', body: '{}' },
        15_000,
        signal,
      )
      const materials = materialsSchema.safeParse(materialResponse.data)
      if (
        !materials.success ||
        (materials.data.email && materials.data.email.trim().toLowerCase() !== job.accountEmail.trim().toLowerCase())
      ) {
        throw new AppError('AGENT_MATERIALS_INVALID', '中央号池返回的任务材料无效。', {
          statusCode: 502,
        })
      }
      this.dependencies.materials.activate(job.id, job.accountEmail, {
        ...materials.data,
        email: job.accountEmail.trim().toLowerCase(),
      })
      const executionOptions = {
        materialScope: job.id,
        beforeBackendWrite: (stage: BackendWriteStage) =>
          this.centralRequest(
            `/api/provisioning/agent/tasks/${job.id}/begin-write`,
            { method: 'POST', body: JSON.stringify({ stage }) },
            15_000,
            signal,
          ).then(() => undefined),
      }
      let localTask: PublicTask
      try {
        localTask =
          job.operation === 'create'
            ? this.dependencies.orchestrator.startReserved(
                reservation,
                CreateTaskInputSchema.parse({
                  ...job.input,
                  accountEmail: job.accountEmail,
                  loginMaterialSource: 'account_pool',
                }),
                executionOptions,
              )
            : this.dependencies.orchestrator.startReservedReauthorization(
                reservation,
                ReauthorizeTaskInputSchema.parse({
                  ...job.input,
                  accountEmail: job.accountEmail,
                  loginMaterialSource: 'account_pool',
                }),
                executionOptions,
              )
        reservation = undefined
      } catch (error) {
        this.dependencies.materials.clear(job.id)
        throw error
      }
      localTaskId = localTask.id
      this.dependencies.settings.setSetting(SETTING_ACTIVE_LOCAL_TASK, localTaskId)
      eventChain = eventChain.then(() =>
        this.centralRequest(
          `/api/provisioning/agent/tasks/${job.id}/events`,
          { method: 'POST', body: JSON.stringify({ stage: localTask.stage, message: localTask.message }) },
          10_000,
          signal,
        ).then(() => undefined),
      )
      const control = new AbortController()
      const controlSignal = AbortSignal.any([signal, control.signal])
      const controlLoop = this.pollControl(job.id, localTaskId, controlSignal)
      const terminal = await this.dependencies.orchestrator.waitForCompletion(localTaskId)
      control.abort()
      await controlLoop.catch(() => undefined)
      await eventChain
      await this.postTaskResult(job.id, terminal, signal)
      this.clearActiveTaskSettings()
    } catch (error) {
      if (signal.aborted) throw error
      const localTask = localTaskId ? this.dependencies.settings.getTask(localTaskId) : null
      if (localTask && localTask.status !== 'active') {
        await this.postTaskResult(job.id, localTask, signal)
        this.clearActiveTaskSettings()
      } else if (!localTaskId) {
        await this.centralRequest(
          `/api/provisioning/agent/tasks/${job.id}/result`,
          {
            method: 'POST',
            body: JSON.stringify({
              status: 'error',
              stage: 'failed',
              message: safeAgentError(error).message,
              result: { error: safeAgentError(error) },
            }),
          },
          15_000,
          signal,
        )
        this.clearActiveTaskSettings()
      } else {
        throw error
      }
    } finally {
      unsubscribe()
      this.dependencies.materials.clear(job.id)
      if (reservation) this.dependencies.orchestrator.releaseExternalExecution(reservation)
      this.#runningTask = false
      for (const resolve of this.#suspendWaiters) resolve()
      this.#suspendWaiters.clear()
    }
  }

  private async pollControl(centralTaskId: string, localTaskId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await delay(2_000, signal)
        const response = await this.centralRequest<unknown>(
          `/api/provisioning/agent/tasks/${centralTaskId}/control`,
          { method: 'GET' },
          8_000,
          signal,
        )
        const control = controlSchema.safeParse(response.data)
        if (!control.success) throw new AppError('AGENT_PROTOCOL_ERROR', '中央任务控制响应无效。')
        if (control.data.cancelRequested) {
          try {
            this.dependencies.orchestrator.cancel(localTaskId)
          } catch {
            // The local state machine is authoritative once backend writes begin.
          }
          return
        }
      } catch (error) {
        if (signal.aborted) return
        this.markFailure(error)
      }
    }
  }

  private postTaskResult(centralTaskId: string, task: PublicTask, signal: AbortSignal): Promise<JsonResponse<unknown>> {
    return this.centralRequest(
      `/api/provisioning/agent/tasks/${centralTaskId}/result`,
      { method: 'POST', body: JSON.stringify(terminalPayload(task)) },
      15_000,
      signal,
    )
  }

  private async recoverPendingResult(signal: AbortSignal): Promise<boolean> {
    const centralTaskId = this.dependencies.settings.getSetting(SETTING_ACTIVE_CENTRAL_TASK)
    if (!centralTaskId) return false
    const localTaskId = this.dependencies.settings.getSetting(SETTING_ACTIVE_LOCAL_TASK)
    const localTask = localTaskId ? this.dependencies.settings.getTask(localTaskId) : null
    const interrupted =
      !localTask || localTask.stage === 'interrupted' || localTask.error?.code === 'TASK_INTERRUPTED'
    if (localTask && localTask.status !== 'active' && !interrupted) {
      await this.postTaskResult(centralTaskId, localTask, signal)
    } else {
      const terminalFromStage = localTask?.terminalFromStage ?? localTask?.stage ?? 'interrupted'
      const status = BACKEND_WRITE_STAGES.has(terminalFromStage) ? 'uncertain' : 'interrupted'
      await this.centralRequest(
        `/api/provisioning/agent/tasks/${centralTaskId}/result`,
        {
          method: 'POST',
          body: JSON.stringify({
            status,
            stage: 'interrupted',
            message: '本地执行服务曾中断，任务不会自动重试。',
            result: {
              error: {
                code: 'AGENT_INTERRUPTED',
                message: '本地执行服务曾中断，任务不会自动重试。',
                retryable: false,
              },
              terminalFromStage,
            },
          }),
        },
        15_000,
        signal,
      )
    }
    this.clearActiveTaskSettings()
    return true
  }

  private clearActiveTaskSettings(): void {
    this.dependencies.settings.deleteSetting(SETTING_ACTIVE_CENTRAL_TASK)
    this.dependencies.settings.deleteSetting(SETTING_ACTIVE_LOCAL_TASK)
  }
}
