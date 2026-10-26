import { randomUUID } from 'node:crypto';
import {
  deliveryHasMarker, fingerprint, quotaGate, stoppedForQuota, terminal, DispatchCancelledBeforeSend,
} from './domain.ts';
import type { Clock, DesktopPort, Job, Journal, Mode, Quota, ThreadView } from './domain.ts';

export async function createJob(port: DesktopPort, options: {
  callerThreadId: string; targetThreadId: string; mode: Mode; now: number; prompt?: string;
}): Promise<Job> {
  const quota = await port.quota();
  const view = await port.readThread(options.targetThreadId);
  if (view.thread.id !== options.targetThreadId) throw new Error('目标会话身份不匹配');
  const marker = `CODEX_RESUME_ACK_${randomUUID().replaceAll('-', '')}`;
  return {
    version: 1, id: randomUUID(), mode: options.mode,
    callerThreadId: options.callerThreadId, targetThreadId: options.targetThreadId,
    bucketId: 'codex', accountFingerprint: fingerprint(quota), phase: 'observing',
    createdAt: options.now, nextCheckAt: options.now, marker,
    prompt: options.prompt ? `续跑投递标记：${marker}\n\n${options.prompt}`
      : `这是用户授权的额度恢复续跑验证。仅回复完整标记 ${marker}。禁止调用工具、读写文件、执行命令、联网或继续旧项目工作。回复后结束。`,
    verifyMarker: !options.prompt, resumeCount: 0, baselineTurnIds: [],
    evidence: { serverLimitObserved: false, serverQuotaBlockedObserved: false, serverRecoveryObserved: false, sameThreadReply: false },
  };
}

