<script setup lang="ts">
import { computed } from 'vue';
import { useMonitor } from './store.ts';
import { formatDataTime } from '../../src/app/event-data.ts';
const props = defineProps<{ taskId?: string }>();
const store = useMonitor();
const report = computed(()=>store.snapshot?.inspection);
const rows = computed(()=>[{key:'liveHeartbeat',label:'当前监控心跳',status:store.snapshot?.runtime.state==='running' && Date.now()-(store.snapshot?.runtime.heartbeatAt ?? 0)<12000?'pass' as const:'blocked' as const,reason:store.snapshot?.runtime.state ?? '未启动',advice:'心跳不代表额度已刷新；离线时检查监控进程',checkedAt:store.snapshot?.runtime.heartbeatAt ?? null},...(report.value?.checks.filter(c=>c.key!=='worker') ?? []),...(props.taskId ? report.value?.tasks[props.taskId] ?? [] : [])]);
const labels = { pass:'通过', blocked:'阻断', unknown:'未知', unchecked:'未检查', na:'不适用' };
</script>
<template>
<section class="inspection">
  <h3>为什么没续跑 · 连接与兼容性自检</h3>
  <el-button :loading="store.busy" @click="store.command({type:'selfCheck'})">运行只读自检</el-button>
  <p>只读检查不会推进投递。后台原有监控仍独立运行。</p>
  <p v-if="report">读取于 {{ formatDataTime(report.checkedAt) }} · {{ Date.now()-report.checkedAt > (store.snapshot?.settings.pollSeconds ?? 15)*1000 ? '已过期' : '仅代表此时结果' }}；通过不代表当前可发送。</p>
  <p v-else>未检查：运行只读自检查看连接、额度和指定目标。</p>
  <article v-for="row in rows" :key="row.key" class="check-row">
    <strong>{{ row.label }} · {{ labels[row.status] }}</strong><p>{{ row.reason }}</p><small>{{ row.advice }} · {{ row.checkedAt ? formatDataTime(row.checkedAt) : '未检查' }}</small>
  </article>
</section>
</template>
<style scoped>.inspection { margin:20px 0; overflow-wrap:anywhere; } .check-row {padding:10px 0;border-bottom:1px solid #e5ecee;} p {margin:8px 0;} small {color:var(--muted-color,#70838a);}</style>
