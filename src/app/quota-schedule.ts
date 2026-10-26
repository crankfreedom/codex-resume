import type { QuotaWindow } from '../domain.ts';

export interface QuotaCheckSettings {
  mode: 'recovery' | 'fixed';
  intervalSeconds: number;
  recoveryDelayMinutes: number;
  dailyResetCheck: boolean;
}

export const defaultQuotaCheck: QuotaCheckSettings = {
  mode: 'recovery', intervalSeconds: 60, recoveryDelayMinutes: 1, dailyResetCheck: true,
};

export function validateQuotaCheck(value: unknown): QuotaCheckSettings {
  if (!value || typeof value !== 'object') throw new Error('额度查询设置无效');
  const settings = value as QuotaCheckSettings;
  if (!['recovery', 'fixed'].includes(settings.mode)
    || !Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 10 || settings.intervalSeconds > 3600
    || !Number.isInteger(settings.recoveryDelayMinutes) || settings.recoveryDelayMinutes < 0 || settings.recoveryDelayMinutes > 60
    || typeof settings.dailyResetCheck !== 'boolean') throw new Error('额度查询设置无效');
  return { mode: settings.mode, intervalSeconds: settings.intervalSeconds,
    recoveryDelayMinutes: settings.recoveryDelayMinutes, dailyResetCheck: settings.dailyResetCheck };
}

export function normalizeQuotaCheck(value: unknown): QuotaCheckSettings {
  try { return validateQuotaCheck({ ...defaultQuotaCheck, ...(value && typeof value === 'object' ? value : {}) }); }
  catch { return { ...defaultQuotaCheck }; }
}

export function nextDailyQuotaCheck(now: number): number {
  const next = new Date(now);
  next.setHours(0, 10, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function quotaCheckAt(quota: { reason: string; windows: Array<QuotaWindow | null> } | null, now: number, settings: QuotaCheckSettings): number {
  let next = now + settings.intervalSeconds * 1000;
  if (quota && settings.mode === 'recovery') {
    const blocked = quota.windows.filter(window => window && window.usedPercent! >= 100);
    if (quota.reason === 'quota_blocked' && blocked.length && blocked.every(window =>
      typeof window!.resetsAt === 'number' && Number.isFinite(window!.resetsAt) && window!.resetsAt! > 0)) {
      const recovery = Math.max(...blocked.map(window => window!.resetsAt!)) * 1000 + settings.recoveryDelayMinutes * 60000;
      // 过期或缺失的预计时间不能导致忙循环，也不能据此认定额度已恢复。
      if (Number.isFinite(recovery) && recovery > now) next = recovery;
    }
  }
  return settings.dailyResetCheck ? Math.min(next, nextDailyQuotaCheck(now)) : next;
}
