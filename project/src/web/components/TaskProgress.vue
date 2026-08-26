<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, CircleAlert, Hand, LoaderCircle, Play } from '@lucide/vue'
import type { PublicTask } from '../../shared/contracts'
import { canCancelTaskStage } from '../../shared/task-state'
import { localApi } from '../api'
import AccountResult from './AccountResult.vue'

const props = defineProps<{ task: PublicTask | null }>()
const emit = defineEmits<{ toggleTakeover: [] }>()

const authorizationUrl = ref<string | null>(null)
const authorizationUrlUnavailable = ref(false)

watch(
  () => ({
    taskId: props.task?.id ?? null,
    canInspect: Boolean(props.task?.authorization?.validated),
  }),
  async ({ taskId, canInspect }, _previous, onCleanup) => {
    let superseded = false
    onCleanup(() => {
      superseded = true
    })
    authorizationUrl.value = null
    authorizationUrlUnavailable.value = false
    if (!taskId || !canInspect) return
    try {
      const result = await localApi.taskAuthorizationUrl(taskId)
      if (!superseded) authorizationUrl.value = result.authUrl
    } catch {
      if (!superseded) authorizationUrlUnavailable.value = true
    }
  },
  { immediate: true },
)

const phases = computed(() => [
  { label: '准备', stages: ['validating', 'loading_target_account', 'loading_options', 'checking_existing', 'mail_baseline', 'resolving_proxy'] },
  { label: '获取授权', stages: ['generating_auth_url', 'authorization_url_received'] },
  { label: '打开授权', stages: ['browser_started', 'authorization_url_opened', 'email_submitted'] },
  { label: '登录与授权', stages: ['waiting_for_otp', 'resending_otp', 'waiting_for_otp_retry', 'resending_otp_second', 'waiting_for_otp_third', 'otp_submitted', 'waiting_for_password', 'password_submitted', 'waiting_for_totp', 'totp_submitted', 'waiting_for_consent', 'consent_submitted', 'waiting_for_callback', 'manual_intervention', 'account_deactivated_retrying', 'account_deactivated_confirmed'] },
  {
    label: props.task?.selection.operation === 'reauthorize' ? '更新原账号' : '创建账号',
    stages: props.task?.selection.operation === 'reauthorize'
      ? ['locating_deactivated_account', 'marking_account_banned', 'confirming_account_banned', 'exchanging_code', 'applying_oauth_credentials', 'confirming_reauthorization', 'reauthorization_result_uncertain']
      : ['locating_deactivated_account', 'marking_account_banned', 'confirming_account_banned', 'exchanging_code', 'checking_duplicate', 'creating_account', 'confirming_account', 'create_result_uncertain'],
  },
  { label: '完成', stages: ['completed', 'already_exists'] },
])

const effectiveStage = computed(() => {
  if (!props.task) return null
  if (['failed', 'cancelled', 'interrupted'].includes(props.task.stage)) {
    return props.task.terminalFromStage ?? props.task.error?.stage ?? props.task.stage
  }
  return props.task.stage
})

const currentIndex = computed(() => {
  if (!effectiveStage.value) return -1
  const index = phases.value.findIndex((phase) => phase.stages.includes(effectiveStage.value as never))
  return index >= 0 ? index : 0
})
const canToggleTakeover = computed(() =>
  Boolean(
    props.task?.status === 'active' &&
    props.task.authorization?.browserOpenedAt &&
    props.task.stage !== 'manual_intervention' &&
    canCancelTaskStage(props.task.stage),
  ),
)

