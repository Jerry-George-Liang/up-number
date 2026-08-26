<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowLeft, ArrowLeftRight, Eye, EyeOff, KeyRound, Link, LockKeyhole, LogIn, LogOut, Pencil, Plus, RefreshCw, Save, Trash2, Unplug, X } from '@lucide/vue'
import type { DeactivationSettings, MailboxTrustSettings } from '../../shared/contracts'
import type {
  AccountPoolPortalConnectInput,
  AccountPoolPortalStatus,
  PendingTotpLogin,
  PoolConnectionMode,
  ProvisioningAgentStatus,
  PublicBackendSession,
} from '../api'

const props = defineProps<{
  session: PublicBackendSession
  pendingTotp: PendingTotpLogin | null
  mailboxTrustSettings: MailboxTrustSettings | null
  deactivationSettings: DeactivationSettings | null
  provisioningAgent: ProvisioningAgentStatus | null
  accountPoolPortal: AccountPoolPortalStatus | null
  poolConnectionMode: PoolConnectionMode | null
  mailboxSettingsLocked: boolean
  busy: boolean
  poolConnectionOperationBusy: boolean
  modeSwitchDisabled: boolean
}>()
const emit = defineEmits<{
  login: [email: string, password: string, clearPassword: () => void]
  completeTotp: [attemptId: string, code: string, clearCode: () => void]
  cancelPendingLogin: []
  logout: []
  saveMailboxTrustSettings: [customPathOrigins: string[], onSaved: () => void]
  saveDeactivationSettings: [confirmationAttempts: number]
  pairProvisioningAgent: [input: { centralOrigin: string; pairingCode: string; deviceName: string }]
  changeProvisioningAgentOrigin: [centralOrigin: string, onSaved: () => void]
  disconnectProvisioningAgent: []
  connectAccountPoolPortal: [input: AccountPoolPortalConnectInput, onSaved: () => void]
  disconnectAccountPoolPortal: []
  switchPoolConnectionMode: [mode: PoolConnectionMode]
}>()

const email = ref('')
const password = ref('')
const totpCode = ref('')
const showPassword = ref(false)
const newMailboxOrigin = ref('')
const centralOrigin = ref('')
const accountPoolOrigin = ref('http://192.168.50.207:3000')
const pairingCode = ref('')
const deviceName = ref('Mac 执行助手')
const changingCentralOrigin = ref(false)
const changingAccountPoolOrigin = ref(false)
const deactivationAttemptsDraft = ref('2')
watch(
  () => props.deactivationSettings?.confirmationAttempts,
  (value) => {
    if (value !== undefined) deactivationAttemptsDraft.value = String(value)
  },
  { immediate: true },
)
const deactivationAttempts = computed(() => Number(deactivationAttemptsDraft.value))
const canSaveDeactivationSettings = computed(() =>
  Number.isInteger(deactivationAttempts.value) &&
  deactivationAttempts.value >= 1 &&
  deactivationAttempts.value <= 10 &&
  deactivationAttempts.value !== props.deactivationSettings?.confirmationAttempts &&
  !props.mailboxSettingsLocked &&
  !props.busy,
)
const canLogin = computed(() => Boolean(email.value.trim() && password.value && !props.busy))
const canVerifyTotp = computed(() => /^\d{6}$/.test(totpCode.value) && !props.busy)
const canAddMailboxOrigin = computed(
  () =>
    Boolean(newMailboxOrigin.value.trim()) &&
    (props.mailboxTrustSettings?.customPathOrigins.length ?? 20) < 20 &&
    !props.mailboxSettingsLocked &&
    !props.busy,
)
const canPairAgent = computed(
  () => Boolean(centralOrigin.value.trim() && pairingCode.value.trim() && deviceName.value.trim() && !props.busy),
)
const canChangeCentralOrigin = computed(
  () =>
    Boolean(centralOrigin.value.trim()) &&
    centralOrigin.value.trim() !== props.provisioningAgent?.centralOrigin &&
    !props.provisioningAgent?.runningTask &&
    !props.busy,
)
const canConnectAccountPool = computed(
  () => Boolean(accountPoolOrigin.value.trim()) && !props.poolConnectionOperationBusy,
)
const accountPoolStatusLabel = computed(() => {
  const portal = props.accountPoolPortal
  if (!portal?.configured) return '尚未连接纯号池系统'
  if (portal.connected) return '纯号池网页已登录，数据已连接'
  if (!portal.lastError) return '等待检查号池网页状态'
  if (
    ['ACCOUNT_POOL_LOGIN_REQUIRED', 'ACCOUNT_POOL_PAGE_NOT_READY', 'ACCOUNT_POOL_BROWSER_CLOSED']
      .includes(portal.lastError.code)
  ) {
    return '等待号池网页登录'
  }
  return '号池网页连接异常'
})
const nextPoolConnectionMode = computed<PoolConnectionMode>(() =>
  props.poolConnectionMode === 'provisioning_agent' ? 'account_pool' : 'provisioning_agent',
)

