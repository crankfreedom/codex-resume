import { join } from 'node:path';
import { DesktopClient } from '../desktop.ts';
import { createJob, ResumeEngine } from '../engine.ts';
import { DispatchCancelledBeforeSend, quotaGate, realClock, terminal } from '../domain.ts';
import type { DesktopPort, Job, Quota } from '../domain.ts';
import { FileJournal } from '../store.ts';
import { AppDatabase } from './database.ts';
import { discoverCaller, threadIdPattern } from './bootstrap.ts';
import type { Command, Snapshot, ThreadSummary } from './contracts.ts';
import { validateAppearance } from './appearance.ts';
import { quotaCheckAt, validateQuotaCheck } from './quota-schedule.ts';

type Connection = DesktopPort & {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
  send(id: string, prompt: string, beforeDispatch?: () => void): Promise<void>;
  close(): void;
};
export class MonitorService {
  db: AppDatabase;
  directory: string;
  client?: Connection;
  connection: Snapshot['connection'] = { state: 'connecting', message: '正在连接 Codex 桌面 App', checkedAt: null };
  quota: Snapshot['quota'] = null;
  threads: ThreadSummary[] = [];
  private leases = new Map<string, () => void>();
  private busy = false;
  private stopping = false;
  private lastRefresh = 0;
  private nextQuotaCheckAt = 0;
  private quotaInTick?: Quota;
  private now: () => number;
  private creating = new Set<string>();
  private failedLogged = false;
  private makeClient: (caller: string, pipe?: string) => Connection;
  constructor(directory: string, makeClient = (caller: string, pipe?: string): Connection => new DesktopClient(caller, pipe), now = () => Date.now()) {
    this.makeClient = makeClient;
    this.now = now;
    this.directory = directory;
    this.db = new AppDatabase(join(directory, 'resume.sqlite'));
    // 未落定的发送不能因进程重启重放。
    for (const { job } of this.db.jobs()) if (job.phase === 'sending') {
      job.phase = 'send_uncertain'; job.reason = 'restart_during_send';
      this.db.journal(job.id).save(job); this.db.toggle(job.id, false);
      this.db.event(job.id, 'send_uncertain', { reason: job.reason });
    }
    this.db.event(null, 'worker_started');
  }
  private getClient() {
    if (!this.client) {
      const settings = this.db.settings();
      this.client = this.makeClient(settings.callerThreadId || discoverCaller(), settings.pipe || undefined);
    }
    return this.client;
  }
  snapshot(): Snapshot {
    return { connection: this.connection, quota: this.quota, nextQuotaCheckAt: this.nextQuotaCheckAt || null, threads: this.threads,
      tasks: this.db.tasks(), events: this.db.events(), settings: this.db.settings(), dataDirectory: this.directory,
      runtime: { state: 'running', heartbeatAt: Date.now(), pid: process.pid } };
  }
  private async refreshQuota() {
    try {
      const quota = await this.getClient().quota();
      const now = this.now();
      const gate = quotaGate(quota, 'codex', now);
      this.quota = { ...gate, checkedAt: now };
      this.quotaInTick = quota;
      this.nextQuotaCheckAt = quotaCheckAt(now, this.db.settings().quotaCheck);
    } catch (error) { this.disconnect(error); throw error; }
  }
  private disconnect(error: unknown) {
    this.connection = { state: 'disconnected', message: (error as Error).message, checkedAt: this.now() };
    this.quota = null; this.quotaInTick = undefined;
    this.client?.close(); this.client = undefined;
    this.lastRefresh = this.now();
    this.nextQuotaCheckAt = quotaCheckAt(this.now(), this.db.settings().quotaCheck);
    if (!this.failedLogged) this.db.event(null, 'desktop_disconnected', { message: this.connection.message });
    this.failedLogged = true;
  }
  private async refreshThreads() {
    const client = this.getClient();
    const list = await client.call<{ threads: unknown[]; pinnedThreads?: unknown[] }>('list_threads', { limit: 50 });
    const summaries = [...(list.pinnedThreads ?? []), ...(list.threads ?? [])];
    this.threads = [...new Map(summaries.flatMap(raw => {
      const t = raw as Record<string, unknown>;
      if (t.kind !== 'codex' || (t.hostId && t.hostId !== 'local') || typeof t.id !== 'string') return [];
      const status = t.status && typeof t.status === 'object' ? String((t.status as { type?: string }).type ?? 'unknown') : String(t.status ?? 'unknown');
      return [[t.id, { id: t.id, title: String(t.title ?? '未命名会话'), status,
        cwd: String(t.cwd ?? (t.project as { cwd?: string } | undefined)?.cwd ?? ''),
        updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : undefined }] as const];
    })).values()];
    this.connection = { state: 'connected', message: '已连接本机 Codex 桌面 App', checkedAt: this.now() };
    if (this.failedLogged) this.db.event(null, 'desktop_reconnected');
    this.failedLogged = false; this.lastRefresh = this.now();
  }
  async tick(force = false) {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const refreshThreads = force || this.now() - this.lastRefresh >= this.db.settings().pollSeconds * 1000;
      const refreshQuota = force || this.now() >= this.nextQuotaCheckAt;
      if (!refreshThreads && !refreshQuota) return;
      if (refreshQuota) await this.refreshQuota();
      if (refreshThreads || this.connection.state !== 'connected') await this.refreshThreads();
      if (this.connection.state !== 'connected') return;
      for (const { job, enabled } of this.db.jobs()) {
        if (!enabled || this.stopping) continue;
        if (terminal(job.phase)) { this.db.toggle(job.id, false); this.release(job.id); continue; }
        try {
          this.lease(job);
          await this.engine(job).step({ forceQuotaCheck: this.quotaInTick !== undefined, nextQuotaCheckAt: this.nextQuotaCheckAt });
          this.db.error(job.id, null);
          if (terminal(job.phase)) { this.db.toggle(job.id, false); this.release(job.id); }
        } catch (error) {
          const message = (error as Error).message;
          if (this.db.tasks().find(t => t.id === job.id)?.lastError !== message) this.db.event(job.id, 'read_retry', { message });
          this.db.error(job.id, message);
          if (this.connection.state !== 'connected') break;
        }
      }
    } catch (error) {
      // 连接失败也退避；不能使用旧额度发送或每两秒重复额度请求。
      this.disconnect(error);
    } finally {
      this.quotaInTick = undefined;
      for (const id of this.leases.keys()) if (!this.db.enabled(id)) this.release(id);
      this.busy = false;
    }
  }
  private lease(job: Job) {
    if (this.leases.has(job.id)) return;
    const journal = new FileJournal(join(this.directory, 'leases', job.id + '.json'), false);
    // 留下最小作业快照，以便共用 CLI 的显式解锁工具。
    journal.save(job);
    try { this.leases.set(job.id, journal.lock(job.targetThreadId)); }
    catch {
      // 只清理已退出进程的锁，不影响正在运行的其他实例。
      journal.unlock(); this.leases.set(job.id, journal.lock(job.targetThreadId));
    }
  }
  private release(id: string) { this.leases.get(id)?.(); this.leases.delete(id); }
  private engine(job: Job) {
    const client = this.getClient();
    const guarded: DesktopPort = {
      quota: async () => {
        if (!this.quotaInTick) await this.refreshQuota();
        return this.quotaInTick!;
      }, readThread: id => client.readThread(id),
      send: async (id, prompt) => {
        const check = () => {
          if (this.stopping || !this.db.enabled(job.id)) throw new DispatchCancelledBeforeSend('托管已暂停');
        };
        check(); await client.send(id, prompt, check);
      },
    };
    return new ResumeEngine(job, guarded, { ...realClock, now: this.now }, this.db.journal(job.id),
      (_quota, now) => quotaCheckAt(now, this.db.settings().quotaCheck));
  }
  async command(command: Command) {
    if (this.stopping) throw new Error('监控进程正在退出');
    if (command.type === 'refresh') { await this.tick(true); return; }
    if (command.type === 'settings') {
      const s = command.value;
      if (!s || !Number.isInteger(s.pollSeconds) || s.pollSeconds < 10 || s.pollSeconds > 300
        || typeof s.notifications !== 'boolean' || typeof s.closeToTray !== 'boolean'
        || typeof s.callerThreadId !== 'string' || (s.callerThreadId && !threadIdPattern.test(s.callerThreadId))
        || typeof s.pipe !== 'string' || (s.pipe && !/^\\\\\.\\pipe\\codex-app-tools-[a-z0-9-]+$/i.test(s.pipe))) throw new Error('设置参数无效');
      const previous = this.db.settings();
      if ((previous.callerThreadId !== s.callerThreadId || previous.pipe !== s.pipe) && this.db.tasks().some(t => t.enabled))
        throw new Error('修改连接参数前，请先暂停所有托管任务');
      const appearance = s.appearance === undefined ? previous.appearance : validateAppearance(s.appearance);
      const quotaCheck = s.quotaCheck === undefined ? previous.quotaCheck : validateQuotaCheck(s.quotaCheck);
      this.db.setSettings({ ...s, quotaCheck, appearance });
      if (JSON.stringify(previous.quotaCheck) !== JSON.stringify(quotaCheck)) {
        this.nextQuotaCheckAt = this.quota ? quotaCheckAt(this.now(), quotaCheck) : 0;
        for (const { job } of this.db.jobs()) if (job.phase === 'waiting_quota') {
          job.nextCheckAt = this.nextQuotaCheckAt; this.db.journal(job.id).save(job);
        }
      }
      if (previous.callerThreadId !== s.callerThreadId || previous.pipe !== s.pipe) {
        this.client?.close(); this.client = undefined; this.lastRefresh = 0;
        this.quota = null; this.quotaInTick = undefined; this.nextQuotaCheckAt = 0;
      }
      this.db.event(null, 'settings_updated'); return;
    }
    if (command.type === 'add') {
      if (!threadIdPattern.test(command.targetThreadId) || typeof command.prompt !== 'string'
        || !command.prompt.trim() || command.prompt.length > 10000
        || !Number.isInteger(command.maxResumes) || command.maxResumes < 1 || command.maxResumes > 20) throw new Error('任务参数无效');
      if (this.connection.state !== 'connected') throw new Error('请先连接 Codex');
      const target = this.threads.find(t => t.id === command.targetThreadId);
      if (!target) throw new Error('目标不在本机已读取的会话列表中，请刷新后重试');
      if (this.creating.has(target.id) || this.db.tasks().some(t => t.targetThreadId === target.id && t.enabled)) throw new Error('该会话已在托管');
      this.creating.add(target.id);
      try {
        const client = this.getClient();
        const caller = this.db.settings().callerThreadId || discoverCaller();
        const job = await createJob(client, { callerThreadId: caller, targetThreadId: target.id, mode: 'live', now: this.now(), prompt: command.prompt.trim() });
        job.followSession = true; job.maxResumes = command.maxResumes;
        this.lease(job);
        try { this.db.add(job, target.title); } catch (error) { this.release(job.id); throw error; }
      } finally { this.creating.delete(target.id); }
      return;
    }
    const entry = this.db.jobs().find(t => t.job.id === command.id);
    if (!entry) throw new Error('托管任务不存在');
    if (command.type === 'toggle') {
      if (typeof command.enabled !== 'boolean') throw new Error('托管开关无效');
      if (command.enabled) {
        if (terminal(entry.job.phase)) throw new Error('该任务已结束或需要人工核对，请从会话列表重新托管');
        this.lease(entry.job);
      }
      this.db.toggle(command.id, command.enabled);
      // 读取期间暂停要保留互斥，当前 tick 完成后才能释放。
      if (!command.enabled && !this.busy) this.release(command.id);
    } else if (command.type === 'remove') {
      if (entry.enabled || this.busy) throw new Error('请先暂停托管，等待当前检查结束后移除');
      this.release(command.id); this.db.remove(command.id);
    } else if (command.type === 'reconcile') {
      if (this.busy) throw new Error('正在检查任务，请稍后核对');
      if (!['sending', 'send_uncertain'].includes(entry.job.phase)) throw new Error('当前任务无需核对发送');
      this.busy = true;
      try { await this.engine(entry.job).reconcile(); } finally { this.busy = false; }
    } else throw new Error('不支持的操作');
  }
  requestStop() { this.stopping = true; }
  async stop() {
    this.requestStop();
    // 正在读/发送的请求由传输层超时收敛，等待后关闭数据库。
    while (this.busy || this.creating.size) await new Promise(resolve => setTimeout(resolve, 50));
    this.client?.close();
    for (const id of this.leases.keys()) this.release(id);
    this.db.event(null, 'worker_stopped'); this.db.close();
  }
}
