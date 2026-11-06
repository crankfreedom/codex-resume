import { DatabaseSync } from 'node:sqlite';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eventPage, validateFilter } from './events.ts';
import { eventsJsonl } from './event-data.ts';
import type { EventFilter } from './contracts.ts';
// 独立只读连接维持同一 SQLite 快照，聚合更新或新增日志都不会改变本次导出。
export async function exportEventRange(database:string, destination:string, filter:EventFilter = {}, recent=false) {
  validateFilter(filter);
  const db=new DatabaseSync(database,{readOnly:true});
  const temporary=destination+'.partial-'+randomUUID();
  let file:Awaited<ReturnType<typeof open>>|undefined;
  let count=0;
  try {
    db.exec('BEGIN');
    let cursor:number|undefined; const boundary=Number(db.prepare('SELECT coalesce(max(id),0) AS n FROM events').get()!.n);
    if (recent) { const row=db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 149').get(); cursor=row?Number(row.id)-1:undefined; }
    file=await open(temporary,'wx');
    do {
      const page=eventPage(db,filter,cursor,boundary,100,true);
      count+=page.events.length;
      if (page.events.length) await file.write(eventsJsonl(page.events.slice().reverse()));
      cursor=page.nextCursor;
    } while(cursor!==undefined);
    await file.sync(); await file.close(); file=undefined;
    db.exec('COMMIT'); await rename(temporary,destination); return count;
  } finally { await file?.close(); db.close(); await rm(temporary,{force:true}); }
}
