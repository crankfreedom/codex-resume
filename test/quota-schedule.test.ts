import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaGate } from '../src/domain.ts';
import { exampleQuota } from '../src/scenarios.ts';
import { defaultQuotaCheck, nextDailyQuotaCheck, normalizeQuotaCheck, quotaCheckAt, validateQuotaCheck } from '../src/app/quota-schedule.ts';

const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
const recovery = { ...defaultQuotaCheck, recoveryDelayMinutes: 1, dailyResetCheck: false };

test('预计三小时恢复时等待三小时一分钟，固定模式仍按配置间隔查询', () => {
  const quota = quotaGate(exampleQuota(100, now + 3 * 3600000), 'codex', now);
  assert.equal(quotaCheckAt(quota, now, recovery), now + 3 * 3600000 + 60000);
  assert.equal(quotaCheckAt(quota, now, { ...recovery, mode: 'fixed', intervalSeconds: 30 }), now + 30000);
});

test('两个窗口耗尽时选择较晚恢复时间，并应用配置缓冲', () => {
  const quota = exampleQuota(100, now + 3600000);
  quota.rateLimitsByLimitId!.codex!.secondary = { usedPercent: 100, resetsAt: (now + 7 * 3600000) / 1000 };
  assert.equal(quotaCheckAt(quotaGate(quota, 'codex', now), now, { ...recovery, recoveryDelayMinutes: 2 }), now + 7 * 3600000 + 120000);
});

test('额度可用、未知、恢复时间缺失或已过期时按兜底间隔查询', () => {
  const missing = exampleQuota(100, now + 3600000);
  delete missing.rateLimitsByLimitId!.codex!.primary!.resetsAt;
  const incomplete = exampleQuota(100, now + 3600000);
  incomplete.rateLimitsByLimitId!.codex!.secondary = null;
  for (const quota of [exampleQuota(0, now), {}, missing, incomplete, exampleQuota(100, now - 600000)]) {
    assert.equal(quotaCheckAt(quotaGate(quota, 'codex', now), now, recovery), now + recovery.intervalSeconds * 1000);
  }
});

test('两个受限窗口中任一恢复时间未知时不进行长时间盲等', () => {
  const quota = exampleQuota(100, now + 3600000);
  quota.rateLimitsByLimitId!.codex!.secondary = { usedPercent: 100 };
  assert.equal(quotaCheckAt(quotaGate(quota, 'codex', now), now, recovery), now + 60000);
});

test('每日本地零点十分会提前唤醒两种模式，关闭后不再插入检查', () => {
  const before = new Date(2026, 9, 26, 0, 9, 0).getTime();
  const daily = new Date(2026, 9, 26, 0, 10, 0).getTime();
  const quota = quotaGate(exampleQuota(100, before + 3 * 3600000), 'codex', before);
  for (const mode of ['recovery', 'fixed'] as const) {
    const settings = { ...defaultQuotaCheck, mode, intervalSeconds: 3600 };
    assert.equal(quotaCheckAt(quota, before, settings), daily);
    assert.ok(quotaCheckAt(quota, before, { ...settings, dailyResetCheck: false }) > daily);
  }
});

test('零点十分执行后安排下一天，跨月与跨年保持本地日历时间', () => {
  for (const [year, month, day] of [[2026, 9, 31], [2026, 11, 31]]) {
    const time = new Date(year!, month!, day!, 0, 10, 0).getTime();
    assert.equal(nextDailyQuotaCheck(time), new Date(year!, month!, day! + 1, 0, 10, 0).getTime());
  }
});

test('旧额度配置补默认值，非法模式与越界参数不能保存', () => {
  assert.deepEqual(normalizeQuotaCheck(undefined), defaultQuotaCheck);
  for (const patch of [{ mode: 'other' }, { intervalSeconds: 0 }, { intervalSeconds: 3601 },
    { recoveryDelayMinutes: -1 }, { recoveryDelayMinutes: 61 }, { dailyResetCheck: 'true' }]) {
    assert.throws(() => validateQuotaCheck({ ...defaultQuotaCheck, ...patch }), /额度查询设置无效/);
  }
});
