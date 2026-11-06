<script setup lang="ts">
import { computed } from 'vue';
import type { TaskConfig } from '../../src/app/contracts.ts';
const model=defineModel<TaskConfig>({required:true});
const minute=(n:number)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const parse=(s:string)=>Number(s.split(':')[0])*60+Number(s.split(':')[1]);
const start=computed({get:()=>minute(model.value.window.start),set:s=>model.value.window.start=parse(s)});
const end=computed({get:()=>minute(model.value.window.end),set:s=>model.value.window.end=parse(s)});
const expires=computed({get:()=>{if(model.value.expiresAt===null)return '';const d=new Date(model.value.expiresAt);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);},set:s=>model.value.expiresAt=s?new Date(s).getTime():null});
</script>
<template>
<el-form label-position="top" class="policy-fields">
<el-form-item label="授权模式"><el-radio-group v-model="model.mode"><el-radio-button value="auto">自动续跑</el-radio-button><el-radio-button value="observe">仅观察（后台禁止发送）</el-radio-button></el-radio-group></el-form-item>
<el-form-item label="优先级"><el-select v-model="model.priority"><el-option :value="0" label="高"/><el-option :value="1" label="普通"/><el-option :value="2" label="低"/></el-select></el-form-item>
<el-form-item label="托管截止时间（本机时区，留空无截止）"><input v-model="expires" type="datetime-local"></el-form-item>
<el-form-item label="每日允许投递时段（本机时区）"><el-checkbox v-model="model.window.allDay">全天</el-checkbox><span v-if="!model.window.allDay"><input v-model="start" type="time"> 至 <input v-model="end" type="time"></span></el-form-item>
<p>开始包含、结束不包含，可跨午夜；非全天时起止不能相同。到期或时段外仍核对已提交投递。</p>
</el-form>
</template>
<style scoped>
input { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; max-width: 100%; font: inherit; color: var(--text-body); background: #fff; }
p { margin: 6px 0 12px; font-size: var(--font-secondary); color: var(--text-secondary); }
.el-select { width: 160px; }
</style>
