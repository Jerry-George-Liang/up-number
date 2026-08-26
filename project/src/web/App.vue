<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ClipboardList, RefreshCw, RotateCw, Settings, UserPlus } from '@lucide/vue'
import type {
  CreateTaskInput,
  DeactivationSettings,
  MailboxTrustSettings,
  OptionsSnapshot,
  PublicTask,
  ReauthorizationAccountPage,
  ReauthorizationAccountSummary,
  ReauthorizationHostingState,
  ReauthorizationProxyMode,
  ReauthorizeTaskInput,
} from '../shared/contracts'
import {
  isLocalSessionRequired,
  localApi,
  type AccountPoolPortalConnectInput,
  type AccountPoolPortalStatus,
  type PendingTotpLogin,
  type PoolConnectionMode,
  type ProvisioningAgentStatus,
  type PublicBackendSession,
} from './api'
import {
  createTaskCredentialMemory,
  createTaskFormState,
  createLatestRequestGuard,
  createReauthorizationCredentialMemory,
  createReauthorizationFormState,
  rememberTaskCredential,
  rememberReauthorizationCredential,
  selectReauthorizationAccount,
  switchTaskCredentialEmail,
} from './state'
import HistoryView from './views/HistoryView.vue'
import ReauthorizationView from './views/ReauthorizationView.vue'
import SettingsView from './views/SettingsView.vue'
import TaskView from './views/TaskView.vue'

type ViewName = 'task' | 'reauthorization' | 'history' | 'settings'

const view = ref<ViewName>('task')
const navOpen = ref(false)
const loading = ref(true)
const actionBusy = ref(false)
const currentViewRefreshing = ref(false)
const errorMessage = ref('')
const session = ref<PublicBackendSession>({ authenticated: false, email: null, user: null })
const pendingTotp = ref<PendingTotpLogin | null>(null)
const options = ref<OptionsSnapshot | null>(null)
const mailboxTrustSettings = ref<MailboxTrustSettings | null>(null)
const deactivationSettings = ref<DeactivationSettings | null>(null)
const provisioningAgent = ref<ProvisioningAgentStatus | null>(null)
const accountPoolPortal = ref<AccountPoolPortalStatus | null>(null)
const poolConnectionMode = ref<PoolConnectionMode | null>(null)
const tasks = ref<PublicTask[]>([])
const activeTask = ref<PublicTask | null>(null)
const reauthorizationAccounts = ref<ReauthorizationAccountPage | null>(null)
const reauthorizationSearch = ref('')
const reauthorizationImportedWithinDays = ref<number | null>(null)
const reauthorizationPageSize = ref(20)
const selectedReauthorizationAccounts = ref<ReauthorizationAccountSummary[]>([])
const reauthorizationAccountsLoading = ref(false)
const reauthorizationIncludeExcluded = ref(false)
const reauthorizationHosting = ref<ReauthorizationHostingState | null>(null)
const reauthorizationHostingBusy = ref(false)
const taskForm = reactive(createTaskFormState())
const taskCredentialMemory = createTaskCredentialMemory()
const reauthorizationForm = reactive(createReauthorizationFormState())
const reauthorizationCredentialMemory = createReauthorizationCredentialMemory()
const reauthorizationAccountsRequests = createLatestRequestGuard()
let closeEvents: (() => void) | undefined
let agentStatusTimer: ReturnType<typeof globalThis.setInterval> | undefined
let reauthorizationHostingTimer: ReturnType<typeof globalThis.setInterval> | undefined
const REAUTHORIZATION_CACHE_KEY = 'up-icloud.reauthorization.accounts.v1'

function restoreReauthorizationCache(): boolean {
  try {
    const raw = globalThis.localStorage.getItem(REAUTHORIZATION_CACHE_KEY)
    if (!raw) return false
    const cached = JSON.parse(raw) as { accounts?: ReauthorizationAccountPage; search?: string; importedWithinDays?: number | null; pageSize?: number }
    if (!cached.accounts || !Array.isArray(cached.accounts.items) || cached.accounts.items.length === 0) return false
    reauthorizationAccounts.value = cached.accounts
    reauthorizationSearch.value = cached.search ?? ''
    reauthorizationImportedWithinDays.value = cached.importedWithinDays ?? null
    reauthorizationPageSize.value = cached.pageSize ?? cached.accounts.pageSize ?? 20
    return true
  } catch {
    return false
  }
}

