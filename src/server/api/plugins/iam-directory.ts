/**
 * Authorization center API, part 2: people and history. Registered by
 * plugins/iam.ts (paths under `/api/iam`, RBAC service `iam`).
 *
 *   GET /iam/principals?type=user|group|token&q=&limit=&cursor=    paged search
 *   GET /iam/principals/:type/:id?projectId=                        effective permissions, groups, projects, policies
 *   GET /iam/audit?kind=denials|changes|monitor&from&to&principalType&principalId&service&limit&cursor
 *   GET /iam/audit/export                                           the same filters as CSV
 *   GET /iam/settings, PUT /iam/settings                            tenant token policy
 *
 * Paging is server-side and offset based; `cursor` is opaque.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { isPermissionService } from '@/lib/security/rbac';
import { auditItemsToCsv, listAuditFeed, AUDIT_KINDS, type AuditFeedQuery, type AuditKind } from '@/lib/iam/auditFeed';
import { getPrincipalDetail, listPrincipals, PrincipalError, type PrincipalType } from '@/lib/iam/principals';
import { isSafeId, type PolicyIssue } from '@/lib/iam/policySpec';
import { recordIamChange, type IamActor } from '@/lib/iam/audit';
import {
  IamSettingsError,
  getIamSettings,
  parseIamSettingsPatch,
  updateIamSettings,
} from '@/lib/iam/settings';
import {
  requireSessionContext,
  safeReadJsonBody,
  withApiRequestContext,
  type ApiSessionContext,
} from '../fastify-utils';

const logger = createLogger('api:iam-directory');

const PRINCIPAL_TYPES: readonly PrincipalType[] = ['user', 'group', 'token'];
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;
const AUDIT_DEFAULT_PAGE = 50;
const AUDIT_MAX_PAGE = 200;
export const CSV_MAX_ROWS = 10_000;
const MAX_QUERY_LENGTH = 100;

const tenantOf = (s: ApiSessionContext) => ({ tenantDbName: s.tenantDbName, tenantId: s.tenantId });

function fail(reply: FastifyReply, status: number, code: string, error: string, details?: PolicyIssue[]) {
  return reply.code(status).send({ error, code, ...(details && details.length > 0 ? { details } : {}) });
}

const internal = (reply: FastifyReply, what: string, error: unknown) => {
  logger.error(what, { error: error instanceof Error ? error.message : String(error) });
  return fail(reply, 500, 'internal', what);
};

// ── cursors ──────────────────────────────────────────────────────────────

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/**
 * Deepest offset a cursor may carry. A cursor is client-supplied text, and an
 * offset becomes a `skip` in the database: people lists page a directory of tens
 * of thousands, an audit feed that deep should be narrowed with filters instead.
 */
export const MAX_DIRECTORY_OFFSET = 100_000;
export const MAX_AUDIT_OFFSET = 10_000;

