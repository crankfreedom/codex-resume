import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Job, Journal } from '../domain.ts';
import { defaultSettings } from './contracts.ts';
import { normalizeAppearance } from './appearance.ts';
import { normalizeQuotaCheck } from './quota-schedule.ts';
import type { EventRow, ManagedTask, Settings } from './contracts.ts';

export class AppDatabase {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, target TEXT NOT NULL, title TEXT NOT NULL,
        enabled INTEGER NOT NULL, job TEXT NOT NULL, updated INTEGER NOT NULL, last_error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS active_target ON tasks(target) WHERE enabled=1;
      CREATE TABLE IF NOT EXISTS attempts (marker TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        created INTEGER NOT NULL, phase TEXT NOT NULL, turn_id TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        task_id TEXT, type TEXT NOT NULL, details TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  settings(): Settings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get();
    const stored = row ? JSON.parse(String(row.value)) : {};
    return { ...defaultSettings, ...stored, quotaCheck: normalizeQuotaCheck(stored.quotaCheck), appearance: normalizeAppearance(stored.appearance) };
  }
  setSettings(value: Settings) {
    this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
  }
  add(job: Job, title: string) {
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,NULL)').run(job.id, job.targetThreadId, title, 1, JSON.stringify(job), Date.now());
    this.event(job.id, 'monitoring_enabled', { targetThreadId: job.targetThreadId });
  }
  jobs(): Array<{ job: Job; enabled: boolean; title: string }> {
    return this.db.prepare('SELECT job,enabled,title FROM tasks ORDER BY updated DESC').all().map(row => ({
      job: JSON.parse(String(row.job)) as Job, enabled: Boolean(row.enabled), title: String(row.title),
    }));
  }
  enabled(id: string) { return Boolean(this.db.prepare('SELECT enabled FROM tasks WHERE id=?').get(id)?.enabled); }
  toggle(id: string, enabled: boolean) {
    this.db.prepare('UPDATE tasks SET enabled=?,updated=? WHERE id=?').run(Number(enabled), Date.now(), id);
    this.event(id, enabled ? 'monitoring_enabled' : 'monitoring_paused');
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM tasks WHERE id=? AND enabled=0').run(id);
    this.event(id, 'task_removed');
  }
  error(id: string, message: string | null) {
    this.db.prepare('UPDATE tasks SET last_error=? WHERE id=?').run(message, id);
  }
  journal(id: string): Journal {
    return {
      save: job => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('UPDATE tasks SET job=?,updated=? WHERE id=?').run(JSON.stringify(job), Date.now(), id);
          if (job.phase === 'sending' || this.db.prepare('SELECT marker FROM attempts WHERE marker=?').get(job.marker)) this.db.prepare(`INSERT INTO attempts VALUES(?,?,?,?,?)
            ON CONFLICT(marker) DO UPDATE SET phase=excluded.phase,turn_id=excluded.turn_id`)
            .run(job.marker, id, Date.now(), job.phase, job.sentTurnId ?? null);
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      },
      event: (type, details) => this.event(id, type, details),
    };
  }
  event(taskId: string | null, type: string, details: Record<string, unknown> = {}) {
    this.db.prepare('INSERT INTO events(time,task_id,type,details) VALUES(?,?,?,?)')
      .run(Date.now(), taskId, type, JSON.stringify(details));
  }
  events(limit = 150): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
      id: Number(row.id), time: Number(row.time), taskId: row.task_id == null ? null : String(row.task_id),
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
        prompt: job.prompt.replace(/^续跑投递标记：[^\n]+\n\n/, ''), evidence: job.evidence,
        lastError: row.last_error == null ? undefined : String(row.last_error),
      };
    });
  }
  close() { this.db.close(); }
}
