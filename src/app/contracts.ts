import type { Phase, QuotaWindow } from '../domain.ts';
import { defaultAppearance } from './appearance.ts';
import type { Appearance } from './appearance.ts';
import { defaultQuotaCheck } from './quota-schedule.ts';
import type { QuotaCheckSettings } from './quota-schedule.ts';
import type { ResetAppointmentView, ResetCardsSnapshot } from './reset-cards.ts';

export interface ThreadSummary { id: string; title: string; status: string; cwd: string; updatedAt?: string }
export interface Settings { pollSeconds: number; quotaCheck: QuotaCheckSettings; notifications: boolean; closeToTray: boolean; callerThreadId: string; pipe: string; appearance: Appearance; queue:{enabled:boolean;limit:number} }
export interface TaskConfig {
  revision: number; mode: 'auto' | 'observe'; priority: number; queueOrder: number;
  expiresAt: number | null; window: { allDay: boolean; start: number; end: number };
  observedRecovery?: string; notifiedRecovery?: string; requiresConfirmation?: boolean;
}
export interface PromptTemplate { id:string; name:string; body:string; isDefault:boolean }
export interface EditableConfig { prompt:string; maxResumes:number; mode:'auto'|'observe'; priority:number; expiresAt:number|null; window:TaskConfig['window'] }
export interface ManagedTask {
  id: string; title: string; targetThreadId: string; enabled: boolean; phase: Phase;
  reason?: string; createdAt: number; updatedAt: number; nextCheckAt: number;
  resumeCount: number; maxResumes: number; prompt: string; lastError?: string; sentTurnId?: string;
  config:TaskConfig; queuePosition?:number; slotHeld?:boolean;
  evidence: { serverLimitObserved: boolean; serverQuotaBlockedObserved?: boolean; serverRecoveryObserved: boolean; sameThreadReply: boolean };
}
export interface EventRow { id: number; time: number; taskId: string | null; taskName: string | null; type: string; details: Record<string, unknown> }
export type CheckStatus = 'pass' | 'blocked' | 'unknown' | 'unchecked' | 'na';
export interface CheckItem { key: string; label: string; status: CheckStatus; reason: string; advice: string; checkedAt: number | null }
export interface Inspection { checkedAt: number; source: 'read_only'; checks: CheckItem[]; tasks: Record<string, CheckItem[]>; quota?: Snapshot['quota'] }
export interface ArchiveRecord {
  id: string; title: string | null; targetThreadId: string | null; createdAt: number | null; endedAt: number | null;
  reason: string; resumeCount: number | null; incomplete: boolean;
}
export interface AttemptRecord { marker: string; created: number; phase: string; turnId: string | null; revision: number; slot: string }
export interface EventFilter { taskId?: string; from?: number; to?: number; type?: string; reason?: string }
export type DataQuery =
  | { type:'events'; filter?:EventFilter; cursor?:number; boundary?:number; limit?:number }
  | { type:'templates' }
  | { type:'archives'; cursor?:number; limit?:number }
  | { type:'resetAppointments' }
  | { type:'timeline'; taskId:string; cursor?:number; boundary?:number; limit?:number };
export interface DataResult { revisions?:Array<{revision:number;time:number;fields:string[]}>; templates?:PromptTemplate[]; events?:EventRow[]; archives?:ArchiveRecord[]; attempts?:AttemptRecord[]; resetAppointments?:ResetAppointmentView[]; nextCursor?:number; boundary?:number }
export interface Snapshot {
  connection: { state: 'connecting' | 'connected' | 'disconnected'; message: string; checkedAt: number | null };
  quota: { available: boolean; reason: string; windows: Array<QuotaWindow | null>; checkedAt: number } | null;
  queue?:{held:number;enabled:boolean;limit:number};
  inspection?: Inspection;
  nextQuotaCheckAt: number | null;
  resetCards: ResetCardsSnapshot;
  threads: ThreadSummary[]; tasks: ManagedTask[]; events: EventRow[]; settings: Settings;
  runtime: { state: 'starting' | 'running' | 'stopped'; heartbeatAt: number | null; pid?: number; message?: string };
  dataDirectory: string;
}
export type Command =
  | { type: 'refresh' }
  | { type: 'refreshStatus' }
  | { type: 'selfCheck' }
  | { type: 'refreshData' }
  | { type: 'resetCardsRefresh' }
  | { type: 'resetSchedule'; cardKey: string; localTime: string; timeZone: string; confirmed: boolean }
  | { type: 'resetCancel'; id: string }
  | { type: 'resetReconcile'; id: string }
  | { type: 'add'; targetThreadId: string; prompt: string; maxResumes: number; config?: Partial<EditableConfig> }
  | {type:'templateSave'; value:PromptTemplate}
  | {type:'templateDelete'; id:string}
  | {type:'reorder'; id:string; direction:'up'|'down'}
  | {type:'edit'; id:string; revision:number; value:EditableConfig}
  | { type: 'toggle'; id: string; enabled: boolean; confirmedRevision?:number }
  | { type: 'reconcile'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'settings'; value: Settings };
export interface Bridge {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  query(query: DataQuery): Promise<DataResult>;
  exportEvents(filter?: EventFilter): Promise<string | null>;
  openDataDirectory(): Promise<void>;
  quit(): Promise<void>;
}
export const defaultSettings: Settings = {
  pollSeconds: 15, queue:{enabled:false,limit:1}, quotaCheck: { ...defaultQuotaCheck }, notifications: true, closeToTray: true, callerThreadId: '', pipe: '', appearance: { ...defaultAppearance },
};
