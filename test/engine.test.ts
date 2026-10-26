import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, ResumeEngine } from '../src/engine.ts';
import { fingerprint, isUsageLimit, quotaGate } from '../src/domain.ts';
import type { Job, Journal, Quota } from '../src/domain.ts';
import { exampleQuota, HybridDesktop, quotaFailure, SimulatedDesktop, VirtualClock } from '../src/scenarios.ts';
import { FileJournal } from '../src/store.ts';

class MemoryJournal implements Journal {
  saves: Job[] = [];
  events: Array<{ type: string; details: unknown }> = [];
  save(job: Job) { this.saves.push(structuredClone(job)); }
  event(type: string, details?: unknown) { this.events.push({ type, details }); }
}
async function setup() {
  const clock = new VirtualClock();
  const port = new SimulatedDesktop(clock);
  const job = await createJob(port, { callerThreadId: 'caller', targetThreadId: 'simulation-thread', mode: 'simulation', now: clock.now() });
  const journal = new MemoryJournal();
  const engine = new ResumeEngine(job, port, clock, journal);
  return { clock, port, job, journal, engine };
}

test('成功提交后长时间找不到投递回执，停止自动核验并转为人工处理', async () => {
  const { job, clock, engine, port } = await setup();
  job.phase = 'verifying'; job.sentAt = clock.now() - 180001;
  await engine.step();
  assert.equal(job.phase, 'send_uncertain'); assert.equal(port.sends, 0);
});