function persistReauthorizationCache(page: ReauthorizationAccountPage): void {
  try {
    globalThis.localStorage.setItem(REAUTHORIZATION_CACHE_KEY, JSON.stringify({
      accounts: page,
      search: reauthorizationSearch.value,
      importedWithinDays: reauthorizationImportedWithinDays.value,
      pageSize: reauthorizationPageSize.value,
    }))
  } catch {
    // Local storage may be unavailable or full; the live request remains authoritative.
  }
}

const connectedLabel = computed(() => session.value.authenticated ? '后台会话：已连接' : '后台会话：未连接')
const reauthorizationHostingActive = computed(() =>
  ['running', 'paused', 'stopping'].includes(reauthorizationHosting.value?.status ?? 'idle'),
)
const workflowBusy = computed(() => Boolean(activeTask.value?.status === 'active') || reauthorizationHostingActive.value || actionBusy.value)
const settingsBusy = computed(() => Boolean(activeTask.value?.status === 'active') || actionBusy.value)

function selectView(next: ViewName) {
  view.value = next
  navOpen.value = false
  if (next === 'reauthorization' && session.value.authenticated && !reauthorizationAccounts.value) {
    const restored = restoreReauthorizationCache()
    void loadReauthorizationAccounts({
      search: restored ? reauthorizationSearch.value : '',
      page: 1,
      importedWithinDays: restored ? reauthorizationImportedWithinDays.value : null,
    })
  }
}

function redirectLocalhostToCanonicalOrigin(): boolean {
  if (globalThis.window.location.hostname !== 'localhost') return false
  const canonical = new globalThis.URL(globalThis.window.location.href)
  canonical.hostname = '127.0.0.1'
  globalThis.window.location.replace(canonical.toString())
  return true
}

function clearLocalSessionState() {
  reauthorizationAccountsRequests.invalidate()
  reauthorizationAccountsLoading.value = false
  session.value = { authenticated: false, email: null, user: null }
  pendingTotp.value = null
  options.value = null
  mailboxTrustSettings.value = null
  provisioningAgent.value = null
  accountPoolPortal.value = null
  poolConnectionMode.value = null
  tasks.value = []
  activeTask.value = null
  reauthorizationAccounts.value = null
  closeEvents?.()
  closeEvents = undefined
  view.value = 'settings'
}

function reportError(error: unknown, fallback: string) {
  if (isLocalSessionRequired(error)) clearLocalSessionState()
  errorMessage.value = error instanceof Error ? error.message : fallback
}

async function loadAuthenticatedData(refresh = false) {
  const [optionData, history, active] = await Promise.all([
    localApi.options(refresh),
    localApi.tasks(50),
    localApi.activeTask(),
  ])
  options.value = optionData
  tasks.value = history
  activeTask.value = active.task
  if (active.task) watchTask(active.task.id)
}

function watchTask(id: string) {
  closeEvents?.()
  closeEvents = localApi.taskEvents(id, (task) => {
    activeTask.value = task
    const index = tasks.value.findIndex((item) => item.id === task.id)
    if (index >= 0) tasks.value[index] = task
    else tasks.value.unshift(task)
    if (task.status !== 'active') {
      closeEvents?.()
      closeEvents = undefined
      if (task.selection.operation === 'reauthorize') {
        void loadReauthorizationAccounts({
          search: reauthorizationSearch.value,
          page: reauthorizationAccounts.value?.page ?? 1,
          importedWithinDays: reauthorizationImportedWithinDays.value,
        })
      }
    }
  })
}

