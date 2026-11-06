import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MonitorService } from '../src/app/service.ts';
import { exampleQuota } from '../src/scenarios.ts';
import { resetCardKey, resetExecutionGraceMs } from '../src/app/reset-cards.ts';
import { zonedDateTimeToEpoch, inputInTimeZone, formatInTimeZone } from '../src/app/reset-time.ts';
import type { ResetConsumeOutcome, ResetCreditPort, ResetRateLimits } from '../src/app/reset-cards.ts';
import type { CurrentGoal, ThreadView } from '../src/domain.ts';

const cardId = 'reset-card-opaque-0123456789abcdef';
const key = resetCardKey(cardId);
class FakeDesktop {
  target = randomUUID();
  view: ThreadView = { thread: { id: this.target, status: { type: 'idle' } }, turns: [] };
  async quota() { return exampleQuota(100, Date.now() + 3600000); }
  async call<T>() { return { pinnedThreads: [], threads: [] } as T; }
  async readThread() { return structuredClone(this.view); }
  async send() {}
  close() {}
}
class FakeReset implements ResetCreditPort {
  readCalls = 0;
  consumeCalls = 0;
  requests: Array<{ creditId: string; idempotencyKey: string }> = [];
  outcomes: ResetConsumeOutcome[] = ['reset'];
  consumeError?: Error;
  quota: ResetRateLimits = {
    accountId: 'fixture-account', ...exampleQuota(100, Date.now() + 3600000),
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: cardId, title: 'Full reset', description: null, status: 'available', resetType: 'codexRateLimits', grantedAt: 1700000000, expiresAt: 1900000000 }] },
  };
  async read() { this.readCalls++; return { quota: structuredClone(this.quota), userAgent: 'codex-test' }; }
  async consume(creditId: string, idempotencyKey: string) {
    this.consumeCalls++; this.requests.push({ creditId, idempotencyKey });
    if (this.consumeError) throw this.consumeError;
    return this.outcomes.shift() ?? 'reset';
  }
}
function setup(now: () => number) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-reset-test-'));
  const desktop = new FakeDesktop();
  const reset = new FakeReset();
  const service = new MonitorService(directory, () => desktop, now, () => null, () => reset);
  return { directory, desktop, reset, service, cleanup: async () => { try { await service.stop(); } catch { /* 已停止 */ } rmSync(directory, { recursive: true, force: true }); } };
}
async function schedule(service: MonitorService, localTime: string) {
  await service.command({ type: 'resetSchedule', cardKey: key, localTime, timeZone: 'Asia/Shanghai', confirmed: true });
  return service.db.resetAppointments().find(appointment => appointment.status === 'pending')!;
}

test('时区本地时间换算稳定，并正确格式化', () => {
  const epoch = zonedDateTimeToEpoch('2026-11-06T09:00', 'Asia/Shanghai');
  assert.equal(epoch, Date.UTC(2026, 10, 6, 1, 0));
  assert.equal(inputInTimeZone(epoch, 'Asia/Shanghai'), '2026-11-06T09:00');
  assert.match(formatInTimeZone(epoch, 'Asia/Shanghai'), /2026-11-06 09:00（Asia\/Shanghai）/);
  assert.throws(() => zonedDateTimeToEpoch('2026-02-30T10:00', 'Asia/Shanghai'), /无效/);
  assert.throws(() => zonedDateTimeToEpoch('2026-11-06T09:00', 'Not/AZone'), /时区无效/);
});

test('预约持久化、脱敏查询与同卡去重，未来时间零消费', async () => {
  const start = Date.UTC(2026, 10, 6, 0, 0);
  const { service, reset, directory, cleanup } = await setup(() => start);
  let restored: MonitorService | undefined;
  try {
    const appointment = await schedule(service, '2026-11-06T09:00');
    assert.equal(appointment.scheduledAt, Date.UTC(2026, 10, 6, 1, 0));
    assert.equal(appointment.creditId, cardId); assert.equal(appointment.accountFingerprint.length, 64);
    assert.equal(reset.consumeCalls, 0);
    const views = service.db.query({ type: 'resetAppointments' }).resetAppointments!;
    assert.equal(views.length, 1);
    assert.ok(!JSON.stringify(views).includes(cardId));
    assert.ok(!JSON.stringify(views).includes('fixture-account'));
    assert.equal(views[0]!.idSuffix, cardId.slice(-6));
    await assert.rejects(schedule(service, '2026-11-06T10:00'), /已有待执行/);
    await service.stop();
    restored = new MonitorService(directory, () => new FakeDesktop(), () => start, () => null, () => reset);
    assert.equal(restored.db.resetAppointments()[0]!.status, 'pending');
    assert.equal(reset.consumeCalls, 0);
  } finally { await restored?.stop(); await cleanup(); }
});

