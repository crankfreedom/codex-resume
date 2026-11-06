function timeParts(epoch: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}
function assertTimeZone(timeZone: string) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) throw new Error('时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new Error('时区无效'); }
}
export function zonedDateTimeToEpoch(localTime: string, timeZone: string): number {
  assertTimeZone(timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error('执行日期和时间格式无效');
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const date = new Date(target);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59) throw new Error('执行日期和时间无效');
  let candidate = target;
  for (let index = 0; index < 4; index++) {
    const parts = timeParts(candidate, timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const adjustment = target - represented;
    candidate += adjustment;
    if (!adjustment) return candidate;
  }
  throw new Error('该时区下不存在此本地时间，请重新选择');
}
export function inputInTimeZone(epoch: number, timeZone: string): string {
  assertTimeZone(timeZone);
  const part = timeParts(epoch, timeZone);
  return `${part.year.toString().padStart(4, '0')}-${part.month.toString().padStart(2, '0')}-${part.day.toString().padStart(2, '0')}T${part.hour.toString().padStart(2, '0')}:${part.minute.toString().padStart(2, '0')}`;
}
export function formatInTimeZone(epoch: number, timeZone: string): string {
  assertTimeZone(timeZone);
  return `${inputInTimeZone(epoch, timeZone).replace('T', ' ')}（${timeZone}）`;
}
