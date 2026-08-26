<script setup lang="ts">
import type { LoginMaterialSource } from '../../shared/contracts'
import type { TaskLoginMode } from '../state'

interface LoginMaterialForm {
  materialSource: LoginMaterialSource
  loginMode: TaskLoginMode
  accountEmail: string
  mailboxAccess: string
  accountPassword: string
  totpSecret: string
}

const props = withDefaults(
  defineProps<{
    form: LoginMaterialForm
    disabled?: boolean
    emailReadonly?: boolean
    emailPlaceholder?: string
    idPrefix?: string
  }>(),
  {
    disabled: false,
    emailReadonly: false,
    emailPlaceholder: '请输入账号邮箱',
    idPrefix: 'task',
  },
)

const emit = defineEmits<{
  accountEmailCommitted: []
  credentialsChanged: []
}>()
const form = props.form

const loginModes: Array<{ value: TaskLoginMode; label: string }> = [
  { value: 'email_otp', label: '邮箱验证码' },
  { value: 'password_totp', label: '密码 + 2FA' },
]
const materialSources: Array<{ value: LoginMaterialSource; label: string }> = [
  { value: 'account_pool', label: '账号池自动获取' },
  { value: 'manual', label: '手动备用' },
]

function setLoginMode(mode: TaskLoginMode) {
  form.loginMode = mode
}

function setMaterialSource(source: LoginMaterialSource) {
  form.materialSource = source
}
</script>

<template>
  <div class="field-row field-row-start">
    <span class="field-label">登录材料</span>
    <div class="segmented-control login-mode-control" role="group" aria-label="登录材料来源">
      <button
        v-for="source in materialSources"
        :key="source.value"
        type="button"
        :class="{ active: form.materialSource === source.value }"
        :aria-pressed="form.materialSource === source.value"
        :disabled="disabled"
        @click="setMaterialSource(source.value)"
      >
        {{ source.label }}
      </button>
    </div>
  </div>

  <div v-if="form.materialSource === 'manual'" class="field-row field-row-start">
    <span class="field-label">手动登录方式</span>
    <div class="segmented-control login-mode-control" role="group" aria-label="登录方式">
      <button
        v-for="mode in loginModes"
        :key="mode.value"
        type="button"
        :class="{ active: form.loginMode === mode.value }"
        :aria-pressed="form.loginMode === mode.value"
        :disabled="disabled"
        @click="setLoginMode(mode.value)"
      >
        {{ mode.label }}
      </button>
    </div>
  </div>

  <div class="field-row">
    <label :for="`${idPrefix}-account-email`">账号邮箱</label>
    <input
      :id="`${idPrefix}-account-email`"
      v-model.trim="form.accountEmail"
      type="email"
      :readonly="emailReadonly"
      :disabled="disabled"
      :autocomplete="emailReadonly ? 'off' : 'email'"
      :placeholder="emailPlaceholder"
      required
      @change="emit('accountEmailCommitted')"
    />
  </div>

  <div v-if="form.materialSource === 'manual' && form.loginMode === 'email_otp'" class="field-row">
    <label :for="`${idPrefix}-mailbox-access`">邮箱取件密码 / 接口链接</label>
    <div class="field-control-stack">
      <input
        :id="`${idPrefix}-mailbox-access`"
        v-model="form.mailboxAccess"
        type="password"
        autocomplete="off"
        data-1p-ignore="true"
        placeholder="请输入取件密码或完整邮箱接口链接"
        :disabled="disabled"
        required
        @input="emit('credentialsChanged')"
      />
      <span class="field-help">可填写取件密码，或粘贴受支持邮箱服务的完整收件链接</span>
    </div>
  </div>

  <div v-if="form.materialSource === 'manual' && form.loginMode === 'password_totp'" class="field-row">
    <label :for="`${idPrefix}-account-password`">账号密码</label>
    <input
      :id="`${idPrefix}-account-password`"
      v-model="form.accountPassword"
      type="password"
      autocomplete="off"
      data-1p-ignore="true"
      placeholder="请输入账号密码"
      :disabled="disabled"
      required
      @input="emit('credentialsChanged')"
    />
  </div>

  <div v-if="form.materialSource === 'manual' && form.loginMode === 'password_totp'" class="field-row">
    <label :for="`${idPrefix}-totp-secret`">2FA 密钥</label>
    <input
      :id="`${idPrefix}-totp-secret`"
      v-model="form.totpSecret"
      type="password"
      autocomplete="off"
      data-1p-ignore="true"
      placeholder="请输入 2FA 密钥"
      :disabled="disabled"
      required
      @input="emit('credentialsChanged')"
    />
  </div>
</template>
