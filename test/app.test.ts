import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MonitorService } from '../src/app/service.ts';
import { exampleQuota } from '../src/scenarios.ts';
import { appearanceThemes, defaultAppearance, normalizeAppearance } from '../src/app/appearance.ts';
import { defaultQuotaCheck } from '../src/app/quota-schedule.ts';
import type { CurrentGoal, Job, ThreadView } from '../src/domain.ts';

class FakeDesktop {
  goal: CurrentGoal | null = null;
  goalError?: Error;
  readGoal() { if (this.goalError) throw this.goalError; return structuredClone(this.goal); }
  caller = randomUUID();
  target = randomUUID();
  view: ThreadView = { thread: { id: this.target, status: { type: 'idle' } }, turns: [{ id: 'blocked', status: 'failed', error: { code: 'UsageLimitExceeded' } }] };
  quotaValue = exampleQuota(100, Date.now() + 3600000);
  sends = 0;
  quotaCalls = 0;
  quotaError?: Error;
  afterRead?: () => Promise<void>;
  onSend?: () => void;
  async quota() { this.quotaCalls++; if (this.quotaError) throw this.quotaError; return structuredClone(this.quotaValue); }
  async call<T>() { return { pinnedThreads: [], threads: [{ id: this.target, title: '测试长任务', kind: 'codex', hostId: 'local', status: { type: 'idle' } }] } as T; }
  async readThread() { await this.afterRead?.(); return structuredClone(this.view); }
  async send(_id: string, prompt: string, beforeDispatch?: (reconnected?:boolean) => void | Promise<void>,beforeWrite?:()=>void) {
    this.onSend?.(); await beforeDispatch?.(); beforeWrite?.(); this.sends++;
    this.view.turns.unshift({ id: 'sent-' + this.sends, status: 'completed', items: [
      { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: prompt } },
      { type: 'agentMessage', text: '业务完成' },
    ] });
  }
  close() {}
}
async function setup(now?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-test-'));
  const desktop = new FakeDesktop();
  if (now) desktop.quotaValue = exampleQuota(100, now() + 3 * 3600000);
  const service = new MonitorService(directory, () => desktop, now, () => desktop.readGoal());
  service.db.setSettings({ ...service.db.settings(), callerThreadId: desktop.caller });
  await service.tick(true);
  return { directory, desktop, service, cleanup: async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }); } };
}
async function add(service: MonitorService, desktop: FakeDesktop) {
  await service.command({ type: 'add', targetThreadId: desktop.target, prompt: '继续已授权任务', maxResumes: 3 });
  return service.db.jobs()[0]!.job;
}

test('加入时实时拒绝普通已完成任务，列表摘要过期也不能绕过', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.view.turns = [{ id: 'done', status: 'completed' }];
    await assert.rejects(add(service, desktop), /该任务已经完成，无法加入托管列表/);
    assert.equal(service.snapshot().tasks.length, 0); assert.equal(desktop.sends, 0);
    assert.equal(service.db.events().some(e => e.type === 'monitoring_enabled'), false);
    desktop.view.turns[0]!.status = 'inProgress'; desktop.view.thread.status.type = 'active';
    await add(service, desktop);
    assert.equal(service.snapshot().tasks.length, 1, '校验失败后仍可重新加入未完成任务');
  } finally { await cleanup(); }
});

test('未结束 Goal 的单轮完成可以托管，主动暂停、受阻和自身预算不会自动续跑', async () => {
  for (const status of ['active', 'usage_limited', 'paused', 'blocked', 'budget_limited'] as const) {
    const { service, desktop, cleanup } = await setup();
    try {
      desktop.goal = { id: 'goal-1', status };
      desktop.view.turns = [{ id: 'done-round', status: 'completed' }];
      await add(service, desktop); await service.tick(true);
      assert.equal(service.snapshot().tasks.length, 1, status);
      assert.equal(service.snapshot().tasks[0]!.enabled, ['active', 'usage_limited'].includes(status));
      assert.equal(desktop.sends, 0);
    } finally { await cleanup(); }
  }
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goal = { id: 'paused-goal', status: 'paused' };
    desktop.quotaValue = exampleQuota(0, Date.now());
    await add(service, desktop); await service.tick(true);
    assert.equal(desktop.sends, 0, '即使最新轮次为额度失败，也不能恢复主动暂停的 Goal');
    assert.equal(service.snapshot().tasks[0]!.reason, 'goal_paused');
  } finally { await cleanup(); }
});

