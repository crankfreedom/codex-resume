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
  lastObservation?: ThreadObservation;
  evidence: { serverLimitObserved: boolean; serverQuotaBlockedObserved?: boolean; serverRecoveryObserved: boolean; sameThreadReply: boolean };
}
export interface ThreadObservation {
  threadId: string;
  threadStatus: string;
  activeFlags: string[];
  latestTurn: { id: string; status: string; error: Record<string, string> | null; usageLimitDetected: boolean } | null;
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
  // 历史 read_thread 可能只保留 message；真实额度文案使用 U+2019 弯引号。
  const message = typeof value.message === 'string' ? value.message.normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'").replace(/\s+/g, ' ') : '';
  return /\byou(?:'ve| have) hit your usage limit\b|\busage limit (?:has been )?exceeded\b/i.test(message);
}

export function stoppedForQuota(view: ThreadView): boolean {
  const turn = view.turns[0];
  return Boolean(turn && turn.status === 'failed' && isUsageLimit(turn.error));
}

// 只记录状态与有界服务端错误，不收集聊天 items、提示词或账号数据。
export function describeThread(view: ThreadView): ThreadObservation {
  const turn = view.turns[0];
  let error: Record<string, string> | null = null;
  if (turn?.error && typeof turn.error === 'object') {
    error = {};
    const source = turn.error as Record<string, unknown>;
    for (const key of ['code', 'type', 'kind', 'codexErrorInfo', 'message']) {
      const value = source[key];
      if (typeof value === 'string') error[key] = value.slice(0, key === 'message' ? 1000 : 200);
      else if (value && typeof value === 'object' && key !== 'message') {
        // 兼容带标签的错误，只提取标签和基础类型字段。
        const summary = Object.fromEntries(Object.entries(value).slice(0, 8).map(([tag, item]) => [tag.slice(0, 80),
          item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).slice(0, 8)
            .filter(([, field]) => field === null || ['string', 'number', 'boolean'].includes(typeof field))
            .map(([field, content]) => [field.slice(0, 80), typeof content === 'string' ? content.slice(0, 200) : content]))
            : typeof item === 'string' ? item.slice(0, 200) : item]));
        error[key] = JSON.stringify(summary).slice(0, 1000);
      }
    }
    error.fields = Object.keys(source).slice(0, 20).map(key => key.slice(0, 80)).join(',');
  }
  return {
    threadId: view.thread.id, threadStatus: view.thread.status.type,
    activeFlags: [...(view.thread.status.activeFlags ?? [])].sort(),
    latestTurn: turn ? { id: turn.id, status: turn.status, error, usageLimitDetected: stoppedForQuota(view) } : null,
  };
}

export function deliveryHasMarker(turn: Turn, marker: string): boolean {
  return (turn.items ?? []).some((item) => (item.type === 'functionCallOutput' && item.name === 'send_message_to_thread'
    && item.namespace === 'codex_app' && item.output?.text?.includes(marker))
    || (item.type === 'userMessage' && item.text?.includes(marker)));
}
