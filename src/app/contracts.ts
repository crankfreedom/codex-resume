import type { Phase, QuotaWindow } from '../domain.ts';
import { defaultAppearance } from './appearance.ts';
import type { Appearance } from './appearance.ts';
import { defaultQuotaCheck } from './quota-schedule.ts';
import type { QuotaCheckSettings } from './quota-schedule.ts';

export interface ThreadSummary { id: string; title: string; status: string; cwd: string; updatedAt?: string }
export interface Settings { pollSeconds: number; quotaCheck: QuotaCheckSettings; notifications: boolean; closeToTray: boolean; callerThreadId: string; pipe: string; appearance: Appearance }
export interface ManagedTask {
  id: string; title: string; targetThreadId: string; enabled: boolean; phase: Phase;
  reason?: string; createdAt: number; updatedAt: number; nextCheckAt: number;
  resumeCount: number; maxResumes: number; prompt: string; lastError?: string;
  evidence: { serverLimitObserved: boolean; serverQuotaBlockedObserved?: boolean; serverRecoveryObserved: boolean; sameThreadReply: boolean };
}
export interface EventRow { id: number; time: number; taskId: string | null; type: string; details: Record<string, unknown> }
export interface Snapshot {
  connection: { state: 'connecting' | 'connected' | 'disconnected'; message: string; checkedAt: number | null };
  quota: { available: boolean; reason: string; windows: Array<QuotaWindow | null>; checkedAt: number } | null;
  nextQuotaCheckAt: number | null;
  threads: ThreadSummary[]; tasks: ManagedTask[]; events: EventRow[]; settings: Settings;
  runtime: { state: 'starting' | 'running' | 'stopped'; heartbeatAt: number | null; pid?: number; message?: string };
  dataDirectory: string;
}
export type Command =
  | { type: 'refresh' }
  | { type: 'add'; targetThreadId: string; prompt: string; maxResumes: number }
  | { type: 'toggle'; id: string; enabled: boolean }
  | { type: 'reconcile'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'settings'; value: Settings };
export interface Bridge {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  exportEvents(): Promise<string | null>;
  openDataDirectory(): Promise<void>;
  quit(): Promise<void>;
}
export const defaultSettings: Settings = {
  pollSeconds: 15, quotaCheck: { ...defaultQuotaCheck }, notifications: true, closeToTray: true, callerThreadId: '', pipe: '', appearance: { ...defaultAppearance },
};
