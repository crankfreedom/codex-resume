import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/app/database.ts';

test('旧库事务升级到 v3，四表原值及累计次数保留，重开幂等，未知高版拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-migration-')); const path = join(dir, 'fixture.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE settings(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,target TEXT,title TEXT,enabled INTEGER,job TEXT,updated INTEGER,last_error TEXT);
      CREATE TABLE attempts(marker TEXT PRIMARY KEY,task_id TEXT,created INTEGER,phase TEXT,turn_id TEXT);
      CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER,task_id TEXT,type TEXT,details TEXT,task_name TEXT);
      INSERT INTO settings VALUES(1,'{"pollSeconds":30}');
      INSERT INTO tasks VALUES('task','target','旧任务',1,'{"resumeCount":2,"prompt":"原授权"}',123,NULL);
      INSERT INTO attempts VALUES('marker','task',100,'send_uncertain',NULL);
      INSERT INTO events VALUES(1,100,'task','quota_checked','{}','旧任务'); PRAGMA user_version=2;`);
    old.close();
    for (let i=0;i<2;i++) {
      const db = new AppDatabase(path);
      assert.equal(db.db.prepare('PRAGMA user_version').get()!.user_version,4);
      assert.deepEqual(JSON.parse(String(db.db.prepare('SELECT job FROM tasks').get()!.job)),{resumeCount:2,prompt:'原授权'});
      assert.equal(db.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n,1);
      assert.equal(db.db.prepare('SELECT slot FROM attempts').get()!.slot,'held');
      assert.equal(db.events()[0]!.taskName,'旧任务'); assert.equal(db.settings().pollSeconds,30); db.close();
    }
    const future = new DatabaseSync(path); future.exec('PRAGMA user_version=99'); future.close();
    assert.throws(()=>new AppDatabase(path),/拒绝降级/);
    const verify = new DatabaseSync(path); assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version,99); verify.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

import { exportEventRange } from '../src/app/export.ts';

test('日志超过150条、同时间稳定游标、日期与异常筛选、快照批次导出不重复遗漏',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'resume-events-')); const path=join(dir,'test.sqlite'); const db=new AppDatabase(path);
  try {
    for(let i=0;i<251;i++) db.db.prepare('INSERT INTO events(time,task_id,task_name,type,details) VALUES(?,?,?,?,?)').run(1000,'t','任务',i%2?'quota_checked':'suspended',JSON.stringify({reason:i%2?'quota_blocked':'account_changed'}));
    let page=db.query({type:'events',limit:50}); const ids:number[]=[];
    while(true) {ids.push(...page.events!.map(e=>e.id));if(page.nextCursor===undefined)break;page=db.query({type:'events',limit:50,cursor:page.nextCursor,boundary:page.boundary});}
    assert.equal(new Set(ids).size,251);assert.equal(ids.length,251);assert.equal(ids[0],251);assert.equal(ids.at(-1),1);
    assert.equal(db.query({type:'events',filter:{from:1000,to:1001,type:'suspended',reason:'account'},limit:100}).events!.length,100);
    assert.equal(db.query({type:'events',filter:{from:1001}}).events!.length,0);
    assert.throws(()=>db.query({type:'events',limit:101}),/分页/);
    const pending=exportEventRange(path,join(dir,'all.jsonl'),{});
    db.event(null,'late'); db.db.prepare("UPDATE events SET details='{}' WHERE id=1").run();
    assert.equal(await pending,251);
    const rows=readFileSync(join(dir,'all.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(rows.map(e=>e.id),Array.from({length:251},(_,i)=>i+1));assert.equal(rows[0].details.reason,'account_changed');
    assert.equal(await exportEventRange(path,join(dir,'recent.jsonl'),{},true),150);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('迁移失败回滚，未留下新列或新版本',()=>{
  const dir=mkdtempSync(join(tmpdir(),'resume-rollback-')); const path=join(dir,'test.sqlite');
  try {
    const old=new DatabaseSync(path);old.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,target TEXT,title TEXT,enabled INTEGER,job TEXT,updated INTEGER,last_error TEXT);
      CREATE TABLE attempts(marker TEXT PRIMARY KEY,broken_task_id TEXT,created INTEGER,phase TEXT,turn_id TEXT);
      CREATE TABLE archives(broken TEXT); PRAGMA user_version=2;`);old.close();
    assert.throws(()=>new AppDatabase(path));
    const verify=new DatabaseSync(path);assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version,2);
    assert.equal(verify.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='config'),false);verify.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

import { lifecycle } from '../src/app/timeline.ts';
test('生命周期区分接收、匹配和轮次结束，缺证据不推算、时钟回拨显示未知',()=>{
  const attempt={marker:'m',created:1,phase:'verifying',turnId:'own',revision:2,slot:'held'};
  const rows=[{id:1,time:1000,taskId:'t',taskName:'任务',type:'send_intent_persisted',details:{marker:'m'}},
    {id:2,time:1200,taskId:'t',taskName:'任务',type:'resume_submitted',details:{marker:'m'}},
    {id:3,time:1500,taskId:'t',taskName:'任务',type:'resume_receipt_matched',details:{marker:'m'}}];
  assert.equal(lifecycle(rows,[attempt])[0]!.receipt,'0.5 秒');assert.match(lifecycle(rows,[attempt])[0]!.run,/进行中/);
  assert.match(lifecycle(rows,[attempt])[0]!.wait,/未知/);
  rows.push({id:4,time:900,taskId:'t',taskName:'任务',type:'delivery_turn_finished',details:{marker:'m'}});
  assert.match(lifecycle(rows,[{...attempt,slot:'released'}])[0]!.stage,/不等于当前任务完成/);
  assert.match(lifecycle(rows,[attempt])[0]!.run,/时钟回拨/);
});
