<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useMonitor } from './store.ts';
import { formatDataTime } from '../../src/app/event-data.ts';
import { formatInTimeZone, inputInTimeZone, zonedDateTimeToEpoch } from '../../src/app/reset-time.ts';
import type { ResetAppointmentView } from '../../src/app/reset-cards.ts';

const store = useMonitor();
const cards = computed(() => store.snapshot?.resetCards.cards ?? []);
const info = computed(() => store.snapshot?.resetCards);
const available = computed(() => cards.value.filter(card => card.status === 'available'));
const tab = ref('cards');
const appointments = ref<ResetAppointmentView[]>([]);
const selectedKey = ref('');
const timeZone = ref('Asia/Shanghai');
const localTime = ref(inputInTimeZone(Date.now() + 3600000, 'Asia/Shanghai'));
const timeZones = ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Europe/London', 'America/New_York'];

const selectedCard = computed(() => available.value.find(card => card.key === selectedKey.value));
const pending = computed(() => appointments.value.filter(appointment => ['pending', 'running', 'uncertain'].includes(appointment.status)));
const records = computed(() => appointments.value.filter(appointment => appointment.status !== 'pending'));
const statusLabels: Record<ResetAppointmentView['status'], string> = {
  pending: '待执行', running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消', missed: '已错过', uncertain: '结果不确定',
};
const statusClass: Record<ResetAppointmentView['status'], string> = {
  pending: 'waiting_quota', running: 'sending', succeeded: 'completed', failed: 'suspended', cancelled: 'suspended', missed: 'suspended', uncertain: 'send_uncertain',
};
const reasonLabels: Record<string, string> = {
  cancelled_by_user: '用户取消', restart_missed: '程序退出或休眠错过执行时间', execution_missed: '错过执行时间，不自动补用',
  account_changed: '账号已切换，禁止沿用旧账号执行', credit_unavailable: '指定卡片状态不可用', credit_expired: '指定卡片已到期',
  credit_details_unavailable: '最新明细缺少指定卡片，禁止替换', preflight_failed: '执行前检查失败，未发起兑换',
  response_uncertain: '兑换响应不确定，请使用原请求 ID 核对', nothingToReset: '服务端返回当前没有可重置的额度窗口', noCredit: '服务端返回没有可用卡片',
};
const reason = (value?: string | null) => value ? reasonLabels[value] ?? value : '';
const statusText = (value: string) => statusLabels[value as ResetAppointmentView['status']] ?? value;
const statusKind = (value: string) => statusClass[value as ResetAppointmentView['status']] ?? '';
async function load() {
  appointments.value = (await window.resume.query({ type: 'resetAppointments' })).resetAppointments ?? [];
}
async function refresh() {
  if (await store.command({ type: 'resetCardsRefresh' })) ElMessage.success('已刷新真实卡片明细');
  await load();
}
function preview() {
  const card = selectedCard.value;
  if (!card) return;
  const scheduledAt = zonedDateTimeToEpoch(localTime.value, timeZone.value);
  return {
    card, scheduledAt,
    display: formatInTimeZone(scheduledAt, timeZone.value),
    expires: card.expiresAt === null ? '无到期时间' : formatInTimeZone(card.expiresAt, timeZone.value),
  };
}
async function schedule() {
  const value = preview();
  if (!value) { ElMessage.warning('请先选择可用卡片'); return; }
  if (value.scheduledAt <= Date.now()) { ElMessage.warning('预约时间必须晚于当前时间'); return; }
  if (value.card.expiresAt !== null && value.card.expiresAt <= value.scheduledAt) { ElMessage.warning('卡片将在预约时间前到期'); return; }
  try {
    await ElMessageBox.confirm(
      `确认预约内容：\n卡片：${value.card.title}（ID 尾号 ${value.card.idSuffix}）\n执行时间：${value.display}\n卡片到期：${value.expires}\n\n到点将只使用上面这张卡片，不自动替换其他卡片；\n错过执行时间会标记“已错过”，不自动补用。`,
      '保存前确认预约详情', { confirmButtonText: '确认预约', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  if (await store.command({ type: 'resetSchedule', cardKey: value.card.key, localTime: localTime.value, timeZone: timeZone.value, confirmed: true })) {
    ElMessage.success('预约已保存，到点前可取消');
    tab.value = 'appointments'; await load();
  }
}
async function cancel(appointment: ResetAppointmentView) {
  try {
    await ElMessageBox.confirm('取消该预约后将不再执行，也不会使用该卡片。', '取消预约', { confirmButtonText: '取消预约', cancelButtonText: '返回', type: 'warning' });
  } catch { return; }
  if (await store.command({ type: 'resetCancel', id: appointment.id })) { ElMessage.success('已取消'); await load(); }
}
async function reconcile(appointment: ResetAppointmentView) {
  try {
    await ElMessageBox.confirm(
      `将使用原请求 ID 再次核对这张卡片（ID 尾号 ${appointment.idSuffix}），不会更换请求 ID，也不会自动替换其他卡片。`,
      '核对不确定的兑换结果', { confirmButtonText: '使用原请求 ID 核对', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  if (await store.command({ type: 'resetReconcile', id: appointment.id })) { ElMessage.success('核对已提交，请查看执行记录'); await load(); }
}
onMounted(() => { void refresh(); });
</script>

<template>
  <section class="reset-cards">
    <div class="section-heading">
      <h2>重置卡</h2>
      <small class="muted">真实卡片明细来自官方 App Server；卡片完整 ID 只保存在本机，界面仅显示尾号。</small>
      <el-button :loading="store.busy" @click="refresh">刷新卡片（只读）</el-button>
    </div>
    <div v-if="info?.error" class="connection-alert"><span>读取失败</span>{{ info.error }}</div>
    <div class="footnote">
      桌面工具只接受 idempotencyKey 且自带“剩余不超过 10%”门槛；本功能使用官方 App Server 的指定 creditId 接口，不调用该工具，也不把 10% 门槛推断为底层固定条件。服务端仍可能返回“当前无可重置额度窗口”。
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="卡片列表" name="cards">
        <section class="card reset-panel">
          <div class="card-label">真实卡片明细<span>{{ info?.details === 'available' ? '已获取明细' : '明细不可用' }}</span></div>
          <p class="muted" v-if="info?.details === 'unavailable'">
            服务端报告 {{ info?.availableCount ?? 0 }} 张可用卡片，但未返回明细，无法选择指定卡片，也不臆造卡片数量。
          </p>
          <div v-if="!available.length" class="small-empty">{{ info?.details === 'available' ? '当前没有可用的重置卡。' : '刷新后如仍无明细，则无法预约指定卡片。' }}</div>
          <el-table v-else :data="available" size="small">
            <el-table-column prop="title" label="名称" min-width="200" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><span class="phase" :class="row.status">{{ row.status === 'available' ? '可用' : row.status }}</span></template></el-table-column>
            <el-table-column label="到期时间" min-width="170"><template #default="{ row }">{{ row.expiresAt === null ? '无到期时间' : formatInTimeZone(row.expiresAt, timeZone) }}</template></el-table-column>
            <el-table-column label="ID 尾号" width="110"><template #default="{ row }"><code>{{ row.idSuffix }}</code></template></el-table-column>
            <el-table-column label="操作" width="90"><template #default="{ row }"><el-button text type="primary" @click="selectedKey = row.key">预约</el-button></template></el-table-column>
          </el-table>
          <p class="muted" v-if="info?.details === 'available'">服务端可能只返回部分明细，可用总数以 availableCount 为准；状态、到期时间以执行前最新查询为准。</p>
        </section>
      </el-tab-pane>

      <el-tab-pane label="预约管理" name="appointments">
        <section class="card reset-panel">
          <div class="card-label">预约详情确认<span>只使用选中的卡</span></div>
          <div v-if="!available.length" class="small-empty">没有可用卡片，无法创建预约。</div>
          <el-form v-else label-position="top" class="schedule-form">
            <el-form-item label="选择卡片">
              <el-select v-model="selectedKey" placeholder="选择一张可用重置卡" style="width: 100%">
                <el-option v-for="card in available" :key="card.key" :value="card.key" :label="`${card.title}（${card.idSuffix}）`" />
              </el-select>
            </el-form-item>
            <div class="schedule-grid">
              <el-form-item label="执行日期与时间（一次性）"><el-date-picker v-model="localTime" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" :disabled-date="(d: Date) => d.getTime() < Date.now() - 86400000" style="width: 100%" /></el-form-item>
              <el-form-item label="时区"><el-select v-model="timeZone" style="width: 100%"><el-option v-for="zone in timeZones" :key="zone" :value="zone" :label="zone" /></el-select></el-form-item>
            </div>
            <div class="schedule-preview" v-if="preview()">
              <strong>预约预览</strong>
              <dl>
                <dt>卡片</dt><dd>{{ preview()!.card.title }}（ID 尾号 {{ preview()!.card.idSuffix }}）</dd>
                <dt>执行时间</dt><dd>{{ preview()!.display }}</dd>
                <dt>卡片到期</dt><dd>{{ preview()!.expires }}</dd>
              </dl>
              <p>到点仅兑换上面这张卡；错过执行时间默认“已错过”，不自动补用。</p>
            </div>
            <el-button type="primary" :disabled="!selectedCard || store.busy" :loading="store.busy" @click="schedule">确认并预约</el-button>
          </el-form>
        </section>
        <section class="card reset-panel">
          <div class="card-label">待执行 / 执行中 / 结果不确定 <span>{{ pending.length }}</span></div>
          <div v-if="!pending.length" class="small-empty">暂无进行中的预约。</div>
          <div v-for="appointment in pending" :key="appointment.id" class="reset-row">
            <div class="task-avatar">R</div>
            <div class="task-main"><h3>{{ appointment.cardTitle }}</h3><p>ID 尾号 {{ appointment.idSuffix }} · {{ formatInTimeZone(appointment.scheduledAt, appointment.timeZone) }}</p><small v-if="appointment.message" class="error-text">{{ appointment.message }}</small></div>
            <span class="phase" :class="statusKind(appointment.status)">{{ statusText(appointment.status) }}</span>
            <el-button v-if="appointment.status === 'pending'" text type="danger" @click="cancel(appointment)">取消</el-button>
            <el-button v-if="appointment.status === 'uncertain'" text type="primary" @click="reconcile(appointment)">原请求 ID 核对</el-button>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="执行记录" name="records">
        <section class="card reset-panel">
          <div class="card-label">执行记录 <span>{{ records.length }}</span></div>
          <div v-if="!records.length" class="small-empty">暂无执行记录。</div>
          <el-table v-else :data="records" size="small">
            <el-table-column label="状态" width="110"><template #default="{ row }"><span class="phase" :class="statusKind(row.status)">{{ statusText(row.status) }}</span></template></el-table-column>
            <el-table-column prop="cardTitle" label="卡片" min-width="160" />
            <el-table-column label="ID 尾号" width="100"><template #default="{ row }"><code>{{ row.idSuffix }}</code></template></el-table-column>
            <el-table-column label="预约时间" min-width="170"><template #default="{ row }">{{ formatInTimeZone(row.scheduledAt, row.timeZone) }}</template></el-table-column>
            <el-table-column label="结果 / 原因" min-width="220"><template #default="{ row }">{{ row.message ?? reason(row.reason) }}</template></el-table-column>
            <el-table-column label="请求 ID" min-width="150"><template #default="{ row }"><code>{{ row.requestId }}</code></template></el-table-column>
            <el-table-column label="完成时间" min-width="150"><template #default="{ row }">{{ row.finishedAt ? formatDataTime(row.finishedAt) : '—' }}</template></el-table-column>
          </el-table>
          <p class="muted">每次逻辑兑换使用持久化的唯一请求 ID；结果不确定时保留原请求 ID 供核对，不更换 ID 盲目重试。执行成功后会刷新额度与卡片数据。</p>
        </section>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.reset-panel { padding: 18px 20px; }
.schedule-form { max-width: 640px; }
.schedule-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.schedule-preview { background: #f5f7fa; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.schedule-preview dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0; }
.schedule-preview dt { color: #78839a; }
.schedule-preview dd { margin: 0; }
.reset-row { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid #eef1f5; }
.reset-row:last-child { border-bottom: none; }
</style>
