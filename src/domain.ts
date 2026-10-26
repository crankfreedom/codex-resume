import { createHash } from 'node:crypto';

export type Mode = 'live' | 'hybrid' | 'simulation';
export type Phase = 'observing' | 'waiting_quota' | 'sending' | 'verifying' | 'completed' | 'suspended' | 'send_uncertain';
export interface Turn {
  id: string;
  status: string;
  error?: unknown;
  items?: Array<{ type: string; name?: string; namespace?: string; text?: string; output?: { text?: string } }>;
}
export interface ThreadView {
  thread: { id: string; title?: string; status: { type: string; activeFlags?: string[] } };
  turns: Turn[];
}
export interface QuotaWindow {
  usedPercent?: number | null;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}
export interface QuotaBucket {
  primary?: QuotaWindow | null;
  secondary?: QuotaWindow | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean;
  planType?: string;
}
export interface Quota {
  accountId?: string | null;
  ordinaryUsageAllowed?: boolean;
  rateLimits?: QuotaBucket | null;
  rateLimitsByLimitId?: Record<string, QuotaBucket | null> | null;
}
export interface Job {
  version: 1;
  id: string;
  mode: Mode;
  callerThreadId: string;
  targetThreadId: string;
  bucketId: string;
  accountFingerprint: string;
  phase: Phase;
  createdAt: number;
  nextCheckAt: number;
  blockedTurnId?: string;
  sentTurnId?: string;
  sentAt?: number;
  marker: string;
  prompt: string;
  verifyMarker: boolean;
  followSession?: boolean;
  resumeCount: number;
  maxResumes?: number;
  baselineTurnIds: string[];
  reason?: string;
  evidence: { serverLimitObserved: boolean; serverQuotaBlockedObserved?: boolean; serverRecoveryObserved: boolean; sameThreadReply: boolean };
}
export interface DesktopPort {
  quota(): Promise<Quota>;
  readThread(id: string): Promise<ThreadView>;
  send(id: string, prompt: string): Promise<void>;
}
// 仅用于发送调用之前的本地取消；网络错误绝不能转换成这个类型。
export class DispatchCancelledBeforeSend extends Error {}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface Journal {
  save(job: Job): void;
  event(type: string, details?: Record<string, unknown>): void;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
export const terminal = (phase: Phase) => ['completed', 'suspended', 'send_uncertain'].includes(phase);

export function fingerprint(quota: Quota): string {
  if (typeof quota.accountId !== 'string' || !quota.accountId) throw new Error('账号身份不可用，拒绝授权续跑');
  return createHash('sha256').update(quota.accountId).digest('hex');
}

export function quotaGate(quota: Quota, bucketId: string, now: number, bufferMs = 5000) {
  // 新式目录存在时，缺失的桶不能用旧式单桶视图冒充。
  const bucket = quota.rateLimitsByLimitId != null ? quota.rateLimitsByLimitId[bucketId] : quota.rateLimits;
  const nextPoll = now + 60000;
  if (!bucket) return { available: false, nextCheckAt: nextPoll, reason: 'quota_unknown', windows: [] };
  const windows = [bucket.primary, bucket.secondary];
  const unknown = windows.some((window) => !window || !Number.isFinite(window.usedPercent)
    || window.usedPercent! < 0 || window.usedPercent! > 100);
  const blocked = windows.filter((window) => window != null && window.usedPercent! >= 100);
  const blockedResets = blocked.map((window) => window!.resetsAt).filter((reset): reset is number =>
    typeof reset === 'number' && Number.isFinite(reset) && reset > 0);
  const reset = blockedResets.length ? Math.max(...blockedResets) * 1000 + bufferMs : nextPoll;
  const reached = Boolean(bucket.rateLimitReachedType) || bucket.spendControlReached === true || quota.ordinaryUsageAllowed === false;
  return {
    available: !unknown && blocked.length === 0 && !reached,
    // 重置时间只用于安排复查；到点后仍需重新请求真实额度。
    nextCheckAt: Math.min(nextPoll, reset > now ? reset : now + 15000),
    reason: unknown ? 'quota_unknown' : blocked.length || reached ? 'quota_blocked' : 'quota_available',
    windows: windows.map((window) => window ? {
      usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins, resetsAt: window.resetsAt,
    } : null),
  };
}

export function isUsageLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  const known = ['code', 'type', 'codexErrorInfo', 'kind'];
  const normalize = (text: string) => text.replace(/[_\-\s]/g, '').toLowerCase();
  for (const key of known) {
    if (typeof value[key] === 'string' && normalize(value[key]) === 'usagelimitexceeded') return true;
    if (value[key] && typeof value[key] === 'object') {
      const tagged = value[key] as Record<string, unknown>;
      if (Object.keys(tagged).some((tag) => normalize(tag) === 'usagelimitexceeded')) return true;
      if (isUsageLimit(tagged)) return true;
    }
  }
  // 仅检查服务端 error 字段，不从模型回复或用户文本推断额度状态。
  return typeof value.message === 'string'
    && /you(?:'ve| have) hit your usage limit|usage limit (?:has been )?exceeded/i.test(value.message);
}

export function stoppedForQuota(view: ThreadView): boolean {
  const turn = view.turns[0];
  return Boolean(turn && turn.status === 'failed' && isUsageLimit(turn.error));
}

export function deliveryHasMarker(turn: Turn, marker: string): boolean {
  return (turn.items ?? []).some((item) => (item.type === 'functionCallOutput' && item.name === 'send_message_to_thread'
    && item.namespace === 'codex_app' && item.output?.text?.includes(marker))
    || (item.type === 'userMessage' && item.text?.includes(marker)));
}
