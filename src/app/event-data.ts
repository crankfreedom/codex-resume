import type { EventRow } from './contracts.ts';

const millisecondFields = new Set(['time', 'createdAt', 'updatedAt', 'checkedAt', 'nextCheckAt', 'nextQuotaCheckAt', 'heartbeatAt']);

/** 按本机时区输出固定精度，数据库和调度仍使用原始时间戳。 */
export function formatDataTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间无效';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function readableValue(value: unknown, key = ''): unknown {
  if (typeof value === 'number' && (millisecondFields.has(key) || key === 'resetsAt')) {
    return formatDataTime(key === 'resetsAt' ? value * 1000 : value);
  }
  if (Array.isArray(value)) return value.map(item => readableValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, readableValue(item, name)]));
  }
  return value;
}

export function readableEvent(event: EventRow) {
  return { ...event, time: formatDataTime(event.time), details: readableValue(event.details) as Record<string, unknown> };
}

/** 保留 JSONL 每行一个事件及从旧到新的导出顺序。 */
export function eventsJsonl(events: EventRow[]): string {
  return events.slice().reverse().map(event => JSON.stringify(readableEvent(event))).join('\n') + (events.length ? '\n' : '');
}