async function initialize() {
  loading.value = true
  errorMessage.value = ''
  try {
    session.value = await localApi.initializeSession()
    const [trustSettings, deactivationConfig, agentStatus, accountPoolStatus, connectionModeStatus] = await Promise.all([
      localApi.mailboxTrustSettings(),
      localApi.deactivationSettings(),
      localApi.provisioningAgent(),
      localApi.accountPoolPortal(),
      localApi.poolConnectionMode(),
    ])
    mailboxTrustSettings.value = trustSettings
    deactivationSettings.value = deactivationConfig
    provisioningAgent.value = agentStatus
    accountPoolPortal.value = accountPoolStatus
    poolConnectionMode.value = connectionModeStatus.mode
    if (session.value.authenticated) await loadAuthenticatedData()
    else view.value = 'settings'
  } catch (error) {
    reportError(error, '无法连接本地服务。')
  } finally {
    loading.value = false
  }
}

async function refreshCurrentView() {
  if (!session.value.authenticated || currentViewRefreshing.value) return
  currentViewRefreshing.value = true
  errorMessage.value = ''
  try {
    if (view.value === 'task') {
      const [optionData, active] = await Promise.all([localApi.options(true), localApi.activeTask()])
      options.value = optionData
      activeTask.value = active.task
      if (active.task) watchTask(active.task.id)
    } else if (view.value === 'reauthorization') {
      const [, hosting, active] = await Promise.all([
        loadReauthorizationAccounts({
          search: reauthorizationSearch.value,
          page: reauthorizationAccounts.value?.page ?? 1,
          importedWithinDays: reauthorizationImportedWithinDays.value,
        }),
        localApi.reauthorizationHosting(),
        localApi.activeTask(),
      ])
      reauthorizationHosting.value = hosting
      activeTask.value = active.task
      if (active.task) watchTask(active.task.id)
    } else if (view.value === 'history') {
      tasks.value = await localApi.tasks(50)
    } else {
      const [trustSettings, deactivationConfig, agentStatus, accountPoolStatus, connectionModeStatus] = await Promise.all([
        localApi.mailboxTrustSettings(),
        localApi.deactivationSettings(),
        localApi.provisioningAgent(),
        localApi.accountPoolPortal(),
        localApi.poolConnectionMode(),
      ])
      mailboxTrustSettings.value = trustSettings
      deactivationSettings.value = deactivationConfig
      provisioningAgent.value = agentStatus
      accountPoolPortal.value = accountPoolStatus
      poolConnectionMode.value = connectionModeStatus.mode
    }
  } catch (error) {
    reportError(error, '当前页面刷新失败。')
  } finally {
    currentViewRefreshing.value = false
  }
}

async function startTask(input: CreateTaskInput) {
  actionBusy.value = true
  errorMessage.value = ''
  try {
    const task = await localApi.startTask(input)
    activeTask.value = task
    tasks.value = [task, ...tasks.value.filter((item) => item.id !== task.id)]
    watchTask(task.id)
  } catch (error) {
    reportError(error, '任务启动失败。')
  } finally {
    actionBusy.value = false
  }
}

async function loadReauthorizationAccounts(input: {
  search: string
  page: number
  pageSize?: number
  maxUsage7dPercent?: number
  importedWithinDays?: number | null
  includeExcluded?: boolean
}): Promise<boolean> {
  if (!session.value.authenticated) return false
  const requestId = reauthorizationAccountsRequests.begin()
  reauthorizationAccountsLoading.value = true
  errorMessage.value = ''
  const search = input.search.trim()
  reauthorizationSearch.value = search
  try {
    const threshold = input.maxUsage7dPercent ?? reauthorizationForm.maxUsage7dPercent
    const importedWithinDays = input.importedWithinDays === undefined
      ? reauthorizationImportedWithinDays.value
      : input.importedWithinDays
    reauthorizationImportedWithinDays.value = importedWithinDays
    const pageSize = input.pageSize ?? reauthorizationPageSize.value
    reauthorizationPageSize.value = pageSize
    if (input.includeExcluded !== undefined) reauthorizationIncludeExcluded.value = input.includeExcluded
    const page = await localApi.reauthorizationAccounts(
      search,
      input.page,
      pageSize,
      threshold,
      importedWithinDays ?? undefined,
      reauthorizationIncludeExcluded.value,
    )
    if (!reauthorizationAccountsRequests.isLatest(requestId)) return false
    reauthorizationAccounts.value = page
    persistReauthorizationCache(page)
    return true
  } catch (error) {
    if (!reauthorizationAccountsRequests.isLatest(requestId)) return false
    reportError(error, '无法读取重新授权账号。')
    return false
  } finally {
    if (reauthorizationAccountsRequests.isLatest(requestId)) {
      reauthorizationAccountsLoading.value = false
    }
  }
}

