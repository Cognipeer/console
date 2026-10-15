import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AlertEventStatus,
  AlertModule,
  IncidentSeverity,
  IncidentStatus,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
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
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@/lib/services/alerts/incidentService';
import type { BulkIncidentAction } from '@/lib/services/alerts/incidentService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:alerts');

const EVENT_STATUSES: AlertEventStatus[] = ['fired', 'resolved', 'acknowledged'];
const BULK_ACTIONS: BulkIncidentAction[] = ['acknowledge', 'resolve', 'close'];
const DEFAULT_PAGE_SIZE = 50;
/** One more than this is fetched to learn whether another page exists, and the stores clamp at 200. */
const MAX_PAGE_SIZE = 100;
const MAX_NOTE_LENGTH = 4000;
const MAX_ENTITY_SEARCH_LENGTH = 200;

type ProjectScoped = Awaited<ReturnType<typeof requireProjectContextForRequest>>;

/**
 * By-id access narrowing. A member only reaches records of the active project
 * (anything else answers 404, exactly like a missing id); owners and admins keep
 * the tenant-wide reach the project resolver already grants them.
 */
function recordScope(context: ProjectScoped): { projectId?: string } {
  const role = context.user?.role;
  if (role === 'owner' || role === 'admin') return {};
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
    skip: Number.isFinite(skip) ? Math.max(skip, 0) : 0,
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

export const alertsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/alerts/rules', guarded('List alert rules', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { projectId, session } = context;
    const rules = await AlertService.listRules(session.tenantDbName, session.tenantId, projectId);
    const [modes, states] = await Promise.all([
      AlertService.getModeAvailability(session.tenantId),
      AlertService.stateCounts(session.tenantDbName, rules.map((rule) => String(rule._id))),
    ]);

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
    });
  }));

  app.post('/alerts/rules', guarded('Create alert rule', async (request, reply) => {
    const { projectId, session } = await requireProjectContextForRequest(request);
    const body = readObjectBody(request);

    const rule = await AlertService.createRule(
      session.tenantDbName,
      session.tenantId,
      projectId,
      session.userId,
      body as never,
    );

    return reply.code(201).send({ rule });
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
    const result = await AlertService.testChannel(
      session.tenantDbName,
      session,
      {
        projectId,
        projectName: context.project?.name ?? '',
        ruleScopeProjectId: recordScope(context).projectId,
      },
      body,
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
    };
    const { limit, skip } = parsePage(query);
    const status = enumParam<IncidentStatus>(query.status, 'status', INCIDENT_STATUSES);
    const severity = enumParam<IncidentSeverity>(query.severity, 'severity', INCIDENT_SEVERITIES);
    const alertModule = enumParam<AlertModule>(query.module, 'module', VALID_MODULES);
    const ruleId = stringParam(query.ruleId, 'ruleId');
    const entityKey = stringParam(query.entityKey, 'entityKey');

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
    });
    const hasMore = rows.length > limit;
    const incidents = hasMore ? rows.slice(0, limit) : rows;

    const counts = await IncidentService.countByStatus(session.tenantDbName, projectId);
    const filtered = Boolean(severity || alertModule || ruleId || entityKey);
    const statusTotal = status
      ? counts[status]
      : INCIDENT_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    // The stores count by project and status only; with other filters the total is the rows seen so far (+1 when more exist).
    const total = filtered ? skip + incidents.length + (hasMore ? 1 : 0) : statusTotal;

    return reply.code(200).send({ incidents, total, hasMore, openCount: counts.open ?? 0, counts });
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

    // Bulk always works inside the active project, owner or not: a list selection never spans projects.
    const result = await IncidentService.bulkUpdate(
      session.tenantDbName,
      body.ids as string[],
      action,
      { userId: session.userId },
      { projectId: context.projectId },
    );
    return reply.code(200).send(result);
  }));

  app.get('/alerts/incidents/:incidentId', guarded('Get incident', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const incident = await IncidentService.getIncident(session.tenantDbName, incidentId, recordScope(context));

    if (!incident) {
      return reply.code(404).send({ error: 'Incident not found' });
    }

    return reply.code(200).send({ incident });
  }));

  app.patch('/alerts/incidents/:incidentId', guarded('Update incident', async (request, reply) => {
    const context = await requireProjectContextForRequest(request);
    const { session } = context;
    const { incidentId } = request.params as { incidentId: string };
    const body = readObjectBody(request);
    const scope = recordScope(context);

    const hasStatus = body.status !== undefined;
    const hasAssignee = body.assignedTo !== undefined;
    if (!hasStatus && !hasAssignee) {
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
      const assignee = body.assignedTo === 'me' ? session.userId : (body.assignedTo as string | null);
      const updated = await IncidentService.assign(session.tenantDbName, incidentId, assignee, scope);
      if (!updated) return reply.code(404).send({ error: 'Incident not found' });
      incident = updated;
    }

    return reply.code(200).send({ incident });
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

    return reply.code(200).send({ incident });
  }));
};