test('Goal 多轮续跑后保留托管，Goal 消失且最新轮次正常结束时自动移除并保留日志和尝试', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goal = { id: 'goal-1', status: 'active' };
    const job = await add(service, desktop); await service.tick(true);
    desktop.quotaValue = exampleQuota(0, Date.now());
    await service.tick(true); await service.tick(true);
    assert.equal(service.snapshot().tasks[0]!.phase, 'observing');
    assert.equal(service.snapshot().tasks[0]!.resumeCount, 1);
    assert.equal(service.db.db.prepare('SELECT phase FROM attempts WHERE task_id=?').get(job.id)?.phase, 'completed');
    desktop.view.turns.unshift({ id: 'goal-next-round', status: 'failed', error: { code: 'UsageLimitExceeded' } });
    await service.tick(true); await service.tick(true);
    assert.equal(desktop.sends, 2);
    assert.equal(service.snapshot().tasks.length, 1);
    desktop.goal = null;
    await service.tick(true);
    assert.equal(service.snapshot().tasks.length, 0);
    const removed = service.db.events().filter(e => e.type === 'task_removed');
    assert.equal(removed.length, 1); assert.equal(removed[0]!.taskName, '测试长任务');
    assert.equal(removed[0]!.details.automatic, true);
    assert.equal(service.db.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND phase=?').get(job.id, 'completed')?.n, 2);
    await service.tick(true); assert.equal(desktop.sends, 2);
    assert.equal(service.db.events().filter(e => e.type === 'task_removed').length, 1);
  } finally { await cleanup(); }
});

test('Goal 消失但最新轮次仍运行或失败时保留任务，Goal 更换也不沿用旧授权发送', async () => {
  for (const status of ['inProgress', 'failed', 'interrupted'] as const) {
    const { service, desktop, cleanup } = await setup();
    try {
      desktop.goal = { id: 'goal-1', status: 'active' };
      await add(service, desktop); await service.tick(true);
      desktop.goal = null; desktop.view.turns[0]!.status = status;
      desktop.view.thread.status.type = status === 'inProgress' ? 'active' : 'idle';
      desktop.quotaValue = exampleQuota(0, Date.now());
      await service.tick(true);
      assert.equal(service.snapshot().tasks.length, 1);
      assert.equal(service.snapshot().tasks[0]!.reason, 'goal_changed_or_cleared');
      assert.equal(desktop.sends, 0);
    } finally { await cleanup(); }
  }
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goal = { id: 'goal-1', status: 'active' }; await add(service, desktop);
    desktop.goal = { id: 'goal-2', status: 'active' }; desktop.quotaValue = exampleQuota(0, Date.now());
    await service.tick(true);
    assert.equal(service.snapshot().tasks[0]!.reason, 'goal_changed_or_cleared'); assert.equal(desktop.sends, 0);
  } finally { await cleanup(); }
});

test('Goal 读取失败和读取期间身份变化时不创建、删除或发送', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goalError = new Error('Goal 读取失败');
    await assert.rejects(add(service, desktop), /Goal 读取失败/);
    assert.equal(service.snapshot().tasks.length, 0);
    desktop.goalError = undefined;
    await add(service, desktop); await service.tick(true);
    desktop.goalError = new Error('Goal 读取失败'); desktop.quotaValue = exampleQuota(0, Date.now());
    await service.tick(true);
    assert.equal(service.snapshot().tasks.length, 1); assert.equal(desktop.sends, 0);
    desktop.goalError = undefined;
    desktop.afterRead = async () => { desktop.goal = { id: 'new-goal', status: 'active' }; };
    await service.tick(true);
    assert.match(service.snapshot().tasks[0]!.lastError!, /读取期间 Goal 已变化/);
    assert.equal(desktop.sends, 0);
  } finally { await cleanup(); }
});

test('发送前复查发现 Goal 主动暂停时取消投递', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goal = { id: 'goal-1', status: 'active' }; await add(service, desktop);
    desktop.quotaValue = exampleQuota(0, Date.now());
    let reads = 0;
    desktop.afterRead = async () => { if (++reads === 2) desktop.goal!.status = 'paused'; };
    await service.tick(true);
    assert.equal(desktop.sends, 0); assert.equal(service.snapshot().tasks[0]!.reason, 'goal_paused');
  } finally { await cleanup(); }
});

test('Goal 跨正常完成轮次仍受累计续跑次数上限约束', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    desktop.goal = { id: 'goal-1', status: 'active' };
    const job = await add(service, desktop); job.maxResumes = 1; service.db.journal(job.id).save(job);
    desktop.quotaValue = exampleQuota(0, Date.now());
    await service.tick(true); await service.tick(true);
    desktop.view.turns.unshift({ id: 'goal-next-failure', status: 'failed', error: { code: 'UsageLimitExceeded' } });
    await service.tick(true); await service.tick(true);
    assert.equal(desktop.sends, 1); assert.equal(service.snapshot().tasks[0]!.reason, 'resume_limit_reached');
    assert.equal(service.snapshot().tasks[0]!.enabled, false);
  } finally { await cleanup(); }
});

test('发送已准备好但尚未派发时再次核对 Goal，暂停或源库失败都取消且扣回次数', async () => {
  for (const failure of ['paused', 'unavailable']) {
    const { service, desktop, cleanup } = await setup();
    try {
      desktop.goal = { id: 'goal-1', status: 'active' }; await add(service, desktop);
      desktop.quotaValue = exampleQuota(0, Date.now());
      desktop.onSend = () => {
        if (failure === 'paused') desktop.goal!.status = 'paused';
        else desktop.goalError = new Error('Goal 源库不可用');
      };
      await service.tick(true);
      assert.equal(desktop.sends, 0);
      assert.equal(service.snapshot().tasks[0]!.resumeCount, 0);
      assert.equal(service.snapshot().tasks[0]!.reason, failure === 'paused' ? 'goal_paused' : 'goal_state_unavailable');
    } finally { await cleanup(); }
  }
});

