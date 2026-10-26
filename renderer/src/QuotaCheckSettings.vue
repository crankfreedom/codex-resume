<script setup lang="ts">
import type { QuotaCheckSettings } from '../../src/app/quota-schedule.ts';

const settings = defineModel<QuotaCheckSettings>({ required: true });
defineProps<{ nextCheckAt: number | null }>();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>

<template>
  <div class="quota-check-settings">
    <h2>额度恢复检查</h2>
    <el-radio-group v-model="settings.mode" aria-label="额度查询模式">
      <el-radio value="recovery">按预计恢复时间</el-radio>
      <el-radio value="fixed">固定时间间隔</el-radio>
    </el-radio-group>
    <p v-if="settings.mode === 'recovery'">额度耗尽且返回有效恢复时间时，等到预计恢复时间加缓冲后再查。例如还有 3 小时恢复、缓冲 1 分钟，就在 3 小时 1 分钟后复查。</p>
    <p v-else>无论额度是否耗尽，都按下方固定间隔查询。实际执行时间还受请求耗时与约两秒的后台调度影响。</p>
    <div class="quota-option">
      <label for="quota-check-interval">{{ settings.mode === 'fixed' ? '固定查询间隔' : '常规与兜底间隔' }}</label>
      <el-input-number id="quota-check-interval" v-model="settings.intervalSeconds" :min="10" :max="3600" :step="10" />
      <span>秒</span>
    </div>
    <p v-if="settings.mode === 'recovery'">额度可用、数据未知或恢复时间缺失／已过期时，使用此间隔继续查询。</p>
    <div v-if="settings.mode === 'recovery'" class="quota-option">
      <label for="quota-recovery-delay">恢复后缓冲</label>
      <el-input-number id="quota-recovery-delay" v-model="settings.recoveryDelayMinutes" :min="0" :max="60" />
      <span>分钟</span>
    </div>
    <div class="quota-option">
      <label id="quota-daily-label">每日 00:10 额外检查</label>
      <el-switch v-model="settings.dailyResetCheck" aria-labelledby="quota-daily-label" />
    </div>
    <p>按本机时区 {{ timezone }} 执行，两种模式都支持；用于检查可能提前发生的重置。到点仍需查询确认，不能直接认定额度恢复。休眠错过后会在恢复运行时补查。</p>
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
