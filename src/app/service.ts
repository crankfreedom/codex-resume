import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopClient } from '../desktop.ts';
import { createJob, ResumeEngine } from '../engine.ts';
import { DispatchCancelledBeforeSend, quotaGate, realClock, terminal, currentTaskCompleted, fingerprint, stoppedForQuota } from '../domain.ts';
import type { DesktopPort, Job, Quota } from '../domain.ts';
import { FileJournal } from '../store.ts';
import { AppDatabase } from './database.ts';
import { discoverCaller, threadIdPattern } from './bootstrap.ts';
import type { Command, Snapshot, ThreadSummary } from './contracts.ts';
import { validateAppearance } from './appearance.ts';
import { quotaCheckAt, validateQuotaCheck } from './quota-schedule.ts';
import { defaultTaskConfig, validateEditable, timePolicy } from './task-policy.ts';
import { check, taskChecks } from './diagnostics.ts';
import { readLocalGoal } from './goals.ts';
import type { GoalReader } from './goals.ts';
import { AppServerResetClient } from './app-server.ts';
import { initialResetCards, publicResetCards, resetCardsSnapshot, resetExecutionGraceMs } from './reset-cards.ts';
import type { ResetCardsSnapshot, ResetConsumeOutcome, ResetCreditPort, ResetRateLimits } from './reset-cards.ts';
import { zonedDateTimeToEpoch } from './reset-time.ts';