export class ResumeEngine {
  job: Job;
  port: DesktopPort;
  clock: Clock;
  journal: Journal;
  private scheduleQuota?: (quota: Quota, now: number) => number;
  constructor(job: Job, port: DesktopPort, clock: Clock, journal: Journal, scheduleQuota?: (quota: Quota, now: number) => number) {
    this.job = job; this.port = port; this.clock = clock; this.journal = journal;
    this.scheduleQuota = scheduleQuota;
  }
  private persist() { this.journal.save(this.job); }
  private stop(reason: string) {
    this.job.phase = 'suspended'; this.job.reason = reason;
    this.persist(); this.journal.event('suspended', { reason });
  }
  private sameStoppedTurn(view: ThreadView): boolean {
    if (view.thread.id !== this.job.targetThreadId) { this.stop('thread_identity_changed'); return false; }
    if (view.thread.status.type === 'active' || view.thread.status.activeFlags?.length) {
      this.stop('manual_activity_or_approval'); return false;
    }
    if (view.turns[0]?.id !== this.job.blockedTurnId) { this.stop('thread_changed_since_block'); return false; }
    if (!stoppedForQuota(view)) { this.stop('no_longer_quota_failure'); return false; }
    return true;
  }
  async step(options: { forceQuotaCheck?: boolean; nextQuotaCheckAt?: number } = {}): Promise<void> {
    const job = this.job;
    const wasWaiting = job.phase === 'waiting_quota';
    if (terminal(job.phase)) return;
    if (job.phase === 'sending') {
      // 可能在网络已收件但本地未记账时崩溃；只对账，不重复发送。
      job.phase = 'send_uncertain'; job.reason = 'restart_during_send'; this.persist();
      this.journal.event('send_uncertain', { reason: job.reason }); return;
    }
    if (job.phase === 'verifying') { await this.verify(); return; }
    const view = await this.port.readThread(job.targetThreadId);
    if (view.thread.id !== job.targetThreadId) { this.stop('thread_identity_changed'); return; }
    if (job.phase === 'observing') {
      if (view.thread.status.type === 'active') return;
      if (view.thread.status.activeFlags?.length) { this.stop('approval_or_input_pending'); return; }
      if (!stoppedForQuota(view)) {
        if (view.turns[0]?.status === 'completed' && job.followSession) {
          if (job.reason !== 'awaiting_actual_quota_event') {
            job.reason = 'awaiting_actual_quota_event'; this.persist();
            this.journal.event('observing_completed_session', { reason: job.reason, noMessageSent: true });
          }
          return;
        }
        if (view.turns[0] && view.turns[0].status !== 'inProgress') this.stop('last_turn_not_quota_failure');
        return;
      }
      job.blockedTurnId = view.turns[0]!.id;
      job.reason = undefined;
      job.phase = 'waiting_quota';
      if (job.mode === 'live') job.evidence.serverLimitObserved = true;
      this.persist();
      this.journal.event('quota_stop_detected', { mode: job.mode, source: job.mode === 'live' ? 'server_error' : 'injected', blockedTurnId: job.blockedTurnId });
    } else if (!this.sameStoppedTurn(view)) return;
    if (wasWaiting && options.nextQuotaCheckAt !== undefined && job.nextCheckAt !== options.nextQuotaCheckAt) {
      job.nextCheckAt = options.nextQuotaCheckAt; this.persist();
    }
    if (!options.forceQuotaCheck && this.clock.now() < job.nextCheckAt) return;
    const quota = await this.port.quota();
    if (fingerprint(quota) !== job.accountFingerprint) { this.stop('account_changed'); return; }
    const gate = quotaGate(quota, job.bucketId, this.clock.now());
    this.journal.event('quota_checked', { mode: job.mode, ...gate });
    if (!gate.available) {
      if (job.mode === 'live' && gate.reason === 'quota_blocked') job.evidence.serverQuotaBlockedObserved = true;
      job.nextCheckAt = this.scheduleQuota?.(quota, this.clock.now()) ?? gate.nextCheckAt; this.persist(); return;
    }
    // 最后一道会话检查放在额度查询之后，减少人工恢复与自动发送的竞态窗口。
    const finalView = await this.port.readThread(job.targetThreadId);
    if (!this.sameStoppedTurn(finalView)) return;
    if (job.mode === 'live' && job.evidence.serverQuotaBlockedObserved) job.evidence.serverRecoveryObserved = true;
    job.baselineTurnIds = finalView.turns.map((turn) => turn.id);
    job.phase = 'sending'; job.resumeCount += 1; job.sentAt = this.clock.now();
    this.persist();
    this.journal.event('send_intent_persisted', { targetThreadId: job.targetThreadId, marker: job.marker, resumeCount: job.resumeCount });
    try { await this.port.send(job.targetThreadId, job.prompt); }
    catch (error) {
      if (error instanceof DispatchCancelledBeforeSend) {
        job.resumeCount -= 1; this.stop('monitoring_paused_before_send'); return;
      }
      job.phase = 'send_uncertain'; job.reason = 'send_response_uncertain'; this.persist();
      this.journal.event('send_uncertain', { reason: job.reason, message: (error as Error).message }); return;
    }
    job.phase = 'verifying'; job.nextCheckAt = this.clock.now(); this.persist();
    this.journal.event('resume_submitted', { targetThreadId: job.targetThreadId });
  }
  async verify(): Promise<void> {
    const job = this.job;
    const view = await this.port.readThread(job.targetThreadId);
    if (view.thread.id !== job.targetThreadId) { this.stop('thread_identity_changed'); return; }
    // 同时校验输入投递标记，防止把人工启动的另一轮误当作自动续跑成功。
    const own = view.turns.find((turn) => !job.baselineTurnIds.includes(turn.id) && deliveryHasMarker(turn, job.marker));
    if (!own) {
      if (job.sentAt && this.clock.now() - job.sentAt > 180000) {
        job.phase = 'send_uncertain'; job.reason = 'receipt_not_found_no_automatic_resend';
        this.persist(); this.journal.event('send_uncertain', { reason: job.reason });
      }
      return;
    }
    if (job.sentTurnId && own.id !== job.sentTurnId) { this.stop('resume_turn_identity_changed'); return; }
    job.sentTurnId = own.id; this.persist();
    if (own.status === 'inProgress') return;
    if (own.status !== 'completed') {
      if (job.followSession && own.id === view.turns[0]?.id
        && stoppedForQuota({ thread: view.thread, turns: [own] })
        && job.resumeCount < (job.maxResumes ?? 1)) {
        const nextMarker = `CODEX_RESUME_ACK_${randomUUID().replaceAll('-', '')}`;
        job.prompt = job.prompt.replaceAll(job.marker, nextMarker); job.marker = nextMarker;
        job.phase = 'observing'; job.reason = undefined; job.sentTurnId = undefined; job.sentAt = undefined;
        job.baselineTurnIds = []; job.nextCheckAt = this.clock.now();
        this.persist(); this.journal.event('next_quota_cycle', { resumeCount: job.resumeCount }); return;
      }
      this.stop('resumed_turn_failed_or_interrupted'); return;
    }
    if (job.verifyMarker) {
      const items = own.items ?? [];
      const reply = items.some((item) => item.type === 'agentMessage' && item.text?.trim() === job.marker);
      const actions = items.filter((item) => !['agentMessage', 'reasoning', 'userMessage'].includes(item.type)
        && !(item.type === 'functionCallOutput' && item.name === 'send_message_to_thread' && item.namespace === 'codex_app'));
      if (!reply || actions.length) { this.stop('validation_reply_or_actions_mismatch'); return; }
    }
    job.evidence.sameThreadReply = true; job.phase = 'completed'; this.persist();
    this.journal.event('completed', {
      mode: job.mode, targetThreadId: job.targetThreadId, turnId: own.id, resumeCount: job.resumeCount,
      evidence: job.evidence, verdict: job.mode === 'live'
        ? job.evidence.serverLimitObserved && job.evidence.serverQuotaBlockedObserved && job.evidence.serverRecoveryObserved
          ? 'live_e2e_passed' : 'live_resume_verified'
        : `${job.mode}_passed`,
    });
  }
  async reconcile(): Promise<void> {
    if (!['send_uncertain', 'sending'].includes(this.job.phase)) return;
    this.job.phase = 'verifying'; this.persist();
    await this.verify();
    if (this.job.phase === 'verifying' && !this.job.sentTurnId) {
      this.job.phase = 'send_uncertain'; this.job.reason = 'receipt_not_found_no_automatic_resend'; this.persist();
    }
  }
  async run(options: { pollMs: number; maxMs: number; signal?: AbortSignal }) {
    const deadline = this.clock.now() + options.maxMs;
    while (!terminal(this.job.phase) && !options.signal?.aborted && this.clock.now() < deadline) {
      try { await this.step(); }
      catch (error) {
        this.journal.event('read_retry', { message: (error as Error).message });
        // 只读失败允许稍后重连，发送异常不会进入此分支。
      }
      if (!terminal(this.job.phase)) await this.clock.sleep(Math.min(options.pollMs, Math.max(0, deadline - this.clock.now())));
    }
    return this.job.phase;
  }
}
