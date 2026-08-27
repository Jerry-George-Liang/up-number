<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Ban, CheckCircle2, ChevronLeft, ChevronRight, CircleX, Flag, Play, RefreshCw, Search, SkipForward, Square, X } from '@lucide/vue'
import type {
  PublicTask,
  ReauthorizationAccountPage,
  ReauthorizationAccountSummary,
  ReauthorizationHostingState,
  ReauthorizationProxyMode,
  ReauthorizeTaskInput,
} from '../../shared/contracts'
import { canCancelTaskStage } from '../../shared/task-state'
import LoginMaterialFields from '../components/LoginMaterialFields.vue'
import TaskProgress from '../components/TaskProgress.vue'
import {
  canStartReauthorization,
  toReauthorizeTaskInput,
  type ReauthorizationFormState,
} from '../state'
import { formatExactTime, formatRelativeTime } from '../time'

const props = defineProps<{
  form: ReauthorizationFormState
  accounts: ReauthorizationAccountPage | null
  search: string
  importedWithinDays: number | null
  suppliers: string[]
  supplier: string
  importedAfter: string
  importedBefore: string
  authenticated: boolean
  task: PublicTask | null
  busy: boolean
  accountsLoading: boolean
  hosting: ReauthorizationHostingState | null
  hostingBusy: boolean
  selectedAccountIds: number[]
}>()

const emit = defineEmits<{
  loadAccounts: [input: { search: string; page: number; pageSize?: number; importedWithinDays?: number | null; includeExcluded?: boolean; supplier?: string; importedAfter?: string; importedBefore?: string }]
  toggleAccount: [account: ReauthorizationAccountSummary]
  saveDisposition: [input: { account: ReauthorizationAccountSummary; note: string; excluded: boolean }]
  saveBulkDisposition: [input: { note: string; excluded: boolean }]
  startSelected: []
  start: [input: ReauthorizeTaskInput]
  cancel: []
  toggleTakeover: []
  credentialsChanged: []
  proxyModeChanged: [mode: ReauthorizationProxyMode]
  searchChanged: [search: string]
  thresholdChanged: [input: { maxUsage7dPercent: number; search: string }]
  importedTimeChanged: [days: number | null]
  startHosting: []
  stopHosting: []
  skipCurrentHosting: []
}>()

const hostingActive = computed(() => ['running', 'paused', 'stopping'].includes(props.hosting?.status ?? 'idle'))
const hasHostingSummary = computed(() => Boolean(props.hosting?.total))
const hostingProcessed = computed(() =>
  props.hosting
    ? props.hosting.completed + props.hosting.failed + props.hosting.banned + props.hosting.skipped
    : 0,
)
const hostingElapsedLabel = computed(() => {
  const startedAt = props.hosting?.createdAt
  if (!startedAt) return '00:00:00'
  const endTime = hostingActive.value ? relativeTimeNow.value : Date.parse(props.hosting?.updatedAt ?? startedAt)
  const elapsedSeconds = Math.max(0, Math.floor((endTime - Date.parse(startedAt)) / 1000))
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
})
const hostingStatusLabel = computed(() => {
  const status = props.hosting?.status
  if (status === 'running') return '运行中'
  if (status === 'paused') return '等待人工'
  if (status === 'stopping') return '正在停止'
  if (status === 'completed') return '已完成'
  if (status === 'stopped') return '已停止'
  return '未开始'
})
const hostingResultLabel = computed(() => {
  if (!props.hosting?.lastResult) return ''
  return { success: '成功', failed: '失败', banned: '封号', skipped: '跳过' }[props.hosting.lastResult]
})
const hostingCurrentAccountLabel = computed(() => {
  if (
    props.hosting?.currentTaskId &&
    props.task?.id === props.hosting.currentTaskId &&
    props.task.accountEmail
  ) {
    return props.task.accountEmail
  }
  return props.hosting?.currentAccountId ? `#${props.hosting.currentAccountId}` : ''
})
const canSkipCurrent = computed(() =>
  Boolean(
    props.hosting?.currentTaskId &&
    props.task?.id === props.hosting.currentTaskId &&
    props.task.status === 'active' &&
    canCancelTaskStage(props.task.stage) &&
    props.hosting.status !== 'stopping',
  ),
)