function clearPassword() {
  password.value = ''
  showPassword.value = false
}

function clearCode() {
  totpCode.value = ''
}

function submitLogin() {
  if (!canLogin.value) return
  emit('login', email.value, password.value, clearPassword)
}

function submitTotp() {
  if (!canVerifyTotp.value || !props.pendingTotp) return
  emit('completeTotp', props.pendingTotp.attemptId, totpCode.value, clearCode)
}

function cancelTotp() {
  clearCode()
  emit('cancelPendingLogin')
}

function addMailboxOrigin() {
  if (!canAddMailboxOrigin.value || !props.mailboxTrustSettings) return
  emit(
    'saveMailboxTrustSettings',
    [...props.mailboxTrustSettings.customPathOrigins, newMailboxOrigin.value],
    () => {
      newMailboxOrigin.value = ''
    },
  )
}

function removeMailboxOrigin(origin: string) {
  if (props.mailboxSettingsLocked || props.busy || !props.mailboxTrustSettings) return
  emit(
    'saveMailboxTrustSettings',
    props.mailboxTrustSettings.customPathOrigins.filter((item) => item !== origin),
    () => undefined,
  )
}

function pairAgent() {
  if (!canPairAgent.value) return
  emit('pairProvisioningAgent', {
    centralOrigin: centralOrigin.value.trim(),
    pairingCode: pairingCode.value.trim(),
    deviceName: deviceName.value.trim(),
  })
  pairingCode.value = ''
}

function startChangingCentralOrigin() {
  if (!props.provisioningAgent?.paired || props.provisioningAgent.runningTask || props.busy) return
  centralOrigin.value = props.provisioningAgent.centralOrigin ?? ''
  changingCentralOrigin.value = true
}

function cancelChangingCentralOrigin() {
  changingCentralOrigin.value = false
  centralOrigin.value = ''
}

function changeCentralOrigin() {
  if (!canChangeCentralOrigin.value) return
  emit('changeProvisioningAgentOrigin', centralOrigin.value.trim(), cancelChangingCentralOrigin)
}

function startChangingAccountPoolOrigin() {
  if (props.busy) return
  accountPoolOrigin.value = props.accountPoolPortal?.origin ?? 'http://192.168.50.207:3000'
  changingAccountPoolOrigin.value = true
}

function cancelChangingAccountPoolOrigin() {
  changingAccountPoolOrigin.value = false
  accountPoolOrigin.value = props.accountPoolPortal?.origin ?? 'http://192.168.50.207:3000'
}

function connectAccountPool() {
  if (!canConnectAccountPool.value) return
  const input = {
    origin: accountPoolOrigin.value.trim(),
  }
  emit(
    'connectAccountPoolPortal',
    input,
    () => {
      changingAccountPoolOrigin.value = false
    },
  )
}

function recheckAccountPool() {
  if (props.busy || !props.accountPoolPortal?.origin) return
  emit('connectAccountPoolPortal', {
    origin: props.accountPoolPortal.origin,
    foreground: false,
    reuseOnly: true,
  }, () => undefined)
}

