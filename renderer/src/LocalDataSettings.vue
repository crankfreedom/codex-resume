<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useMonitor } from './store.ts';
import { formatDataTime, readableEvent } from '../../src/app/event-data.ts';

const store = useMonitor();
const snapshot = computed(() => store.snapshot);
const events = computed(() => snapshot.value?.events ?? []);
const content = computed(() => JSON.stringify(events.value.map(readableEvent), null, 2));
const openDirectory = () => window.resume.openDataDirectory();
const quit = () => window.resume.quit();
async function refresh() {
  if (await store.command({ type: 'refreshData' })) ElMessage.success('本机数据已刷新');
}
async function exportEvents() {
  try { if (await window.resume.exportEvents()) ElMessage.success('事件已导出'); }
  catch (error) { ElMessage.error((error as Error).message); }
}
</script>

<template>
  <section class="card settings-card data-card">
    <h2>本机数据</h2>
    <p>任务、设置、发送意图与事件保存在：</p>
    <code>{{ snapshot?.dataDirectory ?? '正在初始化' }}</code>
    <div class="data-actions">
      <el-button @click="openDirectory">打开数据目录</el-button>
      <el-button :loading="store.busy" @click="refresh">刷新数据</el-button>
      <el-button :disabled="!snapshot || snapshot.runtime.state !== 'running'" @click="exportEvents">导出最近事件</el-button>
      <el-button text type="danger" @click="quit">退出并停止监控</el-button>
    </div>
    <div class="data-preview-heading">
      <h3>最近事件内容 <span>{{ events.length }} 条</span></h3>
      <span v-if="snapshot?.runtime.heartbeatAt" class="muted">快照更新于 {{ formatDataTime(snapshot.runtime.heartbeatAt) }}</span>
    </div>
    <p>自动展示最近 150 条事件，最新在前；刷新数据会重新读取本机记录。时间使用本机时区，格式为 YYYY-MM-DD HH:mm:ss。</p>
    <pre v-if="events.length" class="data-preview" tabindex="0" aria-label="最近事件数据">{{ content }}</pre>
    <div v-else class="small-empty">{{ snapshot?.runtime.state === 'running' ? '暂无事件记录' : '正在等待本机数据' }}</div>
  </section>
</template>

<style scoped>
.data-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.data-actions .el-button { margin-left: 0; }
.data-preview-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.data-preview-heading h3 { margin: 8px 0 0; font-size: var(--font-body); font-weight: 500; }
.data-preview-heading h3 span { color: var(--muted-color, #70838a); font-size: var(--font-secondary); margin-left: 6px; }
.data-preview { max-height: 440px; max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; margin: 14px 0 0; border: 1px solid #e5ecee; border-radius: 7px; background: #f5f7f9; color: #425c66; font-size: var(--font-secondary); line-height: var(--content-line-height); tab-size: 2; }
</style>
