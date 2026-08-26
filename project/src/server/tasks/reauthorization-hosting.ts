import type {
  PublicTask,
  ReauthorizationAccountPage,
  ReauthorizationAccountSummary,
  ReauthorizationHostingState,
  ReauthorizationHostingResult,
  ReauthorizationProxyMode,
} from '../../shared/contracts'
import { AppError } from '../../shared/errors'

const SETTING_KEY = 'reauthorization.hosting.v1'
const EXCLUDED_ACCOUNT_IDS_SETTING_KEY = 'reauthorization.hosting.excluded-account-ids.v1'
const ACCOUNT_NOTES_SETTING_KEY = 'reauthorization.hosting.account-notes.v1'
const OTP_ROUNDS_EXHAUSTED_MESSAGE = '三轮等待结束，仍未取得可安全使用的最新验证码'

export interface ReauthorizationHostingStartInput {
  search: string
  maxUsage7dPercent: number
  importedWithinDays?: number
  proxyMode: ReauthorizationProxyMode
  accountIds?: number[]
}

interface PersistedState extends ReauthorizationHostingState {
  pendingAccountIds: number[]
  skipCurrentRequested: boolean
}

interface Dependencies {
  settings: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string): void
  }
  listAccounts(input: {
    search: string
    page: number
    pageSize: number
    maxUsage7dPercent: number
    importedWithinDays?: number
  }): Promise<ReauthorizationAccountPage>
  getAccount(accountId: number, maxUsage7dPercent: number): Promise<ReauthorizationAccountSummary>
  startTask(input: unknown): PublicTask
  getActiveTask(): PublicTask | null
  getTask(id: string): PublicTask | null
  subscribe(listener: (task: PublicTask) => void): () => void
  cancelTask(taskId: string): PublicTask
}

function idleState(): PersistedState {
  return {
    status: 'idle', search: '', maxUsage7dPercent: 90, importedWithinDays: null,
    proxyMode: 'existing', pendingAccountIds: [], skipCurrentRequested: false, currentAccountId: null, currentTaskId: null,
    total: 0, completed: 0, failed: 0, skipped: 0, lastMessage: '', createdAt: null,
    banned: 0, lastAccountId: null, lastResult: null,
    updatedAt: new Date().toISOString(),
  }
}

export class ReauthorizationHostingService {
  #state: PersistedState = idleState()
  #loopRunning = false
  #loopPromise: Promise<void> | null = null
  #unsubscribe: (() => void) | null = null
  #resolveTerminalWait: (() => void) | null = null
  #shuttingDown = false
  #excludedAccountIdsCache: Set<number> | null = null
  #accountNotesCache: Record<string, string> | null = null

  constructor(private readonly dependencies: Dependencies) {}

