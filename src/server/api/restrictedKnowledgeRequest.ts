/**
 * Who may read a stored copy that holds passages of documents not open to everyone (`kbRestricted` on a session, a
 * model log row, an evaluation item...; see rag/access/exposure.ts): the person it was made for, and whoever reads
 * every knowledge base it names through the admin exception. That is a `rag` administrator of the knowledge base's
 * project, as the engine decides for this request, where the knowledge base keeps the exception on. An API token
 * never is one, and neither is a call an application makes for a person (ragAccessRequest.ts).
 *
 * Asked once per knowledge base per request: a list of a hundred rows that name two knowledge bases costs two
 * engine questions. When the engine cannot decide, the 503 it throws is the caller's to answer, never an allow.
 */

import type { FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope, type IEvaluationRunItem, type IRedTeamAttemptResult } from '@/lib/database';
import { parseRestrictedKnowledgeTag, restrictedKnowledgeTagsOf } from '@/lib/services/rag/access/exposure';
import { serviceActionAllowedForRequest } from './fastify-utils';

export interface RestrictedKnowledgeReader {
  /** Whether the viewer reads the knowledge base `tag` names through the admin exception. */
  readsThroughException(tag: string): Promise<boolean>;
  /**
   * Whether the viewer may read a copy marked with `tags`: nothing is marked, the viewer is one of `askers`, or the
   * viewer reads every knowledge base named through the admin exception.
   */
  mayRead(tags: unknown, askers: ReadonlyArray<string | null | undefined>): Promise<boolean>;
}

const logger = createLogger('api:restricted-knowledge');

const readers = new WeakMap<FastifyRequest, Map<string, RestrictedKnowledgeReader>>();

/**
 * The viewer a request through an API token is: the token, never its owner. A token reads only what is open to
 * everyone and to the token itself, so a copy made for its owner is not the token's to read; one made for work the
 * token did is. Never equal to a user id.
 */
export function apiTokenViewer(tokenId: string): string {
  return `api_token:${tokenId}`;
}

/**
 * The reader for `viewerUserId` in this request (`tenantDbName` is where the knowledge bases live): a user id, or
 * `apiTokenViewer(id)` where an API token calls. Kept on the request, so the handlers and helpers of one request share
 * its answers.
 */
export function restrictedKnowledgeReaderFor(
  request: FastifyRequest,
  input: { tenantDbName: string; viewerUserId: string | null | undefined },
): RestrictedKnowledgeReader {
  const viewer = input.viewerUserId ? String(input.viewerUserId) : '';
  let byViewer = readers.get(request);
  if (!byViewer) {
    byViewer = new Map();
    readers.set(request, byViewer);
  }
  const memoKey = `${input.tenantDbName}\u0000${viewer}`;
  const known = byViewer.get(memoKey);
  if (known) return known;

  const answers = new Map<string, Promise<boolean>>();
  const readsThroughException = (tag: string): Promise<boolean> => {
    let pending = answers.get(tag);
    if (!pending) {
      pending = decide(request, input.tenantDbName, tag);
      answers.set(tag, pending);
      // An engine outage is not kept: the next question asks again.
      pending.catch(() => {
        if (answers.get(tag) === pending) answers.delete(tag);
      });
    }
    return pending;
  };
  const reader: RestrictedKnowledgeReader = {
    readsThroughException,
    async mayRead(tags, askers) {
      const marks = restrictedKnowledgeTagsOf(tags);
      if (marks.length === 0) return true;
      if (viewer && askers.some((id) => id !== null && id !== undefined && String(id) === viewer)) return true;
      for (const tag of marks) {
        if (!(await readsThroughException(tag))) return false;
      }
      return true;
    },
  };
  byViewer.set(memoKey, reader);
  return reader;
}

async function decide(request: FastifyRequest, tenantDbName: string, tag: string): Promise<boolean> {
  // Only a person acting for themselves administers a knowledge base.
  if (request.apiTokenContext) return false;
  const named = parseRestrictedKnowledgeTag(tag);
  if (!named) return false;
  const ragModule = await runWithTenantScope(tenantDbName, (db) => db.findRagModuleByKey(named.key, named.projectId ?? ''));
  // A knowledge base that gave up the exception is read by nobody past its permissions; one that is gone is
  // answered for by the administrators of the project it was in.
  if (ragModule?.access?.adminBypass === false) return false;
  return serviceActionAllowedForRequest(request, 'rag', 'admin', { projectId: named.projectId ?? null });
}

/**
 * The rows of a list whose content the viewer may not read: `markOf` says what each row is marked with and whom it
 * was made for. A row the engine could not decide for is counted in (shown without its content, never with it), so
 * a list still answers.
 */
