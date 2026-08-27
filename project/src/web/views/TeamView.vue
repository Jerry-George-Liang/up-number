<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Box, Download, FileSearch, RefreshCw, Search, ShieldCheck, Upload } from '@lucide/vue'
import { localApi, type TeamWorkflowState } from '../api'

type TeamTab = 'redeem' | 'reclaim'
type ExportFormat = 'sub2api' | 'cpa'

const TEAM_DRAFT_KEY = 'up-icloud.team.draft.v1'

interface TeamDraft {
  tab: TeamTab
  redeemInput: string
  reclaimInput: string
  format: ExportFormat
  confirmReclaimAll: boolean
}

function restoreDraft(): TeamDraft {
  const fallback: TeamDraft = { tab: 'redeem', redeemInput: '', reclaimInput: '', format: 'sub2api', confirmReclaimAll: false }
  try {
    const parsed = JSON.parse(globalThis.localStorage.getItem(TEAM_DRAFT_KEY) ?? '') as Partial<TeamDraft>
    return {
      tab: parsed.tab === 'reclaim' ? 'reclaim' : 'redeem',
      redeemInput: typeof parsed.redeemInput === 'string' ? parsed.redeemInput : '',
      reclaimInput: typeof parsed.reclaimInput === 'string' ? parsed.reclaimInput : '',
      format: parsed.format === 'cpa' ? 'cpa' : 'sub2api',
      confirmReclaimAll: parsed.confirmReclaimAll === true,
    }
  } catch {
    return fallback
  }
}

const draft = restoreDraft()
const tab = ref<TeamTab>(draft.tab)
const redeemInput = ref(draft.redeemInput)
const reclaimInput = ref(draft.reclaimInput)
const format = ref<ExportFormat>(draft.format)
const fileInput = ref<HTMLInputElement | null>(null)
const confirmReclaimAll = ref(draft.confirmReclaimAll)
const workflow = ref<TeamWorkflowState | null>(null)
const workflowBusy = ref(false)
const workflowError = ref('')
const actionResult = ref('')
const actionBusy = ref(false)
const redeemResult = ref<Record<string, unknown> | null>(null)
const redeemMessage = ref('')
const reclaimResult = ref<Record<string, unknown> | null>(null)
const reclaimMessage = ref('')
let workflowTimer: ReturnType<typeof globalThis.setInterval> | null = null

interface ReclaimTask {
  status?: string
  no_action?: boolean
  order_no?: string
  download_token?: string
}