const authorizationStatus = computed(() => {
  const authorization = props.task?.authorization
  if (!authorization) return null
  const diagnostics = authorization.diagnostics
  const providerErrorDetected = props.task?.error?.code === 'OAUTH_PROVIDER_ERROR'
  const rows = [
    {
      label: '后台授权链接',
      value: authorization.validated ? '已实时生成并校验' : '历史记录，未按当前完整契约校验',
      complete: authorization.validated,
    },
    { label: '无痕浏览器', value: authorization.browserOpenedAt ? '已启动' : '未启动', complete: Boolean(authorization.browserOpenedAt) },
    {
      label: 'Chrome 首条请求',
      value: authorization.navigationValidated ? '完整参数已核验' : '未核验',
      complete: authorization.navigationValidated,
    },
  ]
  if (diagnostics?.redirect) {
    rows.push({
      label: 'OpenAI 页面',
      value: providerErrorDetected ? '已显示提供方错误页' : `${diagnostics.redirect.origin}${diagnostics.redirect.path}`,
      complete: !providerErrorDetected,
    })
  }
  return rows
})

const deactivationStatus = computed(() => {
  const progress = props.task?.deactivation
  if (!progress) return null
  const result = progress.banResult === 'banned'
    ? '已封号'
    : progress.banResult === 'already_banned'
      ? '原本已封号'
      : progress.banResult === 'no_matching_account'
        ? '无后台账号可标记'
        : progress.banResult === 'ambiguous_match'
          ? '后台账号不唯一'
          : progress.banResult === 'write_rejected'
            ? '写入被拒绝'
            : progress.banResult === 'write_uncertain'
              ? '结果待人工核对'
              : '处理中'
  return [
    { label: '停用检测', value: `${progress.detectedCount} / ${progress.confirmationAttempts ?? 2} 次` },
    { label: '自动重试', value: progress.retryAttempted ? '已执行' : '未执行' },
    { label: '封号结果', value: result },
  ]
})
</script>

<template>
  <section class="progress-panel" aria-labelledby="progress-title">
    <h2 id="progress-title">
      任务进度
    </h2>
    <ol class="progress-list">
      <li
        v-for="(phase, index) in phases"
        :key="phase.label"
        :class="{ active: index === currentIndex, complete: index < currentIndex }"
      >
        <span class="progress-marker">
          <Check v-if="index < currentIndex" :size="15" />
          <CircleAlert v-else-if="index === currentIndex && task?.status === 'error'" :size="15" />
          <LoaderCircle v-else-if="index === currentIndex && task?.status === 'active'" :size="15" class="spin" />
          <span v-else>{{ index + 1 }}</span>
        </span>
        <span class="progress-label">{{ phase.label }}</span>
        <span v-if="index === currentIndex" class="status-badge" :class="task?.status">
          {{ task?.stage === 'manual_intervention' ? '需接管' : task?.status === 'error' ? '失败' : task?.status === 'cancelled' ? '已取消' : task?.status === 'active' ? '进行中' : '完成' }}
        </span>
      </li>
    </ol>
    <button
      v-if="canToggleTakeover"
      class="secondary-button takeover-button"
      :class="{ active: task?.manualTakeover }"
      type="button"
      @click="emit('toggleTakeover')"
    >
      <Play v-if="task?.manualTakeover" :size="17" />
      <Hand v-else :size="17" />
      {{ task?.manualTakeover ? '取消接管' : '人工接管' }}
    </button>
    <p v-if="task" class="task-message" :class="task.status">
      {{ task.message }}
    </p>
    <dl v-if="authorizationStatus" class="authorization-status">
      <div v-for="item in authorizationStatus" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd :class="{ complete: item.complete }">
          {{ item.value }}
        </dd>
      </div>
    </dl>
    <dl v-if="deactivationStatus" class="authorization-status">
      <div v-for="item in deactivationStatus" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>
    <details
      v-if="task?.authorization?.validated"
      class="authorization-url-details"
      :open="task?.error?.code === 'OAUTH_PROVIDER_ERROR'"
    >
      <summary>查看本次完整授权地址</summary>
      <textarea
        v-if="authorizationUrl"
        :value="authorizationUrl"
        aria-label="本次完整授权地址"
        readonly
        spellcheck="false"
      />
      <p v-else-if="authorizationUrlUnavailable" class="authorization-url-unavailable">
        该授权链接已失效，请重新生成。
      </p>
    </details>
    <AccountResult :account="task?.account ?? null" />
  </section>
</template>