export async function rowsWithHiddenContent<T>(
  request: FastifyRequest,
  input: { tenantDbName: string; viewerUserId: string | null | undefined },
  rows: ReadonlyArray<T>,
  markOf: (row: T) => { tags: unknown; askers: ReadonlyArray<string | null | undefined> },
): Promise<Set<T>> {
  const hidden = new Set<T>();
  const reader = restrictedKnowledgeReaderFor(request, input);
  for (const row of rows) {
    const mark = markOf(row);
    if (restrictedKnowledgeTagsOf(mark.tags).length === 0) continue;
    try {
      if (!(await reader.mayRead(mark.tags, mark.askers))) hidden.add(row);
    } catch (error) {
      hidden.add(row);
      logger.warn('Restricted content check failed, row content hidden', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return hidden;
}

/**
 * MCP request log rows of knowledge base calls that handed on passages not open to everyone (the provider marks the
 * logged summary with `restrictedKnowledge`): a viewer who may not read them sees the call without what was asked
 * (`arguments`) or what failed.
 */
export async function withoutRestrictedMcpLogContent<T extends {
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  callerUserId?: string;
  userId?: string;
}>(
  request: FastifyRequest,
  input: { tenantDbName: string; viewerUserId: string | null | undefined },
  rows: T[],
): Promise<Array<T | (T & { restricted: true })>> {
  const hidden = await rowsWithHiddenContent(request, input, rows, (row) => ({
    tags: row.responsePayload?.restrictedKnowledge,
    askers: [row.callerUserId, row.userId],
  }));
  if (hidden.size === 0) return rows;
  return rows.map((row) => {
    if (!hidden.has(row)) return row;
    const tool = row.requestPayload?.tool;
    return {
      ...row,
      requestPayload: { ...(tool !== undefined ? { tool } : {}), arguments: { omitted: true, reason: 'restricted' } },
      errorMessage: undefined,
      restricted: true as const,
    };
  });
}

/**
 * Whom an evaluation run's stored copies were made for: the caller that started it. A run a token started, the token
 * (`apiTokenViewer`) and the person who owns it, who may act as the token anyway; a run a person started, that person.
 * A run that does not record its caller names only the person in `createdBy` (a token never reads it as its own).
 */
function evaluationRunAskers(run: { createdBy?: string; actorType?: string; apiTokenId?: string }): string[] {
  const person = run.createdBy ? [run.createdBy] : [];
  return run.actorType === 'api_token' && run.apiTokenId ? [apiTokenViewer(run.apiTokenId), ...person] : person;
}

/**
 * An evaluation run, with the items whose work handed on passages of knowledge base documents not open to everyone
 * (`kbRestricted`) cut down for a viewer who may not read them: the score and the verdict stay, the output, the
 * scorers' details and the error go. Whoever started the run may read them (`evaluationRunAskers`).
 */
export async function withoutRestrictedRunItems<
  R extends { createdBy?: string; actorType?: string; apiTokenId?: string; items?: IEvaluationRunItem[] },
>(
  request: FastifyRequest,
  input: { tenantDbName: string; viewerUserId: string | null | undefined },
  run: R,
): Promise<R> {
  const items = run.items ?? [];
  const askers = evaluationRunAskers(run);
  const hidden = await rowsWithHiddenContent(request, input, items, (item) => ({ tags: item.kbRestricted, askers }));
  if (hidden.size === 0) return run;
  return {
    ...run,
    items: items.map((item): IEvaluationRunItem => (hidden.has(item)
      ? {
        itemId: item.itemId,
        scores: item.scores.map((score) => ({ scorerType: score.scorerType, score: score.score, passed: score.passed, weight: score.weight })),
        score: item.score,
        passed: item.passed,
        ...(item.latencyMs !== undefined ? { latencyMs: item.latencyMs } : {}),
        ...(item.usage ? { usage: item.usage } : {}),
        restricted: true,
      }
      : item)),
  };
}

/**
 * A red-team run, with the attempts whose work handed on passages of knowledge base documents not open to everyone
 * cut down for a viewer who may not read them: the finding (outcome, severity, category, verdict) stays, the
 * transcript, the detectors' rationales and the error go. The run's starter may read them.
 */
export async function withoutRestrictedAttempts<R extends { createdBy?: string; attempts?: IRedTeamAttemptResult[] }>(
  request: FastifyRequest,
  input: { tenantDbName: string; viewerUserId: string | null | undefined },
  run: R,
): Promise<R> {
  const attempts = run.attempts ?? [];
  const hidden = await rowsWithHiddenContent(request, input, attempts, (attempt) => ({ tags: attempt.kbRestricted, askers: [run.createdBy] }));
  if (hidden.size === 0) return run;
  return {
    ...run,
    attempts: attempts.map((attempt): IRedTeamAttemptResult => {
      if (!hidden.has(attempt)) return attempt;
      const { error: _error, ...rest } = attempt;
      void _error;
      return {
        ...rest,
        transcript: [],
        signals: attempt.signals.map(({ error: _signalError, ...signal }) => (void _signalError, { ...signal, rationale: '' })),
        restricted: true,
      };
    }),
  };
}
