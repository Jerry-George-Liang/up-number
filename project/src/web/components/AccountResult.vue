<script setup lang="ts">
import type { AccountResult } from '../../shared/contracts'

defineProps<{ account: AccountResult | null }>()
</script>

<template>
  <section class="result-section" aria-labelledby="result-title">
    <h3 id="result-title">
      结果预览
    </h3>
    <div class="result-grid result-grid-head">
      <span>账号 ID</span><span>名称</span><span>状态</span>
    </div>
    <div class="result-grid">
      <span>{{ account?.id ?? '—' }}</span>
      <span class="truncate" :title="account?.name">{{ account?.name ?? '—' }}</span>
      <span>{{ account?.status ?? '—' }}</span>
    </div>
  </section>
</template>
