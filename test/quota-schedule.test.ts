import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultQuotaCheck, normalizeQuotaCheck, quotaCheckAt, validateQuotaCheck } from '../src/app/quota-schedule.ts';

test('新配置默认每十分钟检查，未配置和非法旧值回退默认', () => {
  assert.deepEqual(defaultQuotaCheck, { intervalSeconds: 600 });
  for (const value of [undefined, null, {}, 'invalid', { intervalSeconds: 0 }]) {
    assert.deepEqual(normalizeQuotaCheck(value), defaultQuotaCheck);
  }
});

test('旧预计恢复模式改为十分钟，移除缓冲与每日开关', () => {
  assert.deepEqual(normalizeQuotaCheck({
    mode: 'recovery', intervalSeconds: 60, recoveryDelayMinutes: 10, dailyResetCheck: true,
  }), { intervalSeconds: 600 });
});

test('保留旧固定模式和新配置的自定义间隔，不保留已移除字段', () => {
  assert.deepEqual(normalizeQuotaCheck({
    mode: 'fixed', intervalSeconds: 120, recoveryDelayMinutes: 2, dailyResetCheck: true,
  }), { intervalSeconds: 120 });
  assert.deepEqual(normalizeQuotaCheck({ intervalSeconds: 30 }), { intervalSeconds: 30 });
});

test('跨越零点十分仍按十分钟定期检查，跨月和跨年不插入每日查询', () => {
  for (const [year, month, day] of [[2026, 9, 26], [2026, 9, 31], [2026, 11, 31]]) {
    const now = new Date(year!, month!, day!, 0, 9, 0).getTime();
    assert.equal(quotaCheckAt(now, defaultQuotaCheck), now + 600000);
    const midnight = new Date(year!, month!, day!, 23, 59, 0).getTime();
    assert.equal(quotaCheckAt(midnight, defaultQuotaCheck), midnight + 600000);
  }
});

test('间隔允许十秒至一小时，非整数和越界参数不能保存', () => {
  for (const intervalSeconds of [10, 600, 3600]) {
    assert.deepEqual(validateQuotaCheck({ intervalSeconds }), { intervalSeconds });
  }
  for (const value of [null, {}, { intervalSeconds: 0 }, { intervalSeconds: 9 },
    { intervalSeconds: 3601 }, { intervalSeconds: 10.5 }, { intervalSeconds: '600' }]) {
    assert.throws(() => validateQuotaCheck(value), /额度查询设置无效/);
  }
});
