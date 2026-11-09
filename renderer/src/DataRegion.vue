<script setup lang="ts">
withDefaults(defineProps<{ loading?: boolean; error?: string; label: string; size?: 'small' | 'normal' }>(), { size: 'normal' });
defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="data-region" :class="`data-region--${size}`" :aria-busy="!!loading" :aria-label="label">
    <div v-if="loading" class="region-loading" role="status">
      <span class="region-spinner" aria-hidden="true"></span><span>正在加载{{ label }}…</span>
      <div class="region-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
    </div>
    <div v-else-if="error" class="region-error" role="alert"><p>{{ label }}读取失败：{{ error }}</p><el-button @click="$emit('retry')">重试</el-button></div>
    <div v-show="!loading && !error" class="region-content"><slot></slot></div>
  </div>
</template>

<style scoped>
.data-region { min-width: 0; width: 100%; }
.region-loading,.region-error { min-height: 160px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 18px; color: var(--text-secondary); font-size: var(--font-secondary); text-align: center; overflow-wrap: anywhere; }
.data-region--small .region-loading,.data-region--small .region-error { min-height: 96px; }
.region-spinner { width: 22px; height: 22px; border: 2px solid var(--accent-border); border-top-color: var(--accent); border-radius: 50%; animation: region-spin .8s linear infinite; }
.region-skeleton { width: min(100%, 320px); display: grid; gap: 8px; }
.region-skeleton i { height: 8px; background: var(--accent-soft); border-radius: 4px; animation: region-pulse 1.4s ease-in-out infinite alternate; }
.region-skeleton i:last-child { width: 65%; }
.region-error p { margin: 0; }
@keyframes region-spin { to { transform: rotate(360deg); } }
@keyframes region-pulse { to { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .region-spinner,.region-skeleton i { animation: none; } }
</style>
