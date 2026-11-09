<script setup lang="ts">
import { onMounted, onUnmounted, toRefs } from 'vue';
import { ElMessage } from 'element-plus';
import { timelineLabels } from '../../src/app/timeline.ts';
import { formatDataTime, readableEvent } from '../../src/app/event-data.ts';
import { useHistory } from './history-store.ts';
import { useLocalData } from './store.ts';
import DataRegion from './DataRegion.vue';
const props = defineProps<{ taskId?: string }>();
const store = useHistory();
const localData = useLocalData();
const key = props.taskId ? `task:${props.taskId}` : 'main';
const session = store.session(key, props.taskId);
const { tab, task, type, reason, from, to, selectedTitle, archives, events, attempts, revisions, next, phases } = toRefs(session);
const { load, logs, timeline } = session;
const time = (n: number | null) => n === null ? '未知' : formatDataTime(n);
async function exportAll() {
  const path = await localData.exportEvents(tab.value === 'timeline' ? { taskId: task.value } : session.filter());
  if (path) ElMessage.success('已导出 ' + path);
}
onMounted(() => void load());
onUnmounted(() => { if (props.taskId) store.release(key); });
</script>
<template>
<section class="card history-page">
  <div class="data-actions"><el-button v-if="!props.taskId" @click="tab='archives';load()">已结束任务</el-button><el-button v-if="!props.taskId" @click="tab='events';load()">检索历史日志</el-button><el-button :loading="session.resource.state.pending" @click="load()">刷新本页（只读）</el-button></div>

  <template v-if="tab==='archives'">
    <h2>历史归档</h2><p>当前任务完成与用户移除分别记录。旧数据缺失显示未知；重新托管需从会话列表核验并确认授权。</p>
  <DataRegion :loading="session.resource.state.pending || (!session.resource.state.loaded && !session.resource.state.error)" :error="session.resource.state.error" label="历史查询结果" @retry="session.retry()">
    <article v-for="a in archives" :key="a.id" class="history-row"><h3>{{ a.title ?? '未知任务名' }} <small>{{ a.incomplete?'历史不完整':'' }}</small></h3><p>{{ a.reason==='current_task_completed'?'当前任务完成':a.reason==='user_removed'?'用户移除托管':'旧记录，结束结果未知' }} · 续跑 {{ a.resumeCount ?? '未知' }} 次</p><p>{{ a.targetThreadId ?? '原会话未知' }}<br>创建 {{ time(a.createdAt) }} · 结束 {{ time(a.endedAt) }}</p><el-button @click="timeline(a.id,a.title ?? '')">查看生命周期时间线</el-button><el-button @click="logs(a.id)">检索该任务日志</el-button></article>
    <p v-if="!archives.length">暂无历史归档</p>
    </DataRegion>
  </template>
  <template v-else>
    <h2>{{ tab==='timeline'?'生命周期时间线':'历史日志检索' }} {{ tab==='timeline'?selectedTitle:'' }}</h2>
    <div v-if="tab==='events'" class="filters"><el-input v-model="task" placeholder="任务 ID（留空含应用事件）"/><el-input v-model="type" placeholder="事件类型（精确匹配）"/><el-input v-model="reason" placeholder="异常原因关键词"/><label>起始（本机时区）<input v-model="from" type="datetime-local"></label><label>结束（不包含）<input v-model="to" type="datetime-local"></label><el-button @click="load()">查询</el-button><el-button :loading="localData.exporting" @click="exportAll">导出全部筛选结果</el-button></div>
  <DataRegion :loading="session.resource.state.pending || (!session.resource.state.loaded && !session.resource.state.error)" :error="session.resource.state.error" label="历史查询结果" @retry="session.retry()">
    <p v-for="r in revisions" :key="r.revision">配置修订 {{ r.revision }} · {{ time(r.time) }} · 变更字段 {{ r.fields.join('、') || '旧版原始配置' }}</p><article v-for="phase in phases" :key="phase.marker" class="history-row"><strong>{{ phase.stage }}</strong><p>额度等待 {{ phase.wait }} · 回执等待 {{ phase.receipt }} · 投递运行 {{ phase.run }}</p></article><el-button v-if="tab==='timeline'" :loading="localData.exporting" @click="exportAll">导出该任务全部事件</el-button><p>每页最多 50 条，最新在前；下页读取更早事件。时间线只陈列已有证据，预计恢复时间不算实际恢复。</p>
    <div v-for="a in attempts" :key="a.marker" class="history-row"><strong>投递周期 {{ a.marker }}</strong><p>配置修订 {{ a.revision }} · {{ a.phase }} · 对应轮次 {{ a.turnId ?? '尚未匹配' }} · 槽位 {{ a.slot }}</p></div>
    <article v-for="(e,index) in events" :key="e.id" class="history-row"><strong>{{ timelineLabels[e.type] ?? e.type }} #{{ e.id }}</strong><p>{{ time(e.time) }} · {{ e.taskName ?? (e.taskId?'任务名未知':'应用') }}</p><p>距本页前一事件：{{ events[index+1] && e.time >= events[index+1]!.time ? ((e.time-events[index+1]!.time)/1000)+' 秒' : '未知（缺少前序证据）' }}</p><p v-if="Number(e.details.checkCount)>1">合并 {{ e.details.checkCount }} 次检查：{{ time(Number(e.details.firstCheckedAt)) }} → {{ time(Number(e.details.lastCheckedAt)) }}</p><details><summary>证据与原因</summary><pre>{{ JSON.stringify(readableEvent(e).details,null,2) }}</pre></details></article>
    <p v-if="!events.length">暂无匹配事件</p>
    </DataRegion>
  </template>
  <el-button :disabled="next===undefined || session.resource.state.pending || !!session.resource.state.error" @click="load(true)">下一页（更早）</el-button>
</section>
</template>
<style scoped>.history-page {padding:var(--space-card);min-width:0;} .data-actions,.filters {display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;} .filters .el-input {width:220px;} .filters label {display:flex;flex-direction:column;gap:6px;} .history-row {padding:var(--space-row) 0;border-bottom:1px solid #e5ecee;overflow-wrap:anywhere;} pre {white-space:pre-wrap;overflow-wrap:anywhere;} .history-row p {margin:4px 0;}</style>