function switchPoolConnectionMode() {
  if (!props.poolConnectionMode || props.modeSwitchDisabled) return
  cancelChangingAccountPoolOrigin()
  cancelChangingCentralOrigin()
  emit('switchPoolConnectionMode', nextPoolConnectionMode.value)
}

onBeforeUnmount(() => {
  clearPassword()
  clearCode()
})
</script>

<template>
  <section class="settings-view" aria-labelledby="settings-title">
    <div class="section-heading">
      <h1 id="settings-title">
        设置
      </h1>
    </div>
    <div class="settings-grid">
    <div class="settings-band">
      <div class="settings-status">
        <span class="status-dot" :class="{ connected: session.authenticated }"></span>
        <div>
          <strong>{{ session.authenticated ? '后台会话已连接' : '后台会话未连接' }}</strong>
          <span>{{ session.email || 'coding.tu-zi.com' }}</span>
        </div>
        <button v-if="session.authenticated" class="secondary-button" type="button" :disabled="busy" @click="emit('logout')">
          <LogOut :size="17" />退出
        </button>
      </div>

      <form v-if="!session.authenticated && !pendingTotp" class="settings-form" @submit.prevent="submitLogin">
        <div class="settings-field">
          <label for="backend-email">后台登录邮箱</label>
          <input
            id="backend-email"
            v-model="email"
            type="email"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            required
          />
        </div>
        <div class="settings-field">
          <label for="backend-password">后台登录密码</label>
          <div class="password-wrap">
            <input
              id="backend-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              required
            />
            <button class="password-toggle" type="button" :title="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">
              <EyeOff v-if="showPassword" :size="18" /><Eye v-else :size="18" />
            </button>
          </div>
        </div>
        <button class="primary-button" type="submit" :disabled="!canLogin">
          <LogIn :size="18" />登录后台
        </button>
      </form>

      <form v-else-if="!session.authenticated && pendingTotp" class="settings-form totp-form" @submit.prevent="submitTotp">
        <div class="totp-heading">
          <KeyRound :size="19" />
          <div>
            <strong>输入动态验证码</strong>
            <span>{{ pendingTotp.maskedEmail || '当前后台账号' }}</span>
          </div>
        </div>
        <div class="settings-field">
          <label for="backend-totp">六位验证码</label>
          <input
            id="backend-totp"
            v-model="totpCode"
            class="totp-input"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            pattern="[0-9]{6}"
            required
          />
        </div>
        <div class="settings-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="cancelTotp">
            <ArrowLeft :size="17" />返回登录
          </button>
          <button class="primary-button" type="submit" :disabled="!canVerifyTotp">
            <KeyRound :size="18" />验证并登录
          </button>
        </div>
      </form>
    </div>

    <div class="settings-band deactivation-settings-band">
      <div class="settings-subheading">
        <div>
          <h2>自动封号确认</h2>
          <span>{{ mailboxSettingsLocked ? '任务运行中，设置已锁定' : '连续检测到账号停用后标记封号' }}</span>
        </div>
      </div>
      <form class="deactivation-settings-form" @submit.prevent="emit('saveDeactivationSettings', deactivationAttempts)">
        <label for="deactivation-confirmation-attempts">确认次数</label>
        <input
          id="deactivation-confirmation-attempts"
          v-model="deactivationAttemptsDraft"
          type="number"
          inputmode="numeric"
          min="1"
          max="10"
          step="1"
          :disabled="mailboxSettingsLocked || busy || !deactivationSettings"
        />
        <span>次</span>
        <button class="secondary-button" type="submit" :disabled="!canSaveDeactivationSettings">
          <Save :size="17" />保存
        </button>
      </form>
      <p class="settings-help">
        默认 2 次，至少 1 次。设置为 1 次时，首次明确返回 account_deactivated 后直接进入封号处理。
      </p>
    </div>

    <div class="settings-band mailbox-settings-band">
      <div class="settings-subheading">
        <div>
          <h2>可信邮箱服务</h2>
          <span>{{ mailboxSettingsLocked ? '任务运行中，设置已锁定' : '路径式收件链接' }}</span>
        </div>
        <span v-if="mailboxTrustSettings" class="settings-count">
          {{ mailboxTrustSettings.customPathOrigins.length }}/20
        </span>
      </div>

      <div v-if="mailboxTrustSettings && !mailboxTrustSettings.configurationValid" class="settings-inline-error" role="alert">
        自定义配置无法读取，当前仅使用内置邮箱服务。
      </div>

      <div v-if="mailboxTrustSettings" class="trusted-origin-list">
        <div v-for="origin in mailboxTrustSettings.builtInPathOrigins" :key="`built-in:${origin}`" class="trusted-origin-row">
          <LockKeyhole :size="17" aria-hidden="true" />
          <span class="truncate" :title="origin">{{ origin }}</span>
          <span class="origin-kind">内置</span>
        </div>
        <div v-for="origin in mailboxTrustSettings.customPathOrigins" :key="origin" class="trusted-origin-row">
          <span class="status-dot connected" aria-hidden="true"></span>
          <span class="truncate" :title="origin">{{ origin }}</span>
          <button
            class="icon-button compact-icon-button"
            type="button"
            title="删除可信邮箱服务"
            :disabled="mailboxSettingsLocked || busy"
            @click="removeMailboxOrigin(origin)"
          >
            <Trash2 :size="17" />
          </button>
        </div>
      </div>
      <div v-else class="settings-loading">
        正在读取可信邮箱服务
      </div>

      <form class="mailbox-origin-form" @submit.prevent="addMailboxOrigin">
        <input
          v-model="newMailboxOrigin"
          type="text"
          inputmode="url"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          placeholder="域名或 HTTPS 地址"
          :disabled="mailboxSettingsLocked || busy || !mailboxTrustSettings"
        />
        <button class="primary-button" type="submit" :disabled="!canAddMailboxOrigin">
          <Plus :size="18" />添加
        </button>
      </form>
    </div>
    </div>

    <div class="settings-band pool-connection-settings-band">
      <div class="settings-subheading pool-connection-heading">
        <div>
          <h2>{{ poolConnectionMode === 'provisioning_agent' ? '中央号池执行助手' : '纯号池系统' }}</h2>
          <span>
            {{ poolConnectionMode === 'provisioning_agent'
              ? '任务只会在这台 Mac 上打开无痕 Chrome'
              : '只连接账号池数据，不包含上号系统或执行设备' }}
          </span>
        </div>
        <button
          class="secondary-button pool-mode-switch-button"
          type="button"
          :disabled="modeSwitchDisabled || !poolConnectionMode"
          @click="switchPoolConnectionMode"
        >
          <ArrowLeftRight :size="17" />
          {{ poolConnectionMode === 'provisioning_agent' ? '切换到纯号池' : '切换到中央执行助手' }}
        </button>
      </div>

      <template v-if="poolConnectionMode === 'account_pool'">
        <div v-if="accountPoolPortal" class="settings-status account-pool-status">
          <span class="status-dot" :class="{ connected: accountPoolPortal.connected }"></span>
          <div>
            <strong>
              {{ accountPoolStatusLabel }}
            </strong>
            <span v-if="accountPoolPortal.origin">{{ accountPoolPortal.origin }}</span>
            <span v-else>填写号池地址后打开网页并检查登录状态</span>
          </div>
          <div v-if="accountPoolPortal.configured" class="agent-status-actions">
            <button
              v-if="accountPoolPortal.connected"
              class="secondary-button"
              type="button"
              :disabled="poolConnectionOperationBusy"
              @click="recheckAccountPool"
            >
              <RefreshCw :size="17" />重新检查
            </button>
            <button class="secondary-button" type="button" :disabled="busy" @click="startChangingAccountPoolOrigin">
              <Pencil :size="17" />更换地址
            </button>
            <button class="secondary-button" type="button" :disabled="busy" @click="emit('disconnectAccountPoolPortal')">
              <Unplug :size="17" />断开
            </button>
          </div>
        </div>

        <div v-if="accountPoolPortal?.lastError" class="settings-inline-error" role="alert">
          {{ accountPoolPortal.lastError.message }}
        </div>

        <form
          v-if="accountPoolPortal && (!accountPoolPortal.connected || changingAccountPoolOrigin)"
          class="settings-form account-pool-origin-form"
          @submit.prevent="connectAccountPool"
        >
          <div class="settings-field">
            <label for="account-pool-origin">号池系统地址</label>
            <input
              id="account-pool-origin"
              v-model="accountPoolOrigin"
              type="url"
              inputmode="url"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="http://192.168.50.207:3000"
              :disabled="busy"
              required
            />
          </div>
          <div class="settings-actions">
            <button
              v-if="accountPoolPortal.configured"
              class="secondary-button"
              type="button"
              :disabled="poolConnectionOperationBusy"
              @click="cancelChangingAccountPoolOrigin"
            >
              <X :size="17" />取消
            </button>
            <button class="primary-button" type="submit" :disabled="!canConnectAccountPool">
              <RefreshCw :size="17" />打开并检查网页状态
            </button>
          </div>
        </form>
      </template>

      <template v-else-if="poolConnectionMode === 'provisioning_agent'">
        <div v-if="provisioningAgent" class="settings-status agent-status">
          <span class="status-dot" :class="{ connected: provisioningAgent.connected }"></span>
          <div>
            <strong>
              {{ provisioningAgent.paired ? (provisioningAgent.connected ? '已连接中央号池' : '已配对，等待连接') : '尚未配对' }}
            </strong>
            <span v-if="provisioningAgent.paired">
              {{ provisioningAgent.deviceName }} · {{ provisioningAgent.centralOrigin }}
            </span>
            <span v-else>从中央号池生成一次性配对码后在此连接</span>
          </div>
          <div v-if="provisioningAgent.paired" class="agent-status-actions">
            <button
              class="secondary-button"
              type="button"
              :disabled="busy || provisioningAgent.runningTask"
              @click="startChangingCentralOrigin"
            >
              <Pencil :size="17" />更换地址
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="busy || provisioningAgent.runningTask"
              @click="emit('disconnectProvisioningAgent')"
            >
              <Unplug :size="17" />断开
            </button>
          </div>
        </div>

        <div v-if="provisioningAgent?.lastError" class="settings-inline-error" role="alert">
          {{ provisioningAgent.lastError.message }}
        </div>

        <form
          v-if="provisioningAgent?.paired && changingCentralOrigin"
          class="settings-form agent-origin-form"
          @submit.prevent="changeCentralOrigin"
        >
          <div class="settings-field">
            <label for="replacement-central-origin">中央号池地址</label>
            <input
              id="replacement-central-origin"
              v-model="centralOrigin"
              type="url"
              inputmode="url"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              placeholder="http://192.168.50.218:3001"
              :disabled="busy || provisioningAgent.runningTask"
              required
            />
          </div>
          <div class="settings-actions">
            <button class="secondary-button" type="button" :disabled="busy" @click="cancelChangingCentralOrigin">
              <X :size="17" />取消
            </button>
            <button class="primary-button" type="submit" :disabled="!canChangeCentralOrigin">
              <Save :size="17" />验证并更换
            </button>
          </div>
        </form>

        <form v-if="provisioningAgent && !provisioningAgent.paired" class="settings-form" @submit.prevent="pairAgent">
          <div class="settings-field">
            <label for="central-origin">中央号池地址</label>
            <input id="central-origin" v-model="centralOrigin" type="url" placeholder="http://192.168.50.218:3001" required />
          </div>
          <div class="settings-field">
            <label for="pairing-code">一次性配对码</label>
            <input id="pairing-code" v-model="pairingCode" type="text" autocomplete="off" required />
          </div>
          <div class="settings-field">
            <label for="device-name">设备名称</label>
            <input id="device-name" v-model="deviceName" type="text" maxlength="80" required />
          </div>
          <button class="primary-button" type="submit" :disabled="!canPairAgent">
            <Link :size="18" />连接中央号池
          </button>
        </form>
      </template>
    </div>
  </section>
</template>
