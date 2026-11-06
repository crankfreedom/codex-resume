import { createHash } from 'node:crypto';
import type { Quota } from '../domain.ts';

export type ResetCreditStatus = 'available' | 'redeeming' | 'redeemed' | 'unknown';
export type ResetAppointmentStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missed' | 'uncertain';
export type ResetConsumeOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

export interface RawResetCredit {
  id: string;
  title?: string | null;
  description?: string | null;
  status: ResetCreditStatus;
  resetType: string;
  grantedAt: number;
  expiresAt?: number | null;
}
export interface ResetRateLimits extends Quota {
  rateLimitResetCredits?: { availableCount: number; credits?: RawResetCredit[] | null } | null;
}
export interface ResetCard {
  key: string;
  title: string;
  description: string | null;
  status: ResetCreditStatus;
  resetType: string;
  grantedAt: number;
  expiresAt: number | null;
  idSuffix: string;
}
export interface ResetCardsSnapshot {
  cards: ResetCard[];
  availableCount: number | null;
  details: 'unchecked' | 'unavailable' | 'empty' | 'available';
  checkedAt: number | null;
  error: string | null;
  userAgent: string | null;
}
export interface ResetAppointment {
  id: string;
  cardKey: string;
  creditId: string;
  cardTitle: string;
  idSuffix: string;
  scheduledAt: number;
  timeZone: string;
  localTime: string;
  accountFingerprint: string;
  idempotencyKey: string;
  requestId: string;
  status: ResetAppointmentStatus;
  reason: string | null;
  message: string | null;
  outcome: ResetConsumeOutcome | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
}
export type ResetAppointmentView = Omit<ResetAppointment, 'creditId' | 'accountFingerprint'>;
export interface ResetCreditPort {
  read(): Promise<{ quota: ResetRateLimits; userAgent: string | null }>;
  consume(creditId: string, idempotencyKey: string): Promise<ResetConsumeOutcome>;
}

export const initialResetCards: ResetCardsSnapshot = {
  cards: [], availableCount: null, details: 'unchecked', checkedAt: null, error: null, userAgent: null,
};
export const resetExecutionGraceMs = 10_000;
export const resetCardKey = (creditId: string) => createHash('sha256').update(creditId).digest('hex');

export function publicResetCards(quota: ResetRateLimits): Array<{ raw: RawResetCredit; view: ResetCard }> {
  const credits = quota.rateLimitResetCredits?.credits;
  if (!Array.isArray(credits)) return [];
  return credits.flatMap(credit => {
    if (!credit || typeof credit.id !== 'string' || !credit.id || credit.id.length > 512) return [];
    const status: ResetCreditStatus = ['available', 'redeeming', 'redeemed'].includes(credit.status) ? credit.status : 'unknown';
    const expiresAt = typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) ? credit.expiresAt * 1000 : null;
    const grantedAt = Number.isFinite(credit.grantedAt) ? credit.grantedAt * 1000 : 0;
    return [{ raw: credit, view: {
      key: resetCardKey(credit.id), title: String(credit.title ?? '重置卡'), description: credit.description ?? null,
      status, resetType: String(credit.resetType ?? 'unknown'), grantedAt, expiresAt, idSuffix: credit.id.slice(-6),
    } }];
  });
}

export function resetCardsSnapshot(quota: ResetRateLimits, checkedAt: number, userAgent: string | null): ResetCardsSnapshot {
  const summary = quota.rateLimitResetCredits;
  const cards = publicResetCards(quota).map(entry => entry.view);
  return {
    cards, availableCount: typeof summary?.availableCount === 'number' ? summary.availableCount : null,
    details: !summary || !Array.isArray(summary.credits) ? 'unavailable' : cards.length ? 'available' : 'empty',
    checkedAt, error: null, userAgent,
  };
}
