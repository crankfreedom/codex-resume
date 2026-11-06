import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalStatuses, readLocalGoal } from '../src/app/goals.ts';
import { currentTaskCompleted } from '../src/domain.ts';
import type { ThreadView } from '../src/domain.ts';

test('Goal 元数据只读查询兼容已完成后清除，不读目标正文、不改源库', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-goal-'));
  const path = join(directory, 'goals_1.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,status TEXT,objective TEXT)');
    for (const status of goalStatuses) {
      db.prepare('INSERT OR REPLACE INTO thread_goals VALUES(?,?,?,?)').run('target', 'goal-1', status, '不得暴露的目标正文');
      const before = readFileSync(path);
      const value = readLocalGoal('target', directory);
      assert.deepEqual(value, { id: 'goal-1', status });
      assert.deepEqual(readFileSync(path), before);
      assert.equal(JSON.stringify(value).includes('目标正文'), false);
    }
    db.prepare('DELETE FROM thread_goals WHERE thread_id=?').run('target');
    assert.equal(readLocalGoal('target', directory), null);
    db.prepare('INSERT INTO thread_goals VALUES(?,?,?,?)').run('target', 'goal-2', 'active', 'other');
    assert.equal(readLocalGoal('target', directory)?.id, 'goal-2', '重新读取当前数据，不缓存旧 Goal');
    assert.equal(readLocalGoal("target' OR 1=1 --", directory), null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Goal 源库缺失、结构或状态未知时失败关闭，不能假定无 Goal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-resume-goal-'));
  const path = join(directory, 'goals_1.sqlite');
  try {
    assert.throws(() => readLocalGoal('target', directory), /无法只读确认/);
    assert.equal(existsSync(path), false, '不得创建 Codex 数据库');
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE thread_goals(thread_id TEXT,goal_id TEXT)');
      assert.throws(() => readLocalGoal('target', directory), /无法只读确认/);
      db.exec('ALTER TABLE thread_goals ADD COLUMN status TEXT');
      db.exec("INSERT INTO thread_goals VALUES('target','goal-1','future-status')");
      assert.throws(() => readLocalGoal('target', directory), /无法只读确认/);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('完成判定检查当前未结束 Goal、最新轮次和活动标志，不依赖历史完成事件', () => {
  const view: ThreadView = { thread: { id: 'target', status: { type: 'idle' } }, turns: [{ id: 'turn', status: 'completed' }], goal: null };
  assert.equal(currentTaskCompleted(view), true);
  for (const status of goalStatuses) {
    view.goal = { id: 'goal', status };
    assert.equal(currentTaskCompleted(view), status === 'complete');
  }
  view.goal = null;
  for (const status of ['inProgress', 'failed', 'interrupted', 'unknown']) {
    view.turns[0]!.status = status;
    assert.equal(currentTaskCompleted(view), false);
  }
  view.turns[0]!.status = 'completed'; view.thread.status.type = 'active';
  assert.equal(currentTaskCompleted(view), false);
  view.thread.status = { type: 'idle', activeFlags: ['waitingOnApproval'] };
  assert.equal(currentTaskCompleted(view), false);
  view.thread.status = { type: 'unknown' };
  assert.equal(currentTaskCompleted(view), false);
  view.thread.status = { type: 'idle' }; view.goal = undefined;
  assert.equal(currentTaskCompleted(view), false, '旧 CLI 无 Goal 证据时保持原规则');
});