/** null = absent (offset 0); 'invalid' = present but not one of ours (or deeper than `maxOffset`). */
export function decodeCursor(value: unknown, maxOffset: number = MAX_DIRECTORY_OFFSET): number | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) return 'invalid';
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.o <= maxOffset ? parsed.o : 'invalid';
  } catch {
    return 'invalid';
  }
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function dateParam(value: unknown): Date | undefined | 'invalid' {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return 'invalid';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

// ── audit filters ────────────────────────────────────────────────────────

function parseAuditQuery(raw: Record<string, unknown>, maxLimit: number, defaultLimit: number):
  | { ok: true; query: AuditFeedQuery }
  | { ok: false; code: string; message: string } {
  const kind = (raw.kind === undefined || raw.kind === '' ? 'denials' : raw.kind) as AuditKind;
  if (!AUDIT_KINDS.includes(kind)) return { ok: false, code: 'invalid_kind', message: `kind must be one of: ${AUDIT_KINDS.join(', ')}` };

  const from = dateParam(raw.from);
  const to = dateParam(raw.to);
  if (from === 'invalid' || to === 'invalid') return { ok: false, code: 'invalid_date', message: 'from and to must be ISO 8601 dates' };

  let principalType: PrincipalType | undefined;
  if (raw.principalType !== undefined && raw.principalType !== '') {
    if (!PRINCIPAL_TYPES.includes(raw.principalType as PrincipalType)) return { ok: false, code: 'invalid_principal', message: 'principalType must be user, group or token' };
    principalType = raw.principalType as PrincipalType;
  }
  let principalId: string | undefined;
  if (raw.principalId !== undefined && raw.principalId !== '') {
    if (!isSafeId(raw.principalId)) return { ok: false, code: 'invalid_principal', message: 'principalId is not a valid id' };
    principalId = raw.principalId;
  }
  if ((principalType && !principalId) || (!principalType && principalId)) {
    return { ok: false, code: 'invalid_principal', message: 'principalType and principalId go together' };
  }
  let service: string | undefined;
  if (raw.service !== undefined && raw.service !== '') {
    if (typeof raw.service !== 'string' || !isPermissionService(raw.service)) return { ok: false, code: 'invalid_service', message: 'Unknown service' };
    service = raw.service;
  }
  const offset = decodeCursor(raw.cursor, MAX_AUDIT_OFFSET);
  if (offset === 'invalid') return { ok: false, code: 'invalid_cursor', message: 'Unknown cursor' };

  return {
    ok: true,
    query: {
      kind,
      from,
      to,
      principalType,
      principalId,
      service,
      limit: intParam(raw.limit, defaultLimit, 1, maxLimit),
      offset: offset ?? 0,
    },
  };
}

// ── plugin ───────────────────────────────────────────────────────────────

export const iamDirectoryApiPlugin: FastifyPluginAsync = async (app) => {
  // ── principals ──────────────────────────────────────────────────────────
  app.get('/iam/principals', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const query = request.query as Record<string, unknown>;
    const type = query.type;
    if (typeof type !== 'string' || !PRINCIPAL_TYPES.includes(type as PrincipalType)) {
      return fail(reply, 400, 'invalid_type', 'type must be user, group or token');
    }
    const offset = decodeCursor(query.cursor);
    if (offset === 'invalid') return fail(reply, 400, 'invalid_cursor', 'Unknown cursor');
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, MAX_QUERY_LENGTH) : '';
    const limit = intParam(query.limit, DEFAULT_PAGE, 1, MAX_PAGE);
    try {
      const page = await listPrincipals(tenantOf(session), { type: type as PrincipalType, q: q || undefined, limit, offset: offset ?? 0 });
      return reply.send({ items: page.items, nextCursor: page.hasMore ? encodeCursor((offset ?? 0) + limit) : null });
    } catch (error) {
      return internal(reply, 'Failed to list principals', error);
    }
  }));

  app.get('/iam/principals/:type/:id', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const { type, id } = request.params as { type: string; id: string };
    if (!PRINCIPAL_TYPES.includes(type as PrincipalType)) return fail(reply, 400, 'invalid_type', 'type must be user, group or token');
    if (!isSafeId(id)) return fail(reply, 404, 'principal_not_found', 'Principal not found');
    const { projectId } = request.query as { projectId?: string };
    if (projectId !== undefined && projectId !== '' && !isSafeId(projectId)) return fail(reply, 400, 'invalid_project', 'projectId is not a valid id');
    try {
      return reply.send(await getPrincipalDetail(tenantOf(session), { type: type as PrincipalType, id, projectId: projectId || null }));
    } catch (error) {
      if (error instanceof PrincipalError) return fail(reply, error.code === 'principal_not_found' ? 404 : 400, error.code, error.message);
      return internal(reply, 'Failed to load the principal', error);
    }
  }));

  // ── audit ───────────────────────────────────────────────────────────────
  app.get('/iam/audit', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const parsed = parseAuditQuery(request.query as Record<string, unknown>, AUDIT_MAX_PAGE, AUDIT_DEFAULT_PAGE);
    if (!parsed.ok) return fail(reply, 400, parsed.code, parsed.message);
    try {
      const page = await listAuditFeed(tenantOf(session), parsed.query);
      const next = parsed.query.offset + parsed.query.limit;
      // Past the deepest page a cursor may reach there is no "next": the reader narrows the filters instead.
      const paged = page.hasMore && next <= MAX_AUDIT_OFFSET;
      const warnings = [...(page.warnings ?? []), ...(page.hasMore && !paged ? ['paging_capped'] : [])];
      return reply.send({
        items: page.items,
        nextCursor: paged ? encodeCursor(next) : null,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      return internal(reply, 'Failed to read the audit trail', error);
    }
  }));

  app.get('/iam/audit/export', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    const raw = request.query as Record<string, unknown>;
    // The export has no cursor and no page size of its own: it walks the feed up to a cap.
    const parsed = parseAuditQuery({ ...raw, cursor: undefined }, AUDIT_MAX_PAGE, AUDIT_MAX_PAGE);
    if (!parsed.ok) return fail(reply, 400, parsed.code, parsed.message);
    try {
      let csv = '';
      let offset = 0;
      let rows = 0;
      let cut = false;
      const warnings = new Set<string>();
      for (;;) {
        const page = await listAuditFeed(tenantOf(session), { ...parsed.query, limit: AUDIT_MAX_PAGE, offset });
        csv += auditItemsToCsv(page.items, offset === 0);
        page.warnings?.forEach((w) => warnings.add(w));
        rows += page.items.length;
        offset += AUDIT_MAX_PAGE;
        if (!page.hasMore) break;
        if (rows >= CSV_MAX_ROWS) {
          cut = true;
          break;
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      if (cut) {
        // Say so IN the file as well as in a header: the file is what gets forwarded to an auditor.
        csv += auditItemsToCsv([{
          id: 'export-truncated', at: new Date().toISOString(), kind: parsed.query.kind, principal: null, service: '', action: '',
          summary: `Export stopped after ${CSV_MAX_ROWS} rows; narrow the filters (dates, person, service) to export the rest`,
        }], false);
      }
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="iam-audit-${parsed.query.kind}-${day}.csv"`)
        .header('cache-control', 'no-store');
      if (cut) reply.header('x-export-truncated', 'true');
      if (warnings.size > 0) reply.header('x-export-warnings', [...warnings].join(','));
      return reply.send(csv || auditItemsToCsv([], true));
    } catch (error) {
      return internal(reply, 'Failed to export the audit trail', error);
    }
  }));

  // ── settings ────────────────────────────────────────────────────────────
  app.get('/iam/settings', withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      return reply.send(await getIamSettings(session.tenantDbName));
    } catch (error) {
      return internal(reply, 'Failed to read the settings', error);
    }
  }));

  // The change is audited by recordIamChange below; the generic request row would repeat it.
  app.put('/iam/settings', { config: { skipAuditOnSuccess: true } }, withApiRequestContext(async (request, reply) => {
    const session = requireSessionContext(request);
    try {
      const patch = parseIamSettingsPatch(safeReadJsonBody(request));
      const previous = await getIamSettings(session.tenantDbName);
      const next = await updateIamSettings(session.tenantDbName, patch, session.userId);
      const actor: IamActor = {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
        userEmail: session.userEmail,
        userRole: session.userRole,
        requestId: session.requestId,
      };
      await recordIamChange(request, actor, {
        event: 'iam.settings.update',
        resourceType: 'iam-settings',
        resourceId: 'settings',
        metadata: { tokens: next.tokens, previous: { tokens: previous.tokens } },
      });
      return reply.send(next);
    } catch (error) {
      if (error instanceof IamSettingsError) {
        return fail(reply, 400, 'validation', error.message, error.details.map((d) => ({ message: d.message, field: d.field })));
      }
      return internal(reply, 'Failed to save the settings', error);
    }
  }));
};
