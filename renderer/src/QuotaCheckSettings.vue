<script setup lang="ts">
import type { QuotaCheckSettings } from '../../src/app/quota-schedule.ts';

const settings = defineModel<QuotaCheckSettings>({ required: true });
defineProps<{ nextCheckAt: number | null }>();
</script>

<template>
  <div class="quota-check-settings">
    <h2>额度恢复检查</h2>
    <p>定期查询额度，默认每 10 分钟检查一次。实际执行时间还受请求耗时与约两秒的后台调度影响。</p>
    <div class="quota-option">
      <label for="quota-check-interval">检查间隔</label>
      <el-input-number id="quota-check-interval" v-model="settings.intervalSeconds" :min="10" :max="3600" :step="10" />
      <span>秒</span>
    </div>
    <p>默认 600 秒（10 分钟），允许 10–3600 秒。额度耗尽、可用或未知时均使用此间隔；预计恢复时间仅作展示。启动时立即查询，休眠错过检查后恢复运行时补查。</p>
    <p class="quota-next" aria-live="polite">已保存配置的下次额度查询：<strong>{{ nextCheckAt ? new Date(nextCheckAt).toLocaleString('zh-CN', { hour12: false }) : '等待首次查询' }}</strong></p>
    <p>与下方监控参数一起点击“保存设置”生效。</p>
  </div>
</template>

<style scoped>
.quota-check-settings > p { color: var(--text-secondary); font-size: var(--font-secondary); line-height: var(--content-line-height); margin: 10px 0 18px; }
.quota-option { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 18px 0; font-size: var(--font-body); }
.quota-option > label { min-width: 170px; font-weight: 500; }
.quota-option .el-input-number { width: 150px; }
.quota-check-settings .quota-next { background: var(--accent-soft); padding: 12px 15px; border-radius: 7px; }
.quota-next strong { color: var(--accent-ink); overflow-wrap: anywhere; }
</style>