test('到期成功使用指定卡与持久化键，成功后刷新额度与卡片', async () => {
  const start = Date.UTC(2026, 10, 6, 0, 0);
  let now = start;
  const { service, reset, cleanup } = await setup(() => now);
  try {
    const appointment = await schedule(service, '2026-11-06T09:00');
    now = appointment.scheduledAt;
    await service.tick();
    assert.equal(reset.consumeCalls, 1);
    assert.equal(reset.requests[0]!.creditId, cardId);
    assert.equal(reset.requests[0]!.idempotencyKey, appointment.idempotencyKey);
    const done = service.db.resetAppointment(appointment.id);
    assert.equal(done.status, 'succeeded'); assert.equal(done.outcome, 'reset');
    assert.ok(reset.readCalls >= 2, '执行前复核与执行后刷新均应重新读取');
    assert.equal(service.db.resetAppointments()[0]!.requestId, appointment.idempotencyKey);
  } finally { await cleanup(); }
});

test('执行前账号切换、卡片失效、卡片到期均零消费且明确失败', async () => {
  const cases: Array<{ name: string; mutate: (reset: FakeReset) => void; reason: string }> = [
    { name: '账号切换', mutate: r => { r.quota.accountId = 'another-account'; }, reason: 'account_changed' },
    { name: '卡片状态不可用', mutate: r => { r.quota.rateLimitResetCredits!.credits![0]!.status = 'redeemed'; }, reason: 'credit_unavailable' },
    { name: '卡片到期', mutate: r => { r.quota.rateLimitResetCredits!.credits![0]!.expiresAt = 1500000000; }, reason: 'credit_expired' },
  ];
  for (const item of cases) {
    const start = Date.UTC(2026, 10, 6, 0, 0);
    let now = start;
    const { service, reset, cleanup } = await setup(() => now);
    try {
      const appointment = await schedule(service, '2026-11-06T09:00');
      item.mutate(reset);
      now = appointment.scheduledAt;
      await service.tick();
      assert.equal(reset.consumeCalls, 0, item.name);
      assert.equal(service.db.resetAppointment(appointment.id).status, 'failed', item.name);
      assert.equal(service.db.resetAppointment(appointment.id).reason, item.reason, item.name);
    } finally { await cleanup(); }
  }
});

test('取消预约零消费；休眠错过时间默认已错过且重启不补用', async () => {
  const start = Date.UTC(2026, 10, 6, 0, 0);
  let now = start;
  const { service, reset, directory, cleanup } = await setup(() => now);
  let restored: MonitorService | undefined;
  try {
    const cancelTarget = await schedule(service, '2026-11-06T09:00');
    await service.command({ type: 'resetCancel', id: cancelTarget.id });
    assert.equal(service.db.resetAppointment(cancelTarget.id).status, 'cancelled');
    const missed = await schedule(service, '2026-11-06T10:00');
    now = missed.scheduledAt + resetExecutionGraceMs + 1;
    await service.tick();
    assert.equal(reset.consumeCalls, 0);
    assert.equal(service.db.resetAppointment(missed.id).status, 'missed');
    // 重启时已过期的待执行预约直接标记已错过。
    const overdue = await schedule(service, '2026-11-06T11:00');
    await service.stop();
    now = overdue.scheduledAt + 1;
    restored = new MonitorService(directory, () => new FakeDesktop(), () => now, () => null, () => reset);
    assert.equal(restored.db.resetAppointment(overdue.id).status, 'missed');
    assert.equal(reset.consumeCalls, 0);
  } finally { await restored?.stop(); await cleanup(); }
});

test('响应不确定保留原请求 ID，人工核对复用同键成功且不盲目重试', async () => {
  const start = Date.UTC(2026, 10, 6, 0, 0);
  let now = start;
  const { service, reset, cleanup } = await setup(() => now);
  try {
    const appointment = await schedule(service, '2026-11-06T09:00');
    reset.consumeError = new Error('模拟超时');
    now = appointment.scheduledAt;
    await service.tick();
    assert.equal(service.db.resetAppointment(appointment.id).status, 'uncertain');
    assert.equal(reset.consumeCalls, 1);
    await service.tick(); // 不得自动重试。
    assert.equal(reset.consumeCalls, 1);
    reset.consumeError = undefined; reset.outcomes = ['alreadyRedeemed'];
    await service.command({ type: 'resetReconcile', id: appointment.id });
    assert.equal(reset.consumeCalls, 2);
    assert.equal(reset.requests[0]!.idempotencyKey, reset.requests[1]!.idempotencyKey);
    assert.equal(reset.requests[0]!.creditId, reset.requests[1]!.creditId);
    assert.equal(service.db.resetAppointment(appointment.id).status, 'succeeded');
    assert.equal(service.db.resetAppointment(appointment.id).attempts, 2);
  } finally { await cleanup(); }
});

test('执行中重启转为结果不确定，不自动补用，仅可原键核对', async () => {
  const start = Date.UTC(2026, 10, 6, 0, 0);
  const { service, reset, directory, cleanup } = await setup(() => start);
  let restored: MonitorService | undefined;
  try {
    const appointment = await schedule(service, '2026-11-06T09:00');
    service.db.claimResetAppointment(appointment.id, start);
    await service.stop();
    restored = new MonitorService(directory, () => new FakeDesktop(), () => start, () => null, () => reset);
    assert.equal(restored.db.resetAppointment(appointment.id).status, 'uncertain');
    assert.equal(reset.consumeCalls, 0);
    await restored.tick();
    assert.equal(reset.consumeCalls, 0);
  } finally { await restored?.stop(); await cleanup(); }
});
