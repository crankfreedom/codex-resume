import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../src/app/database.ts';
import { eventsJsonl, formatDataTime, readableEvent } from '../src/app/event-data.ts';
import type { EventRow } from '../src/app/contracts.ts';

test('预览与 JSONL 将毫秒、秒级时间转为本机年月日时分秒，保留数值和空值', () => {
  const time = new Date(2026, 9, 28, 8, 9, 7).getTime();
  const event: EventRow = { id: 1, time, taskId: 'task-1', taskName: '测试长任务', type: 'quota_checked', details: {
    nextCheckAt: time + 600000, windows: [{ resetsAt: time / 1000, usedPercent: 100, windowDurationMins: 300 }, null],
    checkedAt: null, resumeCount: 2, message: '保留原始文本',
  } };
  const original = structuredClone(event);
  assert.equal(formatDataTime(time), '2026-10-28 08:09:07');
  assert.equal(formatDataTime(new Date(2026, 0, 2, 0, 3, 4).getTime()), '2026-01-02 00:03:04');
  assert.deepEqual(readableEvent(event), { ...event, time: '2026-10-28 08:09:07', details: {
    ...event.details, nextCheckAt: '2026-10-28 08:19:07',
    windows: [{ resetsAt: '2026-10-28 08:09:07', usedPercent: 100, windowDurationMins: 300 }, null],
  } });
  const latest = { ...event, id: 2, time: time + 1000 };
  const lines = eventsJsonl([latest, event]).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines, [readableEvent(event), readableEvent(latest)]);
  assert.deepEqual(event, original);
  assert.equal(eventsJsonl([]), '');
});

test('旧版 SQLite 补齐历史任务名，未知任务不臆造名称，重复打开保留新记录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-migration-'));
  const path = join(directory, 'resume.sqlite');
  const legacy = new DatabaseSync(path);
  let database: AppDatabase | undefined;
  try {
    legacy.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, target TEXT NOT NULL, title TEXT NOT NULL,
      enabled INTEGER NOT NULL, job TEXT NOT NULL, updated INTEGER NOT NULL, last_error TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
        task_id TEXT, type TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const job = JSON.stringify({ phase: 'waiting_quota', prompt: '原始提示词', nextCheckAt: 123456 });
    legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,NULL)').run('known', 'target', '历史任务名', 1, job, 42);
    legacy.prepare('INSERT INTO settings VALUES(1,?)').run('{"pollSeconds":45}');
    for (const taskId of ['known', 'already-removed', null]) {
      legacy.prepare('INSERT INTO events(time,task_id,type,details) VALUES(?,?,?,?)').run(100, taskId, 'legacy_event', '{}');
    }
    legacy.close();
    database = new AppDatabase(path);
    assert.deepEqual(database.events().map(event => [event.taskId, event.taskName]), [
      [null, null], ['already-removed', null], ['known', '历史任务名'],
    ]);
    assert.equal(database.db.prepare('SELECT job FROM tasks WHERE id=?').get('known')?.job, job);
    assert.equal(database.db.prepare('SELECT enabled FROM tasks WHERE id=?').get('known')?.enabled, 1);
    assert.equal(database.settings().pollSeconds, 45);
    database.event('known', 'new_event');
    database.close(); database = undefined;
    database = new AppDatabase(path);
    assert.equal(database.events().length, 4);
    assert.equal(database.events()[0]!.taskName, '历史任务名');
    assert.equal(database.db.prepare('PRAGMA user_version').get()?.user_version, 2);
  } finally {
    if (legacy.isOpen) legacy.close();
    database?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