test('额度窗口使用秒级恢复时间，两个窗口都耗尽时等待较晚恢复时间', () => {
  const quota = exampleQuota(100, 1800000010000);
  quota.rateLimitsByLimitId!.codex!.secondary!.usedPercent = 100;
  quota.rateLimitsByLimitId!.codex!.secondary!.resetsAt = 1800000020;
  const gate = quotaGate(quota, 'codex', 1800000000000);
  assert.equal(gate.available, false);
  assert.equal(gate.nextCheckAt, 1800000025000);
});
test('缺失额度、缺失桶、未知周额度均不视为剩余充足', () => {
  for (const quota of [{}, { rateLimitsByLimitId: {}, rateLimits: exampleQuota(0, 1800000010000).rateLimitsByLimitId!.codex },
    { rateLimits: { primary: { usedPercent: 0 }, secondary: null } },
    { rateLimits: { primary: { usedPercent: NaN }, secondary: { usedPercent: 0 } } }] as Quota[]) {
    assert.equal(quotaGate(quota, 'codex', 1800000000000).available, false);
  }
});
test('时间到达仍不能替代服务端恢复证明', () => {
  const quota = exampleQuota(100, 1799990000000);
  const gate = quotaGate(quota, 'codex', 1800000000000);
  assert.equal(gate.available, false);
  assert.ok(gate.nextCheckAt > 1800000000000);
});
test('全局禁止访问或服务端限额标记优先于百分比', () => {
  const quota = exampleQuota(0, 1800000010000);
  quota.ordinaryUsageAllowed = false;
  assert.equal(quotaGate(quota, 'codex', 1800000000000).available, false);
  quota.ordinaryUsageAllowed = true;
  quota.rateLimitsByLimitId!.codex!.rateLimitReachedType = 'reached';
  assert.equal(quotaGate(quota, 'codex', 1800000000000).available, false);
});
test('额度错误只从服务端结构字段识别，普通回复或429不构成续跑授权', () => {
  assert.ok(isUsageLimit({ codexErrorInfo: { usageLimitExceeded: {} } }));
  assert.ok(isUsageLimit({ code: 'usage_limit_exceeded' }));
  assert.ok(isUsageLimit({ message: "You've hit your usage limit" }));
  assert.equal(isUsageLimit({ message: '网络429' }), false);
  assert.equal(isUsageLimit({ text: 'UsageLimitExceeded' }), false);
});
test('额度恢复前零发送，恢复后原会话恰好续跑一次并得到回执', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  assert.equal(job.phase, 'waiting_quota');
  assert.equal(port.sends, 0);
  await clock.sleep(9999);
  await engine.step();
  assert.equal(port.sends, 0);
  await clock.sleep(6001);
  await engine.step();
  await engine.step();
  assert.equal(job.phase, 'completed');
  assert.equal(port.sends, 1);
  assert.ok(port.sentAt! >= port.resetAt);
  await engine.step();
  assert.equal(port.sends, 1);
  assert.equal(job.evidence.serverLimitObserved, false);
});
test('五小时恢复但每周仍耗尽时继续等待', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  const quota = exampleQuota(0, clock.now() + 10000);
  quota.rateLimitsByLimitId!.codex!.secondary!.usedPercent = 100;
  port.quotaOverride = quota;
  await engine.step();
  assert.equal(job.phase, 'waiting_quota');
  assert.equal(port.sends, 0);
});
test('运行中的 fair-use 轮次即使额度耗尽也不打断、不追加消息', async () => {
  const { port, job, engine } = await setup();
  port.view.thread.status = { type: 'active' };
  port.view.turns[0]!.status = 'inProgress';
  await engine.step();
  assert.equal(job.phase, 'observing');
  assert.equal(port.sends, 0);
});
test('完成、一般失败与主动中断不能触发额度自动续跑', async () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const { port, job, engine } = await setup();
    port.view.turns[0]!.status = status;
    port.view.turns[0]!.error = { code: 'HttpConnectionFailed' };
    await engine.step();
    assert.equal(job.phase, 'suspended');
    assert.equal(port.sends, 0);
  }
});
test('等待审批的会话不能发送', async () => {
  const { port, job, engine } = await setup();
  port.view.thread.status = { type: 'idle', activeFlags: ['waitingOnApproval'] };
  await engine.step();
  assert.equal(job.phase, 'suspended');
  assert.equal(port.sends, 0);
});
test('等待期间人工恢复或追加消息会停止自动续跑', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  port.view.turns.unshift({ id: 'manual-turn', status: 'completed' });
  await engine.step();
  assert.equal(job.reason, 'thread_changed_since_block');
  assert.equal(port.sends, 0);
});
test('额度查询期间的人工操作由最终会话检查拦截', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  const original = port.quota.bind(port);
  port.quota = async () => {
    const quota = await original();
    port.view.turns.unshift({ id: 'manual-race', status: 'inProgress' });
    port.view.thread.status = { type: 'active' };
    return quota;
  };
  await engine.step();
  assert.equal(job.reason, 'manual_activity_or_approval');
  assert.equal(port.sends, 0);
});
test('账号切换导致暂停，不把新账号额度用于旧任务', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  port.quotaOverride = { ...exampleQuota(0, clock.now()), accountId: 'other-account' };
  await engine.step();
  assert.equal(job.reason, 'account_changed');
  assert.equal(port.sends, 0);
});
test('写入发送意图之后才触碰桌面发送接口', async () => {
  const { clock, port, journal, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  const send = port.send.bind(port);
  port.send = async (id, prompt) => {
    assert.equal(journal.saves.at(-1)!.phase, 'sending');
    assert.equal(journal.saves.at(-1)!.resumeCount, 1);
    await send(id, prompt);
  };
  await engine.step();
});
test('发送响应丢失时不重试，通过回执对账可完成', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step();
  await clock.sleep(20000);
  port.sendError = new Error('响应超时，但桌面已收件');
  await engine.step();
  assert.equal(job.phase, 'send_uncertain');
  await engine.step();
  assert.equal(port.sends, 1);
  await engine.reconcile();
  assert.equal(job.phase, 'completed');
  assert.equal(port.sends, 1);
});
test('发送失败且没有回执时保持不确定状态，绝不盲目补发', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step(); await clock.sleep(20000);
  port.sendError = new Error('未知'); port.dropReceipt = true;
  await engine.step(); await engine.reconcile();
  assert.equal(job.phase, 'send_uncertain');
  assert.equal(port.sends, 1);
});
test('重启时遇到 sending 意图只转为不确定，不重复发送', async () => {
  const { port, job, engine } = await setup();
  job.phase = 'sending'; job.resumeCount = 1;
  await engine.step();
  assert.equal(job.phase, 'send_uncertain');
  assert.equal(port.sends, 0);
});
test('等待状态持久化后重建引擎仍只发送一次', async () => {
  const { clock, port, job, journal, engine } = await setup();
  await engine.step();
  const restored = structuredClone(journal.saves.at(-1)!);
  await clock.sleep(20000);
  const restarted = new ResumeEngine(restored, port, clock, journal);
  await restarted.step(); await restarted.step();
  assert.equal(restored.phase, 'completed');
  assert.equal(port.sends, 1);
  assert.equal(job.phase, 'waiting_quota');
});
test('另一条人工轮次的回执不能被认作本次续跑', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step(); await clock.sleep(20000); await engine.step();
  port.view.turns[0]!.items = [{ type: 'agentMessage', text: job.marker }];
  await engine.step();
  assert.equal(job.phase, 'verifying');
});
test('标记回执验证会发现非预期工具动作', async () => {
  const { clock, port, job, engine } = await setup();
  await engine.step(); await clock.sleep(20000); await engine.step();
  port.view.turns[0]!.items!.push({ type: 'commandExecution' });
  await engine.step();
  assert.equal(job.reason, 'validation_reply_or_actions_mismatch');
});
test('业务提示词也携带投递标记以对账，但不强制纯文本回执', async () => {
  const { clock, port, journal } = await setup();
  const job = await createJob(port, { callerThreadId: 'caller', targetThreadId: 'simulation-thread', mode: 'live', now: clock.now(), prompt: '继续已有工作' });
  assert.ok(job.prompt.includes(job.marker));
  assert.equal(job.verifyMarker, false);
  const engine = new ResumeEngine(job, port, clock, journal);
  await engine.step(); await clock.sleep(20000); await engine.step(); await engine.step();
  assert.equal(job.phase, 'completed');
});
test('混合测试到时后仍以真实账号额度为准，真实每周耗尽不会发送', async () => {
  const clock = new VirtualClock();
  const real = new SimulatedDesktop(clock);
  real.view.turns[0]!.status = 'completed'; real.view.turns[0]!.error = null;
  const hybrid = new HybridDesktop(real, 'simulation-thread', 'blocked-turn', clock.now() + 10000, clock);
  const job = await createJob(hybrid, { callerThreadId: 'caller', targetThreadId: 'simulation-thread', mode: 'hybrid', now: clock.now() });
  const engine = new ResumeEngine(job, hybrid, clock, new MemoryJournal());
  await engine.step(); await clock.sleep(20000);
  real.quotaOverride = exampleQuota(0, clock.now());
  real.quotaOverride.rateLimitsByLimitId!.codex!.secondary!.usedPercent = 100;
  await engine.step();
  assert.equal(real.sends, 0);
  assert.equal(job.phase, 'waiting_quota');
});
test('文件状态原子保存并可恢复，损坏文件不运行；同一任务不能双开', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-test-'));
  try {
    const journal = new FileJournal(join(directory, 'job.json'), false);
    const { job } = await setup();
    journal.save(job);
    assert.deepEqual(journal.load(), job);
    const release = journal.lock();
    assert.throws(() => journal.lock(), /已有锁/);
    assert.throws(() => journal.unlock(), /仍运行/);
    release();
    const releaseAgain = journal.lock(); releaseAgain();
    writeFileSync(journal.path, '{"version":1}');
    assert.throws(() => journal.load(), /状态无效/);
    assert.equal(readFileSync(journal.path, 'utf8'), '{"version":1}');
  } finally { rmSync(directory, { recursive: true }); }
});