test('旧版 completed 记录重启后重新校验，未结束 Goal 不被误删', async () => {
  for (const goal of [null, { id: 'unfinished-goal', status: 'active' as const }]) {
    const { service, desktop, directory } = await setup();
    let restored: MonitorService | undefined;
    try {
      const job = await add(service, desktop); job.phase = 'completed';
      service.db.journal(job.id).save(job); service.db.toggle(job.id, false);
      desktop.goal = goal; desktop.view.turns = [{ id: 'done-round', status: 'completed' }];
      await service.stop();
      restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
      await restored.tick(true);
      assert.equal(restored.snapshot().tasks.length, goal ? 1 : 0);
      if (goal) {
        assert.equal(restored.snapshot().tasks[0]!.phase, 'observing');
        assert.equal(restored.snapshot().tasks[0]!.enabled, false);
      }
    } finally { await restored?.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('本次续跑轮次已完成但最新人工轮次仍运行时不自动移除', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    await add(service, desktop); desktop.quotaValue = exampleQuota(0, Date.now());
    await service.tick(true);
    desktop.view.turns.unshift({ id: 'manual-running', status: 'inProgress' });
    desktop.view.thread.status.type = 'active';
    await service.tick(true);
    assert.equal(service.snapshot().tasks.length, 1);
    assert.equal(service.snapshot().tasks[0]!.reason, 'thread_changed_since_resume');
    assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});

test('人工核对发送回执确认当前任务完成时同样自动移除，不重新投递', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    const job = await add(service, desktop);
    job.phase = 'send_uncertain'; job.resumeCount = 1; job.sentAt = Date.now();
    service.db.journal(job.id).save(job); service.db.toggle(job.id, false);
    desktop.view.turns.unshift({ id: 'received', status: 'completed', items: [{ type: 'userMessage', text: job.marker }] });
    await service.command({ type: 'reconcile', id: job.id });
    assert.equal(service.snapshot().tasks.length, 0); assert.equal(desktop.sends, 0);
    assert.equal(service.db.events().find(e => e.type === 'task_removed')?.details.automatic, true);
  } finally { await cleanup(); }
});

test('10 秒额度查询照常执行，重复额度分段合并，变化和恢复立即记录且只发送一次', async () => {
  const start = 1800000000000; let now = start;
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await service.command({ type: 'settings', value: { ...service.db.settings(), quotaCheck: { intervalSeconds: 10 } } });
    await add(service, desktop); await service.tick(true);
    const calls = desktop.quotaCalls;
    const checks = () => service.db.events().filter(e => e.type === 'quota_checked');
    const firstId = checks()[0]!.id;
    for (let n = 1; n <= 89; n++) { now = start + n * 10000; await service.tick(); }
    assert.equal(desktop.quotaCalls, calls + 89);
    assert.equal(desktop.sends, 0);
    assert.equal(checks().length, 2);
    assert.equal(checks()[1]!.id, firstId);
    assert.equal(checks()[1]!.details.checkCount, 60);
    assert.equal(checks()[0]!.details.checkCount, 30);
    assert.equal(checks()[0]!.details.periodicSummary, true);
    assert.equal(checks()[0]!.details.firstCheckedAt, start + 600000);
    assert.equal(checks()[0]!.details.lastCheckedAt, now);
    assert.equal(checks()[0]!.details.nextCheckAt, service.snapshot().nextQuotaCheckAt);
    assert.equal(checks()[0]!.details.nextCheckAt, service.db.tasks()[0]!.nextCheckAt);
    assert.equal(checks()[0]!.details.nextCheckAt, now + 10000);
    assert.notEqual(checks()[0]!.details.gateSuggestedCheckAt, now + 10000);
    desktop.quotaValue.rateLimitsByLimitId!.codex!.secondary!.usedPercent = 40;
    now += 10000; await service.tick(); assert.equal(checks().length, 3);
    desktop.quotaValue = exampleQuota(0, now + 3600000);
    now += 10000; await service.tick();
    assert.equal(checks().length, 4); assert.equal(checks()[0]!.details.available, true);
    assert.equal(desktop.sends, 1);
    now += 10000; await service.tick();
    assert.equal(service.db.tasks().length, 0);
    assert.equal(service.db.events().find(e => e.type === 'task_removed')?.details.automatic, true);
    assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});

test('快照分别暴露未匹配和已匹配的续跑轮次，长任务继续运行不被当作完成', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    await add(service, desktop); await service.tick(true);
    desktop.quotaValue = exampleQuota(0, Date.now() + 3600000);
    await service.tick(true);
    assert.equal(service.snapshot().tasks[0]!.phase, 'verifying');
    assert.equal(service.snapshot().tasks[0]!.sentTurnId, undefined);
    desktop.view.turns[0]!.status = 'inProgress'; desktop.view.thread.status.type = 'active';
    await service.tick(true);
    const task = service.snapshot().tasks[0]!;
    assert.equal(task.phase, 'verifying'); assert.equal(task.sentTurnId, 'sent-1');
    assert.equal(task.evidence.sameThreadReply, false); assert.equal(task.enabled, true);
    await service.tick(true); assert.equal(desktop.sends, 1);
    desktop.view.turns[0]!.status = 'completed'; desktop.view.thread.status.type = 'idle';
    await service.tick(true);
    assert.equal(service.snapshot().tasks.length, 0);
    assert.equal((service.db.events().find(e => e.type === 'completed')!.details.evidence as Job['evidence']).sameThreadReply, true);
    assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});

