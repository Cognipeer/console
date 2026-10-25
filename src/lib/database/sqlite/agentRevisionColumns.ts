/**
 * Column codecs for agent test revisions (evaluation targets/runs, red-team
 * campaigns/runs). `agentVersion` is TEXT so it can hold `'draft'` next to a
 * version number; the number therefore comes back as digits.
 */

import type { IAgentRunRevision } from '../provider/types.domain';

export function agentVersionToColumn(value: number | 'draft' | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function agentVersionFromColumn(raw: unknown): number | 'draft' | undefined {
  if (raw === 'draft') return 'draft';
  const version = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

export function agentRevisionFromColumn(raw: unknown): IAgentRunRevision | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as IAgentRunRevision | null;
    return parsed && typeof parsed === 'object' && 'requested' in parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}
