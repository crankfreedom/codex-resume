import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MonitorService } from '../src/app/service.ts';
import { exampleQuota } from '../src/scenarios.ts';
import { defaultAppearance } from '../src/app/appearance.ts';
import { defaultQuotaCheck } from '../src/app/quota-schedule.ts';
import type { Job, ThreadView } from '../src/domain.ts';

class FakeDesktop {
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
  async send(_id: string, prompt: string) {
    this.onSend?.(); this.sends++;
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
  const service = new MonitorService(directory, () => desktop, now);
  service.db.setSettings({ ...service.db.settings(), callerThreadId: desktop.caller });
  await service.tick(true);
  return { directory, desktop, service, cleanup: async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }); } };
}
async function add(service: MonitorService, desktop: FakeDesktop) {
  await service.command({ type: 'add', targetThreadId: desktop.target, prompt: '继续已授权任务', maxResumes: 3 });
  return service.db.jobs()[0]!.job;
}

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
    restored = new MonitorService(directory, () => desktop);
    assert.deepEqual(restored.db.events().filter(event => event.taskId === job.id), events);
    assert.equal(desktop.sends, 0);
  } finally {
    await restored?.stop(); if (!stopped) await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('旧设置补齐外观，活动任务可保存外观，非法字号不能覆盖有效设置', async () => {
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
    assert.equal(service.db.settings().appearance.bodyFontSize, 20);
    assert.equal(desktop.sends, 0);
    await service.stop(); stopped = true;
    restored = new MonitorService(directory, () => desktop);
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
    assert.equal(service.db.tasks()[0]!.phase, 'completed');
    assert.equal(service.db.tasks()[0]!.enabled, false);
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
    restored = new MonitorService(directory, () => desktop);
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
    restored = new MonitorService(directory, () => desktop, () => now);
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
    assert.equal(desktop.sends, 1); assert.equal(service.db.tasks()[0]!.phase, 'completed');
    assert.equal(service.db.tasks()[0]!.enabled, false);
    assert.equal(service.db.tasks()[0]!.evidence.sameThreadReply, true);
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
  const restored = new MonitorService(directory, () => desktop);
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
  const restored = new MonitorService(directory, () => desktop);
  try {
    assert.equal(restored.db.tasks()[0]!.enabled, false);
    assert.equal(restored.db.settings().callerThreadId, desktop.caller);
    assert.ok(restored.db.events().length >= 3);
  } finally { await restored.stop(); rmSync(directory, { recursive: true, force: true }); }
});