  excludedAccountIds(): number[] {
    return [...this.#loadExcludedAccountIds()].sort((a, b) => a - b)
  }

  setAccountExcluded(accountId: number, excluded: boolean): boolean {
    const ids = this.#loadExcludedAccountIds()
    if (excluded) ids.add(accountId)
    else ids.delete(accountId)
    this.dependencies.settings.setSetting(EXCLUDED_ACCOUNT_IDS_SETTING_KEY, JSON.stringify([...ids].sort((a, b) => a - b)))
    return excluded
  }

  accountNotes(): Record<string, string> {
    return { ...this.#loadAccountNotes() }
  }

  accountNote(accountId: number): string {
    return this.#loadAccountNotes()[String(accountId)] ?? ''
  }

  notedAccountIds(): number[] {
    return Object.entries(this.#loadAccountNotes())
      .filter(([, note]) => Boolean(note?.trim()))
      .map(([id]) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  }

  setAccountNote(accountId: number, note: string): string {
    const notes = this.#loadAccountNotes()
    const normalized = note.trim()
    if (normalized) notes[String(accountId)] = normalized
    else delete notes[String(accountId)]
    this.dependencies.settings.setSetting(ACCOUNT_NOTES_SETTING_KEY, JSON.stringify(notes))
    return normalized
  }

  decorateAccount(account: ReauthorizationAccountSummary): ReauthorizationAccountSummary {
    const notes = this.#loadAccountNotes()
    return {
      ...account,
      excludedFromHosting: this.#loadExcludedAccountIds().has(account.id),
      hostingNote: notes[String(account.id)] ?? '',
    }
  }

  decoratePage(page: ReauthorizationAccountPage): ReauthorizationAccountPage {
    const excluded = this.#loadExcludedAccountIds()
    const notes = this.#loadAccountNotes()
    return {
      ...page,
      items: page.items.map((account) => ({
        ...account,
        excludedFromHosting: excluded.has(account.id),
        hostingNote: notes[String(account.id)] ?? '',
      })),
    }
  }

  async restore(): Promise<void> {
    const raw = this.dependencies.settings.getSetting(SETTING_KEY)
    if (!raw) return
    try {
      this.#state = JSON.parse(raw) as PersistedState
      this.#state.skipCurrentRequested ??= false
      this.#state.banned ??= 0
      this.#state.lastAccountId ??= null
      this.#state.lastResult ??= null
    } catch {
      this.#state = idleState()
      this.#persist()
      return
    }
    if (!['running', 'paused', 'stopping'].includes(this.#state.status)) return
    if (this.#state.status === 'stopping') {
      this.#finishStop()
      return
    }
    if (this.#state.currentTaskId) {
      const previous = this.dependencies.getTask(this.#state.currentTaskId)
      if (!previous || previous.status !== 'active') {
        this.#state.failed += 1
        this.#state.lastAccountId = this.#state.currentAccountId
        this.#state.lastResult = 'failed'
        this.#state.currentAccountId = null
        this.#state.currentTaskId = null
        this.#state.lastMessage = '服务重启时当前账号任务已中断，已继续处理下一个账号。'
      }
    }
    this.#state.status = 'running'
    this.#persist()
    this.#startLoop()
  }

  getState(): ReauthorizationHostingState {
    return {
      status: this.#state.status,
      search: this.#state.search,
      maxUsage7dPercent: this.#state.maxUsage7dPercent,
      importedWithinDays: this.#state.importedWithinDays,
      proxyMode: this.#state.proxyMode,
      currentAccountId: this.#state.currentAccountId,
      currentTaskId: this.#state.currentTaskId,
      total: this.#state.total,
      completed: this.#state.completed,
      failed: this.#state.failed,
      banned: this.#state.banned,
      skipped: this.#state.skipped,
      lastAccountId: this.#state.lastAccountId,
      lastResult: this.#state.lastResult,
      lastMessage: this.#state.lastMessage,
      createdAt: this.#state.createdAt,
      updatedAt: this.#state.updatedAt,
    }
  }

  async start(input: ReauthorizationHostingStartInput): Promise<ReauthorizationHostingState> {
    if (['running', 'paused', 'stopping'].includes(this.#state.status)) {
      throw new AppError('REAUTHORIZATION_HOSTING_ACTIVE', '重新授权托管已经在运行。', { statusCode: 409 })
    }
    if (this.dependencies.getActiveTask()) {
      throw new AppError('TASK_ALREADY_ACTIVE', '已有任务正在运行，请等待当前任务结束后再开始托管。', { statusCode: 409 })
    }
    const ids: number[] = input.accountIds ? [...new Set(input.accountIds)] : []
    let page = 1
    let hasMore = input.accountIds === undefined
    while (hasMore) {
      const result = await this.dependencies.listAccounts({
        search: input.search,
        page,
        pageSize: 100,
        maxUsage7dPercent: input.maxUsage7dPercent,
        ...(input.importedWithinDays === undefined ? {} : { importedWithinDays: input.importedWithinDays }),
      })
      ids.push(...result.items.map((account) => account.id))
      hasMore = page < result.pages
      page += 1
    }
    const excluded = this.#loadExcludedAccountIds()
    const notes = this.#loadAccountNotes()
    const eligibleIds = ids.filter((id) => !excluded.has(id) && !notes[String(id)]?.trim())
    if (eligibleIds.length === 0) {
      throw new AppError('REAUTHORIZATION_HOSTING_EMPTY', '当前筛选条件下没有可托管的账号。', { statusCode: 409 })
    }
    const now = new Date().toISOString()
    this.#state = {
      status: 'running', search: input.search, maxUsage7dPercent: input.maxUsage7dPercent,
      importedWithinDays: input.importedWithinDays ?? null, proxyMode: input.proxyMode,
      pendingAccountIds: eligibleIds, currentAccountId: null, currentTaskId: null, total: eligibleIds.length,
      skipCurrentRequested: false,
      completed: 0, failed: 0, skipped: 0, lastMessage: `已锁定 ${eligibleIds.length} 个账号，准备开始。`,
      banned: 0, lastAccountId: null, lastResult: null,
      createdAt: now, updatedAt: now,
    }
    this.#persist()
    this.#startLoop()
    return this.getState()
  }

  stop(): ReauthorizationHostingState {
    if (!['running', 'paused', 'stopping'].includes(this.#state.status)) return this.getState()
    if (this.#state.currentTaskId) {
      this.#state.status = 'stopping'
      this.#state.lastMessage = '正在取消当前账号并停止托管。'
      this.#persist()
      try {
        this.dependencies.cancelTask(this.#state.currentTaskId)
      } catch {
        this.#state.lastMessage = '当前账号处于不可取消阶段，将在该阶段结束后停止。'
        this.#persist()
      }
    } else {
      this.#finishStop()
    }
    return this.getState()
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      await this.#loopPromise
      return
    }
    this.#shuttingDown = true
    const currentTaskId = this.#state.currentTaskId
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#state.status = 'stopped'
    this.#state.pendingAccountIds = []
    this.#state.currentAccountId = null
    this.#state.currentTaskId = null
    this.#state.skipCurrentRequested = false
    this.#state.lastMessage = '服务关闭，托管已停止。'
    this.#persist()
    this.#resolveTerminalWait?.()
    this.#resolveTerminalWait = null
    if (currentTaskId && this.dependencies.getTask(currentTaskId)?.status === 'active') {
      try {
        this.dependencies.cancelTask(currentTaskId)
      } catch {
        // The orchestrator shutdown waits for any non-cancellable write stage.
      }
    }
    await this.#loopPromise
  }

  skipCurrent(): ReauthorizationHostingState {
    if (!['running', 'paused'].includes(this.#state.status) || !this.#state.currentTaskId) {
      throw new AppError('REAUTHORIZATION_HOSTING_NO_CURRENT', '当前没有可以跳过的托管账号。', { statusCode: 409 })
    }
    this.#state.skipCurrentRequested = true
    this.#state.lastMessage = '正在跳过当前账号。'
    this.#persist()
    try {
      this.dependencies.cancelTask(this.#state.currentTaskId)
    } catch (error) {
      this.#state.skipCurrentRequested = false
      this.#state.lastMessage = '当前任务所处阶段不能跳过。'
      this.#persist()
      throw error
    }
    return this.getState()
  }

  #startLoop(): void {
    if (this.#loopRunning) return
    this.#loopRunning = true
    this.#loopPromise = this.#run().finally(() => {
      this.#loopRunning = false
      this.#loopPromise = null
    })
  }

  async #run(): Promise<void> {
    while (this.#state.status === 'running' || this.#state.status === 'paused') {
      if (this.#state.currentTaskId) {
        const current = this.dependencies.getTask(this.#state.currentTaskId)
        if (current?.status === 'active') await this.#waitForTerminal(current.id)
        else this.#completeCurrent(current)
        continue
      }
      const accountId = this.#state.pendingAccountIds.shift()
      if (accountId === undefined) {
        this.#state.status = 'completed'
        this.#state.lastMessage = '全部托管账号已处理完成。'
        this.#persist()
        return
      }
      const accountNote = this.accountNote(accountId).trim()
      if (this.#loadExcludedAccountIds().has(accountId) || accountNote) {
        this.#state.skipped += 1
        this.#state.lastAccountId = accountId
        this.#state.lastResult = 'skipped'
        this.#state.lastMessage = accountNote ? '已跳过已有备注的账号。' : '已跳过手动标记为不托管的账号。'
        this.#persist()
        continue
      }
      try {
        const account = await this.dependencies.getAccount(accountId, this.#state.maxUsage7dPercent)
        if (this.#state.status !== 'running' && this.#state.status !== 'paused') return
        const task = this.dependencies.startTask({
          accountId: account.id,
          accountEmail: account.email,
          maxUsage7dPercent: this.#state.maxUsage7dPercent,
          proxyMode: this.#state.proxyMode,
          loginMaterialSource: 'account_pool',
        })
        this.#state.currentAccountId = accountId
        this.#state.currentTaskId = task.id
        this.#state.lastMessage = `正在处理第 ${this.#processedCount() + 1} / ${this.#state.total} 个账号。`
        this.#persist()
        await this.#waitForTerminal(task.id)
      } catch (error) {
        if (this.#shuttingDown || !['running', 'paused'].includes(this.#state.status)) return
        this.#state.skipped += 1
        this.#state.lastAccountId = accountId
        this.#state.lastResult = 'skipped'
        this.#state.lastMessage = error instanceof Error ? `已跳过一个账号：${error.message}` : '已跳过一个无法启动的账号。'
        this.#persist()
      }
    }
    if (this.#state.status === 'stopping' && !this.#state.currentTaskId) this.#finishStop()
  }

  #waitForTerminal(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      const resolveWait = () => {
        if (this.#resolveTerminalWait === resolveWait) this.#resolveTerminalWait = null
        resolve()
      }
      this.#resolveTerminalWait = resolveWait
      const finish = (task: PublicTask) => {
        if (this.#shuttingDown) return
        if (task.id !== taskId) return
        if (task.status === 'active') {
          if (
            task.stage === 'manual_intervention' &&
            task.message.includes(OTP_ROUNDS_EXHAUSTED_MESSAGE) &&
            !this.#state.skipCurrentRequested
          ) {
            this.#state.skipCurrentRequested = true
            this.#state.lastMessage = '三轮验证码等待结束，正在自动跳过当前账号。'
            this.#persist()
            this.dependencies.cancelTask(task.id)
            return
          }
          const next = task.stage === 'manual_intervention' || task.manualTakeover ? 'paused' : 'running'
          if (this.#state.status !== 'stopping' && this.#state.status !== next) {
            this.#state.status = next
            this.#state.lastMessage = next === 'paused' ? '当前账号等待人工处理，完成后将自动继续。' : '人工处理已结束，正在继续当前账号。'
            this.#persist()
          }
          return
        }
        this.#unsubscribe?.()
        this.#unsubscribe = null
        this.#completeCurrent(task)
        resolveWait()
      }
      this.#unsubscribe = this.dependencies.subscribe(finish)
      const current = this.dependencies.getTask(taskId)
      if (current) finish(current)
    })
  }

  #loadExcludedAccountIds(): Set<number> {
    if (this.#excludedAccountIdsCache) return this.#excludedAccountIdsCache
    const raw = this.dependencies.settings.getSetting(EXCLUDED_ACCOUNT_IDS_SETTING_KEY)
    if (!raw) return (this.#excludedAccountIdsCache = new Set())
    try {
      const value = JSON.parse(raw)
      this.#excludedAccountIdsCache = new Set(
        Array.isArray(value)
          ? value.filter((id): id is number => Number.isInteger(id) && id > 0)
          : [],
      )
    } catch {
      this.#excludedAccountIdsCache = new Set()
    }
    return this.#excludedAccountIdsCache
  }

  #loadAccountNotes(): Record<string, string> {
    if (this.#accountNotesCache) return this.#accountNotesCache
    const raw = this.dependencies.settings.getSetting(ACCOUNT_NOTES_SETTING_KEY)
    if (!raw) return (this.#accountNotesCache = {})
    try {
      const value = JSON.parse(raw)
      this.#accountNotesCache = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              (entry): entry is [string, string] => /^\d+$/.test(entry[0]) && typeof entry[1] === 'string',
            ),
          )
        : {}
    } catch {
      this.#accountNotesCache = {}
    }
    return this.#accountNotesCache
  }

  #completeCurrent(task: PublicTask | null): void {
    if (this.#shuttingDown) return
    const accountId = this.#state.currentAccountId
    const wasSkipped = this.#state.skipCurrentRequested
    let result: ReauthorizationHostingResult
    if (wasSkipped) {
      this.#state.skipped += 1
      result = 'skipped'
    } else if (task?.status === 'success') {
      this.#state.completed += 1
      result = 'success'
    } else if (task?.error?.code === 'OPENAI_ACCOUNT_DEACTIVATED_BANNED') {
      this.#state.banned += 1
      result = 'banned'
    } else {
      this.#state.failed += 1
      result = 'failed'
    }
    const errorCode = task?.error?.code
    const automaticSkipNotes: Record<string, string> = {
      MAILBOX_ACCOUNT_EXPIRED: '邮箱接码过期',
      MAIL_ACCESS_URL_EXPIRED: '邮箱接码失效',
      MAIL_HTTP_ERROR: '邮箱接码失效',
      ACCOUNT_POOL_EMAIL_NOT_FOUND: '号池没有',
      ACCOUNT_POOL_MATERIALS_MISSING: '号池没有',
      MAIL_ACCESS_URL_EMAIL_MISMATCH: '邮箱接码失效',
      OPENAI_EMAIL_VERIFICATION_REQUIRED: '没有接码邮箱链接',
    }
    const automaticSkipNote = errorCode ? automaticSkipNotes[errorCode] : undefined
    if (accountId && automaticSkipNote) {
      this.setAccountExcluded(accountId, true)
      this.setAccountNote(accountId, automaticSkipNote)
    }
    this.#state.lastAccountId = accountId
    this.#state.lastResult = result
    this.#state.skipCurrentRequested = false
    this.#state.currentAccountId = null
    this.#state.currentTaskId = null
    if (this.#state.status === 'stopping') this.#finishStop()
    else {
      this.#state.status = 'running'
      this.#state.lastMessage = wasSkipped
        ? '当前账号已跳过，正在处理下一个。'
        : result === 'success'
          ? '当前账号已成功，正在处理下一个。'
          : result === 'banned'
            ? '当前账号已确认封号，正在处理下一个。'
            : '当前账号处理失败，正在处理下一个。'
      this.#persist()
    }
  }

  #processedCount(): number {
    return this.#state.completed + this.#state.failed + this.#state.banned + this.#state.skipped
  }

  #finishStop(): void {
    this.#state.status = 'stopped'
    this.#state.pendingAccountIds = []
    this.#state.currentAccountId = null
    this.#state.currentTaskId = null
    this.#state.skipCurrentRequested = false
    this.#state.lastMessage = '托管已停止。'
    this.#persist()
  }

  #persist(): void {
    this.#state.updatedAt = new Date().toISOString()
    this.dependencies.settings.setSetting(SETTING_KEY, JSON.stringify(this.#state))
  }
}
