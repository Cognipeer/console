import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getTenantDatabase } from '@/lib/database';
import type {
  AlertEventStatus,
  EntityMetricType,
  AlertModule,
  IncidentSeverity,
  IncidentSort,
  IncidentStatus,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { checkRateLimit, type RateLimitConfig } from '@/lib/services/auth/rateLimiter';
import {
  ALERT_CHANNEL_TYPES,
  AlertService,
  IncidentService,
  MODULE_METRICS,
  VALID_METRICS,
  VALID_MODULES,
  VALID_WINDOWS,
} from '@/lib/services/alerts';
import { AlertApiError } from '@/lib/services/alerts/alertApiError';
import { AlertBacktestService } from '@/lib/services/alerts/alertBacktest';
import { AlertChannelLibraryService } from '@/lib/services/alerts/alertChannelLibrary';
import { resolveEntityPath } from '@/lib/services/alerts/entityLinks';
import { AlertTemplateService } from '@/lib/services/alerts/alertTemplates';
import { authz } from '@/lib/iam/routeAuthz';
import { RULE_SORTS, RULE_STATUS_FILTERS } from '@/lib/services/alerts/ruleInsights';
import {
  BULK_INCIDENT_ACTIONS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATS_RANGE_MS,
  INCIDENT_STATUSES,
} from '@/lib/services/alerts/incidentService';
import type { BulkIncidentAction, IncidentStatsRange } from '@/lib/services/alerts/incidentService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:alerts');

const EVENT_STATUSES: AlertEventStatus[] = ['fired', 'resolved', 'acknowledged'];
const BULK_ACTIONS: BulkIncidentAction[] = BULK_INCIDENT_ACTIONS;
const INCIDENT_SORTS: IncidentSort[] = ['firedAt', '-firedAt', 'updatedAt', '-updatedAt', 'severity', '-severity'];
const STATS_RANGES = Object.keys(INCIDENT_STATS_RANGE_MS) as IncidentStatsRange[];
const DEFAULT_PAGE_SIZE = 50;
/** One more than this is fetched to learn whether another page exists, and the stores clamp at 200. */
const MAX_PAGE_SIZE = 100;
const MAX_NOTE_LENGTH = 4000;
/** The most rows a list skips: deeper pages are not a real use, and a huge offset breaks the stores. */
const MAX_SKIP = 100_000;
const MAX_ENTITY_SEARCH_LENGTH = 200;
const MAX_ENTITY_LINKS = 100;
const ENTITY_LINK_TYPES: EntityMetricType[] = ['agent', 'model', 'kb', 'mcp', 'tool'];
/** A test notification mails / posts to the outside, so it is throttled per person and per project. */
const CHANNEL_TEST_USER_LIMIT: RateLimitConfig = { maxAttempts: 5, windowSeconds: 60 };
const CHANNEL_TEST_PROJECT_LIMIT: RateLimitConfig = { maxAttempts: 20, windowSeconds: 60 };

/** Notes are stored on the incident and returned with it: throttled per person. */
const NOTE_USER_LIMIT: RateLimitConfig = { maxAttempts: 30, windowSeconds: 60 };

/** Backtests read up to a week of rollups: throttled per person and per project. */
const BACKTEST_USER_LIMIT: RateLimitConfig = { maxAttempts: 10, windowSeconds: 60 };
const BACKTEST_PROJECT_LIMIT: RateLimitConfig = { maxAttempts: 30, windowSeconds: 60 };

type ProjectScoped = Awaited<ReturnType<typeof requireProjectContextForRequest>>;

/** The channel library is tenant-wide, so only owners and admins change it. */
function isOwnerOrAdmin(context: ProjectScoped): boolean {
  const role = context.user?.role;
  return role === 'owner' || role === 'admin';
}

function canManageLibrary(context: ProjectScoped): boolean {
  return isOwnerOrAdmin(context);
}

function libraryForbidden(reply: FastifyReply) {
  return reply.code(403).send({
    error: 'Forbidden',
    code: 'forbidden',
    message: 'Only workspace owners and admins can manage the channel library',
  });
}

/**
 * By-id access narrowing. A member only reaches records of the active project
 * (anything else answers 404, exactly like a missing id); owners and admins keep
 * the tenant-wide reach the project resolver already grants them.
 */