const canSubmit = computed(() =>
  props.selectedAccountIds.length > 1
    ? props.authenticated && !props.busy && props.form.materialSource === 'account_pool'
    : canStartReauthorization(props.form, props.authenticated, props.busy),
)
const searchDraft = ref(props.search)
const thresholdDraft = ref(String(props.form.maxUsage7dPercent))
const thresholdError = ref('')
const importedTimePreset = ref(
  props.importedWithinDays === null || [1, 3, 7, 15, 30].includes(props.importedWithinDays)
    ? String(props.importedWithinDays ?? '')
    : 'custom',
)
const customImportedDays = ref(String(props.importedWithinDays ?? 7))
const importedTimeError = ref('')
const showExcludedAccounts = ref(false)
const supplierDraft = ref(props.supplier)
const importedAfterDraft = ref(props.importedAfter ? props.importedAfter.slice(0, 16) : '')
const importedBeforeDraft = ref(props.importedBefore ? props.importedBefore.slice(0, 16) : '')
const dispositionAccount = ref<ReauthorizationAccountSummary | null>(null)
const visibleAccounts = computed(() =>
  props.accounts?.items ?? [],
)

function toggleExcludedAccounts() {
  emit('loadAccounts', {
    search: searchDraft.value,
    page: 1,
    importedWithinDays: props.importedWithinDays,
    includeExcluded: showExcludedAccounts.value,
    supplier: supplierDraft.value,
    importedAfter: props.importedAfter,
    importedBefore: props.importedBefore,
  })
}

