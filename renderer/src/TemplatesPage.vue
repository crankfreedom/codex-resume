<script setup lang="ts">
import {ElMessage} from 'element-plus';
import {onMounted,ref} from 'vue';
import {useMonitor} from './store.ts';
import type {PromptTemplate} from '../../src/app/contracts.ts';
const store=useMonitor();const rows=ref<PromptTemplate[]>([]);const draft=ref<PromptTemplate>({id:'',name:'',body:'',isDefault:false});
async function load(){try{rows.value=(await window.resume.query({type:'templates'})).templates ?? [];}catch(error){ElMessage.error((error as Error).message);}}
function edit(row?:PromptTemplate){draft.value=row?{...row}:{id:crypto.randomUUID(),name:'',body:'',isDefault:false};}
async function save(){if(await store.command({type:'templateSave',value:draft.value})){await load();edit();}}
async function remove(id:string){if(await store.command({type:'templateDelete',id}))await load();}
onMounted(()=>{edit();void load();});
</script>
<template><section class="card settings-card"><h2>续跑提示词模板</h2><p>创建任务时复制正文并预览确认。修改、删除或设为默认不会追改已托管任务，也不代表发送授权。</p>
<article v-for="t in rows" :key="t.id"><h3>{{ t.name }} {{ t.isDefault?'（默认）':'' }}</h3><pre>{{ t.body }}</pre><el-button @click="edit(t)">编辑</el-button><el-button @click="remove(t.id)">删除</el-button></article>
<h3>{{ rows.some(t=>t.id===draft.id)?'编辑模板':'新建模板' }}</h3><el-input v-model="draft.name" placeholder="模板名称" :maxlength="100"/><el-input v-model="draft.body" type="textarea" :rows="6" placeholder="模板正文" :maxlength="10000" show-word-limit/><el-checkbox v-model="draft.isDefault">默认模板</el-checkbox><p>预览</p><pre>{{ draft.body || '请输入正文' }}</pre><el-button @click="edit()">新建</el-button><el-button type="primary" :disabled="!draft.name.trim() || !draft.body.trim()" @click="save">保存模板</el-button></section></template>
<style scoped>
article { border-bottom: 1px solid var(--border-subtle); padding: var(--space-row) 0; }
h3 { margin: 12px 0 6px; font-size: var(--font-body); font-weight: 600; }
p { margin: 6px 0; color: var(--text-secondary); font-size: var(--font-secondary); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: var(--font-secondary); line-height: var(--content-line-height); padding: 12px; margin: 8px 0 12px; background: var(--surface-subtle); border: 1px solid var(--border-subtle); border-radius: 8px; }
.el-input, .el-textarea { margin: 6px 0; }
</style>