function recordScope(context: ProjectScoped): { projectId?: string } {
  if (isOwnerOrAdmin(context)) return {};
  return { projectId: context.projectId };
}

function sendAlertApiError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AlertApiError)) return null;
  return reply.code(error.status).send({
    error: error.message,
    code: error.code,
    message: error.message,
    ...(error.extra ?? {}),
  });
}

/** Every handler: gated by the request context, typed failures answered 4xx, the rest 500 without internals. */
function guarded(label: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return withApiRequestContext(async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be valid JSON' });
      const typed = sendAlertApiError(reply, error);
      if (typed) return typed;
      const projectError = sendProjectContextError(reply, error);
      if (projectError) return projectError;
      logger.error(`${label} error`, { error });
      return reply.code(500).send({ error: 'Internal error' });
    }
  });
}

/** A JSON body that is a plain object; `null`, arrays and scalars are the caller's mistake (400), never a 500. */
function readObjectBody(request: FastifyRequest): Record<string, unknown> {
  const body = readJsonBody<unknown>(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AlertApiError(400, 'invalid_body', 'A JSON object is required');
  }
  return body as Record<string, unknown>;
}

function parsePage(query: { limit?: string; skip?: string }): { limit: number; skip: number } {
  const limit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  const skip = Number.parseInt(query.skip ?? '0', 10);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
    skip: Number.isFinite(skip) ? Math.min(Math.max(skip, 0), MAX_SKIP) : 0,
  };
}

