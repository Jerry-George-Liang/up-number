<script setup lang="ts">
import { computed } from 'vue'
import { Check, CheckCheck, LockKeyhole, Play, RotateCcw } from '@lucide/vue'
import type {
  Concurrency,
  CreateTaskInput,
  OptionsSnapshot,
  ProxyChoice,
} from '../../shared/contracts'
import { isSubscriptionAvailable, type SubscriptionOption } from '../../shared/contracts'
import {
  canStartTask,
  toCreateTaskInput,
  toggleAllGroupIds,
  type TaskFormState,
} from '../state'
import OptionSelect from './OptionSelect.vue'
import LoginMaterialFields from './LoginMaterialFields.vue'

const props = defineProps<{
  form: TaskFormState
  options: OptionsSnapshot | null
  authenticated: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  submit: [input: CreateTaskInput]
  accountEmailCommitted: []
  credentialsChanged: []
}>()

const form = props.form
const proxyModes: Array<{ value: ProxyChoice['mode']; label: string }> = [
  { value: 'none', label: '不使用代理' },
  { value: 'fixed', label: '指定固定代理' },
  { value: 'random_fixed', label: '随机固定代理' },
  { value: 'dynamic', label: '动态订阅' },
]
const concurrencyOptions: Array<{ value: Concurrency; label: string }> = (
  [1, 3, 5, 10, 20] as const
).map((value) => ({ value, label: String(value) }))
const canSubmit = computed(() => canStartTask(form, props.authenticated, props.options, props.busy))
const selectedGroupCount = computed(() => form.groupIds.length)
const allGroupsSelected = computed(() => {
  const groups = props.options?.groups ?? []
  return groups.length > 0 && groups.every((group) => form.groupIds.includes(group.id))
})

function setProxyMode(mode: ProxyChoice['mode']) {
  form.proxyMode = mode
  if (mode !== 'fixed') form.fixedProxyId = null
  if (mode !== 'dynamic') form.subscriptionId = null
}

function toggleGroup(id: number) {
  form.groupIds = form.groupIds.includes(id)
    ? form.groupIds.filter((selectedId) => selectedId !== id)
    : [...form.groupIds, id]
}

function clearGroups() {
  form.groupIds = []
}

function toggleAllGroups() {
  form.groupIds = toggleAllGroupIds(form.groupIds, props.options?.groups ?? [])
}

function subscriptionLabel(subscription: SubscriptionOption): string {
  if (subscription.nodeCount === undefined || subscription.healthyNodeCount === undefined) return subscription.name
  return `${subscription.name} (${subscription.healthyNodeCount}/${subscription.nodeCount})`
}

function submit() {
  emit('accountEmailCommitted')
  emit('credentialsChanged')
  if (!canSubmit.value) return
  emit('submit', toCreateTaskInput(form))
}
</script>

<template>
  <form class="task-form" @submit.prevent="submit">
    <LoginMaterialFields
      :form="form"
      @account-email-committed="emit('accountEmailCommitted')"
      @credentials-changed="emit('credentialsChanged')"
    />

    <div class="field-row field-row-start">
      <span class="field-label">代理类型</span>
      <div class="segmented-control" role="group" aria-label="代理类型">
        <button
          v-for="mode in proxyModes"
          :key="mode.value"
          type="button"
          :class="{ active: form.proxyMode === mode.value }"
          :aria-pressed="form.proxyMode === mode.value"
          @click="setProxyMode(mode.value)"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>

    <OptionSelect
      v-if="form.proxyMode === 'fixed'"
      id="fixed-proxy"
      v-model="form.fixedProxyId"
      label="固定代理"
      placeholder="请选择固定代理"
      :options="(options?.proxies ?? []).map((item) => ({ value: item.id, label: item.name }))"
    />
    <OptionSelect
      v-if="form.proxyMode === 'dynamic'"
      id="dynamic-subscription"
      v-model="form.subscriptionId"
      label="动态订阅"
      placeholder="请选择动态订阅"
      :options="(options?.subscriptions ?? []).map((item) => ({
        value: item.id,
        label: subscriptionLabel(item),
        disabled: !isSubscriptionAvailable(item),
      }))"
    />

    <div class="field-row field-row-start">
      <span class="field-label">并发数</span>
      <div class="segmented-control concurrency-control" role="group" aria-label="并发数">
        <button
          v-for="option in concurrencyOptions"
          :key="option.value"
          type="button"
          :class="{ active: form.concurrency === option.value }"
          :aria-pressed="form.concurrency === option.value"
          @click="form.concurrency = option.value"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
    <OptionSelect
      id="supplier"
      v-model="form.supplier"
      label="供应商（可选）"
      placeholder="不选择供应商"
      :options="(options?.suppliers ?? []).map((item) => ({ value: item, label: item }))"
    />

    <div class="field-row field-row-start">
      <div class="field-label-block">
        <span class="field-label">分组（可选）</span>
        <span class="field-help">{{ selectedGroupCount ? `已选 ${selectedGroupCount} 个` : '可多选' }}</span>
      </div>
      <div class="group-picker" aria-label="分组">
        <div v-if="options?.groups.length" class="group-picker-actions">
          <button class="group-selection-button" type="button" @click="toggleAllGroups">
            <RotateCcw v-if="allGroupsSelected" :size="14" />
            <CheckCheck v-else :size="14" />
            {{ allGroupsSelected ? '取消全选' : '全选分组' }}
          </button>
          <button v-if="selectedGroupCount && !allGroupsSelected" class="group-selection-button" type="button" @click="clearGroups">
            <RotateCcw :size="14" />清空分组
          </button>
        </div>
        <div v-if="!(options?.groups.length)" class="option-empty">
          暂无可用分组
        </div>
        <label v-for="group in options?.groups ?? []" :key="group.id" class="check-option">
          <input
            type="checkbox"
            :checked="form.groupIds.includes(group.id)"
            @change="toggleGroup(group.id)"
          />
          <span class="check-box check-box-outline"><Check :size="14" /></span>
          <span class="check-option-label">{{ group.name }}</span>
        </label>
      </div>
    </div>

    <div class="field-row">
      <span class="field-label">允许重复创建</span>
      <label class="switch-control">
        <input v-model="form.allowDuplicateCreation" type="checkbox" role="switch" />
        <span class="switch-track"><span class="switch-thumb"></span></span>
        <span class="switch-label">{{ form.allowDuplicateCreation ? '已开启' : '已关闭' }}</span>
      </label>
    </div>

    <div class="field-row">
      <span class="field-label">确认混合渠道风险</span>
      <label class="switch-control">
        <input v-model="form.confirmMixedChannelRisk" type="checkbox" role="switch" />
        <span class="switch-track"><span class="switch-thumb"></span></span>
        <span class="switch-label">{{ form.confirmMixedChannelRisk ? '已确认' : '未确认' }}</span>
      </label>
    </div>

    <div class="field-row locked-setting">
      <span></span>
      <div class="locked-setting-value">
        <span class="check-box"><Check :size="16" /></span>
        <LockKeyhole :size="17" />
        <span>清除所有模型（必选）</span>
      </div>
    </div>

    <div class="field-row form-actions">
      <span></span>
      <button class="primary-button" type="submit" :disabled="!canSubmit">
        <Play :size="18" fill="currentColor" />
        {{ busy ? '任务运行中' : '开始任务' }}
      </button>
    </div>
  </form>
</template>