async function chooseReauthorizationAccount(account: ReauthorizationAccountSummary) {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  if (reauthorizationForm.accountId === account.id) {
    reauthorizationForm.accountId = null
    reauthorizationForm.accountName = ''
    reauthorizationForm.accountStatus = ''
    reauthorizationForm.accountImportedAt = null
    reauthorizationForm.accountEmail = ''
    return
  }
  actionBusy.value = true
  errorMessage.value = ''
  try {
    const current = await localApi.reauthorizationAccount(
      account.id,
      reauthorizationForm.maxUsage7dPercent,
    )
    selectReauthorizationAccount(reauthorizationForm, reauthorizationCredentialMemory, current)
  } catch (error) {
    reportError(error, '无法读取所选账号。')
  } finally {
    actionBusy.value = false
  }
}

async function toggleReauthorizationAccount(account: ReauthorizationAccountSummary) {
  const index = selectedReauthorizationAccounts.value.findIndex((item) => item.id === account.id)
  if (index >= 0) {
    selectedReauthorizationAccounts.value.splice(index, 1)
    if (reauthorizationForm.accountId === account.id) {
      reauthorizationForm.accountId = null
      reauthorizationForm.accountName = ''
      reauthorizationForm.accountStatus = ''
      reauthorizationForm.accountImportedAt = null
      reauthorizationForm.accountEmail = ''
    }
    return
  }
  selectedReauthorizationAccounts.value.push(account)
  if (selectedReauthorizationAccounts.value.length === 1) await chooseReauthorizationAccount(account)
}

