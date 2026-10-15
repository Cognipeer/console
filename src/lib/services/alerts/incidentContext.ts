/**
 * Incident context: what an on-call person wants to know the moment an alert
 * fires, gathered once at FIRE time.
 *
 * Core part (every edition): the mode and window, and for an agent whether its
 * version changed versus the previous window and which error signatures dominate
 * its failed sessions. The enterprise enricher (correlated dependency
 * regressions) is merged in with a short timeout; a failure never blocks the alert.
 *
 * Failing sessions are linked by a list URL, never by session ids.
 */

import type {
  DatabaseProvider,
  EntityMetricType,
  IAlertRule,
  IIncidentContext,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getIncidentEnricher } from '@/enterprise/alert-extensions';

const logger = createLogger('alert-incident-context');

const SESSION_SAMPLE_LIMIT = 2000;
const FAILED_SESSION_SAMPLE_LIMIT = 200;
const MAX_SIGNATURES = 5;
const MAX_SIGNATURE_LENGTH = 160;
export const ENRICHER_TIMEOUT_MS = 3_000;

export interface IncidentContextInput {
  db: DatabaseProvider;
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  rule: IAlertRule;
  entityType: EntityMetricType | null;
  entityKey: string;
  windowMinutes: number;
  nowMs: number;
}

/** First line of an error message with ids and numbers masked, so equal failures group together. */
export function normalizeErrorSignature(message: unknown): string {
  if (typeof message !== 'string') return '';
  const firstLine = message.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const normalized = firstLine
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/\d{2,}/g, '<n>')
    .replace(/\s+/g, ' ');
  return normalized.length > MAX_SIGNATURE_LENGTH ? `${normalized.slice(0, MAX_SIGNATURE_LENGTH - 1)}…` : normalized;
}

/** The top error signatures of a set of failed sessions (`errors[].message`). */
export function summarizeErrorSignatures(
  sessions: Array<{ errors?: Array<Record<string, unknown>> | null }>,
): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const errors = Array.isArray(session.errors) ? session.errors : [];
    // One signature counts once per session, so a retry loop does not drown the rest.
    const seen = new Set<string>();
    for (const error of errors) {
      const signature = normalizeErrorSignature(error?.message);
      if (signature) seen.add(signature);
    }
    for (const signature of seen) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SIGNATURES)
    .map(([message, count]) => ({ message, count }));
}

function versionsOf(sessions: Array<{ agentVersion?: string | null }>): string[] {
  // Sessions arrive newest first, so the first entry is the latest version.
  const seen: string[] = [];
  for (const session of sessions) {
    const version = typeof session.agentVersion === 'string' ? session.agentVersion.trim() : '';
    if (version && !seen.includes(version)) seen.push(version);
  }
  return seen;
}

async function agentContext(input: IncidentContextInput, context: IIncidentContext): Promise<void> {
  const { db, projectId, entityKey, nowMs, windowMinutes } = input;
  const windowMs = windowMinutes * 60_000;
  const from = new Date(nowMs - windowMs).toISOString();
  const previousFrom = new Date(nowMs - 2 * windowMs).toISOString();
  const to = new Date(nowMs).toISOString();

  const [current, previous, failed] = await Promise.all([
    db.listAgentTracingSessions({
      agentNameExact: entityKey,
      from,
      to,
      limit: SESSION_SAMPLE_LIMIT,
      includeTotal: false,
      projection: { agentVersion: 1, startedAt: 1 },
    }, projectId),
    db.listAgentTracingSessions({
      agentNameExact: entityKey,
      from: previousFrom,
      to: from,
      limit: SESSION_SAMPLE_LIMIT,
      includeTotal: false,
      projection: { agentVersion: 1, startedAt: 1 },
    }, projectId),
    db.listAgentTracingSessions({
      agentNameExact: entityKey,
      status: 'error',
      from,
      to,
      limit: FAILED_SESSION_SAMPLE_LIMIT,
      includeTotal: true,
      projection: { errors: 1, startedAt: 1 },
    }, projectId),
  ]);

  const currentVersions = versionsOf(current.sessions);
  const previousVersions = versionsOf(previous.sessions);
  const introduced = currentVersions.find((version) => !previousVersions.includes(version));
  // With no sessions before the window there is nothing to compare with: a quiet agent or a new one did not "change version".
  context.versionChange = previousVersions.length > 0 && introduced !== undefined
    ? { from: previousVersions[0] ?? null, to: introduced }
    : null;

  const signatures = summarizeErrorSignatures(failed.sessions);
  if (signatures.length > 0) context.errorSignatures = signatures;

  const query = new URLSearchParams({ agent: entityKey, status: 'error', from, to });
  context.failingSessions = failed.total > 0
    ? { count: failed.total, listPath: `/dashboard/tracing/sessions?${query.toString()}` }
    : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Merge what the enterprise enricher adds; its lists extend, its other fields win. */
function mergeEnrichment(context: IIncidentContext, extra: Partial<IIncidentContext>): void {
  const { notes, correlations, ...rest } = extra;
  Object.assign(context, rest);
  if (correlations?.length) context.correlations = correlations;
  if (notes?.length) context.notes = [...(context.notes ?? []), ...notes];
}

export async function buildIncidentContext(input: IncidentContextInput): Promise<IIncidentContext> {
  const context: IIncidentContext = {
    mode: input.rule.condition.mode ?? 'threshold',
    windowMinutes: input.windowMinutes,
  };

  if (input.entityType === 'agent' && input.entityKey) {
    try {
      await agentContext(input, context);
    } catch (error) {
      logger.warn('Could not gather agent incident context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const enricher = getIncidentEnricher();
  if (enricher) {
    try {
      const extra = await withTimeout(
        enricher({
          tenantDbName: input.tenantDbName,
          tenantId: input.tenantId,
          projectId: input.projectId,
          rule: input.rule,
          entityType: input.entityType,
          entityKey: input.entityKey,
          windowMinutes: input.windowMinutes,
          nowMs: input.nowMs,
        }),
        ENRICHER_TIMEOUT_MS,
      );
      if (extra) mergeEnrichment(context, extra);
      else logger.warn('Incident enricher timed out', { timeoutMs: ENRICHER_TIMEOUT_MS });
    } catch (error) {
      logger.warn('Incident enricher failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return context;
}
