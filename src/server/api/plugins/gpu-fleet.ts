/**
 * Admin-facing GPU fleet API.
 *
 * Routes under `/api/gpu-fleet/*` are gated by the standard cookie-session
 * auth. They surface hosts, slices, and deployments for the UI and let
 * operators rotate registration tokens, create deployments, etc.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { recordAuditLog } from '@/lib/services/audit';
import { requireSessionContext, safeReadJsonBody, withApiRequestContext } from '../fastify-utils';
import {
  BundleNotFound,
  applyMigLayoutCommand,
  claimPendingHost,
  createDeployment,
  createGpuHost,
  createTerminalSession,
  deleteDeployment,
  deleteGpuHost,
  describeBundle,
  disableFleetToken,
  enqueueCommand,
  getGpuHost,
  getOrInitFleetSettings,
  isSupportedPlatform,
  listAvailableBundles,
  listDeploymentsByHost,
  listGpuHosts,
  listModelLibrary,
  listPendingClaimHosts,
  listSlicesForHost,
  readBundleStream,
  rejectPendingHost,
  renderInstallSnippet,
  rotateFleetToken,
  rotateRegistrationToken,
  restartDeployment,
  stopDeployment,
  updateAgentDistribution,
  type AgentPlatform,
} from '@/lib/services/gpuFleet';
import type { AgentDistributionMode } from '@/lib/database';
import type { TerminalSandbox } from '@cognipeer/gpu-fleet-protocol';
import type { LlmDeploymentRuntime } from '@/lib/database';

const log = createLogger('api:gpu-fleet');

const SUPPORTED_RUNTIMES: LlmDeploymentRuntime[] = ['vllm', 'tgi', 'ollama', 'custom'];

function isRuntime(value: unknown): value is LlmDeploymentRuntime {
  return typeof value === 'string' && (SUPPORTED_RUNTIMES as string[]).includes(value);
}

function sanitizeHost(host: Awaited<ReturnType<typeof listGpuHosts>>[number]) {
  return {
    id: host.id,
    name: host.name,
    provider: host.provider,
    status: host.status,
    accelerator: host.accelerator,
    gpuFramework: host.gpuFramework,
    serviceAddress: host.serviceAddress,
    terminalEnabled: host.terminalEnabled,
    labels: host.labels,
    inventory: host.inventory,
    lastHeartbeatAt: host.lastHeartbeatAt,
    agentVersion: host.agentVersion,
    paired: host.agentTokenHash !== null,
    awaitingRegistration: host.registrationTokenHash !== null,
    createdAt: host.createdAt,
  };
}

export const gpuFleetApiPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/gpu-fleet/hosts',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const hosts = await listGpuHosts(session.tenantDbName, session.tenantId);
        return reply.code(200).send({ hosts: hosts.map(sanitizeHost) });
      } catch (error) {
        log.error('list gpu hosts failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post(
    '/gpu-fleet/hosts',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const body = safeReadJsonBody(request) as { name?: unknown; provider?: unknown; labels?: unknown };
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          return reply.code(400).send({ error: 'name is required' });
        }
        const result = await createGpuHost({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          name: body.name,
          provider: typeof body.provider === 'string'
            ? (body.provider as 'azure' | 'aws' | 'gcp' | 'self')
            : 'self',
          labels: body.labels && typeof body.labels === 'object'
            ? (body.labels as Record<string, string>)
            : undefined,
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.create',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: result.host.id,
            metadata: { name: result.host.name, provider: result.host.provider },
          },
        );
        return reply.code(201).send({
          host: sanitizeHost(result.host),
          registrationToken: result.registrationToken,
          registrationTokenExpiresAt: result.registrationTokenExpiresAt,
          tenantSlug: session.tenantSlug,
        });
      } catch (error) {
        log.error('create gpu host failed', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.get<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const host = await getGpuHost(session.tenantDbName, (request.params as { hostId: string }).hostId);
        if (!host || host.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Host not found' });
        }
        const [slices, deployments] = await Promise.all([
          listSlicesForHost(session.tenantDbName, host.id),
          listDeploymentsByHost(session.tenantDbName, host.id),
        ]);
        return reply.code(200).send({
          host: sanitizeHost(host),
          slices,
          deployments,
        });
      } catch (error) {
        log.error('get gpu host failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.patch<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/service-address',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const hostId = (request.params as { hostId: string }).hostId;
        const body = safeReadJsonBody(request) as { serviceAddress?: unknown };
        const newAddress = body.serviceAddress;
        if (newAddress !== null && typeof newAddress !== 'string') {
          return reply.code(400).send({
            error: 'serviceAddress must be a string (e.g. "10.0.0.4" or "ec2-X.compute.amazonaws.com") or null to clear.',
          });
        }
        // Loose validation: IP4, IP6, or DNS hostname. Server-side check
        // here mostly catches typos; the real test is whether the pool
        // proxy can reach it.
        if (typeof newAddress === 'string' && newAddress.trim()) {
          const trimmed = newAddress.trim();
          if (!/^[a-zA-Z0-9.:\-_]+$/.test(trimmed) || trimmed.length > 253) {
            return reply.code(400).send({
              error: 'serviceAddress must be an IP or a DNS hostname (a-z, 0-9, . : - _)',
            });
          }
        }
        const { getDatabase } = await import('@/lib/database');
        const db = await getDatabase();
        await db.switchToTenant(session.tenantDbName);
        const host = await db.findGpuHostById(hostId);
        if (!host || host.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Host not found' });
        }
        await db.updateGpuHost(hostId, {
          serviceAddress: typeof newAddress === 'string' ? newAddress.trim() || null : null,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.service-address.update',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: hostId,
            metadata: { previous: host.serviceAddress, next: newAddress },
          },
        );
        const refreshed = await db.findGpuHostById(hostId);
        return reply.code(200).send({ host: refreshed ? sanitizeHost(refreshed) : null });
      } catch (error) {
        log.error('update host service-address failed', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/rotate-token',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const result = await rotateRegistrationToken(
          session.tenantDbName,
          (request.params as { hostId: string }).hostId,
        );
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.rotate-token',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: (request.params as { hostId: string }).hostId,
            metadata: {},
          },
        );
        return reply.code(200).send({
          registrationToken: result.registrationToken,
          expiresAt: result.expiresAt,
          tenantSlug: session.tenantSlug,
        });
      } catch (error) {
        log.error('rotate gpu host token failed', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.delete<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const removed = await deleteGpuHost(session.tenantDbName, (request.params as { hostId: string }).hostId);
        if (!removed) return reply.code(404).send({ error: 'Host not found' });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.delete',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: (request.params as { hostId: string }).hostId,
            metadata: {},
          },
        );
        return reply.code(204).send();
      } catch (error) {
        log.error('delete gpu host failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/deployments',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const body = safeReadJsonBody(request) as Record<string, unknown>;
        if (typeof body.name !== 'string' || typeof body.image !== 'string'
          || typeof body.modelName !== 'string' || typeof body.sliceUuid !== 'string') {
          return reply.code(400).send({ error: 'name, sliceUuid, image, modelName required' });
        }
        if (!isRuntime(body.runtime)) {
          return reply.code(400).send({
            error: `runtime must be one of: ${SUPPORTED_RUNTIMES.join(', ')}`,
          });
        }

        const deployment = await createDeployment({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId: (request.params as { hostId: string }).hostId,
          sliceUuid: String(body.sliceUuid),
          name: body.name,
          runtime: body.runtime,
          image: body.image,
          modelName: body.modelName,
          args: Array.isArray(body.args) ? (body.args as string[]) : undefined,
          env: body.env && typeof body.env === 'object'
            ? (body.env as Record<string, string>)
            : undefined,
          port: typeof body.port === 'number' ? body.port : undefined,
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.deployment.create',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'llm-deployment',
            resourceId: deployment.id,
            metadata: { image: deployment.image, modelName: deployment.modelName },
          },
        );
        return reply.code(201).send({ deployment });
      } catch (error) {
        log.error('create deployment failed', { error });
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.get<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const id = (request.params as { deploymentId: string }).deploymentId;
      const { getDatabase } = await import('@/lib/database');
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const deployment = await db.findLlmDeploymentById(id);
      if (!deployment || deployment.tenantId !== session.tenantId) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }
      // Enrich with the auto-registered pool/model keys so the UI can
      // wire up the playground without a second roundtrip.
      let pools = await db.listLlmPools(session.tenantId);
      let owningPool = pools.find((p) => p.deploymentIds.includes(deployment.id));

      // Lazy auto-publish: if the deployment is healthy but no pool yet
      // wraps it (because the auto-publish in the event ingestor didn't
      // fire for older deployments, or the user wiped state), try now.
      // Best-effort — if publish fails the page still renders without a
      // playground link.
      if (deployment.actualState === 'healthy' && !owningPool) {
        try {
          const { publishDeploymentToModelHub } = await import('@/lib/services/gpuFleet/autoRegister');
          const consoleBaseUrl = `${request.protocol}://${request.headers.host}`;
          await publishDeploymentToModelHub({
            tenantDbName: session.tenantDbName,
            tenantId: session.tenantId,
            deployment,
            consoleBaseUrl,
            actorUserId: session.userId,
            modality: 'llm',
          });
          pools = await db.listLlmPools(session.tenantId);
          owningPool = pools.find((p) => p.deploymentIds.includes(deployment.id));
        } catch (error) {
          log.warn('lazy auto-publish on GET deployment failed', {
            deploymentId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const host = await db.findGpuHostById(deployment.hostId);
      const inferenceServer = deployment.inferenceServerKey
        ? await db.findInferenceServerByKey(session.tenantId, deployment.inferenceServerKey)
        : null;
      return reply.code(200).send({
        deployment,
        host: host
          ? { id: host.id, name: host.name, accelerator: host.accelerator, serviceAddress: host.serviceAddress }
          : null,
        pool: owningPool
          ? {
              key: owningPool.key,
              name: owningPool.name,
              providerKey: owningPool.providerKey,
              modelKey: owningPool.modelKey,
            }
          : null,
        inferenceServer: inferenceServer
          ? { key: inferenceServer.key, baseUrl: inferenceServer.baseUrl, status: inferenceServer.status }
          : null,
      });
    }),
  );

  app.get<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId/timeline',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const id = (request.params as { deploymentId: string }).deploymentId;
      const { getDatabase } = await import('@/lib/database');
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const deployment = await db.findLlmDeploymentById(id);
      if (!deployment || deployment.tenantId !== session.tenantId) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      // Commands link explicitly via resourceRef (set to the deploymentId
      // at enqueue time). Events embed deploymentId in their payload. We
      // read each table once, then merge chronologically client-side.
      const allCommands = await db.listGpuFleetCommandsByHost(deployment.hostId, {
        resourceRef: id,
        limit: 200,
      });
      const recentEvents = await db.listGpuFleetEvents(deployment.hostId, { limit: 500 });

      const commands = allCommands.map((c) => ({
        kind: 'command' as const,
        id: c.id,
        type: c.kind,
        status: c.status,
        attempts: c.attempts,
        at: c.issuedAt,
        deliveredAt: c.deliveredAt,
        completedAt: c.completedAt,
        lastError: c.lastError,
      }));

      const events = recentEvents
        .filter((e) => {
          const p = e.payload as Record<string, unknown> | null;
          return p != null && (p.deploymentId === id || JSON.stringify(p).includes(id));
        })
        .map((e) => ({
          kind: 'event' as const,
          id: e._id,
          type: e.kind,
          at: e.occurredAt,
          payload: e.payload,
        }));

      // Sort chronologically (oldest first — easier to read top→bottom).
      const items = [...commands, ...events].sort((a, b) => {
        const ta = (a.at instanceof Date ? a.at : new Date(a.at)).getTime();
        const tb = (b.at instanceof Date ? b.at : new Date(b.at)).getTime();
        return ta - tb;
      });

      return reply.code(200).send({
        deployment,
        items,
      });
    }),
  );

  app.post<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId/fetch-logs',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const id = (request.params as { deploymentId: string }).deploymentId;
        const { getDatabase } = await import('@/lib/database');
        const db = await getDatabase();
        await db.switchToTenant(session.tenantDbName);
        const deployment = await db.findLlmDeploymentById(id);
        if (!deployment || deployment.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Deployment not found' });
        }
        // Cap tail at 500 lines — collect-logs payload ships back inside an
        // event, so we don't want a runaway log buffer flooding the wire.
        const body = safeReadJsonBody(request) as { tailLines?: number };
        const tail = Math.max(50, Math.min(body.tailLines ?? 300, 1000));
        const cmd = await enqueueCommand({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId: deployment.hostId,
          kind: 'collect-logs',
          payload: { deploymentId: id, tailLines: tail },
          resourceRef: id,
          createdBy: session.userId,
        });
        return reply.code(202).send({ commandId: cmd.id, tail });
      } catch (error) {
        log.error('fetch deployment logs failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId/stop',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const deployment = await stopDeployment({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          deploymentId: (request.params as { deploymentId: string }).deploymentId,
          updatedBy: session.userId,
        });
        if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });
        return reply.code(200).send({ deployment });
      } catch (error) {
        log.error('stop deployment failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  app.post<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId/restart',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const ok = await restartDeployment({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          deploymentId: (request.params as { deploymentId: string }).deploymentId,
          updatedBy: session.userId,
        });
        if (!ok) return reply.code(404).send({ error: 'Deployment not found' });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.deployment.restart',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'llm-deployment',
            resourceId: (request.params as { deploymentId: string }).deploymentId,
            metadata: {},
          },
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        log.error('restart deployment failed', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/restart-agent',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const hostId = (request.params as { hostId: string }).hostId;
        const { getDatabase } = await import('@/lib/database');
        const db = await getDatabase();
        await db.switchToTenant(session.tenantDbName);
        const host = await db.findGpuHostById(hostId);
        if (!host || host.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'Host not found' });
        }
        // Enqueue a reboot-agent command — the agent processes it by calling
        // `process.exit(0)`. systemd/launchd restarts the service automatically,
        // which re-handshakes via the persisted agent-token and re-emits a
        // fresh inventory. Useful when the agent has gone weird (event push
        // failing, stuck pull, etc.) but the host itself is fine.
        await enqueueCommand({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId,
          kind: 'reboot-agent',
          payload: {},
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.restart-agent',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: hostId,
            metadata: {},
          },
        );
        return reply.code(202).send({ ok: true });
      } catch (error) {
        log.error('restart agent failed', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }),
  );

  app.delete<{ Params: { deploymentId: string } }>(
    '/gpu-fleet/deployments/:deploymentId',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const removed = await deleteDeployment({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          deploymentId: (request.params as { deploymentId: string }).deploymentId,
          updatedBy: session.userId,
        });
        if (!removed) return reply.code(404).send({ error: 'Deployment not found' });
        return reply.code(204).send();
      } catch (error) {
        log.error('delete deployment failed', { error });
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }),
  );

  // ── MIG reconfigure ─────────────────────────────────────────────────

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/mig',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const hostId = (request.params as { hostId: string }).hostId;
        const body = safeReadJsonBody(request) as {
          gpuUuid?: unknown;
          profiles?: unknown;
        };
        if (typeof body.gpuUuid !== 'string' || !Array.isArray(body.profiles)) {
          return reply.code(400).send({ error: 'gpuUuid and profiles array required' });
        }
        const profiles = body.profiles.filter((p): p is string => typeof p === 'string');
        const result = await applyMigLayoutCommand({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId,
          layout: { gpuUuid: body.gpuUuid, profiles },
          createdBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.mig.apply',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: hostId,
            metadata: { gpuUuid: body.gpuUuid, profiles, drained: result.drainedDeploymentIds.length },
          },
        );
        return reply.code(202).send(result);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'MIG apply failed',
        });
      }
    }),
  );

  // ── Terminal session ────────────────────────────────────────────────

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/hosts/:hostId/terminal',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const hostId = (request.params as { hostId: string }).hostId;
        const body = safeReadJsonBody(request) as {
          sandbox?: TerminalSandbox;
          deploymentId?: string;
          cols?: number;
          rows?: number;
        };
        const sandbox: TerminalSandbox = body.sandbox ?? 'docker-debug';
        if (!['host', 'docker-debug', 'deployment-exec'].includes(sandbox)) {
          return reply.code(400).send({ error: 'invalid sandbox mode' });
        }

        const host = await getGpuHost(session.tenantDbName, hostId);
        if (!host || host.tenantId !== session.tenantId) {
          return reply.code(404).send({ error: 'host not found' });
        }
        if (!host.terminalEnabled) {
          return reply.code(403).send({ error: 'terminal access not enabled on this host' });
        }

        const settings = await getOrInitFleetSettings(session.tenantDbName, session.tenantId);
        const term = createTerminalSession({
          tenantId: session.tenantId,
          tenantDbName: session.tenantDbName,
          tenantSlug: session.tenantSlug,
          hostId,
          sandbox,
          deploymentId: body.deploymentId,
          cols: body.cols,
          rows: body.rows,
          ttlSeconds: settings.terminalSessionTtlSeconds,
          openedBy: session.userId,
        });

        await enqueueCommand({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId,
          kind: 'open-terminal-session',
          payload: {
            sessionId: term.sessionId,
            sandbox,
            deploymentId: term.deploymentId,
            ttlSeconds: term.ttlSeconds,
            cols: term.cols,
            rows: term.rows,
          },
          resourceRef: term.sessionId,
          createdBy: session.userId,
        });

        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.terminal.open',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: hostId,
            metadata: { sandbox, sessionId: term.sessionId },
          },
        );

        return reply.code(201).send({
          sessionId: term.sessionId,
          websocketPath: `/api/gpu-fleet/terminal/${term.sessionId}/browser`,
          expiresAt: term.expiresAt,
        });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'open-terminal failed',
        });
      }
    }),
  );

  // ── Onboarding: pending_claim hosts ─────────────────────────────────

  app.get(
    '/gpu-fleet/onboarding/pending',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const hosts = await listPendingClaimHosts(session.tenantDbName, session.tenantId);
      return reply.code(200).send({ hosts: hosts.map(sanitizeHost) });
    }),
  );

  app.post<{ Params: { hostId: string } }>(
    '/gpu-fleet/onboarding/pending/:hostId/claim',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const body = safeReadJsonBody(request) as {
          name?: unknown;
          labels?: unknown;
          serviceAddress?: unknown;
          terminalEnabled?: unknown;
        };
        const host = await claimPendingHost({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId: (request.params as { hostId: string }).hostId,
          name: typeof body.name === 'string' ? body.name : undefined,
          labels: body.labels && typeof body.labels === 'object'
            ? (body.labels as Record<string, string>)
            : undefined,
          serviceAddress: typeof body.serviceAddress === 'string'
            ? body.serviceAddress
            : body.serviceAddress === null
              ? null
              : undefined,
          terminalEnabled: typeof body.terminalEnabled === 'boolean' ? body.terminalEnabled : undefined,
          claimedBy: session.userId,
        });
        await recordAuditLog(
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
          {
            service: 'gpu-fleet',
            action: 'admin',
            event: 'gpu-fleet.host.claim',
            actorType: 'user',
            actorUserId: session.userId,
            actorEmail: session.userEmail,
            outcome: 'success',
            resourceType: 'gpu-host',
            resourceId: host.id,
            metadata: { name: host.name },
          },
        );
        return reply.code(200).send({ host: sanitizeHost(host) });
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Claim failed',
        });
      }
    }),
  );

  app.delete<{ Params: { hostId: string } }>(
    '/gpu-fleet/onboarding/pending/:hostId',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const removed = await rejectPendingHost({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          hostId: (request.params as { hostId: string }).hostId,
        });
        if (!removed) return reply.code(404).send({ error: 'Host not found' });
        return reply.code(204).send();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Reject failed',
        });
      }
    }),
  );

  // ── Fleet settings + install snippet ────────────────────────────────

  app.get(
    '/gpu-fleet/settings',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const settings = await getOrInitFleetSettings(session.tenantDbName, session.tenantId);
      // Never leak the token hash to the UI.
      return reply.code(200).send({
        agentDistributionMode: settings.agentDistributionMode,
        agentDistributionExternalUrlTemplate: settings.agentDistributionExternalUrlTemplate,
        terminalSessionTtlSeconds: settings.terminalSessionTtlSeconds,
        fleetTokenSet: settings.fleetTokenHash !== null,
        fleetTokenRotatedAt: settings.fleetTokenRotatedAt,
        availableBundles: listAvailableBundles().map((b) => ({
          platform: b.platform,
          sizeBytes: b.sizeBytes,
          mtime: b.mtime,
        })),
      });
    }),
  );

  app.put(
    '/gpu-fleet/settings/agent-distribution',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const body = safeReadJsonBody(request) as { mode?: unknown; externalUrlTemplate?: unknown };
      const mode = body.mode as AgentDistributionMode | undefined;
      if (mode !== 'console-served' && mode !== 'external-url') {
        return reply.code(400).send({ error: 'mode must be console-served | external-url' });
      }
      const updated = await updateAgentDistribution({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        mode,
        externalUrlTemplate: typeof body.externalUrlTemplate === 'string'
          ? body.externalUrlTemplate
          : null,
      });
      return reply.code(200).send({
        agentDistributionMode: updated.agentDistributionMode,
        agentDistributionExternalUrlTemplate: updated.agentDistributionExternalUrlTemplate,
      });
    }),
  );

  app.post(
    '/gpu-fleet/settings/fleet-token/rotate',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      const result = await rotateFleetToken({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        rotatedBy: session.userId,
      });
      return reply.code(200).send({ token: result.token, rotatedAt: result.rotatedAt });
    }),
  );

  app.post(
    '/gpu-fleet/settings/fleet-token/disable',
    withApiRequestContext(async (request, reply) => {
      const session = requireSessionContext(request);
      await disableFleetToken({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        rotatedBy: session.userId,
      });
      return reply.code(204).send();
    }),
  );

  app.post(
    '/gpu-fleet/onboarding/install-snippet',
    withApiRequestContext(async (request, reply) => {
      try {
        const session = requireSessionContext(request);
        const body = safeReadJsonBody(request) as { platform?: unknown; rotateToken?: unknown };
        const platform = typeof body.platform === 'string' && isSupportedPlatform(body.platform)
          ? (body.platform as AgentPlatform)
          : undefined;
        const consoleBaseUrl = `${request.protocol}://${request.headers.host}`;
        const snippet = await renderInstallSnippet({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          tenantSlug: session.tenantSlug,
          consoleBaseUrl,
          platform,
          actorUserId: session.userId,
          rotateToken: Boolean(body.rotateToken),
        });
        return reply.code(200).send(snippet);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Snippet rendering failed',
        });
      }
    }),
  );

  // ── Public installer + bundle download (no session auth) ─────────────

  // install.sh is intentionally unauthenticated. It contains no tenant
  // secrets; the fleet token is injected by the operator on the command
  // line. The same script is shared by every tenant.
  app.get('/gpu-fleet/installer.sh', async (_request, reply) => {
    try {
      const installerPath = join(
        process.cwd(),
        'packages',
        'gpu-agent',
        'scripts',
        'install.sh',
      );
      const body = readFileSync(installerPath, 'utf8');
      return reply
        .code(200)
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'installer not found' });
    }
  });

  // Bundle download. Authenticating this would mean every GPU host needs a
  // tenant-scoped credential JUST to download a binary that has no secrets
  // baked in — overkill. Anyone with the URL can fetch it; the agent inside
  // still requires a valid fleet token before it can talk to the console.
  app.get<{ Params: { platform: string } }>(
    '/gpu-fleet/agent-bundle/:platform.tar.gz',
    async (request, reply) => {
      const raw = (request.params as { platform: string }).platform;
      if (!isSupportedPlatform(raw)) {
        return reply.code(400).send({ error: `Unsupported platform: ${raw}` });
      }
      try {
        const { stream, info } = readBundleStream(raw);
        return reply
          .code(200)
          .header('content-type', 'application/gzip')
          .header('content-length', String(info.sizeBytes))
          .header('content-disposition', `attachment; filename="cognipeer-gpu-agent-${raw}.tar.gz"`)
          .send(stream);
      } catch (error) {
        if (error instanceof BundleNotFound) {
          return reply.code(404).send({ error: error.message });
        }
        log.error('bundle download failed', { platform: raw, error });
        return reply.code(500).send({ error: 'bundle download failed' });
      }
    },
  );

  // ── Model library ────────────────────────────────────────────────────

  app.get(
    '/gpu-fleet/model-library',
    withApiRequestContext(async (request, reply) => {
      requireSessionContext(request);
      const query = (request.query ?? {}) as {
        modality?: string;
        accelerator?: string;
        q?: string;
        tag?: string;
      };
      const entries = listModelLibrary({
        modality: query.modality as ReturnType<typeof listModelLibrary>[number]['modality'] | undefined,
        accelerator: query.accelerator as ReturnType<typeof listModelLibrary>[number]['supportedPlatforms'][number] | undefined,
        q: query.q,
        tag: query.tag,
      });
      return reply.code(200).send({ entries });
    }),
  );
};