function applyExtendedFilters(): void {
  const after = importedAfterDraft.value ? new Date(importedAfterDraft.value).toISOString() : ''
  const before = importedBeforeDraft.value ? new Date(importedBeforeDraft.value).toISOString() : ''
  emit('loadAccounts', {
    search: searchDraft.value,
    page: 1,
    importedWithinDays: props.importedWithinDays,
    includeExcluded: showExcludedAccounts.value,
    supplier: supplierDraft.value,
    importedAfter: after,
    importedBefore: before,
  })
}
const bulkDisposition = ref(false)
const dispositionNote = ref('')
const dispositionExcluded = ref(true)
const dispositionError = ref('')
const dispositionPresets = ['邮箱接码过期', '邮箱接码失效', '手机接码', '号池没有']
const relativeTimeNow = ref(Date.now())
let relativeTimeTimer: ReturnType<typeof globalThis.setInterval> | null = null
onMounted(() => {
  relativeTimeTimer = globalThis.setInterval(() => {
    relativeTimeNow.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  if (relativeTimeTimer !== null) globalThis.clearInterval(relativeTimeTimer)
})
watch(
  () => props.search,
  (value) => {
    searchDraft.value = value
  },
)
watch(
  () => props.form.maxUsage7dPercent,
  (value) => {
    thresholdDraft.value = String(value)
    thresholdError.value = ''
  },
)
watch(
  () => props.importedWithinDays,
  (value) => {
    importedTimePreset.value = value === null || [1, 3, 7, 15, 30].includes(value) ? String(value ?? '') : 'custom'
    if (value !== null) customImportedDays.value = String(value)
    importedTimeError.value = ''
  },
)

function commitThreshold(event: globalThis.Event) {
  thresholdDraft.value = (event.currentTarget as globalThis.HTMLInputElement).value
  const value = thresholdDraft.value.trim()
  if (!/^\d+$/.test(value)) {
    thresholdError.value = '请输入 0 到 100 的整数。'
    return
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    thresholdError.value = '请输入 0 到 100 的整数。'
    return
  }
  thresholdError.value = ''
  if (parsed === props.form.maxUsage7dPercent) return
  emit('thresholdChanged', {
    maxUsage7dPercent: parsed,
    search: searchDraft.value,
  })
}

function updateSearchDraft(event: globalThis.Event) {
  searchDraft.value = (event.currentTarget as globalThis.HTMLInputElement).value
  emit('searchChanged', searchDraft.value)
}

function submitSearch() {
  emit('loadAccounts', { search: searchDraft.value, page: 1 })
}

function refreshAccounts() {
  const search = searchDraft.value.trim()
  const currentSearch = props.search.trim()
  emit('loadAccounts', {
    search,
    page: search === currentSearch ? (props.accounts?.page ?? 1) : 1,
    importedWithinDays: props.importedWithinDays,
  })
}

function page(delta: number) {
  const current = props.accounts?.page ?? 1
  emit('loadAccounts', {
    search: props.search,
    page: current + delta,
    importedWithinDays: props.importedWithinDays,
  })
}

function loadPage(pageNumber: number) {
  emit('loadAccounts', {
    search: props.search,
    page: pageNumber,
    importedWithinDays: props.importedWithinDays,
  })
}

function selectPage(event: globalThis.Event) {
  loadPage(Number((event.currentTarget as globalThis.HTMLSelectElement).value))
}

function selectPageSize(event: globalThis.Event) {
  emit('loadAccounts', {
    search: props.search,
    page: 1,
    pageSize: Number((event.currentTarget as globalThis.HTMLSelectElement).value),
    importedWithinDays: props.importedWithinDays,
  })
}

function updateImportedTime(event: globalThis.Event) {
  const value = (event.currentTarget as globalThis.HTMLSelectElement).value
  importedTimePreset.value = value
  importedTimeError.value = ''
  if (value !== 'custom') emit('importedTimeChanged', value === '' ? null : Number(value))
}

function commitCustomImportedTime() {
  const value = customImportedDays.value.trim()
  if (!/^\d+$/.test(value)) {
    importedTimeError.value = '请输入 1 到 365 天。'
    return
  }
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    importedTimeError.value = '请输入 1 到 365 天。'
    return
  }
  importedTimeError.value = ''
  if (days !== props.importedWithinDays) emit('importedTimeChanged', days)
}

function submit() {
  emit('credentialsChanged')
  if (!canSubmit.value) return
  if (props.selectedAccountIds.length > 1) emit('startSelected')
  else emit('start', toReauthorizeTaskInput(props.form))
}

function updateProxyMode(event: globalThis.Event) {
  emit('proxyModeChanged', (event.currentTarget as globalThis.HTMLSelectElement).value as ReauthorizationProxyMode)
}

function timeLabel(value: string | null | undefined): string {
  return formatRelativeTime(value, relativeTimeNow.value)
}

function openDisposition(account: ReauthorizationAccountSummary) {
  bulkDisposition.value = false
  dispositionAccount.value = account
  dispositionNote.value = account.hostingNote ?? ''
  dispositionExcluded.value = account.excludedFromHosting ?? true
  dispositionError.value = ''
}

function openBulkDisposition() {
  if (props.selectedAccountIds.length === 0) return
  dispositionAccount.value = null
  bulkDisposition.value = true
  dispositionNote.value = ''
  dispositionExcluded.value = true
  dispositionError.value = ''
}

function closeDisposition() {
  if (props.hostingBusy) return
  dispositionAccount.value = null
  bulkDisposition.value = false
}

function saveDisposition() {
  if ((!dispositionAccount.value && !bulkDisposition.value) || props.hostingBusy) return
  const note = dispositionNote.value.trim()
  if (note.length > 80 || /[（）\r\n]/.test(note)) {
    dispositionError.value = '备注最多 80 个字符，不能包含括号或换行。'
    return
  }
  if (bulkDisposition.value) emit('saveBulkDisposition', { note, excluded: dispositionExcluded.value })
  else emit('saveDisposition', { account: dispositionAccount.value!, note, excluded: dispositionExcluded.value })
  dispositionAccount.value = null
  bulkDisposition.value = false
}
</script>

<template>
  <div class="task-workspace">
    <section class="task-main reauthorization-main" aria-labelledby="reauthorization-title">
      <div class="section-heading">
        <h1 id="reauthorization-title">
          重新授权
        </h1>
        <button
          v-if="task?.status === 'active' && canCancelTaskStage(task.stage)"
          class="secondary-button danger-button"
          type="button"
          @click="emit('cancel')"
        >
          取消任务
        </button>
      </div>

      <div class="reauthorization-filters">
        <label class="reauthorization-filter-field">
          <span>账号状态</span>
          <select disabled><option>错误</option></select>
        </label>
        <label class="reauthorization-filter-field">
          <span>供应商</span>
          <select v-model="supplierDraft" :disabled="busy || accountsLoading" @change="applyExtendedFilters">
            <option value="">全部供应商</option>
            <option v-for="item in suppliers" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="reauthorization-filter-field">
          <span>用量窗口</span>
          <select disabled><option>7 天</option></select>
        </label>
        <label class="reauthorization-threshold">
          <span>用量 ≤</span>
          <input
            v-model="thresholdDraft"
            name="maxUsage7dPercent"
            type="number"
            inputmode="numeric"
            min="0"
            max="100"
            step="1"
            :aria-invalid="Boolean(thresholdError)"
            :disabled="busy"
            @input="commitThreshold"
          />
          <span>%</span>
          <small v-if="thresholdError">{{ thresholdError }}</small>
        </label>
        <label class="reauthorization-time-filter" :class="{ custom: importedTimePreset === 'custom' }">
          <span>导入时间</span>
          <select
            :value="importedTimePreset"
            :disabled="busy || accountsLoading"
            @change="updateImportedTime"
          >
            <option value="">全部时间</option>
            <option value="1">24 小时内</option>
            <option value="3">3 天内</option>
            <option value="7">7 天内</option>
            <option value="15">15 天内</option>
            <option value="30">30 天内</option>
            <option value="custom">自定义</option>
          </select>
          <input
            v-if="importedTimePreset === 'custom'"
            v-model="customImportedDays"
            type="number"
            inputmode="numeric"
            min="1"
            max="365"
            step="1"
            aria-label="自定义导入天数"
            :aria-invalid="Boolean(importedTimeError)"
            :disabled="busy || accountsLoading"
            @change="commitCustomImportedTime"
            @keydown.enter.prevent="commitCustomImportedTime"
          />
          <span v-if="importedTimePreset === 'custom'" class="custom-time-unit">天内</span>
          <small v-if="importedTimeError">{{ importedTimeError }}</small>
        </label>
        <label class="reauthorization-filter-field">
          <span>导入时间起点（精确到秒）</span>
          <input v-model="importedAfterDraft" type="datetime-local" step="1" :disabled="busy || accountsLoading" @change="applyExtendedFilters" />
        </label>
        <label class="reauthorization-filter-field">
          <span>导入时间终点（精确到秒）</span>
          <input v-model="importedBeforeDraft" type="datetime-local" step="1" :disabled="busy || accountsLoading" @change="applyExtendedFilters" />
        </label>
        <form class="reauthorization-search" role="search" @submit.prevent="submitSearch">
          <input
            :value="searchDraft"
            name="search"
            type="search"
            placeholder="搜索账号名称或邮箱"
            @input="updateSearchDraft"
          />
          <button class="icon-button" type="submit" title="搜索账号" :disabled="accountsLoading">
            <Search :size="18" />
          </button>
        </form>
        <button
          class="secondary-button reauthorization-refresh-button"
          type="button"
          :disabled="accountsLoading || !authenticated"
          @click="refreshAccounts"
        >
          <RefreshCw :size="17" :class="{ spin: accountsLoading }" />
          刷新
        </button>
        <label class="reauthorization-show-excluded">
          <input v-model="showExcludedAccounts" type="checkbox" @change="toggleExcludedAccounts" />
          <span>显示已标记不托管账号</span>
        </label>
      </div>

      <div class="reauthorization-list-summary" role="status" aria-live="polite">
        <span v-if="accountsLoading">正在更新账号数量</span>
        <template v-else-if="accounts">
          <span>符合条件</span><strong>{{ accounts.total }}</strong><span>个账号</span>
          <span class="reauthorization-page-count">当前页显示 {{ visibleAccounts.length }} 个</span>
        </template>
        <span v-else>尚未读取账号数量</span>
        <button
          v-if="selectedAccountIds.length"
          class="secondary-button reauthorization-bulk-disposition-button"
          type="button"
          :disabled="hostingBusy"
          @click="openBulkDisposition"
        ><Flag :size="16" />批量处置 {{ selectedAccountIds.length }}</button>
        <div v-if="accounts && accounts.pages > 1" class="reauthorization-inline-pagination" aria-label="账号列表分页">
          <button class="icon-button" type="button" title="上一页" :disabled="accounts.page <= 1 || accountsLoading" @click="page(-1)">
            <ChevronLeft :size="18" />
          </button>
          <label>
            <span>第</span>
            <select :value="accounts.page" :disabled="accountsLoading" aria-label="选择页码" @change="selectPage">
              <option v-for="pageNumber in accounts.pages" :key="pageNumber" :value="pageNumber">{{ pageNumber }}</option>
            </select>
            <span>/ {{ accounts.pages }} 页</span>
          </label>
          <button class="icon-button" type="button" title="下一页" :disabled="accounts.page >= accounts.pages || accountsLoading" @click="page(1)">
            <ChevronRight :size="18" />
          </button>
        </div>
      </div>

      <div class="reauthorization-account-table">
        <table>
          <thead>
            <tr>
              <th>账号名称</th><th class="reauthorization-hosting-mark-heading">托管</th><th class="reauthorization-select-heading">选择</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in visibleAccounts" :key="account.id">
              <td class="reauthorization-account-cell">
                <details class="reauthorization-account-details">
                  <summary>{{ account.name }}</summary>
                  <dl>
                    <div><dt>邮箱</dt><dd :title="account.email">{{ account.email }}</dd></div>
                    <div><dt>状态</dt><dd><span class="status-badge" :class="account.status === 'error' ? 'error' : ''">{{ account.status }}</span></dd></div>
                    <div><dt>7 天用量</dt><dd class="usage-cell">{{ account.usage7dPercent.toFixed(2) }}%</dd></div>
                    <div><dt>导入时间</dt><dd :title="formatExactTime(account.importedAt)">{{ timeLabel(account.importedAt) }}</dd></div>
                  </dl>
                </details>
              </td>
              <td class="reauthorization-hosting-mark-cell">
                <button
                  class="icon-button reauthorization-hosting-mark-button"
                  :class="{ active: account.excludedFromHosting }"
                  type="button"
                  :title="account.hostingNote || account.excludedFromHosting ? '编辑备注和托管设置' : '添加备注和跳过设置'"
                  :aria-pressed="Boolean(account.excludedFromHosting)"
                  :disabled="hostingBusy"
                  @click="openDisposition(account)"
                >
                  <Flag :size="17" :fill="account.excludedFromHosting ? 'currentColor' : 'none'" />
                </button>
                <span v-if="account.excludedFromHosting" class="reauthorization-hosting-mark-label">不托管</span>
              </td>
              <td class="reauthorization-select-cell">
                <label class="account-checkbox" :title="selectedAccountIds.includes(account.id) ? '取消选择' : '选择此账号'">
                  <input
                    type="checkbox"
                    :checked="selectedAccountIds.includes(account.id)"
                    :disabled="busy"
                    @change="emit('toggleAccount', account)"
                  />
                  <span aria-hidden="true"></span>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="accountsLoading" class="account-list-state">
          <span class="spinner"></span>正在读取账号
        </div>
        <div v-else-if="!visibleAccounts.length" class="account-list-state">
          没有符合条件的账号
        </div>
      </div>

      <div v-if="dispositionAccount || bulkDisposition" class="account-disposition-backdrop" role="presentation" @click.self="closeDisposition">
        <form class="account-disposition-dialog" role="dialog" aria-modal="true" aria-labelledby="account-disposition-title" @submit.prevent="saveDisposition">
          <div class="account-disposition-header">
            <div>
              <strong id="account-disposition-title">{{ bulkDisposition ? `批量处置 ${selectedAccountIds.length} 个账号` : '账号处置' }}</strong>
              <small>{{ bulkDisposition ? '相同备注和托管设置将应用到全部已选账号' : dispositionAccount?.email }}</small>
            </div>
            <button class="icon-button" type="button" title="关闭" :disabled="hostingBusy" @click="closeDisposition"><X :size="18" /></button>
          </div>
          <div class="account-disposition-presets" aria-label="快捷备注">
            <button
              v-for="preset in dispositionPresets"
              :key="preset"
              class="secondary-button"
              :class="{ active: dispositionNote === preset }"
              type="button"
              @click="dispositionNote = preset"
            >{{ preset }}</button>
          </div>
          <label class="account-disposition-field">
            <span>账号名称备注</span>
            <input v-model="dispositionNote" type="text" maxlength="80" placeholder="输入自定义备注" />
            <small>保存后显示为：账号名称（{{ dispositionNote.trim() || '备注内容' }}）</small>
          </label>
          <label class="account-disposition-toggle">
            <input v-model="dispositionExcluded" type="checkbox" />
            <span>跳过本机自动托管</span>
          </label>
          <p v-if="dispositionError" class="account-disposition-error">{{ dispositionError }}</p>
          <div class="account-disposition-actions">
            <button class="secondary-button" type="button" :disabled="hostingBusy" @click="closeDisposition">取消</button>
            <button class="primary-button" type="submit" :disabled="hostingBusy">{{ hostingBusy ? '保存中' : '保存' }}</button>
          </div>
        </form>
      </div>

      <div v-if="accounts && accounts.total > 0" class="pagination-row">
        <label class="reauthorization-page-size">
          <span>每页</span>
          <select :value="accounts.pageSize" :disabled="accountsLoading" aria-label="每页显示数量" @change="selectPageSize">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
          <span>个，共 {{ accounts.total }} 个</span>
        </label>
        <div v-if="accounts.pages > 1" class="pagination-controls">
        <button class="icon-button" type="button" title="上一页" :disabled="accounts.page <= 1 || accountsLoading" @click="page(-1)">
          <ChevronLeft :size="19" />
        </button>
        <span>
          第 {{ accounts.page }} / {{ accounts.pages }} 页
        </span>
        <button class="icon-button" type="button" title="下一页" :disabled="accounts.page >= accounts.pages || accountsLoading" @click="page(1)">
          <ChevronRight :size="19" />
        </button>
        </div>
      </div>
    </section>
    <div class="reauthorization-side">
      <section class="reauthorization-hosting" aria-live="polite">
        <div class="reauthorization-hosting-copy">
          <div class="reauthorization-hosting-heading">
            <strong>自动托管</strong>
            <span class="reauthorization-hosting-state" :data-status="hosting?.status ?? 'idle'">{{ hostingStatusLabel }}</span>
          </div>
          <div v-if="hasHostingSummary && hosting" class="reauthorization-hosting-progress">
            <span>已处理 <strong>{{ hostingProcessed }}</strong> / {{ hosting.total }}</span>
            <span class="hosting-elapsed" title="本轮托管运行时间">用时 {{ hostingElapsedLabel }}</span>
          </div>
          <span v-else>按当前筛选条件逐个重新授权</span>
          <div v-if="hasHostingSummary && hosting" class="reauthorization-hosting-results" aria-label="托管结果统计">
            <span class="hosting-result hosting-result-success"><CheckCircle2 :size="14" /><span>成功</span><strong>{{ hosting.completed }}</strong></span>
            <span class="hosting-result hosting-result-failed"><CircleX :size="14" /><span>失败</span><strong>{{ hosting.failed }}</strong></span>
            <span class="hosting-result hosting-result-banned"><Ban :size="14" /><span>封号</span><strong>{{ hosting.banned }}</strong></span>
            <span class="hosting-result hosting-result-skipped"><SkipForward :size="14" /><span>跳过</span><strong>{{ hosting.skipped }}</strong></span>
          </div>
          <small v-if="hosting?.currentAccountId">当前账号 {{ hostingCurrentAccountLabel }} · {{ hosting.lastMessage }}</small>
          <small v-else-if="hosting?.lastAccountId && hosting.lastResult">最近账号 #{{ hosting.lastAccountId }} · {{ hostingResultLabel }} · {{ hosting.lastMessage }}</small>
          <small v-else-if="hasHostingSummary && hosting">{{ hosting.lastMessage }}</small>
        </div>
        <div v-if="hostingActive" class="reauthorization-hosting-actions">
          <button
            class="secondary-button reauthorization-hosting-button"
            type="button"
            :disabled="hostingBusy || hosting?.status === 'stopping'"
            @click="emit('stopHosting')"
          >
            <Square :size="17" fill="currentColor" />{{ hosting?.status === 'stopping' ? '正在停止' : '停止托管' }}
          </button>
          <button
            class="secondary-button reauthorization-hosting-skip-button"
            type="button"
            title="取消当前账号并继续下一个"
            :disabled="hostingBusy || !canSkipCurrent"
            @click="emit('skipCurrentHosting')"
          >
            <SkipForward :size="17" />跳过当前
          </button>
        </div>
        <div v-else class="reauthorization-hosting-start-row">
          <button
            class="primary-button reauthorization-hosting-button"
            type="button"
            :disabled="hostingBusy || busy || accountsLoading || !accounts?.total"
            @click="emit('startHosting')"
          >
            <Play :size="17" fill="currentColor" />开始托管
          </button>
          <div class="reauthorization-hosting-ready-count" title="按当前筛选条件准备托管的账号数量">
            <span>准备托管</span>
            <strong>{{ accountsLoading ? '—' : (accounts?.total ?? 0) }}</strong>
          </div>
        </div>
      </section>
      <form class="task-form reauthorization-form reauthorization-side-form" @submit.prevent="submit">
        <div v-if="selectedAccountIds.length" class="selected-account-band">
          <div><span>已选择</span><strong>{{ selectedAccountIds.length }} 个账号</strong></div>
          <template v-if="selectedAccountIds.length === 1">
          <div><span>账号名称</span><strong>{{ form.accountName }}</strong></div>
          <div><span>导入时间</span><strong :title="formatExactTime(form.accountImportedAt)">{{ timeLabel(form.accountImportedAt) }}</strong></div>
          <div><span>当前状态</span><strong>{{ form.accountStatus }}</strong></div>
          </template>
        </div>
        <div v-else class="reauthorization-selection-state" role="status">
          请先从上方选择需要重新授权的账号
        </div>
        <div class="reauthorization-proxy-choice">
          <label for="reauthorization-proxy-mode">重新授权代理</label>
          <select
            id="reauthorization-proxy-mode"
            :value="form.proxyMode"
            :disabled="busy || !selectedAccountIds.length"
            @change="updateProxyMode"
          >
            <option value="existing">
              原账号代理
            </option>
            <option value="none">
              无代理
            </option>
          </select>
          <small>“无代理”只对本次任务直连，不修改后台账号配置。</small>
        </div>
        <LoginMaterialFields
          :form="form"
          :disabled="!selectedAccountIds.length || selectedAccountIds.length > 1"
          email-readonly
          :email-placeholder="selectedAccountIds.length > 1 ? '批量任务统一从账号池获取' : '请先选择需要重新授权的账号'"
          id-prefix="reauthorization"
          @credentials-changed="emit('credentialsChanged')"
        />
        <div class="field-row form-actions">
          <span></span>
          <button class="primary-button" type="submit" :disabled="!canSubmit">
            <RefreshCw :size="18" />{{ busy ? '任务运行中' : '开始重新授权' }}
          </button>
        </div>
      </form>
      <TaskProgress :task="task" @toggle-takeover="emit('toggleTakeover')" />
    </div>
  </div>
</template>
