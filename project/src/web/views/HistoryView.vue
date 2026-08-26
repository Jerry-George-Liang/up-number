<script setup lang="ts">
import { ChevronLeft, ChevronRight, CircleCheck, FileText, Trash2 } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { PublicTask } from '../../shared/contracts'

const PAGE_SIZE = 20
const props = defineProps<{ tasks: PublicTask[] }>()
const emit = defineEmits<{ delete: [taskId: string] }>()
const currentPage = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(props.tasks.length / PAGE_SIZE)))
const pageTasks = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return props.tasks.slice(start, start + PAGE_SIZE)
})
const rangeStart = computed(() => props.tasks.length ? (currentPage.value - 1) * PAGE_SIZE + 1 : 0)
const rangeEnd = computed(() => Math.min(currentPage.value * PAGE_SIZE, props.tasks.length))

watch(() => props.tasks.length, () => {
  if (currentPage.value > totalPages.value) currentPage.value = totalPages.value
})

function changePage(offset: number): void {
  currentPage.value = Math.min(totalPages.value, Math.max(1, currentPage.value + offset))
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function authorizationLabel(task: PublicTask): string {
  if (task.authorization?.urlOpenedAt) return '已打开'
  if (task.authorization?.browserOpenedAt) return '浏览器已启动'
  if (task.authorization?.receivedAt) return '地址已获取'
  return '未获取'
}

function deactivationLabel(task: PublicTask): string {
  const progress = task.deactivation
  if (!progress?.confirmed) return ''
  if (progress.banResult === 'banned') return '已封号'
  if (progress.banResult === 'already_banned') return '原本已封号'
  if (progress.banResult === 'no_matching_account') return '已停用，无后台账号'
  if (progress.banResult === 'ambiguous_match') return '已停用，账号不唯一'
  if (progress.banResult === 'write_rejected') return '封号写入被拒绝'
  if (progress.banResult === 'write_uncertain') return '封号结果待核对'
  return '已确认停用'
}

function isBannedTask(task: PublicTask): boolean {
  return (
    task.error?.code === 'OPENAI_ACCOUNT_DEACTIVATED_BANNED' ||
    task.deactivation?.banResult === 'banned' ||
    task.deactivation?.banResult === 'already_banned'
  )
}

function statusLabel(task: PublicTask): string {
  if (isBannedTask(task)) return '封号'
  if (task.status === 'success') return '完成'
  if (task.status === 'active') return '进行中'
  if (task.status === 'cancelled') return '已取消'
  return '失败'
}
</script>

<template>
  <section class="history-view" aria-labelledby="history-title">
    <div class="section-heading">
      <h1 id="history-title">
        任务记录
      </h1>
      <span class="muted-count">{{ tasks.length }} 条</span>
    </div>
    <div v-if="tasks.length" class="table-scroll">
      <table class="history-table">
        <colgroup>
          <col class="history-col-time"><col class="history-col-operation"><col class="history-col-email">
          <col class="history-col-duplicate"><col class="history-col-authorization"><col class="history-col-status">
          <col class="history-col-result"><col class="history-col-actions">
        </colgroup>
        <thead>
          <tr>
            <th>开始时间</th><th>任务类型</th><th>账号邮箱</th><th>重复创建</th><th>授权</th><th>状态</th><th>结果</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in pageTasks" :key="task.id">
            <td>{{ formatTime(task.createdAt) }}</td>
            <td>{{ task.selection.operation === 'reauthorize' ? '重新授权' : '添加账号' }}</td>
            <td class="email-cell" :title="task.accountEmail">
              {{ task.accountEmail }}
            </td>
            <td>{{ task.selection.operation === 'create' ? (task.selection.allowDuplicateCreation ? '允许' : '拦截') : '—' }}</td>
            <td>{{ authorizationLabel(task) }}</td>
            <td><span class="status-badge" :class="isBannedTask(task) ? 'banned' : task.status">{{ statusLabel(task) }}</span></td>
            <td class="history-result-cell" :title="task.deactivation?.confirmed ? deactivationLabel(task) : task.account ? '成功' : task.message">
              <span v-if="task.deactivation?.confirmed" class="result-danger">{{ deactivationLabel(task) }}</span>
              <span v-else-if="task.account" class="result-success"><CircleCheck :size="16" />成功</span>
              <span v-else>{{ task.message }}</span>
            </td>
            <td>
              <button class="icon-button" type="button" title="删除本地记录" :disabled="task.status === 'active'" @click="emit('delete', task.id)">
                <Trash2 :size="17" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="tasks.length" class="pagination-row history-pagination">
      <span>显示第 {{ rangeStart }}–{{ rangeEnd }} 条，共 {{ tasks.length }} 条</span>
      <div v-if="totalPages > 1" class="history-pagination-controls">
        <button class="icon-button" type="button" title="上一页" :disabled="currentPage <= 1" @click="changePage(-1)">
          <ChevronLeft :size="19" />
        </button>
        <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
        <button class="icon-button" type="button" title="下一页" :disabled="currentPage >= totalPages" @click="changePage(1)">
          <ChevronRight :size="19" />
        </button>
      </div>
    </div>
    <div v-else class="empty-state">
      <FileText :size="28" /><span>暂无任务记录</span>
    </div>
  </section>
</template>