test('本机数据刷新读取新事件，不查询额度、不推进任务或投递', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    const job = await add(service, desktop);
    await service.tick(true);
    const before = service.db.tasks();
    const quotaCalls = desktop.quotaCalls;
    desktop.quotaValue = exampleQuota(0, Date.now() + 3600000);
    service.db.event(job.id, 'local_data_test', { nextCheckAt: Date.now() + 600000 });
    const eventCount = service.db.events().length;
    await service.command({ type: 'refreshData' });
    assert.equal(service.snapshot().events[0]!.type, 'local_data_test');
    assert.equal(service.snapshot().events[0]!.taskName, '测试长任务');
    assert.equal(service.db.events().length, eventCount);
    assert.deepEqual(service.db.tasks(), before);
    assert.equal(desktop.quotaCalls, quotaCalls);
    assert.equal(desktop.sends, 0);
  } finally { await cleanup(); }
});

test('任务名写入事件，移除托管并重启后仍保留，应用事件名称为空', async () => {
  const { service, desktop, directory } = await setup();
  let restored: MonitorService | undefined;
  let stopped = false;
  try {
    const job = await add(service, desktop);
    await service.command({ type: 'toggle', id: job.id, enabled: false });
    await service.command({ type: 'remove', id: job.id });
    assert.equal(service.db.tasks().length, 0);
    const events = service.db.events().filter(event => event.taskId === job.id);
    assert.equal(events[0]!.type, 'task_removed');
    assert.ok(events.length >= 3);
    assert.ok(events.every(event => event.taskName === '测试长任务'));
    assert.equal(service.db.events().find(event => event.taskId === null)!.taskName, null);
    await service.stop(); stopped = true;
    restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
    assert.deepEqual(restored.db.events().filter(event => event.taskId === job.id), events);
    assert.equal(desktop.sends, 0);
  } finally {
    await restored?.stop(); if (!stopped) await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('旧设置补齐外观，20 种主题可保存，非法外观不能覆盖有效设置', async () => {
  const { service, desktop, directory } = await setup();
  let restored: MonitorService | undefined;
  let stopped = false;
  try {
    const { appearance: _appearance, ...legacy } = service.db.settings();
    service.db.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...legacy, pollSeconds: 45 }));
    assert.deepEqual(service.db.settings().appearance, defaultAppearance);
    assert.equal(service.db.settings().pollSeconds, 45);
    const job = await add(service, desktop);
    const settings = service.db.settings();
    settings.appearance = { ...settings.appearance, bodyFontSize: 20, secondaryFontSize: 15, accent: 'blue', density: 'compact' };
    await service.command({ type: 'settings', value: settings });
    assert.equal(service.db.enabled(job.id), true);
    assert.equal(service.db.settings().pollSeconds, 45);
    await assert.rejects(service.command({ type: 'settings', value: {
      ...settings, appearance: { ...settings.appearance, bodyFontSize: 400 },
    } }), /外观设置无效/);
    assert.equal(appearanceThemes.filter(theme => theme.kind === 'solid').length, 10);
    assert.equal(appearanceThemes.filter(theme => theme.kind === 'gradient').length, 10);
    assert.equal(normalizeAppearance({ accent: 'not-a-theme' }).accent, 'teal');
    for (const theme of appearanceThemes) {
      settings.appearance.accent = theme.id;
      await service.command({ type: 'settings', value: settings });
      assert.equal(service.db.settings().appearance.accent, theme.id);
      assert.equal(service.db.settings().pollSeconds, 45);
      assert.equal(service.db.enabled(job.id), true);
    }
    await assert.rejects(service.command({ type: 'settings', value: {
      ...settings, appearance: { ...settings.appearance, accent: 'linear-gradient(red, blue)' },
    } } as never), /外观设置无效/);
    assert.equal(service.db.settings().appearance.accent, 'ink');
    assert.equal(service.db.settings().appearance.bodyFontSize, 20);
    assert.equal(desktop.sends, 0);
    await service.stop(); stopped = true;
    restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
    assert.deepEqual(restored.db.settings().appearance, settings.appearance);
    assert.equal(restored.db.enabled(job.id), true);
  } finally {
    if (!stopped) await service.stop();
    await restored?.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test('默认十分钟检查不受三小时恢复时间约束，共用新额度并完成后停托管', async () => {
  const start = new Date(2026, 9, 26, 12).getTime();
  let now = start;
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await add(service, desktop); await service.tick(true);
    const due = start + 600000;
    assert.equal(service.snapshot().nextQuotaCheckAt, due);
    assert.equal(service.db.tasks()[0]!.nextCheckAt, due);
    const calls = desktop.quotaCalls;
    for (const elapsed of [15000, 60000, 300000, 599000]) {
      now = start + elapsed; await service.tick();
      assert.equal(desktop.quotaCalls, calls); assert.equal(desktop.sends, 0);
    }
    desktop.quotaValue = exampleQuota(0, due); now = due;
    await service.tick();
    assert.equal(desktop.quotaCalls, calls + 1, '总览与等待任务应共用本轮新查询');
    assert.equal(desktop.sends, 1);
    now += 16000; await service.tick();
    assert.equal(service.db.tasks().length, 0);
    assert.equal(service.db.events().find(e => e.type === 'task_removed')?.details.automatic, true);
    now += 5 * 3600000; await service.tick();
    assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});

test('修改定期间隔立即重排等待任务，额度查询周期独立于任务检查周期', async () => {
  let now = new Date(2026, 9, 26, 12).getTime();
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await add(service, desktop); await service.tick(true);
    await service.command({ type: 'settings', value: { ...service.db.settings(), pollSeconds: 300,
      quotaCheck: { intervalSeconds: 10 } } });
    assert.equal(service.db.tasks()[0]!.nextCheckAt, now + 10000);
    const calls = desktop.quotaCalls;
    now += 9000; await service.tick(); assert.equal(desktop.quotaCalls, calls);
    now += 1000; await service.tick(); assert.equal(desktop.quotaCalls, calls + 1);
    assert.equal(desktop.sends, 0);
    desktop.quotaValue = exampleQuota(0, now); now += 10000; await service.tick();
    assert.equal(desktop.quotaCalls, calls + 2); assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});

test('零点十分不插入检查，休眠错过定期检查后补查且不会连续重复', async () => {
  let now = new Date(2026, 9, 26, 0, 9, 30).getTime();
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await add(service, desktop); await service.tick(true);
    assert.equal(service.snapshot().nextQuotaCheckAt, now + 600000);
    const calls = desktop.quotaCalls;
    now = new Date(2026, 9, 26, 0, 10).getTime();
    await service.tick(); assert.equal(desktop.quotaCalls, calls);
    // 模拟整个调度器休眠到 00:25；服务端提前恢复，不修改原来的预计恢复时间。
    now = new Date(2026, 9, 26, 0, 25).getTime();
    desktop.quotaValue = exampleQuota(0, now + 3 * 3600000);
    await service.tick();
    assert.equal(desktop.quotaCalls, calls + 1); assert.equal(desktop.sends, 1);
    assert.equal(service.snapshot().nextQuotaCheckAt, now + 600000);
    now += 2000; await service.tick(); assert.equal(desktop.quotaCalls, calls + 1);
  } finally { await cleanup(); }
});

test('定期检查仍受限时继续等待，手动刷新可提前查询但不能绕过额度判定', async () => {
  let now = new Date(2026, 9, 26, 12).getTime();
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await add(service, desktop); await service.tick(true);
    const calls = desktop.quotaCalls;
    now += 15000; await service.command({ type: 'refresh' });
    assert.equal(desktop.quotaCalls, calls + 1); assert.equal(desktop.sends, 0);
    now = service.snapshot().nextQuotaCheckAt!; await service.tick();
    assert.equal(desktop.sends, 0);
    assert.equal(service.snapshot().nextQuotaCheckAt, now + defaultQuotaCheck.intervalSeconds * 1000);
  } finally { await cleanup(); }
});

test('额度配置兼容旧设置并重启保留，非法设置不能覆盖监控或外观参数', async () => {
  const { service, desktop, directory } = await setup();
  let restored: MonitorService | undefined;
  let stopped = false;
  try {
    const { quotaCheck: _quotaCheck, ...legacy } = service.db.settings();
    service.db.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...legacy, pollSeconds: 45 }));
    assert.deepEqual(service.db.settings().quotaCheck, defaultQuotaCheck);
    service.db.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...legacy, pollSeconds: 45,
      quotaCheck: { mode: 'recovery', intervalSeconds: 60, recoveryDelayMinutes: 10, dailyResetCheck: true } }));
    assert.deepEqual(service.db.settings().quotaCheck, { intervalSeconds: 600 });
    service.db.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...legacy, pollSeconds: 45,
      quotaCheck: { mode: 'fixed', intervalSeconds: 120, recoveryDelayMinutes: 2, dailyResetCheck: true } }));
    assert.deepEqual(service.db.settings().quotaCheck, { intervalSeconds: 120 });
    const settings = { ...service.db.settings() };
    await service.command({ type: 'settings', value: settings });
    const saved = JSON.parse(String(service.db.db.prepare('SELECT value FROM settings WHERE id=1').get()!.value));
    assert.deepEqual(saved.quotaCheck, { intervalSeconds: 120 });
    await assert.rejects(service.command({ type: 'settings', value: { ...settings,
      quotaCheck: { ...settings.quotaCheck, intervalSeconds: 0 } } }), /额度查询设置无效/);
    assert.equal(service.db.settings().pollSeconds, 45);
    assert.deepEqual(service.db.settings().appearance, settings.appearance);
    await service.stop(); stopped = true;
    restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
    assert.deepEqual(restored.db.settings().quotaCheck, settings.quotaCheck);
  } finally {
    if (!stopped) await service.stop();
    await restored?.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test('旧预计恢复任务重启后立即复查，并将数小时等待改为十分钟', async () => {
  const now = new Date(2026, 9, 28, 12).getTime();
  const { service, desktop, directory } = await setup(() => now);
  let restored: MonitorService | undefined;
  let stopped = false;
  try {
    await add(service, desktop); await service.tick(true);
    const job = service.db.jobs()[0]!.job;
    service.db.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify({ ...service.db.settings(),
      quotaCheck: { mode: 'recovery', intervalSeconds: 60, recoveryDelayMinutes: 10, dailyResetCheck: true } }));
    job.nextCheckAt = now + 3 * 3600000; service.db.journal(job.id).save(job);
    const calls = desktop.quotaCalls;
    await service.stop(); stopped = true;
    restored = new MonitorService(directory, () => desktop, () => now, () => desktop.readGoal());
    await restored.tick();
    assert.equal(desktop.quotaCalls, calls + 1);
    assert.deepEqual(restored.snapshot().settings.quotaCheck, { intervalSeconds: 600 });
    assert.equal(restored.snapshot().nextQuotaCheckAt, now + 600000);
    assert.equal(restored.db.tasks()[0]!.nextCheckAt, now + 600000);
    assert.equal(restored.db.tasks()[0]!.enabled, true);
    assert.equal(desktop.sends, 0);
  } finally {
    if (!stopped) await service.stop();
    await restored?.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test('定期查询失败时清空旧额度并按十分钟间隔重试，不按心跳反复查询', async () => {
  let now = new Date(2026, 9, 26, 0, 9, 30).getTime();
  const { service, desktop, cleanup } = await setup(() => now);
  try {
    await add(service, desktop); await service.tick(true);
    const calls = desktop.quotaCalls;
    now = service.snapshot().nextQuotaCheckAt!;
    desktop.quotaError = new Error('模拟额度查询超时');
    await service.tick();
    assert.equal(desktop.quotaCalls, calls + 1); assert.equal(service.snapshot().quota, null);
    assert.equal(service.snapshot().nextQuotaCheckAt, now + 600000);
    for (const elapsed of [2000, 18000, 20000]) {
      now += elapsed; await service.tick();
      assert.equal(desktop.quotaCalls, calls + 1); assert.equal(desktop.sends, 0);
    }
    now = service.snapshot().nextQuotaCheckAt!;
    desktop.quotaError = undefined; desktop.quotaValue = exampleQuota(0, now);
    await service.tick();
    assert.equal(desktop.quotaCalls, calls + 2); assert.equal(desktop.sends, 1);
  } finally { await cleanup(); }
});
test('SQLite 托管经过耗尽、等待、恢复与原会话回执，并先提交发送意图', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    const job = await add(service, desktop);
    await service.tick(true);
    assert.equal(service.db.tasks()[0]!.phase, 'waiting_quota'); assert.equal(desktop.sends, 0);
    const saved = service.db.jobs()[0]!.job; saved.nextCheckAt = 0; service.db.journal(job.id).save(saved);
    desktop.quotaValue = exampleQuota(0, Date.now() + 3600000);
    desktop.onSend = () => {
      assert.equal(service.db.jobs()[0]!.job.phase, 'sending');
      assert.equal(service.db.db.prepare('SELECT phase FROM attempts WHERE task_id=?').get(job.id)?.phase, 'sending');
    };
    await service.tick(true); await service.tick(true);
    assert.equal(desktop.sends, 1); assert.equal(service.db.tasks().length, 0);
    assert.equal((service.db.events().find(e => e.type === 'completed')!.details.evidence as Job['evidence']).sameThreadReply, true);
    assert.equal(service.db.db.prepare('SELECT phase FROM attempts WHERE task_id=?').get(job.id)?.phase, 'completed');
    assert.ok(!JSON.stringify(service.snapshot()).includes('accountId'));
  } finally { await cleanup(); }
});
test('发送前的异步读取期间暂停托管，可以阻止本次投递', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    const job = await add(service, desktop);
    desktop.quotaValue = exampleQuota(0, Date.now() + 3600000);
    let reads = 0;
    desktop.afterRead = async () => { if (++reads === 2) await service.command({ type: 'toggle', id: job.id, enabled: false }); };
    await service.tick(true);
    assert.equal(desktop.sends, 0); assert.equal(service.db.tasks()[0]!.enabled, false);
    assert.equal(service.db.tasks()[0]!.phase, 'suspended');
    assert.equal(service.db.tasks()[0]!.resumeCount, 0);
  } finally { await cleanup(); }
});
test('发送中崩溃后重新打开数据库，作业转入待核对且不会自动重发', async () => {
  const { service, desktop, directory } = await setup();
  await add(service, desktop);
  const job = service.db.jobs()[0]!.job; job.phase = 'sending'; job.resumeCount = 1;
  service.db.journal(job.id).save(job); await service.stop();
  const restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
  try {
    assert.equal(restored.db.tasks()[0]!.phase, 'send_uncertain');
    assert.equal(restored.db.tasks()[0]!.enabled, false);
    await restored.tick(true); assert.equal(desktop.sends, 0);
  } finally { await restored.stop(); rmSync(directory, { recursive: true, force: true }); }
});
test('同一目标不能重复托管，未授权的会话和无效参数被拒绝', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    await add(service, desktop); await assert.rejects(add(service, desktop), /已在托管/);
    await assert.rejects(service.command({ type: 'add', targetThreadId: randomUUID(), prompt: '继续', maxResumes: 3 }), /不在本机/);
    await assert.rejects(service.command({ type: 'settings', value: { ...service.db.settings(), pollSeconds: 0 } }), /无效/);
    const original = service.db.settings();
    await assert.rejects(service.command({ type: 'settings', value: { ...original, callerThreadId: randomUUID() } }), /暂停所有/);
  } finally { await cleanup(); }
});
test('再次遇到真实结构的额度错误时轮换投递标记，最多按用户次数续跑', async () => {
  const { service, desktop, cleanup } = await setup();
  try {
    await add(service, desktop);
    desktop.quotaValue = exampleQuota(0, Date.now() + 3600000);
    const markers = new Set<string>();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const job = service.db.jobs()[0]!.job;
      markers.add(job.marker);
      await service.tick(true);
      desktop.view.turns[0]!.status = 'failed'; desktop.view.turns[0]!.error = { code: 'UsageLimitExceeded' };
      await service.tick(true);
      assert.equal(desktop.sends, cycle);
    }
    assert.equal(markers.size, 3); assert.equal(service.db.tasks()[0]!.phase, 'suspended');
    await service.tick(true); assert.equal(desktop.sends, 3);
    assert.equal(service.db.db.prepare('SELECT COUNT(*) AS count FROM attempts').get()?.count, 3);
  } finally { await cleanup(); }
});
test('暂停标志不会被晚到的引擎存盘覆盖，设置和记录重启后仍保留', async () => {
  const { service, desktop, directory } = await setup();
  const job: Job = await add(service, desktop);
  service.db.toggle(job.id, false); service.db.journal(job.id).save(job);
  await service.stop();
  const restored = new MonitorService(directory, () => desktop, undefined, () => desktop.readGoal());
  try {
    assert.equal(restored.db.tasks()[0]!.enabled, false);
    assert.equal(restored.db.settings().callerThreadId, desktop.caller);
    assert.ok(restored.db.events().length >= 3);
  } finally { await restored.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('可发送夹具的只读刷新与自检均零意图零发送，不改额度调度与授权', async () => {
  const {service,desktop,cleanup}=await setup();
  try {
    await add(service,desktop); await service.tick(true);
    desktop.quotaValue=exampleQuota(0,Date.now());
    const before=service.db.jobs(); const next=service.snapshot().nextQuotaCheckAt;
    for (const type of ['refreshStatus','selfCheck'] as const) {
      await service.command({type});
      assert.equal(desktop.sends,0); assert.equal(service.db.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n,0);
      assert.deepEqual(service.db.jobs(),before); assert.equal(service.snapshot().nextQuotaCheckAt,next);
      assert.equal(service.snapshot().inspection?.tasks[before[0]!.job.id]?.find(c=>c.key==='account')?.status,'pass');
    }
    desktop.goalError=new Error('Goal 源库结构不兼容'); await service.inspect();
    assert.equal(service.inspection?.tasks[before[0]!.job.id]?.[0]?.status,'unknown');
    desktop.goalError=undefined; desktop.quotaValue={}; await service.inspect();
    assert.equal(service.inspection?.tasks[before[0]!.job.id]?.find(c=>c.key==='quota')?.status,'unknown');
  } finally { await cleanup(); }
});

test('完整归档事务保留任务摘要、事件及attempts；手动移除不冒充完成',async()=>{
  const {service,desktop,cleanup}=await setup();
  try {
    const job=await add(service,desktop);await service.tick(true);desktop.quotaValue=exampleQuota(0,Date.now());await service.tick(true);await service.tick(true);
    assert.equal(service.db.tasks().length,0);
    const a=service.db.query({type:'archives'}).archives![0]!;
    assert.equal(a.id,job.id);assert.equal(a.reason,'current_task_completed');assert.equal(a.resumeCount,1);assert.equal(a.incomplete,false);
    assert.equal(service.db.query({type:'timeline',taskId:job.id}).attempts!.length,1);
    service.db.removeCompleted(job.id);assert.equal(service.db.query({type:'archives'}).archives!.length,1);
    desktop.view.turns=[{id:'blocked2',status:'failed',error:{code:'UsageLimitExceeded'}}];
    const second=await add(service,desktop);await service.command({type:'toggle',id:second.id,enabled:false});await service.command({type:'remove',id:second.id});
    assert.equal(service.db.query({type:'archives'}).archives![0]!.reason,'user_removed');
  } finally {await cleanup();}
});

test('模板复制、暂停编辑、修订授权与累计次数保留；模板更新不追改任务',async()=>{
  const {service,desktop,cleanup}=await setup();
  try {
    await service.command({type:'templateSave',value:{id:'t',name:'默认',body:'原模板正文',isDefault:true}});
    await service.command({type:'add',targetThreadId:desktop.target,prompt:service.db.templates()[0]!.body,maxResumes:3});
    const task=service.db.tasks()[0]!;
    await service.command({type:'templateSave',value:{id:'t',name:'已修改',body:'新正文',isDefault:true}});
    await service.command({type:'templateDelete',id:'t'}); assert.equal(service.db.tasks()[0]!.prompt,'原模板正文');
    const value={...task.config,prompt:'仅未来发送的新提示词',maxResumes:2};
    await assert.rejects(service.command({type:'edit',id:task.id,revision:1,value}),/暂停/);
    await service.command({type:'toggle',id:task.id,enabled:false});
    const job=service.db.jobs()[0]!.job;job.resumeCount=1;service.db.journal(job.id).save(job);
    await service.command({type:'edit',id:task.id,revision:1,value});
    assert.equal(service.db.tasks()[0]!.enabled,false);assert.equal(service.db.tasks()[0]!.resumeCount,1);
    assert.equal(service.db.config(task.id).revision,2);
    await assert.rejects(service.command({type:'toggle',id:task.id,enabled:true}),/确认/);
    await service.command({type:'toggle',id:task.id,enabled:true,confirmedRevision:2});
    assert.equal(service.db.tasks()[0]!.resumeCount,1);
    assert.equal(service.db.events().find(e=>e.type==='config_revised')!.details.prompt,undefined);
  } finally {await cleanup();}
});

test('仅观察在发送意图之前强制阻断，恢复提醒跨重开去重，切换必须暂停并确认',async()=>{
  const {service,desktop,cleanup}=await setup();
  try {
    await service.command({type:'add',targetThreadId:desktop.target,prompt:'继续',maxResumes:3,config:{mode:'observe'}});
    await service.tick(true);desktop.quotaValue=exampleQuota(0,Date.now());await service.tick(true);await service.tick(true);
    const task=service.db.tasks()[0]!;
    assert.equal(task.resumeCount,0);assert.equal(desktop.sends,0);assert.equal(service.db.unresolved(task.id),false);
    assert.equal(service.db.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n,0);
    assert.equal(service.db.events().filter(e=>e.type==='observe_recovery_ready').length,1);
    const {AppDatabase}=await import('../src/app/database.ts');
    service.db.close();service.db=new AppDatabase(join(service.directory,'resume.sqlite'));await service.tick(true);
    assert.equal(service.db.events().filter(e=>e.type==='observe_recovery_ready').length,1);
    await service.command({type:'toggle',id:task.id,enabled:false});
    await service.command({type:'edit',id:task.id,revision:1,value:{...task.config,mode:'auto',prompt:'确认后的未来提示词',maxResumes:3}});
    await assert.rejects(service.command({type:'toggle',id:task.id,enabled:true,confirmedRevision:1}),/确认/);
    await service.command({type:'toggle',id:task.id,enabled:true,confirmedRevision:2});await service.tick(true);assert.equal(desktop.sends,1);
  } finally {await cleanup();}
});

test('编辑上限等于已使用次数可仅观察，自动续跑仍不能重启额度投递，低于累计值拒绝',async()=>{
  const {service,desktop,cleanup}=await setup();try{
    const job=await add(service,desktop);await service.command({type:'toggle',id:job.id,enabled:false});
    job.resumeCount=2;service.db.journal(job.id).save(job);
    const config=service.db.config(job.id);
    await assert.rejects(service.command({type:'edit',id:job.id,revision:1,value:{...config,prompt:'继续',maxResumes:1}}),/配置无效/);
    await service.command({type:'edit',id:job.id,revision:1,value:{...config,mode:'observe',prompt:'继续',maxResumes:2}});
    await service.command({type:'toggle',id:job.id,enabled:true,confirmedRevision:2});
    desktop.quotaValue=exampleQuota(0,Date.now());await service.tick(true);assert.equal(desktop.sends,0);assert.equal(service.db.tasks()[0]!.resumeCount,2);
    await service.command({type:'toggle',id:job.id,enabled:false});await service.command({type:'edit',id:job.id,revision:2,value:{...config,mode:'auto',prompt:'继续',maxResumes:2}});
    await assert.rejects(service.command({type:'toggle',id:job.id,enabled:true,confirmedRevision:3}),/累计续跑次数/);
  }finally{await cleanup();}
});

test('只读刷新保留置顶会话并按 ID 去重，与后台列表一致',async()=>{
  const {service,desktop,cleanup}=await setup();try{
    const pinned={id:desktop.target,title:'仅置顶目标',kind:'codex',hostId:'local',status:'idle',project:{cwd:'D:/fixture'}};
    desktop.call=async<T>()=>({pinnedThreads:[pinned],threads:[]} as T);
    await service.tick(true);assert.equal(service.snapshot().threads[0]!.id,desktop.target);
    await service.command({type:'refreshStatus'});assert.equal(service.snapshot().threads[0]?.id,desktop.target);
    assert.equal(service.snapshot().threads[0]?.cwd,'D:/fixture');assert.equal(desktop.sends,0);
  }finally{await cleanup();}
});