type Connection = DesktopPort & {
  call<T>(name: string, args: Record<string, unknown>): Promise<T>;
  send(id: string, prompt: string, beforeDispatch?: (reconnected?:boolean) => void | Promise<void>): Promise<void>;
  close(): void;
};
export class MonitorService {
  db: AppDatabase;
  directory: string;
  client?: Connection;
  connection: Snapshot['connection'] = { state: 'connecting', message: '正在连接 Codex 桌面 App', checkedAt: null };
  quota: Snapshot['quota'] = null;
  threads: ThreadSummary[] = [];
  inspection?: Snapshot['inspection'];
  private leases = new Map<string, () => void>();
  private busy = false;
  private stopping = false;
  private lastRefresh = 0;
  private nextQuotaCheckAt = 0;
  private quotaInTick?: Quota;
  private now: () => number;
  private creating = new Set<string>();
  private authorizationEpoch=new Map<string,number>();
  private failedLogged = false;
  private makeClient: (caller: string, pipe?: string) => Connection;
  private makeResetClient: () => ResetCreditPort;
  private resetClient?: ResetCreditPort;
  private readGoal: GoalReader;
  resetCards: ResetCardsSnapshot = { ...initialResetCards, cards: [] };
  constructor(directory: string, makeClient = (caller: string, pipe?: string): Connection => new DesktopClient(caller, pipe), now = () => Date.now(), readGoal: GoalReader = readLocalGoal, makeResetClient: () => ResetCreditPort = () => new AppServerResetClient()) {
    this.makeClient = makeClient;
    this.makeResetClient = makeResetClient;
    this.now = now;
    this.readGoal = readGoal;
    this.directory = directory;
    this.db = new AppDatabase(join(directory, 'resume.sqlite'));
    this.db.recoverResetAppointments(this.now());
    // 未落定的发送不能因进程重启重放。
    for (const { job } of this.db.jobs()) if (job.phase === 'sending') {
      job.phase = 'send_uncertain'; job.reason = 'restart_during_send';
      this.db.journal(job.id).save(job); this.db.toggle(job.id, false);
      this.db.event(job.id, 'send_uncertain', { reason: job.reason });
    }
    this.db.event(null, 'worker_started', { appVersion: process.env.CODEX_RESUME_VERSION ?? null, diagnosticsVersion: 3,
      pollSeconds: this.db.settings().pollSeconds, quotaCheck: this.db.settings().quotaCheck });
  }
  private getClient() {
    if (!this.client) {
      const settings = this.db.settings();
      this.client = this.makeClient(settings.callerThreadId || discoverCaller(), settings.pipe || undefined);
    }
    return this.client;
  }
  snapshot(): Snapshot {
    return { queue:{held:this.db.slots(),...this.db.settings().queue}, inspection: this.inspection, connection: this.connection, quota: this.quota, nextQuotaCheckAt: this.nextQuotaCheckAt || null, resetCards: this.resetCards, threads: this.threads,
      tasks: this.db.tasks(), events: this.db.events(), settings: this.db.settings(), dataDirectory: this.directory,
      runtime: { state: 'running', heartbeatAt: Date.now(), pid: process.pid } };
  }
  private async readTask(id: string) {
    const before = this.readGoal(id);
    const view = await this.getClient().readThread(id);
    const goal = this.readGoal(id);
    if (view.thread.id !== id) throw new Error('目标会话身份不匹配');
    if ((before?.id ?? null) !== (goal?.id ?? null)) throw new Error('读取期间 Goal 已变化，请刷新后重试');
    for(const {job} of this.db.jobs()) if(job.targetThreadId===id) this.db.settleSlots(job.id,view);
    return { ...view, goal };
  }
  private finish(job: Job) {
    if (job.phase === 'completed') { if (!this.db.unresolved(job.id)) {this.db.removeCompleted(job.id); this.release(job.id);} }
    else if (terminal(job.phase)) {
      if (this.db.enabled(job.id)) this.db.toggle(job.id, false);
      if (!this.db.unresolved(job.id)) this.release(job.id);
    }
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
  private getResetClient() {
    if (!this.resetClient) this.resetClient = this.makeResetClient();
    return this.resetClient;
  }
  private presentResetQuota(quota: ResetRateLimits, userAgent: string | null) {
    this.resetCards = resetCardsSnapshot(quota, this.now(), userAgent);
  }
  async refreshResetCards() {
    try {
      const { quota, userAgent } = await this.getResetClient().read();
      this.presentResetQuota(quota, userAgent);
    } catch (error) {
      this.resetCards = { ...this.resetCards, error: (error as Error).message.slice(0, 500), checkedAt: this.now() };
      throw error;
    }
  }
  private async scheduleReset(command: Extract<Command, { type: 'resetSchedule' }>) {
    if (command.confirmed !== true || !/^[a-f0-9]{64}$/.test(command.cardKey)) throw new Error('必须确认具体卡片的预约详情');
    const scheduledAt = zonedDateTimeToEpoch(command.localTime, command.timeZone);
    if (scheduledAt <= this.now()) throw new Error('预约时间必须晚于当前时间');
    const { quota, userAgent } = await this.getResetClient().read();
    this.presentResetQuota(quota, userAgent);
    const selected = publicResetCards(quota).find(entry => entry.view.key === command.cardKey);
    if (!selected) throw new Error('指定卡片不在最新卡片明细中，请刷新后重新选择');
    if (selected.raw.status !== 'available') throw new Error('指定卡片当前不可使用');
    if (selected.view.expiresAt !== null && selected.view.expiresAt <= scheduledAt) throw new Error('指定卡片将在预约时间前到期');
    let accountFingerprint: string;
    try { accountFingerprint = fingerprint(quota); } catch { throw new Error('账号身份不可用，不能创建预约'); }
    const now = this.now();
    const id = randomUUID();
    const idempotencyKey = randomUUID();
    this.db.createResetAppointment({
      id, creditId: selected.raw.id, cardKey: selected.view.key, cardTitle: selected.view.title, idSuffix: selected.view.idSuffix,
      scheduledAt, timeZone: command.timeZone, localTime: command.localTime, accountFingerprint, idempotencyKey, requestId: idempotencyKey,
      status: 'pending', reason: null, message: null, outcome: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, attempts: 0,
    });
    this.db.event(null, 'reset_scheduled', { appointmentId: id, idSuffix: selected.view.idSuffix, scheduledAt, timeZone: command.timeZone });
  }
  private async executeReset(id: string, reconcile = false) {
    const appointment = this.db.claimResetAppointment(id, this.now(), reconcile);
    this.db.event(null, 'reset_started', { appointmentId: id, idSuffix: appointment.idSuffix, requestId: appointment.requestId, reconcile });
    let quota: ResetRateLimits;
    try {
      const read = await this.getResetClient().read();
      quota = read.quota; this.presentResetQuota(quota, read.userAgent);
      let currentFingerprint: string;
      try { currentFingerprint = fingerprint(quota); } catch { throw new Error('账号身份不可用'); }
      if (currentFingerprint !== appointment.accountFingerprint) {
        this.db.finishResetAppointment(id, 'failed', this.now(), 'account_changed', '账号已切换，禁止沿用旧账号预约执行');
        return;
      }
      const selected = publicResetCards(quota).find(entry => entry.raw.id === appointment.creditId);
      if (!selected) {
        this.db.finishResetAppointment(id, 'failed', this.now(), 'credit_details_unavailable', '最新明细中没有指定卡片，禁止自动替换其他卡片');
        return;
      }
      if (selected.raw.status !== 'available') {
        this.db.finishResetAppointment(id, 'failed', this.now(), 'credit_unavailable', `指定卡片状态为 ${selected.raw.status}，未发起兑换`);
        return;
      }
      if (selected.view.expiresAt !== null && selected.view.expiresAt <= this.now()) {
        this.db.finishResetAppointment(id, 'failed', this.now(), 'credit_expired', '指定卡片已到期，未发起兑换');
        return;
      }
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      this.db.finishResetAppointment(id, 'failed', this.now(), 'preflight_failed', message);
      this.db.event(null, 'reset_finished', { appointmentId: id, idSuffix: appointment.idSuffix, requestId: appointment.requestId, status: 'failed', reason: 'preflight_failed' });
      return;
    }
    let outcome: ResetConsumeOutcome;
    try {
      outcome = await this.getResetClient().consume(appointment.creditId, appointment.idempotencyKey);
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      this.db.finishResetAppointment(id, 'uncertain', this.now(), 'response_uncertain', message);
      this.db.event(null, 'reset_uncertain', { appointmentId: id, idSuffix: appointment.idSuffix, requestId: appointment.requestId, message });
      return;
    }
    const succeeded = outcome === 'reset' || outcome === 'alreadyRedeemed';
    const status = succeeded ? 'succeeded' : 'failed';
    const message = outcome === 'reset' ? '指定卡片已使用' : outcome === 'alreadyRedeemed' ? '原请求 ID 已确认完成，未更换请求 ID'
      : outcome === 'nothingToReset' ? '服务端返回当前没有可重置的额度窗口，未使用卡片' : '服务端返回没有可用卡片，未自动替换其他卡片';
    this.db.finishResetAppointment(id, status, this.now(), succeeded ? null : outcome, message, outcome);
    this.db.event(null, 'reset_finished', { appointmentId: id, idSuffix: appointment.idSuffix, requestId: appointment.requestId, status, outcome });
    try { await this.refreshQuota(); } catch (error) {
      this.db.event(null, 'reset_refresh_failed', { appointmentId: id, target: 'quota', message: (error as Error).message.slice(0, 500) });
    }
    try { await this.refreshResetCards(); } catch (error) {
      this.db.event(null, 'reset_refresh_failed', { appointmentId: id, target: 'cards', message: (error as Error).message.slice(0, 500) });
    }
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
      for (const appointment of this.db.dueResetAppointments(this.now())) {
        if (this.stopping) break;
        if (this.now() - appointment.scheduledAt > resetExecutionGraceMs) {
          this.db.missResetAppointment(appointment.id, this.now());
          this.db.event(null, 'reset_missed', { appointmentId: appointment.id, idSuffix: appointment.idSuffix, requestId: appointment.requestId });
          continue;
        }
        await this.executeReset(appointment.id);
      }
      const refreshThreads = force || this.now() - this.lastRefresh >= this.db.settings().pollSeconds * 1000;
      const refreshQuota = force || this.now() >= this.nextQuotaCheckAt;
      if (!refreshThreads && !refreshQuota) return;
      if (refreshQuota) await this.refreshQuota();
      if (refreshThreads || this.connection.state !== 'connected') await this.refreshThreads();
      if (this.connection.state !== 'connected') return;
      // 先核对所有已占用轮次，再按优先级分配新增投递，避免列表顺序延迟释放。
      for(const {job} of this.db.jobs()) if(this.db.unresolved(job.id)) {
        try {this.lease(job);await this.readTask(job.targetThreadId);}
        catch(error){this.db.error(job.id,(error as Error).message);}
      }
      for (const { job, enabled } of this.db.jobs()) {
        if (this.stopping) break;
        if (!enabled && job.phase !== 'completed' && !this.db.unresolved(job.id) && job.phase!=='verifying') continue;
        try {
          if(!enabled && job.phase==='verifying') {await this.engine(job).verify();this.finish(job);continue;}
          if(!enabled && job.phase!=='completed') continue;
          const policy=timePolicy(this.db.config(job.id),this.now());
          if(policy==='expired') {
            job.reason='expired';this.db.journal(job.id).save(job);this.db.toggle(job.id,false);this.db.event(job.id,'task_expired');continue;
          }
          // 旧版 completed 只说明投递轮次结束，清理前重新检查当前任务。
          if (job.phase === 'completed') {
            const view = await this.readTask(job.targetThreadId);
            if (currentTaskCompleted(view)) this.finish(job);
            else {
              job.phase = 'observing'; job.reason = 'task_not_completed'; job.goalId = view.goal?.id ?? null;
              this.db.journal(job.id).save(job); this.db.toggle(job.id, false); this.release(job.id);
            }
            continue;
          }
          if (terminal(job.phase)) { this.finish(job); continue; }
          this.lease(job);
          await this.engine(job).step({ forceQuotaCheck: this.quotaInTick !== undefined || (!policy && (job.reason==='outside_window' || (job.reason==='queue_full' && (!this.db.settings().queue.enabled || this.db.slots()<this.db.settings().queue.limit)) || Boolean(this.db.config(job.id).observedRecovery && !this.db.config(job.id).notifiedRecovery))), nextQuotaCheckAt: this.nextQuotaCheckAt });
          this.db.error(job.id, null);
          this.finish(job);
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
      for (const id of this.leases.keys()) if (!this.db.enabled(id) && !this.db.unresolved(id)) this.release(id);
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
    const revision = this.db.config(job.id).revision;
    const guarded: DesktopPort = {
      quota: async () => {
        if (!this.quotaInTick) await this.refreshQuota();
        return this.quotaInTick!;
      }, readThread: id => this.readTask(id),
      send: async (id, prompt) => {
        const check = () => {
          if (this.stopping || !this.db.enabled(job.id)) throw new DispatchCancelledBeforeSend('托管已暂停');
          const config=this.db.config(job.id);
          if (config.mode!=='auto' || config.revision!==revision || timePolicy(config,this.now())) throw new DispatchCancelledBeforeSend('授权模式或配置修订已变化');
          let reason: string | undefined;
          try {
            const goal = this.readGoal(id);
            if ((goal?.id ?? null) !== job.goalId) reason = 'goal_changed_or_cleared';
            else if (goal && ['paused', 'blocked', 'budget_limited', 'complete'].includes(goal.status)) reason = 'goal_' + goal.status;
          } catch { reason = 'goal_state_unavailable'; }
          if (reason) {
            const error = new DispatchCancelledBeforeSend('当前 Goal 状态不再允许投递');
            error.reason = reason; throw error;
          }
        };
        check(); await client.send(id, prompt, async(reconnected=false)=>{
          check();
          if(!reconnected)return;
          try {
            const quota=await client.quota();
            const view=await this.readTask(id);
            if (fingerprint(quota)!==job.accountFingerprint || !quotaGate(quota,job.bucketId,this.now()).available
              || view.thread.id!==job.targetThreadId || view.thread.status.type==='active' || view.thread.status.activeFlags?.length
              || view.turns[0]?.id!==job.blockedTurnId || !stoppedForQuota(view)) throw new Error('额度、账号或停止轮次已变化');
          } catch(error) {
            const cancelled=new DispatchCancelledBeforeSend('派发前只读复查未通过：'+(error as Error).message);cancelled.reason='dispatch_preflight_unavailable';throw cancelled;
          }
          check();
        });
      },
    };
    const journal = this.db.journal(job.id);
    return new ResumeEngine(job, guarded, { ...realClock, now: this.now }, {
      save: value => journal.save(value),
      event: (type, details) => {
        if (type==='send_cancelled_before_dispatch') this.db.db.prepare("UPDATE attempts SET slot='released' WHERE marker=?").run(job.marker);
        journal.event(type, type === 'quota_checked' ? {
        ...details, marker:job.marker, revision, gateSuggestedCheckAt: details?.nextCheckAt, checkedAt: this.quota?.checkedAt ?? this.now(),
        nextCheckAt: this.nextQuotaCheckAt, nextQuotaCheckAt: this.nextQuotaCheckAt,
      } : {...details,marker:job.marker,revision});
      },
    },
      (_quota, now) => quotaCheckAt(now, this.db.settings().quotaCheck),
      () => {
        if (!this.db.enabled(job.id) || this.stopping) {
          job.phase='suspended';job.reason='monitoring_paused_before_send';
          this.db.event(job.id,'suspended',{reason:job.reason});return false;
        }
        const config=this.db.config(job.id);
        if (config.revision!==revision) return false;
        const timeReason=timePolicy(config,this.now());
        if(timeReason==='expired') {job.reason=timeReason;this.db.toggle(job.id,false);this.db.event(job.id,'task_expired');return false;}
        if (config.mode==='observe') {
          job.reason='observe_only';
          if (job.evidence.serverRecoveryObserved && config.observedRecovery!==job.blockedTurnId) {
            config.observedRecovery=job.blockedTurnId;
            this.db.setConfig(job.id,config); this.db.event(job.id,'observe_recovery_detected',{blockedTurnId:job.blockedTurnId,inAppOnly:Boolean(timeReason)});
          }
          if(!timeReason && job.evidence.serverRecoveryObserved && config.notifiedRecovery!==job.blockedTurnId) {config.notifiedRecovery=job.blockedTurnId;this.db.setConfig(job.id,config);this.db.event(job.id,'observe_recovery_ready',{blockedTurnId:job.blockedTurnId});}
          return false;
        }
        const queue=this.db.settings().queue;
        const waiting=timeReason ?? (queue.enabled && this.db.slots()>=queue.limit ? 'queue_full':null);
        if(waiting) {if(job.reason!==waiting)this.db.event(job.id,'policy_waiting',{reason:waiting});job.reason=waiting;return false;}
        job.reason=undefined;return true;
      });
  }
  async inspect() {
    if (this.busy) throw new Error('后台正在检查，请稍后执行只读检查；后台可独立继续投递');
    this.busy = true;
    const now = this.now();
    const checks = [check('worker','监控心跳','pass','工作进程正在处理只读请求','界面同时显示实际心跳是否过期',now)];
    const tasks: NonNullable<Snapshot['inspection']>['tasks'] = {};
    let reader: Connection | undefined;
    let readQuota: Snapshot['quota'] = null;
    try {
      const settings = this.db.settings();
      const integrity = this.db.db.prepare('PRAGMA quick_check').get();
      checks.push(check('database','本地数据库',integrity?.quick_check === 'ok'?'pass':'blocked',String(integrity?.quick_check),'本地异常时保留文件并停止使用写入功能',now));
      reader = this.makeClient(settings.callerThreadId || discoverCaller(),settings.pipe || undefined);
      const quota = await reader.quota();
      readQuota = { ...quotaGate(quota, 'codex', now), checkedAt: now };
      const list = await reader.call<{threads: unknown[]}>('list_threads',{limit:50});
      if (!Array.isArray(list.threads)) throw new Error('会话列表结构不兼容');
      this.threads=list.threads.flatMap(raw=>{if(!raw || typeof raw!=='object')return [];const t=raw as Record<string,unknown>;if(t.kind!=='codex' || (t.hostId && t.hostId!=='local') || typeof t.id!=='string')return [];return [{id:t.id,title:String(t.title ?? '未命名会话'),status:typeof t.status==='string'?t.status:String((t.status as {type?:string})?.type ?? 'unknown'),cwd:String(t.cwd ?? '')}];});
      checks.push(check('connection','连接与必要接口','pass',settings.pipe ? '使用指定管道，已校验工具目录与只读响应' : '自动发现唯一管道，已校验工具目录与只读响应','升级 Codex 后可重新运行自检',now));
      for (const {job, enabled} of this.db.jobs()) {
        try {
          const before = this.readGoal(job.targetThreadId);
          const view = await reader.readThread(job.targetThreadId);
          const goal = this.readGoal(job.targetThreadId);
          if (!view.thread?.status || !Array.isArray(view.turns)) throw new Error('会话响应结构不兼容');
          if ((before?.id ?? null)!==(goal?.id ?? null)) throw new Error('读取期间 Goal 已变化');
          tasks[job.id] = taskChecks(job,enabled,{...view,goal},quota,now);
          const config=this.db.config(job.id);const policy=timePolicy(config,now);const queue=this.db.settings().queue;
          tasks[job.id]!.push(
            check('mode','授权模式',config.mode==='auto'?'pass':'blocked',config.mode==='auto'?'自动续跑':'仅观察，后台不会创建发送意图','切换模式需暂停、编辑并重新确认',now),
            check('expiry','托管有效期',policy==='expired'?'blocked':'pass',config.expiresAt===null?'无截止时间':String(config.expiresAt),'到期仅停止后续投递，不撤回或释放已提交轮次',now),
            check('window','每日允许时段',policy==='outside_window'?'blocked':'pass',config.window.allDay?'全天':`${config.window.start}–${config.window.end} 分钟（本机时区）`,'时段外仍核对回执，等待下次允许时段再重新检查',now),
            check('queue','优先队列与槽位',!queue.enabled || this.db.slots()<queue.limit?'pass':'blocked',`优先级 ${config.priority}；顺序 ${this.db.tasks().find(t=>t.id===job.id)?.queuePosition}；占用 ${this.db.slots()} / ${queue.enabled?queue.limit:'不限'}；本任务 ${this.db.unresolved(job.id)?'占用':'未占用'}`,'仅计算本助手投递轮次，高优先级不抢占已提交轮次',now));
        } catch (error) {
          tasks[job.id] = [check('goal_read','目标与 Goal 源库','unknown',(error as Error).message,'确认原目标仍存在及 Goal 源库结构可读；不会假定没有 Goal',now)];
        }
      }
      if (!this.db.jobs().length) checks.push(check('goal_read','Goal 源库','unchecked','无授权目标，不读取其他 Goal','添加目标后检查指定目标元数据',null));
    } catch (error) {
      const message = (error as Error).message;
      checks.push(check('connection','连接与兼容性',/兼容|schema|必要能力/.test(message)?'blocked':'unknown',message,'保持 Codex 打开；多管道时在设置显式指定；不兼容需核对版本',now));
    } finally {
      reader?.close(); this.busy = false;
      this.inspection = {checkedAt:now,source:'read_only',checks,tasks,quota:readQuota};
    }
  }
  async command(command: Command) {
    if (this.stopping) throw new Error('监控进程正在退出');
    // 由 worker 返回新数据库快照，不查询额度或推进托管任务。
    if (command.type === 'refreshData') return;
    if (command.type === 'resetCardsRefresh') { await this.refreshResetCards(); return; }
    if (command.type === 'resetSchedule') { await this.scheduleReset(command); return; }
    if (command.type === 'resetCancel') {
      this.db.cancelResetAppointment(command.id, this.now());
      this.db.event(null, 'reset_cancelled', { appointmentId: command.id }); return;
    }
    if (command.type === 'resetReconcile') {
      if (this.busy) throw new Error('后台正在检查，请稍后核对原请求');
      this.busy = true;
      try { await this.executeReset(command.id, true); } finally { this.busy = false; }
      return;
    }
    if (command.type === 'refreshStatus' || command.type === 'selfCheck') { await this.inspect(); return; }
    if (command.type === 'refresh') { await this.tick(true); return; }
    if (command.type === 'templateSave') {this.db.saveTemplate(command.value);return;}
    if (command.type === 'templateDelete') {this.db.deleteTemplate(command.id);return;}
    if (command.type === 'reorder') {if(this.busy) throw new Error('正在检查任务，请稍后调整顺序');this.db.reorder(command.id,command.direction);return;}
    if (command.type === 'edit') {if (this.busy) throw new Error('正在检查任务，请稍后编辑');this.db.edit(command.id,command.revision,command.value);return;}
    if (command.type === 'settings') {
      const s = command.value;
      if (!s || !Number.isInteger(s.pollSeconds) || s.pollSeconds < 10 || s.pollSeconds > 300
        || typeof s.notifications !== 'boolean' || typeof s.closeToTray !== 'boolean'
        || typeof s.callerThreadId !== 'string' || (s.callerThreadId && !threadIdPattern.test(s.callerThreadId))
        || typeof s.pipe !== 'string' || (s.pipe && !/^\\\\\.\\pipe\\codex-app-tools-[a-z0-9-]+$/i.test(s.pipe))) throw new Error('设置参数无效');
      const previous = this.db.settings();
      if ((previous.callerThreadId !== s.callerThreadId || previous.pipe !== s.pipe) && this.db.tasks().some(t => t.enabled))
        throw new Error('修改连接参数前，请先暂停所有托管任务');
      const queue=s.queue ?? previous.queue;
      if(!queue || typeof queue.enabled!=='boolean' || !Number.isInteger(queue.limit) || queue.limit<1 || queue.limit>20) throw new Error('队列限制必须为 1–20');
      const appearance = s.appearance === undefined ? previous.appearance : validateAppearance(s.appearance);
      const quotaCheck = s.quotaCheck === undefined ? previous.quotaCheck : validateQuotaCheck(s.quotaCheck);
      this.db.setSettings({ ...s, queue, quotaCheck, appearance });
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
      if (this.creating.has(target.id) || this.db.tasks().some(t => t.targetThreadId === target.id && (t.enabled || this.db.unresolved(t.id)))) throw new Error('该会话已在托管');
      this.creating.add(target.id);
      try {
        const client = this.getClient();
        const caller = this.db.settings().callerThreadId || discoverCaller();
        let goalId: string | null = null;
        const job = await createJob({ quota: () => client.quota(), send: (id, text) => client.send(id, text), readThread: async id => {
          const view = await this.readTask(id);
          if (currentTaskCompleted(view)) throw new Error('该任务已经完成，无法加入托管列表');
          goalId = view.goal?.id ?? null;
          return view;
        } }, { callerThreadId: caller, targetThreadId: target.id, mode: 'live', now: this.now(), prompt: command.prompt.trim() });
        job.goalId = goalId;
        job.followSession = true; job.maxResumes = command.maxResumes;
        const defaults=defaultTaskConfig();
        const value=validateEditable({...defaults,...command.config,prompt:command.prompt,maxResumes:command.maxResumes});
        this.lease(job);
        try { this.db.add(job,target.title,{...defaults,mode:value.mode,priority:value.priority,expiresAt:value.expiresAt,window:value.window,revision:1,queueOrder:this.db.nextQueueOrder()}); } catch (error) { this.release(job.id); throw error; }
      } finally { this.creating.delete(target.id); }
      return;
    }
    const entry = this.db.jobs().find(t => t.job.id === command.id);
    if (!entry) throw new Error('托管任务不存在');
    if (command.type === 'toggle') {
      const epoch=(this.authorizationEpoch.get(command.id) ?? 0)+1;this.authorizationEpoch.set(command.id,epoch);
      if (typeof command.enabled !== 'boolean') throw new Error('托管开关无效');
      if (command.enabled) {
        if (this.busy) throw new Error('正在检查任务，请稍后继续托管');
        this.busy=true;
        try {
        const config=this.db.config(command.id);
        if (this.db.unresolved(command.id) || ['sending','verifying','send_uncertain'].includes(entry.job.phase)) throw new Error('存在未落定投递，请只核对，不能重新授权');
        if(timePolicy(config,this.now())==='expired') throw new Error('托管已到期，请暂停编辑有效期后重新授权');
        if (config.requiresConfirmation && command.confirmedRevision!==config.revision) throw new Error('请预览配置并确认当前修订的发送授权');
        if (terminal(entry.job.phase) && !config.requiresConfirmation) throw new Error('该任务已结束或需要人工核对，请从会话列表重新托管');
        const view=await this.readTask(entry.job.targetThreadId);
        const quota=await this.getClient().quota();
        if (currentTaskCompleted(view)) throw new Error('该任务已经完成，无法继续托管');
        if (fingerprint(quota)!==entry.job.accountFingerprint || (view.goal?.id ?? null)!==entry.job.goalId || (view.goal && !['active','usage_limited'].includes(view.goal.status))) throw new Error('账号或当前 Goal 与授权不符，请重新核验');
        if (config.mode==='auto' && entry.job.resumeCount >= (entry.job.maxResumes ?? 1)) throw new Error('累计续跑次数已达到上限');
        if(this.stopping || this.authorizationEpoch.get(command.id)!==epoch || this.db.config(command.id).revision!==config.revision || this.db.unresolved(command.id)) throw new Error('重新授权期间状态已变化，请再次核验');
        if (config.requiresConfirmation) {
          entry.job.phase='observing'; entry.job.reason=undefined;
          this.db.journal(command.id).save(entry.job); config.requiresConfirmation=false;this.db.setConfig(command.id,config);
          this.db.event(command.id,'authorization_confirmed',{revision:config.revision});
        }
        this.lease(entry.job);
        } finally {this.busy=false;if(this.authorizationEpoch.get(command.id)!==epoch && !this.db.enabled(command.id) && !this.db.unresolved(command.id))this.release(command.id);}
      }
      this.db.toggle(command.id, command.enabled);
      // 读取期间暂停要保留互斥，当前 tick 完成后才能释放。
      if (!command.enabled && !this.busy && !this.db.unresolved(command.id)) this.release(command.id);
    } else if (command.type === 'remove') {
      if (this.db.unresolved(command.id)) throw new Error('存在未落定投递，不可删除或重建，请先只读核对');
      if (entry.enabled || this.busy) throw new Error('请先暂停托管，等待当前检查结束后移除');
      this.release(command.id); this.db.remove(command.id);
    } else if (command.type === 'reconcile') {
      if (this.busy) throw new Error('正在检查任务，请稍后核对');
      if (!['sending', 'send_uncertain','verifying'].includes(entry.job.phase) && !this.db.unresolved(command.id)) throw new Error('当前任务无需核对发送');
      this.busy = true;
      try {await this.readTask(entry.job.targetThreadId); if(entry.job.phase==='verifying') await this.engine(entry.job).verify();else await this.engine(entry.job).reconcile(); this.finish(entry.job); } finally { this.busy = false; }
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
