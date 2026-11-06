import type { DatabaseSync } from 'node:sqlite';
import type { EventFilter, EventRow } from './contracts.ts';
export function validateFilter(value: EventFilter = {}): EventFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('日志筛选无效');
  for (const key of Object.keys(value)) if (!['taskId','from','to','type','reason'].includes(key)) throw new Error('未知日志筛选');
  for (const key of ['taskId','type','reason'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key]!.length > 200)) throw new Error('日志筛选文本无效');
  for (const key of ['from','to'] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < 0)) throw new Error('日志日期无效');
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) throw new Error('日志日期顺序无效');
  return value;
}
export function eventRow(row: Record<string, unknown>): EventRow {
  return {id:Number(row.id),time:Number(row.time),taskId:row.task_id == null?null:String(row.task_id),taskName:row.task_name == null?null:String(row.task_name),type:String(row.type),details:JSON.parse(String(row.details))};
}
export function eventPage(db: DatabaseSync, filter: EventFilter = {}, cursor?: number, boundary?: number, limit = 50, ascending = false) {
  validateFilter(filter);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页大小必须为 1–100');
  for (const value of [cursor,boundary]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('分页游标无效');
  boundary ??= Number(db.prepare('SELECT coalesce(max(id),0) AS n FROM events').get()!.n);
  const clauses = ['id<=?']; const args: (string|number)[]=[boundary];
  if (cursor !== undefined) {clauses.push(ascending?'id>?':'id<?');args.push(cursor);}
  if (filter.taskId) {clauses.push('task_id=?');args.push(filter.taskId);}
  if (filter.from !== undefined) {clauses.push('time>=?');args.push(filter.from);}
  if (filter.to !== undefined) {clauses.push('time<?');args.push(filter.to);}
  if (filter.type) {clauses.push('type=?');args.push(filter.type);}
  if (filter.reason) {clauses.push("instr(coalesce(json_extract(details,'$.reason'),json_extract(details,'$.observation.latestTurn.error.message'),''),?)>0");args.push(filter.reason);}
  const rows=db.prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY id ${ascending?'ASC':'DESC'} LIMIT ?`).all(...args,limit+1).map(eventRow);
  const more=rows.length>limit; const events=rows.slice(0,limit);
  return {events,boundary,nextCursor:more?events.at(-1)!.id:undefined};
}