test('不同作业文件监控同一目标时也必须互斥，初始登记不可覆盖', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-lock-test-'));
  try {
    const first = new FileJournal(join(directory, 'first.json'), false);
    const second = new FileJournal(join(directory, 'second.json'), false);
    const { job } = await setup();
    first.create(job); second.create(job);
    assert.throws(() => first.create(job), /EEXIST/);
    const releaseFirst = first.lock(job.targetThreadId);
    assert.throws(() => second.lock(job.targetThreadId), /已有锁/);
    releaseFirst();
    const releaseSecond = second.lock(job.targetThreadId); releaseSecond();
  } finally { rmSync(directory, { recursive: true }); }
});

test('主动中断即使保留旧额度错误也不自动恢复', async () => {
  const { port, job, engine } = await setup();
  port.view.turns[0]!.status = 'interrupted';
  await engine.step();
  assert.equal(job.phase, 'suspended');
  assert.equal(port.sends, 0);
});

test('只看到历史额度错误和当前充足额度，不宣称已验证跨窗口等待', async () => {
  const { clock, port, journal } = await setup();
  await clock.sleep(20000);
  const job = await createJob(port, { callerThreadId: 'caller', targetThreadId: 'simulation-thread', mode: 'live', now: clock.now() });
  const engine = new ResumeEngine(job, port, clock, journal);
  await engine.step(); await engine.step();
  assert.equal(job.phase, 'completed');
  assert.equal(job.evidence.serverQuotaBlockedObserved, false);
  assert.equal(job.evidence.serverRecoveryObserved, false);
  const completed = journal.events.find((event) => event.type === 'completed')!.details as { verdict: string };
  assert.equal(completed.verdict, 'live_resume_verified');
});

test('显式跟随聊天可在正常完成后继续观察，但不会续跑已完成轮次', async () => {
  const { clock, port, job, engine } = await setup();
  job.followSession = true;
  port.view.turns[0]!.status = 'completed';
  await engine.step(); await engine.step();
  assert.equal(job.phase, 'observing');
  assert.equal(port.sends, 0);
  port.view = quotaFailure('later-real-turn');
  await engine.step();
  assert.equal(job.phase, 'waiting_quota');
  await clock.sleep(20000);
  await engine.step(); await engine.step();
  assert.equal(job.phase, 'completed');
  assert.equal(port.sends, 1);
});