async function saveReauthorizationDisposition(input: { account: ReauthorizationAccountSummary; note: string; excluded: boolean }) {
  if (reauthorizationHostingBusy.value) return
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    const result = await localApi.setReauthorizationAccountDisposition(input.account.id, input.note, input.excluded)
    Object.assign(input.account, result)
    const selected = selectedReauthorizationAccounts.value.find((item) => item.id === input.account.id)
    if (selected) Object.assign(selected, result)
  } catch (error) {
    reportError(error, '无法修改账号托管标记。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

async function saveBulkReauthorizationDisposition(input: { note: string; excluded: boolean }) {
  if (reauthorizationHostingBusy.value || selectedReauthorizationAccounts.value.length === 0) return
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    const result = await localApi.setBulkReauthorizationAccountDisposition(
      selectedReauthorizationAccounts.value.map((account) => account.id),
      input.note,
      input.excluded,
    )
    for (const updated of result.updated) {
      const selected = selectedReauthorizationAccounts.value.find((account) => account.id === updated.id)
      if (selected) Object.assign(selected, updated)
      const visible = reauthorizationAccounts.value?.items.find((account) => account.id === updated.id)
      if (visible) Object.assign(visible, updated)
    }
    const failedIds = new Set(result.failed.map((failure) => failure.accountId))
    selectedReauthorizationAccounts.value = selectedReauthorizationAccounts.value.filter((account) => failedIds.has(account.id))
    if (result.failed.length > 0) {
      reportError(new Error(`批量处置完成 ${result.updated.length} 个，失败 ${result.failed.length} 个。`), '批量处置未全部完成。')
    }
  } catch (error) {
    reportError(error, '无法批量处置账号。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

async function startSelectedReauthorization() {
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    reauthorizationHosting.value = await localApi.startReauthorizationHosting({
      search: '',
      maxUsage7dPercent: reauthorizationForm.maxUsage7dPercent,
      proxyMode: reauthorizationForm.proxyMode,
      accountIds: selectedReauthorizationAccounts.value.map((account) => account.id),
    })
    selectedReauthorizationAccounts.value = []
    await refreshReauthorizationHosting()
  } catch (error) {
    reportError(error, '无法开始批量重新授权。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

function commitReauthorizationCredentials() {
  errorMessage.value = ''
  rememberReauthorizationCredential(reauthorizationForm, reauthorizationCredentialMemory)
}

function changeReauthorizationProxyMode(mode: ReauthorizationProxyMode) {
  reauthorizationForm.proxyMode = mode
}

function changeReauthorizationSearch(search: string) {
  reauthorizationSearch.value = search
}

function changeReauthorizationThreshold(input: {
  maxUsage7dPercent: number
  search: string
}) {
  const { maxUsage7dPercent, search } = input
  reauthorizationForm.maxUsage7dPercent = maxUsage7dPercent
  reauthorizationForm.accountId = null
  reauthorizationForm.accountName = ''
  reauthorizationForm.accountStatus = ''
  reauthorizationForm.accountEmail = ''
  selectedReauthorizationAccounts.value = []
  reauthorizationAccounts.value = null
  if (session.value.authenticated) {
    void loadReauthorizationAccounts({
      search,
      page: 1,
      maxUsage7dPercent,
    })
  }
}

function changeReauthorizationImportedTime(days: number | null) {
  reauthorizationImportedWithinDays.value = days
  reauthorizationForm.accountId = null
  reauthorizationForm.accountName = ''
  reauthorizationForm.accountStatus = ''
  reauthorizationForm.accountEmail = ''
  selectedReauthorizationAccounts.value = []
  reauthorizationAccounts.value = null
  if (session.value.authenticated) {
    void loadReauthorizationAccounts({
      search: reauthorizationSearch.value,
      page: 1,
      importedWithinDays: days,
    })
  }
}

async function startReauthorization(input: ReauthorizeTaskInput) {
  actionBusy.value = true
  errorMessage.value = ''
  try {
    const task = await localApi.startReauthorization(input)
    activeTask.value = task
    tasks.value = [task, ...tasks.value.filter((item) => item.id !== task.id)]
    watchTask(task.id)
  } catch (error) {
    reportError(error, '重新授权任务启动失败。')
  } finally {
    actionBusy.value = false
  }
}

async function refreshReauthorizationHosting() {
  try {
    reauthorizationHosting.value = await localApi.reauthorizationHosting()
    const currentTaskId = reauthorizationHosting.value.currentTaskId
    if (currentTaskId && activeTask.value?.id !== currentTaskId) {
      const active = await localApi.activeTask()
      if (active.task?.id === currentTaskId) {
        activeTask.value = active.task
        watchTask(currentTaskId)
      }
    }
  } catch {
    // The normal local-session error path remains authoritative.
  }
}

async function startReauthorizationHosting() {
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    const refreshed = await loadReauthorizationAccounts({
      search: reauthorizationSearch.value,
      page: 1,
      importedWithinDays: reauthorizationImportedWithinDays.value,
      includeExcluded: false,
    })
    if (!refreshed || !reauthorizationAccounts.value?.total) {
      errorMessage.value = '当前筛选条件下没有可托管的账号。'
      return
    }
    reauthorizationHosting.value = await localApi.startReauthorizationHosting({
      search: reauthorizationSearch.value.trim(),
      maxUsage7dPercent: reauthorizationForm.maxUsage7dPercent,
      ...(reauthorizationImportedWithinDays.value === null
        ? {}
        : { importedWithinDays: reauthorizationImportedWithinDays.value }),
      proxyMode: reauthorizationForm.proxyMode,
    })
    await refreshReauthorizationHosting()
  } catch (error) {
    reportError(error, '无法开始重新授权托管。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

async function stopReauthorizationHosting() {
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    reauthorizationHosting.value = await localApi.stopReauthorizationHosting()
  } catch (error) {
    reportError(error, '无法停止重新授权托管。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

async function skipCurrentReauthorizationHosting() {
  reauthorizationHostingBusy.value = true
  errorMessage.value = ''
  try {
    reauthorizationHosting.value = await localApi.skipCurrentReauthorizationHosting()
  } catch (error) {
    reportError(error, '无法跳过当前托管账号。')
  } finally {
    reauthorizationHostingBusy.value = false
  }
}

function commitTaskAccountEmail() {
  errorMessage.value = ''
  switchTaskCredentialEmail(taskForm, taskCredentialMemory)
}

function commitTaskCredentials() {
  errorMessage.value = ''
  rememberTaskCredential(taskForm, taskCredentialMemory)
}

async function cancelTask() {
  if (!activeTask.value) return
  actionBusy.value = true
  try {
    activeTask.value = await localApi.cancelTask(activeTask.value.id)
  } catch (error) {
    reportError(error, '取消失败。')
  } finally {
    actionBusy.value = false
  }
}

async function toggleTaskTakeover() {
  if (!activeTask.value || actionBusy.value) return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    activeTask.value = activeTask.value.manualTakeover
      ? await localApi.releaseTaskTakeover(activeTask.value.id)
      : await localApi.takeOverTask(activeTask.value.id)
  } catch (error) {
    reportError(error, activeTask.value.manualTakeover ? '取消接管失败。' : '人工接管失败。')
  } finally {
    actionBusy.value = false
  }
}

async function finishLogin() {
  pendingTotp.value = null
  await loadAuthenticatedData()
  view.value = 'task'
}

async function login(email: string, password: string, clearPassword: () => void) {
  actionBusy.value = true
  errorMessage.value = ''
  try {
    const result = await localApi.login(email, password)
    if (result.state === 'totp_required') {
      pendingTotp.value = result
    } else {
      session.value = result.session
      await finishLogin()
    }
  } catch (error) {
    reportError(error, '登录失败。')
  } finally {
    clearPassword()
    actionBusy.value = false
  }
}

async function completeTotp(attemptId: string, code: string, clearCode: () => void) {
  actionBusy.value = true
  errorMessage.value = ''
  try {
    session.value = await localApi.completeTotp(attemptId, code)
    await finishLogin()
  } catch (error) {
    reportError(error, '二次验证失败。')
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'BACKEND_TOTP_ATTEMPT_EXPIRED' || code === 'BACKEND_TOTP_ATTEMPT_INVALID') {
      pendingTotp.value = null
    }
  } finally {
    clearCode()
    actionBusy.value = false
  }
}

async function cancelPendingLogin() {
  actionBusy.value = true
  errorMessage.value = ''
  try {
    await localApi.cancelPendingLogin()
    pendingTotp.value = null
  } catch (error) {
    reportError(error, '无法取消二次验证。')
  } finally {
    actionBusy.value = false
  }
}

async function logout() {
  actionBusy.value = true
  try {
    await localApi.logout()
    reauthorizationAccountsRequests.invalidate()
    reauthorizationAccountsLoading.value = false
    session.value = { authenticated: false, email: null, user: null }
    pendingTotp.value = null
    options.value = null
    activeTask.value = null
    reauthorizationAccounts.value = null
    closeEvents?.()
    view.value = 'settings'
  } catch (error) {
    reportError(error, '退出失败。')
  } finally {
    actionBusy.value = false
  }
}

async function saveMailboxTrustSettings(customPathOrigins: string[], onSaved: () => void) {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    mailboxTrustSettings.value = await localApi.updateMailboxTrustSettings(customPathOrigins)
    onSaved()
  } catch (error) {
    reportError(error, '可信邮箱服务保存失败。')
  } finally {
    actionBusy.value = false
  }
}

async function saveDeactivationSettings(confirmationAttempts: number) {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    deactivationSettings.value = await localApi.updateDeactivationSettings(confirmationAttempts)
  } catch (error) {
    reportError(error, '封号确认次数保存失败。')
  } finally {
    actionBusy.value = false
  }
}

async function pairProvisioningAgent(input: {
  centralOrigin: string
  pairingCode: string
  deviceName: string
}) {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    provisioningAgent.value = await localApi.pairProvisioningAgent(input)
  } catch (error) {
    reportError(error, '执行助手配对失败。')
  } finally {
    actionBusy.value = false
  }
}

async function changeProvisioningAgentOrigin(centralOrigin: string, onSaved: () => void) {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    provisioningAgent.value = await localApi.changeProvisioningAgentOrigin(centralOrigin)
    onSaved()
  } catch (error) {
    reportError(error, '中央号池地址更换失败。')
  } finally {
    actionBusy.value = false
  }
}

async function disconnectProvisioningAgent() {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    await localApi.disconnectProvisioningAgent()
    provisioningAgent.value = await localApi.provisioningAgent()
  } catch (error) {
    reportError(error, '执行助手断开失败。')
  } finally {
    actionBusy.value = false
  }
}

async function connectAccountPoolPortal(input: AccountPoolPortalConnectInput, onSaved: () => void) {
  if (actionBusy.value) return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    accountPoolPortal.value = await localApi.connectAccountPoolPortal(input)
    onSaved()
  } catch (error) {
    if (accountPoolPortal.value) {
      accountPoolPortal.value = {
        ...accountPoolPortal.value,
        connected: false,
        lastError: {
          code: error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'ACCOUNT_POOL_CONNECT_FAILED',
          message: error instanceof Error ? error.message : '连接号池系统失败。',
        },
      }
    }
    reportError(error, '号池系统连接失败。')
  } finally {
    actionBusy.value = false
  }
}

async function disconnectAccountPoolPortal() {
  if (actionBusy.value || activeTask.value?.status === 'active') return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    await localApi.disconnectAccountPoolPortal()
    accountPoolPortal.value = await localApi.accountPoolPortal()
  } catch (error) {
    reportError(error, '号池系统断开失败。')
  } finally {
    actionBusy.value = false
  }
}

async function switchPoolConnectionMode(mode: PoolConnectionMode) {
  const nonAgentTaskRunning = activeTask.value?.status === 'active' && !provisioningAgent.value?.runningTask
  if (actionBusy.value || nonAgentTaskRunning || mode === poolConnectionMode.value) return
  actionBusy.value = true
  errorMessage.value = ''
  try {
    const modeStatus = await localApi.switchPoolConnectionMode(mode)
    const [agentStatus, accountPoolStatus] = await Promise.all([
      localApi.provisioningAgent(),
      localApi.accountPoolPortal(),
    ])
    poolConnectionMode.value = modeStatus.mode
    provisioningAgent.value = agentStatus
    accountPoolPortal.value = accountPoolStatus
  } catch (error) {
    reportError(error, '号池模式切换失败。')
  } finally {
    actionBusy.value = false
  }
}

async function refreshProvisioningAgentStatus() {
  if (loading.value || actionBusy.value) return
  try {
    const [agentStatus, accountPoolStatus, modeStatus] = await Promise.all([
      localApi.provisioningAgent(),
      localApi.accountPoolPortal(),
      localApi.poolConnectionMode(),
    ])
    provisioningAgent.value = agentStatus
    accountPoolPortal.value = accountPoolStatus
    poolConnectionMode.value = modeStatus.mode
  } catch {
    // The main local-session error path remains authoritative.
  }
}

async function deleteTask(id: string) {
  try {
    await localApi.deleteTask(id)
    tasks.value = tasks.value.filter((task) => task.id !== id)
  } catch (error) {
    reportError(error, '删除记录失败。')
  }
}

onMounted(() => {
  if (!redirectLocalhostToCanonicalOrigin()) {
    void initialize()
    agentStatusTimer = globalThis.setInterval(() => void refreshProvisioningAgentStatus(), 10_000)
    void refreshReauthorizationHosting()
    reauthorizationHostingTimer = globalThis.setInterval(() => void refreshReauthorizationHosting(), 2_000)
  }
})
onBeforeUnmount(() => {
  closeEvents?.()
  if (agentStatusTimer) globalThis.clearInterval(agentStatusTimer)
  if (reauthorizationHostingTimer) globalThis.clearInterval(reauthorizationHostingTimer)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-area">
        <strong>OAuth 账号工具</strong>
      </div>
      <div class="primary-navigation">
        <nav>
          <button :class="{ active: view === 'task' }" type="button" @click="selectView('task')">
            <UserPlus :size="19" />添加账号
          </button>
          <button :class="{ active: view === 'reauthorization' }" type="button" @click="selectView('reauthorization')">
            <RotateCw :size="19" />重新授权
          </button>
          <button :class="{ active: view === 'history' }" type="button" @click="selectView('history')">
            <ClipboardList :size="19" />任务记录
          </button>
          <button :class="{ active: view === 'settings' }" type="button" @click="selectView('settings')">
            <Settings :size="19" />设置
          </button>
        </nav>
      </div>
      <div class="connection-status">
        <span class="status-dot" :class="{ connected: session.authenticated }"></span>{{ connectedLabel }}
      </div>
      <div class="topbar-actions">
        <button class="icon-button" type="button" title="刷新当前页面" :disabled="!session.authenticated || currentViewRefreshing" @click="refreshCurrentView">
          <RefreshCw :size="19" :class="{ spin: currentViewRefreshing }" />
        </button>
        <button class="icon-button" type="button" title="设置" @click="selectView('settings')">
          <Settings :size="20" />
        </button>
      </div>
    </header>

    <main class="content-area">
      <div v-if="errorMessage" class="error-banner" role="alert">
        {{ errorMessage }}
      </div>
      <div v-if="loading" class="loading-state">
        <span class="spinner"></span>正在连接本地服务
      </div>
      <TaskView
        v-else-if="view === 'task'"
        :form="taskForm"
        :options="options"
        :authenticated="session.authenticated"
        :task="activeTask"
        :busy="workflowBusy"
        @start="startTask"
        @cancel="cancelTask"
        @toggle-takeover="toggleTaskTakeover"
        @account-email-committed="commitTaskAccountEmail"
        @credentials-changed="commitTaskCredentials"
      />
      <ReauthorizationView
        v-else-if="view === 'reauthorization'"
        :form="reauthorizationForm"
        :accounts="reauthorizationAccounts"
        :search="reauthorizationSearch"
        :imported-within-days="reauthorizationImportedWithinDays"
        :authenticated="session.authenticated"
        :task="activeTask"
        :busy="workflowBusy"
        :accounts-loading="reauthorizationAccountsLoading"
        :hosting="reauthorizationHosting"
        :hosting-busy="reauthorizationHostingBusy"
        :selected-account-ids="selectedReauthorizationAccounts.map((account) => account.id)"
        @load-accounts="loadReauthorizationAccounts"
        @toggle-account="toggleReauthorizationAccount"
        @save-disposition="saveReauthorizationDisposition"
        @save-bulk-disposition="saveBulkReauthorizationDisposition"
        @start-selected="startSelectedReauthorization"
        @start="startReauthorization"
        @cancel="cancelTask"
        @toggle-takeover="toggleTaskTakeover"
        @credentials-changed="commitReauthorizationCredentials"
        @proxy-mode-changed="changeReauthorizationProxyMode"
        @search-changed="changeReauthorizationSearch"
        @threshold-changed="changeReauthorizationThreshold"
        @imported-time-changed="changeReauthorizationImportedTime"
        @start-hosting="startReauthorizationHosting"
        @stop-hosting="stopReauthorizationHosting"
        @skip-current-hosting="skipCurrentReauthorizationHosting"
      />
      <HistoryView v-else-if="view === 'history'" :tasks="tasks" @delete="deleteTask" />
      <SettingsView
        v-else
        :session="session"
        :pending-totp="pendingTotp"
        :mailbox-trust-settings="mailboxTrustSettings"
        :deactivation-settings="deactivationSettings"
        :provisioning-agent="provisioningAgent"
        :account-pool-portal="accountPoolPortal"
        :pool-connection-mode="poolConnectionMode"
        :mailbox-settings-locked="activeTask?.status === 'active'"
        :busy="settingsBusy"
        :pool-connection-operation-busy="actionBusy"
        :mode-switch-disabled="settingsBusy || (Boolean(activeTask?.status === 'active') && !provisioningAgent?.runningTask)"
        @login="login"
        @complete-totp="completeTotp"
        @cancel-pending-login="cancelPendingLogin"
        @logout="logout"
        @save-mailbox-trust-settings="saveMailboxTrustSettings"
        @save-deactivation-settings="saveDeactivationSettings"
        @pair-provisioning-agent="pairProvisioningAgent"
        @change-provisioning-agent-origin="changeProvisioningAgentOrigin"
        @disconnect-provisioning-agent="disconnectProvisioningAgent"
        @connect-account-pool-portal="connectAccountPoolPortal"
        @disconnect-account-pool-portal="disconnectAccountPoolPortal"
        @switch-pool-connection-mode="switchPoolConnectionMode"
      />
    </main>
  </div>
</template>
