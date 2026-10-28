export interface QuotaCheckSettings {
  intervalSeconds: number;
}

export const defaultQuotaCheck: QuotaCheckSettings = {
  intervalSeconds: 600,
};

export function validateQuotaCheck(value: unknown): QuotaCheckSettings {
  if (!value || typeof value !== 'object') throw new Error('额度查询设置无效');
  const settings = value as QuotaCheckSettings;
  if (!Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 10 || settings.intervalSeconds > 3600)
    throw new Error('额度查询设置无效');
  return { intervalSeconds: settings.intervalSeconds };
}

export function normalizeQuotaCheck(value: unknown): QuotaCheckSettings {
  // 旧预计恢复模式的间隔只是兜底参数，迁移时改用十分钟；旧固定间隔保留。
  if (value && typeof value === 'object' && 'mode' in value && value.mode !== 'fixed') return { ...defaultQuotaCheck };
  try { return validateQuotaCheck({ ...defaultQuotaCheck, ...(value && typeof value === 'object' ? value : {}) }); }
  catch { return { ...defaultQuotaCheck }; }
}

export function quotaCheckAt(now: number, settings: QuotaCheckSettings): number {
  return now + settings.intervalSeconds * 1000;
}
