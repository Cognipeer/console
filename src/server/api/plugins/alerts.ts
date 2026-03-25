import type { FastifyPluginAsync } from 'fastify';
import type {
  AlertEventStatus,
  IAlertChannel,
  IAlertCondition,
  AlertMetric,
  AlertModule,
  IncidentSeverity,
  IncidentStatus,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  AlertService,
  IncidentService,
  MODULE_METRICS,
  VALID_METRICS,
  VALID_MODULES,
  VALID_WINDOWS,
} from '@/lib/services/alerts';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:alerts');

export const alertsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/alerts/rules', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const rules = await AlertService.listRules(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      return reply.code(200).send({
        meta: {
          moduleMetrics: MODULE_METRICS,
          validMetrics: VALID_METRICS,
          validModules: VALID_MODULES,
          validWindows: VALID_WINDOWS,
        },
        rules,
      });
    } catch (error) {
      logger.error('List alert rules error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/alerts/rules', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      if (!VALID_MODULES.includes(body.module as AlertModule)) {
        return reply.code(400).send({
          error: `module must be one of: ${VALID_MODULES.join(', ')}`,
        });
      }

      if (!VALID_METRICS.includes(body.metric as AlertMetric)) {
        return reply.code(400).send({
          error: `metric must be one of: ${VALID_METRICS.join(', ')}`,
        });
      }

      if (
        !body.condition
        || typeof body.condition !== 'object'
        || typeof (body.condition as { threshold?: unknown }).threshold !== 'number'
      ) {
        return reply.code(400).send({ error: 'condition with numeric threshold is required' });
      }

      if (!VALID_WINDOWS.includes(body.windowMinutes as number)) {
        return reply.code(400).send({
          error: `windowMinutes must be one of: ${VALID_WINDOWS.join(', ')}`,
        });
      }

      const rule = await AlertService.createRule(
        session.tenantDbName,
        session.tenantId,
        projectId,
        session.userId,
        {
          channels: body.channels as IAlertChannel[] | undefined,
          condition: body.condition as IAlertCondition,
          cooldownMinutes: body.cooldownMinutes as number | undefined,
          description: body.description as string | undefined,
          enabled: body.enabled as boolean | undefined,
          metric: body.metric as AlertMetric,
          module: body.module as AlertModule,
          name: body.name,
          scope: body.scope as Record<string, unknown> | undefined,
          windowMinutes: body.windowMinutes as number,
        },
      );

      return reply.code(201).send({ rule });
    } catch (error) {
      logger.error('Create alert rule error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/alerts/rules/:ruleId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { ruleId } = request.params as { ruleId: string };
      const rule = await AlertService.getRule(session.tenantDbName, ruleId);

      if (!rule) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      return reply.code(200).send({ rule });
    } catch (error) {
      logger.error('Get alert rule error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.put('/alerts/rules/:ruleId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { ruleId } = request.params as { ruleId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const rule = await AlertService.updateRule(session.tenantDbName, ruleId, {
        ...body,
        updatedBy: session.userId,
      });

      if (!rule) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      return reply.code(200).send({ rule });
    } catch (error) {
      logger.error('Update alert rule error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.patch('/alerts/rules/:ruleId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { ruleId } = request.params as { ruleId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled (boolean) is required' });
      }

      const rule = await AlertService.toggleRule(
        session.tenantDbName,
        ruleId,
        body.enabled,
        session.userId,
      );

      if (!rule) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      return reply.code(200).send({ rule });
    } catch (error) {
      logger.error('Toggle alert rule error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.delete('/alerts/rules/:ruleId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { ruleId } = request.params as { ruleId: string };
      const deleted = await AlertService.deleteRule(session.tenantDbName, ruleId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Rule not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete alert rule error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/alerts/history', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        limit?: string;
        ruleId?: string;
        skip?: string;
        status?: AlertEventStatus;
      };

      const events = await AlertService.listEvents(session.tenantDbName, session.tenantId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        projectId,
        ruleId: query.ruleId,
        skip: Number.parseInt(query.skip ?? '0', 10),
        status: query.status,
      });

      const activeCount = await AlertService.countActive(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      return reply.code(200).send({ activeCount, events });
    } catch (error) {
      logger.error('List alert history error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/alerts/history/:eventId/acknowledge', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { eventId } = request.params as { eventId: string };
      const event = await AlertService.acknowledgeEvent(session.tenantDbName, eventId);

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      return reply.code(200).send({ event });
    } catch (error) {
      logger.error('Acknowledge alert event error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/alerts/incidents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        limit?: string;
        ruleId?: string;
        severity?: IncidentSeverity;
        skip?: string;
        status?: IncidentStatus;
      };

      const incidents = await IncidentService.listIncidents(session.tenantDbName, session.tenantId, {
        limit: Number.parseInt(query.limit ?? '50', 10),
        projectId,
        ruleId: query.ruleId,
        severity: query.severity,
        skip: Number.parseInt(query.skip ?? '0', 10),
        status: query.status,
      });

      const openCount = await IncidentService.countIncidents(session.tenantDbName, session.tenantId, {
        projectId,
        status: 'open',
      });

      return reply.code(200).send({ incidents, openCount });
    } catch (error) {
      logger.error('List incidents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/alerts/incidents/:incidentId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { incidentId } = request.params as { incidentId: string };
      const incident = await IncidentService.getIncident(session.tenantDbName, incidentId);

      if (!incident) {
        return reply.code(404).send({ error: 'Incident not found' });
      }

      return reply.code(200).send({ incident });
    } catch (error) {
      logger.error('Get incident error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.patch('/alerts/incidents/:incidentId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { incidentId } = request.params as { incidentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const status = body.status;
      const validStatuses = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];

      if (typeof status !== 'string') {
        return reply.code(400).send({ error: 'Status is required' });
      }

      if (!validStatuses.includes(status)) {
        return reply.code(400).send({
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      const incident = await IncidentService.updateStatus(
        session.tenantDbName,
        incidentId,
        status as IncidentStatus,
        session.userId,
      );

      if (!incident) {
        return reply.code(404).send({ error: 'Incident not found' });
      }

      return reply.code(200).send({ incident });
    } catch (error) {
      logger.error('Update incident error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/alerts/incidents/:incidentId/notes', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { incidentId } = request.params as { incidentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.content !== 'string' || body.content.trim() === '') {
        return reply.code(400).send({ error: 'Note content is required' });
      }

      const incident = await IncidentService.addNote(
        session.tenantDbName,
        incidentId,
        session.userId,
        session.userEmail ?? 'Unknown',
        body.content,
      );

      if (!incident) {
        return reply.code(404).send({ error: 'Incident not found' });
      }

      return reply.code(200).send({ incident });
    } catch (error) {
      logger.error('Add incident note error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
