import type { Clock, DesktopPort, Quota, ThreadView } from './domain.ts';

export class VirtualClock implements Clock {
  time: number;
  constructor(time = 1800000000000) { this.time = time; }
  now() { return this.time; }
  async sleep(ms: number) { this.time += ms; }
}
export function exampleQuota(used: number, reset: number): Quota {
  return {
    accountId: 'simulation-account', ordinaryUsageAllowed: used < 100,
    rateLimitsByLimitId: { codex: {
      primary: { usedPercent: used, windowDurationMins: 300, resetsAt: Math.ceil(reset / 1000) },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.ceil((reset + 86400000) / 1000) },
      rateLimitReachedType: used >= 100 ? 'rateLimitReached' : null,
    } },
  };
}
export function quotaFailure(id = 'blocked-turn', threadId = 'simulation-thread'): ThreadView {
  return {
    thread: { id: threadId, status: { type: 'idle' } },
    turns: [{ id, status: 'failed', error: { codexErrorInfo: 'UsageLimitExceeded' }, items: [] }],
  };
}

export class SimulatedDesktop implements DesktopPort {
  clock: Clock;
  resetAt: number;
  view: ThreadView;
  sends = 0;
  sentAt?: number;
  quotaOverride?: Quota;
  sendError?: Error;
  dropReceipt = false;
  constructor(clock: Clock, resetAfterMs = 10000) {
    this.clock = clock; this.resetAt = clock.now() + resetAfterMs; this.view = quotaFailure();
  }
  async quota() { return structuredClone(this.quotaOverride ?? exampleQuota(this.clock.now() < this.resetAt ? 100 : 0, this.resetAt)); }
  async readThread() { return structuredClone(this.view); }
  async send(id: string, prompt: string) {
    this.sends++; this.sentAt = this.clock.now();
    if (!this.dropReceipt) {
      const marker = prompt.match(/CODEX_RESUME_ACK_[0-9a-f]{32}/)?.[0] ?? 'missing-marker';
      this.view = { thread: { id, status: { type: 'idle' } }, turns: [{
        id: `resumed-${this.sends}`, status: 'completed', items: [
          { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: prompt } },
          { type: 'agentMessage', text: marker },
        ],
      }, ...this.view.turns] };
    }
    if (this.sendError) throw this.sendError;
  }
}

// 混合验证明确替换错误与额度信号；连接、最终额度复查、发送和回执来自真实桌面。
export class HybridDesktop implements DesktopPort {
  real: DesktopPort;
  targetId: string;
  anchorTurnId: string;
  releaseAt: number;
  clock: Clock;
  sent = false;
  constructor(real: DesktopPort, targetId: string, anchorTurnId: string, releaseAt: number, clock: Clock) {
    this.real = real; this.targetId = targetId; this.anchorTurnId = anchorTurnId; this.releaseAt = releaseAt; this.clock = clock;
  }
  async quota() {
    const real = await this.real.quota();
    if (this.clock.now() >= this.releaseAt) return real;
    const injected = structuredClone(real);
    const bucket = injected.rateLimitsByLimitId?.codex ?? injected.rateLimits;
    if (!bucket?.primary) throw new Error('真实额度缺少主窗口，无法构造受限信号');
    bucket.primary.usedPercent = 100;
    bucket.primary.resetsAt = Math.ceil(this.releaseAt / 1000);
    bucket.rateLimitReachedType = 'injected';
    injected.ordinaryUsageAllowed = false;
    return injected;
  }
  async readThread(id: string) {
    const real = await this.real.readThread(id);
    if (id !== this.targetId || this.sent || real.turns[0]?.id !== this.anchorTurnId
      || !['idle', 'notLoaded'].includes(real.thread.status.type)) return real;
    const injected = structuredClone(real);
    injected.turns[0]!.status = 'failed';
    injected.turns[0]!.error = { codexErrorInfo: 'UsageLimitExceeded', message: '测试注入，不是真实额度错误' };
    return injected;
  }
  async send(id: string, prompt: string) {
    if (this.clock.now() < this.releaseAt) throw new Error('混合验证尚未到释放时间');
    const view = await this.real.readThread(id);
    if (view.thread.id !== this.targetId || view.turns[0]?.id !== this.anchorTurnId
      || !['idle', 'notLoaded'].includes(view.thread.status.type) || view.turns[0].status !== 'completed') {
      throw new Error('真实会话已变化，混合验证拒绝发送');
    }
    this.sent = true;
    await this.real.send(id, prompt);
  }
}
