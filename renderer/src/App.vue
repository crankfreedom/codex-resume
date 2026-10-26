<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMonitor } from './store.ts';
import ManualPage from './ManualPage.vue';
import AppearanceSettings from './AppearanceSettings.vue';
import QuotaCheckSettings from './QuotaCheckSettings.vue';
import { version as appVersion } from '../../package.json';
import { defaultSettings } from '../../src/app/contracts.ts';
import logoUrl from '../../resources/icons/logo.png?url';
import type { ManagedTask, Settings, ThreadSummary } from '../../src/app/contracts.ts';

const store = useMonitor();
const page = ref('overview');
const search = ref('');
const now = ref(Date.now());
const selected = ref<ThreadSummary | null>(null);
const detailId = ref<string | null>(null);
const prompt = ref('继续完成本会话中用户已授权且尚未完成的任务。先检查当前进度，接着推进剩余工作；遵守原会话的约束和审批要求。完成后汇报结果。');
const maxResumes = ref(3);
const consent = ref(false);
const settings = ref<Settings>({ ...defaultSettings, quotaCheck: { ...defaultSettings.quotaCheck }, appearance: { ...defaultSettings.appearance } });
const s = computed(() => store.snapshot);
const tasks = computed(() => s.value?.tasks ?? []);
const detail = computed(() => tasks.value.find(t => t.id === detailId.value));
const active = computed(() => tasks.value.filter(t => t.enabled));
const waiting = computed(() => active.value.filter(t => t.phase === 'waiting_quota'));
const attention = computed(() => tasks.value.filter(t => ['suspended', 'send_uncertain'].includes(t.phase)));
const threads = computed(() => (s.value?.threads ?? []).filter(t => `${t.title} ${t.cwd}`.toLowerCase().includes(search.value.toLowerCase())));
const phaseLabels: Record<string, string> = { observing: '观察中', waiting_quota: '等待额度', sending: '正在投递', verifying: '核对续跑', completed: '已完成', suspended: '需要处理', send_uncertain: '发送待核对' };
const eventLabels: Record<string, string> = {
  worker_started: '监控进程启动', worker_stopped: '监控进程停止', monitoring_enabled: '已开启托管', monitoring_paused: '已暂停托管',
  desktop_disconnected: 'Codex 连接中断', desktop_reconnected: 'Codex 已重新连接', observing_completed_session: '会话空闲，继续观察',
  quota_stop_detected: '检测到服务端额度错误', quota_checked: '已复查真实额度', send_intent_persisted: '发送意图已落盘',
  resume_submitted: '已向原会话提交续跑', completed: '续跑已完成', suspended: '托管停止', send_uncertain: '发送结果不确定',
  settings_updated: '设置已保存', task_removed: '已移除托管记录', read_retry: '读取失败，等待重试', next_quota_cycle: '等待下一轮额度恢复',
};
const reasonLabels: Record<string, string> = {
  awaiting_actual_quota_event: '尚未出现真实额度错误，保持观察', quota_unknown: '额度信息不完整', quota_blocked: '额度尚未恢复', quota_available: '额度可用',
  manual_activity_or_approval: '检测到人工操作或审批等待', thread_changed_since_block: '等待期间会话已产生新轮次',
  account_changed: '账号已变化，请重新确认托管', last_turn_not_quota_failure: '最新轮次不是额度错误',
  approval_or_input_pending: '等待用户输入或审批', send_response_uncertain: '发送响应未确定，请只核对回执',
  restart_during_send: '进程在发送期间重启，请核对回执', receipt_not_found_no_automatic_resend: '未找到回执，自动补发已停止',
  resumed_turn_failed_or_interrupted: '续跑失败、被中断或已达到续跑上限', no_longer_quota_failure: '目标已不再因额度停止',
  monitoring_paused_before_send: '发送前托管已暂停', thread_identity_changed: '目标会话身份变化',
};
const reason = (value?: string) => value ? reasonLabels[value] ?? value : '';
const time = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const remaining = (used?: number | null) => typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.round(100 - used)) : null;
const until = (value?: number | null) => {
  if (!value) return '恢复时间未知';
  const minutes = Math.ceil((value * 1000 - now.value) / 60000);
  return minutes <= 0 ? '已到预计时间，等待复查' : minutes < 60 ? `${minutes} 分钟后恢复`
    : minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后恢复` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后恢复`;
};
const heartbeat = computed(() => s.value?.runtime.state === 'running' && now.value - (s.value.runtime.heartbeatAt ?? 0) < 12000);
const headings: Record<string, [string, string]> = {
  overview: ['运行总览', '额度恢复后，让未完成的任务继续向前。'], tasks: ['托管任务', '选择原会话，按你确认的规则等待与续跑。'],
  events: ['运行记录', '每次额度检查、状态变化与续跑都有迹可循。'], settings: ['应用设置', '配置本机监控与桌面行为。'],
  guide: ['使用说明', '了解数据从哪里来、何时更新，以及每一次自动续跑的条件。'],
};
const navItems = [{ id: 'overview', icon: '◫', name: '运行总览' }, { id: 'tasks', icon: '▤', name: '托管任务' }, { id: 'events', icon: '≡', name: '运行记录' }, { id: 'settings', icon: '⚙', name: '应用设置' }, { id: 'guide', icon: '?', name: '使用说明' }];
watch(page, async value => {
  if (value === 'settings' && s.value) settings.value = { ...s.value.settings, quotaCheck: { ...s.value.settings.quotaCheck } };
  await nextTick(); window.scrollTo({ top: 0 });
});
watch(() => store.error, value => { if (value) ElMessage.error(value); });
let timer: ReturnType<typeof setInterval>;
onMounted(() => { void store.start(); timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { clearInterval(timer); store.stop(); });
function choose(thread: ThreadSummary) { selected.value = thread; consent.value = false; }
async function add() {
  if (!selected.value || !consent.value) return;
  if (await store.command({ type: 'add', targetThreadId: selected.value.id, prompt: prompt.value, maxResumes: maxResumes.value })) {
    selected.value = null; ElMessage.success('已开始托管；仅在真实额度错误后自动续跑');
  }
}
async function remove(task: ManagedTask) {
  try {
    await ElMessageBox.confirm('移除本地托管记录，事件日志会保留。', '移除托管', { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' });
    await store.command({ type: 'remove', id: task.id });
  } catch { /* 用户取消 */ }
}
async function exportEvents() {
  try { if (await window.resume.exportEvents()) ElMessage.success('事件已导出'); }
  catch (e) { ElMessage.error((e as Error).message); }
}
async function saveSettings() {
  const appearance = { ...(s.value?.settings.appearance ?? defaultSettings.appearance) };
  if (await store.command({ type: 'settings', value: { ...settings.value, appearance } })) ElMessage.success('设置已保存');
}
const openDirectory = () => window.resume.openDataDirectory();
const quit = () => window.resume.quit();
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><img class="brand-symbol brand-image" :src="logoUrl" alt="Codex Resume Logo"><div>Codex Resume<small>本地任务续跑助手</small></div></div>
      <div class="nav-caption">工作空间</div>
      <nav><button v-for="item in navItems" :key="item.id" :class="{ selected: page === item.id }" @click="page = item.id"><span>{{ item.icon }}</span>{{ item.name }}<b v-if="item.id === 'tasks' && active.length">{{ active.length }}</b></button></nav>
      <div class="sidebar-bottom"><div class="local-badge"><span class="dot" :class="{ good: heartbeat }"></span>{{ heartbeat ? '监控进程运行中' : '监控进程未就绪' }}</div><p>数据仅保存在本机<br>关闭窗口后可在托盘继续运行</p><div class="version">DESKTOP <span>v{{ appVersion }}</span></div></div>
    </aside>
    <main>
      <header><div><div class="eyebrow">CODEX / {{ page === 'settings' ? 'PREFERENCES' : 'WORKSPACE' }}</div><h1>{{ headings[page]?.[0] }}</h1><p>{{ headings[page]?.[1] }}</p></div><div class="header-actions"><span class="connection-pill" :class="{ connected: s?.connection.state === 'connected' }"><i class="dot"></i>{{ s?.connection.state === 'connected' ? 'Codex 已连接' : s?.connection.state === 'connecting' ? '连接中' : 'Codex 未连接' }}</span><el-button :loading="store.busy" @click="store.command({ type: 'refresh' })">↻ 刷新</el-button></div></header>
      <div v-if="s?.connection.state === 'disconnected'" class="connection-alert"><span>连接等待</span>{{ s.connection.message }}<small>请保持 Codex 桌面 App 打开；应用会自动重连。</small></div>
      <div v-if="!heartbeat && s?.runtime.state === 'stopped'" class="connection-alert">{{ s.runtime.message }}。监控已停止，发送中的任务会等待核对。</div>

      <template v-if="page === 'overview'">
        <section class="quota-grid">
          <article v-for="(label, index) in ['5 小时额度', '每周额度']" :key="label" class="card quota-card"><div class="card-label">{{ label }}<span>剩余可用</span></div><div class="quota-value">{{ remaining(s?.quota?.windows[index]?.usedPercent) ?? '—' }}<span v-if="remaining(s?.quota?.windows[index]?.usedPercent) !== null">%</span></div><el-progress :percentage="remaining(s?.quota?.windows[index]?.usedPercent) ?? 0" :show-text="false" :stroke-width="7" :color="(remaining(s?.quota?.windows[index]?.usedPercent) ?? 0) < 15 ? '#db8d37' : '#138575'" /><div class="quota-foot">{{ s?.quota ? until(s.quota.windows[index]?.resetsAt) : '等待服务端额度信息' }}<span>{{ s?.quota?.windows[index]?.resetsAt ? time(s.quota.windows[index]!.resetsAt! * 1000).slice(5) : '' }}</span></div></article>
          <article class="card status-card"><div class="card-label">当前托管<span class="tiny-tag">LIVE</span></div><div class="quota-value">{{ active.length }}<span>个会话</span></div><div class="status-breakdown"><span><i class="dot good"></i>{{ active.length - waiting.length }} 观察 / 核对</span><span><i class="dot amber"></i>{{ waiting.length }} 等待额度</span></div><p>最近检查 {{ time(s?.connection.checkedAt).split(' ')[1] ?? '—' }}</p></article>
        </section>
        <div class="section-heading"><h2>托管中的会话 <span>{{ active.length }}</span></h2><button class="text-button" @click="page = 'tasks'">管理任务 →</button></div>
        <section class="card task-section"><div v-if="!active.length" class="empty"><div class="empty-icon">↻</div><h3>把等待的时间交给这里</h3><p>选择一个 Codex 会话。因额度停止时自动等待，<br>服务端确认恢复后，在原会话继续。</p><el-button type="primary" @click="page = 'tasks'">＋ 选择会话托管</el-button></div><div v-for="task in active" :key="task.id" class="task-row"><div class="task-avatar">C</div><div class="task-main"><h3>{{ task.title }}</h3><p>{{ task.targetThreadId.slice(0, 18) }}… · 已续跑 {{ task.resumeCount }} / {{ task.maxResumes }} 次</p></div><span class="phase" :class="task.phase">{{ phaseLabels[task.phase] }}</span><el-button text @click="detailId = task.id">详情</el-button><el-button @click="store.command({ type: 'toggle', id: task.id, enabled: false })">暂停托管</el-button></div></section>
        <div class="lower-grid"><section class="card flow-card"><div class="section-heading"><h2>自动续跑如何工作</h2><span class="muted">原会话 · 本地执行</span></div><div class="flow"><div><b>01</b><strong>识别额度停止</strong><small>读取服务端错误</small></div><i>→</i><div><b>02</b><strong>等待真实恢复</strong><small>同时检查两类额度</small></div><i>→</i><div><b>03</b><strong>原会话续跑</strong><small>保存意图并核对回执</small></div></div></section><section class="card attention-card"><h2>需要关注 <span>{{ attention.length }}</span></h2><p v-if="!attention.length">暂无需要处理的任务</p><button v-for="task in attention.slice(0, 2)" :key="task.id" class="attention-item" @click="detailId = task.id">{{ task.title }}<small>{{ reason(task.reason) }}</small></button><small class="muted">人工操作、审批等待与不确定发送会停止托管。</small></section></div>
        <div class="footnote">本地运行 · 服务端额度复查 · 仅恢复用户授权的原会话</div>
      </template>

      <template v-if="page === 'tasks'">
        <section class="card managed-card"><div class="section-heading"><h2>托管记录 <span>{{ tasks.length }}</span></h2><small class="muted">暂停托管只停止本应用检查，不会中断 Codex</small></div><div v-if="!tasks.length" class="small-empty">还没有托管记录，从下方选择会话开始。</div><div v-for="task in tasks" :key="task.id" class="task-row"><div class="task-avatar">C</div><div class="task-main"><h3>{{ task.title }}</h3><p>{{ task.enabled ? reason(task.reason) || '按规则观察原会话' : '托管已停止' }} · 续跑 {{ task.resumeCount }} / {{ task.maxResumes }}</p><small v-if="task.lastError" class="error-text">{{ task.lastError }}</small></div><span class="phase" :class="task.phase">{{ !task.enabled && !['completed','suspended','send_uncertain'].includes(task.phase) ? '已暂停' : phaseLabels[task.phase] }}</span><el-button text @click="detailId = task.id">详情</el-button><el-button v-if="!['completed','suspended','send_uncertain'].includes(task.phase)" :loading="store.busy" @click="store.command({ type: 'toggle', id: task.id, enabled: !task.enabled })">{{ task.enabled ? '暂停托管' : '继续托管' }}</el-button><el-button v-if="!task.enabled" text @click="remove(task)">移除</el-button></div></section>
        <div class="section-heading"><h2>从 Codex 选择会话</h2><el-input v-model="search" placeholder="搜索会话名称或目录" clearable class="search" /></div><section class="card thread-list"><div v-if="!threads.length" class="empty compact"><div class="empty-icon">▤</div><h3>{{ s?.connection.state === 'connected' ? '没有匹配的本机会话' : '连接 Codex 后显示会话' }}</h3><p>显示本机最近 50 条及置顶会话，可通过顶部刷新更新。</p></div><div v-for="thread in threads" :key="thread.id" class="thread-row"><div class="task-avatar subtle">↗</div><div class="task-main"><h3>{{ thread.title }}</h3><p>{{ thread.cwd || thread.id }}</p></div><span class="muted thread-status">{{ thread.status === 'active' ? '运行中' : thread.status === 'idle' ? '空闲' : thread.status }}</span><el-button :disabled="tasks.some(t => t.targetThreadId === thread.id && t.enabled) || store.busy" @click="choose(thread)">{{ tasks.some(t => t.targetThreadId === thread.id && t.enabled) ? '已托管' : '托管会话' }}</el-button></div></section>
      </template>

      <template v-if="page === 'events'"><div class="section-heading"><h2>最近事件 <span>{{ s?.events.length ?? 0 }}</span></h2><el-button @click="exportEvents">导出 JSONL</el-button></div><section class="card event-list"><div v-if="!s?.events.length" class="small-empty">暂无运行记录</div><div v-for="event in s?.events" :key="event.id" class="event-row"><span class="event-dot" :class="event.type"></span><div><h3>{{ eventLabels[event.type] ?? event.type }}<code>#{{ event.id }}</code></h3><p>{{ event.taskId ? tasks.find(t => t.id === event.taskId)?.title ?? event.taskId.slice(0, 8) : '应用' }}<span v-if="event.details.reason"> · {{ reason(String(event.details.reason)) }}</span></p><details><summary>查看详情</summary><pre>{{ JSON.stringify(event.details, null, 2) }}</pre></details></div><time>{{ time(event.time) }}</time></div></section><p class="footnote">显示最近 150 条事件；完整事件和发送记录保存在本机 SQLite 数据库中。</p></template>

      <template v-if="page === 'settings'"><AppearanceSettings /><section class="card settings-card"><QuotaCheckSettings v-model="settings.quotaCheck" :next-check-at="s?.nextQuotaCheckAt ?? null" /></section><section class="card settings-card"><h2>监控与桌面</h2><div class="setting-row"><div><strong>任务检查间隔</strong><p>刷新会话列表并检查托管状态；额度查询使用上方独立策略。</p></div><el-input-number v-model="settings.pollSeconds" :min="10" :max="300" :step="5" /><span>秒</span></div><div class="setting-row"><div><strong>桌面通知</strong><p>额度停止、续跑提交、完成或需要处理时通知。</p></div><el-switch v-model="settings.notifications" /></div><div class="setting-row"><div><strong>关闭窗口后保留托盘</strong><p>从托盘选择“退出并停止监控”才会结束进程。</p></div><el-switch v-model="settings.closeToTray" /></div><h2 class="advanced-title">连接参数 <small>通常无需填写</small></h2><el-form label-position="top"><el-form-item label="调用会话 ID"><el-input v-model="settings.callerThreadId" placeholder="留空：从本机 Codex 会话索引自动发现" /></el-form-item><el-form-item label="桌面工具管道"><el-input v-model="settings.pipe" placeholder="留空：自动发现唯一的 Codex 桌面管道" /></el-form-item></el-form><p class="muted">连接依赖当前 Codex 桌面版本的内部工具桥接；升级后若不兼容，应用会停止发送并显示错误。</p><el-button type="primary" :loading="store.busy" @click="saveSettings">保存设置</el-button></section><section class="card settings-card data-card"><h2>本机数据</h2><p>任务、设置、发送意图与事件保存在：</p><code>{{ s?.dataDirectory ?? '正在初始化' }}</code><div><el-button @click="openDirectory">打开数据目录</el-button><el-button @click="exportEvents">导出最近事件</el-button><el-button text type="danger" @click="quit">退出并停止监控</el-button></div></section></template>
      <ManualPage v-if="page === 'guide'" :snapshot="s" />
    </main>

    <el-dialog :model-value="!!selected" title="托管原会话" width="600px" @close="selected = null"><div class="dialog-target"><span class="task-avatar">C</span><div><strong>{{ selected?.title }}</strong><small>{{ selected?.id }}</small></div></div><el-form label-position="top"><el-form-item label="额度恢复后发送的续跑提示词"><el-input v-model="prompt" type="textarea" :rows="5" :maxlength="10000" show-word-limit /></el-form-item><el-form-item label="最多自动续跑次数"><el-input-number v-model="maxResumes" :min="1" :max="20" /><span class="input-help">再次遇到额度错误时继续等待，正常完成后结束。</span></el-form-item></el-form><div class="consent-box"><el-checkbox v-model="consent">允许本应用在该会话因真实额度错误停止后自动发送上述提示词。</el-checkbox><p>运行中与普通完成不会触发发送；人工恢复、审批等待或发送不确定时停止托管。</p></div><template #footer><el-button @click="selected = null">取消</el-button><el-button type="primary" :disabled="!consent || !prompt.trim()" :loading="store.busy" @click="add">确认并开始托管</el-button></template></el-dialog>
    <el-drawer :model-value="!!detail" title="托管详情" size="480px" @close="detailId = null"><template v-if="detail"><h2>{{ detail.title }}</h2><p><span class="phase" :class="detail.phase">{{ phaseLabels[detail.phase] }}</span></p><dl class="detail-list"><dt>原会话</dt><dd>{{ detail.targetThreadId }}</dd><dt>托管状态</dt><dd>{{ detail.enabled ? '已开启' : '已停止' }}</dd><dt>说明</dt><dd>{{ reason(detail.reason) || '按规则观察中' }}</dd><dt>续跑次数</dt><dd>{{ detail.resumeCount }} / {{ detail.maxResumes }}</dd><dt>创建时间</dt><dd>{{ time(detail.createdAt) }}</dd><dt>最近变化</dt><dd>{{ time(detail.updatedAt) }}</dd><dt v-if="detail.phase === 'waiting_quota'">下次额度检查</dt><dd v-if="detail.phase === 'waiting_quota'">{{ time(detail.nextCheckAt) }}</dd><dt>续跑提示词</dt><dd class="prompt-content">{{ detail.prompt }}</dd><dt>已记录的真实证据</dt><dd>额度错误：{{ detail.evidence.serverLimitObserved ? '是' : '否' }}<br>阻断额度：{{ detail.evidence.serverQuotaBlockedObserved ? '是' : '否' }}<br>恢复快照：{{ detail.evidence.serverRecoveryObserved ? '是' : '否' }}<br>原会话完成回执：{{ detail.evidence.sameThreadReply ? '是' : '否' }}</dd></dl><el-button v-if="detail.phase === 'send_uncertain'" type="primary" :loading="store.busy" @click="store.command({ type: 'reconcile', id: detail.id }).then(() => detailId = null)">只核对回执，不重新发送</el-button><p v-if="detail.lastError" class="error-text">{{ detail.lastError }}</p></template></el-drawer>
  </div>
</template>
