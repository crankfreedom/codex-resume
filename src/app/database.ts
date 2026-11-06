import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deliveryHasMarker } from '../domain.ts';
import type { ThreadView } from '../domain.ts';
import type { Job, Journal } from '../domain.ts';
import { defaultSettings } from './contracts.ts';
import { normalizeAppearance } from './appearance.ts';
import { normalizeQuotaCheck } from './quota-schedule.ts';
import { defaultTaskConfig, validateEditable } from './task-policy.ts';
import type { TaskConfig, EditableConfig, PromptTemplate } from './contracts.ts';
import { eventPage } from './events.ts';
import type { ArchiveRecord, DataQuery, DataResult, EventRow, ManagedTask, Settings } from './contracts.ts';
import type { ResetAppointment, ResetAppointmentStatus, ResetConsumeOutcome } from './reset-cards.ts';

export class AppDatabase {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 4) { this.db.close(); throw new Error('本地数据库版本高于当前程序，拒绝降级'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, target TEXT NOT NULL, title TEXT NOT NULL,
        enabled INTEGER NOT NULL, job TEXT NOT NULL, updated INTEGER NOT NULL, last_error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS active_target ON tasks(target) WHERE enabled=1;
      CREATE TABLE IF NOT EXISTS attempts (marker TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        created INTEGER NOT NULL, phase TEXT NOT NULL, turn_id TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        task_id TEXT, type TEXT NOT NULL, details TEXT NOT NULL, task_name TEXT);`);
    if (!this.db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'task_name')) {
      this.db.exec(`ALTER TABLE events ADD COLUMN task_name TEXT;
          UPDATE events SET task_name=(SELECT title FROM tasks WHERE tasks.id=events.task_id);
          `);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_task_type ON events(task_id,type,id);
      `);
    if (version < 3) this.migrateV3();
    if (version < 4) this.migrateV4();
    this.recoverLimitedHistory();
    this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  private migrateV3() {
      const has = (table: string, field: string) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === field);
      if (!has('tasks', 'config')) this.db.exec("ALTER TABLE tasks ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
      if (!has('attempts', 'revision')) this.db.exec('ALTER TABLE attempts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      if (!has('attempts', 'slot')) this.db.exec("ALTER TABLE attempts ADD COLUMN slot TEXT NOT NULL DEFAULT 'held'");
      this.db.exec(`CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, ended INTEGER NOT NULL, reason TEXT NOT NULL, snapshot TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS revisions (task_id TEXT NOT NULL, revision INTEGER NOT NULL, time INTEGER NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(task_id,revision));
        CREATE INDEX IF NOT EXISTS events_time ON events(time,id);
        CREATE INDEX IF NOT EXISTS events_type ON events(type,id);
        CREATE INDEX IF NOT EXISTS attempts_slot ON attempts(slot,task_id);
        UPDATE attempts SET slot='released' WHERE phase='completed';
        PRAGMA user_version=3;`);
  }
  private migrateV4() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS reset_appointments (
      id TEXT PRIMARY KEY, credit_id TEXT NOT NULL, card_key TEXT NOT NULL, card_title TEXT NOT NULL, id_suffix TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, time_zone TEXT NOT NULL, local_time TEXT NOT NULL, account_fingerprint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, message TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reset_active_credit ON reset_appointments(credit_id)
      WHERE status IN ('pending','running','uncertain');
    CREATE INDEX IF NOT EXISTS reset_due ON reset_appointments(status,scheduled_at);
    PRAGMA user_version=4;`);
  }
  private recoverLimitedHistory() {
    const rows = this.db.prepare(`SELECT task_id, max(task_name) AS title FROM events
      WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks) AND task_id NOT IN (SELECT id FROM archives) GROUP BY task_id`).all();
    for (const row of rows) {
      const id=String(row.task_id);
      const record: ArchiveRecord={id,title:row.title==null?null:String(row.title),targetThreadId:null,createdAt:null,endedAt:null,reason:'legacy_incomplete',resumeCount:null,incomplete:true};
      this.db.prepare('INSERT OR IGNORE INTO archives VALUES(?,?,?,?)').run(id,0,record.reason,JSON.stringify(record));
    }
  }
  private resetRow(row: Record<string, unknown>): ResetAppointment {
    return {
      id: String(row.id), creditId: String(row.credit_id), cardKey: String(row.card_key), cardTitle: String(row.card_title), idSuffix: String(row.id_suffix),
      scheduledAt: Number(row.scheduled_at), timeZone: String(row.time_zone), localTime: String(row.local_time), accountFingerprint: String(row.account_fingerprint),
      idempotencyKey: String(row.idempotency_key), requestId: String(row.request_id), status: String(row.status) as ResetAppointmentStatus,
      reason: row.reason == null ? null : String(row.reason), message: row.message == null ? null : String(row.message),
      outcome: row.outcome == null ? null : String(row.outcome) as ResetConsumeOutcome,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), startedAt: row.started_at == null ? null : Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at), attempts: Number(row.attempts),
    };
  }
  resetAppointments(): ResetAppointment[] {
    return this.db.prepare('SELECT * FROM reset_appointments ORDER BY created_at DESC,id DESC LIMIT 500').all().map(row => this.resetRow(row));
  }
  resetAppointment(id: string): ResetAppointment {
    const row = this.db.prepare('SELECT * FROM reset_appointments WHERE id=?').get(id);
    if (!row) throw new Error('重置卡预约不存在');
    return this.resetRow(row);
  }
  createResetAppointment(value: ResetAppointment) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM reset_appointments WHERE credit_id=? AND status IN ('pending','running','uncertain')").get(value.creditId)) {
        throw new Error('该卡片已有待执行、执行中或结果不确定的预约');
      }
      this.db.prepare(`INSERT INTO reset_appointments(
        id,credit_id,card_key,card_title,id_suffix,scheduled_at,time_zone,local_time,account_fingerprint,
        idempotency_key,request_id,status,reason,message,outcome,created_at,updated_at,started_at,finished_at,attempts
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.id, value.creditId, value.cardKey, value.cardTitle, value.idSuffix, value.scheduledAt, value.timeZone, value.localTime,
        value.accountFingerprint, value.idempotencyKey, value.requestId, value.status, value.reason, value.message, value.outcome,
        value.createdAt, value.updatedAt, value.startedAt, value.finishedAt, value.attempts,
      );
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dueResetAppointments(now: number) {
    return this.db.prepare("SELECT * FROM reset_appointments WHERE status='pending' AND scheduled_at<=? ORDER BY scheduled_at,id").all(now).map(row => this.resetRow(row));
  }
  recoverResetAppointments(now: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE reset_appointments SET status='missed',reason='restart_missed',message=?,updated_at=?,finished_at=? WHERE status='pending' AND scheduled_at<?")
        .run('程序重启时预约时间已过，不自动补用', now, now, now);
      this.db.prepare("UPDATE reset_appointments SET status='uncertain',reason='restart_during_consume',message=?,updated_at=? WHERE status='running'")
        .run('进程在执行期间重启；保留原请求 ID，禁止自动重试', now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claimResetAppointment(id: string, now: number, reconcile = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.resetAppointment(id);
      const expected = reconcile ? 'uncertain' : 'pending';
      if (current.status !== expected) throw new Error(reconcile ? '仅结果不确定的预约可核对' : '预约已被取消或状态已变化');
      const result = this.db.prepare(`UPDATE reset_appointments SET status='running',reason=NULL,message=NULL,outcome=NULL,
        started_at=coalesce(started_at,?),finished_at=NULL,updated_at=?,attempts=attempts+1 WHERE id=? AND status=?`).run(now, now, id, expected);
      if (result.changes !== 1) throw new Error('预约领取冲突');
      this.db.exec('COMMIT');
      return this.resetAppointment(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishResetAppointment(id: string, status: ResetAppointmentStatus, now: number, reason: string | null, message: string | null, outcome: ResetConsumeOutcome | null = null) {
    if (!['succeeded', 'failed', 'missed', 'uncertain'].includes(status)) throw new Error('预约终态无效');
    const result = this.db.prepare(`UPDATE reset_appointments SET status=?,reason=?,message=?,outcome=?,updated_at=?,finished_at=? WHERE id=? AND status='running'`)
      .run(status, reason, message, outcome, now, status === 'uncertain' ? null : now, id);
    if (result.changes !== 1) throw new Error('预约执行状态已变化');
  }
  missResetAppointment(id: string, now: number, reason = 'execution_missed') {
    const result = this.db.prepare(`UPDATE reset_appointments SET status='missed',reason=?,message=?,updated_at=?,finished_at=? WHERE id=? AND status='pending'`)
      .run(reason, '已超过允许执行时刻，不自动补用', now, now, id);
    if (result.changes !== 1) throw new Error('预约状态已变化，不能标记已错过');
  }
  cancelResetAppointment(id: string, now: number) {
    const result = this.db.prepare(`UPDATE reset_appointments SET status='cancelled',reason='cancelled_by_user',message=?,updated_at=?,finished_at=? WHERE id=? AND status='pending'`)
      .run('用户取消，未发起兑换', now, now, id);
    if (result.changes !== 1) {
      const current = this.resetAppointment(id);
      throw new Error(current.status === 'running' ? '预约正在执行，不能取消或替换卡片' : '仅待执行预约可取消');
    }
  }
  query(query: DataQuery): DataResult {
    if (!query || typeof query !== 'object') throw new Error('查询无效');
    if (query.type==='templates') return {templates:this.templates()};
    if (query.type==='resetAppointments') return {resetAppointments:this.resetAppointments().map(({creditId:_creditId,accountFingerprint:_accountFingerprint,...view})=>view)};
    if (query.type==='events') return eventPage(this.db,query.filter,query.cursor,query.boundary,query.limit);
    if (query.type==='timeline') {
      if (typeof query.taskId!=='string' || !query.taskId || query.taskId.length>200) throw new Error('时间线任务无效');
      return {...eventPage(this.db,{taskId:query.taskId},query.cursor,query.boundary,query.limit),
        revisions:this.db.prepare('SELECT * FROM revisions WHERE task_id=? ORDER BY revision DESC LIMIT 100').all(query.taskId).map(r=>{const v=JSON.parse(String(r.fields));return {revision:Number(r.revision),time:Number(r.time),fields:Array.isArray(v)?v:v.changed};}),
        attempts:this.db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY created,marker LIMIT 100').all(query.taskId).map(row=>({marker:String(row.marker),created:Number(row.created),phase:String(row.phase),turnId:row.turn_id==null?null:String(row.turn_id),revision:Number(row.revision),slot:String(row.slot)}))};
    }
    if (query.type==='archives') {
      const limit=query.limit ?? 50;
      if (!Number.isInteger(limit)||limit<1||limit>100 || (query.cursor!==undefined && (!Number.isSafeInteger(query.cursor)||query.cursor<0))) throw new Error('归档分页无效');
      const rows=this.db.prepare('SELECT rowid,snapshot FROM archives WHERE rowid<? ORDER BY rowid DESC LIMIT ?').all(query.cursor ?? Number.MAX_SAFE_INTEGER,limit+1);
      return {archives:rows.slice(0,limit).map(r=>JSON.parse(String(r.snapshot))),nextCursor:rows.length>limit?Number(rows[limit-1]!.rowid):undefined};
    }
    throw new Error('不支持的查询');
  }
  private archive(id:string, reason:string, completed=false) {
    if(this.unresolved(id)) throw new Error('存在未落定投递，不可归档移除');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (row && (!completed || (JSON.parse(String(row.job)) as Job).phase==='completed')) {
        const job=JSON.parse(String(row.job)) as Job;
        const record:ArchiveRecord={id,title:String(row.title),targetThreadId:job.targetThreadId,createdAt:job.createdAt,endedAt:Date.now(),reason,resumeCount:job.resumeCount,incomplete:false};
        this.db.prepare('INSERT OR IGNORE INTO archives VALUES(?,?,?,?)').run(id,record.endedAt,reason,JSON.stringify(record));
        this.event(id,'task_archived',{reason});
        this.event(id,'task_removed',{reason:completed?'completed':'user_removed',automatic:completed});
        this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  config(id:string):TaskConfig {
    const row=this.db.prepare('SELECT config,rowid FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('托管任务不存在');
    return {...defaultTaskConfig(Number(row.rowid)),...JSON.parse(String(row.config))};
  }
  setConfig(id:string,config:TaskConfig) {this.db.prepare('UPDATE tasks SET config=? WHERE id=?').run(JSON.stringify(config),id);}
  unresolved(id:string) { return Boolean(this.db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND slot='held'").get(id)); }
  templates():PromptTemplate[] {return this.db.prepare('SELECT * FROM templates ORDER BY is_default DESC,name,id').all().map(r=>({id:String(r.id),name:String(r.name),body:String(r.body),isDefault:Boolean(r.is_default)}));}
  saveTemplate(value:PromptTemplate) {
    if (!value || typeof value.id!=='string' || !value.id || value.id.length>100 || typeof value.name!=='string' || !value.name.trim() || value.name.length>100 || typeof value.body!=='string' || !value.body.trim() || value.body.length>10000 || typeof value.isDefault!=='boolean') throw new Error('模板参数无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (value.isDefault) this.db.exec('UPDATE templates SET is_default=0');
      this.db.prepare('INSERT INTO templates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body,is_default=excluded.is_default').run(value.id,value.name.trim(),value.body.trim(),Number(value.isDefault));
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  deleteTemplate(id:string) { if (typeof id!=='string'||id.length>100) throw new Error('模板 ID 无效');this.db.prepare('DELETE FROM templates WHERE id=?').run(id); }
  edit(id:string,revision:number,value:EditableConfig) {
    const entry=this.jobs().find(e=>e.job.id===id); if(!entry) throw new Error('托管任务不存在');
    if (entry.enabled || this.unresolved(id) || ['sending','verifying','send_uncertain'].includes(entry.job.phase)) throw new Error('仅暂停且无未落定投递的任务可编辑，请先只读核对');
    const config=this.config(id); if(config.revision!==revision) throw new Error('配置已变化，请重新打开编辑');
    value=validateEditable(value,entry.job.resumeCount);
    const job=entry.job; const priorMaxResumes=job.maxResumes; const priorPrompt=job.prompt.replace(/^续跑投递标记：[^\n]+\n\n/,'');
    const fields=Object.keys(value).filter(k=>k==='prompt'?value.prompt!==priorPrompt:k==='maxResumes'?value.maxResumes!==job.maxResumes:JSON.stringify(value[k as keyof EditableConfig])!==JSON.stringify(config[k as keyof TaskConfig]));
    job.prompt=`续跑投递标记：${job.marker}\n\n${value.prompt}`; job.maxResumes=value.maxResumes;
    const next={...config,mode:value.mode,priority:value.priority,expiresAt:value.expiresAt,window:value.window,revision:config.revision+1,requiresConfirmation:true};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE tasks SET job=?,config=?,updated=? WHERE id=? AND enabled=0').run(JSON.stringify(job),JSON.stringify(next),Date.now(),id);
      this.db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?)').run(id,config.revision,Date.now(),JSON.stringify({changed:[],config,prompt:priorPrompt,maxResumes:priorMaxResumes}));
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(id,next.revision,Date.now(),JSON.stringify({changed:fields,config:next,prompt:value.prompt,maxResumes:value.maxResumes}));
      this.event(id,'config_revised',{revision:next.revision,fields});this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get();
    const stored = row ? JSON.parse(String(row.value)) : {};
    return { ...defaultSettings, ...stored, queue:stored.queue ?? {...defaultSettings.queue}, quotaCheck: normalizeQuotaCheck(stored.quotaCheck), appearance: normalizeAppearance(stored.appearance) };
  }
  setSettings(value: Settings) {
    this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
  }
  nextQueueOrder() {return Number(this.db.prepare("SELECT coalesce(max(coalesce(json_extract(config,'$.queueOrder'),rowid)),0)+1 AS n FROM tasks").get()!.n);}
  add(job: Job, title: string, config=defaultTaskConfig(this.nextQueueOrder())) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO tasks(id,target,title,enabled,job,updated,last_error,config) VALUES(?,?,?,?,?,?,NULL,?)').run(job.id,job.targetThreadId,title,1,JSON.stringify(job),Date.now(),JSON.stringify(config));
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(job.id,config.revision,Date.now(),JSON.stringify({changed:['created'],config,prompt:job.prompt.replace(/^续跑投递标记：[^\n]+\n\n/,''),maxResumes:job.maxResumes}));
      this.event(job.id,'task_created',{targetThreadId:job.targetThreadId,revision:config.revision,mode:config.mode});
      this.event(job.id,'monitoring_enabled',{targetThreadId:job.targetThreadId});this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  jobs(): Array<{ job: Job; enabled: boolean; title: string }> {
    return this.db.prepare('SELECT job,enabled,title FROM tasks').all().map(row => ({
      job: JSON.parse(String(row.job)) as Job, enabled: Boolean(row.enabled), title: String(row.title),
    })).sort((a,b)=>{const x=this.config(a.job.id),y=this.config(b.job.id);return x.priority-y.priority || x.queueOrder-y.queueOrder || a.job.id.localeCompare(b.job.id);});
  }
  slots() {return Number(this.db.prepare("SELECT count(*) AS n FROM attempts WHERE slot='held'").get()!.n);}
  settleSlots(taskId:string,view:ThreadView) {
    const task=this.db.prepare('SELECT target FROM tasks WHERE id=?').get(taskId);
    if (!task || task.target!==view.thread.id) return;
    for (const attempt of this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND slot='held'").all(taskId)) {
      const own=view.turns.find(t=>deliveryHasMarker(t,String(attempt.marker)));
      if (own && ['completed','failed','interrupted','cancelled'].includes(own.status)) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare("UPDATE attempts SET slot='released',turn_id=? WHERE marker=?").run(own.id,attempt.marker!);
          this.event(taskId,'delivery_turn_finished',{marker:String(attempt.marker),turnId:own.id,status:own.status,elapsedMs:Math.max(0,Date.now()-Number(attempt.created))});
          this.db.exec('COMMIT');
        }catch(error){this.db.exec('ROLLBACK');throw error;}
      }
    }
  }
  reorder(id:string,direction:'up'|'down') {
    if (!['up','down'].includes(direction)) throw new Error('排序方向无效');
    const config=this.config(id);const peers=this.jobs().filter(t=>this.config(t.job.id).priority===config.priority);
    const index=peers.findIndex(t=>t.job.id===id);const other=peers[index+(direction==='up'?-1:1)];if(!other)return;
    // 重新编号同级任务，消除旧值相同和分数精度问题；顺序不依赖 updated。
    [peers[index],peers[index+(direction==='up'?-1:1)]]=[peers[index+(direction==='up'?-1:1)]!,peers[index]!];
    this.db.exec('BEGIN IMMEDIATE');try {peers.forEach((t,i)=>this.setConfig(t.job.id,{...this.config(t.job.id),queueOrder:i}));this.event(id,'queue_reordered',{direction});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  enabled(id: string) { return Boolean(this.db.prepare('SELECT enabled FROM tasks WHERE id=?').get(id)?.enabled); }
  toggle(id: string, enabled: boolean) {
    this.db.prepare('UPDATE tasks SET enabled=?,updated=? WHERE id=?').run(Number(enabled), Date.now(), id);
    this.event(id, enabled ? 'monitoring_enabled' : 'monitoring_paused');
  }
  remove(id: string) { if (!this.enabled(id)) this.archive(id,'user_removed'); }
  removeCompleted(id: string) { this.archive(id,'current_task_completed',true); }
  error(id: string, message: string | null) {
    this.db.prepare('UPDATE tasks SET last_error=? WHERE id=?').run(message, id);
  }
  journal(id: string): Journal {
    return {
      save: job => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const existing=this.db.prepare('SELECT * FROM attempts WHERE marker=?').get(job.marker);
          if(job.phase==='sending' && existing?.slot==='released') throw new Error('投递标记已结束，请建立新的投递周期');
          if (job.phase==='sending' && !existing) {
            const config=this.config(id); const queue=this.settings().queue;
            if (!this.enabled(id) || config.mode!=='auto' || (queue.enabled && this.slots()>=queue.limit)) throw new Error('投递策略或槽位已变化，未创建意图');
            this.db.prepare("INSERT INTO attempts(marker,task_id,created,phase,turn_id,revision,slot) VALUES(?,?,?,'sending',NULL,?,'held')").run(job.marker,id,Date.now(),config.revision);
          }
          this.db.prepare('UPDATE tasks SET job=?,updated=? WHERE id=?').run(JSON.stringify(job), Date.now(), id);
          if (job.phase === 'sending' || this.db.prepare('SELECT marker FROM attempts WHERE marker=?').get(job.marker)) this.db.prepare(`INSERT INTO attempts(marker,task_id,created,phase,turn_id) VALUES(?,?,?,?,?)
            ON CONFLICT(marker) DO UPDATE SET phase=excluded.phase,turn_id=excluded.turn_id`)
            .run(job.marker, id, Date.now(), job.sentTurnId && job.evidence.sameThreadReply ? 'completed' : job.phase, job.sentTurnId ?? null);
          if(job.cancelledBeforeDispatchMarker) this.db.prepare("UPDATE attempts SET slot='released' WHERE marker=? AND task_id=?").run(job.cancelledBeforeDispatchMarker,id);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      },
      event: (type, details) => this.event(id, type, details),
    };
  }
  event(taskId: string | null, type: string, details: Record<string, unknown> = {}, taskName?: string) {
    if (type === 'quota_checked' && taskId && typeof details.checkedAt === 'number') {
      // 仅聚合日志；每次真实查询和状态机推进仍照常执行。旧事件不回写。
      const previous = this.db.prepare("SELECT id,details FROM events WHERE task_id=? AND type='quota_checked' ORDER BY id DESC LIMIT 1").get(taskId);
      const prior = previous ? JSON.parse(String(previous.details)) as Record<string, unknown> : undefined;
      const signature = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['nextCheckAt', 'nextQuotaCheckAt', 'gateSuggestedCheckAt', 'checkedAt', 'firstCheckedAt', 'lastCheckedAt', 'checkCount', 'periodicSummary'].includes(key))));
      const same = prior && typeof prior.checkCount === 'number' && signature(prior) === signature(details);
      const firstCheckedAt = same ? Number(prior.firstCheckedAt) : details.checkedAt;
      if (same && details.checkedAt >= Number(prior.lastCheckedAt) && details.checkedAt - firstCheckedAt < 600000) {
        this.db.prepare('UPDATE events SET details=? WHERE id=?').run(JSON.stringify({ ...details,
          firstCheckedAt, lastCheckedAt: details.checkedAt, checkCount: Number(prior.checkCount) + 1,
          periodicSummary: prior.periodicSummary ?? false }), previous!.id!);
        return;
      }
      details = { ...details, firstCheckedAt: details.checkedAt, lastCheckedAt: details.checkedAt,
        checkCount: 1, periodicSummary: Boolean(same && details.checkedAt - firstCheckedAt >= 600000) };
    }
    const name = taskName ?? (taskId ? this.db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId)?.title : null);
    this.db.prepare('INSERT INTO events(time,task_id,task_name,type,details) VALUES(?,?,?,?,?)')
      .run(Date.now(), taskId, name == null ? null : String(name), type, JSON.stringify(details));
  }
  events(limit = 150): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
      id: Number(row.id), time: Number(row.time), taskId: row.task_id == null ? null : String(row.task_id),
      taskName: row.task_name == null ? null : String(row.task_name),
      type: String(row.type), details: JSON.parse(String(row.details)),
    }));
  }
  tasks(): ManagedTask[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY updated DESC').all().map(row => {
      const job = JSON.parse(String(row.job)) as Job;
      return {
        id: job.id, targetThreadId: job.targetThreadId, title: String(row.title), enabled: Boolean(row.enabled),
        phase: job.phase, reason: job.reason, createdAt: job.createdAt, updatedAt: Number(row.updated),
        nextCheckAt: job.nextCheckAt, resumeCount: job.resumeCount, maxResumes: job.maxResumes ?? 1,
        config:this.config(job.id),slotHeld:this.unresolved(job.id),
        prompt: job.prompt.replace(/^续跑投递标记：[^\n]+\n\n/, ''), evidence: job.evidence, sentTurnId: job.sentTurnId,
        lastError: row.last_error == null ? undefined : String(row.last_error),
      };
    }).sort((a,b)=>a.config.priority-b.config.priority || a.config.queueOrder-b.config.queueOrder || a.id.localeCompare(b.id)).map((t,i)=>({...t,queuePosition:i+1}));
  }
  close() { this.db.close(); }
}
