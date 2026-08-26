<script setup lang="ts">
defineProps<{
  id: string
  label: string
  modelValue: string | number | null
  options: Array<{ value: string | number; label: string; disabled?: boolean }>
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string | number | null] }>()

function update(event: globalThis.Event) {
  const raw = (event.target as globalThis.HTMLSelectElement).value
  emit('update:modelValue', raw === '' ? null : /^-?\d+$/.test(raw) ? Number(raw) : raw)
}
</script>

<template>
  <div class="field-row">
    <label :for="id">{{ label }}</label>
    <div class="select-wrap">
      <select :id="id" :value="modelValue ?? ''" :disabled="disabled" @change="update">
        <option v-if="placeholder" value="">
          {{ placeholder }}
        </option>
        <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">
          {{ option.label }}
        </option>
      </select>
    </div>
  </div>
</template>