function enumParam<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AlertApiError(400, 'invalid_filter', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringParam(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new AlertApiError(400, 'invalid_filter', `${field} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

/** An ISO date query/body value; anything else is a 400 with `code`. */
function dateValue(value: unknown, field: string, code = 'invalid_filter'): Date {
  const date = typeof value === 'string' && value.length <= 64 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new AlertApiError(400, code, `${field} must be an ISO 8601 date`);
  }
  return date;
}

/** One incident with the display names of its acknowledger, assignee and resolver. */
async function withNames<T extends Parameters<typeof IncidentService.withUserNames>[0]>(tenantDbName: string, incident: T) {
  const names = await IncidentService.resolveUserNames(tenantDbName, [incident]);
  return IncidentService.withUserNames(incident, names);
}

export const alertsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/alerts/rules', guarded('List alert rules', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { projectId, session } = context;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const owner = stringParam(query.owner, 'owner');
    const view = await AlertService.listRulesView(session.tenantDbName, session.tenantId, projectId, {
      includeStats: query.include === 'stats',
      status: enumParam(query.status, 'status', RULE_STATUS_FILTERS),
      owner: owner === 'me' ? session.userId : owner,
      q: stringParam(query.q, 'q', MAX_ENTITY_SEARCH_LENGTH),
      sort: enumParam(query.sort, 'sort', RULE_SORTS),
    });
    const { rules, states } = view;
    const modes = await AlertService.getModeAvailability(session.tenantId);

    return reply.code(200).send({
      meta: {
        moduleMetrics: MODULE_METRICS,
        validMetrics: VALID_METRICS,
        validModules: VALID_MODULES,
        validWindows: VALID_WINDOWS,
        catalog: AlertService.getCatalog(),
        modes,
        channelTypes: ALERT_CHANNEL_TYPES,
      },
      rules,
      states,
      /** Per rule: { status: firing|pending|ok|noData|disabled, muted, noData }. */
      derived: view.derived,
      /** Only with include=stats (or sort=-fired7d): per rule { fired7d, daily7d[7] }; rules without fires are absent. */
      ...(view.stats ? { stats: view.stats, statsCapped: view.statsCapped } : {}),
      /** Over the project's whole rule set, before the filters; `noisy` is null without stats. */
      kpis: view.kpis,
      /** Rules matching the filters. */
      total: view.total,
    });
  }));

  app.post('/alerts/rules', guarded('Create alert rule', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const { templateKey, ...body } = readObjectBody(request);
    // A template customised in the rule form before saving keeps its template mark.
    const rule = templateKey !== undefined
      ? await AlertTemplateService.createFromTemplate(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        body as never,
        templateKey,
      )
      : await AlertService.createRule(session.tenantDbName, session.tenantId, projectId, session.userId, body as never);

    return reply.code(201).send({ rule });
  }));

  app.get('/alerts/templates', guarded('List alert rule templates', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const list = await AlertTemplateService.list(session.tenantDbName, session.tenantId, projectId);
    return reply.code(200).send(list);
  }));

  app.post('/alerts/templates', guarded('Add alert rule templates', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const empty = request.body === undefined || request.body === null || request.body === '';
    const body = empty ? {} : readObjectBody(request);
    const result = await AlertTemplateService.apply(
      session.tenantDbName,
      session.tenantId,
      projectId,
      session.userId,
      { keys: body.keys },
    );
    return reply.code(result.created.length > 0 ? 201 : 200).send(result);
  }));

  app.post('/alerts/rules/preview', guarded('Preview alert rule', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const body = readObjectBody(request);
    const preview = await AlertService.previewRule(session.tenantDbName, session, projectId, body);
    return reply.code(200).send(preview);
  }));

  app.get('/alerts/entities', guarded('List alert entities', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const query = (request.query ?? {}) as { entityType?: string; q?: string; limit?: string };
    const limit = Number.parseInt(query.limit ?? '50', 10);
    const entities = await AlertService.listEntities(session.tenantDbName, session.tenantId, projectId, {
      entityType: query.entityType,
      q: stringParam(query.q, 'q', MAX_ENTITY_SEARCH_LENGTH),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return reply.code(200).send({ entities });
  }));

  app.post('/alerts/channels/test', guarded('Test alert channel', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { projectId, session } = context;
    const body = readObjectBody(request);

    const userLimit = checkRateLimit(`alerts:channel-test:user:${session.tenantDbName}:${session.userId}`, CHANNEL_TEST_USER_LIMIT);
    const projectLimit = userLimit.allowed
      ? checkRateLimit(`alerts:channel-test:project:${session.tenantDbName}:${projectId}`, CHANNEL_TEST_PROJECT_LIMIT)
      : userLimit;
    if (!projectLimit.allowed) {
      reply.header('Retry-After', String(Math.max(1, projectLimit.retryAfterSeconds)));
      throw new AlertApiError(429, 'rate_limited', 'Too many test notifications. Wait a moment and try again.');
    }

    const result = await AlertService.testChannel(
      session.tenantDbName,
      session,
      {
        projectId,
        projectName: context.project?.name ?? '',
        ruleScopeProjectId: recordScope(context).projectId,
        // a shared library channel is tested by the people who manage the library, on every path
        canTestLibrary: canManageLibrary(context),
      },
      body,
    );
    return reply.code(200).send({ result });
  }));

  app.post('/alerts/rules/:ruleId/mute', guarded('Mute alert rule', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { ruleId } = request.params as { ruleId: string };
    const body = readObjectBody(request);
    if (!('until' in body)) {
      throw new AlertApiError(400, 'invalid_until', 'until (ISO date-time, or null to unmute) is required');
    }
    const rule = await AlertService.muteRule(
      session.tenantDbName,
      ruleId,
      { until: body.until, reason: body.reason },
      session.userId,
      recordScope(context),
    );
    if (!rule) return reply.code(404).send({ error: 'Rule not found' });
    return reply.code(200).send({ rule });
  }));

  // Lookup only (writes nothing): a reader may batch-resolve the pages of the entities on screen.
  app.post('/alerts/entities/links', { config: { ...authz.service('alerts', 'read'), skipAuditOnSuccess: true } }, guarded('Resolve entity links', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const body = readObjectBody(request);
    if (!Array.isArray(body.entities) || body.entities.length > MAX_ENTITY_LINKS) {
      throw new AlertApiError(400, 'invalid_entities', `entities must be an array of at most ${MAX_ENTITY_LINKS} items`);
    }
    if (body.projectId !== undefined && (typeof body.projectId !== 'string' || !body.projectId)) {
      throw new AlertApiError(400, 'invalid_project', 'projectId must be a project id');
    }
    const db = await getTenantDatabase(session.tenantDbName);
    // An owner or admin may open an incident of another project; its entities live in that project.
    let projectId = context.projectId;
    if (typeof body.projectId === 'string' && body.projectId !== projectId) {
      const project = isOwnerOrAdmin(context) ? await db.findProjectById(body.projectId).catch(() => null) : null;
      if (!project || String(project.tenantId) !== String(session.tenantId)) {
        throw new AlertApiError(404, 'project_not_found', 'Project not found');
      }
      projectId = body.projectId;
    }
    const links: Record<string, string | null> = {};
    for (const raw of body.entities as Array<{ type?: unknown; key?: unknown }>) {
      const type = raw?.type;
      const key = raw?.key;
      if (typeof type !== 'string' || !ENTITY_LINK_TYPES.includes(type as EntityMetricType) || typeof key !== 'string' || !key || key.length > MAX_ENTITY_SEARCH_LENGTH) {
        throw new AlertApiError(400, 'invalid_entities', 'Every entity needs a valid type and key');
      }
      links[`${type}:${key}`] = await resolveEntityPath(db, projectId, type as EntityMetricType, key);
    }
    return reply.code(200).send({ links });
  }));

  // Replays stored rollups only (nothing is written or sent), so a reader may run it and a success is not an audited change.
  app.post('/alerts/rules/backtest', { config: { ...authz.service('alerts', 'read'), skipAuditOnSuccess: true } }, guarded('Backtest alert rule', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const body = readObjectBody(request);

    const userLimit = checkRateLimit(`alerts:backtest:user:${session.tenantDbName}:${session.userId}`, BACKTEST_USER_LIMIT);
    const projectLimit = userLimit.allowed
      ? checkRateLimit(`alerts:backtest:project:${session.tenantDbName}:${projectId}`, BACKTEST_PROJECT_LIMIT)
      : userLimit;
    if (!projectLimit.allowed) {
      reply.header('Retry-After', String(Math.max(1, projectLimit.retryAfterSeconds)));
      throw new AlertApiError(429, 'rate_limited', 'Too many backtests. Wait a moment and try again.');
    }

    const result = await AlertBacktestService.run(session.tenantDbName, session, projectId, {
      rule: body.rule,
      days: body.days,
    });
    return reply.code(200).send(result);
  }));

  // ── Channel library (tenant-wide; owners and admins manage it, everyone with alerts access reads the masked list) ──

  app.get('/alerts/channels/library', guarded('List library channels', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const channels = await AlertChannelLibraryService.list(session.tenantDbName, session.tenantId, recordScope(context));
    return reply.code(200).send({ channels });
  }));

  app.post('/alerts/channels/library', guarded('Create library channel', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    if (!canManageLibrary(context)) return libraryForbidden(reply);
    const { session } = context;
    const channel = await AlertChannelLibraryService.create(
      session.tenantDbName,
      session.tenantId,
      session.userId,
      readObjectBody(request),
    );
    return reply.code(201).send({ channel });
  }));

  app.patch('/alerts/channels/library/:id', guarded('Update library channel', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    if (!canManageLibrary(context)) return libraryForbidden(reply);
    const { session } = context;
    const { id } = request.params as { id: string };
    const channel = await AlertChannelLibraryService.update(session.tenantDbName, session.tenantId, id, readObjectBody(request));
    return reply.code(200).send({ channel });
  }));

  app.delete('/alerts/channels/library/:id', guarded('Delete library channel', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    if (!canManageLibrary(context)) return libraryForbidden(reply);
    const { session } = context;
    const { id } = request.params as { id: string };
    await AlertChannelLibraryService.remove(session.tenantDbName, session.tenantId, id);
    return reply.code(200).send({ success: true });
  }));

  app.post('/alerts/channels/library/:id/test', guarded('Test library channel', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    if (!canManageLibrary(context)) return libraryForbidden(reply);
    const { projectId, session } = context;
    const { id } = request.params as { id: string };

    const userLimit = checkRateLimit(`alerts:channel-test:user:${session.tenantDbName}:${session.userId}`, CHANNEL_TEST_USER_LIMIT);
    const projectLimit = userLimit.allowed
      ? checkRateLimit(`alerts:channel-test:project:${session.tenantDbName}:${projectId}`, CHANNEL_TEST_PROJECT_LIMIT)
      : userLimit;
    if (!projectLimit.allowed) {
      reply.header('Retry-After', String(Math.max(1, projectLimit.retryAfterSeconds)));
      throw new AlertApiError(429, 'rate_limited', 'Too many test notifications. Wait a moment and try again.');
    }

    const result = await AlertService.testChannel(
      session.tenantDbName,
      session,
      { projectId, projectName: context.project?.name ?? '', canTestLibrary: true },
      { libraryChannelId: id },
    );
    return reply.code(200).send({ result });
  }));

  app.get('/alerts/rules/:ruleId', guarded('Get alert rule', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { ruleId } = request.params as { ruleId: string };
    const rule = await AlertService.getRule(session.tenantDbName, ruleId, recordScope(context));

    if (!rule) {
      return reply.code(404).send({ error: 'Rule not found' });
    }

    const states = await AlertService.listRuleStates(session.tenantDbName, String(rule._id));
    return reply.code(200).send({ rule, states });
  }));

  app.put('/alerts/rules/:ruleId', guarded('Update alert rule', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { ruleId } = request.params as { ruleId: string };
    const body = readObjectBody(request);
    const rule = await AlertService.updateRule(
      session.tenantDbName,
      ruleId,
      { ...body, updatedBy: session.userId } as never,
      recordScope(context),
    );

    if (!rule) {
      return reply.code(404).send({ error: 'Rule not found' });
    }

    return reply.code(200).send({ rule });
  }));

  app.patch('/alerts/rules/:ruleId', guarded('Toggle alert rule', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { ruleId } = request.params as { ruleId: string };
    const body = readObjectBody(request);

    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled (boolean) is required' });
    }

    const rule = await AlertService.toggleRule(
      session.tenantDbName,
      ruleId,
      body.enabled,
      session.userId,
      recordScope(context),
    );

    if (!rule) {
      return reply.code(404).send({ error: 'Rule not found' });
    }

    return reply.code(200).send({ rule });
  }));

  app.delete('/alerts/rules/:ruleId', guarded('Delete alert rule', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { ruleId } = request.params as { ruleId: string };
    const deleted = await AlertService.deleteRule(session.tenantDbName, ruleId, recordScope(context));

    if (!deleted) {
      return reply.code(404).send({ error: 'Rule not found' });
    }

    return reply.code(200).send({ success: true });
  }));

  app.get('/alerts/history', guarded('List alert history', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const query = (request.query ?? {}) as {
      limit?: string;
      ruleId?: string;
      skip?: string;
      status?: string;
    };
    const { limit, skip } = parsePage(query);

    const events = await AlertService.listEvents(session.tenantDbName, session.tenantId, {
      limit,
      projectId,
      ruleId: stringParam(query.ruleId, 'ruleId'),
      skip,
      status: enumParam(query.status, 'status', EVENT_STATUSES),
    });

    const activeCount = await AlertService.countActive(
      session.tenantDbName,
      session.tenantId,
      projectId,
    );

    return reply.code(200).send({ activeCount, events });
  }));

  app.patch('/alerts/history/:eventId/acknowledge', guarded('Acknowledge alert event', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { eventId } = request.params as { eventId: string };
    const event = await AlertService.acknowledgeEvent(session.tenantDbName, eventId, {
      projectId: recordScope(context).projectId,
      userId: session.userId,
    });

    if (!event) {
      return reply.code(404).send({ error: 'Event not found' });
    }

    return reply.code(200).send({ event });
  }));

  app.get('/alerts/incidents', guarded('List incidents', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const query = (request.query ?? {}) as {
      entityKey?: string;
      limit?: string;
      module?: string;
      ruleId?: string;
      severity?: string;
      skip?: string;
      status?: string;
      updatedAfter?: string;
      q?: string;
      assignee?: string;
      sort?: string;
      snoozed?: string;
    };
    // Taken BEFORE the reads: a row written while they run has updatedAt >= serverTime, so the next
    // `updatedAfter=serverTime` poll cannot miss it (it may be seen twice; clients merge by id).
    const serverTime = new Date();
    const { limit, skip } = parsePage(query);
    const status = enumParam<IncidentStatus>(query.status, 'status', INCIDENT_STATUSES);
    const severity = enumParam<IncidentSeverity>(query.severity, 'severity', INCIDENT_SEVERITIES);
    const alertModule = enumParam<AlertModule>(query.module, 'module', VALID_MODULES);
    const ruleId = stringParam(query.ruleId, 'ruleId');
    const entityKey = stringParam(query.entityKey, 'entityKey');
    const updatedAfter = query.updatedAfter === undefined || query.updatedAfter === ''
      ? undefined
      : dateValue(query.updatedAfter, 'updatedAfter');
    const q = stringParam(query.q, 'q')?.trim() || undefined;
    const sort = enumParam<IncidentSort>(query.sort, 'sort', INCIDENT_SORTS);
    const snoozedParam = enumParam<'true' | 'false'>(query.snoozed, 'snoozed', ['true', 'false']);
    const snoozed = snoozedParam === undefined ? undefined : snoozedParam === 'true';
    const assigneeParam = stringParam(query.assignee, 'assignee');
    // 'me' = the caller, 'unassigned' = nobody (null), anything else is a user id.
    const assignee = assigneeParam === undefined
      ? undefined
      : assigneeParam === 'me' ? session.userId
        : assigneeParam === 'unassigned' ? null
          : assigneeParam;

    // One extra row tells whether another page exists.
    const rows = await IncidentService.listIncidents(session.tenantDbName, session.tenantId, {
      entityKey,
      limit: limit + 1,
      module: alertModule,
      projectId,
      ruleId,
      severity,
      skip,
      status,
      updatedAfter,
      q,
      assignee,
      snoozed,
      sort,
    });
    const hasMore = rows.length > limit;
    const incidents = hasMore ? rows.slice(0, limit) : rows;

    const counts = await IncidentService.countByStatus(session.tenantDbName, projectId);
    const filtered = Boolean(severity || alertModule || ruleId || entityKey || updatedAfter || q || assignee !== undefined || snoozed !== undefined);
    const statusTotal = status
      ? counts[status]
      : INCIDENT_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    // The stores count by project and status only; with other filters the total is the rows seen so far (+1 when more exist).
    const total = filtered ? skip + incidents.length + (hasMore ? 1 : 0) : statusTotal;

    const names = await IncidentService.resolveUserNames(session.tenantDbName, incidents);
    return reply.code(200).send({
      incidents: incidents.map((incident) => IncidentService.withUserNames(incident, names)),
      total,
      hasMore,
      openCount: counts.open ?? 0,
      counts,
      serverTime: serverTime.toISOString(),
    });
  }));

  // Static path: registered next to (and wins over) /alerts/incidents/:incidentId.
  app.get('/alerts/incidents/stats', guarded('Incident stats', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const query = (request.query ?? {}) as { range?: string };
    const range = enumParam<IncidentStatsRange>(query.range, 'range', STATS_RANGES) ?? '24h';
    const stats = await IncidentService.stats(session.tenantDbName, projectId, range);
    return reply.code(200).send({ ...stats, range });
  }));

  app.post('/alerts/incidents/bulk', guarded('Bulk update incidents', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const body = readObjectBody(request);

    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || !id)) {
      throw new AlertApiError(400, 'invalid_ids', 'ids must be an array of incident ids');
    }
    const action = enumParam<BulkIncidentAction>(body.action, 'action', BULK_ACTIONS);
    if (!action) throw new AlertApiError(400, 'invalid_action', `action must be one of: ${BULK_ACTIONS.join(', ')}`);

    let assignedTo: string | null | undefined;
    let until: Date | undefined;
    if (action === 'assign') {
      if (body.assignedTo !== null && typeof body.assignedTo !== 'string') {
        throw new AlertApiError(400, 'invalid_assignee', 'assignedTo must be a user id, "me" or null');
      }
      assignedTo = body.assignedTo === 'me' ? session.userId : (body.assignedTo as string | null);
    }
    if (action === 'snooze') until = dateValue(body.until, 'until', 'invalid_snooze');

    // Bulk always works inside the active project, owner or not: a list selection never spans projects.
    const result = await IncidentService.bulkUpdate(
      session.tenantDbName,
      body.ids as string[],
      action,
      { userId: session.userId },
      { projectId: context.projectId },
      { assignedTo, until },
    );
    return reply.code(200).send(result);
  }));

  app.get('/alerts/incidents/:incidentId/deliveries', guarded('Incident deliveries', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const incident = await IncidentService.getIncident(session.tenantDbName, incidentId, recordScope(context));
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    const deliveries = await AlertService.listIncidentDeliveries(session.tenantDbName, session.tenantId, String(incident._id));
    return reply.code(200).send({ deliveries });
  }));

  app.get('/alerts/incidents/:incidentId/similar', guarded('Similar incidents', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const incident = await IncidentService.getIncident(session.tenantDbName, incidentId, recordScope(context));
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    return reply.code(200).send(await IncidentService.similar(session.tenantDbName, session.tenantId, incident));
  }));

  app.get('/alerts/incidents/:incidentId', guarded('Get incident', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const incident = await IncidentService.getIncident(session.tenantDbName, incidentId, recordScope(context));

    if (!incident) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    return reply.code(200).send({ incident: await withNames(session.tenantDbName, incident) });
  }));

  app.patch('/alerts/incidents/:incidentId', guarded('Update incident', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const body = readObjectBody(request);
    const scope = recordScope(context);

    const hasStatus = body.status !== undefined;
    const hasAssignee = body.assignedTo !== undefined;
    const hasSnooze = body.snoozedUntil !== undefined;
    if (!hasStatus && !hasAssignee && !hasSnooze) {
      return reply.code(400).send({ error: 'Status is required' });
    }

    let incident = await IncidentService.getIncident(session.tenantDbName, incidentId, scope);
    if (!incident) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    if (hasStatus) {
      if (typeof body.status !== 'string') {
        return reply.code(400).send({ error: 'Status is required' });
      }
      if (!INCIDENT_STATUSES.includes(body.status as IncidentStatus)) {
        return reply.code(400).send({
          error: `Invalid status. Must be one of: ${INCIDENT_STATUSES.join(', ')}`,
        });
      }
    }
    if (hasAssignee && body.assignedTo !== null && typeof body.assignedTo !== 'string') {
      return reply.code(400).send({ error: 'assignedTo must be a user id, "me" or null' });
    }
    const snoozeUntil = hasSnooze && body.snoozedUntil !== null
      ? dateValue(body.snoozedUntil, 'snoozedUntil', 'invalid_snooze')
      : null;
    // Validate every field before writing any, so a bad one never leaves a half-applied change.
    if (snoozeUntil) IncidentService.assertSnoozeWindow(snoozeUntil);
    IncidentService.assertPatchable(incident, {
      status: hasStatus ? (body.status as IncidentStatus) : undefined,
      snoozeUntil,
    });
    const assignee = hasAssignee
      ? await IncidentService.resolveAssignee(
        session.tenantDbName,
        body.assignedTo === 'me' ? session.userId : (body.assignedTo as string | null),
      )
      : null;

    if (hasStatus) {
      const updated = await IncidentService.updateStatus(
        session.tenantDbName,
        incidentId,
        body.status as IncidentStatus,
        session.userId,
        scope,
      );
      if (!updated) return reply.code(404).send({ error: 'Incident not found' });
      incident = updated;
    }
    if (hasAssignee) {
      const updated = await IncidentService.assign(session.tenantDbName, incidentId, assignee, scope);
      if (!updated) return reply.code(404).send({ error: 'Incident not found' });
      incident = updated;
    }
    if (hasSnooze) {
      const updated = await IncidentService.snooze(session.tenantDbName, incidentId, snoozeUntil, session.userId, scope);
      if (!updated) return reply.code(404).send({ error: 'Incident not found' });
      incident = updated;
    }

    return reply.code(200).send({ incident: await withNames(session.tenantDbName, incident) });
  }));

  app.post('/alerts/incidents/:incidentId/notes', guarded('Add incident note', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const body = readObjectBody(request);

    if (typeof body.content !== 'string' || body.content.trim() === '') {
      return reply.code(400).send({ error: 'Note content is required' });
    }
    if (body.content.length > MAX_NOTE_LENGTH) {
      return reply.code(400).send({ error: `Note content must be at most ${MAX_NOTE_LENGTH} characters` });
    }
    const noteLimit = checkRateLimit(`alerts:note:user:${session.tenantDbName}:${session.userId}`, NOTE_USER_LIMIT);
    if (!noteLimit.allowed) {
      reply.header('Retry-After', String(Math.max(1, noteLimit.retryAfterSeconds)));
      throw new AlertApiError(429, 'rate_limited', 'Too many notes. Wait a moment and try again.');
    }

    const incident = await IncidentService.addNote(
      session.tenantDbName,
      incidentId,
      session.userId,
      session.userEmail ?? 'Unknown',
      body.content,
      recordScope(context),
    );

    if (!incident) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    return reply.code(200).send({ incident: await withNames(session.tenantDbName, incident) });
  }));
};
