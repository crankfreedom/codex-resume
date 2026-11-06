<script setup lang="ts">
import { ref } from 'vue';
import type { ManagedTask,TaskConfig } from '../../src/app/contracts.ts';
import { useMonitor } from './store.ts';
import TaskPolicyFields from './TaskPolicyFields.vue';
const props=defineProps<{task:ManagedTask}>(); const store=useMonitor(); const open=ref(false);
const prompt=ref(''); const max=ref(3); const policy=ref<TaskConfig>(structuredClone({...props.task.config,window:{...props.task.config.window}}));
function edit(){prompt.value=props.task.prompt;max.value=props.task.maxResumes;policy.value=JSON.parse(JSON.stringify(props.task.config));open.value=true;}
async function save(){if(await store.command({type:'edit',id:props.task.id,revision:policy.value.revision,value:{...policy.value,prompt:prompt.value,maxResumes:max.value}}))open.value=false;}
</script>
<template>
<el-button :disabled="task.enabled || task.slotHeld || ['sending','verifying','send_uncertain'].includes(task.phase)" @click="edit">暂停后编辑配置</el-button>
<el-dialog v-model="open" title="编辑托管配置 · 保存后保持暂停" width="580px" append-to-body>
<p>目标固定：{{ task.title }} / {{ task.targetThreadId }}</p><p>累计已使用 {{ task.resumeCount }} 次；本次编辑不重置次数或投递证据。当前修订 {{ task.config.revision }}。</p>
<el-input v-model="prompt" type="textarea" :rows="5" :maxlength="10000"/><p>累计续跑上限</p><el-input-number v-model="max" :min="Math.max(1,task.resumeCount)" :max="20"/>
<TaskPolicyFields v-model="policy"/>
<template #footer><el-button @click="open=false">取消</el-button><el-button type="primary" @click="save">保存并保持暂停</el-button></template>
</el-dialog>
</template>
