/**
 * Cluster admin API.
 *
 * Read-only inspection of the cluster topology + CRUD on instance
 * assignments. Listing assignable instances spans every tenant, so the
 * caller must be a privileged session — gated through `requireSessionContext`
 * for now; tighten with RBAC when the cluster permission tier is defined.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getClusterOverview,
  listAssignableInstances,
  assignInstance,
  unassignInstance,
} from '@/lib/services/cluster/clusterAdminService';
import type { InstanceEntityType, InstanceAssignmentMode } from '@/lib/core/cluster';
import { recordAuditLog } from '@/lib/services/audit';
import { requireSessionContext, withApiRequestContext } from '../fastify-utils';

const log = createLogger('api:cluster');

const VALID_ENTITY_TYPES: InstanceEntityType[] = [
  'agent',
  'mcp',
  'browser',
  'js-sandbox',
  'inference-server',
  'alert-rule',
  'automation',
];

const VALID_MODES: InstanceAssignmentMode[] = ['strict', 'preferred'];

function isEntityType(value: string): value is InstanceEntityType {
  return (VALID_ENTITY_TYPES as string[]).includes(value);
}

function isMode(value: unknown): value is InstanceAssignmentMode {
  return typeof value === 'string' && (VALID_MODES as string[]).includes(value);
}

export const clusterApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/cluster/overview', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const overview = await getClusterOverview();
      return reply.code(200).send(overview);
    } catch (error) {
      log.error('Cluster overview failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/cluster/instances', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      const instances = await listAssignableInstances();
      return reply.code(200).send({ instances });
    } catch (error) {
      log.error('List cluster instances failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.put('/cluster/assignments/:entityType/:entityId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const params = request.params as { entityType: string; entityId: string };
      if (!isEntityType(params.entityType)) {
        return reply.code(400).send({ error: 'Invalid entityType' });
      }
      const body = (request.body ?? {}) as { nodeName?: unknown; mode?: unknown };
      if (typeof body.nodeName !== 'string' || body.nodeName.trim() === '') {
        return reply.code(400).send({ error: 'nodeName is required' });
      }
      const mode: InstanceAssignmentMode = isMode(body.mode) ? body.mode : 'strict';
      const assignment = await assignInstance({
        entityType: params.entityType,
        entityId: params.entityId,
        nodeName: body.nodeName.trim(),
        mode,
        updatedBy: session.userId ?? null,
      });
      await recordAuditLog(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        {
          service: 'cluster',
          action: 'admin',
          event: 'cluster.assignment.set',
          actorType: 'user',
          actorUserId: session.userId,
          actorEmail: session.userEmail,
          outcome: 'success',
          resourceType: 'instance-assignment',
          resourceId: `${params.entityType}:${params.entityId}`,
          metadata: { nodeName: assignment.nodeName, mode: assignment.mode },
        },
      );
      return reply.code(200).send({ assignment });
    } catch (error) {
      log.error('Assign instance failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/cluster/assignments/:entityType/:entityId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const params = request.params as { entityType: string; entityId: string };
      if (!isEntityType(params.entityType)) {
        return reply.code(400).send({ error: 'Invalid entityType' });
      }
      const removed = await unassignInstance(params.entityType, params.entityId);
      if (removed) {
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'cluster',
            action: 'admin',
            event: 'cluster.assignment.delete',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'instance-assignment',
            resourceId: `${params.entityType}:${params.entityId}`,
            metadata: {},
          },
        );
      }
      return reply.code(200).send({ removed });
    } catch (error) {
      log.error('Unassign instance failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