function numberField(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const reclaimTasks = computed<ReclaimTask[]>(() => {
  const cards = Array.isArray(reclaimResult.value?.cards) ? reclaimResult.value.cards : []
  return cards.flatMap((card) => card && typeof card === 'object' && Array.isArray((card as { tasks?: unknown }).tasks)
    ? (card as { tasks: ReclaimTask[] }).tasks
    : [])
})
const reclaimCompleted = computed(() => reclaimTasks.value.filter((task) => ['done', 'skipped', 'unreclaimable', 'not_owned', 'exhausted', 'failed'].includes(task.status ?? '')).length)
const reclaimNormal = computed(() => Math.max(numberField(reclaimResult.value, 'skipped_not_401'), reclaimTasks.value.filter((task) => task.no_action).length))
const reclaimUpdated = computed(() => reclaimTasks.value.filter((task) => task.status === 'done' && !task.no_action).length)
const reclaimPending = computed(() => Math.max(0, reclaimCodes.value.length - reclaimCompleted.value))
const reclaimDownloads = computed(() => reclaimTasks.value.filter((task) => task.status === 'done' && task.order_no && task.download_token))

interface RedeemEntry {
  cardCode?: string
  preview?: Record<string, unknown>
  order?: Record<string, unknown> | null
}

const redeemEntries = computed<RedeemEntry[]>(() => Array.isArray(redeemResult.value?.results)
  ? redeemResult.value.results.filter((item): item is RedeemEntry => Boolean(item && typeof item === 'object'))
  : [])
const redeemFirst = computed(() => redeemEntries.value[0] ?? null)
const redeemPreview = computed(() => {
  const value = redeemFirst.value?.preview
  return value && typeof value.preview === 'object' ? value.preview as Record<string, unknown> : value ?? null
})
const redeemOrder = computed(() => {
  const value = redeemFirst.value?.order
  return value && typeof value.order === 'object' ? value.order as Record<string, unknown> : value ?? null
})
const redeemOrderNo = computed(() => typeof redeemOrder.value?.order_no === 'string' ? redeemOrder.value.order_no : '')
const redeemDownloadToken = computed(() => typeof redeemOrder.value?.download_token === 'string' ? redeemOrder.value.download_token : '')
const redeemStatus = computed(() => typeof redeemOrder.value?.status === 'string' ? redeemOrder.value.status : redeemOrder.value ? 'submitted' : 'unavailable')
const redeemBound = computed(() => numberField(redeemPreview.value, 'bound_count'))
const redeemQuota = computed(() => numberField(redeemPreview.value, 'card_quota_total'))
const redeemDelivered = computed(() => numberField(redeemOrder.value, 'delivered_count'))

async function refreshWorkflow(): Promise<void> {
  try {
    workflow.value = await localApi.teamWorkflow()
    if (workflow.value.status !== 'running' && workflowTimer !== null) {
      globalThis.clearInterval(workflowTimer)
      workflowTimer = null
    }
  } catch (error) {
    workflowError.value = error instanceof Error ? error.message : '无法读取 Team 自动任务状态。'
  }
}

async function startWorkflow(): Promise<void> {
  workflowBusy.value = true
  workflowError.value = ''
  try {
    workflow.value = await localApi.startTeamWorkflow()
    if (workflowTimer === null) workflowTimer = globalThis.setInterval(() => void refreshWorkflow(), 2_000)
  } catch (error) {
    workflowError.value = error instanceof Error ? error.message : '无法启动 Team 自动处理。'
  } finally {
    workflowBusy.value = false
  }
}

void refreshWorkflow()

watch([tab, redeemInput, reclaimInput, format, confirmReclaimAll], () => {
  try {
    globalThis.localStorage.setItem(TEAM_DRAFT_KEY, JSON.stringify({
      tab: tab.value,
      redeemInput: redeemInput.value,
      reclaimInput: reclaimInput.value,
      format: format.value,
      confirmReclaimAll: confirmReclaimAll.value,
    } satisfies TeamDraft))
  } catch {
    // The live form remains usable when local storage is unavailable or full.
  }
})

function parseCodes(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 2000)
}

const redeemCodes = computed(() => parseCodes(redeemInput.value))
const reclaimCodes = computed(() => parseCodes(reclaimInput.value))
const redeemLineCount = computed(() => redeemInput.value ? redeemInput.value.split(/\r?\n/).length : 0)
const reclaimLineCount = computed(() => reclaimInput.value ? reclaimInput.value.split(/\r?\n/).length : 0)

function normalizeRedeemInput(): void {
  redeemInput.value = redeemCodes.value.join('\n')
}

function normalizeReclaimInput(): void {
  reclaimInput.value = reclaimCodes.value.join('\n')
}

async function redeem(): Promise<void> {
  if (!redeemCodes.value.length || format.value === 'cpa' || actionBusy.value) return
  actionBusy.value = true; actionResult.value = ''; redeemMessage.value = ''
  try {
    redeemResult.value = await localApi.redeemTeamCodes(redeemCodes.value, format.value) as Record<string, unknown>
    const submitted = redeemEntries.value.filter((entry) => entry.order).length
    redeemMessage.value = `核对完成：${redeemCodes.value.length} 张兑换码，已提交 ${submitted} 个兑换订单。`
  } catch (error) { redeemMessage.value = error instanceof Error ? error.message : '兑换失败。' }
  finally { actionBusy.value = false }
}

