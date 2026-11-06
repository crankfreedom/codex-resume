import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CurrentGoal } from '../domain.ts';

export const goalStatuses = ['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'] as const;
export type GoalReader = (threadId: string) => CurrentGoal | null;

// 只读取当前 Goal 的身份和状态；不读取 objective，不创建、迁移或修改 Codex 数据。
export function readLocalGoal(threadId: string, directory = process.env.CODEX_HOME || join(homedir(), '.codex')): CurrentGoal | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(directory, 'goals_1.sqlite'), { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const columns = db.prepare('PRAGMA table_info(thread_goals)').all().map(row => row.name);
    if (!['thread_id', 'goal_id', 'status'].every(name => columns.includes(name))) throw new Error('Goal 数据结构不兼容');
    const row = db.prepare('SELECT goal_id,status FROM thread_goals WHERE thread_id=?').get(threadId);
    if (!row) return null;
    if (typeof row.goal_id !== 'string' || !row.goal_id || !goalStatuses.includes(row.status as typeof goalStatuses[number]))
      throw new Error('Goal 状态无效');
    return { id: row.goal_id, status: row.status as CurrentGoal['status'] };
  } catch {
    throw new Error('无法只读确认当前 Goal 状态，请确认本机 Codex 数据目录及版本后重试');
  } finally { db?.close(); }
}
