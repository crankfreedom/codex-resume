import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Job, Journal } from './domain.ts';

export class FileJournal implements Journal {
  path: string;
  eventPath: string;
  echo: boolean;
  constructor(path: string, echo = true) {
    this.path = resolve(path);
    this.eventPath = this.path.replace(/\.json$/, '') + '.events.jsonl';
    this.echo = echo;
    mkdirSync(dirname(this.path), { recursive: true });
  }
  load(): Job {
    const job = JSON.parse(readFileSync(this.path, 'utf8')) as Job;
    const phases = ['observing', 'waiting_quota', 'sending', 'verifying', 'completed', 'suspended', 'send_uncertain'];
    if (job.version !== 1 || !job.id || !['live', 'hybrid', 'simulation'].includes(job.mode)
      || !phases.includes(job.phase) || !job.targetThreadId || !job.callerThreadId || !job.marker
      || !job.accountFingerprint || typeof job.prompt !== 'string' || !job.evidence
      || !Number.isFinite(job.nextCheckAt) || !Array.isArray(job.baselineTurnIds)) {
      throw new Error('任务状态无效，拒绝恢复运行');
    }
    return job;
  }
  save(job: Job) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, JSON.stringify(job, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.path);
  }
  create(job: Job) {
    const fd = openSync(this.path, 'wx');
    try { writeFileSync(fd, JSON.stringify(job, null, 2)); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  event(type: string, details: Record<string, unknown> = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...details });
    appendFileSync(this.eventPath, line + '\n', { encoding: 'utf8', flush: true });
    if (this.echo) console.log(line);
  }
  private targetLockPath(targetId: string) {
    const directory = process.env.CODEX_RESUME_LOCK_DIR
      ?? join(process.env.APPDATA ?? join(homedir(), '.local', 'share'), 'codex-resume', 'locks');
    mkdirSync(directory, { recursive: true });
    return resolve(directory, createHash('sha256').update(targetId).digest('hex') + '.lock');
  }
  lock(targetId?: string): () => void {
    const paths = [this.path + '.lock', ...(targetId ? [this.targetLockPath(targetId)] : [])];
    const token = randomUUID();
    const owned: string[] = [];
    const release = () => {
      for (const path of owned.reverse()) {
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
      }
    };
    try {
      for (const path of paths) {
        let fd: number;
        try { fd = openSync(path, 'wx'); }
        catch { throw new Error(`任务已有锁：${path}。确认原进程退出后，用 unlock 命令清理。`); }
        owned.push(path);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
        finally { closeSync(fd); }
      }
    } catch (error) { release(); throw error; }
    return release;
  }
  unlock() {
    const paths = [this.path + '.lock', this.targetLockPath(this.load().targetThreadId)].filter(existsSync);
    // 先确认所有持有者已退出，再清理；不终止任何进程。
    for (const path of paths) this.assertOwnerDead(path);
    for (const path of paths) unlinkSync(path);
  }
  private assertOwnerDead(path: string) {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('无效锁文件，需要人工检查');
    try { process.kill(lock.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    throw new Error(`锁持有进程 ${lock.pid} 仍运行，拒绝解锁`);
  }
}