async function downloadRedeemOrder(): Promise<void> {
  if (!redeemOrderNo.value || !redeemDownloadToken.value || actionBusy.value) return
  actionBusy.value = true
  try {
    const blob = await localApi.downloadTeamOrder(redeemOrderNo.value, redeemDownloadToken.value)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${redeemOrderNo.value}.bin`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) { redeemMessage.value = error instanceof Error ? error.message : '下载失败。' }
  finally { actionBusy.value = false }
}
async function healthCheck(): Promise<void> {
  if (!reclaimCodes.value.length || actionBusy.value) return
  actionBusy.value = true; actionResult.value = ''
  try {
    const result = await localApi.teamHealthCheck(reclaimCodes.value) as Record<string, unknown>
    reclaimResult.value = result
    reclaimMessage.value = `检测完成：需要找回 ${numberField(result, 'need_reclaim')}，正常 ${numberField(result, 'healthy')}，无法找回 ${numberField(result, 'cannot_reclaim')}。`
  } catch (error) { reclaimMessage.value = error instanceof Error ? error.message : '检测失败。' }
  finally { actionBusy.value = false }
}
async function history(): Promise<void> {
  if (!reclaimCodes.value.length || actionBusy.value) return
  actionBusy.value = true; actionResult.value = ''
  try {
    const result = await localApi.teamHistory(reclaimCodes.value) as Record<string, unknown>
    reclaimResult.value = result
    const cards = Array.isArray(result.cards) ? result.cards.length : 0
    reclaimMessage.value = `兑换状态查询完成，共返回 ${cards} 张兑换码。`
  } catch (error) { reclaimMessage.value = error instanceof Error ? error.message : '查询失败。' }
  finally { actionBusy.value = false }
}
async function reclaim(mode: '401' | 'all'): Promise<void> {
  if (!reclaimCodes.value.length || actionBusy.value || (mode === 'all' && !confirmReclaimAll.value)) return
  actionBusy.value = true; actionResult.value = ''; reclaimMessage.value = ''
  try {
    reclaimResult.value = await localApi.reclaimTeamCodes(reclaimCodes.value, mode) as Record<string, unknown>
    reclaimMessage.value = `批量查卡处理已提交：${reclaimCodes.value.length} 张卡，处理中 ${numberField(reclaimResult.value, 'queued')} 条，已完成 ${numberField(reclaimResult.value, 'done')} 条。`
  } catch (error) { reclaimMessage.value = error instanceof Error ? error.message : '找回失败。' }
  finally { actionBusy.value = false }
}

async function refreshReclaimProgress(): Promise<void> {
  if (!reclaimCodes.value.length || actionBusy.value) return
  actionBusy.value = true
  try {
    reclaimResult.value = await localApi.reclaimTeamCodes(reclaimCodes.value, '401', true) as Record<string, unknown>
    reclaimMessage.value = '进度已刷新。'
  } catch (error) { reclaimMessage.value = error instanceof Error ? error.message : '刷新进度失败。' }
  finally { actionBusy.value = false }
}

async function downloadReclaimTask(task: ReclaimTask): Promise<void> {
  if (!task.order_no || !task.download_token) return
  actionBusy.value = true
  try {
    const blob = await localApi.downloadTeamOrder(task.order_no, task.download_token)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${task.order_no}.bin`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) { reclaimMessage.value = error instanceof Error ? error.message : '下载失败。' }
  finally { actionBusy.value = false }
}

async function importCodes(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  if (files.length === 0) return
  const contents = await Promise.all(files.map((file) => file.text()))
  reclaimInput.value = parseCodes([reclaimInput.value, ...contents].filter(Boolean).join('\n')).join('\n')
  input.value = ''
}
</script>

