<script setup lang="ts">
import type { CreateTaskInput, OptionsSnapshot, PublicTask } from '../../shared/contracts'
import { canCancelTaskStage } from '../../shared/task-state'
import TaskForm from '../components/TaskForm.vue'
import TaskProgress from '../components/TaskProgress.vue'
import type { TaskFormState } from '../state'

defineProps<{
  form: TaskFormState
  options: OptionsSnapshot | null
  authenticated: boolean
  task: PublicTask | null
  busy: boolean
}>()

const emit = defineEmits<{
  start: [input: CreateTaskInput]
  cancel: []
  toggleTakeover: []
  accountEmailCommitted: []
  credentialsChanged: []
}>()
</script>

<template>
  <div class="task-workspace">
    <section class="task-main" aria-labelledby="task-title">
      <div class="section-heading">
        <h1 id="task-title">
          添加账号
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
      <TaskForm
        :form="form"
        :options="options"
        :authenticated="authenticated"
        :busy="busy"
        @submit="(input) => emit('start', input)"
        @account-email-committed="emit('accountEmailCommitted')"
        @credentials-changed="emit('credentialsChanged')"
      />
    </section>
    <TaskProgress :task="task" @toggle-takeover="emit('toggleTakeover')" />
  </div>
</template>