<template>
  <section class="team-view">
    <div class="section-heading team-heading">
      <div><h1>Team</h1><p>兑换与凭据找回</p></div>
    </div>

    <div class="team-notice">卡密属于敏感凭据，请勿公开或转发。</div>

    <nav class="team-tabs" aria-label="Team 功能">
      <button type="button" :class="{ active: tab === 'redeem' }" @click="tab = 'redeem'">
        <Box :size="18" />兑换
      </button>
      <button type="button" :class="{ active: tab === 'reclaim' }" @click="tab = 'reclaim'">
        <ShieldCheck :size="18" />401 找回
      </button>
    </nav>

    <section class="team-workflow-bar">
      <div>
        <strong>后台 Team 账号自动处理</strong>
        <span>{{ workflow?.message ?? '正在读取状态…' }}</span>
        <small v-if="workflow?.outputDirectory">保存位置：{{ workflow.outputDirectory }}</small>
        <small v-if="workflowError" class="team-workflow-error">{{ workflowError }}</small>
      </div>
      <div class="team-workflow-counts">
        <span>账号 {{ workflow?.accounts ?? 0 }}</span><span>兑换码 {{ workflow?.codes ?? 0 }}</span><span>已授权 {{ workflow?.reauthorized ?? 0 }}</span><span>已删除 {{ workflow?.deleted ?? 0 }}</span>
      </div>
      <button type="button" :disabled="workflowBusy || workflow?.status === 'running'" @click="startWorkflow">
        {{ workflow?.status === 'running' ? '处理中' : '开始自动处理' }}
      </button>
    </section>

    <section v-if="tab === 'redeem'" class="team-panel">
      <header class="team-panel-header">
        <div><h2><Box :size="19" />兑换登记</h2><p>每行一个兑换码。单个直接兑换，多个自动逐个兑换。</p></div>
        <span>{{ redeemCodes.length > 1 ? '批量' : redeemCodes.length === 1 ? '单个' : '空' }}</span>
      </header>

      <div class="team-field-label">
        <label for="team-redeem-codes">兑换码</label>
        <span>{{ redeemCodes.length }}/2000 个 · {{ redeemLineCount }} 行</span>
      </div>
      <textarea id="team-redeem-codes" v-model="redeemInput" rows="5" placeholder="单个：粘贴一个兑换码&#10;多个：每行一个，自动逐个兑换" @blur="normalizeRedeemInput"></textarea>
      <p class="team-input-status" :class="{ ready: redeemCodes.length > 0 }">
        {{ redeemCodes.length > 0 ? `可兑换 · 已输入 ${redeemCodes.length} 个，可核对额度或直接兑换。` : '待输入 · 每行一个兑换码，重复码自动去除。' }}
      </p>

      <div class="team-format-tabs" aria-label="导出格式">
        <button type="button" :class="{ active: format === 'sub2api' }" @click="format = 'sub2api'">sub2api</button>
        <button type="button" :class="{ active: format === 'cpa' }" @click="format = 'cpa'">cpa</button>
      </div>
      <small>cpa 格式开发中，当前仅支持 sub2api</small>

      <button class="team-primary-action" type="button" :disabled="redeemCodes.length === 0 || format === 'cpa' || actionBusy" @click="redeem">
        <Search :size="18" />核对并兑换
      </button>
      <p v-if="redeemMessage" class="team-reclaim-message">{{ redeemMessage }}</p>

      <div v-if="redeemResult" class="team-redeem-summary">
        <div class="team-redeem-main">
          <span class="team-complete-label">{{ redeemStatus === 'completed' ? '已完成' : redeemStatus === 'unavailable' ? '不可兑换' : '处理中' }}</span>
          <h3>{{ redeemOrder ? `已绑定 ${redeemBound} 个，兑换已提交` : '额度核对完成' }}</h3>
          <p>{{ redeemOrder ? '兑换完成后请及时下载文件。' : '当前兑换码没有可提交的剩余额度。' }}</p>
          <div class="team-redeem-metrics">
            <span>已生成<strong>{{ redeemDelivered }}</strong></span>
            <span>已绑定<strong>{{ redeemBound }}</strong></span>
            <span>总额度<strong>{{ redeemQuota }}</strong></span>
          </div>
          <button v-if="redeemOrderNo && redeemDownloadToken" type="button" :disabled="actionBusy" @click="downloadRedeemOrder"><Download :size="17" />下载文件</button>
        </div>
        <dl>
          <div><dt>兑换码</dt><dd>{{ redeemFirst?.cardCode ?? '-' }}</dd></div>
          <div><dt>格式</dt><dd>{{ format }}</dd></div>
          <div><dt>订单号</dt><dd>{{ redeemOrderNo || '-' }}</dd></div>
          <div><dt>状态</dt><dd><span class="team-status-pill">{{ redeemStatus }}</span></dd></div>
        </dl>
      </div>

      <div v-else class="team-preview-grid">
        <div class="team-preview-empty">
          <span><Search :size="17" />待兑换</span>
          <strong>等待核对额度</strong>
          <p>核对额度不占用额度，兑换结果与下载入口将在此处显示。</p>
          <button type="button" disabled><Download :size="17" />先核对额度</button>
        </div>
        <dl>
          <div><dt>存根</dt><dd>-</dd></div>
          <div><dt>兑换码</dt><dd>-</dd></div>
          <div><dt>格式</dt><dd>{{ format }}</dd></div>
          <div><dt>状态</dt><dd><span class="team-status-pill">待兑换</span></dd></div>
        </dl>
      </div>
    </section>

    <section v-else class="team-panel team-reclaim-panel">
      <header class="team-panel-header">
        <div><h2><Search :size="19" />查询 &amp; 401 找回</h2><p>批量检测凭据状态，并找回失效凭据。</p></div>
      </header>

      <label class="team-dropzone">
        <Upload :size="24" /><strong>拖入 ZIP / TXT，或点击选择文件</strong><span>仅在本机解析文件，不上传文件本体</span>
        <input ref="fileInput" type="file" accept=".txt,.zip,text/plain,application/zip" multiple @change="importCodes" />
      </label>

      <div class="team-field-label">
        <label for="team-reclaim-codes">兑换码</label>
        <span>{{ reclaimCodes.length }}/2000 个 · {{ reclaimLineCount }} 行</span>
      </div>
      <textarea id="team-reclaim-codes" v-model="reclaimInput" rows="6" placeholder="每行粘贴一个兑换码" @blur="normalizeReclaimInput"></textarea>
      <p class="team-input-status" :class="{ ready: reclaimCodes.length > 0 }">已输入 {{ reclaimCodes.length }} 个兑换码</p>

      <button class="team-primary-action team-danger-action" type="button" :disabled="reclaimCodes.length === 0 || actionBusy" @click="reclaim('401')">
        <ShieldCheck :size="18" />检测并找回 401
      </button>
      <div class="team-dual-actions">
        <button type="button" :disabled="reclaimCodes.length === 0 || actionBusy" @click="healthCheck"><ShieldCheck :size="17" />只读检测凭据</button>
        <button type="button" :disabled="reclaimCodes.length === 0 || actionBusy" @click="history"><FileSearch :size="17" />查询兑换状态</button>
      </div>

      <p v-if="reclaimMessage" class="team-reclaim-message">{{ reclaimMessage }}</p>

      <div class="team-progress-placeholder">
        <div><span>处理进度</span><strong>{{ reclaimCompleted }} / {{ reclaimCodes.length }}</strong></div>
        <div class="team-result-counts">
          <span>已更新凭据 <strong>{{ reclaimUpdated }}</strong></span><span>本来正常 <strong>{{ reclaimNormal }}</strong></span><span>等待处理 <strong>{{ reclaimPending }}</strong></span>
        </div>
        <button type="button" :disabled="reclaimCodes.length === 0 || actionBusy" @click="refreshReclaimProgress"><RefreshCw :size="17" />刷新进度</button>
        <button v-for="task in reclaimDownloads" :key="task.order_no" class="team-download-button" type="button" @click="downloadReclaimTask(task)">
          <Download :size="17" />下载 {{ task.order_no }}
        </button>
      </div>

      <section class="team-reclaim-all">
        <div>
          <strong>找回全部（含正常账号）</strong>
          <p>对全部账号执行找回。正常账号原样返回，耗时更久。</p>
        </div>
        <label class="team-confirm-option">
          <input v-model="confirmReclaimAll" type="checkbox" />
          <span class="check-box-outline"></span>
          <span>我确认对全部账号发起找回</span>
        </label>
        <button type="button" :disabled="reclaimCodes.length === 0 || !confirmReclaimAll || actionBusy" @click="reclaim('all')">找回全部</button>
      </section>
    </section>
  </section>
</template>
